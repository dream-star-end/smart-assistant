/** Internal Box tool transport on the existing OpenClaude Messages route.
 * OpenClaude remains the agent/tool/memory/Skill owner; Box runs only Claude
 * Code's model process. This is off-route until real Box acceptance, remote
 * cleanup/reconciliation and production wiring pass T2 audit. */
import type { BoxDurableJournal, BoxRemoteCleanupCandidate,
  BoxPrelaunchRecoveryCandidate } from "./boxDurableJournal.js";
import { runBoxToolFirstRound, type BoxToolFirstHandoff,
  type BoxToolFirstFinal } from "./boxToolFirstRound.js";
import { publishBoxToolResume, type BoxToolPublishedResume } from "./boxToolResumePublish.js";
import { runBoxToolContinuation } from "./boxToolContinuation.js";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";
import { stripBoxCcbToolBudgetTail } from "./boxCacheAnnotations.js";
import { makeBoxPrelaunchCleanup } from "./boxPrelaunchControl.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import type { ProxyBody } from "./shared.js";

type FetchArgs = { uid: bigint; sessionId: string | null; requestId: string;
  canonicalModel: string; canonicalBody: ProxyBody; upstreamModel: string;
  url: string; init: RequestInit };
type First = typeof runBoxToolFirstRound;
type Publish = typeof publishBoxToolResume;
type Continue = typeof runBoxToolContinuation;

function resumeShape(body: ProxyBody): boolean {
  const messages = stripBoxCcbToolBudgetTail(body).messages;
  const last = Array.isArray(messages) ? messages.at(-1) : null;
  if (!last || typeof last !== "object" || !("role" in last)
    || last.role !== "user" || !("content" in last)
    || !Array.isArray(last.content) || last.content.length < 1) return false;
  return last.content.every((block) => block && typeof block === "object"
    && "type" in block && block.type === "tool_result");
}

export class BoxToolFetch {
  private readonly targets = new Map<string, Set<BoxResolvedTarget>>();
  private readonly ownedRunIdentity = new Map<string, { uid: bigint;
    accountId: bigint; runNonce: string; leaseEpoch: string }>();
  private readonly terminalCleanup = new Map<string, { target: BoxResolvedTarget;
    candidate: BoxRemoteCleanupCandidate; claimed: boolean }>();
  private readonly terminalInFlight = new Map<string, Promise<void>>();
  private readonly reconcileInFlight = new Set<string>();
  private readonly prelaunchInFlight = new Set<string>();
  private readonly cleanup = new Set<{ target: BoxResolvedTarget;
    pending: Promise<void>; failed: boolean }>();
  constructor(private readonly deps: {
    supervisorAsset: Buffer;
    keeperAsset: Buffer;
    virtualMcpAsset: Buffer;
    detachedRunnerAsset: Buffer;
    journal: BoxDurableJournal;
    maxOutputTokensForModel: (model: string) => number | null;
    resolveTarget: (args: { uid: bigint; sessionId: string | null;
      requestId: string; upstreamModel: string; signal: AbortSignal;
      allowWakeIfHibernated?: boolean;
      requiredAccountId?: bigint }) => Promise<BoxResolvedTarget>;
    onUnknown: (args: { uid: bigint; accountId: bigint;
      requestId: string; phase: string }) => Promise<void>;
    runFirst?: First;
    publishResume?: Publish;
    runContinuation?: Continue;
    /** Test-only shortening of the bounded restart-cleanup resolver wait. */
    cleanupResolveTimeoutMs?: number;
  }) {}

  private own(nonce: string, target: BoxResolvedTarget, uid: bigint,
    leaseEpoch: string): void {
    const existing = this.ownedRunIdentity.get(nonce);
    if (existing && (existing.uid !== uid || existing.accountId !== target.accountId
      || existing.leaseEpoch !== leaseEpoch)) {
      this.closeUnusedTarget(target);
      throw new Error("BOX_LOCAL_OWNER_MISMATCH");
    }
    this.ownedRunIdentity.set(nonce, { uid, accountId: target.accountId,
      runNonce: nonce, leaseEpoch });
    let group = this.targets.get(nonce);
    if (!group) { group = new Set(); this.targets.set(nonce, group); }
    group.add(target);
  }

  private retainCleanup(handle: { target: BoxResolvedTarget;
    pending: Promise<void> }): void {
    const state = { target: handle.target, pending: handle.pending, failed: false };
    this.cleanup.add(state);
    void handle.pending.then(() => { this.cleanup.delete(state); }, () => {
      state.failed = true;
    });
  }

