/** First-message Box CLI tool-use decoder (one client-visible message; since
 * OCV5-301 it may span model retries after calls the CLI itself rejected). It progressively forwards blocks
 * but withholds the Anthropic tool_use terminal until the complete snapshot,
 * sidecar pending IDs and durable cross-HTTP journal are verified by caller.
 * This is a protocol primitive, not the production bridge by itself.
 */
import { BoxCliCompaction, BoxCliCompactionError, isBoxCliCompactBoundary,
  isBoxCliSyntheticUser } from "./boxCliCompaction.js";
import type { BoxToolCatalog } from "./boxToolCatalog.js";
import { hashBoxAssistantContent, hashBoxAssistantEchoContent,
  hashBoxAssistantNoCallerContent } from "./boxCallFingerprint.js";
import { acceptBoxToolProgress, classifyBoxToolProgress,
  type BoxToolProgressBinding } from "./boxToolProgress.js";
import { isDeepStrictEqual } from "node:util";

export class BoxCliToolHandoffError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxCliToolHandoffError"; }
}

interface Obj { [key: string]: unknown }
function obj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxCliToolHandoffError("BOX_TOOL_STREAM_INVALID");
  }
  return value as Obj;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new BoxCliToolHandoffError("BOX_TOOL_USAGE_INVALID");
  }
  return value as number;
}
const TOOL_ID = /^toolu_[A-Za-z0-9_-]{1,120}$/;
/** OCV5-301: how many consecutive model messages may consist only of calls
 * to tools this invocation does not expose before the run fails closed. */
const BOX_CLI_REJECTED_SEGMENTS_MAX = 3;
/** Exactly Claude Code's unknown-tool answer (services/tools/toolExecution);
 * any other tool error (cancel, permission, validation) is not merged. */
function cliNoSuchToolText(content: unknown, name: string): boolean {
  const expected = `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`;
  if (typeof content === "string") return content === expected;
  return Array.isArray(content) && content.length === 1 && !!content[0]
    && typeof content[0] === "object" && (content[0] as Obj).type === "text"
    && (content[0] as Obj).text === expected;
}

export interface BoxToolUse {
  readonly id: string;
  readonly boxName: string;
  readonly clientName: string;
  readonly input: Obj;
}
export interface BoxToolHandoffCandidate {
  readonly messageId: string;
  /** Full client-visible assistant content, including text/thinking/order. */
  readonly assistantContentHash: string;
  /** CCB echo of non-thinking blocks; used only when CCB omits thinking. */
  readonly assistantEchoHash?: string;
  /** CCB may keep thinking while omitting only tool_use.caller. */
  readonly assistantNoCallerHash: string;
  readonly toolUses: readonly BoxToolUse[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}
export interface BoxToolFinalCandidate {
  readonly messageId: string;
  /** Optional acceleration evidence; empty/oversized final output still bills normally. */
  readonly assistantContentHash?: string;
  readonly stopReason: "end_turn" | "max_tokens" | "stop_sequence";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}
export interface BoxToolHandoffProof {
  /** Receipt from a successful durable journal write, not a local counter. */
  readonly durableRevision: string;
  /** All IDs committed from the completed model message, in model order. */
  readonly journaledToolUseIds: readonly string[];
  /** Nonempty subset whose owner-scoped MCP pending files already exist.
   * Claude Code may dispatch later IDs only after the first result arrives. */
  readonly verifiedPendingToolUseIds: readonly string[];
}
interface ActiveBlock {
  original: number;
  visible: number;
  type: string;
  id?: string;
  boxName?: string;
  clientName?: string;
  startInput?: Obj;
  /** OCV5-301: a call to a tool this run does not expose; never client-visible. */
  rejected?: boolean;
  text: string;
  partial: string;
  start: Obj;
  thinking?: string;
  signature?: string;
}

interface CompletedBlock {
  type: string;
  /** OCV5-301: upstream-only block (a rejected call); excluded from visible content. */
  hidden?: boolean;
  use?: BoxToolUse;
  upstream: Obj;
  visible: Obj;
}

export class BoxCliToolHandoffDecoder {
  private pending = "";
  private bytes = 0;
  private splitHighSurrogate = "";
  private failed = false;
  private committed = false;
  private initSeen = false;
  private started = false;
  private stopReason: string | null = null;
  private sawStop = false;
  private messageId: string | null = null;
  /** Current segment's upstream message id (equals messageId for segment 0). */
  private segmentMessageId: string | null = null;
  private startMessage: Obj | null = null;
  private deltaUsage: Obj = {};
  private stopSequence: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private nextIndex = 0;
  private lastOriginalIndex = -1;
  private active: ActiveBlock | null = null;
  private blocks: CompletedBlock[] = [];
  /** Claude Code can emit one assistant snapshot per completed content block
   * (Opus 5.5: [thinking], then [tool_use]) or a cumulative prefix. */
  private readonly snapshots: Obj[][] = [];
  /** The client executes a tool at its content_block_stop, before message_stop.
   * Hold the entire first tool block and every later frame until the handoff
   * is validated and durable; prior text/thinking still streams live. */
  private holdToolFrames = false;
  private readonly heldToolFrames: string[] = [];
  private heldToolBytes = 0;
  private heldTerminal: string[] = [];
  private candidate: BoxToolHandoffCandidate | null = null;
  private finalCandidate: BoxToolFinalCandidate | null = null;
  private finalStreamChecked = false;
  private expectedToolIds: readonly string[] = [];
  private remainder = "";
  private compaction: BoxCliCompaction | null = null;
  /** OCV5-301 multi-message merge. Claude Code answers a call to a tool it
   * does not expose with its own error result and the model retries in a new
   * message of the same run; native Claude Code shows that as one turn. The
   * segments are merged into the single client-visible message: the rejected
   * call and the CLI's error are dropped, text/thinking already streamed in
   * that message stay (as native shows them), later blocks keep their visible
   * order, and usage is the sum of every segment (each was a paid call). A
   * segment with any exposed (valid) call is never merged. */
  private segments = 0;
  private segmentStart = 0;
  private readonly messageIds = new Set<string>();
  /** Rejected call id -> its tool name, until the CLI's own answer arrives. */
  private awaitingCliErrors: Map<string, string> | null = null;
  private awaitingNextMessage = false;
  private baseInput = 0;
  private baseOutput = 0;
  private baseRead = 0;
  private baseWrite = 0;

