/** Convert a completed, supervised Claude CLI stream-json call back to
 * Anthropic Messages SSE without rewriting model events or trusting prose.
 * Tool handoffs need a separate live-path; this complete-call path forbids
 * tool_use so it can never swallow a pending OpenClaude-local tool execution.
 */
export class BoxCliSseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BoxCliSseError";
  }
}

interface ObjectValue { [key: string]: unknown }
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxCliSseError("BOX_CLI_STREAM_INVALID");
  }
  return value as ObjectValue;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new BoxCliSseError("BOX_CLI_USAGE_INVALID");
  }
  return value as number;
}
function usage(value: unknown): ObjectValue {
  const parsed = object(value);
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens",
    "cache_creation_input_tokens"]) {
    if (parsed[key] !== undefined) count(parsed[key]);
  }
  return parsed;
}

export interface BoxCliSseResult {
  sse: string;
  inputTokens: number;
  outputTokens: number;
}

export function completedBoxCliToSse(stdout: string, expectedModel: string): BoxCliSseResult {
  if (!stdout || Buffer.byteLength(stdout) > 1_048_576 || !expectedModel) {
    throw new BoxCliSseError("BOX_CLI_STREAM_INVALID");
  }
  let started = false, stopped = false, resultSeen = false, initSeen = false;
  let inputTokens: number | null = null, outputTokens: number | null = null;
  let cacheRead = 0, cacheCreation = 0, nextIndex = 0, deltaPhase = false;
  let stopReason: string | null = null;
  let activeBlock: { index: number; type: string } | null = null;
  const frames: string[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let record: ObjectValue;
    try { record = object(JSON.parse(line)); }
    catch { throw new BoxCliSseError("BOX_CLI_STREAM_INVALID"); }
    const kind = record.type;
    if (kind === "stream_event") {
      const event = object(record.event);
      const eventType = event.type;
      if (typeof eventType !== "string") throw new BoxCliSseError("BOX_CLI_EVENT_INVALID");
      if (eventType === "message_start") {
        if (started || !initSeen) throw new BoxCliSseError("BOX_CLI_EVENT_ORDER_INVALID");
        const message = object(event.message);
        if (message.model !== expectedModel) throw new BoxCliSseError("BOX_CLI_MODEL_MISMATCH");
        if (!Array.isArray(message.content) || message.content.length !== 0) {
          throw new BoxCliSseError("BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
        }
        const startUsage = usage(message.usage);
        inputTokens = count(startUsage.input_tokens);
        outputTokens = count(startUsage.output_tokens);
        cacheRead = count(startUsage.cache_read_input_tokens ?? 0);
        cacheCreation = count(startUsage.cache_creation_input_tokens ?? 0);
        started = true;
      } else if (eventType === "content_block_start") {
        const index = event.index;
        if (!started || stopped || deltaPhase || !Number.isSafeInteger(index) || index !== nextIndex
          || activeBlock !== null) throw new BoxCliSseError("BOX_CLI_EVENT_ORDER_INVALID");
        const block = object(event.content_block);
        if (block.type === "tool_use") throw new BoxCliSseError("BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
        if (block.type !== "text" && block.type !== "thinking" && block.type !== "redacted_thinking") {
          throw new BoxCliSseError("BOX_CLI_BLOCK_UNSUPPORTED");
        }
        activeBlock = { index: index as number, type: block.type as string };
      } else if (eventType === "content_block_delta" || eventType === "content_block_stop") {
        const index = event.index;
        if (!started || stopped || deltaPhase || activeBlock === null || activeBlock.index !== index) {
          throw new BoxCliSseError("BOX_CLI_EVENT_ORDER_INVALID");
        }
        if (eventType === "content_block_stop") {
          activeBlock = null;
          nextIndex++;
        } else {
          const delta = object(event.delta);
          if (!((activeBlock.type === "text" && delta.type === "text_delta" && typeof delta.text === "string")
            || (activeBlock.type === "thinking" && delta.type === "thinking_delta"
              && typeof delta.thinking === "string")
            || (activeBlock.type === "thinking" && delta.type === "signature_delta"
              && typeof delta.signature === "string"))) {
            throw new BoxCliSseError("BOX_CLI_DELTA_INVALID");
          }
        }
      } else if (eventType === "message_delta") {
        if (!started || stopped || activeBlock !== null) throw new BoxCliSseError("BOX_CLI_EVENT_ORDER_INVALID");
        deltaPhase = true;
        const reason = object(event.delta).stop_reason;
        if (reason === "tool_use") throw new BoxCliSseError("BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
        if (stopReason !== null && (reason === null || reason === undefined || reason !== stopReason)) {
          throw new BoxCliSseError("BOX_CLI_EVENT_ORDER_INVALID");
        }
        if (reason !== null && reason !== undefined) {
          if (reason !== "end_turn" && reason !== "max_tokens" && reason !== "stop_sequence") {
            throw new BoxCliSseError("BOX_CLI_STOP_REASON_UNSUPPORTED");
          }
          stopReason = reason;
        }
        const observed = usage(event.usage);
        if ((observed.input_tokens !== undefined && count(observed.input_tokens) !== inputTokens)
          || (observed.cache_read_input_tokens !== undefined
            && count(observed.cache_read_input_tokens) !== cacheRead)
          || (observed.cache_creation_input_tokens !== undefined
            && count(observed.cache_creation_input_tokens) !== cacheCreation)) {
          throw new BoxCliSseError("BOX_CLI_USAGE_MISMATCH");
        }
        const nextOutput = count(observed.output_tokens);
        if (outputTokens !== null && nextOutput < outputTokens) {
          throw new BoxCliSseError("BOX_CLI_USAGE_REGRESSION");
        }
        outputTokens = nextOutput;
      } else if (eventType === "message_stop") {
        if (!started || stopped || activeBlock !== null || stopReason === null) {
          throw new BoxCliSseError("BOX_CLI_EVENT_ORDER_INVALID");
        }
        stopped = true;
      } else if (eventType !== "ping") {
        throw new BoxCliSseError("BOX_CLI_EVENT_UNSUPPORTED");
      }
      frames.push(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
    } else if (kind === "result") {
      if (!stopped || resultSeen || record.subtype !== "success" || record.is_error !== false) {
        throw new BoxCliSseError("BOX_CLI_RESULT_INVALID");
      }
      const finalUsage = usage(record.usage);
      if (count(finalUsage.input_tokens) !== inputTokens
        || count(finalUsage.output_tokens) !== outputTokens
        || count(finalUsage.cache_read_input_tokens ?? 0) !== cacheRead
        || count(finalUsage.cache_creation_input_tokens ?? 0) !== cacheCreation) {
        throw new BoxCliSseError("BOX_CLI_USAGE_MISMATCH");
      }
      resultSeen = true;
    } else if (kind === "system") {
      if (record.subtype === "init") {
        if (initSeen || started || !Array.isArray(record.tools) || record.tools.length !== 0
          || !Array.isArray(record.mcp_servers) || record.mcp_servers.length !== 0) {
          throw new BoxCliSseError("BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
        }
        initSeen = true;
      }
    } else if (kind === "assistant") {
      const content = object(record.message).content;
      if (!Array.isArray(content) || content.some((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) return true;
        const type = (block as { type?: unknown }).type;
        return type !== "text" && type !== "thinking" && type !== "redacted_thinking";
      })) throw new BoxCliSseError("BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
    } else if (kind !== "rate_limit_event") {
      throw new BoxCliSseError("BOX_CLI_RECORD_UNSUPPORTED");
    }
  }
  if (!started || !stopped || !resultSeen || inputTokens === null || outputTokens === null) {
    throw new BoxCliSseError("BOX_CLI_STREAM_INCOMPLETE");
  }
  return { sse: frames.join(""), inputTokens, outputTokens };
}
