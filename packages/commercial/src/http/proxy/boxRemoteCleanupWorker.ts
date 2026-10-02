/** Shared-leader, flag-independent Box privacy cleanup recovery. Only a
 * terminal-proof journal candidate may reach remote Exec; no CLI launch,
 * tool publication or paid retry exists in this worker. */
import type { BoxAccountResolver } from "./boxAccountResolver.js";
import type { BoxDurableJournal, BoxRemoteCleanupCandidate,
  BoxStoppedFailureProbeCandidate } from "./boxDurableJournal.js";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";
import { readBoxTerminalProof } from "./boxTerminalProof.js";
import { readBoxStagedToolCatalog } from "./boxStagedCatalogRead.js";
import { rehydrateBoxToolCatalog } from "./boxToolCatalog.js";
import { observeBoxToolTerminalOnly } from "./boxToolTerminalRecovery.js";
import type { BoxReplayMessageWriter } from "./boxReplayMessageFile.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";

type Journal = Pick<BoxDurableJournal, "listRemoteCleanupCandidates" |
  "claimRemoteCleanup" | "markRemoteCleaned"> & Partial<Pick<BoxDurableJournal,
    "listStoppedFailureProbeCandidates" | "claimStoppedFailureProbe" |
    "markFirstRoundStoppedFailure" | "markToolChainStoppedFailure" | "markFirstRoundRejectedStream" |
    "readDetachedUnknownRecovery" | "complete" | "completeToolChain" |
    "readRecoveryWinner">>;
type Resolver = Pick<BoxAccountResolver, "resolve"> &
  Partial<Pick<BoxAccountResolver, "retryFailedAgentCleanup">>;

export class BoxRemoteCleanupWorker {
  private readonly orphaned = new Map<BoxResolvedTarget,
    { pending: Promise<void> | null; failed: boolean }>();
  constructor(private readonly deps: { journal: Journal; resolver: Resolver;
    writeRecoveryMessage?: BoxReplayMessageWriter }) {}

  private async resolvePinned(candidate: Pick<BoxRemoteCleanupCandidate,
    "uid" | "requestId" | "accountId">): Promise<BoxResolvedTarget> {
    const abort = new AbortController();
    const pending = this.deps.resolver.resolve({ uid: candidate.uid,
      sessionId: null, requestId: candidate.requestId,
      upstreamModel: "claude-opus-5-5", requiredAccountId: candidate.accountId,
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
        target = await this.resolvePinned(candidate);
        if (target.accountId !== candidate.accountId) throw new Error("BOX_STOP_PROBE_ACCOUNT_MISMATCH");
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let proof: Awaited<ReturnType<typeof readBoxTerminalProof>>;
        try {
          proof = await Promise.race([
            readBoxTerminalProof({ target, expectedAccountId: candidate.accountId,
              runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch,
              signal: abort.signal }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => { abort.abort();
                reject(new Error("BOX_STOP_PROBE_TIMEOUT")); }, 11_000);
            }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
        if (proof.reason === "worker_complete") {
          const outcome = await this.recoverProvedSuccess(candidate, target);
          if (outcome === "undeliverable") {
            // OCV5-306: the CLI finished on its own with a tool call no client
            // ever received; settle unbilled instead of pinning the session.
            const close = { requestId: candidate.requestId, uid: candidate.uid,
              leaseEpoch: candidate.leaseEpoch, proof };
            if (candidate.linked) await journal.markToolChainStoppedFailure({ ...close, rejectedStream: true });
            else if (journal.markFirstRoundRejectedStream) await journal.markFirstRoundRejectedStream(close);
            else { pending++; continue; }
            recovered++;
          } else if (outcome !== "committed") pending++;
          continue;
        }
        const stop = { requestId: candidate.requestId, uid: candidate.uid,
          leaseEpoch: candidate.leaseEpoch, proof };
        if (candidate.linked) await journal.markToolChainStoppedFailure(stop);
        else await journal.markFirstRoundStoppedFailure(stop);
        recovered++;
      } catch { pending++; }
      finally { if (target) await this.closeLocal(target); }
    }
    return { recovered, pending };
  }

  /** worker_complete is not a failure. Close one final round only when the
   * writer, chain evidence, catalog binding and capsule all exist. */
  private async recoverProvedSuccess(candidate: BoxStoppedFailureProbeCandidate,
    target: BoxResolvedTarget): Promise<"committed" | "undeliverable" | "pending"> {
    const journal = this.deps.journal;
    const write = this.deps.writeRecoveryMessage;
    if (!write || !journal.readDetachedUnknownRecovery || !journal.complete
      || !journal.completeToolChain || !journal.readRecoveryWinner) return "pending";
    const loaded = await journal.readDetachedUnknownRecovery({
      requestId: candidate.requestId, uid: candidate.uid,
      accountId: candidate.accountId, runNonce: candidate.runNonce,
      leaseEpoch: candidate.leaseEpoch, linked: candidate.linked === true });
    if (!loaded.ok) return "pending";
    let json: string;
    try {
      json = (await readBoxStagedToolCatalog({ exec: target.exec,
        runNonce: candidate.runNonce })).json;
    } catch { return "pending"; }
    let catalog;
    try { catalog = rehydrateBoxToolCatalog(json); }
    catch { return "pending"; }
    if (catalog.bindingSha256 !== loaded.evidence.catalogHash) return "pending";
    const outcome = await observeBoxToolTerminalOnly({
      evidence: loaded.evidence, catalog, target }, {
      journal: { complete: journal.complete.bind(journal),
        completeToolChain: journal.completeToolChain.bind(journal),
        readRecoveryWinner: journal.readRecoveryWinner.bind(journal) },
      writeMessage: write });
    if (outcome.status === "committed") return "committed";
    return outcome.reason === "BOX_RECOVERY_INTERMEDIATE_HANDOFF" ? "undeliverable" : "pending";
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