  constructor(private readonly expectedModel: string,
    private readonly catalog: BoxToolCatalog,
    private readonly options: { alreadyInitialized?: boolean; allowFinal?: boolean;
      progress?: BoxToolProgressBinding; trustedNativeSessionId?: string } = {}) {
    if (!/^claude-[a-z0-9-]{3,64}$/.test(expectedModel)
      || catalog.tools.length < 1) {
      throw new BoxCliToolHandoffError("BOX_TOOL_DECODER_INVALID");
    }
    this.initSeen = options.alreadyInitialized === true;
    this.compaction = options.trustedNativeSessionId
      ? new BoxCliCompaction(options.trustedNativeSessionId) : null;
  }

  push(chunk: string): { sse: string; candidate: BoxToolHandoffCandidate | null;
    finalCandidate: BoxToolFinalCandidate | null } {
    if (this.failed || this.committed || typeof chunk !== "string") {
      throw new BoxCliToolHandoffError("BOX_TOOL_DECODER_CLOSED");
    }
    try {
      let measured = this.splitHighSurrogate + chunk;
      this.splitHighSurrogate = "";
      if (measured.length > 0) {
        const last = measured.charCodeAt(measured.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          this.splitHighSurrogate = measured.slice(-1);
          measured = measured.slice(0, -1);
        }
      }
      this.bytes += Buffer.byteLength(measured);
      if (this.bytes > 1_048_576) throw new BoxCliToolHandoffError("BOX_TOOL_STREAM_TOO_LARGE");
      this.pending += chunk;
      let emitted = "";
      while (this.candidate === null && this.finalCandidate === null) {
        const index = this.pending.indexOf("\n");
        if (index < 0) break;
        const line = this.pending.slice(0, index).replace(/\r$/, "");
        this.pending = this.pending.slice(index + 1);
        if (line) emitted += this.record(obj(JSON.parse(line)));
      }
      if ((this.candidate !== null || this.finalCandidate !== null) && this.pending) {
        this.remainder += this.pending;
        this.pending = "";
      }
      return { sse: emitted, candidate: this.candidate
        ? structuredClone(this.candidate) : null,
      finalCandidate: this.finalCandidate ? structuredClone(this.finalCandidate) : null };
    } catch (error) {
      this.failed = true;
      throw error instanceof BoxCliToolHandoffError ? error
        : new BoxCliToolHandoffError("BOX_TOOL_STREAM_INVALID");
    }
  }

