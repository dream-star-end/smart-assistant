import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { createBoxReplayReader, createBoxReplayWriter } from "../../egress/boxReplaySetup.js";
import { observeBoxToolTerminalOnly } from "./boxToolTerminalRecovery.js";
import { BoxDurableJournalError } from "./boxDurableJournal.js";
import type { BoxDetachedUnknownRecovery } from "./boxDurableJournal.js";

const model = "claude-opus-5-5";
const catalog = compileBoxToolCatalog([{ name: "local_echo", description: "synthetic",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }]);
const use = { type: "tool_use", id: "toolu_synthetic_a",
  name: "mcp__ocbridge__t0", input: { value: "x" } };
const evidence: BoxDetachedUnknownRecovery = {
  requestId: "synthetic-request", uid: 3n, accountId: 20n,
  runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
  sessionId: "session-synthetic", turnKey: "c".repeat(64),
  model: "box-api-claude-opus-5-5", upstreamModel: model, roundNo: 1,
  spoolOffset: 0, catalogHash: catalog.bindingSha256,
  detachedRunnerHash: "d".repeat(64), rootRequestId: "synthetic-request",
  rootLaunchPermit: true, resultHashes: null };
const event = (value: unknown) => ({ type: "stream_event", event: value });
const proof = { runNonce: evidence.runNonce, leaseEpoch: evidence.leaseEpoch,
  keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 };

function spool(records: unknown[]) {
  const raw = Buffer.from(records.map((item) => JSON.stringify(item) + "\n").join(""));
  return { accountId: 20n, exec: { run: async (req: { args: string[] }) => {
    if (req.args[5] === "--read") {
      const offset = Number(req.args[7]);
      const bytes = raw.subarray(offset);
      return { stdout: JSON.stringify({ data: bytes.toString("base64"),
        offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 as const };
    }
    if (req.args[2]?.includes("terminal.json")) {
      return { stdout: JSON.stringify(proof) + "\n", stderrBytes: 0, exitCode: 0 as const };
    }
    throw new Error(`unexpected exec ${req.args.join(" ")}`);
  } } };
}

const handoffRecords = [
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
const finalRecords = [
  { type: "system", subtype: "init", tools: [use.name], mcp_servers: [{}] },
  event({ type: "message_start", message: { id: "msg_final", model,
    role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 0,
      cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } } }),
  event({ type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "done" } }),
  { type: "assistant", message: { id: "msg_final", model, role: "assistant",
    content: [{ type: "text", text: "done" }] } },
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 3, output_tokens: 4 } }),
  event({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 9, output_tokens: 8,
      cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } },
];

test("terminal-only recovery does not write a handoff or skip to a later final", async () => {
  let writes = 0, completes = 0;
  const mixed = [...handoffRecords, ...finalRecords.slice(1)];
  const outcome = await observeBoxToolTerminalOnly({
    evidence, catalog, target: spool(mixed) as never }, {
    writeMessage: async () => { writes++; throw new Error("must not write"); },
    journal: { complete: async () => { completes++; },
      completeToolChain: async () => { completes++; },
      readRecoveryWinner: async () => null } as never });
  assert.deepEqual(outcome, { status: "pending", reason: "BOX_RECOVERY_INTERMEDIATE_HANDOFF",
    undeliverable: true });
  assert.equal(writes, 0);
  assert.equal(completes, 0);
});

