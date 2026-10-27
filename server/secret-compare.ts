import { timingSafeEqual } from 'node:crypto';

// Comparaison de jetons en temps constant : seule la longueur peut fuiter, pas le préfixe commun.
export function secretMatches(expected: string | null | undefined, candidate: string | undefined): boolean {
  if (expected === null || expected === undefined || candidate === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}
