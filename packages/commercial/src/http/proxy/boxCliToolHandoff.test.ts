import test from "node:test";
import assert from "node:assert/strict";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { BoxCliToolHandoffDecoder, BoxCliToolHandoffError } from "./boxCliToolHandoff.js";
import { hashBoxAssistantContent } from "./boxCallFingerprint.js";
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
  assert.ok(!streamed.includes('"name":"Bash"'),
    "tool block must stay hidden until durable handoff");
  assert.ok(!streamed.includes("event: message_delta"));
  const candidate = decoder.push("").candidate;
  assert.equal(candidate?.assistantContentHash, hashBoxAssistantContent([
    { ...use("toolu_parallel_a"), name: "Bash" },
    { ...use("toolu_parallel_b"), name: "Bash" },
  ]));
  assert.deepEqual(candidate?.toolUses.map((item) => [item.id, item.boxName,
    item.clientName, item.input.value]), [
    ["toolu_parallel_a", boxName, "Bash", "same"],
    ["toolu_parallel_b", boxName, "Bash", "same"],
  ]);
  assert.throws(() => decoder.commitHandoff({ durableRevision: "",
    journaledToolUseIds: ["toolu_parallel_a", "toolu_parallel_b"],
    verifiedPendingToolUseIds: ["toolu_parallel_a"] }),
    (error: unknown) => error instanceof BoxCliToolHandoffError
      && error.code === "BOX_TOOL_HANDOFF_PROOF_INVALID");
  assert.throws(() => decoder.commitHandoff({ durableRevision: "synthetic-journal-rev-1",
    journaledToolUseIds: new Array<string>(2),
    verifiedPendingToolUseIds: ["toolu_parallel_a"] }),
  (error: unknown) => error instanceof BoxCliToolHandoffError
    && error.code === "BOX_TOOL_HANDOFF_PROOF_INVALID");
  (candidate!.toolUses as unknown as Array<unknown>).splice(0, 2);
  assert.equal(decoder.push("").candidate?.toolUses.length, 2,
    "published candidate is not the internal authorization baseline");
  assert.throws(() => decoder.commitHandoff({ durableRevision: "synthetic-journal-rev-1",
    journaledToolUseIds: [], verifiedPendingToolUseIds: ["toolu_parallel_a"] }),
  (error: unknown) => error instanceof BoxCliToolHandoffError
    && error.code === "BOX_TOOL_HANDOFF_PROOF_INVALID");
  const proof = { durableRevision: "synthetic-journal-rev-1",
    journaledToolUseIds: ["toolu_parallel_a", "toolu_parallel_b"],
    verifiedPendingToolUseIds: ["toolu_parallel_a"] };
  for (const pending of [[], ["toolu_wrong"], new Array<string>(1)]) {
    assert.throws(() => decoder.commitHandoff({ ...proof,
      verifiedPendingToolUseIds: pending }),
    (error: unknown) => error instanceof BoxCliToolHandoffError
      && error.code === "BOX_TOOL_HANDOFF_PROOF_INVALID");
  }
  const terminal = decoder.commitHandoff(proof);
  assert.ok(terminal.includes('"name":"Bash"'));
  assert.ok(terminal.includes("event: content_block_stop"));
  assert.ok(terminal.includes('"stop_reason":"tool_use"'));
  assert.ok(terminal.includes("event: message_stop"));
  observer.push(terminal); observer.flush();
  assert.equal(observer.result().kind, "final");
  assert.throws(() => decoder.commitHandoff(proof),
    (error: unknown) => error instanceof BoxCliToolHandoffError
      && error.code === "BOX_TOOL_HANDOFF_NOT_READY");
});

test("client tool execution cannot start before snapshot and durable handoff", () => {
  const bad = records().map((item) => {
    if (item.type !== "assistant") return item;
    const msg = (item as { message: { content: Array<Record<string, unknown>> } }).message;
    if (msg.content.length !== 2) return item;
    return { ...item, message: { ...msg, content: [msg.content[0],
      { ...msg.content[1], input: { value: "tampered" } }] } };
  });
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  let visible = "";
  assert.throws(() => {
    for (const line of lines(bad)) visible += decoder.push(line).sse;
  }, /BOX_TOOL_SNAPSHOT_MISMATCH/);
  assert.ok(!visible.includes("event: content_block_start"));
  assert.ok(!visible.includes("event: content_block_stop"));
  const valid = new BoxCliToolHandoffDecoder(model, catalog);
  let before = "";
  for (const line of lines(records())) before += valid.push(line).sse;
  assert.ok(!before.includes("event: content_block_stop"));
  const after = valid.commitHandoff({ durableRevision: "journal-rev-1",
    journaledToolUseIds: ["toolu_parallel_a", "toolu_parallel_b"],
    verifiedPendingToolUseIds: ["toolu_parallel_a"] });
  assert.equal((after.match(/event: content_block_stop/g) ?? []).length, 2);
});

