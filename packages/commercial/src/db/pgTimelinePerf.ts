import {
  deriveOrderSeqsForRead,
  LAST_MESSAGE_PREVIEW_TAIL_MAX,
  type MessageLike,
} from "@openclaude/storage";

/**
 * SQL expression for tape record visible/raw payload byte size without
 * decompressing TOAST BYTEA on rows populated after migration 0350.
 * Falls back seamlessly to octet_length(...) for legacy NULL rows.
 */
export function precomputedTapePayloadBytesSql(alias = "r"): string {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(${p}visible_payload_bytes, CASE WHEN ${p}visible_payload IS NOT NULL THEN octet_length(${p}visible_payload) ELSE COALESCE(${p}payload_bytes, octet_length(${p}payload)) END)`;
}

/**
 * SQL expression for visible_payload byte length only (used by chunked range
 * reads). Avoids detoasting visible_payload when visible_payload_bytes is set.
 */
export function precomputedTapeVisibleBytesSql(alias = "r"): string {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(${p}visible_payload_bytes, CASE WHEN ${p}visible_payload IS NULL THEN NULL ELSE octet_length(${p}visible_payload) END)`;
}

export interface SupersededErrorModelSidecarLike {
  role: string;
  semanticText: string;
}

/**
 * Precompute `client_session_turn_tape_records.is_superseded_api_error` for all
 * physical ordinals of one prepared turn tape.
 *
 * Matches the exact legacy SQL predicate in `readUnifiedTimelineTapeHeads`:
 * an assistant record is superseded iff its own model sidecars include an
 * assistant `'API Error:%'` entry AND a strictly later physical ordinal has an
 * assistant model sidecar.
 */
export function computeSupersededApiErrorFlags(
  records: ReadonlyArray<{ role: string }>,
  sidecarsByOrdinal: ReadonlyArray<ReadonlyArray<SupersededErrorModelSidecarLike>>,
): boolean[] {
  let maxAssistantModelOrdinal = -1;
  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    const sidecars = sidecarsByOrdinal[ordinal];
    if (sidecars && sidecars.some((m) => m.role === "assistant")) {
      maxAssistantModelOrdinal = ordinal;
    }
  }
  const flags = new Array<boolean>(records.length);
  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    const rec = records[ordinal];
    if (!rec || rec.role !== "assistant" || ordinal >= maxAssistantModelOrdinal) {
      flags[ordinal] = false;
      continue;
    }
    const sidecars = sidecarsByOrdinal[ordinal];
    flags[ordinal] = !!sidecars && sidecars.some(
      (m) => m.role === "assistant" && m.semanticText.startsWith("API Error:"),
    );
  }
  return flags;
}

const LAST_PREVIEW_RAW_MAX_CHARS = 240;

/**
 * Strip PostgreSQL UTF-8 TEXT-illegal NUL (U+0000) and unpaired UTF-16
 * surrogates from a derived sidebar preview string so a derived preview column
 * can NEVER fail an authoritative message write transaction with SQLSTATE 22021
 * (OCV5-824 B4). Matches `toPlainSessionText`, which strips U+0000 as well.
 */
export function sanitizePgTextForPreview(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code === 0) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = raw.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += raw[i]! + raw[i + 1]!;
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += raw[i]!;
  }
  return out;
}

/**
 * Precompute `client_sessions.last_preview` matching the SQL semantics of
 * `listClientSessions`: scan at most the trailing `tailMax` messages newest
 * first, take the first non-empty trimmed `.text` (sanitized to PG-safe UTF-8
 * without NUL/unpaired surrogates), and cap to 240 chars.
 *
 * Returns `""` (empty string, NOT null) when computed with no non-empty text so
 * `listClientSessions` short-circuits `cs.last_preview IS NOT NULL` instead of
 * falling back to `json_array_elements(cs.messages::json)`.
 */
export function computeSessionLastPreviewRaw(
  messages: ReadonlyArray<MessageLike | Record<string, unknown>>,
  tailMax: number = LAST_MESSAGE_PREVIEW_TAIL_MAX,
): string {
  const start = Math.max(0, messages.length - Math.max(1, tailMax));
  for (let i = messages.length - 1; i >= start; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const text = (msg as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const sanitized = sanitizePgTextForPreview(text).trim();
    if (sanitized.length > 0) {
      return sanitized.length > LAST_PREVIEW_RAW_MAX_CHARS
        ? sanitized.slice(0, LAST_PREVIEW_RAW_MAX_CHARS)
        : sanitized;
    }
  }
  return "";
}

/**
 * Preloaded `client_sessions` row passed from `getClientSession` /
 * `getClientSessionPartial` into `readClientTimelinePageImpl` to eliminate the
 * duplicate SELECT and duplicate `JSON.parse(messages)`.
 */
export interface PreloadedTimelineSession {
  messages: string;
  parsedHotMessages?: MessageLike[];
  archived_through_seq: number | null;
  history_revision: string;
  timeline_generation: string;
}

export interface ParsedHotTimelineMessages {
  hot: MessageLike[];
  snapshotMaxSeq: number;
  anyMissingSeq: boolean;
}

/**
 * Parse `client_sessions.messages` once, derive `_orderSeq`, compute
 * `snapshotMaxSeq`, and detect legacy rows missing `_seq`.
 */
export function parseHotTimelineMessages(
  hotJson: string,
  archivedThroughSeq: number,
  sessionId: string,
): ParsedHotTimelineMessages {
  let hot: MessageLike[] = [];
  try {
    const parsed = JSON.parse(hotJson);
    if (Array.isArray(parsed)) {
      hot = deriveOrderSeqsForRead(parsed as MessageLike[], archivedThroughSeq);
    }
  } catch {
    throw new Error(`[pgSessions] unified timeline hot row malformed: ${sessionId}`);
  }
  return summarizeHotTimelineMessages(hot, archivedThroughSeq);
}

export function summarizeHotTimelineMessages(
  hot: MessageLike[],
  archivedThroughSeq: number,
): ParsedHotTimelineMessages {
  let snapshotMaxSeq = 0;
  let anyMissingSeq = false;
  for (const message of hot) {
    if (
      message &&
      typeof message._seq === "number" &&
      Number.isSafeInteger(message._seq) &&
      message._seq > 0
    ) {
      if (message._seq > snapshotMaxSeq) snapshotMaxSeq = message._seq;
    } else {
      anyMissingSeq = true;
    }
  }
  if (snapshotMaxSeq === 0) snapshotMaxSeq = archivedThroughSeq;
  return { hot, snapshotMaxSeq, anyMissingSeq };
}