  /** Model-visible completed Message, not a CLI JSONL record or partial SSE.
   * Callers may persist this privately before committing handoff/terminal
   * evidence; the returned clone cannot mutate decoder authorization state. */
  completedMessage(): Obj {
    if (this.failed || !this.sawStop || !this.startMessage || !this.messageId
      || !this.stopReason || (!this.candidate && !this.finalCandidate)) {
      throw new BoxCliToolHandoffError("BOX_TOOL_MESSAGE_NOT_COMPLETE");
    }
    const startUsage = obj(this.startMessage.usage);
    return structuredClone({ ...this.startMessage, type: "message", role: "assistant",
      id: this.messageId, model: this.expectedModel,
      content: this.visibleBlocks(),
      stop_reason: this.stopReason, stop_sequence: this.stopSequence,
      usage: { ...startUsage, ...this.deltaUsage, input_tokens: this.totals().inputTokens,
        output_tokens: this.totals().outputTokens,
        cache_read_input_tokens: this.totals().cacheReadTokens,
        cache_creation_input_tokens: this.totals().cacheWriteTokens } });
  }

  /** Only call after sidecar pending records and durable journal agree. */
  commitHandoff(proof: BoxToolHandoffProof): string {
    if (this.failed || this.committed || !this.candidate || this.heldTerminal.length !== 2) {
      throw new BoxCliToolHandoffError("BOX_TOOL_HANDOFF_NOT_READY");
    }
    if (!proof || typeof proof.durableRevision !== "string"
      || !Array.isArray(proof.journaledToolUseIds)
      || !Array.isArray(proof.verifiedPendingToolUseIds)
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(proof.durableRevision)
      || proof.journaledToolUseIds.length !== this.expectedToolIds.length
      || this.expectedToolIds.some((id, index) =>
        !Object.hasOwn(proof.journaledToolUseIds, index)
        || proof.journaledToolUseIds[index] !== id)
      || proof.verifiedPendingToolUseIds.length < 1
      || proof.verifiedPendingToolUseIds.length > this.expectedToolIds.length
      || new Set(proof.verifiedPendingToolUseIds).size !== proof.verifiedPendingToolUseIds.length
      || Array.from({ length: proof.verifiedPendingToolUseIds.length }, (_, index) => index)
        .some((index) => !Object.hasOwn(proof.verifiedPendingToolUseIds, index)
          || !this.expectedToolIds.includes(proof.verifiedPendingToolUseIds[index]!))) {
      throw new BoxCliToolHandoffError("BOX_TOOL_HANDOFF_PROOF_INVALID");
    }
    this.committed = true;
    return this.heldToolFrames.join("") + this.heldTerminal.join("");
  }

  /** Caller invokes only after remote terminal proof and journal completion. */
  commitFinal(proof: { terminalReason: "worker_complete";
    journaledUsage: { inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheWriteTokens: number } }): string {
    const final = this.finalCandidate;
    if (this.failed || this.committed || !this.finalStreamChecked
      || !final || this.heldTerminal.length !== 2
      || this.heldToolFrames.length !== 0
      || proof?.terminalReason !== "worker_complete"
      || !proof.journaledUsage
      || proof.journaledUsage.inputTokens !== final.inputTokens
      || proof.journaledUsage.outputTokens !== final.outputTokens
      || proof.journaledUsage.cacheReadTokens !== final.cacheReadTokens
      || proof.journaledUsage.cacheWriteTokens !== final.cacheWriteTokens) {
      throw new BoxCliToolHandoffError("BOX_TOOL_FINAL_PROOF_INVALID");
    }
    this.committed = true;
    return this.heldTerminal.join("");
  }

  /** Call only after nonce/epoch-bound remote stop AND an exact spool EOF read. */
  finishFinal(): void {
    if (this.compaction) {
      try { this.compaction.assertSettled(); }
      catch (error) {
        if (error instanceof BoxCliCompactionError) throw new BoxCliToolHandoffError(error.code);
        throw error;
      }
    }
    if (this.failed || this.committed || !this.finalCandidate
      || this.pending.length !== 0 || this.remainder.length !== 0
      || this.splitHighSurrogate.length !== 0) {
      throw new BoxCliToolHandoffError("BOX_TOOL_FINAL_TRAILING_BYTES");
    }
    this.finalStreamChecked = true;
  }

