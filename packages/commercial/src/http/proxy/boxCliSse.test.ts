import test from "node:test";
import assert from "node:assert/strict";
import { completedBoxCliToSse, createBoxCliSseDecoder, BoxCliSseError } from "./boxCliSse.js";
import { _UsageObserver } from "./shared.js";
import { BoxExecTransport } from "./boxExecTransport.js";

const model = "claude-opus-5-5";
const event = (value: unknown) => ({ type: "stream_event", event: value });
function records(blockType = "text"): Array<Record<string, unknown>> {
  return [
    { type: "system", subtype: "init", tools: [], mcp_servers: [] },
    event({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant",
      model, content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: blockType, text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture" } }),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
    event({ type: "message_stop" }),
    { type: "assistant", message: { id: "msg_1", model, role: "assistant",
      content: [{ type: "text", text: "fixture" }] } },
    { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 2, output_tokens: 7 } },
  ];
}
function jsonl(value: unknown[]): string { return value.map((item) => JSON.stringify(item)).join("\n") + "\n"; }
function rejected(value: unknown[], code: string): void {
  assert.throws(() => completedBoxCliToSse(jsonl(value), model),
    (error: unknown) => error instanceof BoxCliSseError && error.code === code);
}

test("completed Box CLI events become unmodified Anthropic SSE with observed usage", () => {
  const source = records();
  const output = completedBoxCliToSse(jsonl(source), model);
  assert.equal(output.inputTokens, 2);
  assert.equal(output.outputTokens, 7);
  const types = [...output.sse.matchAll(/^event: ([a-z_]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(types, ["message_start", "content_block_start", "content_block_delta",
    "content_block_stop", "message_delta", "message_stop"]);
  assert.ok(output.sse.includes(JSON.stringify((source[3] as { event: unknown }).event)));
  assert.ok(!output.sse.includes('"type":"result"'), "CLI result is not a second model event");
});

test("fragmented live JSONL emits text before CLI terminal and withholds message_stop", () => {
  const source = records();
  const decoder = createBoxCliSseDecoder(model);
  let early = "";
  for (const record of source.slice(0, 4)) {
    const line = JSON.stringify(record) + "\n";
    const midpoint = Math.floor(line.length / 2);
    assert.equal(decoder.push(line.slice(0, midpoint)), "");
    early += decoder.push(line.slice(midpoint));
  }
  assert.ok(early.includes("event: content_block_delta"));
  assert.ok(!early.includes("event: message_stop"));
  let later = "";
  for (const record of source.slice(4)) later += decoder.push(JSON.stringify(record) + "\n");
  assert.ok(!later.includes("event: message_stop"), "terminal is held until final integrity proof");
  const final = decoder.finish();
  assert.equal(final.tailSse.includes("event: message_stop"), true);
  assert.equal(early + later + final.tailSse, completedBoxCliToSse(jsonl(source), model).sse);
  assert.equal(final.inputTokens, 2);
  assert.equal(final.outputTokens, 7);
});

test("live decoder never emits terminal success if final snapshot contradicts earlier text", () => {
  const source = records();
  (source[7] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text =
    "different";
  const decoder = createBoxCliSseDecoder(model);
  let streamed = "";
  for (const record of source) streamed += decoder.push(JSON.stringify(record) + "\n");
  assert.ok(streamed.includes("event: content_block_delta"));
  assert.ok(!streamed.includes("event: message_stop"));
  assert.throws(() => decoder.finish(),
    (error: unknown) => error instanceof BoxCliSseError && error.code === "BOX_CLI_TEXT_MISMATCH");
});

test("real Connect transport callback delivers first model delta before remote exit", async () => {
  const source = records();
  const part1 = jsonl(source.slice(0, 4));
  const part2 = jsonl(source.slice(4));
  const frame = (value: unknown, flag = 0): Buffer => {
    const raw = Buffer.from(JSON.stringify(value));
    const out = Buffer.alloc(5 + raw.length);
    out[0] = flag; out.writeUInt32BE(raw.length, 1); raw.copy(out, 5);
    return out;
  };
  let release!: () => void;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(frame({ stdoutEvent: { data: part1 } }));
    release = () => {
      controller.enqueue(frame({ stdoutEvent: { data: part2 } }));
      controller.enqueue(frame({ exitEvent: {} }));
      controller.enqueue(frame({}, 2));
      controller.close();
    };
  } }), { status: 200 });
  const decoder = createBoxCliSseDecoder(model);
  let streamed = "", terminal = false;
  let seenDelta!: () => void;
  const firstDelta = new Promise<void>((resolve) => { seenDelta = resolve; });
  const transport = new BoxExecTransport({ execUrl: "https://box.example.cursorvm.com/agent.v1.ControlService/Exec",
    execToken: "synthetic-exec", networkToken: "synthetic-network" }, async () => response,
  async () => {});
  const pending = transport.run({ command: "/usr/bin/python3", args: ["--version"],
    cwd: "/tmp", environment: {} }, { timeoutMs: 2000,
    onStdout: (chunk) => {
      streamed += decoder.push(chunk);
      if (streamed.includes("event: content_block_delta")) seenDelta();
    } }).then((result) => { terminal = true; return result; });
  try {
    await Promise.race([firstDelta, new Promise<never>((_, reject) => setTimeout(() =>
      reject(new Error("FIRST_DELTA_NOT_PROGRESSIVE")), 500))]);
    assert.equal(terminal, false, "the Box process has not exited yet");
    assert.ok(streamed.includes("event: content_block_delta"));
    assert.ok(!streamed.includes("event: message_stop"));
  } finally { release(); }
  const result = await pending;
  assert.equal(result.exitCode, 0);
  const final = decoder.finish();
  assert.equal(streamed + final.tailSse, completedBoxCliToSse(part1 + part2, model).sse);
});

test("tool_use is never silently consumed by the complete-call path", () => {
  rejected(records("tool_use"), "BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
});

test("missing/duplicate/out-of-order events and failed result do not yield success SSE", () => {
  const missingStop = records().filter((item) => (item as { event?: { type?: string } }).event?.type !== "message_stop");
  rejected(missingStop, "BOX_CLI_RESULT_INVALID");
  const duplicateStart = records();
  duplicateStart.splice(2, 0, duplicateStart[1]!);
  rejected(duplicateStart, "BOX_CLI_EVENT_ORDER_INVALID");
  const badFinal = records();
  badFinal[8] = { ...badFinal[8], is_error: true };
  rejected(badFinal, "BOX_CLI_RESULT_INVALID");
  const badUsage = records();
  badUsage[5] = event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: -1 } });
  rejected(badUsage, "BOX_CLI_USAGE_INVALID");
});

