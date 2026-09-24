/** Off-by-default Box text transport behind the existing internal Messages
 * identity/authority/precheck/finalizer. Account selection and durable lease
 * journal are injected; do not enable without the latter's production wiring.
 */
import type { BoxExecTransport, BoxExecResult } from "./boxExecTransport.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import { BoxInvocationRegistry, type BoxInvocationLease } from "./boxInvocationRegistry.js";
import { createBoxCliSseDecoder } from "./boxCliSse.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import { makeBoxTextPlan } from "./boxTextPlan.js";
import type { ProxyBody } from "./shared.js";
import { rootLogger } from "../../logging/logger.js";

type ExecRunner = Pick<BoxExecTransport, "run">;
const log = rootLogger.child({ subsys: "box-text-fetch" });
export interface BoxResolvedTarget {
  accountId: bigint;
  exec: ExecRunner;
  /** Only close after authoritative remote terminal evidence, or before open. */
  dispose?: () => void | Promise<void>;
}
const MIN_RUN_BUDGET_MS = 140_000; // 120s Exec + 20s bounded cleanup
export class BoxTextFetchError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxTextFetchError"; }
}

export class BoxTextFetch {
  private readonly orphanedTargets = new Set<BoxResolvedTarget>();
  private readonly disposal = new WeakMap<BoxResolvedTarget,
    { done: boolean; pending: Promise<void> | null }>();
  constructor(private readonly deps: {
    supervisorAsset: Buffer;
    registry: BoxInvocationRegistry;
    maxOutputTokensForModel: (model: string) => number | null;
    resolveTarget: (args: { uid: bigint; sessionId: string | null; requestId: string;
      upstreamModel: string; signal: AbortSignal }) => Promise<BoxResolvedTarget>;
    onUnknown: (args: { uid: bigint; sessionId: string; accountId: bigint;
      requestId: string; phase: string }) => Promise<void>;
    now?: () => number;
    budgetMs?: number;
  }) {}