  /** True while Claude Code's own error result for a rejected call is due;
   * feed loops must pass such `user` records to the decoder, not the echo. */
  awaitingCliToolError(): boolean {
    return this.awaitingCliErrors !== null;
  }

  private totals(): { inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number } {
    return { inputTokens: this.baseInput + this.inputTokens,
      outputTokens: this.baseOutput + this.outputTokens,
      cacheReadTokens: this.baseRead + this.cacheRead,
      cacheWriteTokens: this.baseWrite + this.cacheWrite };
  }

  private visibleBlocks(): Obj[] {
    return this.blocks.filter((block) => !block.hidden).map((block) => block.visible);
  }

  private acceptCliToolErrors(record: Obj): void {
    const awaiting = this.awaitingCliErrors;
    const message = obj(record.message);
    const content = message.content;
    if (!awaiting || record.isSynthetic === true || message.role !== "user"
      || !Array.isArray(content) || content.length < 1 || content.length > awaiting.size) {
      throw new BoxCliToolHandoffError("BOX_TOOL_CLI_ERROR_INVALID");
    }
    for (const raw of content) {
      const item = obj(raw);
      if (item.type !== "tool_result" || item.is_error !== true
        || typeof item.tool_use_id !== "string" || !awaiting.has(item.tool_use_id)
        || !cliNoSuchToolText(item.content, awaiting.get(item.tool_use_id)!)) {
        throw new BoxCliToolHandoffError("BOX_TOOL_CLI_ERROR_INVALID");
      }
      awaiting.delete(item.tool_use_id);
    }
    if (awaiting.size === 0) {
      this.awaitingCliErrors = null;
      this.awaitingNextMessage = true;
    }
  }

  takeRemainder(): string {
    const raw = this.remainder;
    this.remainder = "";
    return raw;
  }