test("Opus 5.5 segmented assistant snapshots preserve thinking then local tool_use", () => {
  const thought = { type: "thinking", thinking: "private-thought", signature: "signed" };
  const tool = use("toolu_segmented_opus55");
  const source = [
    { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_segmented", model,
      role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: "thinking", thinking: "" } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "thinking_delta", thinking: "private-thought" } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "signature_delta", signature: "signed" } }),
    { type: "assistant", message: { id: "msg_segmented", model,
      role: "assistant", content: [thought] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "content_block_start", index: 1,
      content_block: { type: "tool_use", id: tool.id, name: boxName, input: {} } }),
    event({ type: "content_block_delta", index: 1,
      delta: { type: "input_json_delta", partial_json: '{"value":"same"}' } }),
    { type: "assistant", message: { id: "msg_segmented", model,
      role: "assistant", content: [tool] } },
    event({ type: "content_block_stop", index: 1 }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 8, input_tokens: 2 } }),
    event({ type: "message_stop" }),
  ];
  const valid = new BoxCliToolHandoffDecoder(model, catalog);
  for (const line of lines(source)) valid.push(line);
  assert.deepEqual(valid.push("").candidate?.toolUses.map((item) =>
    [item.clientName, item.input.value]), [["Bash", "same"]]);
  const firstContentType = (item: unknown): string | undefined =>
    (item as { message?: { content?: Array<{ type?: string }> } })
      .message?.content?.[0]?.type;
  for (const changed of [
    source.filter((item) => !(item.type === "assistant"
      && firstContentType(item) === "thinking")),
    source.map((item) => item.type === "assistant"
      && firstContentType(item) === "tool_use"
      ? { ...item, message: { ...((item as { message?: object }).message ?? {}),
        content: [{ ...tool, input: { value: "changed" } }] } } : item),
  ]) {
    const decoder = new BoxCliToolHandoffDecoder(model, catalog);
    assert.throws(() => { for (const line of lines(changed)) decoder.push(line); },
      /BOX_TOOL_SNAPSHOT_MISMATCH/);
  }
});

test("identical text blocks do not make segmented snapshot coverage ambiguous", () => {
  const textBlock = { type: "text", text: "same" };
  const tool = use("toolu_repeated_text");
  const source = [
    { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_repeat", model,
      role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    ...[0, 1].flatMap((index) => [
      event({ type: "content_block_start", index,
        content_block: { type: "text", text: "" } }),
      event({ type: "content_block_delta", index,
        delta: { type: "text_delta", text: "same" } }),
      { type: "assistant", message: { id: "msg_repeat", model,
        role: "assistant", content: [textBlock] } },
      event({ type: "content_block_stop", index }),
    ]),
    event({ type: "content_block_start", index: 2,
      content_block: { type: "tool_use", id: tool.id, name: boxName, input: {} } }),
    event({ type: "content_block_delta", index: 2,
      delta: { type: "input_json_delta", partial_json: '{"value":"same"}' } }),
    { type: "assistant", message: { id: "msg_repeat", model,
      role: "assistant", content: [tool] } },
    event({ type: "content_block_stop", index: 2 }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 8, input_tokens: 2 } }),
    event({ type: "message_stop" }),
  ];
  const valid = new BoxCliToolHandoffDecoder(model, catalog);
  for (const line of lines(source)) valid.push(line);
  assert.equal(valid.push("").candidate?.toolUses.length, 1);
  const missingSecond = source.filter((item, index) => index !== 8);
  const invalid = new BoxCliToolHandoffDecoder(model, catalog);
  assert.throws(() => { for (const line of lines(missingSecond)) invalid.push(line); },
    /BOX_TOOL_SNAPSHOT_MISMATCH/);
});