test("rejects hidden tool evidence outside content_block_start", () => {
  const toolReason = records();
  toolReason[5] = event({ type: "message_delta", delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 7 } });
  rejected(toolReason, "BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
  const toolAtStart = records();
  (toolAtStart[1] as { event: { message: { content: unknown[] } } }).event.message.content =
    [{ type: "tool_use", id: "toolu_1" }];
  rejected(toolAtStart, "BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
  const toolInAssistant = records();
  toolInAssistant[7] = { type: "assistant", message: { id: "msg_1", model,
    role: "assistant", content: [{ type: "tool_use", id: "toolu_1" }] } };
  rejected(toolInAssistant, "BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
});

test("rejects duplicate block indices and delta type mismatches", () => {
  const reused = records();
  reused.splice(5, 0, event({ type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } }));
  rejected(reused, "BOX_CLI_EVENT_ORDER_INVALID");
  const wrongDelta = records();
  wrongDelta[3] = event({ type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: "{}" } });
  rejected(wrongDelta, "BOX_CLI_DELTA_INVALID");
});

test("rejects cumulative usage regressions, cache negatives and result mismatch", () => {
  const regressed = records();
  regressed.splice(6, 0, event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 0 } }));
  rejected(regressed, "BOX_CLI_USAGE_REGRESSION");
  const badCache = records();
  (badCache[8] as { usage: { cache_read_input_tokens?: number } }).usage.cache_read_input_tokens = -1;
  rejected(badCache, "BOX_CLI_USAGE_INVALID");
  const mismatch = records();
  (mismatch[8] as { usage: { output_tokens: number } }).usage.output_tokens = 8;
  rejected(mismatch, "BOX_CLI_USAGE_MISMATCH");
});

test("terminal message_delta phase forbids later content and stop-reason reset", () => {
  const lateContent = records();
  lateContent.splice(6, 0,
    event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_stop", index: 1 }));
  rejected(lateContent, "BOX_CLI_EVENT_ORDER_INVALID");
  const resetReason = records();
  resetReason.splice(6, 0, event({ type: "message_delta", delta: { stop_reason: null },
    usage: { output_tokens: 7 } }));
  rejected(resetReason, "BOX_CLI_EVENT_ORDER_INVALID");
});

test("delta input/cache usage cannot contradict start and result", () => {
  const inputMismatch = records();
  inputMismatch[5] = event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7, input_tokens: 999 } });
  rejected(inputMismatch, "BOX_CLI_USAGE_MISMATCH");
  const cacheMismatch = records();
  cacheMismatch[5] = event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7, cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20 } });
  rejected(cacheMismatch, "BOX_CLI_USAGE_MISMATCH");
});

