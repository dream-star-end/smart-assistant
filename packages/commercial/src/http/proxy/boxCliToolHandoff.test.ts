import test from "node:test";
import assert from "node:assert/strict";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { BoxCliToolHandoffDecoder, BoxCliToolHandoffError } from "./boxCliToolHandoff.js";
import { _UsageObserver } from "./shared.js";

const model = "claude-opus-5-5";
const boxName = "mcp__ocbridge__t0";
const catalog = compileBoxToolCatalog([{ name: "Bash", description: "Synthetic local tool",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }]);
const event = (value: unknown) => ({ type: "stream_event", event: value });
const use = (id: string) => ({ type: "tool_use", id, name: boxName,
  input: { value: "same" } });
function records() {
  const first = "toolu_parallel_a", second = "toolu_parallel_b";
  return [
    { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_tool_1", model,
      role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: first, name: boxName, input: {} } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"value":"same"}' } }),
    { type: "assistant", message: { id: "msg_tool_1", model,
      role: "assistant", content: [use(first)] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "content_block_start", index: 1,
      content_block: { type: "tool_use", id: second, name: boxName, input: {} } }),
    event({ type: "content_block_delta", index: 1,
      delta: { type: "input_json_delta", partial_json: '{"value":"same"}' } }),
    { type: "assistant", message: { id: "msg_tool_1", model,
      role: "assistant", content: [use(first), use(second)] } },
    event({ type: "content_block_stop", index: 1 }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 8, input_tokens: 2 } }),
    event({ type: "message_stop" }),
  ];
}
const lines = (values: unknown[]) => values.map((item) => JSON.stringify(item) + "\n");

test("interleaved real-CC-style snapshots and two identical tools form one guarded handoff", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  const observer = new _UsageObserver();
  let streamed = "";
  for (const line of lines(records())) {
    const midpoint = Math.floor(line.length / 2);
    assert.equal(decoder.push(line.slice(0, midpoint)).sse, "");
    const next = decoder.push(line.slice(midpoint));
    streamed += next.sse;
    observer.push(next.sse);
  }
  observer.flush();
  assert.equal(observer.result().kind, "partial");
  assert.ok(streamed.includes('"name":"Bash"'));
  assert.ok(!streamed.includes("event: message_delta"));
  const candidate = decoder.push("").candidate;
  assert.deepEqual(candidate?.toolUses.map((item) => [item.id, item.boxName,
    item.clientName, item.input.value]), [
    ["toolu_parallel_a", boxName, "Bash", "same"],
    ["toolu_parallel_b", boxName, "Bash", "same"],
  ]);
  assert.throws(() => decoder.commitHandoff({ durableRevision: "", verifiedToolUseIds: [] }),
    (error: unknown) => error instanceof BoxCliToolHandoffError
      && error.code === "BOX_TOOL_HANDOFF_PROOF_INVALID");
  assert.throws(() => decoder.commitHandoff({ durableRevision: "synthetic-journal-rev-1",
    verifiedToolUseIds: new Array<string>(2) }),
  (error: unknown) => error instanceof BoxCliToolHandoffError
    && error.code === "BOX_TOOL_HANDOFF_PROOF_INVALID");
  (candidate!.toolUses as unknown as Array<unknown>).splice(0, 2);
  assert.equal(decoder.push("").candidate?.toolUses.length, 2,
    "published candidate is not the internal authorization baseline");
  assert.throws(() => decoder.commitHandoff({ durableRevision: "synthetic-journal-rev-1",
    verifiedToolUseIds: [] }),
  (error: unknown) => error instanceof BoxCliToolHandoffError
    && error.code === "BOX_TOOL_HANDOFF_PROOF_INVALID");
  const proof = { durableRevision: "synthetic-journal-rev-1",
    verifiedToolUseIds: ["toolu_parallel_a", "toolu_parallel_b"] };
  const terminal = decoder.commitHandoff(proof);
  assert.ok(terminal.includes('"stop_reason":"tool_use"'));
  assert.ok(terminal.includes("event: message_stop"));
  observer.push(terminal); observer.flush();
  assert.equal(observer.result().kind, "final");
  assert.throws(() => decoder.commitHandoff(proof),
    (error: unknown) => error instanceof BoxCliToolHandoffError
      && error.code === "BOX_TOOL_HANDOFF_NOT_READY");
});

test("UTF-8 byte cap does not depend on a split surrogate pair", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  decoder.push("x".repeat(1_048_572));
  const emoji = "😀";
  decoder.push(emoji[0]!);
  decoder.push(emoji[1]!);
  assert.throws(() => decoder.push("x"),
    (error: unknown) => error instanceof BoxCliToolHandoffError
      && error.code === "BOX_TOOL_STREAM_TOO_LARGE");
});

test("snapshot mismatch, duplicate ID and unsupported tool name fail before terminal", () => {
  for (const mutation of ["snapshot", "duplicate", "name"] as const) {
    const source = records();
    if (mutation === "snapshot") {
      const final = source[8] as { message: { content: Array<{ id: string }> } };
      final.message.content[1]!.id = "toolu_wrong";
    } else if (mutation === "duplicate") {
      const start = source[6] as { event: { content_block: { id: string } } };
      start.event.content_block.id = "toolu_parallel_a";
    } else {
      const start = source[2] as { event: { content_block: { name: string } } };
      start.event.content_block.name = "mcp__wrong__t0";
    }
    const decoder = new BoxCliToolHandoffDecoder(model, catalog);
    assert.throws(() => {
      for (const line of lines(source)) decoder.push(line);
    }, BoxCliToolHandoffError);
    assert.throws(() => decoder.commitHandoff({ durableRevision: "synthetic-journal-rev-1",
      verifiedToolUseIds: ["toolu_parallel_a", "toolu_parallel_b"] }),
      (error: unknown) => error instanceof BoxCliToolHandoffError
        && error.code === "BOX_TOOL_HANDOFF_NOT_READY");
  }
});

test("post-handoff bytes are not misparsed as the first HTTP response", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  const suffix = '{"type":"user","message":{"content":"synthetic-result"}}\n';
  const result = decoder.push(lines(records()).join("") + suffix);
  assert.equal(result.candidate?.toolUses.length, 2);
  assert.equal(decoder.takeRemainder(), suffix);
  assert.equal(decoder.takeRemainder(), "");
});
