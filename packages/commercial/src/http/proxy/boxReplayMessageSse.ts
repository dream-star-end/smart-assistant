/** Rebuild a standard Anthropic SSE round from the exact completed Message.
 * This is read-only response delivery; it never invokes Box, tools or billing. */
export class BoxReplayMessageSseError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxReplayMessageSseError"; }
}
type Obj = Record<string, unknown>;
function obj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxReplayMessageSseError("BOX_REPLAY_MESSAGE_INVALID");
  }
  return value as Obj;
}
function frame(type: string, value: Obj): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}
function token(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
export function boxReplayMessageToSse(raw: unknown): string {
  const message = obj(raw);
  const usage = obj(message.usage);
  if (message.type !== "message" || message.role !== "assistant"
    || typeof message.id !== "string" || typeof message.model !== "string"
    || !Array.isArray(message.content)
    || !["tool_use", "end_turn", "max_tokens", "stop_sequence"]
      .includes(String(message.stop_reason))
    || !token(usage.input_tokens) || !token(usage.output_tokens)
    || !token(usage.cache_read_input_tokens)
    || !token(usage.cache_creation_input_tokens)) {
    throw new BoxReplayMessageSseError("BOX_REPLAY_MESSAGE_INVALID");
  }
  let sse = frame("message_start", { message: { ...message, content: [],
    stop_reason: null, stop_sequence: null,
    usage: { ...usage, output_tokens: 0 } } });
  for (let index = 0; index < message.content.length; index++) {
    if (!Object.hasOwn(message.content, index)) {
      throw new BoxReplayMessageSseError("BOX_REPLAY_MESSAGE_INVALID");
    }
    const block = obj(message.content[index]);
    if (block.type === "text" && typeof block.text === "string") {
      sse += frame("content_block_start", { index,
        content_block: { ...block, text: "" } });
      if (block.text) sse += frame("content_block_delta", { index,
        delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "thinking" && typeof block.thinking === "string"
      && typeof block.signature === "string" && block.signature.length > 0) {
      const { signature: _signature, ...start } = block;
      sse += frame("content_block_start", { index,
        content_block: { ...start, thinking: "" } });
      if (block.thinking) sse += frame("content_block_delta", { index,
        delta: { type: "thinking_delta", thinking: block.thinking } });
      sse += frame("content_block_delta", { index,
        delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
      sse += frame("content_block_start", { index, content_block: block });
    } else if (block.type === "tool_use" && typeof block.id === "string"
      && typeof block.name === "string" && block.input
      && typeof block.input === "object" && !Array.isArray(block.input)) {
      sse += frame("content_block_start", { index,
        content_block: { ...block, input: {} } });
      sse += frame("content_block_delta", { index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else throw new BoxReplayMessageSseError("BOX_REPLAY_BLOCK_INVALID");
    sse += frame("content_block_stop", { index });
  }
  sse += frame("message_delta", { delta: { stop_reason: message.stop_reason,
    stop_sequence: message.stop_sequence ?? null }, usage });
  sse += frame("message_stop", {});
  return sse;
}
