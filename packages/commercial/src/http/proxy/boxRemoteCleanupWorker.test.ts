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
    assert.deepEqual(request.args.slice(-2), [candidate.runNonce, "0"]);
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

test("restart worker proves a stopped linked failure before cleaning private files", async () => {
  const sequence: string[] = [];
  const probe = { requestId: "box-linked", uid: 3n, accountId: 20n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: true };
  const failedProof = { ...candidate.proof, reason: "worker_failed" as const,
    revision: 2 as const, workerExitCode: 7 };
  let stopped = false;
  const worker = new BoxRemoteCleanupWorker({
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => { sequence.push("probe-claim"); return true; },
      markFirstRoundStoppedFailure: async () => { throw new Error("wrong round"); },
      markToolChainStoppedFailure: async ({ proof }: { proof: unknown }) => {
        assert.deepEqual(proof, failedProof); sequence.push("stopped-CAS"); stopped = true;
      },
      listRemoteCleanupCandidates: async () => stopped ? [{ ...candidate,
        requestId: probe.requestId, proof: failedProof }] : [],
      claimRemoteCleanup: async () => { sequence.push("clean-claim"); return true; },
      markRemoteCleaned: async () => { sequence.push("clean-done"); } } as never,
    resolver: { resolve: async () => ({ accountId: 20n,
      exec: { run: async (request: { args: string[] }) => {
        if (request.args.at(-1)?.startsWith("/tmp/ocv5-289-proof-")) {
          sequence.push("proof-read");
          return { stdout: JSON.stringify(failedProof) + "\n", stderrBytes: 0, exitCode: 0 };
        }
        sequence.push("remote-clean");
        return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 };
      } }, dispose: async () => { sequence.push("dispose"); } }) as never } as never,
  });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 1, pending: 0, orphaned: 0 });
  assert.deepEqual(sequence, ["probe-claim", "proof-read", "stopped-CAS", "dispose",
    "clean-claim", "remote-clean", "clean-done", "dispose"]);
});

test("worker_complete without a recovery writer stays pending and does not complete", async () => {
  let completes = 0;
  const probe = { requestId: "box-success", uid: 3n, accountId: 20n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: false };
  const worker = new BoxRemoteCleanupWorker({
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => true,
      markFirstRoundStoppedFailure: async () => { throw new Error("not a failure"); },
      markToolChainStoppedFailure: async () => { throw new Error("not a failure"); },
      readDetachedUnknownRecovery: async () => { throw new Error("must not read"); },
      complete: async () => { completes++; },
      listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => { throw new Error("must not clean"); } } as never,
    resolver: { resolve: async (args: { allowWakeIfHibernated?: boolean }) => {
      assert.equal(args.allowWakeIfHibernated, false);
      return { accountId: 20n, exec: { run: async () => ({ stdout: JSON.stringify({
        runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch,
        keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 }) + "\n",
      stderrBytes: 0, exitCode: 0 as const }) }, dispose: async () => {} } as never;
    } } as never,
  });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.equal(completes, 0);
});

test("cleanup retries after the first remote failure and marks done once", async () => {
  let attempts = 0, marked = 0;
  const worker = new BoxRemoteCleanupWorker({
    journal: { listRemoteCleanupCandidates: async () => [candidate],
      claimRemoteCleanup: async () => true,
      markRemoteCleaned: async () => { marked++; },
      listStoppedFailureProbeCandidates: async () => [] } as never,
    resolver: { resolve: async () => ({ accountId: 20n,
      exec: { run: async () => {
        attempts++;
        if (attempts === 1) throw new Error("synthetic first cleanup failure");
        return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const };
      } }, dispose: async () => {} }) as never } as never,
  });
  assert.equal((await worker.reconcileBatch()).cleaned, 0);
  assert.equal(marked, 0);
  assert.equal((await worker.reconcileBatch()).cleaned, 1);
  assert.equal(marked, 1);
  assert.equal(attempts, 2);
});

