/** One finite-state reader for a trusted CLI session's compact carrier.
 * Session identity comes from the plan or journal, never from the record.
 * A summary is not an echo, a model message, a terminal proof, or a bill.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Supervised stream JSONL is already refused above 1 MiB. A summary is model
 * text inside that stream, so its UTF-8 size stays under the stream cap and
 * still above a short fixture. 512 KiB leaves the billed turn room in 1 MiB.
 * Preserved UUID lists use the existing 128-round product cap, not an
 * unbounded tail and not the previous ungrounded cap of 8. */
export const MAX_SUMMARY_UTF8_BYTES = 512 * 1024;
export const MAX_PRESERVED_UUIDS = 128;
export type BoxCliCompactionPhase = "pre-model" | "in-model";

export class BoxCliCompactionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BoxCliCompactionError";
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxCliCompactionError(code);
  }
  return value as Record<string, unknown>;
}
function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new BoxCliCompactionError(code);
  }
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new BoxCliCompactionError("BOX_CLI_COMPACT_BOUNDARY_INVALID");
  }
  return value as number;
}
function uuidList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRESERVED_UUIDS) {
    throw new BoxCliCompactionError("BOX_CLI_COMPACT_BOUNDARY_INVALID");
  }
  return value.map((item) => uuid(item, "BOX_CLI_COMPACT_BOUNDARY_INVALID"));
}

export function isBoxCliCompactBoundary(record: unknown): boolean {
  return !!record && typeof record === "object" && !Array.isArray(record)
    && (record as { type?: unknown }).type === "system"
    && (record as { subtype?: unknown }).subtype === "compact_boundary";
}
export function isBoxCliSyntheticUser(record: unknown): boolean {
  return !!record && typeof record === "object" && !Array.isArray(record)
    && (record as { type?: unknown }).type === "user"
    && (record as { isSynthetic?: unknown }).isSynthetic === true;
}

/** OCV5-368: the shape of Claude Code's own resume turn after a message ended
 * at `max_tokens` ("Output token limit hit. Resume directly …"): a synthetic
 * top-level user record with exactly one short text block. The wording changes
 * between CLI releases, so only the shape is checked here; the decoder accepts
 * it solely right after a `max_tokens` message_stop. A compact summary has the
 * same shape but always follows a compact_boundary, which stays rejected. */
export const MAX_OUTPUT_LIMIT_RESUME_UTF8_BYTES = 4096;
export function isBoxCliOutputLimitResume(record: unknown): boolean {
  if (!isBoxCliSyntheticUser(record)) return false;
  const row = record as { parent_tool_use_id?: unknown; message?: unknown };
  if (row.parent_tool_use_id !== null) return false;
  const message = row.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user" || !Array.isArray(content) || content.length !== 1) return false;
  const block = content[0];
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  const { type, text } = block as { type?: unknown; text?: unknown };
  return type === "text" && typeof text === "string"
    && Object.keys(block).every((key) => key === "type" || key === "text")
    && Buffer.byteLength(text, "utf8") >= 1
    && Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_LIMIT_RESUME_UTF8_BYTES;
}

/** Returns true when this record is consumed and must not reach echo, SSE, or billing. */
export class BoxCliCompaction {
  private pendingAnchor: string | null = null;
  private consumed = false;

  constructor(readonly trustedSessionId: string) {
    uuid(trustedSessionId, "BOX_CLI_COMPACT_SESSION_INVALID");
  }

  take(record: unknown, phase: BoxCliCompactionPhase): boolean {
    if (phase === "in-model" && (isBoxCliCompactBoundary(record) || isBoxCliSyntheticUser(record))) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_PHASE");
    }
    if (isBoxCliCompactBoundary(record)) {
      if (this.consumed || this.pendingAnchor) {
        throw new BoxCliCompactionError("BOX_CLI_COMPACT_DUPLICATE");
      }
      this.pendingAnchor = this.readBoundary(record);
      return true;
    }
    if (isBoxCliSyntheticUser(record)) {
      if (!this.pendingAnchor) throw new BoxCliCompactionError("BOX_CLI_COMPACT_SUMMARY_INVALID");
      this.readSummary(record, this.pendingAnchor);
      this.pendingAnchor = null;
      this.consumed = true;
      return true;
    }
    if (this.pendingAnchor) throw new BoxCliCompactionError("BOX_CLI_COMPACT_INTERRUPTED");
    return false;
  }

  assertSettled(): void {
    if (this.pendingAnchor) throw new BoxCliCompactionError("BOX_CLI_COMPACT_INTERRUPTED");
  }

  private readBoundary(record: unknown): string {
    const row = object(record, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    if (row.session_id !== this.trustedSessionId) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_BOUNDARY_INVALID");
    }
    uuid(row.uuid, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    if (row.logical_parent_uuid !== undefined) {
      uuid(row.logical_parent_uuid, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    }
    const meta = object(row.compact_metadata, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    if (meta.trigger !== "auto") throw new BoxCliCompactionError("BOX_CLI_COMPACT_BOUNDARY_INVALID");
    count(meta.pre_tokens);
    count(meta.post_tokens);
    count(meta.cumulative_dropped_tokens);
    count(meta.duration_ms);
    const segment = object(meta.preserved_segment, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    const head = uuid(segment.head_uuid, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    const anchor = uuid(segment.anchor_uuid, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    const tail = uuid(segment.tail_uuid, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    const messages = object(meta.preserved_messages, "BOX_CLI_COMPACT_BOUNDARY_INVALID");
    if (uuid(messages.anchor_uuid, "BOX_CLI_COMPACT_BOUNDARY_INVALID") !== anchor) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_BOUNDARY_INVALID");
    }
    const listed = uuidList(messages.uuids);
    const all = uuidList(messages.all_uuids);
    if (!listed.includes(head) || !listed.includes(tail) || !all.includes(head) || !all.includes(tail)) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_BOUNDARY_INVALID");
    }
    return anchor;
  }

  private readSummary(record: unknown, anchor: string): void {
    const row = object(record, "BOX_CLI_COMPACT_SUMMARY_INVALID");
    if (row.session_id !== this.trustedSessionId
      || row.parent_tool_use_id !== null
      || row.isSynthetic !== true
      || uuid(row.uuid, "BOX_CLI_COMPACT_SUMMARY_INVALID") !== anchor) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_SUMMARY_INVALID");
    }
    if (row.timestamp !== undefined && (typeof row.timestamp !== "string"
      || row.timestamp.length < 1 || row.timestamp.length > 40)) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_SUMMARY_INVALID");
    }
    const message = object(row.message, "BOX_CLI_COMPACT_SUMMARY_INVALID");
    if (message.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_SUMMARY_INVALID");
    }
    const block = object(message.content[0], "BOX_CLI_COMPACT_SUMMARY_INVALID");
    if (block.type !== "text" || typeof block.text !== "string"
      || Buffer.byteLength(block.text, "utf8") < 1
      || Buffer.byteLength(block.text, "utf8") > MAX_SUMMARY_UTF8_BYTES
      || Object.keys(block).some((key) => key !== "type" && key !== "text")) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_SUMMARY_INVALID");
    }
  }
}
