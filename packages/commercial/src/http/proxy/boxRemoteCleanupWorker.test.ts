import test from "node:test";
import assert from "node:assert/strict";
import { BoxRemoteCleanupWorker } from "./boxRemoteCleanupWorker.js";

const candidate = { requestId: "box-final", uid: 3n, accountId: 20n,
  runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
  proof: { runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
    keeperPid: 101, cliPid: 102, reason: "worker_complete" as const,
    revision: 1 as const } };

test("shared leader cleans only claimed terminal proof and never launches CLI", async () => {
  const sequence: string[] = [];
  const target = { accountId: 20n, exec: { run: async (request: { args: string[];
    command: string }) => {
    sequence.push("remote-clean");
    assert.equal(request.command, "/usr/bin/python3");
    assert.equal(request.args.at(-1), candidate.runNonce);
    return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const };
  } }, dispose: async () => { sequence.push("dispose"); } };
  const worker = new BoxRemoteCleanupWorker({
    journal: { listRemoteCleanupCandidates: async () => [candidate],
      claimRemoteCleanup: async () => { sequence.push("claim"); return true; },
      markRemoteCleaned: async () => { sequence.push("done"); } } as never,
    resolver: { resolve: async (args: { requiredAccountId: bigint }) => {
      sequence.push("resolve"); assert.equal(args.requiredAccountId, 20n);
      return target as never;
    } } as never,
  });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 1, pending: 0, orphaned: 0 });
  assert.deepEqual(sequence, ["claim", "resolve", "remote-clean", "done", "dispose"]);
});

test("lost CAS claim never resolves a Box target or touches remote files", async () => {
  let resolves = 0;
  const worker = new BoxRemoteCleanupWorker({
    journal: { listRemoteCleanupCandidates: async () => [candidate],
      claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => { throw new Error("must not mark"); } } as never,
    resolver: { resolve: async () => { resolves++; throw new Error("must not resolve"); } } as never,
  });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.equal(resolves, 0);
});

test("flag-independent idle recovery performs only an empty journal read", async () => {
  let resolverCleanupRetries = 0;
  const worker = new BoxRemoteCleanupWorker({
    journal: { listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => { throw new Error("must not claim"); },
      markRemoteCleaned: async () => { throw new Error("must not mark"); } } as never,
    resolver: { resolve: async () => { throw new Error("must not contact Box"); },
      retryFailedAgentCleanup: async () => { resolverCleanupRetries++; return 0; } } as never,
  });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.equal(resolverCleanupRetries, 2,
    "failed resolver-owned ProxyAgents are retried even without Box candidates");
});

test("remote cleanup failure never marks done and keeps durable retry eligible", async () => {
  let marked = 0, disposed = 0;
  const worker = new BoxRemoteCleanupWorker({
    journal: { listRemoteCleanupCandidates: async () => [candidate],
      claimRemoteCleanup: async () => true,
      markRemoteCleaned: async () => { marked++; } } as never,
    resolver: { resolve: async () => ({ accountId: 20n,
      exec: { run: async () => { throw new Error("synthetic Box failure"); } },
      dispose: async () => { disposed++; } }) as never } as never,
  });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.equal(marked, 0);
  assert.equal(disposed, 1);
});
