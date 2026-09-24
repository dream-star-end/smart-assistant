/** First-message Box CLI tool-use decoder. It progressively forwards blocks
 * but withholds the Anthropic tool_use terminal until the complete snapshot,
 * sidecar pending IDs and durable cross-HTTP journal are verified by caller.
 * This is a protocol primitive, not the production bridge by itself.
 */
import type { BoxToolCatalog } from "./boxToolCatalog.js";
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

export interface BoxToolUse {
  readonly id: string;
  readonly boxName: string;
  readonly clientName: string;
  readonly input: Obj;
}
export interface BoxToolHandoffCandidate {
  readonly messageId: string;
  readonly toolUses: readonly BoxToolUse[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}
export interface BoxToolFinalCandidate {
  readonly messageId: string;
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
  text: string;
  partial: string;
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
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private nextIndex = 0;
  private lastOriginalIndex = -1;
  private active: ActiveBlock | null = null;
  private blocks: Array<{ type: string; text?: string; use?: BoxToolUse }> = [];
  private snapshot: Obj | null = null;
  private heldTerminal: string[] = [];
  private candidate: BoxToolHandoffCandidate | null = null;
  private finalCandidate: BoxToolFinalCandidate | null = null;
  private finalStreamChecked = false;
  private expectedToolIds: readonly string[] = [];
  private remainder = "";

  constructor(private readonly expectedModel: string,
    private readonly catalog: BoxToolCatalog,
    private readonly options: { alreadyInitialized?: boolean; allowFinal?: boolean } = {}) {
    if (!/^claude-[a-z0-9-]{3,64}$/.test(expectedModel)
      || catalog.tools.length < 1) {
      throw new BoxCliToolHandoffError("BOX_TOOL_DECODER_INVALID");
    }
    this.initSeen = options.alreadyInitialized === true;
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
    return this.heldTerminal.join("");
  }

