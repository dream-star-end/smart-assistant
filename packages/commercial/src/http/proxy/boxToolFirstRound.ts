/** First paid Box tool round on the existing OpenClaude Messages path.
 * Off-route until the complete cross-HTTP resume/terminal coordinator passes
 * real Box acceptance. The remote CLI never executes OpenClaude tools. */
import { isDeepStrictEqual } from "node:util";
import { deriveBoxCallFingerprint } from "./boxCallFingerprint.js";
import { makeBoxDetachedToolPlan, type BoxDetachedToolPlan } from "./boxDetachedToolPlan.js";
import { BoxCliToolHandoffDecoder, type BoxToolHandoffCandidate } from "./boxCliToolHandoff.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import type { BoxDurableJournal } from "./boxDurableJournal.js";
import { makeBoxPendingRead, parseBoxPendingCall } from "./boxToolResultPlan.js";
import { pollBoxSpoolLines } from "./boxSpoolPoller.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import type { ProxyBody } from "./shared.js";

export class BoxToolFirstRoundError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolFirstRoundError"; }
}
export interface BoxToolFirstHandoff {
  readonly plan: BoxDetachedToolPlan;
  /** Must remain owned until nonce/epoch-bound remote terminal proof. */
  readonly target: BoxResolvedTarget;
  readonly candidate: BoxToolHandoffCandidate;
  readonly spoolOffset: number;
}
type Journal = Pick<BoxDurableJournal, "admit" | "markRunning" |
  "markPrestartStopped" | "markUnknown" | "recordToolHandoff">;

