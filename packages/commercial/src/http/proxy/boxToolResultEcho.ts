/** Strictly bind Claude CLI's user/tool_result echo to the tool results that
 * OpenClaude already published. Echoes are observations, never instructions
 * to execute a tool again or bill another round. */
import { createHash } from "node:crypto";
import type { BoxMatchedToolResult } from "./boxToolResultMatcher.js";

type ExpectedEcho = Pick<BoxMatchedToolResult,
  "modelToolUseId" | "contentHash" | "isError">
  & { readonly content?: BoxMatchedToolResult["content"] };
type EchoBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** OCV5-302: Claude Code rewrites some MCP tool results before the model sees
 * them, so its echo can differ from what OpenClaude published. A mismatching
 * echo is accepted only as a byte-exact rebuild of the CLI's rewrite of the
 * published content, which must be in hand (live continuation, or recovery
 * after the hash-verified published file was read); hash-only evidence stays
 * strictly byte-bound:
 *  - empty result -> `(<tool> completed with no output)`;
 *  - text over the MCP 50k-char limit -> the CLI's own `<persisted-output>`
 *    message (buildLargeToolResultMessage/generatePreview), rebuilt here.
 * Images are never relaxed: boxToolResultImages publishes them within the
 * CLI limits, so the CLI passes their bytes through unchanged. */
const EMPTY_MARKER = /^\(mcp__ocbridge__[A-Za-z0-9_-]{1,48} completed with no output\)$/;
const CLI_PREVIEW_BYTES = 2000;
/** Claude Code persists an MCP result only when the summed text length
 * (toolResultStorage.contentSize) exceeds min(MCP 100k, default 50k). */
const CLI_PERSIST_THRESHOLD_CHARS = 50_000;

function cliFileSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  return `${(kb / 1024).toFixed(1).replace(/\.0$/, "")}MB`;
}

/** Claude Code's buildLargeToolResultMessage, rebuilt from the published text. */
function persistedMatches(echo: string, published: Array<{ type: "text"; text: string }>,
  id: string): boolean {
  if (published.reduce((sum, block) => sum + block.text.length, 0) <= CLI_PERSIST_THRESHOLD_CHARS) {
    return false;
  }
  const sources = [JSON.stringify(published, null, 2),
    ...(published.length === 1 ? [published[0]!.text] : [])];
  const path = /^[^\n]{1,4096}\/tool-results\/[^\n/]{0,256}$/;
  for (const source of sources) {
    let preview = source, hasMore = false;
    if (source.length > CLI_PREVIEW_BYTES) {
      const truncated = source.slice(0, CLI_PREVIEW_BYTES);
      const lastNewline = truncated.lastIndexOf("\n");
      preview = source.slice(0, lastNewline > CLI_PREVIEW_BYTES * 0.5 ? lastNewline : CLI_PREVIEW_BYTES);
      hasMore = true;
    }
    const head = `<persisted-output>\nOutput too large (${cliFileSize(source.length)}). Full output saved to: `;
    const tail = `\n\nPreview (first ${cliFileSize(CLI_PREVIEW_BYTES)}):\n${preview}`
      + `${hasMore ? "\n...\n" : "\n"}</persisted-output>`;
    if (echo.startsWith(head) && echo.endsWith(tail) && echo.length > head.length + tail.length) {
      const filepath = echo.slice(head.length, echo.length - tail.length);
      if (path.test(filepath) && filepath.includes(id)) return true;
    }
  }
  return false;
}

/** Synchronous shape test: could this echo be one of the CLI rewrites at all? */
function possibleCliRewrite(echoed: EchoBlock[], published: EchoBlock[]): boolean {
  return echoed.length === 1 && echoed[0]!.type === "text"
    && published.every((block) => block.type === "text")
    && (EMPTY_MARKER.test(echoed[0]!.text) || echoed[0]!.text.startsWith("<persisted-output>\n"));
}

function cliTransformed(echoed: EchoBlock[], expected: ExpectedEcho): boolean {
  const published = expected.content as EchoBlock[] | undefined;
  if (!published || !possibleCliRewrite(echoed, published)) return false;
  const text = (echoed[0] as { text: string }).text;
  if (EMPTY_MARKER.test(text)) {
    return published.every((block) => (block as { text: string }).text.trim() === "");
  }
  return published.length > 0 && persistedMatches(text,
    published as Array<{ type: "text"; text: string }>, expected.modelToolUseId);
}

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
  private readonly expected = new Map<string, ExpectedEcho>();
  private readonly seen = new Set<string>();
  private deferred: Array<{ echoed: EchoBlock[]; expected: ExpectedEcho }> = [];
  constructor(results: readonly ExpectedEcho[]) {
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
      if (isError !== expected.isError || (hash !== expected.contentHash && (!expected.content
        || !possibleCliRewrite(normalized as EchoBlock[], expected.content as EchoBlock[])))) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_MISMATCH");
      }
      // OCV5-302: a possible CLI rewrite of known published content is
      // verified asynchronously (pixels) before the echo may complete.
      if (hash !== expected.contentHash) this.deferred.push({ echoed: normalized as EchoBlock[], expected });
      this.seen.add(id);
    }
  }
  /** Must run before assertComplete when any echo differed from its hash. */
  async verifyDeferred(): Promise<void> {
    const pending = this.deferred;
    this.deferred = [];
    for (const item of pending) {
      if (!cliTransformed(item.echoed, item.expected)) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_MISMATCH");
      }
    }
  }

  assertComplete(): void {
    if (this.deferred.length > 0) throw new BoxToolResultEchoError("BOX_TOOL_ECHO_UNVERIFIED");
    if (this.seen.size !== this.expected.size) {
      throw new BoxToolResultEchoError("BOX_TOOL_ECHO_INCOMPLETE");
    }
  }
}
