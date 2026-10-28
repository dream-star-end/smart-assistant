import test from "node:test";
import assert from "node:assert/strict";
import { BoxRemoteCleanupWorker } from "./boxRemoteCleanupWorker.js";
import { BoxDurableJournalError } from "./boxDurableJournal.js";
import { BoxExecTransport } from "./boxExecTransport.js";

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
  phase: string;
  unknownForMs: number;
  linked?: boolean;
  intent?: boolean;
  stopStdout?: string | Error;
  proofAfterStop?: boolean;
}) {
  const sequence: string[] = [];
  const probe = { requestId: "box-resume-leaf", uid: 3n, accountId: 20n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch,
    linked: input.linked ?? true,
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
      markFirstRoundStoppedFailure: async ({ proof }: { proof: unknown }) => {
        if (probe.linked) throw new Error("wrong round");
        assert.deepEqual(proof, failedProof); sequence.push("first-round-CAS");
      },
      markToolChainStoppedFailure: async ({ proof }: { proof: unknown }) => {
        if (!probe.linked) throw new Error("wrong round");
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

// OCV5-313 (#1a28c670): a continuation_unknown leaf was outside the OCV5-323
// stop, so its CLI ran on alone for an hour while the probe only logged
// BOX_EXEC_REMOTE_EXIT. Every unknown phase of a launched run is now stopped.
test("OCV5-313 every unknown phase gets the timed stop; a rejected echo is stopped at once", async () => {
  const stopped = ["proof-read", "intent", "keeper-stop", "proof-read", "stopped-CAS", "dispose"];
  for (const phase of ["continuation_unknown", "first_round_unknown",
    "stage_transport_unknown:input_3:BOX_EXEC_TIMEOUT"]) {
    const early = staleResumeWorker({ phase, unknownForMs: 19 * 60_000 });
    assert.deepEqual(await early.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
    assert.deepEqual(early.sequence, ["proof-read", "dispose"], phase);
    const late = staleResumeWorker({ phase, unknownForMs: 21 * 60_000 });
    assert.deepEqual(await late.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
    assert.deepEqual(late.sequence, stopped, phase);
  }
  const young = staleResumeWorker({ phase: "continuation_echo_rejected", unknownForMs: 2_000 });
  assert.deepEqual(await young.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  const echo = staleResumeWorker({ phase: "continuation_echo_rejected", unknownForMs: 11_000 });
  assert.deepEqual(await echo.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(echo.sequence, stopped);
  // OCV5-328: a stream the handoff decoder rejected is as undeliverable.
  const fresh = staleResumeWorker({ phase: "continuation_stream_rejected", unknownForMs: 2_000 });
  assert.deepEqual(await fresh.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  const stream = staleResumeWorker({ phase: "continuation_stream_rejected", unknownForMs: 11_000 });
  assert.deepEqual(await stream.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(stream.sequence, stopped);
  // A launched first round closes through the first-round CAS.
  const first = staleResumeWorker({ phase: "first_round_unknown", unknownForMs: 21 * 60_000,
    linked: false });
  assert.deepEqual(await first.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(first.sequence, ["proof-read", "intent", "keeper-stop", "proof-read",
    "first-round-CAS", "dispose"]);
});

// OCV5-313: after its CLI finished by itself (worker_complete) #1a28c670 stayed
// unknown without a log line, because the recovery met the rejected echo again.
function provedSuccessWorker(input: { linked: boolean;
  outcome: { status: "committed" } | { status: "undeliverable" | "pending"; reason: string } }) {
  const sequence: string[] = [];
  const probe = { requestId: "box-finished-alone", uid: 3n, accountId: 25n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: input.linked };
  const worker = new BoxRemoteCleanupWorker({
    recoverProvedSuccess: async (seen) => {
      assert.equal(seen.requestId, probe.requestId); sequence.push("recover"); return input.outcome;
    },
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => true,
      markFirstRoundStoppedFailure: async () => { throw new Error("not a failure"); },
      markToolChainStoppedFailure: async (stop: { rejectedStream?: boolean;
        proof: { reason: string } }) => {
        assert.equal(stop.rejectedStream, true);
        assert.equal(stop.proof.reason, "worker_complete");
        sequence.push("rejected-stream-CAS");
      },
      markRunExpiredUnproven: async () => { throw new Error("a proven run is never unproven"); },
      listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => { throw new Error("must not clean"); } } as never,
    resolver: { resolve: async () => ({ accountId: 25n, exec: { run: async () => ({
      stdout: JSON.stringify(candidate.proof) + "\n", stderrBytes: 0, exitCode: 0 as const }) },
    dispose: async () => {} }) as never } as never,
  });
  return { worker, sequence };
}

test("OCV5-313 a finished run whose spool rules out a final closes only as a linked unbilled leaf", async () => {
  const echo = { status: "undeliverable" as const, reason: "BOX_TOOL_ECHO_CONTENT_MISMATCH" };
  const linked = provedSuccessWorker({ linked: true, outcome: echo });
  assert.deepEqual(await linked.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(linked.sequence, ["recover", "rejected-stream-CAS"]);
  // A first round stays held (success-recovery gate contract).
  const first = provedSuccessWorker({ linked: false, outcome: echo });
  assert.deepEqual(await first.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(first.sequence, ["recover"]);
  // Infrastructure outcomes are never settled, whatever their age.
  for (const reason of ["BOX_RECOVERY_CAPSULE_FAILED", "BOX_RECOVERY_CATALOG_UNREADABLE",
    "BOX_RECOVERY_PROOF_UNREAD", "BOX_RECOVERY_WRITER_MISSING"]) {
    const pending = provedSuccessWorker({ linked: true, outcome: { status: "pending", reason } });
    assert.deepEqual(await pending.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
    assert.deepEqual(pending.sequence, ["recover"], reason);
  }
  const committed = provedSuccessWorker({ linked: true, outcome: { status: "committed" } });
  assert.deepEqual(await committed.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(committed.sequence, ["recover"]);
});

// OCV5-312/313: rows pinned to disabled account 20 failed the pinned resolve
// forever (BOX_ACCOUNT_UNAVAILABLE every two minutes) and had no terminal state.
function expiredWorker(input: { expired: boolean; resolve: "unavailable" | "no-proof" | "proof";
  staleResume?: { phase: string; unknownForMs: number }; closeError?: Error }) {
  const sequence: string[] = [];
  const closes: unknown[] = [];
  const probe = { requestId: "box-pinned", uid: 3n, accountId: 20n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: true,
    ...(input.staleResume ? { staleResume: input.staleResume } : {}),
    ...(input.expired ? { expired: true } : {}) };
  const failedProof = { ...candidate.proof, reason: "keeper_stopped" as const };
  const worker = new BoxRemoteCleanupWorker({
    staleResumeProofWaitMs: 20,
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => true,
      recordStaleResumeStop: async () => { sequence.push("intent"); return true; },
      markFirstRoundStoppedFailure: async () => { throw new Error("wrong round"); },
      markToolChainStoppedFailure: async () => { sequence.push("stopped-CAS"); },
      markRunExpiredUnproven: async (close: unknown) => {
        closes.push(close); sequence.push("expired-close");
        if (input.closeError) throw input.closeError;
        return { action: "closed", shape: "unbilled_leaf", priorBoxState: "unknown", ancestors: 1 };
      },
      listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => { throw new Error("must not clean"); } } as never,
    resolver: { resolve: async () => {
      sequence.push("resolve");
      if (input.resolve === "unavailable") {
        throw Object.assign(new Error("BOX_ACCOUNT_UNAVAILABLE"), { code: "BOX_ACCOUNT_UNAVAILABLE" });
      }
      return { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
        if (request.args.at(-1)?.startsWith("/tmp/ocv5-289-proof-")) {
          sequence.push("proof-read");
          if (input.resolve === "proof") {
            return { stdout: JSON.stringify(failedProof) + "\n", stderrBytes: 0, exitCode: 0 };
          }
          throw Object.assign(new Error("BOX_EXEC_REMOTE_EXIT"), { code: "BOX_EXEC_REMOTE_EXIT" });
        }
        sequence.push("keeper-stop");
        throw Object.assign(new Error("BOX_EXEC_REMOTE_EXIT"), { code: "BOX_EXEC_REMOTE_EXIT" });
      } }, dispose: async () => { sequence.push("dispose"); } } as never;
    } } as never,
  });
  return { worker, sequence, closes, probe };
}

test("OCV5-313 an expired run on an unreachable account gets its terminal state", async () => {
  const f = expiredWorker({ expired: true, resolve: "unavailable" });
  assert.deepEqual(await f.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(f.sequence, ["resolve", "expired-close"]);
  assert.deepEqual(f.closes, [{ requestId: f.probe.requestId, uid: 3n, accountId: 20n,
    runNonce: f.probe.runNonce, leaseEpoch: f.probe.leaseEpoch, cause: "BOX_ACCOUNT_UNAVAILABLE" }]);
  // Not expired yet: the run may still be alive, nothing is closed.
  const young = expiredWorker({ expired: false, resolve: "unavailable" });
  assert.deepEqual(await young.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(young.sequence, ["resolve"]);
  // The journal's own fences decide; a refusal stays a pending probe.
  const refused = expiredWorker({ expired: true, resolve: "unavailable",
    closeError: new Error("BOX_EXPIRED_CLOSE_RUN_NOT_EXPIRED") });
  assert.deepEqual(await refused.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
});

test("OCV5-313 an expired run on a reachable Box is closed only when no proof can be had", async () => {
  // Unknown leaf: the keeper is asked to stop first; only then is it unproven.
  const leaf = expiredWorker({ expired: true, resolve: "no-proof",
    staleResume: { phase: "continuation_unknown", unknownForMs: 5 * 3_600_000 } });
  assert.deepEqual(await leaf.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(leaf.sequence, ["resolve", "proof-read", "intent", "keeper-stop",
    "expired-close", "dispose"]);
  assert.equal((leaf.closes[0] as { cause: string }).cause, "BOX_EXEC_REMOTE_EXIT");
  // A waiting handoff has no stop intent; it is closed on its age alone.
  const handoff = expiredWorker({ expired: true, resolve: "no-proof" });
  assert.deepEqual(await handoff.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(handoff.sequence, ["resolve", "proof-read", "expired-close", "dispose"]);
  // A readable proof always wins over expiry.
  const proven = expiredWorker({ expired: true, resolve: "proof" });
  assert.deepEqual(await proven.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(proven.sequence, ["resolve", "proof-read", "stopped-CAS", "dispose"]);
  assert.deepEqual(proven.closes, []);
  const young = expiredWorker({ expired: false, resolve: "no-proof" });
  assert.deepEqual(await young.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(young.closes, []);
});

// OCV5-488 (10-17 commercial account 79): three handoff leaves held their
// account for 78 min after their CLIs were gone. No proof could be read, the
// leaves were neither stale nor expired, so every probe stayed pending.
const BOOT = "0f2c5d1e-1111-4222-8333-444455556666";
function absentWorker(input: { looks: Array<string | Error>;
  prior?: { v: 1; atMs: number; boot: string }; closeError?: Error }) {
  const sequence: string[] = [];
  const closes: unknown[] = [];
  const released: unknown[] = [];
  let look = 0;
  let seen = input.prior ?? null;
  const probe = { requestId: "box-parked", uid: 3n, accountId: 79n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: false };
  const worker = new BoxRemoteCleanupWorker({
    holds: {
      recordRunAbsence: async (args: { boot: string; requestId: string }) => {
        assert.equal(args.requestId, probe.requestId);
        sequence.push("record");
        const prior = seen;
        if (!seen) seen = { v: 1, atMs: 1_792_000_000_000, boot: args.boot };
        return prior;
      },
      clearRunAbsence: async () => { sequence.push("clear"); seen = null; } } as never,
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => true,
      markFirstRoundStoppedFailure: async () => { throw new Error("no proof exists"); },
      markToolChainStoppedFailure: async () => { throw new Error("no proof exists"); },
      markRunExpiredUnproven: async (args: unknown) => {
        sequence.push("absent-close");
        closes.push(args);
        if (input.closeError) throw input.closeError;
        return { action: "closed", shape: "billed_handoff", priorBoxState: "handoff", ancestors: 0 };
      },
      listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => { throw new Error("must not clean"); } } as never,
    resolver: { resolve: async () => ({ accountId: 79n, exec: { run: async (request: { args: string[] }) => {
      if (request.args.at(-1)?.startsWith("/tmp/ocv5-289-proof-")) {
        sequence.push("proof-read");
        throw Object.assign(new Error("BOX_EXEC_REMOTE_EXIT"), { code: "BOX_EXEC_REMOTE_EXIT" });
      }
      assert.ok(request.args[2]?.includes("boot_id"), "only the read-only liveness probe runs");
      assert.equal(request.args[3], candidate.runNonce);
      sequence.push("look");
      const out = input.looks[look++] ?? "";
      if (out instanceof Error) throw out;
      return { stdout: out, stderrBytes: 0, exitCode: 0 };
    } }, dispose: async () => { sequence.push("dispose"); } }) as never } as never,
    onProcessAbsentClosed: (closed) => { released.push(closed); },
  });
  return { worker, sequence, closes, released, probe };
}

test("OCV5-488 a run seen gone on two looks is closed without waiting for its age", async () => {
  const f = absentWorker({ looks: [`absent ${BOOT}\n`, `absent ${BOOT}\n`] });
  // first look: recorded, still held
  assert.deepEqual(await f.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(f.sequence, ["proof-read", "look", "record", "dispose"]);
  assert.deepEqual(f.closes, []);
  // second look: the journal's own fences (a minute apart, billing settled) decide
  assert.deepEqual(await f.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(f.sequence.slice(4), ["proof-read", "look", "record", "absent-close", "dispose"]);
  assert.deepEqual(f.closes, [{ requestId: "box-parked", uid: 3n, accountId: 79n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch,
    cause: "box_process_absent", absence: { boot: BOOT } }]);
  assert.deepEqual(f.released, [{ requestId: "box-parked", accountId: 79n,
    shape: "billed_handoff", rebooted: false }]);
});

test("OCV5-488 a reboot between the looks confirms at once", async () => {
  const f = absentWorker({ prior: { v: 1, atMs: 1_792_000_000_000, boot: BOOT },
    looks: ["absent 9e8d7c6b-0000-4000-8000-000000000001\n"] });
  assert.deepEqual(await f.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(f.released, [{ requestId: "box-parked", accountId: 79n,
    shape: "billed_handoff", rebooted: true }]);
});

test("OCV5-488 alive clears the earlier look; terminal, unreadable or malformed looks prove nothing", async () => {
  const alive = absentWorker({ prior: { v: 1, atMs: 1, boot: BOOT }, looks: [`alive ${BOOT}\n`] });
  assert.deepEqual(await alive.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(alive.sequence, ["proof-read", "look", "clear", "dispose"]);
  for (const out of [`terminal ${BOOT}\n`, new Error("BOX_EXEC_REMOTE_EXIT"), "absent\n", `absent ${BOOT}\nalive ${BOOT}\n`]) {
    const f = absentWorker({ prior: { v: 1, atMs: 1, boot: BOOT }, looks: [out] });
    assert.deepEqual(await f.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
    assert.deepEqual(f.sequence, ["proof-read", "look", "dispose"], String(out));
    assert.deepEqual(f.closes, []);
  }
});

test("OCV5-488 the journal's refusal keeps the run pending and releases nothing", async () => {
  for (const code of ["BOX_ABSENT_CLOSE_NOT_CONFIRMED", "BOX_ABSENT_CLOSE_BILLING_UNSETTLED",
    "BOX_EXPIRED_CLOSE_CHAIN_INVALID"]) {
    const f = absentWorker({ prior: { v: 1, atMs: 1, boot: BOOT }, looks: [`absent ${BOOT}\n`],
      closeError: new BoxDurableJournalError(code) });
    assert.deepEqual(await f.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 }, code);
    assert.deepEqual(f.released, [], code);
  }
});

// OCV5-649 (10-28 commercial uid 4, account 79): the look passed a response
// cap the real transport refuses before sending, so closeAbsent never closed a
// run in production and a gone run held its session for the full 4h15m.
test("OCV5-649 the liveness look passes the real transport argument check", async () => {
  const sequence: string[] = [];
  const frame = (value: unknown, flag = 0): Buffer => {
    const raw = Buffer.from(JSON.stringify(value));
    const out = Buffer.alloc(5 + raw.length);
    out[0] = flag;
    out.writeUInt32BE(raw.length, 1);
    raw.copy(out, 5);
    return out;
  };
  const reply = (...parts: Buffer[]): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.concat(parts)); controller.close(); } }), { status: 200 });
  const exec = new BoxExecTransport({ execUrl: "https://box.example.test/connect.exec.v1.ExecService/Exec",
    execToken: "synthetic-exec", networkToken: "synthetic-network" }, async (_url, init) => {
    const args = (JSON.parse(Buffer.from(init.body as Uint8Array).subarray(5).toString("utf8")) as
      { args: string[] }).args;
    if (args.at(-1)?.startsWith("/tmp/ocv5-289-proof-")) {
      sequence.push("proof-read");
      return reply(frame({ exitEvent: { exitCode: 1 } }), frame({}, 2));
    }
    sequence.push("look");
    return reply(frame({ stdoutEvent: { data: `absent ${BOOT}\n` } }), frame({ exitEvent: {} }), frame({}, 2));
  }, async () => {});
  const probe = { requestId: "box-gone", uid: 4n, accountId: 79n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: false };
  const worker = new BoxRemoteCleanupWorker({
    holds: { recordRunAbsence: async () => { sequence.push("record"); return null; },
      clearRunAbsence: async () => { sequence.push("clear"); } } as never,
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => true,
      markFirstRoundStoppedFailure: async () => { throw new Error("no proof exists"); },
      markToolChainStoppedFailure: async () => { throw new Error("no proof exists"); },
      markRunExpiredUnproven: async () => { throw new Error("first look only records"); },
      listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => { throw new Error("must not clean"); } } as never,
    resolver: { resolve: async () => ({ accountId: 79n, exec,
      dispose: async () => { sequence.push("dispose"); } }) as never } as never,
  });
  assert.deepEqual(await worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(sequence, ["proof-read", "look", "record", "dispose"]);
});

// OCV5-488 (10-17 commercial uid 4): its container was rebuilt at 07:53 while
// three of its turns' CLIs stayed parked on their handoffs; nothing could
// answer them any more and nothing stopped them.
function abandonedWorker(input: { abandoned: boolean; intent?: boolean }) {
  const sequence: string[] = [];
  const probe = { requestId: "box-abandoned", uid: 4n, accountId: 79n,
    runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch, linked: false,
    ...(input.abandoned ? { abandonedHandoff: true as const } : {}) };
  const stoppedProof = { ...candidate.proof, reason: "keeper_stopped" as const };
  let stopped = false;
  const worker = new BoxRemoteCleanupWorker({
    staleResumeProofWaitMs: 50,
    holds: { recordAbandonedHandoffStop: async (args: { requestId: string }) => {
      assert.equal(args.requestId, probe.requestId);
      sequence.push("intent"); return input.intent ?? true;
    } } as never,
    journal: { listStoppedFailureProbeCandidates: async () => [probe],
      claimStoppedFailureProbe: async () => true,
      markFirstRoundStoppedFailure: async ({ proof }: { proof: unknown }) => {
        assert.deepEqual(proof, stoppedProof); sequence.push("first-round-CAS");
      },
      markToolChainStoppedFailure: async () => { throw new Error("wrong round"); },
      listRemoteCleanupCandidates: async () => [],
      claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => { throw new Error("must not clean"); } } as never,
    resolver: { resolve: async () => ({ accountId: 79n, exec: { run: async (request: { args: string[] }) => {
      if (request.args.at(-1)?.startsWith("/tmp/ocv5-289-proof-")) {
        sequence.push("proof-read");
        if (!stopped) throw Object.assign(new Error("BOX_EXEC_REMOTE_EXIT"), { code: "BOX_EXEC_REMOTE_EXIT" });
        return { stdout: `${JSON.stringify(stoppedProof)}\n`, stderrBytes: 0, exitCode: 0 };
      }
      assert.deepEqual(request.args.slice(-2), [candidate.runNonce, candidate.leaseEpoch],
        "stop is bound to the original nonce/epoch keeper");
      sequence.push("keeper-stop");
      stopped = true;
      return { stdout: "stop-requested\n", stderrBytes: 0, exitCode: 0 };
    } }, dispose: async () => { sequence.push("dispose"); } }) as never } as never,
  });
  return { worker, sequence };
}

test("OCV5-488 a handoff whose container is gone: intent, keeper stop, proof, then the existing CAS", async () => {
  const f = abandonedWorker({ abandoned: true });
  assert.deepEqual(await f.worker.reconcileBatch(), { cleaned: 0, pending: 0, orphaned: 0 });
  assert.deepEqual(f.sequence, ["proof-read", "intent", "keeper-stop", "proof-read",
    "first-round-CAS", "dispose"]);
});

test("OCV5-488 a handoff in the active container is never stopped, however long its tools run", async () => {
  const f = abandonedWorker({ abandoned: false });
  assert.deepEqual(await f.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(f.sequence, ["proof-read", "dispose"]);
  // the container came back between listing and the intent: no signal is sent
  const raced = abandonedWorker({ abandoned: true, intent: false });
  assert.deepEqual(await raced.worker.reconcileBatch(), { cleaned: 0, pending: 1, orphaned: 0 });
  assert.deepEqual(raced.sequence, ["proof-read", "intent", "dispose"]);
});
