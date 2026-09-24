/** Strictly bind Claude CLI's user/tool_result echo to the tool results that
 * OpenClaude already published. Echoes are observations, never instructions
 * to execute a tool again or bill another round. */
import { createHash } from "node:crypto";
import type { BoxMatchedToolResult } from "./boxToolResultMatcher.js";

export class BoxToolResultEchoError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolResultEchoError"; }
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxToolResultEchoError("BOX_TOOL_ECHO_INVALID");
  }
  return value as Record<string, unknown>;
}
function content(value: unknown): Array<Record<string, unknown>> {
  const blocks = typeof value === "string" ? [{ type: "text", text: value }] : value;
  if (!Array.isArray(blocks) || blocks.length > 64) {
    throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_INVALID");
  }
  return blocks.map((raw) => {
    const block = obj(raw);
    if (block.type === "text" && typeof block.text === "string"
      && Object.keys(block).length === 2 && Object.hasOwn(block, "text")) {
      return { type: "text", text: block.text };
    }
    if (block.type === "image") {
      const source = obj(block.source);
      if (Object.keys(block).length !== 2 || !Object.hasOwn(block, "source")
        || Object.keys(source).length !== 3
        || !Object.hasOwn(source, "type") || !Object.hasOwn(source, "media_type")
        || !Object.hasOwn(source, "data")
        || source.type !== "base64" || typeof source.data !== "string"
        || typeof source.media_type !== "string"
        || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type)) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_INVALID");
      }
      const decoded = Buffer.from(source.data, "base64");
      if (decoded.toString("base64") !== source.data) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_INVALID");
      }
      return { type: "image", data: source.data, mimeType: source.media_type };
    }
    throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_INVALID");
  });
}

export class BoxToolResultEcho {
  private readonly expected = new Map<string, BoxMatchedToolResult>();
  private readonly seen = new Set<string>();
  constructor(results: readonly BoxMatchedToolResult[]) {
    if (!Array.isArray(results) || results.length < 1 || results.length > 32) {
      throw new BoxToolResultEchoError("BOX_TOOL_ECHO_EXPECTED_INVALID");
    }
    for (const result of results) {
      if (!/^toolu_[A-Za-z0-9_-]{1,120}$/.test(result.modelToolUseId)
        || !/^[a-f0-9]{64}$/.test(result.contentHash)
        || this.expected.has(result.modelToolUseId)) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_EXPECTED_INVALID");
      }
      this.expected.set(result.modelToolUseId, result);
    }
  }
  accept(raw: unknown): void {
    const record = obj(raw);
    const message = obj(record.message);
    if (record.type !== "user" || message.role !== "user"
      || !Array.isArray(message.content) || message.content.length < 1
      || message.content.length > this.expected.size) {
      throw new BoxToolResultEchoError("BOX_TOOL_ECHO_INVALID");
    }
    for (const rawBlock of message.content) {
      const block = obj(rawBlock);
      const id = block.tool_use_id;
      if (block.type !== "tool_result" || typeof id !== "string"
        || !this.expected.has(id) || this.seen.has(id)
        || Object.keys(block).some((key) => key !== "type" && key !== "tool_use_id"
          && key !== "content" && key !== "is_error")
        || (block.is_error !== undefined && typeof block.is_error !== "boolean")) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_ID_INVALID");
      }
      const normalized = content(block.content);
      const isError = block.is_error === true;
      const hash = createHash("sha256").update(JSON.stringify({
        content: normalized, isError })).digest("hex");
      const expected = this.expected.get(id)!;
      if (hash !== expected.contentHash || isError !== expected.isError) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_MISMATCH");
      }
      this.seen.add(id);
    }
  }
  assertComplete(): void {
    if (this.seen.size !== this.expected.size) {
      throw new BoxToolResultEchoError("BOX_TOOL_ECHO_INCOMPLETE");
    }
  }
}
