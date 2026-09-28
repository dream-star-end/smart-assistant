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
  assert.deepEqual(outcome, { status: "pending", reason: "BOX_RECOVERY_INTERMEDIATE_HANDOFF" });
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