test("renumbers a verified visible index gap without inventing hidden content", () => {
  const source = records();
  for (const i of [2, 3, 4]) {
    (source[i] as { event: { index: number } }).event.index = 1;
  }
  const output = completedBoxCliToSse(jsonl(source), model);
  const indexes = output.sse.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { index?: number })
    .filter((entry) => entry.index !== undefined).map((entry) => entry.index);
  assert.deepEqual(indexes, [0, 0, 0]);
  assert.ok(output.sse.includes('"text":"fixture"'));
});

test("a hidden text prefix cannot be erased by index normalization", () => {
  const source = records();
  for (const i of [2, 3, 4]) {
    (source[i] as { event: { index: number } }).event.index = 1;
  }
  (source[7] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text =
    "prefix-fixture";
  rejected(source, "BOX_CLI_TEXT_MISMATCH");
});

test("nonempty block start and multiple deltas are included in the text proof", () => {
  const source = records();
  (source[2] as { event: { content_block: { text: string } } }).event.content_block.text = "pre";
  (source[3] as { event: { delta: { text: string } } }).event.delta.text = "fix";
  source.splice(4, 0, event({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "-suffix" } }));
  (source[8] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text =
    "prefix-suffix";
  const output = completedBoxCliToSse(jsonl(source), model);
  assert.ok(output.sse.includes('"text":"-suffix"'));
});

test("missing final assistant snapshot and backwards original indexes fail closed", () => {
  rejected(records().filter((item) => item.type !== "assistant"), "BOX_CLI_TEXT_MISMATCH");
  const reversed = records();
  reversed.splice(5, 0,
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_stop", index: 0 }));
  (reversed[2] as { event: { index: number } }).event.index = 1;
  (reversed[3] as { event: { index: number } }).event.index = 1;
  (reversed[4] as { event: { index: number } }).event.index = 1;
  rejected(reversed, "BOX_CLI_EVENT_ORDER_INVALID");
});

test("Opus 5 response cannot pass as Opus 5.5", () => {
  const source = records();
  (source[1] as { event: { message: { model: string } } }).event.message.model = "claude-opus-5";
  rejected(source, "BOX_CLI_MODEL_MISMATCH");
});

test("another assistant message cannot overwrite the current text proof", () => {
  const source = records();
  (source[3] as { event: { delta: { text: string } } }).event.delta.text = "suffix";
  (source[7] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text =
    "prefix-suffix";
  const other = { type: "assistant", message: { id: "msg_other", model,
    role: "assistant", content: [{ type: "text", text: "suffix" }] } };
  const beforeResult = source.slice();
  beforeResult.splice(8, 0, other);
  rejected(beforeResult, "BOX_CLI_ASSISTANT_MISMATCH");
  const afterResult = source.concat([other]);
  rejected(afterResult, "BOX_CLI_RECORD_AFTER_RESULT");
  const sameMessageShrink = source.slice();
  sameMessageShrink.splice(8, 0, { ...other,
    message: { ...other.message, id: "msg_1" } });
  rejected(sameMessageShrink, "BOX_CLI_TEXT_MISMATCH");
});

test("converter SSE drives existing billing observer with input/cache intact", () => {
  const source = records();
  const start = (source[1] as { event: { message: { usage: Record<string, number> } } }).event.message.usage;
  start.cache_read_input_tokens = 100;
  start.cache_creation_input_tokens = 20;
  const finalUsage = (source[8] as { usage: Record<string, number> }).usage;
  finalUsage.cache_read_input_tokens = 100;
  finalUsage.cache_creation_input_tokens = 20;
  const converted = completedBoxCliToSse(jsonl(source), model);
  const observer = new _UsageObserver();
  observer.push(converted.sse.slice(0, 121));
  observer.push(converted.sse.slice(121));
  observer.flush();
  const observation = observer.result();
  assert.equal(observation.kind, "final");
  if (observation.kind === "final") {
    assert.deepEqual(observation.usage, {
      input_tokens: 2n, output_tokens: 7n,
      cache_read_tokens: 100n, cache_write_tokens: 20n,
    });
  }
});
