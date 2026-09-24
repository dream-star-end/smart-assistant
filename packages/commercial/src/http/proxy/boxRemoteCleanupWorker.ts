/** Shared-leader, flag-independent Box privacy cleanup recovery. Only a
 * terminal-proof journal candidate may reach remote Exec; no CLI launch,
 * tool publication or paid retry exists in this worker. */
import type { BoxAccountResolver } from "./boxAccountResolver.js";
import type { BoxDurableJournal, BoxRemoteCleanupCandidate } from "./boxDurableJournal.js";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";

type Journal = Pick<BoxDurableJournal, "listRemoteCleanupCandidates" |
  "claimRemoteCleanup" | "markRemoteCleaned">;
type Resolver = Pick<BoxAccountResolver, "resolve">;

export class BoxRemoteCleanupWorker {
  private readonly orphaned = new Map<BoxResolvedTarget,
    { pending: Promise<void> | null; failed: boolean }>();
  constructor(private readonly deps: { journal: Journal; resolver: Resolver }) {}

  private async resolvePinned(candidate: BoxRemoteCleanupCandidate): Promise<BoxResolvedTarget> {
    const abort = new AbortController();
    const pending = this.deps.resolver.resolve({ uid: candidate.uid,
      sessionId: null, requestId: candidate.requestId,
      upstreamModel: "claude-opus-5-5", requiredAccountId: candidate.accountId,
      signal: abort.signal });
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

  async reconcileBatch(limit = 10): Promise<{ cleaned: number; pending: number;
    orphaned: number }> {
    for (const [target, state] of this.orphaned) {
      if (state.failed && !state.pending) {
        state.failed = false;
        await this.closeLocal(target);
      }
    }
    const candidates = await this.deps.journal.listRemoteCleanupCandidates(limit);
    let cleaned = 0, pending = 0;
    for (const candidate of candidates) {
      let target: BoxResolvedTarget | null = null;
      try {
        if (!await this.deps.journal.claimRemoteCleanup(candidate)) continue;
        target = await this.resolvePinned(candidate);
        if (target.accountId !== candidate.accountId) throw new Error("BOX_CLEANUP_ACCOUNT_MISMATCH");
        const remote = target.exec.run(makeBoxRunCleanup(candidate.runNonce), {
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
