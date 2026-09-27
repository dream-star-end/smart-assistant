import test from "node:test";
import assert from "node:assert/strict";
import { boxReplayMessageToSse } from "./boxReplayMessageSse.js";
import { _UsageObserver } from "./shared.js";

const base = { type: "message", role: "assistant", id: "msg_replay",
  model: "claude-opus-5-5", stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 7,
    cache_read_input_tokens: 101, cache_creation_input_tokens: 2 } };
function events(sse: string): Array<Record<string, unknown>> {
  return sse.split("\n\n").filter(Boolean).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data); return JSON.parse(data.slice(6)) as Record<string, unknown>;
  });
}

test("stored tool Message replays standard SSE with the same id, content and usage", () => {
  const message = { ...base, stop_reason: "tool_use", content: [
    { type: "thinking", thinking: "thought", signature: "signed" },
    { type: "text", text: "call the local tool" },
    { type: "tool_use", id: "toolu_replay", name: "Bash",
      input: { command: "printf synthetic" }, caller: { type: "direct" } },
  ] };
  const sse = boxReplayMessageToSse(message);
  const parsed = events(sse);
  assert.deepEqual(parsed.map((item) => item.type), [
    "message_start", "content_block_start", "content_block_delta",
    "content_block_delta", "content_block_stop", "content_block_start",
    "content_block_delta", "content_block_stop", "content_block_start",
    "content_block_delta", "content_block_stop", "message_delta", "message_stop",
  ]);
  assert.equal((parsed[0]?.message as { id: string }).id, message.id);
  const toolStart = parsed.find((item) => item.type === "content_block_start"
    && item.index === 2)?.content_block as { name: string };
  assert.equal(toolStart.name, "Bash");
  const finalUsage = (parsed.find((item) => item.type === "message_delta")?.usage) as {
    cache_read_input_tokens: number };
  assert.equal(finalUsage.cache_read_input_tokens, 101);
  const signatureDelta = parsed.find((item) => item.type === "content_block_delta"
    && (item.delta as { type?: string }).type === "signature_delta")?.delta as {
    signature: string };
  assert.equal(signatureDelta.signature, "signed");
  const toolDelta = parsed.find((item) => item.type === "content_block_delta"
    && (item.delta as { type?: string }).type === "input_json_delta")?.delta as {
    partial_json: string };
  assert.equal(toolDelta.partial_json, JSON.stringify({ command: "printf synthetic" }));
  const observer = new _UsageObserver();
  observer.push(sse); observer.flush();
  const observed = observer.result();
  assert.equal(observed.kind, "final");
  if (observed.kind === "final") assert.deepEqual(observed.usage,
    { input_tokens: 11n, output_tokens: 7n,
      cache_read_tokens: 101n, cache_write_tokens: 2n });
});

test("empty completed text and redacted thinking replay without inventing tool calls", () => {
  const empty = boxReplayMessageToSse({ ...base, stop_reason: "end_turn", content: [] });
  assert.deepEqual(events(empty).map((item) => item.type),
    ["message_start", "message_delta", "message_stop"]);
  const hidden = events(boxReplayMessageToSse({ ...base, stop_reason: "end_turn",
    content: [{ type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "answer" }] }));
  assert.equal((hidden.find((item) => item.type === "content_block_start")
    ?.content_block as { data: string }).data, "opaque");
  assert.equal(hidden.at(-1)?.type, "message_stop");
});

test("unsupported blocks and sparse content cannot become successful replay", () => {
  assert.throws(() => boxReplayMessageToSse({ ...base, stop_reason: "end_turn",
    content: [{ type: "tool_result", content: "forbidden" }] }), /BOX_REPLAY_BLOCK_INVALID/);
  const sparse = [{ type: "text", text: "x" }] as Array<unknown>;
  sparse.length = 2;
  assert.throws(() => boxReplayMessageToSse({ ...base, stop_reason: "end_turn",
    content: sparse }), /BOX_REPLAY_MESSAGE_INVALID/);
  for (const usage of [{ ...base.usage, input_tokens: -5 },
    { ...base.usage, cache_read_input_tokens: -1 },
    { ...base.usage, cache_creation_input_tokens: "2" }]) {
    assert.throws(() => boxReplayMessageToSse({ ...base, usage,
      stop_reason: "end_turn", content: [] }), /BOX_REPLAY_MESSAGE_INVALID/);
  }
  assert.throws(() => boxReplayMessageToSse({ ...base, stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "thought" }] }), /BOX_REPLAY_BLOCK_INVALID/);
  assert.throws(() => boxReplayMessageToSse({ ...base, stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "thought", signature: "" }] }),
  /BOX_REPLAY_BLOCK_INVALID/);
});
