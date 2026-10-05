/** Internal Box tool transport on the existing OpenClaude Messages route.
 * OpenClaude remains the agent/tool/memory/Skill owner; Box runs only Claude
 * Code's model process. This is off-route until real Box acceptance, remote
 * cleanup/reconciliation and production wiring pass T2 audit. */
import { BOX_API_RESOLVE_MODEL } from "./boxNativeContextOwner.js";
import type { BoxMcpAliasMode } from "./boxToolCatalog.js";
import type { BoxDurableJournal, BoxRemoteCleanupCandidate,
  BoxPrelaunchRecoveryCandidate, BoxNativeGcCandidate } from "./boxDurableJournal.js";
import { runBoxToolFirstRound, type BoxToolFirstHandoff,
  type BoxToolFirstFinal } from "./boxToolFirstRound.js";
import { publishBoxToolResume, type BoxToolPublishedResume } from "./boxToolResumePublish.js";
import { runBoxToolContinuation } from "./boxToolContinuation.js";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";
import { makeBoxNativeGcDelete, parseBoxNativeGcResult } from "./boxNativeGcFile.js";
import { prepareBoxContinuation, preparedMatchesBody,
  BoxContinuationDecisionError, type PreparedContinuation } from "./boxPreparedContinuation.js";
import { makeBoxPrelaunchCleanup } from "./boxPrelaunchControl.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import type { ProxyBody } from "./shared.js";
import type { BoxReplayMessageWriter } from "./boxReplayMessageFile.js";
import { classifyBoxContinuation } from "./boxPreparedContinuation.js";
import { deriveBoxCallFingerprint } from "./boxCallFingerprint.js";
import { BoxDurableJournalError } from "./boxDurableJournal.js";
import { BoxToolResultEchoError } from "./boxToolResultEcho.js";
import type { BoxToolResumeClaim } from "./boxDurableJournal.js";
import { rootLogger } from "../../logging/logger.js";

const fetchLog = rootLogger.child({ subsys: "box-tool-fetch" });

type FetchArgs = { uid: bigint; sessionId: string | null; requestId: string;
  canonicalModel: string; canonicalBody: ProxyBody; upstreamModel: string;
  url: string; init: RequestInit; prepared?: PreparedContinuation };
type First = typeof runBoxToolFirstRound;
type Publish = typeof publishBoxToolResume;
type Continue = typeof runBoxToolContinuation;