  private closeUnusedTarget(target: BoxResolvedTarget): void {
    const pending = Promise.resolve().then(() => target.dispose?.());
    this.retainCleanup({ target, pending });
  }

  private async resolveCleanupTarget(candidate: BoxRemoteCleanupCandidate |
    BoxPrelaunchRecoveryCandidate): Promise<BoxResolvedTarget> {
    const timeoutMs = this.deps.cleanupResolveTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("BOX_CLEANUP_RESOLVE_BUDGET_INVALID");
    }
    const abort = new AbortController();
    const pending = Promise.resolve().then(() => this.deps.resolveTarget({ uid: candidate.uid,
      sessionId: null, requestId: candidate.requestId,
      upstreamModel: "claude-opus-5-5", requiredAccountId: candidate.accountId,
      signal: abort.signal }));
    let abandoned = false, completed: BoxResolvedTarget | null = null;
    void pending.then((target) => {
      completed = target;
      if (abandoned) this.closeUnusedTarget(target);
    }, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort(); reject(new Error("BOX_CLEANUP_RESOLVE_TIMEOUT"));
        }, timeoutMs);
      })]);
    } catch (error) {
      abandoned = true;
      if (completed) this.closeUnusedTarget(completed);
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Restart-safe, no-paid takeover of a private stage that never acquired a
   * durable launch permit. Old v1 rows without the control receipt are not
   * eligible and must be resolved by exact operator proof. */
  async reconcilePrelaunchRecovery(limit = 10): Promise<number> {
    const candidates = await this.deps.journal.listPrelaunchRecoveryCandidates(limit);
    let settled = 0;
    await Promise.allSettled(candidates.map(async (candidate) => {
      if (this.prelaunchInFlight.has(candidate.runNonce)) return;
      this.prelaunchInFlight.add(candidate.runNonce);
      let target: BoxResolvedTarget | null = null;
      let targetWasOwned = false;
      try {
        if (!await this.deps.journal.claimPrelaunchRecovery(candidate)) return;
        target = await this.resolveCleanupTarget(candidate);
        targetWasOwned = this.targets.get(candidate.runNonce)?.has(target) ?? false;
        if (target.accountId !== candidate.accountId) {
          throw new Error("BOX_PRELAUNCH_RECOVERY_ACCOUNT_MISMATCH");
        }
        const pending = target.exec.run(makeBoxPrelaunchCleanup(candidate.receipt), {
          timeoutMs: 20_000, maxResponseBytes: 4096 });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: Awaited<typeof pending>;
        try {
          result = await Promise.race([pending, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("BOX_PRELAUNCH_RECOVERY_TIMEOUT")), 20_500);
          })]);
        } finally { if (timer) clearTimeout(timer); }
        const cleanedReceipt = result.stdout.trim();
        if (cleanedReceipt !== `cleaned:${candidate.receipt.identityHash}`) {
          throw new Error("BOX_PRELAUNCH_RECOVERY_UNPROVEN");
        }
        await this.deps.journal.markGuardedPrestartStopped({
          requestId: candidate.requestId, uid: candidate.uid,
          accountId: candidate.accountId, runNonce: candidate.runNonce,
          leaseEpoch: candidate.leaseEpoch, receipt: candidate.receipt,
          cleanedReceipt,
        });
        const owned = this.ownedRunIdentity.get(candidate.runNonce);
        if (owned && owned.uid === candidate.uid
          && owned.accountId === candidate.accountId
          && owned.leaseEpoch === candidate.leaseEpoch) {
          await this.releaseLocalTargets(candidate.runNonce);
        }
        settled++;
      } finally {
        if (target && !targetWasOwned) this.closeUnusedTarget(target);
        this.prelaunchInFlight.delete(candidate.runNonce);
      }
    }));
    return settled;
  }

  private async cleanedElsewhere(candidate: BoxRemoteCleanupCandidate): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([
        this.deps.journal.remoteCleanupStatus(candidate),
        new Promise<"pending">((resolve) => {
          timer = setTimeout(() => resolve("pending"), 2000);
        }),
      ]);
      return status === "done";
    } catch { return false; /* Cleanup status is pending, never response-fatal. */ }
    finally { if (timer) clearTimeout(timer); }
  }

  /** Only local ProxyAgents whose remote invocation is already proven stopped,
   * or whose paid invocation never started, are eligible for this retry. */
  async retryFailedCleanup(): Promise<number> {
    const retryable = [...this.cleanup].filter((item) => item.failed);
    await Promise.allSettled(retryable.map(async (item) => {
      item.failed = false;
      const pending = Promise.resolve().then(() => item.target.dispose?.());
      item.pending = pending;
      const observed = pending.then(() => { this.cleanup.delete(item); },
        () => { item.failed = true; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([observed, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 200);
      })]); }
      finally { if (timer) clearTimeout(timer); }
    }));
    return this.cleanup.size;
  }

  /** Terminal proof and journal evidence already exist for these runs.
   * The remote cleanup is idempotent; this never relaunches the paid CLI. */
  async retryTerminalCleanup(): Promise<number> {
    await Promise.allSettled([...this.terminalCleanup].map(async ([nonce, held]) => {
      if (!held.claimed) {
        held.claimed = await this.deps.journal.claimRemoteCleanup(held.candidate);
      }
      if (held.claimed) await this.cleanKnownTerminal(nonce, held.target, held.candidate);
      else if (await this.cleanedElsewhere(held.candidate)) {
        await this.releaseLocalTargets(nonce);
      }
    }));
    await this.reapCleanedOwnedTargets();
    return this.terminalCleanup.size;
  }

  private async reapCleanedOwnedTargets(): Promise<void> {
    await Promise.allSettled([...this.ownedRunIdentity].map(async ([nonce, identity]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const done = await Promise.race([
          (async () => await this.deps.journal.remoteCleanupDoneByRunIdentity(identity)
            || await this.deps.journal.prelaunchCleanupDoneByRunIdentity(identity))(),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 2_000); }),
        ]);
        if (done) await this.releaseLocalTargets(nonce);
      } finally { if (timer) clearTimeout(timer); }
    }));
  }

  /** Restart-safe takeover: a new egress process can find already-proven
   * terminal runs in the existing journal and clean them on the pinned Box.
   * This never resumes, replays or pays for a CLI invocation. */
  async reconcileRemoteCleanup(limit = 10): Promise<number> {
    const candidates = await this.deps.journal.listRemoteCleanupCandidates(limit);
    await Promise.allSettled(candidates.map(async (candidate) => {
      if (this.reconcileInFlight.has(candidate.runNonce)) return;
      this.reconcileInFlight.add(candidate.runNonce);
      try {
        if (!await this.deps.journal.claimRemoteCleanup(candidate)) {
          if (this.terminalCleanup.has(candidate.runNonce)
            && await this.cleanedElsewhere(candidate)) {
            await this.releaseLocalTargets(candidate.runNonce);
          }
          return;
        }
        let held = this.terminalCleanup.get(candidate.runNonce);
        if (!held) {
          const target = await this.resolveCleanupTarget(candidate);
          if (target.accountId !== candidate.accountId) {
            this.closeUnusedTarget(target);
            throw new Error("BOX_CLEANUP_ACCOUNT_MISMATCH");
          }
          held = { target, candidate, claimed: true };
          this.terminalCleanup.set(candidate.runNonce, held);
          this.own(candidate.runNonce, target, candidate.uid, candidate.leaseEpoch);
        }
        held.claimed = true;
        await this.cleanKnownTerminal(candidate.runNonce, held.target, candidate);
      } finally { this.reconcileInFlight.delete(candidate.runNonce); }
    }));
    await this.reapCleanedOwnedTargets();
    return this.terminalCleanup.size;
  }

  private cleanKnownTerminal(runNonce: string, target: BoxResolvedTarget,
    candidate: BoxRemoteCleanupCandidate): Promise<void> {
    const existing = this.terminalInFlight.get(runNonce);
    if (existing) return existing;
    const pending = this.performTerminalCleanup(runNonce, target, candidate).finally(() => {
      this.terminalInFlight.delete(runNonce);
    });
    this.terminalInFlight.set(runNonce, pending);
    return pending;
  }

  private async performTerminalCleanup(runNonce: string,
    target: BoxResolvedTarget, candidate: BoxRemoteCleanupCandidate): Promise<void> {
    const keepNativeProject = candidate.nativePointer?.cliCwd
      === `/tmp/ocv5-289-run-${runNonce}`;
    const remote = target.exec.run(makeBoxRunCleanup(runNonce,
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
    await this.releaseLocalTargets(runNonce);
  }

  private async releaseLocalTargets(runNonce: string): Promise<void> {
    this.terminalCleanup.delete(runNonce);
    this.ownedRunIdentity.delete(runNonce);
    const group = this.targets.get(runNonce);
    if (!group) return;
    this.targets.delete(runNonce);
    await Promise.allSettled([...group].map(async (owned) => {
      const pending = Promise.resolve().then(() => owned.dispose?.());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const observed = pending.then(() => {}, () => {});
      try { await Promise.race([observed, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 200);
      })]); }
      finally { if (timer) clearTimeout(timer); }
      this.retainCleanup({ target: owned, pending });
    }));
  }

  private async releaseAfterProof(candidate: BoxRemoteCleanupCandidate): Promise<void> {
    const runNonce = candidate.runNonce;
    const group = this.targets.get(runNonce);
    if (!group) return;
    const target = [...group].at(-1)!;
    const held = { target, candidate, claimed: false };
    this.terminalCleanup.set(runNonce, held);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { held.claimed = await Promise.race([
      this.deps.journal.claimRemoteCleanup(candidate),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000); }),
    ]); }
    catch { held.claimed = false; }
    finally { if (timer) clearTimeout(timer); }
    if (!held.claimed) {
      if (await this.cleanedElsewhere(candidate)) {
        await this.releaseLocalTargets(runNonce);
      }
      return;
    }
    try { await this.cleanKnownTerminal(runNonce, target, candidate); }
    catch { /* retain pinned target and private files for bounded retry */ }
  }

  async fetch(args: FetchArgs): Promise<Response> {
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    args.init.signal?.addEventListener("abort", onAbort, { once: true });
    if (args.init.signal?.aborted) abort.abort();
    const init = { ...args.init, signal: abort.signal };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const emit = (sse: string): void => {
          if (sse) controller.enqueue(Buffer.from(sse, "utf8"));
        };
        void (async () => {
          if (resumeShape(args.canonicalBody)) {
            const published: BoxToolPublishedResume = await (this.deps.publishResume
              ?? publishBoxToolResume)({ ...args, init }, {
              journal: this.deps.journal,
              resolveTarget: (input) => this.deps.resolveTarget({ ...input,
                allowWakeIfHibernated: true }),
              retainUnknownTarget: ({ target, claim }) => this.own(claim.runNonce,
                target, args.uid, claim.leaseEpoch),
              onUnknown: this.deps.onUnknown,
            });
            this.own(published.claim.runNonce, published.target,
              args.uid, published.claim.leaseEpoch);
            const result = await (this.deps.runContinuation ?? runBoxToolContinuation)({
              published, uid: args.uid, requestId: args.requestId,
              canonicalBody: args.canonicalBody, upstreamModel: args.upstreamModel,
              signal: abort.signal, emit,
            }, { journal: this.deps.journal,
              retainUnknownTarget: ({ published: held }) =>
                this.own(held.claim.runNonce, held.target,
                  args.uid, held.claim.leaseEpoch),
              onUnknown: this.deps.onUnknown });
            if (result.kind === "final") {
              await this.releaseAfterProof({ requestId: args.requestId,
                uid: args.uid, accountId: published.claim.accountId,
                runNonce: published.claim.runNonce,
                leaseEpoch: published.claim.leaseEpoch, proof: result.proof });
            }
          } else {
            const outcome: BoxToolFirstHandoff | BoxToolFirstFinal = await (this.deps.runFirst
              ?? runBoxToolFirstRound)({ ...args, init, emit }, {
              supervisorAsset: this.deps.supervisorAsset,
              keeperAsset: this.deps.keeperAsset,
              virtualMcpAsset: this.deps.virtualMcpAsset,
              detachedRunnerAsset: this.deps.detachedRunnerAsset,
              journal: this.deps.journal,
              maxOutputTokensForModel: this.deps.maxOutputTokensForModel,
              resolveTarget: (input) => this.deps.resolveTarget({ ...input,
                allowWakeIfHibernated: true }),
              onUnknown: this.deps.onUnknown,
              retainUnknownTarget: ({ target, plan }) => this.own(plan.runNonce,
                target, args.uid, plan.leaseEpoch),
              retainCleanupTarget: (handle) => this.retainCleanup(handle),
            });
            this.own(outcome.plan.runNonce, outcome.target,
              args.uid, outcome.plan.leaseEpoch);
            if (outcome.kind === "final") {
              await this.releaseAfterProof({ requestId: args.requestId,
                uid: args.uid, accountId: outcome.target.accountId,
                runNonce: outcome.plan.runNonce,
                leaseEpoch: outcome.plan.leaseEpoch, proof: outcome.proof,
                ...(outcome.nativePointer ? { nativePointer: outcome.nativePointer } : {}) });
            }
          }
          controller.close();
        })().catch((error: unknown) => {
          try { controller.error(error); } catch { /* downstream already cancelled */ }
        }).finally(() => {
          args.init.signal?.removeEventListener("abort", onAbort);
        });
      },
      cancel: () => { abort.abort(); },
    });
    return new Response(stream, { status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
}
