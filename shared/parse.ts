// Validation of data received from another process: API responses read by the web UI (local or relayed
// machine) and states fetched from remote machines by the server. Never trust a cast: parse.

/** Defensive parser: null when the value does not follow the contract. */
export type Parser<T> = (value: unknown) => T | null;

class InvalidData extends Error {}

/** Composable strict validation: throws on invalid data; `parser` turns it into a Parser. */
export type Schema<T> = (value: unknown) => T;

const invalid = (): never => {
  throw new InvalidData();
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function asNullableString(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
}

export function asNullableNumber(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/** Valid items of a list; invalid ones are dropped. */
export function parseItems<T>(v: unknown, parse: Parser<T>): T[] {
  return Array.isArray(v) ? v.map(parse).filter((item): item is T => item !== null) : [];
}

export function parser<T>(schema: Schema<T>): Parser<T> {
  return (value) => {
    try {
      return schema(value);
    } catch (cause) {
      if (cause instanceof InvalidData) return null;
      throw cause;
    }
  };
}

/** Uses a Parser inside a Schema. */
export function schema<T>(parse: Parser<T>): Schema<T> {
  return (value) => parse(value) ?? invalid();
}

export const string: Schema<string> = (v) => (typeof v === 'string' ? v : invalid());
export const number: Schema<number> = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : invalid());
export const boolean: Schema<boolean> = (v) => (typeof v === 'boolean' ? v : invalid());
export const unknown: Schema<unknown> = (v) => v;

export function literal<const T extends readonly string[]>(...values: T): Schema<T[number]> {
  return (v) => (values.includes(v as string) ? (v as T[number]) : invalid());
}

export function nullable<T>(item: Schema<T>): Schema<T | null> {
  return (v) => (v === null ? null : item(v));
}

/** Field added after the first version of the contract: absent stays absent. */
export function optional<T>(item: Schema<T>): Schema<T | undefined> {
  return (v) => (v === undefined ? undefined : item(v));
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return (v) => (Array.isArray(v) ? v.map(item) : invalid());
}

export function record<T>(item: Schema<T>): Schema<Record<string, T>> {
  return (v) => {
    if (!isRecord(v) || Array.isArray(v)) return invalid();
    return Object.fromEntries(Object.entries(v).map(([key, value]) => [key, item(value)]));
  };
}

/** Every key of T must be described (optional ones with `optional`); unknown keys are dropped. */
export function object<T>(shape: { [K in keyof T & string]: Schema<T[K]> }): Schema<T> {
  return (v) => {
    if (!isRecord(v) || Array.isArray(v)) return invalid();
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries<Schema<unknown>>(shape)) {
      const value = field(v[key]);
      if (value !== undefined) out[key] = value;
    }
    return out as T;
  };
}

/** Union discriminated by `key`: one schema per tag. */
export function variant<T extends Record<K, string>, K extends string>(
  key: K,
  variants: { [Tag in T[K]]: Schema<Extract<T, Record<K, Tag>>> },
): Schema<T> {
  return (v) => {
    if (!isRecord(v) || typeof v[key] !== 'string' || !Object.hasOwn(variants, v[key])) return invalid();
    return (variants as Record<string, Schema<T>>)[v[key]]!(v);
  };
}
