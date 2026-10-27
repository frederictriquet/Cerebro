import { useInsertionEffect, useRef, type RefObject } from 'react';

// Ref sur la dernière valeur rendue, pour les rappels et les effets installés une seule fois. Elle est mise à jour
// au commit, avant tout effet, et jamais pendant le rendu : un rendu abandonné ne la modifie pas.
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}
