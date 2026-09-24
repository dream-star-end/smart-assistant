import test from "node:test";
import assert from "node:assert/strict";
import { BoxToolFetch } from "./boxToolFetch.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { ProxyBody } from "./shared.js";

const tools = [{ name: "local_echo", description: "synthetic",
  input_schema: { type: "object", properties: {} } }];
const firstBody: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, tools, messages: [{ role: "user", content: "first" }] };
const nextBody: ProxyBody = { ...firstBody, messages: [
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_A",
    name: "local_echo", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A",
    content: "local result" }] },
] };
const call = (canonicalBody: ProxyBody) => ({ uid: 3n, sessionId: "session",
  requestId: canonicalBody === firstBody ? "box-first" : "box-next",
  canonicalModel: canonicalBody.model, canonicalBody,
  upstreamModel: "claude-opus-5-5", url: BOX_INTERNAL_ENDPOINT,
  init: { method: "POST", body: JSON.stringify({ ...canonicalBody,
    model: "claude-opus-5-5" }) } });
const journal = () => ({ claimRemoteCleanup: async () => true,
  remoteCleanupStatus: async () => "pending",
  markRemoteCleaned: async () => {},
  listRemoteCleanupCandidates: async () => [] }) as never;

test("same internal model fetch streams first handoff then next final without tool execution", async () => {
  const calls: string[] = [];
  let disposed = false;
  const target = { accountId: 20n,
    exec: { run: async () => ({ stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const }) },
    dispose: async () => { disposed = true; } };
  const claim = { runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), accountId: 20n,
    spoolOffset: 1234, roundNo: 2 };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), journal: journal(),
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      calls.push("first"); input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "tool_handoff", plan: { runNonce: claim.runNonce }, target };
    }) as never,
    publishResume: (async () => { calls.push("claim-and-publish");
      return { claim, target, access: {} }; }) as never,
    runContinuation: (async (input: { emit: (sse: string) => void }) => {
      calls.push("continued-final");
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", proof: { runNonce: claim.runNonce,
        leaseEpoch: claim.leaseEpoch, keeperPid: 101, cliPid: 102,
        reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const first = await service.fetch(call(firstBody));
  assert.match(await first.text(), /event: message_stop/);
  assert.equal(disposed, false, "remote CLI remains owned across HTTP boundary");
  const second = await service.fetch(call(nextBody));
  assert.match(await second.text(), /event: message_stop/);
  assert.deepEqual(calls, ["first", "claim-and-publish", "continued-final"]);
  assert.equal(disposed, true, "local target closes only after terminal proof");
  assert.equal(await service.retryFailedCleanup(), 0);
});

test("failed local close retry is bounded and never starts concurrent dispose", async () => {
  let attempts = 0;
  const target = { accountId: 20n,
    exec: { run: async () => ({ stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const }) },
    dispose: () => {
    attempts++;
    if (attempts === 1) throw new Error("first close failed");
    return new Promise<void>(() => {});
  } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), journal: journal(),
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "a".repeat(24),
        leaseEpoch: "b".repeat(32) }, target,
        proof: { runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
          keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 1);
  const started = Date.now();
  assert.equal(await service.retryFailedCleanup(), 1);
  assert.ok(Date.now() - started < 800);
  assert.equal(attempts, 2);
  assert.equal(await service.retryFailedCleanup(), 1);
  assert.equal(attempts, 2, "unsettled close attempt is not duplicated");
});

test("terminal cleanup failure retains the pinned Box target for idempotent retry", async () => {
  let attempts = 0, disposed = false;
  const target = { accountId: 20n, exec: { run: async () => {
    attempts++;
    if (attempts === 1) throw new Error("synthetic cleanup transport failure");
    return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const };
  } }, dispose: async () => { disposed = true; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), journal: journal(),
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "b".repeat(24),
        leaseEpoch: "c".repeat(32) }, target,
        proof: { runNonce: "b".repeat(24), leaseEpoch: "c".repeat(32),
          keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  assert.match(await response.text(), /message_stop/);
  assert.equal(disposed, false);
  assert.equal(await service.retryTerminalCleanup(), 0);
  assert.equal(attempts, 2);
  assert.equal(disposed, true);
});

test("fresh egress instance recovers proven remote cleanup from durable journal", async () => {
  const candidate = { requestId: "box-proven", uid: 3n, accountId: 20n,
    runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
    proof: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
      keeperPid: 101, cliPid: 102, reason: "worker_complete" as const,
      revision: 1 as const } };
  let marked = false, disposed = false, cleans = 0;
  const target = { accountId: 20n, exec: { run: async () => {
    cleans++;
    return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const };
  } }, dispose: async () => { disposed = true; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { listRemoteCleanupCandidates: async () => marked ? [] : [candidate],
      claimRemoteCleanup: async () => true,
      remoteCleanupStatus: async () => marked ? "done" : "pending",
      markRemoteCleaned: async (value: typeof candidate) => {
        assert.deepEqual(value, candidate); marked = true;
      } } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async (args) => {
      assert.equal(args.requiredAccountId, 20n);
      return target as never;
    },
    onUnknown: async () => {},
  });
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  assert.equal(cleans, 1);
  assert.equal(marked, true);
  assert.equal(disposed, true);
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  assert.equal(cleans, 1, "already-cleaned remote run is not touched again");
});

test("worker that lost cleanup claim releases local target once peer marked exact proof done", async () => {
  let disposed = false, remoteCalls = 0;
  const target = { accountId: 20n,
    exec: { run: async () => { remoteCalls++; throw new Error("must not clean twice"); } },
    dispose: async () => { disposed = true; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { claimRemoteCleanup: async () => false,
      remoteCleanupStatus: async () => "done" } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "e".repeat(24),
        leaseEpoch: "f".repeat(32) }, target,
        proof: { runNonce: "e".repeat(24), leaseEpoch: "f".repeat(32),
          keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  assert.match(await response.text(), /message_stop/);
  assert.equal(remoteCalls, 0);
  assert.equal(disposed, true);
});
