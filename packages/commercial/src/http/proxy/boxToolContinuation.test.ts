import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { runBoxToolContinuation } from "./boxToolContinuation.js";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import type { ProxyBody } from "./shared.js";
import type { BoxReplayMessageWriter,
  BoxReplayMessagePointer } from "./boxReplayMessageFile.js";

const inheritedInstance = process.env.OC_INSTANCE_ID;
process.env.OC_INSTANCE_ID = "box-test";
test.after(() => {
  if (inheritedInstance === undefined) delete process.env.OC_INSTANCE_ID;
  else process.env.OC_INSTANCE_ID = inheritedInstance;
});

const model = "claude-opus-5-5", id = "toolu_continued_a";
const boxName = "mcp__ocbridge__t0";
const tools = [{ name: "local_echo", description: "synthetic local tool",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }];
const catalog = compileBoxToolCatalog(tools);
const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, tools, messages: [{ role: "user", content: "synthetic" }] };
const event = (x: unknown) => ({ type: "stream_event", event: x });
const usage = { input_tokens: 2, output_tokens: 0 };
const toolRecords = [
  event({ type: "message_start", message: { id: "msg_tool_next", model,
    role: "assistant", content: [], usage } }),
  event({ type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id, name: boxName, input: {} } }),
  event({ type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
  { type: "assistant", message: { id: "msg_tool_next", model, role: "assistant",
    content: [{ type: "tool_use", id, name: boxName, input: { value: "x" } }] } },
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "tool_use" },
    usage: { input_tokens: 2, output_tokens: 4 } }),
  event({ type: "message_stop" }),
];
const finalRecords = [
  event({ type: "message_start", message: { id: "msg_final_next", model,
    role: "assistant", content: [], usage } }),
  event({ type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "done" } }),
  { type: "assistant", message: { id: "msg_final_next", model, role: "assistant",
    content: [{ type: "text", text: "done" }] } },
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 2, output_tokens: 4 } }),
  event({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 10, output_tokens: 12 } },
];
const raw = (records: unknown[]) => Buffer.from(records.map((x) => JSON.stringify(x) + "\n").join(""));
const localResult = "OpenClaude user-container result";
const echoRecord = { type: "user", message: { role: "user", content: [
  { type: "tool_result", tool_use_id: "toolu_prior_a", content: localResult },
] } };
const echoHash = createHash("sha256").update(JSON.stringify({
  content: [{ type: "text", text: localResult }], isError: false })).digest("hex");