test("one final round persists a capsule the existing reader can load", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocv5-capsule-"));
  const platformRoot = join(root, "state");
  const writer = createBoxReplayWriter(true, platformRoot);
  const reader = createBoxReplayReader(platformRoot);
  assert.ok(writer && reader);
  let usage: unknown;
  try {
    let pointer: Awaited<ReturnType<NonNullable<typeof writer>>> | undefined;
    const outcome = await observeBoxToolTerminalOnly({
      evidence, catalog, target: spool(finalRecords) as never }, {
      writeMessage: async (id, message) => {
        pointer = await writer!(id, message);
        return pointer;
      },
      journal: { complete: async (input: { usage: unknown }) => { usage = input.usage; },
        completeToolChain: async () => { throw new Error("root uses complete"); },
        readRecoveryWinner: async () => null } as never });
    assert.equal(outcome.status, "committed");
    assert.deepEqual(usage, { inputTokens: 3, outputTokens: 4,
      cacheReadTokens: 1, cacheWriteTokens: 2 });
    assert.ok(pointer);
    const stored = await reader!(pointer) as { id?: string; usage?: { output_tokens?: number } };
    assert.equal(stored.id, "msg_final");
    assert.equal(stored.usage?.output_tokens, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed_stopped winner is not overwritten after BOX_TOOL_CHAIN_INVALID", async () => {
  let completes = 0;
  const echo = { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: use.id, content: "ok" }] } };
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text: "ok" }], isError: false })).digest("hex");
  const outcome = await observeBoxToolTerminalOnly({
    evidence: { ...evidence, roundNo: 2, spoolOffset: 0,
      resultHashes: [{ modelToolUseId: use.id, contentHash: hash, isError: false }] },
    catalog, target: spool([echo, ...finalRecords.slice(1)]) as never }, {
    writeMessage: async (id) => ({ version: 1 as const, ...id, bytes: 8,
      sha256: "e".repeat(64) }),
    journal: {
      complete: async () => { throw new Error("not root"); },
      completeToolChain: async () => {
        completes++;
        throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
      },
      readRecoveryWinner: async () => ({ state: "inflight", boxState: "failed_stopped",
        proofReason: "worker_failed" }),
    } as never });
  assert.equal(completes, 1);
  assert.deepEqual(outcome, { status: "pending", reason: "BOX_RECOVERY_LOST_RACE" });
});

test("a catalog binding mismatch does not write or complete", async () => {
  let writes = 0;
  const outcome = await observeBoxToolTerminalOnly({
    evidence: { ...evidence, catalogHash: "0".repeat(64) },
    catalog, target: spool(finalRecords) as never }, {
    writeMessage: async () => { writes++; throw new Error("must not write"); },
    journal: { complete: async () => { throw new Error("must not complete"); },
      completeToolChain: async () => { throw new Error("must not complete"); },
      readRecoveryWinner: async () => null } as never });
  assert.deepEqual(outcome, { status: "pending", reason: "BOX_RECOVERY_CATALOG_MISMATCH" });
  assert.equal(writes, 0);
});

test("journal state committed with boxState unknown is not a terminal winner", async () => {
  const echo = { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: use.id, content: "ok" }] } };
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text: "ok" }], isError: false })).digest("hex");
  const outcome = await observeBoxToolTerminalOnly({
    evidence: { ...evidence, roundNo: 2, spoolOffset: 0,
      resultHashes: [{ modelToolUseId: use.id, contentHash: hash, isError: false }] },
    catalog, target: spool([echo, ...finalRecords.slice(1)]) as never }, {
    writeMessage: async (id) => ({ version: 1 as const, ...id, bytes: 8,
      sha256: "e".repeat(64) }),
    journal: {
      complete: async () => { throw new Error("not root"); },
      completeToolChain: async () => {
        throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
      },
      readRecoveryWinner: async () => ({ state: "committed", boxState: "unknown",
        proofReason: null }),
    } as never });
  assert.deepEqual(outcome, { status: "pending", reason: "BOX_TOOL_CHAIN_INVALID" });
});