test("handoff digest binds the full visible assistant text before tool_use", () => {
  const tool = use("toolu_text_then_tool");
  const source = [
    { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_text_tool", model,
      role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "A" } }),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "content_block_start", index: 1,
      content_block: { type: "tool_use", id: tool.id, name: boxName, input: {} } }),
    event({ type: "content_block_delta", index: 1,
      delta: { type: "input_json_delta", partial_json: '{"value":"same"}' } }),
    { type: "assistant", message: { id: "msg_text_tool", model,
      role: "assistant", content: [{ type: "text", text: "A" }, tool] } },
    event({ type: "content_block_stop", index: 1 }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 8, input_tokens: 2 } }),
    event({ type: "message_stop" }),
  ];
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  for (const line of lines(source)) decoder.push(line);
  const hash = decoder.push("").candidate?.assistantContentHash;
  assert.equal(hash, hashBoxAssistantContent([
    { type: "text", text: "A" }, { ...tool, name: "Bash" },
  ]));
  assert.notEqual(hash, hashBoxAssistantContent([
    { type: "text", text: "B" }, { ...tool, name: "Bash" },
  ]));
});

test("thinking, signature and redacted data bind streamed content, not a divergent snapshot", () => {
  const source = (mutation?: "thinking" | "signature" | "redacted" | "multi_signature") => {
    const thought = { type: "thinking", thinking: "private-thought",
      signature: mutation === "multi_signature" ? "second" : "signed" };
    const redacted = { type: "redacted_thinking", data: "ciphertext" };
    const tool = use("toolu_thinking_then_tool");
    const snapshot = [{ ...thought }, { ...redacted }, { ...tool }];
    if (mutation === "thinking") snapshot[0] = { ...thought, thinking: "different" };
    if (mutation === "signature") snapshot[0] = { ...thought, signature: "different" };
    if (mutation === "redacted") snapshot[1] = { ...redacted, data: "different" };
    return { snapshot, records: [
      { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] },
      event({ type: "message_start", message: { id: "msg_thought_tool", model,
        role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
      event({ type: "content_block_start", index: 0,
        content_block: { type: "thinking", thinking: "" } }),
      event({ type: "content_block_delta", index: 0,
        delta: { type: "thinking_delta", thinking: "private-thought" } }),
      ...(mutation === "multi_signature" ? [
        event({ type: "content_block_delta", index: 0,
          delta: { type: "signature_delta", signature: "first" } }),
        event({ type: "content_block_delta", index: 0,
          delta: { type: "signature_delta", signature: "second" } }),
      ] : [event({ type: "content_block_delta", index: 0,
        delta: { type: "signature_delta", signature: "signed" } })]),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "content_block_start", index: 1, content_block: redacted }),
      event({ type: "content_block_stop", index: 1 }),
      event({ type: "content_block_start", index: 2,
        content_block: { type: "tool_use", id: tool.id, name: boxName, input: {} } }),
      event({ type: "content_block_delta", index: 2,
        delta: { type: "input_json_delta", partial_json: '{"value":"same"}' } }),
      { type: "assistant", message: { id: "msg_thought_tool", model,
        role: "assistant", content: snapshot } },
      event({ type: "content_block_stop", index: 2 }),
      event({ type: "message_delta", delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 8, input_tokens: 2 } }),
      event({ type: "message_stop" }),
    ] };
  };
  const valid = new BoxCliToolHandoffDecoder(model, catalog);
  for (const line of lines(source().records)) valid.push(line);
  assert.equal(valid.push("").candidate?.assistantContentHash,
    hashBoxAssistantContent([
      { type: "thinking", thinking: "private-thought", signature: "signed" },
      { type: "redacted_thinking", data: "ciphertext" },
      { ...use("toolu_thinking_then_tool"), name: "Bash" },
    ]));
  for (const mutation of ["thinking", "signature", "redacted"] as const) {
    const decoder = new BoxCliToolHandoffDecoder(model, catalog);
    assert.throws(() => {
      for (const line of lines(source(mutation).records)) decoder.push(line);
    }, /BOX_TOOL_SNAPSHOT_MISMATCH/);
  }
  const repeated = new BoxCliToolHandoffDecoder(model, catalog);
  for (const line of lines(source("multi_signature").records)) repeated.push(line);
  assert.equal(repeated.push("").candidate?.assistantContentHash,
    hashBoxAssistantContent([
      { type: "thinking", thinking: "private-thought", signature: "second" },
      { type: "redacted_thinking", data: "ciphertext" },
      { ...use("toolu_thinking_then_tool"), name: "Bash" },
    ]));
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
      journaledToolUseIds: ["toolu_parallel_a", "toolu_parallel_b"],
      verifiedPendingToolUseIds: ["toolu_parallel_a"] }),
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

