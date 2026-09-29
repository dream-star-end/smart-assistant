import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import type { BoxDurableJournal, BoxReplayIdentity } from "./boxDurableJournal.js";
import { observeBoxToolUnknown } from "./boxToolUnknownObserver.js";
import type { ProxyBody } from "./shared.js";

const model = "claude-opus-5-5";
const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, messages: [{ role: "user", content: "synthetic" }],
  tools: [{ name: "local_echo", description: "synthetic",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }],
  metadata: { user_id: JSON.stringify({ session_id: "session-synthetic",
    oc_turn_key: "a".repeat(64) }) } };
const catalogHash = compileBoxToolCatalog(body.tools).bindingSha256;
const identity: BoxReplayIdentity = { requestId: "synthetic-request",
  rootRequestId: "synthetic-request", uid: 3n, accountId: 20n,
  runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
  invocationMode: "detached_tool", state: "unknown", roundNo: 1,
  spoolOffset: 0, rootLaunchPermit: true,
  detachedRunnerHash: "c".repeat(64), catalogHash };
const event = (value: unknown) => ({ type: "stream_event", event: value });
const use = { type: "tool_use", id: "toolu_synthetic_a",
  name: "mcp__ocbridge__t0", input: { value: "x" } };
const common = [
  { type: "system", subtype: "init", tools: [use.name], mcp_servers: [{}] },
  event({ type: "message_start", message: { id: "msg_synthetic", model,
    role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
  event({ type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id: use.id, name: use.name, input: {} } }),
  event({ type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
  { type: "assistant", message: { id: "msg_synthetic", model,
    role: "assistant", content: [use] } },
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "tool_use" },
    usage: { input_tokens: 2, output_tokens: 4 } }),
  event({ type: "message_stop" }),
];
const toolRaw = Buffer.from(common.map((record) => JSON.stringify(record) + "\n").join(""));

test("unknown root observes one tool handoff from existing spool, never launches", async () => {
  const requests: string[] = [];
  let journaled: unknown;
  let written: unknown;
  let disposed = false;
  const target = { accountId: 20n, dispose: () => { disposed = true; },
    exec: { run: async (request: { args: string[] }) => {
      if (request.args[5] === "--read") {
        requests.push("read");
        const offset = Number(request.args[7]);
        const bytes = toolRaw.subarray(offset);
        return { stdout: JSON.stringify({ data: bytes.toString("base64"),
          offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 };
      }
      if (request.args[2]?.includes("pending.")) {
        requests.push("pending");
        return { stdout: JSON.stringify({ version: 1,
          modelToolUseId: use.id, mcpRequestId: 7,
          name: "t0", arguments: { value: "x" } }),
        stderrBytes: 0, exitCode: 0 };
      }
      throw new Error("paid launch or unexpected remote operation");
    } } };
  const outcome = await observeBoxToolUnknown({ identity,
    canonicalBody: body, upstreamModel: model }, {
    resolveTarget: async (args) => {
      assert.equal(args.requiredAccountId, 20n);
      assert.equal(args.allowWakeIfHibernated, false);
      return target as never;
    },
    writeMessage: async (id, message) => {
      written = message;
      return { version: 1, ...id, bytes: 123, sha256: "d".repeat(64) };
    },
    journal: { recordToolHandoff: async (
      value: Parameters<BoxDurableJournal["recordToolHandoff"]>[0]) => {
      journaled = value;
      return { durableRevision: "synthetic", journaledToolUseIds: [use.id],
        verifiedPendingToolUseIds: [use.id] };
    } } as never,
  });
  assert.equal(outcome, "committed");
  assert.deepEqual(requests, ["read", "pending"]);
  assert.equal(disposed, true);
  assert.equal((written as { id: string }).id, "msg_synthetic");
  assert.equal((journaled as { spoolOffset: number }).spoolOffset, toolRaw.length);
});

test("unknown without the original paid permit never resolves Box", async () => {
  let resolved = false;
  const outcome = await observeBoxToolUnknown({ identity: {
    ...identity, rootLaunchPermit: false }, canonicalBody: body,
    upstreamModel: model }, { journal: {} as never,
    writeMessage: async () => { throw new Error("must not write"); },
    resolveTarget: async () => { resolved = true; throw new Error("must not resolve"); } });
  assert.equal(outcome, "pending");
  assert.equal(resolved, false);
});

test("linked observer validates the parent tool-result echo before model evidence", async () => {
  const echo = { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: use.id, content: "ok" }] } };
  const hash = createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text: "ok" }], isError: false })).digest("hex");
  const linked = { ...identity, requestId: "linked-request", roundNo: 2,
    resultHashes: [{ modelToolUseId: use.id, contentHash: hash, isError: false }] };
  const modelRecords = common.slice(1);
  const raw = Buffer.from([echo, ...modelRecords].map((x) => JSON.stringify(x) + "\n").join(""));
  let committed = false, disposed = false;
  const target = { accountId: 20n, dispose: () => { disposed = true; },
    exec: { run: async (req: { args: string[] }) => {
      if (req.args[5] === "--read") {
        const offset = Number(req.args[7]);
        const bytes = raw.subarray(offset);
        return { stdout: JSON.stringify({ data: bytes.toString("base64"),
          offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 };
      }
      if (req.args[2]?.includes("pending.")) return { stdout: JSON.stringify({
        version: 1, modelToolUseId: use.id, mcpRequestId: 7,
        name: "t0", arguments: { value: "x" } }),
      stderrBytes: 0, exitCode: 0 };
      throw new Error("paid or unexpected remote operation");
    } } };
  const result = await observeBoxToolUnknown({ identity: linked,
    canonicalBody: body, upstreamModel: model }, {
    resolveTarget: async () => target as never,
    writeMessage: async (id) => ({ version: 1, ...id,
      bytes: 123, sha256: "d".repeat(64) }),
    journal: { recordToolHandoff: async () => {
      committed = true;
      return { durableRevision: "synthetic", journaledToolUseIds: [use.id],
        verifiedPendingToolUseIds: [use.id] };
    } } as never,
  });
  assert.equal(result, "committed");
  assert.equal(committed, true);
  assert.equal(disposed, true);
});

