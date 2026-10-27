import { useCallback, useState } from 'react';
import { errorMessage } from './format.ts';
// Accès au localStorage, propre à ce navigateur. Il peut être indisponible (mode privé, quota,
// stockage bloqué) : les lectures retombent alors sur la valeur par défaut, les écritures
// échouent sans interrompre l'interface.

/** Valeur brute enregistrée, ou null si elle est absente ou illisible. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Enregistre la valeur (null l'efface) ; renvoie un message d'erreur si le stockage échoue. */
export function writeStored(key: string, value: string | null): string | null {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return null;
  } catch (err) {
    console.warn('Stockage local indisponible', key, err);
    return errorMessage(err, 'stockage du navigateur indisponible');
  }
}

/** Valeur JSON enregistrée, à valider par l'appelant ; null si absente ou illisible. */
export function readJson(key: string): unknown {
  const raw = readStored(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    console.warn('Valeur locale illisible', key, err);
    return null;
  }
}

/** Enregistre la valeur en JSON (null l'efface) ; renvoie un message d'erreur si le stockage échoue. */
export function writeJson(key: string, value: unknown): string | null {
  return writeStored(key, value === null ? null : JSON.stringify(value));
}

/** Codage d'un booléen : valeurs enregistrées pour vrai et pour faux. */
export type FlagValues = readonly [on: string, off: string];
const BINARY: FlagValues = ['1', '0'];

/** Booléen enregistré ; la valeur par défaut (éventuellement calculée) s'applique sinon. */
export function readFlag(key: string, fallback: boolean | (() => boolean), [on, off]: FlagValues = BINARY): boolean {
  const raw = readStored(key);
  if (raw === on) return true;
  if (raw === off) return false;
  return typeof fallback === 'function' ? fallback() : fallback;
}

export function writeFlag(key: string, value: boolean, [on, off]: FlagValues = BINARY): void {
  writeStored(key, value ? on : off);
}

/** Booléen mémorisé par ce navigateur ; la valeur par défaut n'est évaluée qu'au premier rendu. */
export function useStoredFlag(key: string, fallback: boolean | (() => boolean), values: FlagValues = BINARY) {
  const [value, setValue] = useState(() => readFlag(key, fallback, values));
  const [on, off] = values;
  const update = useCallback(
    (next: boolean): void => {
      setValue(next);
      writeFlag(key, next, [on, off]);
    },
    [key, on, off],
  );
  return [value, update] as const;
}
