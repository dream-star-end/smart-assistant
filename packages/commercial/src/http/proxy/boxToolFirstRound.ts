/** First paid Box tool round on the existing OpenClaude Messages path.
 * Off-route until the complete cross-HTTP resume/terminal coordinator passes
 * real Box acceptance. The remote CLI never executes OpenClaude tools. */
import { isDeepStrictEqual } from "node:util";
import { deriveBoxCallFingerprint, deriveBoxContextHash } from "./boxCallFingerprint.js";
import { makeBoxDetachedToolPlan, type BoxDetachedToolPlan } from "./boxDetachedToolPlan.js";
import { BoxCliToolHandoffDecoder, type BoxToolHandoffCandidate } from "./boxCliToolHandoff.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import type { BoxDurableJournal } from "./boxDurableJournal.js";
import { makeBoxPendingRead, parseBoxPendingCall } from "./boxToolResultPlan.js";
import { pollBoxSpoolLines } from "./boxSpoolPoller.js";
import { readBoxSpoolChunk } from "./boxSpoolRead.js";
import { readBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import { guardBoxPrivateStage, makeBoxPrelaunchBootstrap,
  makeBoxPrelaunchCleanup, makeBoxPrelaunchInit, parseBoxPrelaunchBootstrap,
  type BoxPrelaunchReceipt } from "./boxPrelaunchControl.js";
import { randomBytes } from "node:crypto";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import type { ProxyBody } from "./shared.js";

export class BoxToolFirstRoundError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolFirstRoundError"; }
}
export interface BoxToolFirstHandoff {
  readonly kind: "tool_handoff";
  readonly plan: BoxDetachedToolPlan;
  /** Must remain owned until nonce/epoch-bound remote terminal proof. */
  readonly target: BoxResolvedTarget;
  readonly candidate: BoxToolHandoffCandidate;
  readonly spoolOffset: number;
}
export interface BoxToolFirstFinal {
  readonly kind: "final";
  readonly plan: BoxDetachedToolPlan;
  readonly target: BoxResolvedTarget;
  readonly proof: BoxTerminalProof;
}
type Journal = Pick<BoxDurableJournal, "admit" |
  "markPrestartStopped" | "recordPrelaunchControl" | "armGuardedLaunch" |
  "markGuardedPrestartStopped" | "markUnknown" | "recordToolHandoff" | "complete">;

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
  /** Failed local-agent close remains explicitly owned for bounded retry. */
  retainCleanupTarget: (handle: { target: BoxResolvedTarget;
    pending: Promise<void>; uid: bigint; requestId: string; phase: string }) => void;
  budgetMs?: number;
}): Promise<BoxToolFirstHandoff | BoxToolFirstFinal> {
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
  let contextHash: string;
  try {
    fingerprint = deriveBoxCallFingerprint(input.uid, input.canonicalBody);
    contextHash = deriveBoxContextHash(input.canonicalBody);
  }
  catch { throw new BoxToolFirstRoundError("BOX_TOOL_IDENTITY_MISSING"); }
  // The durable digest must describe the request actually passed to the
  // remote CLI, not merely the handler snapshot used for identity checks.
  try {
    if (deriveBoxContextHash({ ...body, model: input.canonicalModel }) !== contextHash) {
      throw new BoxToolFirstRoundError("BOX_TOOL_FETCH_BINDING_INVALID");
    }
  } catch (error) {
    if (error instanceof BoxToolFirstRoundError) throw error;
    throw new BoxToolFirstRoundError("BOX_TOOL_FETCH_BINDING_INVALID");
  }
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
  let admitted = false, launchAttempted = false;
  let armAttempted = false;
  let prelaunchReceipt: BoxPrelaunchReceipt | null = null;
  let prestartClosed = false;
  let unknownNotified = false;
  type Disposal = { pending: Promise<void>; retained: boolean };
  const disposals = new WeakMap<BoxResolvedTarget, Disposal>();
  const retainCleanup = (owned: BoxResolvedTarget, state: Disposal,
    phase: string): void => {
    if (state.retained) return;
    state.retained = true;
    deps.retainCleanupTarget({ target: owned, pending: state.pending,
      uid: input.uid, requestId: input.requestId, phase });
  };
  const disposeOnce = (owned: BoxResolvedTarget, phase: string): Disposal => {
    const existing = disposals.get(owned);
    if (existing) return existing;
    const state: Disposal = { pending: Promise.resolve(), retained: false };
    const pending = Promise.resolve().then(() => owned.dispose?.()).then(() => {},
      (error: unknown) => {
        retainCleanup(owned, state, phase);
        throw error;
      });
    state.pending = pending;
    disposals.set(owned, state);
    return state;
  };
  const bounded = async <T>(pending: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([pending, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new BoxToolFirstRoundError(
        "BOX_TOOL_CLEANUP_TIMEOUT")), ms);
    })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const closeBounded = async (owned: BoxResolvedTarget, phase: string): Promise<void> => {
    const state = disposeOnce(owned, phase);
    try { await bounded(state.pending, 200); }
    catch (error) {
      if (error instanceof BoxToolFirstRoundError
        && error.code === "BOX_TOOL_CLEANUP_TIMEOUT") {
        retainCleanup(owned, state, phase);
      }
      throw error;
    }
  };
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
    if (prelaunchReceipt) {
      try {
        // Never use caller abort here: a timed-out private stage can still be
        // mutating remotely. CLEANED is emitted only under the same flock.
        const cleaned = await bounded(target.exec.run(
          makeBoxPrelaunchCleanup(prelaunchReceipt), {
          timeoutMs: 20_000, maxResponseBytes: 4096 }), 20_500);
        if (cleaned.stdout.trim() !== `cleaned:${prelaunchReceipt.identityHash}`) {
          throw new Error("cleanup receipt mismatch");
        }
        await bounded(deps.journal.markGuardedPrestartStopped({
          requestId: input.requestId, uid: input.uid, accountId: target.accountId,
          runNonce: plan.runNonce, leaseEpoch: plan.leaseEpoch,
          receipt: prelaunchReceipt, cleanedReceipt: cleaned.stdout.trim(),
        }), 2_000);
        prestartClosed = true;
      } catch { await unknown("prestart_cleanup_unknown"); }
      return;
    }
    try { await bounded(deps.journal.markPrestartStopped({ requestId: input.requestId,
      uid: input.uid, leaseEpoch: plan.leaseEpoch }), 2_000); prestartClosed = true; }
    catch { await unknown("prestart_journal_unknown"); }
  };
  try {
    if (signal.aborted) throw new BoxToolFirstRoundError("BOX_TOOL_ABORTED");
    const pendingTarget = deps.resolveTarget({ uid: input.uid, sessionId: input.sessionId,
      requestId: input.requestId, upstreamModel: input.upstreamModel, signal });
    let resolutionAbandoned = false;
    let completedTarget: BoxResolvedTarget | null = null;
    void pendingTarget.then((late) => {
      completedTarget = late;
      if (resolutionAbandoned) void closeBounded(late, "late_resolver").catch(() => {});
    }, () => {});
    try { target = await race(pendingTarget); }
    catch (error) {
      resolutionAbandoned = true;
      if (completedTarget) void closeBounded(completedTarget, "late_resolver").catch(() => {});
      throw error;
    }
    const pendingAdmission = deps.journal.admit({ requestId: input.requestId, uid: input.uid,
      accountId: target.accountId, model: input.canonicalModel, fingerprint,
      runNonce: plan.runNonce, leaseEpoch: plan.leaseEpoch,
      invocationMode: "detached_tool", contextHash });
    // A timed-out admission can commit after the HTTP caller has left. No
    // model launch follows it, so its late success is safe to prestart-close.
    void pendingAdmission.then(() => {
      if (signal.aborted && !admitted) void deps.journal.markPrestartStopped({
        requestId: input.requestId, uid: input.uid, leaseEpoch: plan.leaseEpoch }).catch(() => {});
    }, () => {});
    await race(pendingAdmission);
    admitted = true;
    let stageLabel = "before_stage";
    try {
      if (process.env.OC_BOX_ASSET_BATCH === "1") {
        stageLabel = "assets";
        const staged = await run(plan.stageAssets);
        if (staged.stdout.trim() !== plan.assetManifest) {
          throw new BoxToolFirstRoundError("BOX_TOOL_ASSET_STAGE_INVALID");
        }
      } else {
        for (const [label, request, expected] of [
          ["supervisor", plan.stageSupervisor, plan.supervisorHash],
          ["keeper", plan.stageKeeper, plan.keeperHash],
          ["virtual_mcp", plan.stageVirtualMcp, plan.virtualMcpHash],
          ["detached_runner", plan.stageDetachedRunner, plan.detachedRunnerHash],
        ] as const) {
          stageLabel = label;
          const staged = await run(request);
          if (staged.stdout.trim() !== expected) {
            throw new BoxToolFirstRoundError("BOX_TOOL_ASSET_STAGE_INVALID");
          }
        }
      }
      stageLabel = "prelaunch_bootstrap";
      const controlId = randomBytes(16).toString("hex");
      const bootstrap = await run(makeBoxPrelaunchBootstrap({
        runNonce: plan.runNonce, leaseEpoch: plan.leaseEpoch,
        accountId: target.accountId.toString(), controlId,
      }));
      prelaunchReceipt = parseBoxPrelaunchBootstrap(bootstrap.stdout, {
        runNonce: plan.runNonce, leaseEpoch: plan.leaseEpoch,
        accountId: target.accountId.toString(), controlId,
      });
      stageLabel = "prelaunch_journal";
      await race(deps.journal.recordPrelaunchControl({ requestId: input.requestId,
        uid: input.uid, accountId: target.accountId, runNonce: plan.runNonce,
        leaseEpoch: plan.leaseEpoch, receipt: prelaunchReceipt }));
      for (const [index, request] of plan.stageInputs.entries()) {
        stageLabel = `input_${index}`;
        if (index === 0) {
          if (request.args[3] !== plan.cwd || typeof request.args[4] !== "string") {
            throw new BoxToolFirstRoundError("BOX_TOOL_INIT_PLAN_INVALID");
          }
          await run(makeBoxPrelaunchInit(prelaunchReceipt, request.args[4]));
        } else {
          await run(guardBoxPrivateStage(request, prelaunchReceipt));
        }
      }
      if (signal.aborted || remaining() < 60_000) {
        throw new BoxToolFirstRoundError("BOX_TOOL_BUDGET_EXHAUSTED");
      }
      stageLabel = "launch_arm";
      armAttempted = true;
      await race(deps.journal.armGuardedLaunch({ requestId: input.requestId,
        uid: input.uid, accountId: target.accountId, runNonce: plan.runNonce,
        leaseEpoch: plan.leaseEpoch, receipt: prelaunchReceipt }));
    } catch (error) {
      // An arm CAS may have committed before its acknowledgement was lost.
      // Never clean remotely after that point without a separate proof that
      // the paid launch permit was not granted.
      if (armAttempted) {
        await unknown("launch_arm_unknown");
        throw error;
      }
      await prestart();
      if (!prestartClosed && error instanceof BoxExecTransportError
        && !error.terminalKnown) {
        await unknown(`stage_transport_unknown:${stageLabel}:${error.code}`);
      }
      throw error;
    }
    launchAttempted = true;
    const launch = await run(plan.launch);
    if (launch.stdout.trim() !== "launched") {
      throw new BoxToolFirstRoundError("BOX_TOOL_LAUNCH_UNKNOWN");
    }
    const decoder = new BoxCliToolHandoffDecoder(plan.expectedModel, plan.catalog,
      { allowFinal: true });
    for await (const line of pollBoxSpoolLines({ exec: target.exec, access: plan,
      startOffset: 0, deadlineMs: Math.max(1, remaining()), signal })) {
      const decoded = decoder.push(line.text);
      if (decoded.sse) input.emit(decoded.sse);
      if (decoded.finalCandidate) {
        const final = decoded.finalCandidate;
        let proof: BoxTerminalProof | null = null;
        const until = Date.now() + 20_000;
        while (!proof && Date.now() < until && !signal.aborted) {
          try { proof = await race(readBoxTerminalProof({ target,
            expectedAccountId: target.accountId, runNonce: plan.runNonce,
            leaseEpoch: plan.leaseEpoch, signal })); }
          catch (error) {
            if (!(error instanceof BoxExecTransportError && error.terminalKnown)) throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        }
        if (!proof || proof.reason !== "worker_complete") {
          throw new BoxToolFirstRoundError("BOX_TOOL_TERMINAL_UNPROVEN");
        }
        const trailing = await race(readBoxSpoolChunk({ exec: target.exec,
          plan, offset: line.endOffset, signal }));
        if (trailing.bytes.length !== 0) {
          throw new BoxToolFirstRoundError("BOX_TOOL_FINAL_TRAILING_BYTES");
        }
        decoder.finishFinal();
        const usage = { inputTokens: final.inputTokens,
          outputTokens: final.outputTokens, cacheReadTokens: final.cacheReadTokens,
          cacheWriteTokens: final.cacheWriteTokens };
        await race(deps.journal.complete({ requestId: input.requestId,
          uid: input.uid, leaseEpoch: plan.leaseEpoch, proof, usage }));
        input.emit(decoder.commitFinal({ terminalReason: proof.reason,
          journaledUsage: usage }));
        return { kind: "final", plan, target, proof };
      }
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
      return { kind: "tool_handoff", plan, target, candidate,
        spoolOffset: line.endOffset };
    }
    throw new BoxToolFirstRoundError("BOX_TOOL_STREAM_INCOMPLETE");
  } catch (error) {
    if (launchAttempted) await unknown("first_round_unknown");
    if ((!admitted || prestartClosed) && target) {
      await closeBounded(target, "prestart_dispose").catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.init.signal?.removeEventListener("abort", onClientAbort);
  }
}