test("root final requires remote completion proof and exact spool EOF", async () => {
  const records = [common[0],
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
      usage: { input_tokens: 2, output_tokens: 4 } },
  ];
  const raw = Buffer.from(records.map((x) => JSON.stringify(x) + "\n").join(""));
  let committed = false;
  const target = { accountId: 20n, dispose: () => {},
    exec: { run: async (req: { args: string[] }) => {
      if (req.args[5] === "--read") {
        const offset = Number(req.args[7]);
        const bytes = raw.subarray(offset);
        return { stdout: JSON.stringify({ data: bytes.toString("base64"),
          offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 };
      }
      if (req.args[2]?.includes("terminal.json")) return { stdout: JSON.stringify({
        runNonce: identity.runNonce, leaseEpoch: identity.leaseEpoch,
        keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 }) + "\n",
      stderrBytes: 0, exitCode: 0 };
      throw new Error("paid or unexpected remote operation");
    } } };
  const result = await observeBoxToolUnknown({ identity,
    canonicalBody: body, upstreamModel: model }, {
    resolveTarget: async () => target as never,
    writeMessage: async (id) => ({ version: 1, ...id,
      bytes: 123, sha256: "d".repeat(64) }),
    journal: { complete: async () => { committed = true; } } as never,
  });
  assert.equal(result, "committed");
  assert.equal(committed, true);
});

test("observer skips a bound heartbeat and still rejects the outer session", async () => {
  const native = "11111111-1111-4111-8111-111111111111";
  const outer = "a95915c9-b92f-4980-8c7a-d339e54e5767";
  const echo = { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: use.id, content: "ok" }] } };
  const hash = createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text: "ok" }], isError: false })).digest("hex");
  const beat = (session: string) => ({ type: "tool_progress",
    tool_use_id: `${use.id}-heartbeat-0`, tool_name: use.name,
    parent_tool_use_id: use.id, elapsed_time_seconds: 30, heartbeat: true,
    session_id: session, uuid: "22222222-2222-4222-8222-222222222222" });
  const linked = { ...identity, requestId: "linked-request", roundNo: 2, spoolOffset: 80,
    resultHashes: [{ modelToolUseId: use.id, contentHash: hash, isError: false }],
    priorToolUses: [{ id: use.id, boxName: use.name, clientName: "local_echo",
      inputHash: "ab".repeat(32) }], nativeSessionId: native };
  const raw = Buffer.from([beat(native), echo, ...common.slice(1)]
    .map((item) => JSON.stringify(item) + "\n").join(""));
  let settled = 0;
  const target = { accountId: 20n, dispose: () => {},
    exec: { run: async (req: { args: string[] }) => {
      if (req.args[5] === "--read") {
        const offset = Number(req.args[7]);
        const bytes = raw.subarray(Math.max(0, offset - linked.spoolOffset));
        return { stdout: JSON.stringify({ data: bytes.toString("base64"),
          offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 };
      }
      if (req.args[2]?.includes("pending.")) return { stdout: JSON.stringify({
        version: 1, modelToolUseId: use.id, mcpRequestId: 7,
        name: "t0", arguments: { value: "x" } }), stderrBytes: 0, exitCode: 0 };
      throw new Error("paid or unexpected remote operation");
    } } };
  const deps = { resolveTarget: async () => target as never,
    writeMessage: async (id: { uid: string; requestId: string; runNonce: string;
      leaseEpoch: string; roundNo: number }) => ({ version: 1 as const, ...id,
      bytes: 123, sha256: "d".repeat(64) }),
    journal: { recordToolHandoff: async () => ({ durableRevision: "synthetic",
      journaledToolUseIds: [use.id], verifiedPendingToolUseIds: [use.id] }),
    completeToolChain: async () => { settled += 1; } } as never };
  const ok = await observeBoxToolUnknown({ identity: linked, canonicalBody: body,
    upstreamModel: model }, deps);
  assert.equal(ok, "committed");
  assert.equal(settled, 0);
  const wrong = Buffer.from([beat(outer), echo, ...common.slice(1)]
    .map((item) => JSON.stringify(item) + "\n").join(""));
  const wrongTarget = { ...target, exec: { run: async (req: { args: string[] }) => {
    if (req.args[5] === "--read") {
      const offset = Number(req.args[7]);
      const bytes = wrong.subarray(Math.max(0, offset - linked.spoolOffset));
      return { stdout: JSON.stringify({ data: bytes.toString("base64"),
        offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 };
    }
    throw new Error("must not read pending after a rejected heartbeat");
  } } };
  await assert.rejects(() => observeBoxToolUnknown({ identity: linked, canonicalBody: body,
    upstreamModel: model }, { ...deps, resolveTarget: async () => wrongTarget as never }),
  /BOX_TOOL_RECORD_INVALID/);
  const unbound = { ...linked, nativeSessionId: undefined, priorToolUses: undefined };
  await assert.rejects(() => observeBoxToolUnknown({ identity: unbound, canonicalBody: body,
    upstreamModel: model }, deps), /BOX_TOOL_RECORD_INVALID/);
});