test("bound heartbeat still needs a real final proof and exact EOF", async () => {
  const { createHash } = await import("node:crypto");
  const native = "11111111-1111-4111-8111-111111111111";
  const outer = "a95915c9-b92f-4980-8c7a-d339e54e5767";
  const parent = use.id;
  const echo = { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: parent, content: "ok" }] } };
  const hash = createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text: "ok" }], isError: false })).digest("hex");
  const beat = (session: string, patch: Record<string, unknown> = {}) => ({
    type: "tool_progress", tool_use_id: `${parent}-heartbeat-0`, tool_name: use.name,
    parent_tool_use_id: parent, elapsed_time_seconds: 30, heartbeat: true,
    session_id: session, uuid: "22222222-2222-4222-8222-222222222222", ...patch });
  const bound = { ...evidence, roundNo: 2, spoolOffset: 0,
    resultHashes: [{ modelToolUseId: parent, contentHash: hash, isError: false }],
    priorToolUses: [{ id: parent, boxName: use.name, clientName: "local_echo",
      inputHash: "f".repeat(64) }],
    nativeSessionId: native };
  const finalBody = finalRecords.slice(1);
  const run = async (records: unknown[], execPatch?: (args: string[]) => unknown) => {
    let writes = 0, completes = 0;
    const outcome = await observeBoxToolTerminalOnly({
      evidence: bound, catalog, budgetMs: 1000,
      target: { accountId: 20n, exec: { run: async (req: { args: string[] }) => {
        const custom = execPatch?.(req.args);
        if (custom) return custom;
        return spool(records).exec.run(req);
      } } } as never }, {
      writeMessage: async (id) => { writes++; return { version: 1 as const, ...id,
        bytes: 8, sha256: "e".repeat(64) }; },
      journal: { complete: async () => { throw new Error("not root"); },
        completeToolChain: async () => { completes++; },
        readRecoveryWinner: async () => null } as never });
    return { outcome, writes, completes };
  };
  const plain = await run([echo, ...finalBody]);
  assert.equal(plain.outcome.status, "committed");
  assert.equal(plain.writes, 1);
  assert.equal(plain.completes, 1);
  const prefixed = await run([{ type: "rate_limit_event" }, beat(native), echo, ...finalBody]);
  assert.equal(prefixed.outcome.status, "committed");
  assert.equal(prefixed.writes, 1);
  assert.equal(prefixed.completes, 1);
  for (const records of [
    [beat(outer), echo, ...finalBody],
    [beat(native, { parent_tool_use_id: "toolu_other", tool_use_id: "toolu_other-heartbeat-0" }),
      echo, ...finalBody],
    [beat(native, { tool_name: "mcp__ocbridge__t9" }), echo, ...finalBody],
    [beat(native)],
  ]) {
    const rejected = await run(records);
    assert.equal(rejected.outcome.status, "pending");
    assert.equal(rejected.writes, 0);
    assert.equal(rejected.completes, 0);
  }
  const unbound = await observeBoxToolTerminalOnly({
    evidence: { ...bound, priorToolUses: undefined, nativeSessionId: undefined },
    catalog, budgetMs: 1000,
    target: spool([beat(native), echo, ...finalBody]) as never }, {
    writeMessage: async () => { throw new Error("must not write"); },
    journal: { complete: async () => { throw new Error("must not complete"); },
      completeToolChain: async () => { throw new Error("must not complete"); },
      readRecoveryWinner: async () => null } as never });
  assert.deepEqual(unbound, { status: "pending", reason: "BOX_TOOL_RECORD_INVALID" });
  const noProof = await run([beat(native), echo, ...finalBody], (args) => {
    if (args[2]?.includes("terminal.json")) throw new Error("proof unread");
    return undefined;
  });
  assert.equal(noProof.outcome.status, "pending");
  assert.equal(noProof.writes, 0);
  assert.equal(noProof.completes, 0);
});

test("journal state committed with boxState handoff is not a terminal winner", async () => {
  const echo = { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: use.id, content: "ok" }] } };
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text: "ok" }], isError: false })).digest("hex");
  const outcome = await observeBoxToolTerminalOnly({
    evidence: { ...evidence, roundNo: 2, spoolOffset: 0,
      resultHashes: [{ modelToolUseId: use.id, contentHash: hash, isError: false }] },
    catalog, target: spool([echo, ...finalRecords.slice(1)]) as never }, {
    writeMessage: async (id) => ({ version: 1 as const, ...id, bytes: 8,
      sha256: "e".repeat(64) }),
    journal: {
      complete: async () => { throw new Error("not root"); },
      completeToolChain: async () => {
        throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
      },
      readRecoveryWinner: async () => ({ state: "committed", boxState: "handoff",
        proofReason: null }),
    } as never });
  assert.deepEqual(outcome, { status: "pending", reason: "BOX_TOOL_CHAIN_INVALID" });
});

