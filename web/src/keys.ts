import type { KeyboardEvent } from 'react';

// Raccourci de validation des champs multi-lignes : Ctrl+Entrée, ou Cmd+Entrée sur Mac
// (Ctrl+Entrée y est souvent intercepté par le système ou le navigateur). [SPEC UI web › Vue projet]
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const SUBMIT_HINT = IS_MAC ? '⌘+Entrée' : 'Ctrl+Entrée';

export function isSubmitShortcut(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing;
}
