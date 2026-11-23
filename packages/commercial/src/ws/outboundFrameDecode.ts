import type { RawData } from "ws";

/**
 * Single-pass lazy UTF-8 decode + single-pass lazy JSON.parse accessor for
 * container -> master WebSocket frames in `onContainerMessage`.
 *
 * Avoids repeated `Buffer.toString("utf8")` and `JSON.parse(...)` calls across
 * the multiple interceptors on the streaming hot path while keeping the
 * master-only `sys.*` security check able to inspect binary frames as well.
 */
export interface OutboundFrameAccessor {
  /** Lazily decode UTF-8 for text frames (`!isBinary`); returns `null` for binary frames. */
  getFrameText(): string | null;
  /** Lazily decode UTF-8 regardless of `isBinary` (shares cache with `getFrameText`). */
  getRawText(): string | null;
  /** Lazily `JSON.parse` once for the frame (regardless of `isBinary`). */
  getParsedFrame(): unknown | null;
  /** Lazily `JSON.parse` once for text frames (`!isBinary`); returns `null` for binary frames. */
  getParsedTextFrame(): unknown | null;
}

export function rawDataToUtf8(data: RawData): string | null {
  try {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
    return null;
  } catch {
    return null;
  }
}

export function createOutboundFrameAccessor(
  data: RawData,
  isBinary: boolean,
): OutboundFrameAccessor {
  let decoded = false;
  let rawText: string | null = null;
  let parsedAttempted = false;
  let parsedValue: unknown | null = null;

  const getRawText = (): string | null => {
    if (!decoded) {
      decoded = true;
      rawText = rawDataToUtf8(data);
    }
    return rawText;
  };

  const getFrameText = (): string | null => (isBinary ? null : getRawText());

  const getParsedFrame = (): unknown | null => {
    if (!parsedAttempted) {
      parsedAttempted = true;
      const text = getRawText();
      if (text !== null) {
        try {
          parsedValue = JSON.parse(text);
        } catch {
          parsedValue = null;
        }
      }
    }
    return parsedValue;
  };

  const getParsedTextFrame = (): unknown | null => (isBinary ? null : getParsedFrame());

  return { getFrameText, getRawText, getParsedFrame, getParsedTextFrame };
}

/** Insert into a Set while keeping its size bounded (FIFO eviction of oldest entries). */
export function boundedSetAdd<T>(set: Set<T>, value: T, maxSize: number): void {
  if (set.has(value)) return;
  while (set.size >= maxSize) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
  set.add(value);
}

/** Insert/update a Map while keeping its size bounded (LRU-style eviction of oldest entries). */
export function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else {
    while (map.size >= maxSize) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

/** Prune expired timestamp entries and cap a timestamp Map to `maxSize`. */
export function pruneTimestampMap<K>(
  map: Map<K, number>,
  nowMs: number,
  ttlMs: number,
  maxSize: number,
): void {
  for (const [k, ts] of map) {
    if (nowMs - ts > ttlMs) {
      map.delete(k);
    }
  }
  while (map.size > maxSize) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
