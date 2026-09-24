/** Internal Box tool transport on the existing OpenClaude Messages route.
 * OpenClaude remains the agent/tool/memory/Skill owner; Box runs only Claude
 * Code's model process. This is off-route until real Box acceptance, remote
 * cleanup/reconciliation and production wiring pass T2 audit. */
import type { BoxDurableJournal, BoxRemoteCleanupCandidate } from "./boxDurableJournal.js";
import { runBoxToolFirstRound, type BoxToolFirstHandoff,
  type BoxToolFirstFinal } from "./boxToolFirstRound.js";
import { publishBoxToolResume, type BoxToolPublishedResume } from "./boxToolResumePublish.js";
import { runBoxToolContinuation } from "./boxToolContinuation.js";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import type { ProxyBody } from "./shared.js";

type FetchArgs = { uid: bigint; sessionId: string | null; requestId: string;
  canonicalModel: string; canonicalBody: ProxyBody; upstreamModel: string;
  url: string; init: RequestInit };
type First = typeof runBoxToolFirstRound;
type Publish = typeof publishBoxToolResume;
type Continue = typeof runBoxToolContinuation;

function resumeShape(body: ProxyBody): boolean {
  const messages = body.messages;
  const last = Array.isArray(messages) ? messages.at(-1) : null;
  if (!last || typeof last !== "object" || !("role" in last)
    || last.role !== "user" || !("content" in last)
    || !Array.isArray(last.content) || last.content.length < 1) return false;
  return last.content.every((block) => block && typeof block === "object"
    && "type" in block && block.type === "tool_result");
}

export class BoxToolFetch {
  private readonly targets = new Map<string, Set<BoxResolvedTarget>>();
  private readonly terminalCleanup = new Map<string, { target: BoxResolvedTarget;
    candidate: BoxRemoteCleanupCandidate; claimed: boolean }>();
  private readonly terminalInFlight = new Map<string, Promise<void>>();
  private readonly reconcileInFlight = new Set<string>();
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
      requiredAccountId?: bigint }) => Promise<BoxResolvedTarget>;
    onUnknown: (args: { uid: bigint; accountId: bigint;
      requestId: string; phase: string }) => Promise<void>;
    runFirst?: First;
    publishResume?: Publish;
    runContinuation?: Continue;
  }) {}

  private own(nonce: string, target: BoxResolvedTarget): void {
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
    return this.terminalCleanup.size;
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
          const target = await this.deps.resolveTarget({ uid: candidate.uid,
            sessionId: null, requestId: candidate.requestId,
            upstreamModel: "claude-opus-5-5",
            requiredAccountId: candidate.accountId,
            signal: new AbortController().signal });
          if (target.accountId !== candidate.accountId) {
            throw new Error("BOX_CLEANUP_ACCOUNT_MISMATCH");
          }
          held = { target, candidate, claimed: true };
          this.terminalCleanup.set(candidate.runNonce, held);
          this.own(candidate.runNonce, target);
        }
        held.claimed = true;
        await this.cleanKnownTerminal(candidate.runNonce, held.target, candidate);
      } finally { this.reconcileInFlight.delete(candidate.runNonce); }
    }));
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
    const remote = target.exec.run(makeBoxRunCleanup(runNonce), {
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
              resolveTarget: (input) => this.deps.resolveTarget(input),
              retainUnknownTarget: ({ target, claim }) => this.own(claim.runNonce, target),
              onUnknown: this.deps.onUnknown,
            });
            this.own(published.claim.runNonce, published.target);
            const result = await (this.deps.runContinuation ?? runBoxToolContinuation)({
              published, uid: args.uid, requestId: args.requestId,
              canonicalBody: args.canonicalBody, upstreamModel: args.upstreamModel,
              signal: abort.signal, emit,
            }, { journal: this.deps.journal,
              retainUnknownTarget: ({ published: held }) =>
                this.own(held.claim.runNonce, held.target),
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
              resolveTarget: (input) => this.deps.resolveTarget(input),
              onUnknown: this.deps.onUnknown,
              retainUnknownTarget: ({ target, plan }) => this.own(plan.runNonce, target),
              retainCleanupTarget: (handle) => this.retainCleanup(handle),
            });
            this.own(outcome.plan.runNonce, outcome.target);
            if (outcome.kind === "final") {
              await this.releaseAfterProof({ requestId: args.requestId,
                uid: args.uid, accountId: outcome.target.accountId,
                runNonce: outcome.plan.runNonce,
                leaseEpoch: outcome.plan.leaseEpoch, proof: outcome.proof });
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
