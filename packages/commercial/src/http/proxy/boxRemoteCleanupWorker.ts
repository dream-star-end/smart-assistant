/** Shared-leader, flag-independent Box privacy cleanup recovery. Only a
 * terminal-proof journal candidate may reach remote Exec; no CLI launch,
 * tool publication or paid retry exists in this worker. */
import { BOX_API_RESOLVE_MODEL } from "./boxApiResolveModel.js";
import type { BoxAccountResolver } from "./boxAccountResolver.js";
import type { BoxDurableJournal, BoxRemoteCleanupCandidate, BoxStaleResumePhase,
  BoxStoppedFailureProbeCandidate } from "./boxDurableJournal.js";
import { isBoxExpiredCloseCause } from "./boxExpiredClose.js";
import { makeBoxKeeperStop } from "./boxKeeperStop.js";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";
import { readBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";
import { readBoxStagedToolCatalog } from "./boxStagedCatalogRead.js";
import { rehydrateBoxToolCatalog } from "./boxToolCatalog.js";
import { observeBoxToolTerminalOnly } from "./boxToolTerminalRecovery.js";
import type { BoxReplayMessageWriter } from "./boxReplayMessageFile.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import { rootLogger } from "../../logging/logger.js";

const workerLog = rootLogger.child({ subsys: "box-cleanup-worker" });

/** OCV5-322: content-free reason why a stop probe stayed pending. */
function probeFailureTag(error: unknown): { reason: string; cause?: string } {
  if (!(error instanceof Error)) return { reason: "non_error" };
  const code = (error as { code?: unknown }).code;
  const causeTag = (error as { causeTag?: unknown }).causeTag;
  const reason = typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code
    : /^[A-Z0-9_]{1,64}$/.test(error.message) ? error.message
    : error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 48) || "error";
  return typeof causeTag === "string" ? { reason, cause: causeTag.slice(0, 120) } : { reason };
}

/** OCV5-323: a resume leaf goes unknown when its publish failed. No request
 * ever re-publishes those tool results, so the CLI waits until the 4 h
 * supervisor deadline while the run holds the session's Box slot and the idle
 * proof (IDLE_HISTORY_PENDING, 「消息未开始处理」). `unsent` (the target never
 * resolved, nothing reached the run) is stopped at once. Plain `unknown` may
 * have published every result, so it gets time to finish by itself first.
 * OCV5-313: the same holds for every unknown phase of a launched run, linked
 * or first round (#1a28c670: a continuation_unknown leaf ran on alone for an
 * hour). A rejected result echo is stopped at once: its request already failed
 * and whatever the CLI writes next can reach nobody. OCV5-328: so is a stream
 * the handoff decoder rejected (#27da48a8). */
const STALE_UNKNOWN_STOP_AFTER_MS = 20 * 60_000;
const STALE_UNKNOWN_FAST_STOP_AFTER_MS = 10_000;
const STALE_UNKNOWN_FAST_PHASES: ReadonlySet<string> = new Set(
  ["resume_publish_unsent", "continuation_echo_rejected", "continuation_stream_rejected"]);

function staleResumeDue(candidate: BoxStoppedFailureProbeCandidate): BoxStaleResumePhase | null {
  const stale = candidate.staleResume;
  if (!stale) return null;
  return stale.unknownForMs >= (STALE_UNKNOWN_FAST_PHASES.has(stale.phase)
    ? STALE_UNKNOWN_FAST_STOP_AFTER_MS : STALE_UNKNOWN_STOP_AFTER_MS) ? stale.phase : null;
}

export type ProvedSuccess = { status: "committed" }
  | { status: "undeliverable" | "pending"; reason: string };

type Journal = Pick<BoxDurableJournal, "listRemoteCleanupCandidates" |
  "claimRemoteCleanup" | "markRemoteCleaned"> & Partial<Pick<BoxDurableJournal,
    "listStoppedFailureProbeCandidates" | "claimStoppedFailureProbe" |
    "markFirstRoundStoppedFailure" | "markToolChainStoppedFailure" |
    "readDetachedUnknownRecovery" | "complete" | "completeToolChain" |
    "readRecoveryWinner" | "recordStaleResumeStop" | "markRunExpiredUnproven">>;
