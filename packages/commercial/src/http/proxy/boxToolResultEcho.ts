/** Semantically bind Claude CLI's user/tool_result echo to the tool results that
 * OpenClaude already published. Echoes are observations, never instructions
 * to execute a tool again or bill another round. */
import { createHash } from "node:crypto";
import type { BoxMatchedToolResult } from "./boxToolResultMatcher.js";
import { compareBoxResult, projectBoxResult } from "./boxResultSemantics.js";
import { recordBoxContinuationCompatibility, recordBoxContinuationRejection } from "./boxContinuationMetrics.js";

type ExpectedEcho = Pick<BoxMatchedToolResult,
  "modelToolUseId" | "contentHash" | "isError">
  & { readonly content?: BoxMatchedToolResult["content"] };
type EchoBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** OCV5-302 / OCV5-653: compare representation changes through the semantic
 * projection. Known lossy rewrites still need the published content and the
 * proofs below; hash-only recovery stays strictly byte-bound:
 *  - empty result -> `(<tool> completed with no output)`;
 *  - text over the MCP 50k-char limit -> the CLI's own `<persisted-output>`
 *    message (buildLargeToolResultMessage/generatePreview), rebuilt here.
 * Images are never relaxed: boxToolResultImages publishes them within the
 * CLI limits, so the CLI passes their bytes through unchanged.
 * OCV5-313: Claude Code 2.1.288 also saves each MCP image under its own
 * tool-results directory and adds a text block naming that file after the
 * image. Only those notes may be extra; every published block must still be
 * echoed byte for byte and in order. */
const EMPTY_MARKER = /^\(mcp__ocbridge__[A-Za-z0-9_-]{1,48} completed with no output\)$/;
/** OCV5-386: Claude Code's own text when it moved an MCP tool call to the background. The Box
 * runs with that disabled; if it ever appears the round still stops, under its own code. */
const CLI_BACKGROUNDED = /^MCP tool "[^"\n]{1,120}" (?:is still running after \d+s|was moved to the background)/;
const CLI_PREVIEW_BYTES = 2000;
/** Claude Code persists an MCP result only when the summed text length
 * (toolResultStorage.contentSize) exceeds min(MCP 100k, default 50k). */
const CLI_PERSIST_THRESHOLD_CHARS = 50_000;

/** OCV5-390: the CLI names the file under its own config directory, so a run under a non-default login
 * (CLAUDE_CONFIG_DIR=/home/box/.claude-<login>, e.g. cc2's .claude-account2) writes that prefix. The
 * login name follows the admin selection rule ([a-z0-9][a-z0-9-]{0,31}); the default login has no suffix,
 * so .claude-default is not a config dir and is refused. */
const IMAGE_SOURCE_NOTE = new RegExp(String.raw`^\[Image: source: /home/box/\.claude(?:-(?!default/)[a-z0-9][a-z0-9-]{0,31})?/projects/`
  // No "." / ".." segment: the note must name a file inside <project>/<session>/tool-results/.
  + String.raw`(?!\.{1,2}/)[A-Za-z0-9._-]{1,256}/[A-Za-z0-9-]{1,64}/tool-results/(?!\.{1,2}\])[A-Za-z0-9._-]{1,128}\]$`);

/** The echo is the published blocks, in order, plus the CLI's own image source
 * notes. A published block is always matched first; a note is only an extra
 * text block that follows an already echoed image. The echo parser's 64-block
 * limit still bounds published blocks plus notes. */