  /** Manual, bounded-reconcile hook for targets acquired after cancellation or
   * before a lease. Failed closes remain owned here; never silently discarded. */
  async retryFailedOrphanCleanup(): Promise<number> {
    const retryable = [...this.orphanedTargets].filter((target) =>
      this.disposal.get(target)?.pending === null);
    const attempts = Promise.allSettled(retryable.map((target) => this.disposeTarget(target).then(() => {
      this.orphanedTargets.delete(target);
    })));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([attempts, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 200);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    return this.orphanedTargets.size;
  }

  /** Internal reconciliation entry; identity must come from a trusted journal,
   * never an untrusted HTTP payload. */
  retryFailedCleanup(input: { uid: bigint; sessionId: string;
    accountId: bigint }): Promise<void> {
    return this.deps.registry.retryFailedCleanupByIdentity(input);
  }

  private disposeTarget(target: BoxResolvedTarget): Promise<void> {
    let state = this.disposal.get(target);
    if (!state) { state = { done: false, pending: null }; this.disposal.set(target, state); }
    if (state.done) return Promise.resolve();
    if (state.pending) return state.pending;
    const current = state;
    current.pending = Promise.resolve().then(() => target.dispose?.()).then(() => {
      current.done = true;
      current.pending = null;
    }, (error: unknown) => {
      current.pending = null;
      throw error;
    });
    return current.pending;
  }

  private closeOrphan(target: BoxResolvedTarget): void {
    this.orphanedTargets.add(target);
    void this.disposeTarget(target).then(() => {
      this.orphanedTargets.delete(target);
    }, () => {
      log.error("BOX_EGRESS_ORPHAN_DISPOSE_FAILED");
    });
  }

  async fetch(args: { uid: bigint; sessionId: string | null; requestId: string;
    url: string; init: RequestInit }): Promise<Response> {
    if (args.url !== BOX_INTERNAL_ENDPOINT || args.init.method !== "POST"
      || typeof args.init.body !== "string") {
      throw new BoxTextFetchError("BOX_FETCH_REQUEST_INVALID");
    }
    let body: ProxyBody;
    try { body = JSON.parse(args.init.body) as ProxyBody; }
    catch { throw new BoxTextFetchError("BOX_FETCH_REQUEST_INVALID"); }
    const cap = this.deps.maxOutputTokensForModel(body.model);
    if (cap === null) throw new BoxTextFetchError("BOX_MODEL_NOT_CONFIGURED");
    const plan = makeBoxTextPlan({ body, upstreamModel: body.model,
      maxOutputTokensLimit: cap, supervisorAsset: this.deps.supervisorAsset });
    const now = this.deps.now ?? Date.now;
    const budgetMs = this.deps.budgetMs ?? 600_000;
    if (!Number.isSafeInteger(budgetMs) || budgetMs < MIN_RUN_BUDGET_MS || budgetMs > 900_000) {
      throw new BoxTextFetchError("BOX_BUDGET_INVALID");
    }
    const deadlineAt = now() + budgetMs;
    const remaining = (): number => Math.max(0, deadlineAt - now());
    const abort = new AbortController();
    const onClientAbort = (): void => abort.abort();
    args.init.signal?.addEventListener("abort", onClientAbort, { once: true });
    if (args.init.signal?.aborted) abort.abort();
    const timer = setTimeout(() => abort.abort(), budgetMs);
    const aborted = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(
        new BoxTextFetchError("BOX_FETCH_ABORTED")), { once: true });
    });
    void aborted.catch(() => {});
    const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
    let lease: BoxInvocationLease | null = null;
    let resolved: BoxResolvedTarget | null = null;
    let resolutionAbandoned = false;
    let completedTarget: BoxResolvedTarget | null = null;
    let clientLeaseListener: (() => void) | null = null;
    let streamHandedOff = false, unknownNotified = false, localCleaned = false;
    const cleanupLocal = (): void => {
      if (localCleaned) return;
      localCleaned = true;
      resolutionAbandoned = true;
      if (completedTarget && completedTarget !== resolved) this.closeOrphan(completedTarget);
      if (resolved && !lease) this.closeOrphan(resolved);
      clearTimeout(timer);
      args.init.signal?.removeEventListener("abort", onClientAbort);
      if (clientLeaseListener) abort.signal.removeEventListener("abort", clientLeaseListener);
    };
    const markUnknown = async (phase: string): Promise<void> => {
      if (!lease || !resolved) return;
      const held = lease, target = resolved;
      if (held.state === "completed" || held.state === "stopped_cleanup_pending"
        || held.state === "stopped_cleanup_failed") return;
      try { this.deps.registry.markUnknown(held); } catch { /* already stopped */ }
      if (unknownNotified) return;
      unknownNotified = true;
      // Durable notification must be initiated, but an unhealthy journal may
      // not hold a *verified successful* SSE hostage after its model finished.
      const notification = Promise.resolve().then(() => this.deps.onUnknown({ uid: args.uid,
        sessionId: held.sessionId, accountId: target.accountId,
        requestId: args.requestId, phase }));
      const observed = notification.then(() => {}, () => {});
      const waitMs = Math.min(200, remaining());
      if (waitMs <= 0) return;
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([observed, new Promise<void>((resolve) => {
          waitTimer = setTimeout(resolve, waitMs);
        })]);
      } finally { if (waitTimer) clearTimeout(waitTimer); }
    };
    const exec = async (request: Parameters<ExecRunner["run"]>[0],
      timeoutMs: number, useLeaseSignal = true,
      onStdout?: (chunk: string) => void): Promise<BoxExecResult> => {
      const left = remaining();
      if (left < 1000) throw new BoxTextFetchError("BOX_BUDGET_EXHAUSTED");
      return resolved!.exec.run(request, { timeoutMs: Math.max(1000, Math.min(timeoutMs, left)),
        maxResponseBytes: 1_048_576,
        ...(onStdout ? { onStdout } : {}),
        ...(useLeaseSignal && lease ? { signal: lease.signal } : {}) });
    };
    const cleanupKnown = async (): Promise<boolean> => {
      try {
        const result = await exec(plan.cleanup, 20_000, false);
        return result.stdout.trim() === "clean";
      } catch { return false; }
    };
    try {
      if (abort.signal.aborted) throw new BoxTextFetchError("BOX_FETCH_ABORTED");
      try {
        const pendingTarget = this.deps.resolveTarget({ uid: args.uid,
          sessionId: args.sessionId, requestId: args.requestId,
          upstreamModel: body.model, signal: abort.signal });
        // A resolver may ignore cancellation and finish after the HTTP budget.
        // Observe and release that target rather than leaking a ProxyAgent.
        void pendingTarget.then((target) => {
          completedTarget = target;
          if (resolutionAbandoned) this.closeOrphan(target);
        }, () => {});
        resolved = await race(pendingTarget);
      } catch (error) {
        if (error instanceof BoxTextFetchError) throw error;
        throw new BoxTextFetchError("BOX_TARGET_UNAVAILABLE");
      }
      if (abort.signal.aborted || remaining() < MIN_RUN_BUDGET_MS) {
        throw new BoxTextFetchError("BOX_BUDGET_EXHAUSTED");
      }
      const leaseSessionId = args.sessionId ?? args.requestId;
      lease = this.deps.registry.open({ uid: args.uid, sessionId: leaseSessionId,
        accountId: resolved.accountId, leaseMs: remaining(),
        onRemoteStopped: () => this.disposeTarget(resolved!) });
      const currentLease = lease;
      clientLeaseListener = () => {
        if (currentLease.state !== "completed") void markUnknown("request_abort");
      };
      abort.signal.addEventListener("abort", clientLeaseListener, { once: true });

      // No model process exists during staging. Unknown Exec transport still
      // forbids cleanup/retry because a write may remain in flight.
      let inputStageStarted = false;
      try {
        const supervisor = await exec(plan.stageSupervisor, 20_000);
        if (supervisor.stdout.trim() !== plan.supervisorHash) {
          throw new BoxTextFetchError("BOX_SUPERVISOR_STAGE_INVALID");
        }
        inputStageStarted = true;
        for (const step of plan.stageInputs) await exec(step, 20_000);
      } catch (error) {
        const provenStageTerminal = (error instanceof BoxExecTransportError && error.terminalKnown)
          || (error instanceof BoxTextFetchError && error.code === "BOX_SUPERVISOR_STAGE_INVALID");
        if (!provenStageTerminal) {
          await markUnknown("staging_unknown");
        } else if (!inputStageStarted) {
          // Only the global content-addressed supervisor asset was touched;
          // no private cwd or model process exists to clean up.
          this.deps.registry.confirmRemoteStopped(lease);
        } else if (await cleanupKnown()) {
          this.deps.registry.confirmRemoteStopped(lease);
        } else {
          await markUnknown("staging_cleanup_unknown");
        }
        throw new BoxTextFetchError("BOX_STAGING_FAILED");
      }
      // The shared absolute budget includes all prior stage calls. Do not
      // start a paid model if it cannot finish its own bounded supervisor.
      if (remaining() < MIN_RUN_BUDGET_MS || abort.signal.aborted) {
        if (await cleanupKnown()) this.deps.registry.confirmRemoteStopped(lease);
        else await markUnknown("pre_run_cleanup_unknown");
        throw new BoxTextFetchError("BOX_BUDGET_EXHAUSTED");
      }
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const decoder = createBoxCliSseDecoder(plan.expectedModel);
          let remoteTerminalKnown = false;
          const emit = (sse: string): void => {
            if (sse) controller.enqueue(Buffer.from(sse, "utf8"));
          };
          void (async () => {
            try {
              try {
                await exec(plan.run, 120_000, true, (chunk) => emit(decoder.push(chunk)));
                remoteTerminalKnown = true;
              } catch {
                // A failed Connect Exec or failed stream consumer does not prove
                // the remote supervisor and descendants stopped. Never retry.
                await markUnknown(abort.signal.aborted ? "request_abort" : "model_outcome_unknown");
                throw new BoxTextFetchError(abort.signal.aborted
                  ? "BOX_FETCH_ABORTED" : "BOX_MODEL_OUTCOME_UNKNOWN");
              }
              let converted: ReturnType<typeof decoder.finish>;
              try { converted = decoder.finish(); }
              catch {
                // Full Connect exit0 proves watcher completion even if the CLI
                // protocol body is invalid. No terminal SSE or final usage.
                if (await cleanupKnown()) this.deps.registry.confirmRemoteStopped(currentLease);
                else await markUnknown("protocol_cleanup_unknown");
                throw new BoxTextFetchError("BOX_MODEL_PROTOCOL_INVALID");
              }
              // A verified model result is billable even if post-run GC is
              // uncertain; record unknown but do not erase final usage.
              if (await cleanupKnown()) this.deps.registry.confirmRemoteStopped(currentLease);
              else await markUnknown("completed_gc_unknown");
              emit(converted.tailSse);
              controller.close();
            } catch (error) {
              if (!remoteTerminalKnown) await markUnknown("model_stream_unknown");
              try { controller.error(error instanceof BoxTextFetchError ? error
                : new BoxTextFetchError("BOX_MODEL_STREAM_FAILED")); }
              catch { /* downstream already cancelled */ }
            } finally { cleanupLocal(); }
          })();
        },
        cancel: () => { abort.abort(); },
      });
      streamHandedOff = true;
      return new Response(stream, { status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    } finally {
      if (!streamHandedOff) cleanupLocal();
    }
  }
}
