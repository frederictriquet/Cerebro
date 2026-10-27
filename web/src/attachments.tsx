import { ActivityStatus } from './ActivityStatus.tsx';
import { useEffect, useRef, useState } from 'react';

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
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  useEffect(() => () => {
    for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl);
  }, []);

  // Image d'origine de chaque jeton, pour pouvoir la renvoyer vers une autre destination.
  const blobs = useRef(new Map<number, Blob>());
  // Numéro du dernier envoi de chaque image : la réponse d'un envoi remplacé est ignorée.
  const attempts = useRef(new Map<number, number>());

  const forget = (n: number): void => {
    blobs.current.delete(n);
    attempts.current.delete(n);
  };

  const send = (
    n: number,
    image: Blob,
    upload: (image: Blob) => Promise<string>,
    onError: (token: string, message: string) => void,
  ): void => {
    const attempt = (attempts.current.get(n) ?? 0) + 1;
    attempts.current.set(n, attempt);
    upload(image).then(
      (path) => {
        if (attempts.current.get(n) !== attempt) return;
        setItems((current) => current.map((item) => (item.n === n ? { ...item, path } : item)));
      },
      (err: unknown) => {
        if (attempts.current.get(n) !== attempt) return;
        forget(n);
        setItems((current) => {
          const item = current.find((i) => i.n === n);
          if (item) URL.revokeObjectURL(item.previewUrl);
          return current.filter((i) => i.n !== n);
        });
        onError(imageToken(n), err instanceof Error ? err.message : 'Image non envoyée');
      },
    );
  };

  /**
   * Démarre l'envoi et renvoie aussitôt le jeton à insérer.
   * `onError` est appelé (avec le jeton à retirer du texte) si l'envoi échoue.
   */
  const add = (image: Blob, onError: (token: string, message: string) => void): string => {
    counter.current += 1;
    const n = counter.current;
    const token = imageToken(n);
    const previewUrl = URL.createObjectURL(image);
    blobs.current.set(n, image);
    setItems((current) => [...current, { n, token, previewUrl, path: null }]);
    send(n, image, uploadRef.current, onError);
    return token;
  };

  /**
   * Renvoie les images déjà jointes avec `upload` (nouvelle destination, par exemple un autre
   * projet) : leurs chemins doivent désigner le dossier de cette destination. Une image
   * restaurée d'un brouillon, sans fichier d'origine, garde son chemin.
   */
  const reupload = (upload: (image: Blob) => Promise<string>, onError: (token: string, message: string) => void): void => {
    const resent = itemsRef.current.filter((item) => blobs.current.has(item.n));
    if (resent.length === 0) return;
    const ns = new Set(resent.map((item) => item.n));
    setItems((current) => current.map((item) => (ns.has(item.n) ? { ...item, path: null } : item)));
    for (const item of resent) send(item.n, blobs.current.get(item.n)!, upload, onError);
  };

  const remove = (n: number): void => {
    setItems((current) => {
      const item = current.find((i) => i.n === n);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return current.filter((i) => i.n !== n);
    });
    forget(n);
  };

  /** Remplace les jetons par les chemins ; un jeton sans image correspondante est laissé tel quel. */
  const expand = (text: string): string =>
    text.replace(TOKEN, (match, n: string) => items.find((item) => item.n === Number(n))?.path ?? match);

  /** Après envoi : oublie les images et repart de #1. */
  const reset = (): void => {
    for (const item of items) URL.revokeObjectURL(item.previewUrl);
    setItems([]);
    blobs.current.clear();
    attempts.current.clear();
    counter.current = 0;
  };

  /** Garde seulement les images dont le jeton est encore dans le texte (l'utilisateur a pu l'effacer). */
  const prune = (text: string): void => {
    const orphans = items.filter((item) => !text.includes(item.token));
    if (orphans.length === 0) return;
    for (const item of orphans) {
      URL.revokeObjectURL(item.previewUrl);
      forget(item.n);
    }
    setItems((current) => current.filter((item) => text.includes(item.token)));
  };

  const pending = items.some((item) => item.path === null);
  return { items, add, reupload, remove, expand, reset, prune, pending };
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
          <figcaption><ActivityStatus active={item.path === null}>{item.path === null ? 'Envoi…' : `#${item.n}`}</ActivityStatus></figcaption>
          <button type="button" aria-label={`Retirer ${item.token}`} title="Retirer" onClick={() => onRemove(item)}>
            ×
          </button>
        </figure>
      ))}
    </div>
  );
}