function imageSourceNoted(echoed: EchoBlock[], published: EchoBlock[]): boolean {
  let next = 0, images = 0, notes = 0;
  for (const block of echoed) {
    const want = published[next];
    if (want && block.type === want.type && (block.type === "text"
      ? block.text === (want as { text: string }).text
      : block.data === (want as { data: string }).data
        && block.mimeType === (want as { mimeType: string }).mimeType)) {
      next++;
      if (block.type === "image") images++;
    } else if (block.type === "text" && notes < images && IMAGE_SOURCE_NOTE.test(block.text)) {
      notes++;
    } else return false;
  }
  return next === published.length && notes > 0;
}

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
  if (imageSourceNoted(echoed, published)) return true;
  return echoed.length === 1 && echoed[0]!.type === "text"
    && published.every((block) => block.type === "text")
    && (EMPTY_MARKER.test(echoed[0]!.text) || echoed[0]!.text.startsWith("<persisted-output>\n"));
}

function cliTransformed(echoed: EchoBlock[], expected: ExpectedEcho): boolean {
  const published = expected.content as EchoBlock[] | undefined;
  if (!published || !possibleCliRewrite(echoed, published)) return false;
  if (imageSourceNoted(echoed, published)) return true;
  const text = (echoed[0] as { text: string }).text;
  if (EMPTY_MARKER.test(text)) {
    return published.every((block) => (block as { text: string }).text.trim() === "");
  }
  return published.length > 0 && persistedMatches(text,
    published as Array<{ type: "text"; text: string }>, expected.modelToolUseId);
}

export class BoxToolResultEchoError extends Error {
  constructor(readonly code: string) {
    super(code); this.name = "BoxToolResultEchoError";
    recordBoxContinuationRejection("echo", code);
  }
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxToolResultEchoError("BOX_TOOL_ECHO_INVALID");
  }
  return value as Record<string, unknown>;
}

export class BoxToolResultEcho {
  private readonly expected = new Map<string, ExpectedEcho>();
  private readonly seen = new Set<string>();
  private deferred: Array<{ echoed: EchoBlock[]; expected: ExpectedEcho;
    warning?: "envelope" | "opaque_content" }> = [];
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
        || (block.is_error !== undefined && typeof block.is_error !== "boolean")) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_ID_INVALID");
      }
      let projection: ReturnType<typeof projectBoxResult>;
      try { projection = projectBoxResult(block.content); }
      catch { throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_INVALID"); }
      const normalized = projection.atoms;
      const envelopeChanged = Object.keys(block).some((key) =>
        !["type", "tool_use_id", "content", "is_error"].includes(key));
      const isError = block.is_error === true;
      const hash = createHash("sha256").update(JSON.stringify({
        content: normalized, isError })).digest("hex");
      const expected = this.expected.get(id)!;
      if (isError !== expected.isError) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_MISMATCH");
      }
      const compared = expected.content
        ? compareBoxResult(projection, expected.content) : "incompatible";
      const warning = projection.unknownShape || envelopeChanged
        ? (projection.opaque ? "opaque_content" : "envelope") : undefined;
      if (warning && !expected.content) {
        throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_MISMATCH");
      }
      if (hash !== expected.contentHash && compared === "incompatible") {
        const first = normalized[0];
        if (first?.type === "text" && CLI_BACKGROUNDED.test(first.text)) {
          throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CLI_BACKGROUNDED");
        }
        if (!expected.content || !possibleCliRewrite(normalized, expected.content as EchoBlock[])) {
          throw new BoxToolResultEchoError("BOX_TOOL_ECHO_CONTENT_MISMATCH");
        }
        // Known lossy representations (empty markers / persisted previews /
        // source notes) still require their complete existing proof.
        this.deferred.push({ echoed: normalized, expected, warning });
      } else if (warning) recordBoxContinuationCompatibility("echo", warning);
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
      if (item.warning) recordBoxContinuationCompatibility("echo", item.warning);
    }
  }

  assertComplete(): void {
    if (this.deferred.length > 0) throw new BoxToolResultEchoError("BOX_TOOL_ECHO_UNVERIFIED");
    if (this.seen.size !== this.expected.size) {
      throw new BoxToolResultEchoError("BOX_TOOL_ECHO_INCOMPLETE");
    }
  }
}
