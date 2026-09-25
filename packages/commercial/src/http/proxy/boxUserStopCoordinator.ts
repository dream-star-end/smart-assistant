/** Explicit user-stop coordinator for a previously admitted detached Box run.
 * HTTP disconnect alone must not call this. The stop request never constitutes
 * terminal evidence; only the original keeper's strict proof can close a row.
 */
import type { BoxAccountResolver } from "./boxAccountResolver.js";
import type { BoxDurableJournal, BoxJournalAdmission,
  BoxStoppedFailureProbeCandidate } from "./boxDurableJournal.js";
import { makeBoxKeeperStop } from "./boxKeeperStop.js";
import { readBoxTerminalProof } from "./boxTerminalProof.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";

type Identity = Pick<BoxJournalAdmission,
  "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch">;
type Journal = Pick<BoxDurableJournal, "recordUserCancelIntent" | "getCancelLeaf" |
  "markFirstRoundStoppedFailure" | "markToolChainStoppedFailure">;
type Resolver = Pick<BoxAccountResolver, "resolve"> &
  Partial<Pick<BoxAccountResolver, "retryFailedAgentCleanup">>;
export type BoxUserStopOutcome = "stopped_proven" | "completed_unsettled" | "pending";

class BoxUserStopTimeout extends Error {}
async function bounded<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BoxUserStopTimeout()), ms);
  })]); }
  finally { if (timer) clearTimeout(timer); }
}

export class BoxUserStopCoordinator {
  private readonly orphaned = new Map<BoxResolvedTarget,
    { pending: Promise<void> | null; failed: boolean }>();
  constructor(private readonly deps: { journal: Journal; resolver: Resolver;
    proofWaitMs?: number; journalTimeoutMs?: number }) {
    if (deps.journalTimeoutMs !== undefined
      && (!Number.isSafeInteger(deps.journalTimeoutMs)
        || deps.journalTimeoutMs < 1 || deps.journalTimeoutMs > 5_000)) {
      throw new Error("BOX_USER_STOP_JOURNAL_TIMEOUT_INVALID");
    }
  }

  private async closeLocal(target: BoxResolvedTarget): Promise<void> {
    const state = this.orphaned.get(target) ?? { pending: null, failed: false };
    this.orphaned.set(target, state);
    if (state.pending) return;
    const pending = Promise.resolve().then(() => target.dispose?.()).then(() => {
      this.orphaned.delete(target);
    }, () => { state.failed = true; });
    state.pending = pending;
    void pending.finally(() => { if (state.pending === pending) state.pending = null; }).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([pending, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 200);
    })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  async retryFailedLocal(): Promise<number> {
    if (this.deps.resolver.retryFailedAgentCleanup) {
      await bounded(this.deps.resolver.retryFailedAgentCleanup(), 200).catch(() => {});
    }
    for (const [target, state] of this.orphaned) {
      if (state.failed && !state.pending) {
        state.failed = false;
        await this.closeLocal(target);
      }
    }
    return this.orphaned.size;
  }

  private async resolvePinned(leaf: BoxStoppedFailureProbeCandidate): Promise<BoxResolvedTarget> {
    const abort = new AbortController();
    const pending = this.deps.resolver.resolve({ uid: leaf.uid, sessionId: null,
      requestId: leaf.requestId, upstreamModel: "claude-opus-5-5",
      requiredAccountId: leaf.accountId, signal: abort.signal });
    let abandoned = false;
    let completed: BoxResolvedTarget | null = null;
    void pending.then((target) => {
      completed = target;
      if (abandoned) void this.closeLocal(target).catch(() => {});
    }, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort();
          reject(new Error("BOX_USER_STOP_RESOLVE_TIMEOUT")); }, 30_000);
      })]);
    } catch (error) {
      abandoned = true;
      if (completed) void this.closeLocal(completed).catch(() => {});
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  async requestStop(input: Identity): Promise<BoxUserStopOutcome> {
    // This must commit before the first remote stop Exec. Failure here must
    // propagate to the authenticated caller; do not signal an unjournaled run.
    const journalTimeoutMs = this.deps.journalTimeoutMs ?? 5_000;
    try { await bounded(this.deps.journal.recordUserCancelIntent(input), journalTimeoutMs); }
    catch (error) {
      if (error instanceof BoxUserStopTimeout) return "pending";
      throw error;
    }
    let leaf: BoxStoppedFailureProbeCandidate;
    try { leaf = await bounded(this.deps.journal.getCancelLeaf(input), journalTimeoutMs); }
    catch { return "pending"; } // A concurrent terminal may already own it.
    let target: BoxResolvedTarget | null = null;
    try {
      target = await this.resolvePinned(leaf);
      if (target.accountId !== leaf.accountId) return "pending";
      const stop = target.exec.run(makeBoxKeeperStop(leaf.runNonce, leaf.leaseEpoch), {
        timeoutMs: 10_000, maxResponseBytes: 1024 });
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Even a lost/ambiguous stop response is followed only by a proof read,
        // never by another paid or side-effecting model/tool invocation.
        await Promise.race([stop, new Promise<never>((_, reject) => {
          stopTimer = setTimeout(() => reject(new Error("BOX_USER_STOP_TIMEOUT")), 10_500);
        })]);
      } catch { /* The stop may already have reached the original keeper. */ }
      finally { if (stopTimer) clearTimeout(stopTimer); }
      const waitMs = this.deps.proofWaitMs ?? 20_000;
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 20_000) return "pending";
      const deadline = Date.now() + waitMs;
      do {
        try {
          const proof = await readBoxTerminalProof({ target,
            expectedAccountId: leaf.accountId, runNonce: leaf.runNonce,
            leaseEpoch: leaf.leaseEpoch });
          if (proof.reason === "worker_complete") return "completed_unsettled";
          const close = { requestId: leaf.requestId, uid: leaf.uid,
            leaseEpoch: leaf.leaseEpoch, proof };
          try {
            if (leaf.linked) await bounded(
              this.deps.journal.markToolChainStoppedFailure(close), journalTimeoutMs);
            else await bounded(this.deps.journal.markFirstRoundStoppedFailure(close), journalTimeoutMs);
          } catch { return "pending"; } // A late CAS may still commit; never infer it.
          return "stopped_proven";
        } catch { /* Missing proof or losing CAS remains pending. */ }
        if (Date.now() >= deadline) break;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100,
          Math.max(1, deadline - Date.now()))));
      } while (true);
      return "pending";
    } catch { return "pending"; }
    finally { if (target) await this.closeLocal(target); }
  }
}