test("terminal recovery bills the final message after a pre-model compact and rejects a mid-message insert", async () => {
  const session = "e37f0afa-e659-40ba-84e4-fa90bf465945";
  const anchor = "991406f8-0097-4e91-a2f1-b732812e36fe";
  const boundary = { type: "system", subtype: "compact_boundary",
    uuid: "adc44006-42e8-4ee0-92c6-6e9fc1412da8", session_id: session,
    compact_metadata: { trigger: "auto", pre_tokens: 1, post_tokens: 1,
      cumulative_dropped_tokens: 1, duration_ms: 1,
      preserved_segment: { head_uuid: "86b0b5b4-2fc6-40a3-a33c-3185d1655975",
        anchor_uuid: anchor, tail_uuid: "1216440c-7345-45a9-ba11-8262fd3450c3" },
      preserved_messages: { anchor_uuid: anchor,
        uuids: ["86b0b5b4-2fc6-40a3-a33c-3185d1655975", "1216440c-7345-45a9-ba11-8262fd3450c3"],
        all_uuids: ["86b0b5b4-2fc6-40a3-a33c-3185d1655975", "1216440c-7345-45a9-ba11-8262fd3450c3"] } } };
  const summary = { type: "user", isSynthetic: true, parent_tool_use_id: null, session_id: session,
    uuid: anchor, message: { role: "user", content: [{ type: "text", text: "kept" }] } };
  let usage: { inputTokens: number } | undefined;
  const outcome = await observeBoxToolTerminalOnly({
    evidence: { ...evidence, nativeSessionId: session }, catalog,
    target: spool([finalRecords[0], boundary, summary, ...finalRecords.slice(1)]) as never }, {
    writeMessage: async (id) => ({ version: 1 as const, ...id, bytes: 1, sha256: "e".repeat(64) }),
    journal: { complete: async (input: { usage: { inputTokens: number } }) => { usage = input.usage; },
      completeToolChain: async () => { throw new Error("root uses complete"); },
      readRecoveryWinner: async () => null } as never });
  assert.equal(outcome.status, "committed");
  assert.equal(usage?.inputTokens, 3);
  const mid = await observeBoxToolTerminalOnly({
    evidence: { ...evidence, nativeSessionId: session }, catalog,
    target: spool([finalRecords[0], finalRecords[1], boundary]) as never }, {
    writeMessage: async () => { throw new Error("must not write"); },
    journal: { complete: async () => { throw new Error("must not complete"); },
      completeToolChain: async () => { throw new Error("must not complete"); },
      readRecoveryWinner: async () => null } as never });
  assert.deepEqual(mid, { status: "pending", reason: "BOX_CLI_COMPACT_PHASE" });
});

// OCV5-313 (#1a28c670): only what the finished spool itself rules out is
// marked undeliverable; an infrastructure failure never is.
test("OCV5-313 a rejected result echo is undeliverable; infrastructure failures are not", async () => {
  const published = { modelToolUseId: "toolu_prior_a", isError: false,
    contentHash: "0".repeat(64) };
  const round2 = { ...evidence, roundNo: 2, resultHashes: [published],
    priorToolUses: undefined } as unknown as BoxDetachedUnknownRecovery;
  const echoed = { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_prior_a", content: "other bytes" }] } };
  const deps = { writeMessage: async () => { throw new Error("must not write"); },
    journal: { complete: async () => { throw new Error("must not complete"); },
      completeToolChain: async () => { throw new Error("must not complete"); },
      readRecoveryWinner: async () => null } as never };
  const target = spool([echoed, ...finalRecords.slice(1)]);
  const run = target.exec.run;
  target.exec.run = async (req: { args: string[] }) => {
    // The published result file is not readable here: hash-only evidence.
    if (req.args.some((arg) => arg.startsWith("toolu_"))) throw new Error("BOX_EXEC_REMOTE_EXIT");
    return run(req);
  };
  assert.deepEqual(await observeBoxToolTerminalOnly({ evidence: round2, catalog,
    target: target as never }, deps),
  { status: "pending", reason: "BOX_TOOL_ECHO_CONTENT_MISMATCH", undeliverable: true });
  // A first round never expects a user record before the model starts.
  assert.deepEqual(await observeBoxToolTerminalOnly({ evidence, catalog,
    target: spool([echoed, ...finalRecords.slice(1)]) as never }, deps),
  { status: "pending", reason: "BOX_RECOVERY_ECHO_UNEXPECTED", undeliverable: true });
  // Capsule write failure on a real final: stays plain pending.
  const capsule = await observeBoxToolTerminalOnly({ evidence, catalog,
    target: spool(finalRecords) as never }, { ...deps,
    writeMessage: async () => { throw new Error("disk full"); } });
  assert.deepEqual(capsule, { status: "pending", reason: "BOX_RECOVERY_CAPSULE_FAILED" });
  // A spool read that throws is infrastructure, not a verdict on the spool.
  const broken = { accountId: 20n, exec: { run: async () => { throw new Error("BOX_EXEC_TIMEOUT"); } } };
  const unread = await observeBoxToolTerminalOnly({ evidence, catalog, target: broken as never }, deps);
  assert.equal(unread.status, "pending");
  assert.equal("undeliverable" in unread, false);
});