  private record(record: Obj): string {
    if (this.candidate || this.finalCandidate) {
      throw new BoxCliToolHandoffError("BOX_TOOL_AFTER_HANDOFF");
    }
    if (this.compaction) {
      try {
        if (this.compaction.take(record, this.started ? "in-model" : "pre-model")) return "";
      } catch (error) {
        if (error instanceof BoxCliCompactionError) {
          throw new BoxCliToolHandoffError(error.code);
        }
        throw error;
      }
    } else if (isBoxCliCompactBoundary(record) || isBoxCliSyntheticUser(record)) {
      throw new BoxCliToolHandoffError("BOX_CLI_COMPACT_UNBOUND");
    }
    const progress = classifyBoxToolProgress(record);
    if (progress.kind === "malformed") {
      throw new BoxCliToolHandoffError("BOX_TOOL_RECORD_INVALID");
    }
    if (progress.kind === "heartbeat") {
      // Previous-tool telemetry is only valid before this message starts.
      // No SSE, usage, tool id, or modelStarted flag is produced.
      if (this.started || this.sawStop || !acceptBoxToolProgress(
        progress.heartbeat, this.options.progress)) {
        throw new BoxCliToolHandoffError("BOX_TOOL_RECORD_INVALID");
      }
      return "";
    }
    if (record.type === "system" && record.subtype === "init") {
      if (this.initSeen || this.started || !Array.isArray(record.tools)
        || record.tools.length !== this.catalog.tools.length
        || new Set(record.tools).size !== this.catalog.tools.length
        || !Array.isArray(record.mcp_servers) || record.mcp_servers.length !== 1
        || record.tools.some((name) => typeof name !== "string"
          || !this.catalog.clientNameByBoxName.has(name))) {
        throw new BoxCliToolHandoffError("BOX_TOOL_INIT_INVALID");
      }
      this.initSeen = true;
      return "";
    }
    if (record.type === "system" || record.type === "rate_limit_event") return "";
    if (record.type === "user") {
      if (!this.awaitingCliErrors) throw new BoxCliToolHandoffError("BOX_TOOL_RECORD_INVALID");
      this.acceptCliToolErrors(record);
      return "";
    }
    if (this.awaitingCliErrors) throw new BoxCliToolHandoffError("BOX_TOOL_CLI_ERROR_MISSING");
    if (record.type === "assistant") {
      const snapshot = obj(record.message);
      const content = snapshot.content;
      if (!this.started || this.awaitingNextMessage || snapshot.id !== this.segmentMessageId
        || snapshot.model !== this.expectedModel || snapshot.role !== "assistant"
        || !Array.isArray(content) || content.length > 32
        || this.snapshots.length >= 128
        || Array.from({ length: content.length }, (_, i) => i)
          .some((i) => !Object.hasOwn(content, i)
            || !content[i] || typeof content[i] !== "object"
            || Array.isArray(content[i]))) {
        throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_INVALID");
      }
      this.snapshots.push(structuredClone(content) as Obj[]);
      return "";
    }
    if (record.type === "result") {
      if (!this.options.allowFinal || !this.sawStop || this.stopReason === "tool_use"
        || record.subtype !== "success" || record.is_error !== false) {
        throw new BoxCliToolHandoffError("BOX_TOOL_FINAL_RESULT_INVALID");
      }
      const usage = obj(record.usage);
      const total = this.totals();
      if (count(usage.input_tokens) < total.inputTokens
        || count(usage.output_tokens) < total.outputTokens
        || count(usage.cache_read_input_tokens ?? 0) < total.cacheReadTokens
        || count(usage.cache_creation_input_tokens ?? 0) < total.cacheWriteTokens) {
        throw new BoxCliToolHandoffError("BOX_TOOL_FINAL_USAGE_INVALID");
      }
      const visibleCount = this.visibleBlocks().length;
      this.finalCandidate = { messageId: this.messageId!,
        ...(visibleCount >= 1 && visibleCount <= 64
          ? { assistantContentHash: this.visibleAssistantContentHash() } : {}),
        stopReason: this.stopReason as BoxToolFinalCandidate["stopReason"],
        ...total };
      return "";
    }
    if (record.type !== "stream_event") {
      throw new BoxCliToolHandoffError("BOX_TOOL_RECORD_INVALID");
    }
    const event = obj(record.event);
    const kind = event.type;
    if (typeof kind !== "string") throw new BoxCliToolHandoffError("BOX_TOOL_EVENT_INVALID");
    let forwarded: Obj = event;
    if (kind === "message_start") {
      if (!this.initSeen || (this.started && !this.awaitingNextMessage)) {
        throw new BoxCliToolHandoffError("BOX_TOOL_ORDER_INVALID");
      }
      const message = obj(event.message);
      if (message.model !== this.expectedModel || message.role !== "assistant"
        || typeof message.id !== "string" || !message.id || this.messageIds.has(message.id)
        || !Array.isArray(message.content) || message.content.length !== 0) {
        throw new BoxCliToolHandoffError("BOX_TOOL_MESSAGE_INVALID");
      }
      const usage = obj(message.usage);
      const segmentUsage = { input: count(usage.input_tokens), output: count(usage.output_tokens),
        read: count(usage.cache_read_input_tokens ?? 0),
        write: count(usage.cache_creation_input_tokens ?? 0) };
      this.messageIds.add(message.id);
      this.segmentMessageId = message.id;
      if (this.awaitingNextMessage) {
        // The client already holds this turn's message_start; the retry
        // continues the same visible message (OCV5-301).
        this.baseInput += this.inputTokens;
        this.baseOutput += this.outputTokens;
        this.baseRead += this.cacheRead;
        this.baseWrite += this.cacheWrite;
        this.inputTokens = segmentUsage.input;
        this.outputTokens = segmentUsage.output;
        this.cacheRead = segmentUsage.read;
        this.cacheWrite = segmentUsage.write;
        this.awaitingNextMessage = false;
        this.stopReason = null;
        this.stopSequence = null;
        this.sawStop = false;
        this.deltaUsage = {};
        this.lastOriginalIndex = -1;
        this.snapshots.length = 0;
        this.segmentStart = this.blocks.length;
        this.heldTerminal = [];
        return "";
      }
      this.inputTokens = segmentUsage.input;
      this.outputTokens = segmentUsage.output;
      this.cacheRead = segmentUsage.read;
      this.cacheWrite = segmentUsage.write;
      this.messageId = message.id;
      this.startMessage = structuredClone(message);
      this.started = true;
    } else if (kind === "content_block_start") {
      const index = event.index;
      if (!this.started || this.awaitingNextMessage || this.sawStop
        || this.stopReason !== null || this.active
        || !Number.isSafeInteger(index) || Number(index) <= this.lastOriginalIndex
        || Number(index) < 0) throw new BoxCliToolHandoffError("BOX_TOOL_ORDER_INVALID");
      const block = obj(event.content_block);
      const type = block.type;
      if (type !== "tool_use" && type !== "text" && type !== "thinking"
        && type !== "redacted_thinking") {
        throw new BoxCliToolHandoffError("BOX_TOOL_BLOCK_INVALID");
      }
      if (type === "text" && typeof block.text !== "string") {
        throw new BoxCliToolHandoffError("BOX_TOOL_BLOCK_INVALID");
      }
      if ((type === "thinking" && block.thinking !== undefined
          && typeof block.thinking !== "string")
        || (type === "redacted_thinking" && typeof block.data !== "string")
        || (block.signature !== undefined && typeof block.signature !== "string")) {
        throw new BoxCliToolHandoffError("BOX_TOOL_BLOCK_INVALID");
      }
      const active: ActiveBlock = { original: index as number,
        visible: this.nextIndex++, type: type as string,
        text: type === "text" ? block.text as string : "", partial: "",
        start: { ...block },
        thinking: typeof block.thinking === "string" ? block.thinking : undefined,
        signature: typeof block.signature === "string" ? block.signature : undefined };
      if (type === "tool_use" && typeof block.id === "string" && TOOL_ID.test(block.id)
        && typeof block.name === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(block.name)
        && !this.catalog.clientNameByBoxName.has(block.name)
        && !this.holdToolFrames && this.segments < BOX_CLI_REJECTED_SEGMENTS_MAX) {
        // OCV5-301: Claude Code answers this call itself (`No such tool
        // available`) and the model retries. Consume it silently; it is never
        // shown, executed, or handed to the client.
        active.id = block.id;
        active.boxName = block.name;
        active.rejected = true;
        active.startInput = obj(block.input);
        this.active = active;
        this.nextIndex--;
        this.lastOriginalIndex = index as number;
        return "";
      }
      if (type === "tool_use") {
        if (typeof block.id !== "string" || !TOOL_ID.test(block.id)
          || typeof block.name !== "string"
          || !this.catalog.clientNameByBoxName.has(block.name)
          || this.blocks.slice(this.segmentStart).some((item) => item.hidden)) {
          throw new BoxCliToolHandoffError("BOX_TOOL_ID_OR_NAME_INVALID");
        }
        active.id = block.id;
        active.boxName = block.name;
        active.clientName = this.catalog.clientNameByBoxName.get(block.name)!;
        active.startInput = obj(block.input);
        this.holdToolFrames = true;
        forwarded = { ...event, index: active.visible,
          content_block: { ...block, name: active.clientName } };
      } else {
        forwarded = { ...event, index: active.visible };
      }
      this.active = active;
      this.lastOriginalIndex = index as number;
    } else if (kind === "content_block_delta" || kind === "content_block_stop") {
      if (!this.active || this.active.original !== event.index || this.sawStop
        || this.stopReason !== null) throw new BoxCliToolHandoffError("BOX_TOOL_ORDER_INVALID");
      if (this.active.rejected) {
        if (kind === "content_block_delta") {
          const delta = obj(event.delta);
          if (delta.type !== "input_json_delta" || typeof delta.partial_json !== "string") {
            throw new BoxCliToolHandoffError("BOX_TOOL_DELTA_INVALID");
          }
          this.active.partial += delta.partial_json;
          if (Buffer.byteLength(this.active.partial) > 262_144) {
            throw new BoxCliToolHandoffError("BOX_TOOL_INPUT_TOO_LARGE");
          }
          return "";
        }
        let input: Obj;
        try {
          input = this.active.partial ? obj(JSON.parse(this.active.partial))
            : this.active.startInput!;
        } catch { throw new BoxCliToolHandoffError("BOX_TOOL_INPUT_INVALID"); }
        const rejectedId = this.active.id!;
        if (this.blocks.some((item) => item.upstream.id === rejectedId)) {
          throw new BoxCliToolHandoffError("BOX_TOOL_DUPLICATE_ID");
        }
        const upstream = { ...this.active.start, input };
        this.blocks.push({ type: "tool_use", hidden: true, upstream, visible: upstream });
        this.active = null;
        return "";
      }
      forwarded = { ...event, index: this.active.visible };
      if (kind === "content_block_delta") {
        const delta = obj(event.delta);
        if (this.active.type === "tool_use") {
          if (delta.type !== "input_json_delta" || typeof delta.partial_json !== "string") {
            throw new BoxCliToolHandoffError("BOX_TOOL_DELTA_INVALID");
          }
          this.active.partial += delta.partial_json;
          if (Buffer.byteLength(this.active.partial) > 262_144) {
            throw new BoxCliToolHandoffError("BOX_TOOL_INPUT_TOO_LARGE");
          }
        } else if (this.active.type === "text") {
          if (delta.type !== "text_delta" || typeof delta.text !== "string") {
            throw new BoxCliToolHandoffError("BOX_TOOL_DELTA_INVALID");
          }
          this.active.text += delta.text;
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          this.active.thinking = (this.active.thinking ?? "") + delta.thinking;
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          // Anthropic's MessageStream accumulation overwrites on each
          // signature_delta; signatures are complete values, not fragments.
          this.active.signature = delta.signature;
        } else {
          throw new BoxCliToolHandoffError("BOX_TOOL_DELTA_INVALID");
        }
      } else {
        if (this.active.type === "tool_use") {
          let input: Obj;
          try {
            input = this.active.partial ? obj(JSON.parse(this.active.partial))
              : this.active.startInput!;
          } catch { throw new BoxCliToolHandoffError("BOX_TOOL_INPUT_INVALID"); }
          if (this.active.partial && Object.keys(this.active.startInput!).length > 0) {
            throw new BoxCliToolHandoffError("BOX_TOOL_INPUT_INVALID");
          }
          // Hidden (rejected) calls count too: an id is used once per turn.
          if (this.blocks.some((item) => item.use?.id === this.active!.id
            || item.upstream.id === this.active!.id)) {
            throw new BoxCliToolHandoffError("BOX_TOOL_DUPLICATE_ID");
          }
          const use = { id: this.active.id!, boxName: this.active.boxName!,
            clientName: this.active.clientName!, input };
          const upstream = { ...this.active.start, input };
          this.blocks.push({ type: "tool_use", use, upstream,
            visible: { ...upstream, name: use.clientName } });
        } else {
          const upstream = { ...this.active.start };
          if (this.active.type === "text") upstream.text = this.active.text;
          if (this.active.thinking !== undefined) upstream.thinking = this.active.thinking;
          if (this.active.signature !== undefined) upstream.signature = this.active.signature;
          this.blocks.push({ type: this.active.type, upstream, visible: upstream });
        }
        this.active = null;
      }
    } else if (kind === "message_delta") {
      if (!this.started || this.awaitingNextMessage || this.active || this.sawStop) {
        throw new BoxCliToolHandoffError("BOX_TOOL_ORDER_INVALID");
      }
      const reason = obj(event.delta).stop_reason;
      if (this.stopReason !== null || (reason !== "tool_use"
        && !(this.options.allowFinal && (reason === "end_turn"
          || reason === "max_tokens" || reason === "stop_sequence")))) {
        throw new BoxCliToolHandoffError("BOX_TOOL_STOP_REASON_INVALID");
      }
      const usage = obj(event.usage);
      this.deltaUsage = { ...this.deltaUsage, ...usage };
      if ((usage.input_tokens !== undefined && count(usage.input_tokens) !== this.inputTokens)
        || (usage.cache_read_input_tokens !== undefined
          && count(usage.cache_read_input_tokens) !== this.cacheRead)
        || (usage.cache_creation_input_tokens !== undefined
          && count(usage.cache_creation_input_tokens) !== this.cacheWrite)) {
        throw new BoxCliToolHandoffError("BOX_TOOL_USAGE_MISMATCH");
      }
      const nextOutput = count(usage.output_tokens);
      if (nextOutput < this.outputTokens) throw new BoxCliToolHandoffError("BOX_TOOL_USAGE_REGRESSION");
      this.outputTokens = nextOutput;
      this.stopReason = reason as string;
      const sequence = obj(event.delta).stop_sequence;
      if (sequence !== undefined && sequence !== null && typeof sequence !== "string") {
        throw new BoxCliToolHandoffError("BOX_TOOL_STOP_REASON_INVALID");
      }
      this.stopSequence = typeof sequence === "string" ? sequence : null;
      if (this.segments > 0) {
        const total = this.totals();
        forwarded = { ...event, usage: { ...usage,
          ...(usage.input_tokens !== undefined ? { input_tokens: total.inputTokens } : {}),
          output_tokens: total.outputTokens,
          ...(usage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: total.cacheReadTokens } : {}),
          ...(usage.cache_creation_input_tokens !== undefined
            ? { cache_creation_input_tokens: total.cacheWriteTokens } : {}) } };
      }
    } else if (kind === "message_stop") {
      if (!this.started || this.awaitingNextMessage || this.active || this.sawStop
        || this.stopReason === null) {
        throw new BoxCliToolHandoffError("BOX_TOOL_ORDER_INVALID");
      }
      this.sawStop = true;
      this.verifySnapshot();
      const uses = this.blocks.flatMap((block) => block.use ? [block.use] : []);
      const rejected = this.blocks.slice(this.segmentStart).filter((block) => block.hidden);
      if (rejected.length > 0) {
        if (this.stopReason !== "tool_use"
          || this.blocks.slice(this.segmentStart).some((block) => block.use)) {
          throw new BoxCliToolHandoffError("BOX_TOOL_ID_OR_NAME_INVALID");
        }
        this.segments++;
        this.awaitingCliErrors = new Map(rejected.map((block) =>
          [block.upstream.id as string, block.upstream.name as string]));
        this.heldTerminal = [];
        return "";
      }
      if (this.stopReason === "tool_use") {
        if (uses.length < 1) throw new BoxCliToolHandoffError("BOX_TOOL_USE_REQUIRED");
        this.candidate = { messageId: this.messageId!,
          assistantContentHash: this.visibleAssistantContentHash(),
          assistantEchoHash: hashBoxAssistantEchoContent(this.visibleBlocks()),
          assistantNoCallerHash: hashBoxAssistantNoCallerContent(this.visibleBlocks()),
          toolUses: uses, ...this.totals() };
        this.expectedToolIds = uses.map((use) => use.id);
      } else if (uses.length > 0 || !this.options.allowFinal) {
        throw new BoxCliToolHandoffError("BOX_TOOL_STOP_REASON_INVALID");
      }
    } else if (kind !== "ping") {
      throw new BoxCliToolHandoffError("BOX_TOOL_EVENT_UNSUPPORTED");
    }
    const frame = `event: ${kind}\ndata: ${JSON.stringify(forwarded)}\n\n`;
    if (kind === "message_delta" || kind === "message_stop") {
      this.heldTerminal.push(frame);
      return "";
    }
    if (this.holdToolFrames) {
      this.heldToolBytes += Buffer.byteLength(frame);
      if (this.heldToolBytes > 16 * 1024 * 1024) {
        throw new BoxCliToolHandoffError("BOX_TOOL_HELD_FRAMES_TOO_LARGE");
      }
      this.heldToolFrames.push(frame);
      return "";
    }
    return frame;
  }

