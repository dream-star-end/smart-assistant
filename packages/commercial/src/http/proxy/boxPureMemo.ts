/** Process-local memo for pure digests of one Messages body.
 * A hit requires the same messages array, the same short values, and the
 * same long-string references. Replacing a string, number, or key misses.
 * Long strings are immutable, so the reference check does not read their
 * bytes. Results are frozen; callers receive a shallow copy. */
const LONG = 4096;
const MAX_ENTRIES = 4;
const JSON_LITERAL = /^[\u0020-\u0021\u0023-\u005B\u005D-\u007E]*$/;

type Entry = {
  kind: string;
  structural: string;
  longs: readonly string[];
  result: unknown;
};

export type JsonStamp = {
  structural: string;
  longs: readonly string[];
};

const byMessages = new WeakMap<readonly unknown[], Entry[]>();

function pushStamp(value: unknown, parts: string[], longs: string[], depth: number,
  sortKeys: boolean): boolean {
  if (depth > 64) return false;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    parts.push(JSON.stringify(value));
    return true;
  }
  if (value === null || typeof value === "boolean") {
    parts.push(JSON.stringify(value));
    return true;
  }
  if (typeof value === "string") {
    if (value.length >= LONG) {
      parts.push("\u0000L");
      parts.push(String(longs.length));
      longs.push(value);
      return true;
    }
    parts.push(JSON.stringify(value));
    return true;
  }
  if (Array.isArray(value)) {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") return false;
    parts.push("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index) parts.push(",");
      if (!Object.hasOwn(value, index)) return false;
      if (!pushStamp(value[index], parts, longs, depth + 1, sortKeys)) return false;
    }
    parts.push("]");
    return true;
  }
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (typeof object.toJSON === "function") return false;
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(object);
  if (sortKeys) keys.sort();
  parts.push("{");
  for (let index = 0; index < keys.length; index += 1) {
    if (index) parts.push(",");
    const key = keys[index];
    if (key === undefined) continue;
    parts.push(JSON.stringify(key));
    parts.push(":");
    if (!pushStamp(object[key], parts, longs, depth + 1, sortKeys)) return false;
  }
  parts.push("}");
  return true;
}

function sameLongs(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function stampsEqual(left: JsonStamp, right: JsonStamp): boolean {
  return left.structural === right.structural && sameLongs(left.longs, right.longs);
}

/** Insertion-order identity of plain JSON. Null means the caller must not
 * reuse a previously stringified prefix. */
export function jsonIdentityStamp(value: unknown): JsonStamp | null {
  const parts: string[] = [];
  const longs: string[] = [];
  if (!pushStamp(value, parts, longs, 0, false)) return null;
  return { structural: parts.join(""), longs };
}

function copyOut<T>(result: T): T {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>) } as T;
  }
  return result;
}

/** `kind` must include every input that is not part of `body`, such as uid
 * and the active byte ceiling. */
export function memoPureBody<T>(body: object, kind: string, compute: () => T): T {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return compute();
  const parts: string[] = [];
  const longs: string[] = [];
  // A lossy stamp would alias a hole, NaN, or toJSON value onto another body.
  if (!pushStamp(body, parts, longs, 0, true)) return compute();
  const structural = parts.join("");
  const bucket = byMessages.get(messages);
  if (bucket) {
    for (const entry of bucket) {
      if (entry.kind === kind && entry.structural === structural && sameLongs(entry.longs, longs)) {
        return copyOut(entry.result as T);
      }
    }
  }
  const result = compute();
  if (typeof result === "object" && result !== null) Object.freeze(result);
  const list = bucket ?? [];
  list.push({ kind, structural, longs, result });
  if (list.length > MAX_ENTRIES) list.shift();
  if (!bucket) byMessages.set(messages, list);
  return copyOut(result);
}

/** JSON string literal. Long ASCII payloads are quoted in place so a digest
 * walk does not allocate a second copy. The bytes match JSON.stringify. */
export function emitJsonString(value: string, emit: (part: string) => void): void {
  if (value.length >= 1024 && JSON_LITERAL.test(value)) {
    emit('"');
    emit(value);
    emit('"');
    return;
  }
  emit(JSON.stringify(value));
}

/** UTF-8 size of JSON.stringify(body) when `messagesJson` is JSON.stringify
 * of `body.messages`. The other fields are small and are stringified once. */
export function proxyBodyUtf8Bytes(body: object, messagesJson: string): number {
  if (typeof (body as { toJSON?: unknown }).toJSON === "function") {
    return Buffer.byteLength(JSON.stringify(body));
  }
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return Buffer.byteLength(JSON.stringify(body));
  const shell = JSON.stringify({ ...body, messages: [] });
  return Buffer.byteLength(shell) - 2 + Buffer.byteLength(messagesJson);
}