  /** Caller invokes only after remote terminal proof and journal completion. */
  commitFinal(proof: { terminalReason: "worker_complete";
    journaledUsage: { inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheWriteTokens: number } }): string {
    const final = this.finalCandidate;
    if (this.failed || this.committed || !this.finalStreamChecked
      || !final || this.heldTerminal.length !== 2
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
    if (this.failed || this.committed || !this.finalCandidate
      || this.pending.length !== 0 || this.remainder.length !== 0
      || this.splitHighSurrogate.length !== 0) {
      throw new BoxCliToolHandoffError("BOX_TOOL_FINAL_TRAILING_BYTES");
    }
    this.finalStreamChecked = true;
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
    if (record.type === "assistant") {
      const snapshot = obj(record.message);
      if (!this.started || snapshot.id !== this.messageId
        || snapshot.model !== this.expectedModel || snapshot.role !== "assistant"
        || !Array.isArray(snapshot.content)) {
        throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_INVALID");
      }
      this.snapshot = snapshot;
      return "";
    }
    if (record.type === "result") {
      if (!this.options.allowFinal || !this.sawStop || this.stopReason === "tool_use"
        || record.subtype !== "success" || record.is_error !== false) {
        throw new BoxCliToolHandoffError("BOX_TOOL_FINAL_RESULT_INVALID");
      }
      const usage = obj(record.usage);
      if (count(usage.input_tokens) < this.inputTokens
        || count(usage.output_tokens) < this.outputTokens
        || count(usage.cache_read_input_tokens ?? 0) < this.cacheRead
        || count(usage.cache_creation_input_tokens ?? 0) < this.cacheWrite) {
        throw new BoxCliToolHandoffError("BOX_TOOL_FINAL_USAGE_INVALID");
      }
      this.finalCandidate = { messageId: this.messageId!,
        stopReason: this.stopReason as BoxToolFinalCandidate["stopReason"],
        inputTokens: this.inputTokens, outputTokens: this.outputTokens,
        cacheReadTokens: this.cacheRead, cacheWriteTokens: this.cacheWrite };
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
      if (!this.initSeen || this.started) throw new BoxCliToolHandoffError("BOX_TOOL_ORDER_INVALID");
      const message = obj(event.message);
      if (message.model !== this.expectedModel || message.role !== "assistant"
        || typeof message.id !== "string" || !message.id
        || !Array.isArray(message.content) || message.content.length !== 0) {
        throw new BoxCliToolHandoffError("BOX_TOOL_MESSAGE_INVALID");
      }
      const usage = obj(message.usage);
      this.inputTokens = count(usage.input_tokens);
      this.outputTokens = count(usage.output_tokens);
      this.cacheRead = count(usage.cache_read_input_tokens ?? 0);
      this.cacheWrite = count(usage.cache_creation_input_tokens ?? 0);
      this.messageId = message.id;
      this.started = true;
    } else if (kind === "content_block_start") {
      const index = event.index;
      if (!this.started || this.sawStop || this.stopReason !== null || this.active
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
      const active: ActiveBlock = { original: index as number,
        visible: this.nextIndex++, type: type as string,
        text: type === "text" ? block.text as string : "", partial: "" };
      if (type === "tool_use") {
        if (typeof block.id !== "string" || !TOOL_ID.test(block.id)
          || typeof block.name !== "string"
          || !this.catalog.clientNameByBoxName.has(block.name)) {
          throw new BoxCliToolHandoffError("BOX_TOOL_ID_OR_NAME_INVALID");
        }
        active.id = block.id;
        active.boxName = block.name;
        active.clientName = this.catalog.clientNameByBoxName.get(block.name)!;
        active.startInput = obj(block.input);
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
        } else if (!((delta.type === "thinking_delta" && typeof delta.thinking === "string")
          || (delta.type === "signature_delta" && typeof delta.signature === "string"))) {
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
          if (this.blocks.some((item) => item.use?.id === this.active!.id)) {
            throw new BoxCliToolHandoffError("BOX_TOOL_DUPLICATE_ID");
          }
          this.blocks.push({ type: "tool_use", use: { id: this.active.id!,
            boxName: this.active.boxName!, clientName: this.active.clientName!, input } });
        } else this.blocks.push({ type: this.active.type, text: this.active.text });
        this.active = null;
      }
    } else if (kind === "message_delta") {
      if (!this.started || this.active || this.sawStop) {
        throw new BoxCliToolHandoffError("BOX_TOOL_ORDER_INVALID");
      }
      const reason = obj(event.delta).stop_reason;
      if (this.stopReason !== null || (reason !== "tool_use"
        && !(this.options.allowFinal && (reason === "end_turn"
          || reason === "max_tokens" || reason === "stop_sequence")))) {
        throw new BoxCliToolHandoffError("BOX_TOOL_STOP_REASON_INVALID");
      }
      const usage = obj(event.usage);
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
    } else if (kind === "message_stop") {
      if (!this.started || this.active || this.sawStop || this.stopReason === null) {
        throw new BoxCliToolHandoffError("BOX_TOOL_ORDER_INVALID");
      }
      this.sawStop = true;
      this.verifySnapshot();
      const uses = this.blocks.flatMap((block) => block.use ? [block.use] : []);
      if (this.stopReason === "tool_use") {
        if (uses.length < 1) throw new BoxCliToolHandoffError("BOX_TOOL_USE_REQUIRED");
        this.candidate = { messageId: this.messageId!, toolUses: uses,
          inputTokens: this.inputTokens, outputTokens: this.outputTokens,
          cacheReadTokens: this.cacheRead, cacheWriteTokens: this.cacheWrite };
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
    return frame;
  }

  private verifySnapshot(): void {
    const content = this.snapshot?.content;
    if (!Array.isArray(content) || content.length !== this.blocks.length) {
      throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_MISMATCH");
    }
    for (let i = 0; i < this.blocks.length; i++) {
      const observed = obj(content[i]);
      const block = this.blocks[i]!;
      if (observed.type !== block.type) {
        throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_MISMATCH");
      }
      if (block.use) {
        if (observed.id !== block.use.id || observed.name !== block.use.boxName
          || !isDeepStrictEqual(observed.input, block.use.input)) {
          throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_MISMATCH");
        }
      } else if (block.type === "text" && observed.text !== block.text) {
        throw new BoxCliToolHandoffError("BOX_TOOL_SNAPSHOT_MISMATCH");
      }
    }
  }
}