function routeClass(args: FetchArgs): PreparedContinuation["classification"] {
  if (args.prepared && !preparedMatchesBody(args.prepared, args.canonicalBody)) {
    throw new BoxContinuationDecisionError("reject", "BOX_PREPARED_STALE");
  }
  const view = args.prepared ?? prepareBoxContinuation({
    uid: args.uid, canonicalModel: args.canonicalModel, rawBody: args.canonicalBody,
    authorityKind: "local_catalog", authorityTurnId: null,
  });
  if (view.classification === "reject") {
    throw new BoxContinuationDecisionError("reject",
      ("rejectCode" in view ? view.rejectCode : null) ?? "BOX_PREPARED_REJECT");
  }
  return view.classification;
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
  private readonly nativeGcInFlight = new Set<string>();
  private readonly cleanup = new Set<{ target: BoxResolvedTarget;
    pending: Promise<void>; failed: boolean }>();
  constructor(private readonly deps: {
    supervisorAsset: Buffer;
    keeperAsset: Buffer;
    virtualMcpAsset: Buffer;
    detachedRunnerAsset: Buffer;
    toolAliasMode?: BoxMcpAliasMode;
    journal: BoxDurableJournal;
    writeMessage?: BoxReplayMessageWriter;
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
    /** OCV5-299: explicit stop for a locally rejected first-round stream. */
    stopRejectedRun?: Parameters<First>[1]["stopRejectedRun"];
    /** OCV5-313: how long a failed continuation waits for stopRejectedRun. */
    echoStopWaitMs?: number;
    /** OCV5-304: stop an orphaned handoff exactly as the user's Stop does. */
    stopOrphanRun?: (identity: { requestId: string; uid: bigint; accountId: bigint;
      runNonce: string; leaseEpoch: string }) => Promise<"stopped_proven" | "completed_unsettled" | "pending">;
  }) {}

  /** OCV5-313 (#1a28c670): the CLI echoed tool results this request cannot
   * bind, so the request fails and nothing the CLI writes afterwards can be
   * delivered. Left alone it kept running for an hour and held the session.
   * Stop it through the same explicit-stop path as a user Stop (durable intent,
   * original keeper, keeper proof, failed_stopped chain). The wait is bounded;
   * a stop that takes longer keeps running and is still observed. An unproven
   * stop leaves the leaf unknown (phase continuation_echo_rejected) for the
   * cleanup worker. */
  private async stopEchoRejected(args: FetchArgs, claim: BoxToolResumeClaim): Promise<void> {
    const stop = this.deps.stopRejectedRun;
    if (!stop) return;
    const waitMs = this.deps.echoStopWaitMs ?? 25_000;
    const fields = { requestId: args.requestId, accountId: claim.accountId.toString() };
    let late = false;
    const observed = Promise.resolve().then(() => stop({ requestId: args.requestId,
      uid: args.uid, accountId: claim.accountId, runNonce: claim.runNonce,
      leaseEpoch: claim.leaseEpoch })).then((outcome) => {
      fetchLog.warn("box_echo_rejected_stop", { ...fields, outcome, late });
    }, (error: unknown) => {
      fetchLog.error("box_echo_rejected_stop", { ...fields, outcome: "error", late,
        reason: error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
          ? error.message : "error" });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([observed, new Promise<void>((resolve) => {
      timer = setTimeout(() => { late = true; resolve(); }, waitMs);
    })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  /** OCV5-304: a recovered dispatch resent tool results that only the earlier,
   * finished dispatch's handoff could have received. Claim that exchange (one
   * recovery only), stop its orphaned run exactly as the user's Stop does,
   * and let this request continue it as a fresh invocation. Returns false,
   * keeping the original rejection, unless all of that is proven. */
  private async releaseOrphanedExchange(args: FetchArgs, error: unknown): Promise<boolean> {
    if (!(error instanceof Error) || (error as { code?: unknown }).code !== "BOX_TOOL_OWNER_UNKNOWN") {
      return false;
    }
    let toolIds: readonly string[], sessionId: string, turnKey: string;
    try {
      const classified = classifyBoxContinuation(args.canonicalBody);
      const fingerprint = deriveBoxCallFingerprint(args.uid, args.canonicalBody);
      if (classified.classification !== "continuation_candidate") return false;
      toolIds = classified.toolIds; sessionId = fingerprint.sessionId; turnKey = fingerprint.turnKey;
    } catch { return false; }
    return await this.releaseOrphan(args, { toolIds, sessionId, turnKey }) === "released";
  }

  /** OCV5-322: an answered exchange arrives together with a new prompt. It may
   * run fresh only when no handoff of this turn still waits for the results
   * and any orphaned earlier handoff is claimed and proven stopped first. */
  private async admitAnsweredExchange(args: FetchArgs, toolIds: readonly string[]): Promise<void> {
    const journal = this.deps.journal;
    let sessionId: string, turnKey: string;
    try {
      ({ sessionId, turnKey } = deriveBoxCallFingerprint(args.uid, args.canonicalBody));
    } catch {
      throw new BoxContinuationDecisionError("reject", "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
    }
    if (!journal.hasWaitingToolHandoff
      || await journal.hasWaitingToolHandoff({ uid: args.uid, sessionId, turnKey, toolIds })
      || await this.releaseOrphan(args, { toolIds, sessionId, turnKey }) === "held") {
      throw new BoxContinuationDecisionError("reject", "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
    }
  }

  private async releaseOrphan(args: FetchArgs, exchange: { toolIds: readonly string[];
    sessionId: string; turnKey: string }): Promise<"released" | "none" | "held"> {
    const journal = this.deps.journal;
    if (!this.deps.stopOrphanRun || !journal.findOrphanToolHandoff
      || !journal.claimOrphanRecovery || !journal.releaseOrphanRecovery) return "held";
    const orphan = await journal.findOrphanToolHandoff({ uid: args.uid, ...exchange });
    if (orphan.kind === "claimed") throw new BoxDurableJournalError("BOX_RESUME_IN_PROGRESS");
    if (orphan.kind === "none") return "none";
    if (orphan.kind !== "orphan") return "held";
    const claim = { requestId: orphan.identity.requestId, uid: args.uid, by: args.requestId };
    if (!(await journal.claimOrphanRecovery({ ...claim,
      ...(orphan.staleClaim ? { replacing: orphan.staleClaim } : {}) }))) {
      throw new BoxDurableJournalError("BOX_RESUME_IN_PROGRESS");
    }
    if (orphan.stopped) return "released";
    let outcome: "stopped_proven" | "completed_unsettled" | "pending" = "pending";
    try { outcome = await this.deps.stopOrphanRun(orphan.identity); } catch { /* unproven */ }
    if (outcome === "stopped_proven") return "released";
    await journal.releaseOrphanRecovery(claim).catch(() => {});
    return "held";
  }

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
    BoxPrelaunchRecoveryCandidate | BoxNativeGcCandidate): Promise<BoxResolvedTarget> {
    const timeoutMs = this.deps.cleanupResolveTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("BOX_CLEANUP_RESOLVE_BUDGET_INVALID");
    }
    const abort = new AbortController();
    const pending = Promise.resolve().then(() => this.deps.resolveTarget({ uid: candidate.uid,
      sessionId: null, requestId: candidate.requestId,
      upstreamModel: "pointer" in candidate ? candidate.pointer.upstreamModel
        : BOX_API_RESOLVE_MODEL, requiredAccountId: candidate.accountId,
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

  /** Expired native cache privacy GC. This is intentionally independent of
   * the model launch flag, never wakes Box, and never invokes paid Claude. */
  async reconcileNativeGc(limit = 10): Promise<number> {
    const candidates = await this.deps.journal.listNativeGcCandidates(limit);
    await Promise.allSettled(candidates.map(async (candidate) => {
      if (this.nativeGcInFlight.has(candidate.requestId)) return;
      this.nativeGcInFlight.add(candidate.requestId);
      let target: BoxResolvedTarget | null = null;
      try {
        if (!await this.deps.journal.claimNativeGc(candidate)) return;
        target = await this.resolveCleanupTarget(candidate);
        if (target.accountId !== candidate.accountId) {
          throw new Error("BOX_NATIVE_GC_ACCOUNT_MISMATCH");
        }
        const pending = target.exec.run(makeBoxNativeGcDelete(candidate.pointer), {
          timeoutMs: 20_000, maxResponseBytes: 1024 });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: Awaited<typeof pending>;
        try { result = await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("BOX_NATIVE_GC_TIMEOUT")), 20_500);
        })]); }
        finally { if (timer) clearTimeout(timer); }
        const outcome = parseBoxNativeGcResult(result.stdout);
        if (!await this.deps.journal.finishNativeGc(candidate,
          outcome === "blocked" ? "blocked" : "done")) {
          throw new Error("BOX_NATIVE_GC_FENCE_LOST");
        }
      } finally {
        this.nativeGcInFlight.delete(candidate.requestId);
        if (target) this.closeUnusedTarget(target);
      }
    }));
    return candidates.length;
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
    let responseReady = false;
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve; readyReject = reject;
    });
    const acknowledge = (): void => {
      if (responseReady) return;
      responseReady = true;
      readyResolve();
    };
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
          let published: BoxToolPublishedResume | null = null;
          let resumeToolResults = false;
          const route = routeClass(args);
          const answered = route === "fresh" ? (args.prepared
            ? args.prepared.answeredToolIds
            : classifyBoxContinuation(args.canonicalBody).answeredToolIds) : undefined;
          if (answered?.length) {
            await this.admitAnsweredExchange(args, answered);
            resumeToolResults = true;
          }
          if (route === "continuation_candidate") {
            try {
            published = await (this.deps.publishResume
              ?? publishBoxToolResume)({ ...args, init }, {
              journal: this.deps.journal,
              resolveTarget: (input) => this.deps.resolveTarget({ ...input,
                allowWakeIfHibernated: true }),
              retainUnknownTarget: ({ target, claim }) => this.own(claim.runNonce,
                target, args.uid, claim.leaseEpoch),
              onUnknown: this.deps.onUnknown,
            });
            } catch (error) {
              // OCV5-304: no claim was made and nothing launched; a recovered
              // dispatch continues the exchange as a fresh Box invocation.
              if (!(await this.releaseOrphanedExchange(args, error))) throw error;
              resumeToolResults = true;
            }
          }
          if (published) {
            this.own(published.claim.runNonce, published.target,
              args.uid, published.claim.leaseEpoch);
            acknowledge(); // the existing CLI received the durable tool-result handoff
            const claim = published.claim;
            const result = await (this.deps.runContinuation ?? runBoxToolContinuation)({
              published, uid: args.uid, requestId: args.requestId,
              canonicalBody: args.canonicalBody, upstreamModel: args.upstreamModel,
              signal: abort.signal, emit, prepared: args.prepared,
            }, { journal: this.deps.journal,
              writeMessage: this.deps.writeMessage,
              retainUnknownTarget: ({ published: held }) =>
                this.own(held.claim.runNonce, held.target,
                  args.uid, held.claim.leaseEpoch),
              onUnknown: this.deps.onUnknown }).catch(async (error: unknown) => {
              if (error instanceof BoxToolResultEchoError) {
                await this.stopEchoRejected(args, claim);
              }
              throw error;
            });
            if (result.kind === "final") {
              await this.releaseAfterProof({ requestId: args.requestId,
                uid: args.uid, accountId: published.claim.accountId,
                runNonce: published.claim.runNonce,
                leaseEpoch: published.claim.leaseEpoch, proof: result.proof,
                ...(result.nativePointer ? { nativePointer: result.nativePointer } : {}) });
            }
          } else {
            const outcome: BoxToolFirstHandoff | BoxToolFirstFinal = await (this.deps.runFirst
              ?? runBoxToolFirstRound)({ ...args, init, emit, onLaunchAck: acknowledge,
                ...(resumeToolResults ? { resumeToolResults: true } : {}) }, {
              supervisorAsset: this.deps.supervisorAsset,
              keeperAsset: this.deps.keeperAsset,
              virtualMcpAsset: this.deps.virtualMcpAsset,
              detachedRunnerAsset: this.deps.detachedRunnerAsset,
              toolAliasMode: this.deps.toolAliasMode,
              journal: this.deps.journal,
              writeMessage: this.deps.writeMessage,
              maxOutputTokensForModel: this.deps.maxOutputTokensForModel,
              resolveTarget: (input) => this.deps.resolveTarget({ ...input,
                allowWakeIfHibernated: true }),
              onUnknown: this.deps.onUnknown,
              retainUnknownTarget: ({ target, plan }) => this.own(plan.runNonce,
                target, args.uid, plan.leaseEpoch),
              retainCleanupTarget: (handle) => this.retainCleanup(handle),
              ...(this.deps.stopRejectedRun ? { stopRejectedRun: this.deps.stopRejectedRun } : {}),
            });
            acknowledge(); // injected completed runner compatibility; live path acks at launch
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
          if (!responseReady) {
            // Before headers, caller cancellation is still a client abort.
            // Preserve that classification rather than cooling the Box
            // account for a user pressing Stop during staging/launch.
            readyReject(args.init.signal?.aborted
              ? Object.assign(new Error("BOX_TOOL_CLIENT_ABORTED"), {
                name: "AbortError", cause: error }) : error);
          }
          try { controller.error(error); } catch { /* downstream already cancelled */ }
        }).finally(() => {
          args.init.signal?.removeEventListener("abort", onAbort);
        });
      },
      cancel: () => { abort.abort(); },
    });
    await ready;
    return new Response(stream, { status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
}