function fixture(kind: "tool" | "final", failComplete = false,
  trailing = false, omitEcho = false, largeEcho = false, native = false) {
  const sequence: string[] = [], emitted: string[] = [];
  const resultText = largeEcho ? "x".repeat(1_100_000) : localResult;
  const currentEcho = largeEcho ? { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_prior_a", content: resultText },
  ] } } : echoRecord;
  const currentHash = largeEcho ? createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text: resultText }], isError: false })).digest("hex") : echoHash;
  let retained = false;
  const claim = { ownerRequestId: "box-owner", accountId: 20n,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
    spoolOffset: 1234, roundNo: 2, detachedRunnerHash: "c".repeat(64),
    catalogHash: catalog.bindingSha256, durableRevision: "synthetic-revision",
    toolUses: [{ id: "toolu_prior_a", boxName, clientName: "local_echo",
      inputHash: "f".repeat(64) }],
    results: [{ modelToolUseId: "toolu_prior_a", content: [{ type: "text", text: resultText }],
      isError: false, contentHash: currentHash }],
    ...(native ? { nativeSessionId: "12345678-1234-4123-8123-123456789abc",
      nativeCliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}` } : {}) };
  const bytes = Buffer.concat([raw([...(omitEcho ? [] : [currentEcho]),
    ...(kind === "tool" ? toolRecords : finalRecords)]),
    ...(trailing ? [Buffer.from("not-json-after-result\n")] : [])]);
  const proof = { runNonce: claim.runNonce, leaseEpoch: claim.leaseEpoch,
    keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 };
  const target = { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
    const args = request.args;
    if (args[5] === "--read") {
      sequence.push("spool-read");
      const offset = Number(args[7]);
      const start = Math.max(0, offset - claim.spoolOffset);
      const part = bytes.subarray(start, start + 65536);
      return { stdout: JSON.stringify({ offset: offset + part.length,
        data: part.toString("base64") }), stderrBytes: 0, exitCode: 0 as const };
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("pending.")) {
      sequence.push("pending-read");
      return { stdout: JSON.stringify({ version: 1, modelToolUseId: id,
        mcpRequestId: 7, name: "t0", arguments: { value: "x" } }),
      stderrBytes: 0, exitCode: 0 as const };
    }
    if (args[2]?.includes("print(json.dumps({'sha256':actual")) {
      sequence.push("native-inspect");
      return { stdout: JSON.stringify({ sha256: "f".repeat(64), size: 100 }) + "\n",
        stderrBytes: 0, exitCode: 0 as const };
    }
    sequence.push("proof-read");
    return { stdout: JSON.stringify(proof) + "\n", stderrBytes: 0, exitCode: 0 as const };
  } } };
  const published = { claim, target, access: makeBoxDetachedRunAccess({
    runNonce: claim.runNonce, detachedRunnerHash: claim.detachedRunnerHash }) };
  const journal = { recordToolHandoff: async (evidence: { spoolOffset: number }) => {
    sequence.push("durable-handoff");
    assert.equal(evidence.spoolOffset, claim.spoolOffset + bytes.length);
    return { durableRevision: "revision-next", journaledToolUseIds: [id],
      verifiedPendingToolUseIds: [id] };
  }, completeToolChain: async (evidence: { usage: { outputTokens: number } }) => {
    sequence.push("terminal-journal");
    assert.equal(evidence.usage.outputTokens, 4);
    if (failComplete) throw new Error("synthetic journal failure");
  }, attachNativePointer: async () => { sequence.push("native-attach"); return true; },
  markUnknown: async () => { sequence.push("unknown"); } };
  const deps = { journal: journal as never,
    retainUnknownTarget: () => { retained = true; sequence.push("retain"); },
    onUnknown: async () => { sequence.push("notify"); } };
  const input = { published: published as never, uid: 3n, requestId: "box-next",
    canonicalBody: body, upstreamModel: model,
    emit: (sse: string) => { sequence.push("emit"); emitted.push(sse); } };
  return { input, deps, sequence, emitted, proof, bytes,
    get retained() { return retained; } };
}

test("continued tool round records exact new offset before terminal SSE", async () => {
  const f = fixture("tool");
  const result = await runBoxToolContinuation(f.input, f.deps);
  assert.deepEqual(result, { kind: "tool_handoff", spoolOffset: 1234 + f.bytes.length });
  assert.ok(f.sequence.indexOf("durable-handoff") < f.sequence.lastIndexOf("emit"));
  assert.ok(f.emitted.at(-1)?.includes("event: message_stop"));
  assert.equal(f.retained, false);
});

test("final round waits for Box terminal and journal before terminal SSE", async () => {
  const f = fixture("final");
  const result = await runBoxToolContinuation(f.input, f.deps);
  assert.equal(result.kind, "final");
  assert.ok(f.sequence.indexOf("proof-read") < f.sequence.indexOf("terminal-journal"));
  assert.ok(f.sequence.indexOf("terminal-journal") < f.sequence.lastIndexOf("emit"));
  assert.ok(f.emitted.at(-1)?.includes("event: message_stop"));
});

test("each continued round writes its Message before the same-row journal CAS", async () => {
  for (const kind of ["tool", "final"] as const) {
    const f = fixture(kind);
    const journal = f.deps.journal as unknown as {
      recordToolHandoff: (input: { messagePointer?: BoxReplayMessagePointer }) => Promise<unknown>;
      completeToolChain: (input: { messagePointer?: BoxReplayMessagePointer }) => Promise<void>;
    };
    const originalHandoff = journal.recordToolHandoff.bind(journal);
    const originalFinal = journal.completeToolChain.bind(journal);
    journal.recordToolHandoff = async (input) => {
      assert.equal(input.messagePointer?.requestId, f.input.requestId);
      assert.equal(input.messagePointer?.roundNo, 2);
      return originalHandoff(input);
    };
    journal.completeToolChain = async (input) => {
      assert.equal(input.messagePointer?.requestId, f.input.requestId);
      assert.equal(input.messagePointer?.roundNo, 2);
      return originalFinal(input);
    };
    const writeMessage: BoxReplayMessageWriter = async (identity, message) => {
      f.sequence.push("capsule-write");
      assert.equal((message as { id: string }).id,
        kind === "tool" ? "msg_tool_next" : "msg_final_next");
      return { version: 1, ...identity, bytes: 100, sha256: "c".repeat(64) };
    };
    await runBoxToolContinuation(f.input, { ...f.deps, writeMessage });
    const journalEvent = kind === "tool" ? "durable-handoff" : "terminal-journal";
    assert.ok(f.sequence.indexOf("capsule-write") < f.sequence.indexOf(journalEvent));
    assert.ok(f.sequence.indexOf(journalEvent) < f.sequence.lastIndexOf("emit"));
  }
});

test("native final tool round publishes transcript pointer after durable usage", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const f = fixture("final", false, false, false, false, true);
    const result = await runBoxToolContinuation(f.input, f.deps);
    assert.equal(result.kind, "final");
    if (result.kind !== "final") return;
    assert.equal(result.nativePointer?.accountId, "20");
    assert.equal(result.nativePointer?.transcriptSha256, "f".repeat(64));
    assert.ok(f.sequence.indexOf("terminal-journal") < f.sequence.indexOf("native-inspect"));
    assert.ok(f.sequence.indexOf("native-inspect") < f.sequence.indexOf("native-attach"));
    assert.ok(f.sequence.indexOf("native-attach") < f.sequence.lastIndexOf("emit"));
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
});

test("1.1 MB complete tool echo crosses chunk boundaries before final billing", async () => {
  const f = fixture("final", false, false, false, true);
  const result = await runBoxToolContinuation(f.input, f.deps);
  assert.equal(result.kind, "final");
  assert.ok(f.sequence.filter((step) => step === "spool-read").length > 16);
  assert.ok(f.sequence.indexOf("terminal-journal") < f.sequence.lastIndexOf("emit"));
  assert.equal(f.retained, false);
});

test("journal failure after terminal proof withholds final SSE and preserves unknown", async () => {
  const f = fixture("final", true);
  await assert.rejects(() => runBoxToolContinuation(f.input, f.deps),
    /synthetic journal failure/);
  assert.ok(f.sequence.includes("unknown"));
  assert.equal(f.retained, true);
  assert.ok(!f.emitted.join("").includes("event: message_stop"));
});

test("changed catalog after result publication fails closed with target retained", async () => {
  const f = fixture("final");
  (f.input.published as unknown as { claim: { catalogHash: string } })
    .claim.catalogHash = "f".repeat(64);
  await assert.rejects(() => runBoxToolContinuation(f.input, f.deps),
    /BOX_TOOL_CONTINUATION_BINDING_INVALID/);
  assert.ok(f.sequence.includes("unknown"));
  assert.equal(f.retained, true);
  assert.equal(f.emitted.length, 0);
});

test("post-success spool bytes block terminal journal and final SSE", async () => {
  const f = fixture("final", false, true);
  await assert.rejects(() => runBoxToolContinuation(f.input, f.deps),
    /BOX_TOOL_FINAL_TRAILING_BYTES/);
  assert.ok(f.sequence.includes("proof-read"));
  assert.ok(!f.sequence.includes("terminal-journal"));
  assert.ok(!f.emitted.join("").includes("event: message_stop"));
  assert.equal(f.retained, true);
});

test("missing tool-result echo blocks both next tool and final model rounds", async () => {
  for (const kind of ["tool", "final"] as const) {
    const f = fixture(kind, false, false, true);
    await assert.rejects(() => runBoxToolContinuation(f.input, f.deps),
      /BOX_TOOL_ECHO_INCOMPLETE/);
    assert.ok(f.sequence.includes("unknown"));
    assert.ok(!f.sequence.includes("durable-handoff"));
    assert.ok(!f.sequence.includes("terminal-journal"));
    assert.equal(f.retained, true);
  }
});

const NATIVE = "12345678-1234-4123-8123-123456789abc";
const OUTER = "a95915c9-b92f-4980-8c7a-d339e54e5767";
const heartbeat = (parent: string, name: string, elapsed: number, session = NATIVE,
  index = 0, extra?: Record<string, unknown>) => ({
  type: "tool_progress", tool_use_id: `${parent}-heartbeat-${index}`, tool_name: name,
  parent_tool_use_id: parent, elapsed_time_seconds: elapsed, heartbeat: true,
  session_id: session, uuid: "22222222-2222-4222-8222-222222222222", ...extra });

test("long tool heartbeats before between and after echoes do not advance handoff offset", async () => {
  const tools = [
    { name: "local_echo", description: "synthetic local tool",
      input_schema: { type: "object", properties: { value: { type: "string" } } } },
    { name: "local_read", description: "synthetic second tool",
      input_schema: { type: "object", properties: { value: { type: "string" } } } },
  ];
  const localCatalog = compileBoxToolCatalog(tools);
  const priorA = "toolu_prior_a", priorB = "toolu_prior_b", nextId = "toolu_next_c";
  const nameA = "mcp__ocbridge__t0", nameB = "mcp__ocbridge__t1";
  const textA = "alpha", textB = "beta";
  const hashOf = (text: string, isError = false) => createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text }], isError })).digest("hex");
  const echo = (id: string, text: string, isError = false) => ({ type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id,
      content: text, ...(isError ? { is_error: true } : {}) }] } });
  const message = [
    event({ type: "message_start", message: { id: "msg_tool_next", model,
      role: "assistant", content: [], usage } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: nextId, name: nameA, input: {} } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
    { type: "assistant", message: { id: "msg_tool_next", model, role: "assistant",
      content: [{ type: "tool_use", id: nextId, name: nameA, input: { value: "x" } }] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 2, output_tokens: 4 } }),
    event({ type: "message_stop" }),
  ];
  const nextHeartbeat = heartbeat(nextId, nameA, 30, NATIVE, 0);
  const records = [
    heartbeat(priorA, nameA, 30),
    heartbeat(priorA, nameA, 60, NATIVE, 1),
    echo(priorA, textA),
    heartbeat(priorB, nameB, 540, NATIVE, 2),
    echo(priorB, textB, true),
    heartbeat(priorA, nameA, 90, NATIVE, 3),
    ...message,
    nextHeartbeat,
  ];
  const lines = records.map((record) => Buffer.from(JSON.stringify(record) + "\n"));
  const stopAt = lines.slice(0, records.length - 1).reduce((sum, line) => sum + line.length, 0);
  const bytes = Buffer.concat(lines);
  const spoolOffset = 5000;
  const sequence: string[] = [];
  const emitted: string[] = [];
  let settled = 0;
  let retained = false;
  const claim = { ownerRequestId: "box-owner", accountId: 20n,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), spoolOffset, roundNo: 2,
    detachedRunnerHash: "c".repeat(64), catalogHash: localCatalog.bindingSha256,
    durableRevision: "synthetic-revision",
    toolUses: [
      { id: priorA, boxName: nameA, clientName: "local_echo", inputHash: "f".repeat(64) },
      { id: priorB, boxName: nameB, clientName: "local_read", inputHash: "e".repeat(64) },
    ],
    results: [
      { modelToolUseId: priorA, content: [{ type: "text", text: textA }],
        isError: false, contentHash: hashOf(textA) },
      { modelToolUseId: priorB, content: [{ type: "text", text: textB }],
        isError: true, contentHash: hashOf(textB, true) },
    ],
    nativeSessionId: NATIVE, nativeCliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}` };
  const access = makeBoxDetachedRunAccess({ runNonce: claim.runNonce,
    detachedRunnerHash: claim.detachedRunnerHash });
  const execFor = (source: Buffer, chunk: number) => async (request: { args: string[] }) => {
    const args = request.args;
    if (args[5] === "--read") {
      sequence.push("spool-read");
      const offset = Number(args[7]);
      const start = Math.max(0, offset - spoolOffset);
      const part = source.subarray(start, start + chunk);
      return { stdout: JSON.stringify({ offset: offset + part.length,
        data: part.toString("base64") }), stderrBytes: 0, exitCode: 0 as const };
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("pending.")) {
      sequence.push("pending-read");
      return { stdout: JSON.stringify({ version: 1, modelToolUseId: nextId,
        mcpRequestId: 7, name: "t0", arguments: { value: "x" } }),
      stderrBytes: 0, exitCode: 0 as const };
    }
    sequence.push("unexpected-remote");
    throw new Error("must not read proof, publish, or settle");
  };
  const deps = { budgetMs: 2000, journal: {
    recordToolHandoff: async (evidence: { spoolOffset: number }) => {
      sequence.push("durable-handoff");
      assert.equal(evidence.spoolOffset, spoolOffset + stopAt);
      return { durableRevision: "revision-next", journaledToolUseIds: [nextId],
        verifiedPendingToolUseIds: [nextId] };
    }, completeToolChain: async () => { sequence.push("terminal-journal"); settled += 1; },
    markUnknown: async () => { sequence.push("unknown"); },
  } as never, retainUnknownTarget: () => { retained = true; sequence.push("retain"); },
  onUnknown: async () => { sequence.push("notify"); } };
  const inputFor = (source: Buffer, chunk: number) => ({
    published: { claim, target: { accountId: 20n, exec: { run: execFor(source, chunk) } },
      access } as never,
    uid: 3n, requestId: "box-next", canonicalBody: { ...body, tools },
    upstreamModel: model, emit: (sse: string) => { sequence.push("emit"); emitted.push(sse); },
  });
  const result = await runBoxToolContinuation(inputFor(bytes, 65536), deps);
  assert.deepEqual(result, { kind: "tool_handoff", spoolOffset: spoolOffset + stopAt });
  assert.equal(bytes.subarray(stopAt).toString("utf8").includes(nextId + "-heartbeat-0"), true);
  assert.ok(!emitted.join("").includes("heartbeat"));
  assert.equal(settled, 0);
  assert.equal(retained, false);
  assert.ok(!sequence.includes("unknown"));
  sequence.length = 0; emitted.length = 0; retained = false;
  const split = await runBoxToolContinuation(inputFor(bytes, 1), deps);
  assert.equal(split.kind, "tool_handoff");
  if (split.kind === "tool_handoff") assert.equal(split.spoolOffset, spoolOffset + stopAt);
  const crlf = Buffer.concat(records.map((record) => Buffer.from(JSON.stringify(record) + "\r\n")));
  const crlfStop = records.slice(0, -1).reduce((sum, record) =>
    sum + Buffer.byteLength(JSON.stringify(record) + "\r\n"), 0);
  sequence.length = 0;
  const crlfResult = await runBoxToolContinuation(inputFor(crlf, 65536), {
    budgetMs: 2000, retainUnknownTarget: () => { retained = true; },
    onUnknown: async () => { sequence.push("notify"); },
    journal: { recordToolHandoff: async (evidence: { spoolOffset: number }) => {
      assert.equal(evidence.spoolOffset, spoolOffset + crlfStop);
      return { durableRevision: "revision-next", journaledToolUseIds: [nextId],
        verifiedPendingToolUseIds: [nextId] };
    }, completeToolChain: async () => { settled += 1; },
    markUnknown: async () => { sequence.push("unknown"); } } as never });
  assert.equal(crlfResult.kind, "tool_handoff");
  if (crlfResult.kind === "tool_handoff") assert.equal(crlfResult.spoolOffset, spoolOffset + crlfStop);
  assert.notEqual(OUTER, NATIVE);
});