test("a resumed tool round accepts no second init and still fences terminal SSE", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog,
    { alreadyInitialized: true, allowFinal: true });
  let streamed = "";
  for (const line of lines(records().slice(1))) streamed += decoder.push(line).sse;
  const candidate = decoder.push("").candidate;
  assert.equal(candidate?.messageId, "msg_tool_1");
  assert.equal(candidate?.toolUses.length, 2);
  assert.ok(!streamed.includes("event: message_stop"));
  assert.ok(decoder.commitHandoff({ durableRevision: "synthetic-revision",
    journaledToolUseIds: ["toolu_parallel_a", "toolu_parallel_b"],
    verifiedPendingToolUseIds: ["toolu_parallel_a"] }).includes("event: message_stop"));
});

test("a resumed final round streams blocks but withholds terminal until result and durable proof", () => {
  const finalRecords = [
    event({ type: "message_start", message: { id: "msg_final", model,
      role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "done" } }),
    { type: "assistant", message: { id: "msg_final", model,
      role: "assistant", content: [{ type: "text", text: "done" }] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 2, output_tokens: 4 } }),
    event({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 10, output_tokens: 12 } },
  ];
  const decoder = new BoxCliToolHandoffDecoder(model, catalog,
    { alreadyInitialized: true, allowFinal: true });
  let streamed = "";
  for (const line of lines(finalRecords.slice(0, -1))) streamed += decoder.push(line).sse;
  assert.ok(streamed.includes("done"));
  assert.ok(!streamed.includes("event: message_stop"));
  assert.equal(decoder.push("").finalCandidate, null);
  const final = decoder.push(lines(finalRecords.slice(-1))[0]!).finalCandidate;
  assert.equal(final?.stopReason, "end_turn");
  assert.equal(final?.outputTokens, 4, "bill only this HTTP model round, not CLI cumulative total");
  assert.throws(() => decoder.commitFinal({ terminalReason: "worker_complete",
    journaledUsage: { inputTokens: 2, outputTokens: 4,
      cacheReadTokens: 0, cacheWriteTokens: 0 } }), /BOX_TOOL_FINAL_PROOF_INVALID/);
  decoder.finishFinal();
  assert.throws(() => decoder.commitFinal({ terminalReason: "worker_complete",
    journaledUsage: { inputTokens: 2, outputTokens: 999,
      cacheReadTokens: 0, cacheWriteTokens: 0 } }), /BOX_TOOL_FINAL_PROOF_INVALID/);
  const terminal = decoder.commitFinal({ terminalReason: "worker_complete",
    journaledUsage: { inputTokens: 2, outputTokens: 4,
      cacheReadTokens: 0, cacheWriteTokens: 0 } });
  assert.ok(terminal.includes('"stop_reason":"end_turn"'));
  assert.ok(terminal.includes("event: message_stop"));
  assert.throws(() => decoder.push(""), /BOX_TOOL_DECODER_CLOSED/);
});

test("success result followed by same-chunk or later bytes cannot release final SSE", () => {
  const prelude = [
    event({ type: "message_start", message: { id: "msg_final_trailing", model,
      role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "done" } }),
    { type: "assistant", message: { id: "msg_final_trailing", model,
      role: "assistant", content: [{ type: "text", text: "done" }] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 2, output_tokens: 4 } }),
    event({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 10, output_tokens: 12 } },
  ];
  for (const suffix of [
    JSON.stringify({ type: "result", subtype: "error", is_error: true }) + "\n",
    "not-json\n", "{\"type\":\"result\"",
  ]) {
    for (const sameChunk of [true, false]) {
      const decoder = new BoxCliToolHandoffDecoder(model, catalog,
        { alreadyInitialized: true, allowFinal: true });
      const full = lines(prelude).join("");
      if (sameChunk) decoder.push(full + suffix);
      else { decoder.push(full); decoder.push(suffix); }
      assert.throws(() => decoder.finishFinal(), /BOX_TOOL_FINAL_TRAILING_BYTES/);
      assert.throws(() => decoder.commitFinal({ terminalReason: "worker_complete",
        journaledUsage: { inputTokens: 2, outputTokens: 4,
          cacheReadTokens: 0, cacheWriteTokens: 0 } }), /BOX_TOOL_FINAL_PROOF_INVALID/);
    }
  }
});
