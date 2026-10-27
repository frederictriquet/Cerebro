// The text shown to users and stored for an error: never the "Error: " prefix String() would add.
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
