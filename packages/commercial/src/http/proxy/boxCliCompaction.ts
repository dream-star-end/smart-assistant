/** One finite-state reader for a trusted CLI session's compact carrier.
 * Session identity comes from the plan or journal, never from the record.
 * A summary is not an echo, a model message, a terminal proof, or a bill.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SUMMARY_CHARS = 8192;

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
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
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

/** Returns true when this record is consumed and must not reach echo, SSE, or billing. */
export class BoxCliCompaction {
  private pendingAnchor: string | null = null;
  private consumed = false;

  constructor(readonly trustedSessionId: string) {
    uuid(trustedSessionId, "BOX_CLI_COMPACT_SESSION_INVALID");
  }

  take(record: unknown): boolean {
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
      || block.text.length < 1 || block.text.length > MAX_SUMMARY_CHARS
      || Object.keys(block).some((key) => key !== "type" && key !== "text")) {
      throw new BoxCliCompactionError("BOX_CLI_COMPACT_SUMMARY_INVALID");
    }
  }
}

/** Direct binding used by the continuation source gate. Not a Box capture. */
export function assertOcv5296CompactionBinding(): void {
  const session = "e37f0afa-e659-40ba-84e4-fa90bf465945";
  const anchor = "991406f8-0097-4e91-a2f1-b732812e36fe";
  const reader = new BoxCliCompaction(session);
  const boundary = { type: "system", subtype: "compact_boundary",
    uuid: "adc44006-42e8-4ee0-92c6-6e9fc1412da8", session_id: session,
    logical_parent_uuid: "1216440c-7345-45a9-ba11-8262fd3450c3",
    compact_metadata: { trigger: "auto", pre_tokens: 20000029, post_tokens: 369,
      cumulative_dropped_tokens: 19999660, duration_ms: 202,
      preserved_segment: { head_uuid: "86b0b5b4-2fc6-40a3-a33c-3185d1655975",
        anchor_uuid: anchor, tail_uuid: "1216440c-7345-45a9-ba11-8262fd3450c3" },
      preserved_messages: { anchor_uuid: anchor,
        uuids: ["86b0b5b4-2fc6-40a3-a33c-3185d1655975", "1216440c-7345-45a9-ba11-8262fd3450c3"],
        all_uuids: ["86b0b5b4-2fc6-40a3-a33c-3185d1655975", "1216440c-7345-45a9-ba11-8262fd3450c3"] } } };
  const summary = { type: "user", isSynthetic: true, parent_tool_use_id: null, session_id: session,
    uuid: anchor, timestamp: "2026-09-29T13:35:53.708Z",
    message: { role: "user", content: [{ type: "text", text: "summary" }] } };
  if (!reader.take(boundary) || !reader.take(summary)) {
    throw new BoxCliCompactionError("BOX_CLI_COMPACT_SUMMARY_INVALID");
  }
  reader.assertSettled();
  const wrong = new BoxCliCompaction("11111111-1111-4111-8111-111111111111");
  try {
    wrong.take(boundary);
    throw new Error("accepted foreign session");
  } catch (error) {
    if (!(error instanceof BoxCliCompactionError)
      || error.code !== "BOX_CLI_COMPACT_BOUNDARY_INVALID") throw error;
  }
}
