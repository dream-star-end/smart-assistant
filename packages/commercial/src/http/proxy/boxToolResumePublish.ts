/** Publish OpenClaude-executed tool results into one already-running Box CLI.
 * The journal CAS precedes every remote result write. A write is attempted
 * once; uncertain publication is never retried or counted as a new model call. */
import { isDeepStrictEqual } from "node:util";
import type { BoxDurableJournal, BoxToolResumeClaim } from "./boxDurableJournal.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import { makeBoxDetachedRunAccess, type BoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { makeBoxPendingRead, makeBoxToolResultPlan,
  parseBoxPendingCall } from "./boxToolResultPlan.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import type { ProxyBody } from "./shared.js";

export class BoxToolResumePublishError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolResumePublishError"; }
}
export interface BoxToolPublishedResume {
  readonly claim: BoxToolResumeClaim;
  readonly access: BoxDetachedRunAccess;
  readonly target: BoxResolvedTarget;
}
type Journal = Pick<BoxDurableJournal, "claimToolResume" | "markUnknown">;

export async function publishBoxToolResume(input: {
  uid: bigint;
  sessionId: string | null;
  requestId: string;
  canonicalModel: string;
  canonicalBody: ProxyBody;
  upstreamModel: string;
  url: string;
  init: RequestInit;
}, deps: {
  journal: Journal;
  resolveTarget: (args: { uid: bigint; sessionId: string | null;
    requestId: string; upstreamModel: string; requiredAccountId: bigint;
    signal: AbortSignal }) => Promise<BoxResolvedTarget>;
  retainUnknownTarget: (handle: { target: BoxResolvedTarget;
    claim: BoxToolResumeClaim; uid: bigint; requestId: string }) => void;
  onUnknown: (args: { uid: bigint; accountId: bigint; requestId: string;
    phase: string }) => Promise<void>;
  budgetMs?: number;
}): Promise<BoxToolPublishedResume> {
  if (input.url !== BOX_INTERNAL_ENDPOINT || input.init.method !== "POST"
    || typeof input.init.body !== "string") {
    throw new BoxToolResumePublishError("BOX_TOOL_RESUME_REQUEST_INVALID");
  }
  let body: ProxyBody;
  try { body = JSON.parse(input.init.body) as ProxyBody; }
  catch { throw new BoxToolResumePublishError("BOX_TOOL_RESUME_REQUEST_INVALID"); }
  if (input.canonicalBody.model !== input.canonicalModel
    || body.model !== input.upstreamModel
    || !isDeepStrictEqual(body.messages, input.canonicalBody.messages)
    || !isDeepStrictEqual(body.tools, input.canonicalBody.tools)
    || body.max_tokens !== input.canonicalBody.max_tokens) {
    throw new BoxToolResumePublishError("BOX_TOOL_RESUME_BINDING_INVALID");
  }
  const budget = deps.budgetMs ?? 900_000;
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 900_000) {
    throw new BoxToolResumePublishError("BOX_TOOL_RESUME_BUDGET_INVALID");
  }
  const abort = new AbortController();
  const onClientAbort = (): void => abort.abort();
  input.init.signal?.addEventListener("abort", onClientAbort, { once: true });
  if (input.init.signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), budget);
  const signal = abort.signal;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new BoxToolResumePublishError(
      "BOX_TOOL_RESUME_ABORTED")), { once: true });
  });
  void aborted.catch(() => {});
  const race = <T>(value: Promise<T>): Promise<T> => Promise.race([value, aborted]);
  let claim: BoxToolResumeClaim | null = null;
  let target: BoxResolvedTarget | null = null;
  let unknownNotified = false;
  const unknown = async (phase: string): Promise<void> => {
    if (!claim || unknownNotified) return;
    unknownNotified = true;
    if (target) deps.retainUnknownTarget({ target, claim,
      uid: input.uid, requestId: input.requestId });
    const observed = Promise.allSettled([
      deps.journal.markUnknown({ requestId: input.requestId, uid: input.uid,
        leaseEpoch: claim.leaseEpoch, phase }),
      deps.onUnknown({ uid: input.uid, accountId: claim.accountId,
        requestId: input.requestId, phase }),
    ]);
    let wait: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([observed, new Promise<void>((resolve) => {
      wait = setTimeout(resolve, 200);
    })]); }
    finally { if (wait) clearTimeout(wait); }
  };
  try {
    if (signal.aborted) throw new BoxToolResumePublishError("BOX_TOOL_RESUME_ABORTED");
    // This is the only mutation before sidecar publication. An ambiguous CAS
    // response fails closed; it is never reissued by this coordinator.
    claim = await race(deps.journal.claimToolResume({ requestId: input.requestId,
      uid: input.uid, canonicalModel: input.canonicalModel,
      canonicalBody: input.canonicalBody }));
    const access = makeBoxDetachedRunAccess({ runNonce: claim.runNonce,
      detachedRunnerHash: claim.detachedRunnerHash });
    const pendingTarget = deps.resolveTarget({ uid: input.uid,
      sessionId: input.sessionId, requestId: input.requestId,
      upstreamModel: input.upstreamModel,
      requiredAccountId: claim.accountId, signal });
    let resolverLost = false;
    let completedTarget: BoxResolvedTarget | null = null;
    let lateRetained = false;
    const retainLate = (late: BoxResolvedTarget): void => {
      if (lateRetained || !claim) return;
      lateRetained = true;
      deps.retainUnknownTarget({ target: late, claim,
        uid: input.uid, requestId: input.requestId });
    };
    void pendingTarget.then((late) => {
      completedTarget = late;
      if (resolverLost) retainLate(late);
    }, () => {}).catch(() => {});
    try { target = await race(pendingTarget); }
    catch (error) {
      resolverLost = true;
      if (completedTarget) retainLate(completedTarget);
      throw error;
    }
    if (target.accountId !== claim.accountId) {
      throw new BoxToolResumePublishError("BOX_TOOL_RESUME_ACCOUNT_MISMATCH");
    }
    const run = async (request: Parameters<BoxResolvedTarget["exec"]["run"]>[0],
      timeoutMs = 20_000) => {
      if (!target || signal.aborted) throw new BoxToolResumePublishError("BOX_TOOL_RESUME_ABORTED");
      return race(target.exec.run(request, { timeoutMs, maxResponseBytes: 1_048_576,
        signal }));
    };
    const remaining = new Map(claim.toolUses.map((expected, i) =>
      [expected.id, { expected, matched: claim!.results[i]! }] as const));
    if (remaining.size !== claim.toolUses.length) {
      throw new BoxToolResumePublishError("BOX_TOOL_RESUME_RESULT_ORDER_INVALID");
    }
    let idleUntil = Date.now() + Math.min(30_000, budget);
    while (remaining.size > 0) {
      let progressed = false;
      for (const [id, { expected, matched }] of remaining) {
        if (matched.modelToolUseId !== expected.id) {
          throw new BoxToolResumePublishError("BOX_TOOL_RESUME_RESULT_ORDER_INVALID");
        }
        // The CLI may dispatch any subset first. Scan every remaining ID; a
        // pending read is side-effect free, but a result file is published once.
        let pending: ReturnType<typeof parseBoxPendingCall>;
        try {
          const read = await run(makeBoxPendingRead(access.cwd, expected.id));
          pending = parseBoxPendingCall(read.stdout, expected);
        } catch (error) {
          if (error instanceof BoxExecTransportError && error.terminalKnown) continue;
          throw error;
        }
        const staged = makeBoxToolResultPlan({ cwd: access.cwd, expected,
          pending, matched });
        for (let j = 0; j < staged.requests.length; j++) {
          const published = await run(staged.requests[j]!);
          if (j === staged.requests.length - 1
            && published.stdout.trim() !== staged.resultHash) {
            throw new BoxToolResumePublishError("BOX_TOOL_RESULT_PUBLISH_UNPROVEN");
          }
        }
        remaining.delete(id);
        progressed = true;
        idleUntil = Date.now() + Math.min(30_000, budget);
      }
      if (!progressed) {
        if (signal.aborted || Date.now() >= idleUntil) {
          throw new BoxToolResumePublishError("BOX_TOOL_RESUME_PENDING_UNPROVEN");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    return { claim, access, target };
  } catch (error) {
    if (claim) await unknown("resume_publish_unknown");
    throw error;
  } finally {
    clearTimeout(timer);
    input.init.signal?.removeEventListener("abort", onClientAbort);
  }
}
