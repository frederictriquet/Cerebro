import { ActivityStatus } from './ActivityStatus.tsx';
import { useEffect, useRef, useState } from 'react';
import { useLatest } from './use-latest.ts';

// Images jointes à un champ de saisie : le texte affiche un jeton court « [Image #N] »
// (comme Claude Code en terminal) et une miniature ; au moment d'envoyer, chaque jeton est
// remplacé par le chemin du fichier côté serveur, que l'agent sait lire.

export interface Attachment {
  n: number;
  token: string;
  previewUrl: string;
  path: string | null; // null tant que l'envoi n'est pas terminé
}

// Image restaurée d'un brouillon : déjà sur le serveur, mais sans miniature (le blob est perdu).
export function restoredAttachment(n: number, token: string, path: string): Attachment {
  return { n, token, previewUrl: '', path };
}

const TOKEN = /\[Image #(\d+)\]/g;

export function imageToken(n: number): string {
  return `[Image #${n}]`;
}

/** Insère `token` entre `start` et `end`, en ajoutant un espace de chaque côté si nécessaire. */
export function insertToken(text: string, start: number, end: number, token: string): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const left = before === '' || /\s$/.test(before) ? '' : ' ';
  const right = /^\s/.test(after) ? '' : ' ';
  return `${before}${left}${token}${right}${after}`;
}

/** Retire un jeton du texte, ainsi qu'un espace qui le suit. */
export function removeToken(text: string, token: string): string {
  return text.split(`${token} `).join('').split(token).join('');
}

export function useImageAttachments(upload: (image: Blob) => Promise<string>, initial: Attachment[] = []) {
  const [items, setItems] = useState<Attachment[]>(initial);
  const counter = useRef(initial.reduce((max, item) => Math.max(max, item.n), 0));
  const itemsRef = useLatest(items);
  const uploadRef = useLatest(upload);

  useEffect(
    () => () => {
      for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl);
    },
    [itemsRef],
  );

  /**
   * Démarre l'envoi et renvoie aussitôt le jeton à insérer.
   * `onError` est appelé (avec le jeton à retirer du texte) si l'envoi échoue.
   */
  const add = (image: Blob, onError: (token: string, message: string) => void): string => {
    counter.current += 1;
    const n = counter.current;
    const token = imageToken(n);
    const previewUrl = URL.createObjectURL(image);
    setItems((current) => [...current, { n, token, previewUrl, path: null }]);
    uploadRef.current(image).then(
      (path) => setItems((current) => current.map((item) => (item.n === n ? { ...item, path } : item))),
      (err: unknown) => {
        URL.revokeObjectURL(previewUrl);
        setItems((current) => current.filter((item) => item.n !== n));
        onError(token, err instanceof Error ? err.message : 'Image non envoyée');
      },
    );
    return token;
  };

  const remove = (n: number): void => {
    setItems((current) => {
      const item = current.find((i) => i.n === n);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return current.filter((i) => i.n !== n);
    });
  };

  /** Remplace les jetons par les chemins ; un jeton sans image correspondante est laissé tel quel. */
  const expand = (text: string): string =>
    text.replace(TOKEN, (match, n: string) => items.find((item) => item.n === Number(n))?.path ?? match);

  /** Après envoi : oublie les images et repart de #1. */
  const reset = (): void => {
    for (const item of items) URL.revokeObjectURL(item.previewUrl);
    setItems([]);
    counter.current = 0;
  };

  /** Garde seulement les images dont le jeton est encore dans le texte (l'utilisateur a pu l'effacer). */
  const prune = (text: string): void => {
    const orphans = items.filter((item) => !text.includes(item.token));
    if (orphans.length === 0) return;
    for (const item of orphans) URL.revokeObjectURL(item.previewUrl);
    setItems((current) => current.filter((item) => text.includes(item.token)));
  };

  const pending = items.some((item) => item.path === null);
  return { items, add, remove, expand, reset, prune, pending };
}

export function AttachmentStrip({ items, onRemove }: { items: Attachment[]; onRemove: (item: Attachment) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="attachments">
      {items.map((item) => (
        <figure key={item.n} className={item.path === null ? 'attachment pending' : 'attachment'}>
          {item.previewUrl === '' ? (
            <span className="attachment-restored" title={item.path ?? undefined}>
              Image
            </span>
          ) : (
            <img src={item.previewUrl} alt={item.token} />
          )}
          <figcaption>
            <ActivityStatus active={item.path === null}>{item.path === null ? 'Envoi…' : `#${item.n}`}</ActivityStatus>
          </figcaption>
          <button type="button" aria-label={`Retirer ${item.token}`} title="Retirer" onClick={() => onRemove(item)}>
            ×
          </button>
        </figure>
      ))}
    </div>
  );
}
