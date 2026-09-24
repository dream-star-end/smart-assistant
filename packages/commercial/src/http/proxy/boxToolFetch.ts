/** Internal Box tool transport on the existing OpenClaude Messages route.
 * OpenClaude remains the agent/tool/memory/Skill owner; Box runs only Claude
 * Code's model process. This is off-route until real Box acceptance, remote
 * cleanup/reconciliation and production wiring pass T2 audit. */
import type { BoxDurableJournal } from "./boxDurableJournal.js";
import { runBoxToolFirstRound, type BoxToolFirstHandoff,
  type BoxToolFirstFinal } from "./boxToolFirstRound.js";
import { publishBoxToolResume, type BoxToolPublishedResume } from "./boxToolResumePublish.js";
import { runBoxToolContinuation } from "./boxToolContinuation.js";
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

  /** Only local ProxyAgents whose remote invocation is already proven stopped,
   * or whose paid invocation never started, are eligible for this retry. */
  async retryFailedCleanup(): Promise<number> {
    const retryable = [...this.cleanup].filter((item) => item.failed);
    await Promise.allSettled(retryable.map(async (item) => {
      item.failed = false;
      const pending = Promise.resolve().then(() => item.target.dispose?.());
      item.pending = pending;
      try { await pending; this.cleanup.delete(item); }
      catch { item.failed = true; }
    }));
    return this.cleanup.size;
  }

  private async releaseAfterProof(runNonce: string): Promise<void> {
    const group = this.targets.get(runNonce);
    if (!group) return;
    this.targets.delete(runNonce);
    await Promise.allSettled([...group].map(async (target) => {
      const pending = Promise.resolve().then(() => target.dispose?.());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const observed = pending.then(() => {}, () => {});
      try {
        await Promise.race([observed, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 200);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      // A pending or rejected close remains owned. The service timer may retry
      // only after that specific promise settles, never concurrently.
      this.retainCleanup({ target, pending });
    }));
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
              await this.releaseAfterProof(published.claim.runNonce);
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
              await this.releaseAfterProof(outcome.plan.runNonce);
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
