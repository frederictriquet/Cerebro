import { createContext, useContext } from 'react';

// Partagé par les lignes et les groupes d'une liste de sessions, à toute profondeur.
export interface SessionListScope {
  now: number;
  // Lien vers le projet de chaque entrée, pour une liste qui mêle plusieurs projets.
  showProject: boolean;
  onError: (message: string) => void;
}

export const SessionListContext = createContext<SessionListScope | null>(null);

export function useSessionList(): SessionListScope {
  const scope = useContext(SessionListContext);
  if (!scope) throw new Error('Liste de sessions manquante');
  return scope;
}