test("capsule or CAS failure does not run remote cleanup", async () => {
  const remote = `/tmp/ocv5-289-run-${candidate.runNonce}`;
  const { mkdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
  mkdirSync(remote, { mode: 0o700 });
  writeFileSync(`${remote}/tool-catalog.json`, "{\"tools\":[]}");
  let cleans = 0;
  try {
    const probe = { requestId: "box-keep", uid: 3n, accountId: 20n,
      runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: true };
    const worker = new BoxRemoteCleanupWorker({
      journal: { listStoppedFailureProbeCandidates: async () => [probe],
        claimStoppedFailureProbe: async () => true,
        markFirstRoundStoppedFailure: async () => { throw new Error("not a failure"); },
        markToolChainStoppedFailure: async () => { throw new Error("not a failure"); },
        readDetachedUnknownRecovery: async () => ({ ok: false,
          reason: "BOX_RECOVERY_REVISION_MISMATCH" }),
        listRemoteCleanupCandidates: async () => [],
        claimRemoteCleanup: async () => { cleans++; return true; },
        markRemoteCleaned: async () => { cleans++; } } as never,
      writeRecoveryMessage: async () => { throw new Error("capsule failed"); },
      resolver: { resolve: async () => ({ accountId: 20n,
        exec: { run: async (req: { args: string[] }) => {
          if (req.args.some((arg) => arg.includes("tool-catalog") || arg.includes("cleanup"))) {
            cleans++;
          }
          return { stdout: JSON.stringify({ runNonce: candidate.runNonce,
            leaseEpoch: candidate.leaseEpoch, keeperPid: 101, cliPid: 102,
            reason: "worker_complete", revision: 1 }) + "\n",
          stderrBytes: 0, exitCode: 0 as const };
        } }, dispose: async () => {} }) as never } as never,
    });
    assert.equal((await worker.reconcileBatch()).pending, 1);
    assert.equal(cleans, 0);
    assert.equal(existsSync(`${remote}/tool-catalog.json`), true);
  } finally { rmSync(remote, { recursive: true, force: true }); }
});

test("missing terminal marker leaves unknown Box run fenced and never cleans", async () => {
  let stopped = 0, cleaned = 0;
  const probe = { requestId: "box-unknown", uid: 3n, accountId: 20n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: false };
  const worker = new BoxRemoteCleanupWorker({
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => true,
      markFirstRoundStoppedFailure: async () => { stopped++; },
      markToolChainStoppedFailure: async () => { stopped++; },
      listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => { cleaned++; return true; },
      markRemoteCleaned: async () => { cleaned++; } } as never,
    resolver: { resolve: async () => ({ accountId: 20n,
      exec: { run: async () => { throw new Error("terminal.json absent"); } },
      dispose: async () => {} }) as never } as never,
  });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.equal(stopped, 0);
  assert.equal(cleaned, 0);
});

