import type { PoolClient } from "pg";
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
 * Precompute `client_sessions.last_preview` matching the SQL semantics of
 * `listClientSessions`: scan at most the trailing `tailMax` messages newest
 * first, take the first non-empty trimmed `.text`, and cap to 240 chars.
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
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      return trimmed.length > LAST_PREVIEW_RAW_MAX_CHARS
        ? trimmed.slice(0, LAST_PREVIEW_RAW_MAX_CHARS)
        : trimmed;
    }
  }
  return "";
}

export interface LastDispatchSummaryPayload {
  outcome: string;
  failureCode: string | null;
  terminalAtMs: number;
}

export function serializeLastDispatchSummary(input: {
  outcome: string | null;
  failureCode: string | null;
  terminalAtMs: number | null;
}): string | null {
  if (!input.outcome || !Number.isFinite(input.terminalAtMs)) return null;
  const payload: LastDispatchSummaryPayload = {
    outcome: input.outcome,
    failureCode: input.failureCode ?? null,
    terminalAtMs: Math.floor(input.terminalAtMs!),
  };
  return JSON.stringify(payload);
}

/**
 * Maintain `client_sessions.last_dispatch_summary` inside the caller's
 * transaction. Pass `summaryJson = null` to invalidate the cache (e.g. when a
 * dispatch downgrades to `manual_reconcile`), causing `listClientSessions` to
 * fall back to the indexed LATERAL lookup.
 */
export async function updateSessionLastDispatchSummaryInTx(
  client: Pick<PoolClient, "query">,
  input: {
    sessionId: string;
    userId: string;
    summaryJson: string | null;
  },
): Promise<void> {
  await client.query(
    `UPDATE client_sessions
        SET last_dispatch_summary = $3::jsonb
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [input.sessionId, input.userId, input.summaryJson],
  );
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

export type TimelinePartialFastPathResult =
  | { hit: true; snapshotMaxSeq: number; hotCount: number }
  | {
      hit: false;
      reason:
        | "invalid_since"
        | "missing_seq"
        | "revision_mismatch"
        | "generation_mismatch"
        | "newer_messages"
        | "cursor_ahead";
    };

/**
 * Decide whether `getClientSessionPartial(..., { view: "timeline" })` can
 * safely fast-return an empty incremental delta (`isPartial: true, messages: []`)
 * without re-hydrating turn tapes.
 *
 * Strictly fail-closed: any version jump, timelineGeneration mismatch, missing
 * legacy `_seq`, newer messages (`sinceSeq < snapshotMaxSeq`), or out-of-order
 * cursor (`sinceSeq > snapshotMaxSeq`) falls back to a full unified page.
 */
export function evaluateTimelinePartialFastPath(input: {
  sinceSeq: number;
  sinceHistoryRevision?: number;
  sinceTimelineGeneration?: number;
  historyRevision: number;
  timelineGeneration: number;
  snapshotMaxSeq: number;
  anyMissingSeq: boolean;
  hotCount: number;
}): TimelinePartialFastPathResult {
  if (!Number.isSafeInteger(input.sinceSeq) || input.sinceSeq <= 0) {
    return { hit: false, reason: "invalid_since" };
  }
  if (input.anyMissingSeq) {
    return { hit: false, reason: "missing_seq" };
  }
  if (
    !Number.isSafeInteger(input.sinceHistoryRevision) ||
    input.sinceHistoryRevision !== input.historyRevision
  ) {
    return { hit: false, reason: "revision_mismatch" };
  }
  if (
    input.sinceTimelineGeneration !== undefined &&
    (!Number.isSafeInteger(input.sinceTimelineGeneration) ||
      input.sinceTimelineGeneration !== input.timelineGeneration)
  ) {
    return { hit: false, reason: "generation_mismatch" };
  }
  if (input.sinceSeq > input.snapshotMaxSeq) {
    return { hit: false, reason: "cursor_ahead" };
  }
  if (input.sinceSeq < input.snapshotMaxSeq) {
    return { hit: false, reason: "newer_messages" };
  }
  return { hit: true, snapshotMaxSeq: input.snapshotMaxSeq, hotCount: input.hotCount };
}
