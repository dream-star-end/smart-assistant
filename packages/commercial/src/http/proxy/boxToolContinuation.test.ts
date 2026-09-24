import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { runBoxToolContinuation } from "./boxToolContinuation.js";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import type { ProxyBody } from "./shared.js";

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
  trailing = false, omitEcho = false) {
  const sequence: string[] = [], emitted: string[] = [];
  let retained = false;
  const claim = { ownerRequestId: "box-owner", accountId: 20n,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
    spoolOffset: 1234, roundNo: 2, detachedRunnerHash: "c".repeat(64),
    catalogHash: catalog.bindingSha256, durableRevision: "synthetic-revision",
    toolUses: [{ id: "toolu_prior_a", boxName, clientName: "local_echo",
      inputHash: "f".repeat(64) }],
    results: [{ modelToolUseId: "toolu_prior_a", content: [{ type: "text", text: localResult }],
      isError: false, contentHash: echoHash }] };
  const bytes = Buffer.concat([raw([...(omitEcho ? [] : [echoRecord]),
    ...(kind === "tool" ? toolRecords : finalRecords)]),
    ...(trailing ? [Buffer.from("not-json-after-result\n")] : [])]);
  const proof = { runNonce: claim.runNonce, leaseEpoch: claim.leaseEpoch,
    keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 };
  const target = { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
    const args = request.args;
    if (args[5] === "--read") {
      sequence.push("spool-read");
      const offset = Number(args[7]);
      const part = bytes.subarray(Math.max(0, offset - claim.spoolOffset));
      return { stdout: JSON.stringify({ offset: offset + part.length,
        data: part.toString("base64") }), stderrBytes: 0, exitCode: 0 as const };
    }
    if (args[1]?.includes("pending.")) {
      sequence.push("pending-read");
      return { stdout: JSON.stringify({ version: 1, modelToolUseId: id,
        mcpRequestId: 7, name: "t0", arguments: { value: "x" } }),
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
  }, markUnknown: async () => { sequence.push("unknown"); } };
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