// OCV5-323 (#webmusk512gnvx22z): a resume publish whose Box target never
// resolved left the CLI waiting for tool results nobody would publish. The
// run held the session's Box slot and its idle proof for the 4 h deadline.
function staleResumeWorker(input: {
  phase: "resume_publish_unsent" | "resume_publish_unknown";
  unknownForMs: number;
  intent?: boolean;
  stopStdout?: string | Error;
  proofAfterStop?: boolean;
}) {
  const sequence: string[] = [];
  const probe = { requestId: "box-resume-leaf", uid: 3n, accountId: 20n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: true,
    staleResume: { phase: input.phase, unknownForMs: input.unknownForMs } };
  const failedProof = { ...candidate.proof, reason: "worker_failed" as const,
    revision: 2 as const, workerExitCode: 143 };
  let stopped = false;
  const worker = new BoxRemoteCleanupWorker({
    staleResumeProofWaitMs: 50,
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => true,
      recordStaleResumeStop: async (args: { phase: string; requestId: string }) => {
        assert.equal(args.phase, input.phase);
        assert.equal(args.requestId, probe.requestId);
        sequence.push("intent"); return input.intent ?? true;
      },
      markFirstRoundStoppedFailure: async () => { throw new Error("wrong round"); },
      markToolChainStoppedFailure: async ({ proof }: { proof: unknown }) => {
        assert.deepEqual(proof, failedProof); sequence.push("stopped-CAS");
      },
      listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => { throw new Error("must not clean"); } } as never,
    resolver: { resolve: async (args: { allowWakeIfHibernated?: boolean }) => {
      assert.equal(args.allowWakeIfHibernated, false);
      return { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
        if (request.args.at(-1)?.startsWith("/tmp/ocv5-289-proof-")) {
          sequence.push("proof-read");
          if (!stopped || input.proofAfterStop === false) {
            throw Object.assign(new Error("BOX_EXEC_REMOTE_EXIT"), { code: "BOX_EXEC_REMOTE_EXIT" });
          }
          return { stdout: JSON.stringify(failedProof) + "\n", stderrBytes: 0, exitCode: 0 };
        }
        assert.deepEqual(request.args.slice(-2), [candidate.runNonce, candidate.leaseEpoch],
          "stop is bound to the original nonce/epoch keeper");
        sequence.push("keeper-stop");
        const out = input.stopStdout ?? "stop-requested\n";
        if (out instanceof Error) throw out;
        stopped = true;
        return { stdout: out, stderrBytes: 0, exitCode: 0 };
      } }, dispose: async () => { sequence.push("dispose"); } } as never;
    } } as never,
  });
  return { worker, sequence };
}

test("unsent resume leaf: intent, keeper stop, proof, then the existing chain CAS", async () => {
  const { worker, sequence } = staleResumeWorker({ phase: "resume_publish_unsent",
    unknownForMs: 20_000 });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(sequence, ["proof-read", "intent", "keeper-stop", "proof-read",
    "stopped-CAS", "dispose"]);
});

test("unsent resume leaf younger than the grace stays a plain pending probe", async () => {
  const { worker, sequence } = staleResumeWorker({ phase: "resume_publish_unsent",
    unknownForMs: 2_000 });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(sequence, ["proof-read", "dispose"]);
});

test("possibly published resume leaf is left alone for 20 minutes, then stopped", async () => {
  const early = staleResumeWorker({ phase: "resume_publish_unknown", unknownForMs: 19 * 60_000 });
  assert.deepEqual(await early.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(early.sequence, ["proof-read", "dispose"]);
  const late = staleResumeWorker({ phase: "resume_publish_unknown", unknownForMs: 21 * 60_000 });
  assert.deepEqual(await late.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(late.sequence, ["proof-read", "intent", "keeper-stop", "proof-read",
    "stopped-CAS", "dispose"]);
});

test("lost stop intent CAS never signals the keeper", async () => {
  const { worker, sequence } = staleResumeWorker({ phase: "resume_publish_unsent",
    unknownForMs: 60_000, intent: false });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(sequence, ["proof-read", "intent", "dispose"]);
});

test("a stop that cannot reach the keeper is not evidence and closes nothing", async () => {
  const { worker, sequence } = staleResumeWorker({ phase: "resume_publish_unsent",
    unknownForMs: 60_000,
    stopStdout: Object.assign(new Error("BOX_EXEC_REMOTE_EXIT"), { code: "BOX_EXEC_REMOTE_EXIT" }) });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(sequence, ["proof-read", "intent", "keeper-stop", "dispose"]);
});

test("a requested stop without a proof inside the wait stays pending", async () => {
  const { worker, sequence } = staleResumeWorker({ phase: "resume_publish_unsent",
    unknownForMs: 60_000, proofAfterStop: false });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.equal(sequence.includes("stopped-CAS"), false);
  assert.equal(sequence.filter((step) => step === "keeper-stop").length, 1);
});
