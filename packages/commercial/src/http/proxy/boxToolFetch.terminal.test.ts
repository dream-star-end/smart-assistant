import test from "node:test";
import assert from "node:assert/strict";
import { BoxToolFetch } from "./boxToolFetch.js";
import { BoxSpoolTerminalError } from "./boxSpoolPoller.js";
import type { BoxTerminalProof } from "./boxTerminalProof.js";
import type { ProxyBody } from "./shared.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";

const firstBody = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
  tools: [{ name: "local_echo", description: "synthetic",
    input_schema: { type: "object", properties: {} } }],
  metadata: { user_id: JSON.stringify({ session_id: "terminal-session", oc_turn_key: "a".repeat(64) }) },
  messages: [{ role: "user", content: "synthetic" }] } as ProxyBody;
const continuation = { ...firstBody, messages: [
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_A", name: "local_echo", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "already executed" }] },
] } as ProxyBody;
const proof: BoxTerminalProof = { revision: 2, reason: "worker_failed", workerExitCode: 1,
  runNonce: "b".repeat(24), leaseEpoch: "c".repeat(32), keeperPid: 11, cliPid: 12 };

function fixture(linked: boolean, terminal: BoxTerminalProof, wrongAccount = false) {
  const calls: string[] = [];
  const target = { accountId: 20n, exec: { run: async () => {
    calls.push("cleanup"); return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const };
  } }, dispose: async () => { calls.push("dispose"); } };
  const journal = {
    markFirstRoundStoppedFailure: async () => { calls.push("first-failed"); },
    markFirstRoundRejectedStream: async () => { calls.push("first-rejected"); },
    markToolChainStoppedFailure: async (input: { rejectedStream?: boolean }) => {
      calls.push(input.rejectedStream ? "chain-rejected" : "chain-failed");
    },
    claimRemoteCleanup: async () => { calls.push("claim-cleanup"); return true; },
    markRemoteCleaned: async () => { calls.push("cleaned"); },
    remoteCleanupStatus: async () => "pending",
  };
  const claim = { accountId: target.accountId, runNonce: proof.runNonce,
    leaseEpoch: proof.leaseEpoch, roundNo: 2, spoolOffset: 100 };
  const fail = () => { throw new BoxSpoolTerminalError({ proof: terminal,
    accountId: wrongAccount ? 21n : target.accountId }); };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"), keeperAsset: Buffer.from("k"),
    virtualMcpAsset: Buffer.from("m"), detachedRunnerAsset: Buffer.from("d"), journal: journal as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => { throw new Error("must not resolve a new target"); },
    onUnknown: async () => { calls.push("unknown"); },
    stopRejectedRun: async () => { calls.push("stop"); return "stopped_proven"; },
    publishResume: (async () => { calls.push("existing-publish"); return { target, claim }; }) as never,
    runContinuation: (async () => fail()) as never,
    runFirst: (async (input: { onLaunchAck?: () => void }, deps: {
      retainUnknownTarget: (held: unknown) => void;
    }) => {
      calls.push("first-run");
      deps.retainUnknownTarget({ target, plan: { runNonce: proof.runNonce, leaseEpoch: proof.leaseEpoch } });
      input.onLaunchAck?.();
      return fail();
    }) as never,
  });
  const body = linked ? continuation : firstBody;
  const fetch = () => service.fetch({ uid: 4n, sessionId: "terminal-session", requestId: "terminal-leaf",
    canonicalModel: body.model, canonicalBody: body, upstreamModel: "claude-opus-5-5",
    url: BOX_INTERNAL_ENDPOINT, init: { method: "POST", body: JSON.stringify(body) } });
  return { calls, fetch };
}

for (const linked of [false, true]) {
  test(`proved failed ${linked ? "continuation" : "first"} run converges once without Stop or replay`, async () => {
    const f = fixture(linked, proof);
    await assert.rejects(async () => { const r = await f.fetch(); await r.text(); }, /BOX_SPOOL_WORKER_FAILED/);
    assert.equal(f.calls.filter((s) => s === (linked ? "chain-failed" : "first-failed")).length, 1);
    assert.equal(f.calls.filter((s) => s === "cleanup").length, 1);
    assert.equal(f.calls.filter((s) => s === "cleaned").length, 1);
    assert.ok(!f.calls.includes("stop") && !f.calls.includes("unknown"));
    assert.equal(f.calls.filter((s) => s === "first-run").length, linked ? 0 : 1);
  });
  test(`completed but undeliverable ${linked ? "continuation" : "first"} uses rejected-stream zero-fee path`, async () => {
    const complete: BoxTerminalProof = { runNonce: proof.runNonce, leaseEpoch: proof.leaseEpoch,
      revision: 1, reason: "worker_complete", keeperPid: 11, cliPid: 12 };
    const f = fixture(linked, complete);
    await assert.rejects(async () => { const r = await f.fetch(); await r.text(); }, /BOX_SPOOL_TERMINAL_INCOMPLETE/);
    assert.equal(f.calls.filter((s) => s === (linked ? "chain-rejected" : "first-rejected")).length, 1);
    assert.ok(!f.calls.includes("stop") && !f.calls.includes("unknown"));
  });
}

test("a terminal error for a different account cannot settle or clean the owned run", async () => {
  const f = fixture(false, proof, true);
  await assert.rejects(async () => { const r = await f.fetch(); await r.text(); }, /BOX_SPOOL_WORKER_FAILED/);
  assert.deepEqual(f.calls, ["first-run"]);
});