export async function runBoxToolFirstRound(input: {
  uid: bigint;
  sessionId: string | null;
  requestId: string;
  canonicalModel: string;
  canonicalBody: ProxyBody;
  upstreamModel: string;
  url: string;
  init: RequestInit;
  emit: (sse: string) => void;
}, deps: {
  supervisorAsset: Buffer;
  keeperAsset: Buffer;
  virtualMcpAsset: Buffer;
  detachedRunnerAsset: Buffer;
  journal: Journal;
  maxOutputTokensForModel: (model: string) => number | null;
  resolveTarget: (args: { uid: bigint; sessionId: string | null; requestId: string;
    upstreamModel: string; signal: AbortSignal }) => Promise<BoxResolvedTarget>;
  onUnknown: (args: { uid: bigint; accountId: bigint; requestId: string;
    phase: string }) => Promise<void>;
  /** Retain the local target until remote proof or explicit operator recovery. */
  retainUnknownTarget: (handle: { target: BoxResolvedTarget;
    plan: BoxDetachedToolPlan; uid: bigint; requestId: string }) => void;
  budgetMs?: number;
}): Promise<BoxToolFirstHandoff> {
  if (input.url !== BOX_INTERNAL_ENDPOINT || input.init.method !== "POST"
    || typeof input.init.body !== "string") {
    throw new BoxToolFirstRoundError("BOX_TOOL_FETCH_REQUEST_INVALID");
  }
  let body: ProxyBody;
  try { body = JSON.parse(input.init.body) as ProxyBody; }
  catch { throw new BoxToolFirstRoundError("BOX_TOOL_FETCH_REQUEST_INVALID"); }
  if (input.canonicalBody.model !== input.canonicalModel
    || body.model !== input.upstreamModel
    || body.max_tokens !== input.canonicalBody.max_tokens
    || !isDeepStrictEqual(body.messages, input.canonicalBody.messages)
    || !isDeepStrictEqual(body.tools, input.canonicalBody.tools)
    || !Array.isArray(body.tools) || body.tools.length < 1) {
    throw new BoxToolFirstRoundError("BOX_TOOL_FETCH_BINDING_INVALID");
  }
  const cap = deps.maxOutputTokensForModel(input.canonicalModel);
  if (cap === null) throw new BoxToolFirstRoundError("BOX_TOOL_MODEL_NOT_CONFIGURED");
  let fingerprint: ReturnType<typeof deriveBoxCallFingerprint>;
  try { fingerprint = deriveBoxCallFingerprint(input.uid, input.canonicalBody); }
  catch { throw new BoxToolFirstRoundError("BOX_TOOL_IDENTITY_MISSING"); }
  const plan = makeBoxDetachedToolPlan({ body, upstreamModel: input.upstreamModel,
    maxOutputTokensLimit: cap, supervisorAsset: deps.supervisorAsset,
    keeperAsset: deps.keeperAsset, virtualMcpAsset: deps.virtualMcpAsset,
    detachedRunnerAsset: deps.detachedRunnerAsset });
  const budget = deps.budgetMs ?? 900_000;
  if (!Number.isSafeInteger(budget) || budget < 60_000 || budget > 900_000) {
    throw new BoxToolFirstRoundError("BOX_TOOL_BUDGET_INVALID");
  }
  const startedAt = Date.now();
  const remaining = () => Math.max(0, budget - (Date.now() - startedAt));
  const abort = new AbortController();
  const onClientAbort = (): void => abort.abort();
  input.init.signal?.addEventListener("abort", onClientAbort, { once: true });
  if (input.init.signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), budget);
  const signal = abort.signal;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(
      new BoxToolFirstRoundError("BOX_TOOL_ABORTED")), { once: true });
  });
  void aborted.catch(() => {});
  const race = <T>(value: Promise<T>): Promise<T> => Promise.race([value, aborted]);
  let target: BoxResolvedTarget | null = null;
  let admitted = false, launchAttempted = false, inputStageStarted = false;
  let prestartClosed = false;
  let unknownNotified = false;
  const unknown = async (phase: string): Promise<void> => {
    if (!admitted || !target || unknownNotified) return;
    unknownNotified = true;
    deps.retainUnknownTarget({ target, plan, uid: input.uid,
      requestId: input.requestId });
    const observed = Promise.allSettled([
      deps.journal.markUnknown({ requestId: input.requestId, uid: input.uid,
        leaseEpoch: plan.leaseEpoch, phase }),
      deps.onUnknown({ uid: input.uid, accountId: target.accountId,
        requestId: input.requestId, phase }),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([observed, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 200);
    })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const run = async (request: Parameters<BoxResolvedTarget["exec"]["run"]>[0],
    timeoutMs = 20_000) => {
    if (!target || signal.aborted || remaining() < 1000) {
      throw new BoxToolFirstRoundError("BOX_TOOL_ABORTED");
    }
    return race(target.exec.run(request, { timeoutMs: Math.min(timeoutMs, remaining()),
      maxResponseBytes: 1_048_576, signal }));
  };
  const prestart = async (): Promise<void> => {
    if (!target || !admitted) return;
    if (inputStageStarted) {
      try {
        const cleaned = await target.exec.run(plan.cleanup, { timeoutMs: 20_000,
          maxResponseBytes: 4096 });
        if (cleaned.stdout.trim() !== "clean") throw new Error("cleanup mismatch");
      } catch { await unknown("prestart_cleanup_unknown"); return; }
    }
    try { await deps.journal.markPrestartStopped({ requestId: input.requestId,
      uid: input.uid, leaseEpoch: plan.leaseEpoch }); prestartClosed = true; }
    catch { await unknown("prestart_journal_unknown"); }
  };
  try {
    if (signal.aborted) throw new BoxToolFirstRoundError("BOX_TOOL_ABORTED");
    const pendingTarget = deps.resolveTarget({ uid: input.uid, sessionId: input.sessionId,
      requestId: input.requestId, upstreamModel: input.upstreamModel, signal });
    let resolutionAbandoned = false;
    void pendingTarget.then((late) => {
      if (resolutionAbandoned && late !== target) {
        void Promise.resolve(late.dispose?.()).catch(() => {});
      }
    }, () => {});
    try { target = await race(pendingTarget); }
    finally { resolutionAbandoned = true; }
    const pendingAdmission = deps.journal.admit({ requestId: input.requestId, uid: input.uid,
      accountId: target.accountId, model: input.canonicalModel, fingerprint,
      runNonce: plan.runNonce, leaseEpoch: plan.leaseEpoch });
    // A timed-out admission can commit after the HTTP caller has left. No
    // model launch follows it, so its late success is safe to prestart-close.
    void pendingAdmission.then(() => {
      if (signal.aborted && !admitted) void deps.journal.markPrestartStopped({
        requestId: input.requestId, uid: input.uid, leaseEpoch: plan.leaseEpoch }).catch(() => {});
    }, () => {});
    await race(pendingAdmission);
    admitted = true;
    try {
      for (const [request, expected] of [
        [plan.stageSupervisor, plan.supervisorHash],
        [plan.stageKeeper, plan.keeperHash],
        [plan.stageVirtualMcp, plan.virtualMcpHash],
        [plan.stageDetachedRunner, plan.detachedRunnerHash],
      ] as const) {
        const staged = await run(request);
        if (staged.stdout.trim() !== expected) {
          throw new BoxToolFirstRoundError("BOX_TOOL_ASSET_STAGE_INVALID");
        }
      }
      inputStageStarted = true;
      for (const request of plan.stageInputs) await run(request);
      if (signal.aborted || remaining() < 60_000) {
        throw new BoxToolFirstRoundError("BOX_TOOL_BUDGET_EXHAUSTED");
      }
      await race(deps.journal.markRunning({ requestId: input.requestId, uid: input.uid,
        leaseEpoch: plan.leaseEpoch }));
    } catch (error) {
      if (error instanceof BoxExecTransportError && !error.terminalKnown) {
        await unknown("stage_transport_unknown");
      } else await prestart();
      throw error;
    }
    launchAttempted = true;
    const launch = await run(plan.launch);
    if (launch.stdout.trim() !== "launched") {
      throw new BoxToolFirstRoundError("BOX_TOOL_LAUNCH_UNKNOWN");
    }
    const decoder = new BoxCliToolHandoffDecoder(plan.expectedModel, plan.catalog);
    for await (const line of pollBoxSpoolLines({ exec: target.exec, access: plan,
      startOffset: 0, deadlineMs: Math.max(1, remaining()), signal })) {
      const decoded = decoder.push(line.text);
      if (decoded.sse) input.emit(decoded.sse);
      if (!decoded.candidate) continue;
      const candidate = decoded.candidate;
      const pending = new Set<string>();
      const pendingDeadline = Date.now() + Math.min(5000, remaining());
      while (pending.size === 0 && Date.now() < pendingDeadline && !signal.aborted) {
        for (const use of candidate.toolUses) {
          try {
            const result = await run(makeBoxPendingRead(plan.cwd, use.id));
            parseBoxPendingCall(result.stdout, use);
            pending.add(use.id);
          } catch (error) {
            if (!(error instanceof BoxExecTransportError && error.terminalKnown)) throw error;
          }
        }
        if (pending.size === 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      if (pending.size === 0) throw new BoxToolFirstRoundError("BOX_TOOL_PENDING_UNPROVEN");
      const proof = await race(deps.journal.recordToolHandoff({ requestId: input.requestId,
        uid: input.uid, leaseEpoch: plan.leaseEpoch, candidate, roundNo: 1,
        spoolOffset: line.endOffset, detachedRunnerHash: plan.detachedRunnerHash,
        catalogHash: plan.catalog.bindingSha256,
        verifiedPendingToolUseIds: [...pending] }));
      input.emit(decoder.commitHandoff(proof));
      return { plan, target, candidate, spoolOffset: line.endOffset };
    }
    throw new BoxToolFirstRoundError("BOX_TOOL_STREAM_INCOMPLETE");
  } catch (error) {
    if (launchAttempted) await unknown("first_round_unknown");
    if ((!admitted || prestartClosed) && target) {
      await Promise.resolve(target.dispose?.()).catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.init.signal?.removeEventListener("abort", onClientAbort);
  }
}
