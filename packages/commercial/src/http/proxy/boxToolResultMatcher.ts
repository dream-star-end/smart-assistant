/** Bind the next authenticated Messages request to every tool_use from the
 * completed Box model message. This is validation only: tool execution stays
 * in OpenClaude's user container, and publication needs a separate durable CAS. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProxyBody } from "./shared.js";
import type { BoxToolUse } from "./boxCliToolHandoff.js";

const TOOL_ID = /^toolu_[A-Za-z0-9_-]{1,120}$/;
// Leave room for the sidecar result envelope under its 8 MiB frame bound.
const MAX_RESULT_BYTES = 8 * 1024 * 1024 - 4096;
type McpContent = { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export interface BoxMatchedToolResult {
  readonly modelToolUseId: string;
  readonly content: readonly McpContent[];
  readonly isError: boolean;
  readonly contentHash: string;
}
export class BoxToolResultMatchError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolResultMatchError"; }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function content(value: unknown): McpContent[] {
  const blocks = typeof value === "string" ? [{ type: "text", text: value }] : value;
  if (!Array.isArray(blocks) || blocks.length > 64) {
    throw new BoxToolResultMatchError("BOX_TOOL_RESULT_CONTENT_INVALID");
  }
  const out: McpContent[] = [];
  for (const block of blocks) {
    if (!record(block)) throw new BoxToolResultMatchError("BOX_TOOL_RESULT_CONTENT_INVALID");
    if (block.type === "text" && typeof block.text === "string"
      && Object.keys(block).sort().join(",") === "text,type") {
      out.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image" && Object.keys(block).sort().join(",") === "source,type"
      && record(block.source)
      && Object.keys(block.source).sort().join(",") === "data,media_type,type"
      && block.source.type === "base64" && typeof block.source.data === "string"
      && typeof block.source.media_type === "string"
      && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.source.media_type)) {
      const raw = Buffer.from(block.source.data, "base64");
      if (raw.length > MAX_RESULT_BYTES || raw.toString("base64") !== block.source.data) {
        throw new BoxToolResultMatchError("BOX_TOOL_RESULT_CONTENT_INVALID");
      }
      out.push({ type: "image", data: block.source.data,
        mimeType: block.source.media_type });
      continue;
    }
    throw new BoxToolResultMatchError("BOX_TOOL_RESULT_CONTENT_INVALID");
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_RESULT_BYTES) {
    throw new BoxToolResultMatchError("BOX_TOOL_RESULT_TOO_LARGE");
  }
  return out;
}

export function matchBoxToolResults(body: ProxyBody,
  expected: readonly BoxToolUse[]): readonly BoxMatchedToolResult[] {
  if (!Array.isArray(expected) || expected.length < 1 || expected.length > 32
    || !Array.isArray(body.messages) || body.messages.length < 2) {
    throw new BoxToolResultMatchError("BOX_TOOL_RESULT_CONTEXT_INVALID");
  }
  const assistant = body.messages.at(-2), user = body.messages.at(-1);
  if (!record(assistant) || assistant.role !== "assistant"
    || !Array.isArray(assistant.content) || !record(user) || user.role !== "user"
    || !Array.isArray(user.content)) {
    throw new BoxToolResultMatchError("BOX_TOOL_RESULT_CONTEXT_INVALID");
  }
  const uses = assistant.content.filter((block: unknown) => record(block) && block.type === "tool_use");
  if (uses.length !== expected.length || user.content.length !== expected.length) {
    throw new BoxToolResultMatchError("BOX_TOOL_RESULT_SET_MISMATCH");
  }
  for (let i = 0; i < expected.length; i++) {
    const use = uses[i];
    const prior = expected[i]!;
    if (!record(use) || typeof prior.id !== "string" || !TOOL_ID.test(prior.id)
      || use.id !== prior.id || use.name !== prior.clientName
      || !isDeepStrictEqual(use.input, prior.input)) {
      throw new BoxToolResultMatchError("BOX_TOOL_RESULT_HISTORY_MISMATCH");
    }
  }
  const byId = new Map<string, BoxMatchedToolResult>();
  for (const block of user.content) {
    if (!record(block) || block.type !== "tool_result"
      || typeof block.tool_use_id !== "string" || !TOOL_ID.test(block.tool_use_id)
      || Object.keys(block).some((key) =>
        key !== "type" && key !== "tool_use_id" && key !== "content" && key !== "is_error")
      || (block.is_error !== undefined && typeof block.is_error !== "boolean")
      || byId.has(block.tool_use_id)) {
      throw new BoxToolResultMatchError("BOX_TOOL_RESULT_SET_MISMATCH");
    }
    const normalized = content(block.content);
    const isError = block.is_error === true;
    const contentHash = createHash("sha256").update(JSON.stringify({
      content: normalized, isError })).digest("hex");
    byId.set(block.tool_use_id, { modelToolUseId: block.tool_use_id,
      content: normalized, isError, contentHash });
  }
  if (byId.size !== expected.length || expected.some((use) => !byId.has(use.id))) {
    throw new BoxToolResultMatchError("BOX_TOOL_RESULT_SET_MISMATCH");
  }
  return expected.map((use) => byId.get(use.id)!);
}