test("heartbeat-only progress does not complete echo or settle", async () => {
  const only = [heartbeat("toolu_prior_a", boxName, 30),
    event({ type: "message_start", message: { id: "msg_tool_next", model,
      role: "assistant", content: [], usage } })];
  const bytes = Buffer.from(only.map((record) => JSON.stringify(record) + "\n").join(""));
  const sequence: string[] = [];
  const claim = { ownerRequestId: "box-owner", accountId: 20n,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), spoolOffset: 10, roundNo: 2,
    detachedRunnerHash: "c".repeat(64), catalogHash: catalog.bindingSha256,
    durableRevision: "synthetic-revision",
    toolUses: [{ id: "toolu_prior_a", boxName, clientName: "local_echo",
      inputHash: "f".repeat(64) }],
    results: [{ modelToolUseId: "toolu_prior_a", content: [{ type: "text", text: localResult }],
      isError: false, contentHash: echoHash }], nativeSessionId: NATIVE,
    nativeCliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}` };
  await assert.rejects(() => runBoxToolContinuation({
    published: { claim, target: { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
      const offset = Number(request.args[7]);
      const part = bytes.subarray(Math.max(0, offset - 10));
      return { stdout: JSON.stringify({ offset: offset + part.length,
        data: part.toString("base64") }), stderrBytes: 0, exitCode: 0 as const };
    } } }, access: makeBoxDetachedRunAccess({ runNonce: claim.runNonce,
      detachedRunnerHash: claim.detachedRunnerHash }) } as never,
    uid: 3n, requestId: "box-next", canonicalBody: body, upstreamModel: model, emit: () => {},
  }, { budgetMs: 1000, journal: { recordToolHandoff: async () => { sequence.push("handoff"); },
    completeToolChain: async () => { sequence.push("settle"); },
    markUnknown: async () => { sequence.push("unknown"); } } as never,
  retainUnknownTarget: () => { sequence.push("retain"); },
  onUnknown: async () => { sequence.push("notify"); } }), /BOX_TOOL_ECHO_INCOMPLETE/);
  assert.deepEqual(sequence.filter((item) => item !== "unknown" && item !== "retain"
    && item !== "notify"), []);
});

test("wrong parent, tool name, outer session, missing binding, and late phase stay rejected", async () => {
  const cases = [
    heartbeat("toolu_other", boxName, 30),
    heartbeat("toolu_prior_a", "mcp__ocbridge__t9", 30),
    heartbeat("toolu_prior_a", boxName, 30, OUTER),
    heartbeat("toolu_prior_a", boxName, 30, NATIVE, 0, { usage: { input_tokens: 1 } }),
  ];
  for (const record of cases) {
    const f = fixture("tool", false, false, false, false, true);
    const published = f.input.published as { claim: { nativeSessionId?: string };
      access: unknown };
    const prefix = Buffer.from(JSON.stringify(record) + "\n");
    const bytes = Buffer.concat([prefix, Buffer.from([echoRecord, ...toolRecords]
      .map((item) => JSON.stringify(item) + "\n").join(""))]);
    const sequence: string[] = [];
    await assert.rejects(() => runBoxToolContinuation({
      published: { claim: { ...published.claim, nativeSessionId: NATIVE },
        target: { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
          if (request.args[5] !== "--read") throw new Error("must not continue");
          const offset = Number(request.args[7]);
          const part = bytes.subarray(Math.max(0, offset - 1234));
          return { stdout: JSON.stringify({ offset: offset + part.length,
            data: part.toString("base64") }), stderrBytes: 0, exitCode: 0 as const };
        } } }, access: published.access } as never,
      uid: 3n, requestId: "box-next", canonicalBody: body, upstreamModel: model,
      emit: () => { sequence.push("emit"); },
    }, { budgetMs: 1000, journal: { recordToolHandoff: async () => { sequence.push("handoff"); },
      completeToolChain: async () => { sequence.push("settle"); },
      markUnknown: async () => { sequence.push("unknown"); } } as never,
    retainUnknownTarget: () => {}, onUnknown: async () => {} }), /BOX_TOOL_RECORD_INVALID/);
    assert.ok(!sequence.includes("handoff"));
    assert.ok(!sequence.includes("settle"));
    assert.ok(!sequence.includes("emit"));
  }
  const f = fixture("tool");
  const plain = f.input.published as { claim: unknown; access: unknown };
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(heartbeat("toolu_prior_a", boxName, 30)) + "\n"),
    Buffer.from([echoRecord, ...toolRecords].map((item) => JSON.stringify(item) + "\n").join(""))]);
  await assert.rejects(() => runBoxToolContinuation({
    published: { claim: plain.claim, target: { accountId: 20n,
      exec: { run: async (request: { args: string[] }) => {
        const offset = Number(request.args[7]);
        const part = bytes.subarray(Math.max(0, offset - 1234));
        return { stdout: JSON.stringify({ offset: offset + part.length,
          data: part.toString("base64") }), stderrBytes: 0, exitCode: 0 as const };
      } } }, access: plain.access } as never,
    uid: 3n, requestId: "box-next", canonicalBody: body, upstreamModel: model, emit: () => {},
  }, { budgetMs: 1000, journal: { recordToolHandoff: async () => { throw new Error("handoff"); },
    completeToolChain: async () => { throw new Error("settle"); },
    markUnknown: async () => {} } as never,
  retainUnknownTarget: () => {}, onUnknown: async () => {} }), /BOX_TOOL_RECORD_INVALID/);
  const late = Buffer.from([echoRecord, toolRecords[0], heartbeat("toolu_prior_a", boxName, 30)]
    .map((item) => JSON.stringify(item) + "\n").join(""));
  const bound = fixture("tool", false, false, false, false, true);
  const boundPublished = bound.input.published as { claim: unknown; access: unknown };
  await assert.rejects(() => runBoxToolContinuation({
    published: { claim: boundPublished.claim, target: { accountId: 20n,
      exec: { run: async (request: { args: string[] }) => {
        const offset = Number(request.args[7]);
        const part = late.subarray(Math.max(0, offset - 1234));
        return { stdout: JSON.stringify({ offset: offset + part.length,
          data: part.toString("base64") }), stderrBytes: 0, exitCode: 0 as const };
      } } }, access: boundPublished.access } as never,
    uid: 3n, requestId: "box-next", canonicalBody: body, upstreamModel: model, emit: () => {},
  }, { budgetMs: 1000, journal: { recordToolHandoff: async () => { throw new Error("handoff"); },
    completeToolChain: async () => { throw new Error("settle"); },
    markUnknown: async () => {} } as never,
  retainUnknownTarget: () => {}, onUnknown: async () => {} }), /BOX_TOOL_RECORD_INVALID/);
});