type Resolver = Pick<BoxAccountResolver, "resolve"> &
  Partial<Pick<BoxAccountResolver, "retryFailedAgentCleanup">>;

export class BoxRemoteCleanupWorker {
  private readonly orphaned = new Map<BoxResolvedTarget,
    { pending: Promise<void> | null; failed: boolean }>();
  constructor(private readonly deps: { journal: Journal; resolver: Resolver;
    writeRecoveryMessage?: BoxReplayMessageWriter;
    /** How long to re-read the proof after a stale-resume stop. */
    staleResumeProofWaitMs?: number;
    /** Test seam for the worker_complete recovery below. */
    recoverProvedSuccess?: (candidate: BoxStoppedFailureProbeCandidate,
      target: BoxResolvedTarget) => Promise<ProvedSuccess> }) {}

  private async resolvePinned(candidate: Pick<BoxRemoteCleanupCandidate,
    "uid" | "requestId" | "accountId">): Promise<BoxResolvedTarget> {
    const abort = new AbortController();
    const pending = this.deps.resolver.resolve({ uid: candidate.uid,
      sessionId: null, requestId: candidate.requestId,
      upstreamModel: BOX_API_RESOLVE_MODEL, requiredAccountId: candidate.accountId,
      allowWakeIfHibernated: false, signal: abort.signal });
    let abandoned = false;
    let completed: BoxResolvedTarget | null = null;
    void pending.then((target) => {
      completed = target;
      if (abandoned) void this.closeLocal(target).catch(() => {});
    }, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort(); reject(new Error("BOX_CLEANUP_RESOLVE_TIMEOUT"));
        }, 30_000);
      })]);
    } catch (error) {
      abandoned = true;
      if (completed) void this.closeLocal(completed).catch(() => {});
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  private async closeLocal(target: BoxResolvedTarget): Promise<void> {
    const state = this.orphaned.get(target) ?? { pending: null, failed: false };
    this.orphaned.set(target, state);
    if (state.pending) return;
    const pending = Promise.resolve().then(() => target.dispose?.()).then(() => {
      this.orphaned.delete(target);
    }, () => { state.failed = true; });
    state.pending = pending;
    void pending.finally(() => {
      if (state.pending === pending) state.pending = null;
    }).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([pending, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 200);
    })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  /** A read-only probe can close only a failure that the keeper proved
   * stopped. Missing/ambiguous proof is left unknown, never paid-replayed. */
  async reconcileStoppedFailures(limit = 10): Promise<{ recovered: number; pending: number }> {
    const journal = this.deps.journal;
    if (!journal.listStoppedFailureProbeCandidates || !journal.claimStoppedFailureProbe
      || !journal.markFirstRoundStoppedFailure || !journal.markToolChainStoppedFailure) {
      return { recovered: 0, pending: 0 };
    }
    const candidates = await journal.listStoppedFailureProbeCandidates(limit);
    let recovered = 0, pending = 0;
    for (const candidate of candidates) {
      let target: BoxResolvedTarget | null = null;
      try {
        if (!await journal.claimStoppedFailureProbe(candidate)) continue;
        try { target = await this.resolvePinned(candidate); }
        catch (error) {
          // OCV5-313: a disabled or unreachable account never yields a proof.
          if (!await this.closeExpired(candidate, error)) throw error;
          recovered++;
          continue;
        }
        if (target.accountId !== candidate.accountId) throw new Error("BOX_STOP_PROBE_ACCOUNT_MISMATCH");
        let proof: BoxTerminalProof;
        try {
          try { proof = await this.readProof(candidate, target); }
          catch (error) {
            const phase = staleResumeDue(candidate);
            if (!phase) throw error;
            proof = await this.stopStaleResume(candidate, target, phase, error);
          }
        } catch (error) {
          // The proof files are gone and no keeper answered the stop.
          if (!await this.closeExpired(candidate, error)) throw error;
          recovered++;
          continue;
        }
        if (proof.reason === "worker_complete") {
          const outcome = await (this.deps.recoverProvedSuccess
            ?? ((probe, pinned) => this.recoverProvedSuccess(probe, pinned)))(candidate, target);
          if (outcome.status === "undeliverable" && candidate.linked) {
            // OCV5-306: a linked final round whose CLI finished on its own with
            // a tool call no client ever received. Abort only that unbilled
            // final row instead of pinning the session. A first round with an
            // intermediate handoff stays held (success-recovery gate contract).
            // OCV5-313: likewise when the finished spool holds a rejected
            // result echo or a malformed record: no final can come of it.
            await journal.markToolChainStoppedFailure({ requestId: candidate.requestId,
              uid: candidate.uid, leaseEpoch: candidate.leaseEpoch, proof, rejectedStream: true });
            recovered++;
          } else if (outcome.status !== "committed") {
            pending++;
            workerLog.warn("box_stop_probe_pending", { requestId: candidate.requestId,
              accountId: candidate.accountId.toString(), reason: outcome.reason });
          }
          continue;
        }
        const stop = { requestId: candidate.requestId, uid: candidate.uid,
          leaseEpoch: candidate.leaseEpoch, proof };
        if (candidate.linked) await journal.markToolChainStoppedFailure(stop);
        else await journal.markFirstRoundStoppedFailure(stop);
        recovered++;
      } catch (error) {
        pending++;
        // OCV5-322: a probe that can never resolve held a session for hours
        // without a trace; every retry (2 min apart) now says why.
        workerLog.warn("box_stop_probe_pending", { requestId: candidate.requestId,
          accountId: candidate.accountId.toString(), ...probeFailureTag(error) });
      }
      finally { if (target) await this.closeLocal(target); }
    }
    return { recovered, pending };
  }

  /** OCV5-313: only for a run past BOX_RUN_EXPIRED_AFTER_MS whose proof could
   * not be read. The journal re-checks age, identity and every chain fence. */
  private async closeExpired(candidate: BoxStoppedFailureProbeCandidate,
    error: unknown): Promise<boolean> {
    const close = this.deps.journal.markRunExpiredUnproven;
    if (candidate.expired !== true || !close) return false;
    const tag = probeFailureTag(error).reason;
    const cause = isBoxExpiredCloseCause(tag) ? tag : "unreadable";
    const closed = await close.call(this.deps.journal, { requestId: candidate.requestId,
      uid: candidate.uid, accountId: candidate.accountId, runNonce: candidate.runNonce,
      leaseEpoch: candidate.leaseEpoch, cause });
    workerLog.warn("box_run_expired_unproven", { requestId: candidate.requestId,
      accountId: candidate.accountId.toString(), cause, shape: closed.shape,
      ancestors: closed.ancestors });
    return true;
  }

  private async readProof(candidate: BoxStoppedFailureProbeCandidate,
    target: BoxResolvedTarget): Promise<BoxTerminalProof> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        readBoxTerminalProof({ target, expectedAccountId: candidate.accountId,
          runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch,
          signal: abort.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abort.abort();
            reject(new Error("BOX_STOP_PROBE_TIMEOUT")); }, 11_000);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** OCV5-323: journal the intent, ask the original nonce/epoch-bound keeper
   * to stop, then wait briefly for its own terminal proof. The stop is never
   * evidence; without a proof the row stays pending exactly as before. */
  private async stopStaleResume(candidate: BoxStoppedFailureProbeCandidate,
    target: BoxResolvedTarget, phase: BoxStaleResumePhase,
    readError: unknown): Promise<BoxTerminalProof> {
    const record = this.deps.journal.recordStaleResumeStop;
    if (!record || !await record.call(this.deps.journal, { ...candidate, phase })) throw readError;
    let outcome: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        target.exec.run(makeBoxKeeperStop(candidate.runNonce, candidate.leaseEpoch),
          { timeoutMs: 10_000, maxResponseBytes: 1024 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("BOX_STALE_RESUME_STOP_TIMEOUT")), 10_500);
        }),
      ]);
      outcome = /^[a-z-]{1,32}$/.test(result.stdout.trim()) ? result.stdout.trim() : "unexpected";
    } catch (error) { outcome = probeFailureTag(error).reason; }
    finally { if (timer) clearTimeout(timer); }
    workerLog.warn("box_stale_resume_stop", { requestId: candidate.requestId,
      accountId: candidate.accountId.toString(), phase,
      unknownForMs: candidate.staleResume?.unknownForMs, outcome });
    if (outcome !== "stop-requested" && outcome !== "terminal-present") throw readError;
    const deadline = Date.now() + (this.deps.staleResumeProofWaitMs ?? 15_000);
    for (;;) {
      try { return await this.readProof(candidate, target); }
      catch (error) { if (Date.now() >= deadline) throw error; }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }

  /** worker_complete is not a failure. Close one final round only when the
   * writer, chain evidence, catalog binding and capsule all exist. */
  private async recoverProvedSuccess(candidate: BoxStoppedFailureProbeCandidate,
    target: BoxResolvedTarget): Promise<ProvedSuccess> {
    const journal = this.deps.journal;
    const write = this.deps.writeRecoveryMessage;
    if (!write || !journal.readDetachedUnknownRecovery || !journal.complete
      || !journal.completeToolChain || !journal.readRecoveryWinner) {
      return { status: "pending", reason: "BOX_RECOVERY_WRITER_MISSING" };
    }
    const loaded = await journal.readDetachedUnknownRecovery({
      requestId: candidate.requestId, uid: candidate.uid,
      accountId: candidate.accountId, runNonce: candidate.runNonce,
      leaseEpoch: candidate.leaseEpoch, linked: candidate.linked === true });
    if (!loaded.ok) return { status: "pending", reason: loaded.reason };
    let json: string;
    try {
      json = (await readBoxStagedToolCatalog({ exec: target.exec,
        runNonce: candidate.runNonce })).json;
    } catch { return { status: "pending", reason: "BOX_RECOVERY_CATALOG_UNREADABLE" }; }
    let catalog;
    try { catalog = rehydrateBoxToolCatalog(json); }
    catch { return { status: "pending", reason: "BOX_RECOVERY_CATALOG_INVALID" }; }
    if (catalog.bindingSha256 !== loaded.evidence.catalogHash) {
      return { status: "pending", reason: "BOX_RECOVERY_CATALOG_MISMATCH" };
    }
    const outcome = await observeBoxToolTerminalOnly({
      evidence: loaded.evidence, catalog, target }, {
      journal: { complete: journal.complete.bind(journal),
        completeToolChain: journal.completeToolChain.bind(journal),
        readRecoveryWinner: journal.readRecoveryWinner.bind(journal) },
      writeMessage: write });
    if (outcome.status === "committed") return outcome;
    return { status: outcome.undeliverable === true ? "undeliverable" : "pending",
      reason: /^[A-Z0-9_]{1,64}$/.test(outcome.reason) ? outcome.reason
        : "BOX_RECOVERY_OBSERVE_FAILED" };
  }

  async reconcileBatch(limit = 10): Promise<{ cleaned: number; pending: number;
    orphaned: number }> {
    await this.deps.resolver.retryFailedAgentCleanup?.().catch(() => {});
    for (const [target, state] of this.orphaned) {
      if (state.failed && !state.pending) {
        state.failed = false;
        await this.closeLocal(target);
      }
    }
    const probe = await this.reconcileStoppedFailures(limit);
    const candidates = await this.deps.journal.listRemoteCleanupCandidates(limit);
    let cleaned = 0, pending = probe.pending;
    for (const candidate of candidates) {
      let target: BoxResolvedTarget | null = null;
      try {
        if (!await this.deps.journal.claimRemoteCleanup(candidate)) continue;
        target = await this.resolvePinned(candidate);
        if (target.accountId !== candidate.accountId) throw new Error("BOX_CLEANUP_ACCOUNT_MISMATCH");
        const keepNativeProject = candidate.nativePointer?.cliCwd
          === `/tmp/ocv5-289-run-${candidate.runNonce}`;
        const remote = target.exec.run(makeBoxRunCleanup(candidate.runNonce,
          keepNativeProject), {
          timeoutMs: 20_000, maxResponseBytes: 4096 });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let result: Awaited<typeof remote>;
        try { result = await Promise.race([remote, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("BOX_RUN_CLEANUP_TIMEOUT")), 20_500);
        })]); }
        finally { if (timeout) clearTimeout(timeout); }
        if (result.stdout.trim() !== "clean") throw new Error("BOX_RUN_CLEANUP_UNPROVEN");
        await this.deps.journal.markRemoteCleaned(candidate);
        cleaned++;
      } catch { pending++; /* Claimed row re-enters after durable backoff. */ }
      finally { if (target) await this.closeLocal(target); }
    }
    return { cleaned, pending, orphaned: this.orphaned.size };
  }
}