  private verifySnapshot(): void {
    if (this.snapshots.length === 0) {
      throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_MISMATCH");
    }
    // Each merged segment is its own upstream message (OCV5-301).
    const blocks = this.blocks.slice(this.segmentStart);
    // An identical next block can look like either a repeated cumulative
    // prefix or a new segment. Keep every bounded valid coverage position;
    // choosing one greedily would reject [A,A,T] with snapshots [A],[A],[T].
    let covered = new Set<number>([0]);
    for (const content of this.snapshots) {
      if (content.length === 0) continue;
      const next = new Set<number>();
      for (const position of covered) {
        if (content.length >= position && content.length <= blocks.length
          && content.every((observed, i) =>
            isDeepStrictEqual(observed, blocks[i]?.upstream))) {
          next.add(content.length);
        }
        if (position + content.length <= blocks.length
          && content.every((observed, i) =>
            isDeepStrictEqual(observed, blocks[position + i]?.upstream))) {
          next.add(position + content.length);
        }
      }
      if (next.size === 0) {
        throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_MISMATCH");
      }
      covered = next;
    }
    if (!covered.has(blocks.length)) {
      throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_MISMATCH");
    }
  }

  private visibleAssistantContentHash(): string {
    try {
      return hashBoxAssistantContent(this.visibleBlocks());
    } catch {
      throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_MISMATCH");
    }
  }
}
