// Brouillons des prompts non lancés, conservés dans le navigateur : changer d'onglet de projet,
// recharger la page ou fermer le navigateur ne fait plus perdre le texte saisi. [SPEC UI web › Vue projet]

export interface DraftImage {
  n: number;
  token: string;
  path: string;
}

export interface Draft {
  prompt: string;
  images: DraftImage[];
}

const PREFIX = 'cerebro.draft.';

export function readDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const draft = JSON.parse(raw) as Partial<Draft>;
    if (typeof draft.prompt !== 'string') return null;
    return { prompt: draft.prompt, images: Array.isArray(draft.images) ? draft.images : [] };
  } catch (err) {
    console.warn('Brouillon illisible', key, err);
    return null;
  }
}

/** Enregistre (ou efface si le prompt est vide et sans image) ; renvoie un message d'erreur si le stockage échoue. */
export function writeDraft(key: string, draft: Draft): string | null {
  try {
    if (draft.prompt.trim() === '' && draft.images.length === 0) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(draft));
    return null;
  } catch (err) {
    console.warn('Brouillon non enregistré', key, err);
    return err instanceof Error ? err.message : 'stockage du navigateur indisponible';
  }
}
