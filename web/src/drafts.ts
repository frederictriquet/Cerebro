import { readJson, writeJson } from './storage.ts';
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
  const draft = readJson(PREFIX + key) as Partial<Draft> | null;
  if (typeof draft?.prompt !== 'string') return null;
  return { prompt: draft.prompt, images: Array.isArray(draft.images) ? draft.images : [] };
}

/** Enregistre (ou efface si le prompt est vide) ; renvoie un message d'erreur si le stockage échoue. */
export function writeDraft(key: string, draft: Draft): string | null {
  return writeJson(PREFIX + key, draft.prompt.trim() === '' ? null : draft);
}
