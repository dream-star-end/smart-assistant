/**
 * OCV5-893 — Local Fallback Transport & Billing Preparation for Codex and Antigravity.
 *
 * Extracted from `userChatBridge.ts` to keep the bridge under the file-size ratchet cap
 * while strictly matching the billing, route-minting, single-flight slot, and compensation
 * invariants of the native local Codex and Antigravity admission paths.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { parseSwarmSlashCommand } from "@openclaude/protocol";
import type { Pool } from "pg";
import { getAgentCostMultiplier } from "../billing/agentMultiplier.js";
import { resolveLocalSwarmAllowedAntigravityModels } from "../billing/antigravityRouteContext.js";
import { abandonAntigravityTurn, recordAntigravityTurn } from "../billing/antigravitySettle.js";
import {
  DURABLE_CODEX_RECOVERY_VERSION,
  makeCodexFinalizer,
  permanentCodexWaiverReason,
  type CodexFinalizeHandle,
} from "../billing/codexFinalizer.js";
import {
  composeCodexTurnPricing,
  extractInboundPromptText,
  resolveTakenOverCodexBilling,
} from "../billing/codexServiceTierPricing.js";
import type { ModelCatalogSnapshot } from "../billing/modelCatalog.js";
import { serializeBillingPricing } from "../billing/persistedBillingPricing.js";
import {
  estimateMaxCost,
  preCheckWithCost,
  readTotalSpendableBalance,
  releasePreCheck,
  type PreCheckRedis,
  type ReservationHandle,
} from "../billing/preCheck.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import {
  abortInflightJournal,
  readJournalForTakeover,
  startInflightJournal,
  type BillingAuthorityStamp,
  type JournalFailureCode,
} from "../billing/proxyBilling.js";
import {
  admitVerificationSponsorship,
  serializeVerificationSponsorshipSnapshot,
} from "../billing/verificationSponsorship.js";
import type { Logger } from "../logging/logger.js";
import { releaseInflight } from "../account-pool/policy/affinity.js";
import type {
  LocalFallbackCommittedHandle,
  PreparedLocalFallbackTransport,
} from "./userChatBridgeRemotePoolSeal.js";
import type { ModelCheckerHandle } from "./userChatBridgeTypes.js";

export interface FallbackWireOutcome {
  readonly wireSent: boolean;
  readonly handedOff?: boolean;
  readonly reason: string;
}

export type FallbackWireOutcomeHandler = (outcome: FallbackWireOutcome) => void;

export interface FallbackWireTracker {
  readonly onWireOutcome: FallbackWireOutcomeHandler;
  readonly onSyncForwardResult: (accepted: boolean, reason?: string) => Promise<void>;
  readonly onPreForwardAbort: (reason: string) => Promise<void>;
  readonly isWireSent: () => boolean;
}

/**
 * OCV5-893 B4: Coordinates pre-forward abort, synchronous send failure, `preopenQueue`
 * cleanup drop, recovery PG-post-handoff failure, and asynchronous `ws.send(..., cb)`
 * failure/success for a committed local-fallback transport handle.
 * - Any proven pre-wire failure (`preopenQueue` drop, sync throw/false BEFORE transport
 *   handoff, async `cb(err)`) triggers `handle.compensate(reason)` exactly once.
 * - Once the frame is handed off to `containerWs.send` or `preopenQueue` (`handedOff: true`),
 *   a later PG failure in `forwardRecoveryUnderRootFence` must NEVER trigger early compensation;
 *   only an explicit `wireSent: false` callback proves the frame did not reach the wire.
 * - Once `wireSent: true` is confirmed (or delivery is unknown after handoff to the
 *   kernel socket), compensation is never erroneously invoked (normal terminal/reconciler
 *   settlement owns billing).
 */
export function createLocalFallbackWireTracker(args: {
  readonly getHandle: () => LocalFallbackCommittedHandle | null;
  readonly onWireConfirmed?: (handle: LocalFallbackCommittedHandle) => void;
  readonly log?: Logger | null;
}): FallbackWireTracker {
  let settled = false;
  let wireSent = false;
  let handedOffToTransport = false;

  const compensateOnce = async (reason: string): Promise<void> => {
    const h = args.getHandle();
    if (!h) return;
    h.onForwarded?.(false);
    try {
      await h.compensate(reason);
    } catch (err) {
      args.log?.error("user-chat-bridge: local fallback wire compensation failed", {
        reason,
        engine: h.localEngine,
        err,
      });
    }
  };

  return {
    onWireOutcome(outcome: FallbackWireOutcome): void {
      if (outcome.handedOff === true) {
        handedOffToTransport = true;
        return;
      }
      if (settled) return;
      settled = true;
      if (outcome.wireSent) {
        wireSent = true;
        const h = args.getHandle();
        if (h) {
          h.onForwarded?.(true);
          args.onWireConfirmed?.(h);
        }
        return;
      }
      void compensateOnce(outcome.reason);
    },
    async onSyncForwardResult(accepted: boolean, reason = "container_forward_rejected"): Promise<void> {
      if (accepted || settled || handedOffToTransport) return;
      settled = true;
      await compensateOnce(reason);
    },
    async onPreForwardAbort(reason: string): Promise<void> {
      if (settled || handedOffToTransport) return;
      settled = true;
      await compensateOnce(reason);
    },
    isWireSent(): boolean {
      return wireSent;
    },
  };
}

const CODEX_FALLBACK_PRECHECK_TOKEN_ESTIMATE = 64_000;

const GROK_LEASE_ENGINES: Readonly<Record<string, boolean>> = Object.freeze({
  grok: true,
});

export interface LocalFallbackResolvedExec {
  readonly canonicalModel: string;
  readonly engine: string;
  readonly placement: "local" | "remote_pool";
  readonly pricing: ModelPricing;
  readonly billingRevision: string;
  readonly executionRevision: string;
  readonly securityEpoch: number;
}

export interface LocalFallbackActiveCodexTurnState {
  stateId: string;
  peerKey: string;
  peerId: string | null;
  clientMessageId: string | null;
  promptQueueGrantId: string | null;
  engine: "codex" | "grok";
  acquireInflight: boolean;
  acquiredAccountId: bigint | null;
  acquiredSlotId: string | null;
  apiRelayRouteToken: string | null;
  billingRequestId: string | null;
  turnForwarded: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  slotHeartbeat: ReturnType<typeof setInterval> | null;
}

export interface LocalFallbackCodexTurnSnapshot {
  requestId: string;
  model: string;
  accountId: bigint;
  traceId: string;
  codexRouteToken: string | null;
  releaseBridgeTurnState?: (reason: string) => boolean;
  authority: BillingAuthorityStamp | null;
  authorityTurnId: string | null;
  getFinalizer(engineSessionId: string): CodexFinalizeHandle | null;
  abandon(reason: string, failureCode?: JournalFailureCode): Promise<void>;
}

export interface LocalFallbackAntigravityRelayEntry {
  token: string;
  modelId: string;
  sessionId: string | null;
  traceId: string;
}

export interface LocalFallbackCodexBindingHandle {
  acquire(
    containerId: number,
    groupId?: string | null,
  ): Promise<{ account_id: bigint; slotId: string } | null>;
  renew?(account_id: bigint, slotId: string): boolean;
  release(account_id: bigint, slotId: string): void;
}

export type LocalFallbackCodexRouteDecision =
  | {
      kind?: "api_relay";
      engine?: "codex" | "grok";
      token: string;
      baseUrl: string;
      modelProvider: string;
      providerName?: string | null;
      wireApi?: "responses" | "chat";
      preferredAuthMethod?: "apikey" | "chatgpt";
      disableResponseStorage?: boolean;
      groupId: string;
      credentialId: string;
      accountId?: string;
      slotId?: string;
    }
  | { kind: "official_oauth"; groupId: string }
  | { kind: "unavailable"; reason: string };

export interface BridgeLocalFallbackTransportContext {
  readonly localExec: LocalFallbackResolvedExec;
  readonly billingRequestId?: string;
  readonly authorityTurnId?: string;
  readonly uid: bigint;
  readonly containerId: number;
  readonly peerId: string | null;
  readonly clientMessageId: string | null;
  readonly promptQueueGrantId: string | null;
  readonly agentId: string | null;
  readonly traceId: string;
  readonly parsedCapture: Record<string, unknown>;
  readonly enrichedParsed: Record<string, unknown>;
  readonly dispatchRecord:
    | {
        readonly dispatchId: string;
        readonly billingRequestId: string;
        readonly attemptNo: number;
        readonly clientMessageId: string;
      }
    | undefined;
  readonly recoveryJob: { readonly recoveryMode?: string } | undefined;
  readonly containerHasCodexSpeedTiers: boolean;
  readonly codexBillingEnabled: boolean;
  readonly sessionMaxMs: number;
  readonly pgPool?: Pool;
  readonly preCheckRedis?: PreCheckRedis;
  readonly pricing?: PricingCache;
  readonly codexBinding?: LocalFallbackCodexBindingHandle;
  readonly createCodexRoute?: (args: {
    containerId: number;
    userId: bigint;
    modelId: string;
    sessionId?: string;
  }) => Promise<LocalFallbackCodexRouteDecision | null>;
  readonly admitAntigravityTurn?: (args: {
    containerId: number;
    userId: bigint;
    requestId: string;
    modelId: string;
    budgetCredits: bigint;
    allowedModelIds?: readonly string[];
  }) => Promise<{
    token: string;
    baseUrl: string;
    accessToken: string;
    accessTokenExpiresAt: string;
    idToken: string | null;
    allowedModelIds?: readonly string[];
  }>;
  readonly expireAntigravityRoute?: (token: string) => void | Promise<void>;
  readonly activeCodexTurnsByPeer: Map<string, LocalFallbackActiveCodexTurnState>;
  readonly inflightCodexTurns: Map<string, LocalFallbackCodexTurnSnapshot>;
  readonly pendingAntigravityRelays: Map<string, LocalFallbackAntigravityRelayEntry>;
  readonly codexPeerKey: (peerId: string | null) => string;
  readonly isCurrentCodexTurnState: (state: LocalFallbackActiveCodexTurnState) => boolean;
  readonly releaseCodexTurnState: (
    state: LocalFallbackActiveCodexTurnState,
    reason: string,
    expireRouteTokenOnRelease?: boolean,
    preserveAccountSlot?: boolean,
  ) => void;
  readonly expireCodexRouteToken: (token: string | null, reason: string) => void;
  readonly retryPendingGrokLeaseRelease: (requestId: string) => void;
  readonly modelCheckerHandle: ModelCheckerHandle | null;
  readonly catalogSnapshot: ModelCatalogSnapshot | null;
  readonly isCleaned: () => boolean;
  readonly log: Logger | null;
  /** Test seam for reading spendable balance; defaults to `readTotalSpendableBalance`. */
  readonly readSpendableBalance?: (uid: bigint) => Promise<bigint>;
  /** Test seam for Codex preCheck; defaults to `preCheckWithCost`. */
  readonly preCheckWithCostFn?: typeof preCheckWithCost;
  /** Test seam for Antigravity per-account inflight release; defaults to `releaseInflight`. */
  readonly releaseInflightFn?: (token: string) => void;
}

function fallbackCodexAbandonFailureCode(reason: string): JournalFailureCode {
  if (reason.startsWith("bridge_disconnect_") || reason.startsWith("prompt_queue_")) {
    return "CLIENT_ABORT";
  }
  if (reason === "rewritten_frame_too_big") return "INVALID_REQUEST";
  if (reason === "container_forward_rejected") return "UPSTREAM_UNAVAILABLE";
  return "INTERNAL_ERROR";
}

async function prepareCodexLocalFallbackTransport(
  ctx: BridgeLocalFallbackTransportContext,
): Promise<PreparedLocalFallbackTransport | null> {
  if (ctx.isCleaned()) return null;
  // Fail-closed: never allow local Codex fallback without both a local Codex route/binding
  // AND the full commercial Codex billing triad (pgPool + preCheckRedis + pricing).
  if (ctx.codexBinding === undefined && ctx.createCodexRoute === undefined) {
    return null;
  }
  if (!ctx.codexBillingEnabled || !ctx.pgPool || !ctx.preCheckRedis || !ctx.pricing) {
    return null;
  }

  const peerKey = ctx.codexPeerKey(ctx.peerId);
  if (ctx.activeCodexTurnsByPeer.has(peerKey)) {
    return null;
  }

  const codexTurnState: LocalFallbackActiveCodexTurnState = {
    stateId: randomUUID(),
    peerKey,
    peerId: ctx.peerId,
    clientMessageId: ctx.clientMessageId,
    promptQueueGrantId: ctx.promptQueueGrantId,
    engine: "codex",
    acquireInflight: true,
    acquiredAccountId: null,
    acquiredSlotId: null,
    apiRelayRouteToken: null,
    billingRequestId: null,
    turnForwarded: false,
    releaseTimer: null,
    slotHeartbeat: null,
  };
  ctx.activeCodexTurnsByPeer.set(peerKey, codexTurnState);

  const pgPool = ctx.pgPool;
  const preCheckRedis = ctx.preCheckRedis;
  let reservationToRelease: ReservationHandle | null = null;
  let journalRequestId: string | null = null;

  const unwindOnPrepareError = async (reason: string): Promise<void> => {
    if (journalRequestId !== null) {
      const reqId = journalRequestId;
      journalRequestId = null;
      ctx.inflightCodexTurns.delete(reqId);
      await abortInflightJournal(
        pgPool,
        reqId,
        permanentCodexWaiverReason(reason),
        fallbackCodexAbandonFailureCode(reason),
      ).catch(() => {});
    }
    if (reservationToRelease !== null) {
      const res = reservationToRelease;
      reservationToRelease = null;
      await releasePreCheck(preCheckRedis, res).catch(() => {});
    }
    ctx.releaseCodexTurnState(codexTurnState, reason);
  };

  try {
    let codexRoute: Extract<LocalFallbackCodexRouteDecision, { token: string }> | null = null;
    let officialOAuthGroupId: string | null = null;

    if (ctx.createCodexRoute !== undefined) {
      const decision = await ctx.createCodexRoute({
        containerId: ctx.containerId,
        userId: ctx.uid,
        modelId: ctx.localExec.canonicalModel,
        ...(ctx.peerId ? { sessionId: ctx.peerId } : {}),
      });
      if (!ctx.isCurrentCodexTurnState(codexTurnState)) {
        if (
          decision !== null &&
          decision.kind !== "official_oauth" &&
          decision.kind !== "unavailable"
        ) {
          ctx.expireCodexRouteToken(decision.token, "stale_fallback_route_creation");
        }
        await unwindOnPrepareError("stale_fallback_route_creation");
        return null;
      }
      if (decision !== null) {
        if (decision.kind === "official_oauth") {
          officialOAuthGroupId = decision.groupId;
        } else if (decision.kind === "unavailable") {
          await unwindOnPrepareError("codex_fallback_route_unavailable");
          return null;
        } else {
          if (decision.engine !== undefined && GROK_LEASE_ENGINES[decision.engine] === true) {
            ctx.expireCodexRouteToken(decision.token, "unexpected_grok_route_on_codex_fallback");
            await unwindOnPrepareError("unexpected_grok_route_on_codex_fallback");
            return null;
          }
          codexRoute = decision;
          codexTurnState.engine = "codex";
          codexTurnState.apiRelayRouteToken = decision.token;
        }
      }
    }

    let acquired: { account_id: bigint; slotId: string } | null = null;
    if (codexRoute === null) {
      if (ctx.codexBinding === undefined) {
        await unwindOnPrepareError("codex_fallback_binding_missing");
        return null;
      }
      acquired = await ctx.codexBinding.acquire(ctx.containerId, officialOAuthGroupId);
      if (!ctx.isCurrentCodexTurnState(codexTurnState)) {
        if (acquired !== null) {
          try {
            ctx.codexBinding.release(acquired.account_id, acquired.slotId);
          } catch {
            /* best effort */
          }
        }
        await unwindOnPrepareError("stale_fallback_acquire");
        return null;
      }
      if (officialOAuthGroupId !== null && acquired === null) {
        await unwindOnPrepareError("codex_fallback_oauth_group_unavailable");
        return null;
      }
    }

    if (acquired !== null) {
      codexTurnState.acquiredAccountId = acquired.account_id;
      codexTurnState.acquiredSlotId = acquired.slotId;
    }
    codexTurnState.acquireInflight = false;
    codexTurnState.releaseTimer = setTimeout(() => {
      ctx.releaseCodexTurnState(codexTurnState, "timeout");
    }, ctx.sessionMaxMs);
    codexTurnState.releaseTimer.unref?.();

    const effectiveModel = ctx.localExec.canonicalModel;
    const modelPricing = ctx.localExec.pricing ?? ctx.pricing.get(effectiveModel);
    if (!modelPricing) {
      await unwindOnPrepareError("codex_fallback_pricing_missing");
      return null;
    }

    const agentForCharge = ctx.agentId ?? "codex";
    const agentMul = await getAgentCostMultiplier(pgPool, agentForCharge);
    if (!ctx.isCurrentCodexTurnState(codexTurnState)) {
      await unwindOnPrepareError("stale_fallback_multiplier");
      return null;
    }

    let { pricing: derivedPricing, serviceTier: turnServiceTier } = composeCodexTurnPricing(
      modelPricing,
      agentMul,
      effectiveModel,
      ctx.enrichedParsed.serviceTier,
      {
        agentId: ctx.agentId ?? "main",
        collabMode: ctx.enrichedParsed.collabMode,
        advisorModel: ctx.enrichedParsed.advisorModel,
        text: extractInboundPromptText(ctx.enrichedParsed),
        gatewaySupportsSpeedTiers: ctx.containerHasCodexSpeedTiers,
      },
    );

    const requestId =
      ctx.billingRequestId ??
      ctx.dispatchRecord?.billingRequestId ??
      randomBytes(16).toString("hex");
    codexTurnState.billingRequestId = requestId;

    const verificationSponsorship = await admitVerificationSponsorship(pgPool, {
      requestId,
      userId: ctx.uid,
      model: effectiveModel,
      sessionId: ctx.peerId,
    });
    if (!ctx.isCurrentCodexTurnState(codexTurnState)) {
      await unwindOnPrepareError("stale_fallback_sponsorship");
      return null;
    }

    const maxCost = estimateMaxCost(CODEX_FALLBACK_PRECHECK_TOKEN_ESTIMATE, derivedPricing);
    const runPreCheck = ctx.preCheckWithCostFn ?? preCheckWithCost;
    const preCheckResult = await runPreCheck(preCheckRedis, {
      userId: ctx.uid,
      requestId,
      maxCost,
    });
    reservationToRelease = preCheckResult.reservation;

    if (!ctx.isCurrentCodexTurnState(codexTurnState)) {
      await unwindOnPrepareError("stale_fallback_precheck");
      return null;
    }

    const accountIdForQuota = acquired !== null ? acquired.account_id : 0n;
    const authorityTurnId = ctx.authorityTurnId ?? null;

    const admitted = await startInflightJournal(pgPool, {
      requestId,
      userId: ctx.uid,
      containerId: BigInt(ctx.containerId),
      model: effectiveModel,
      precheckCredits: preCheckResult.maxCost,
      ctxJson: {
        agentId: agentForCharge,
        codexAccountId: accountIdForQuota === 0n ? null : accountIdForQuota.toString(),
        source: "codex_bridge",
        crossPoolFallback: true,
        durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
        billingPricing: serializeBillingPricing(derivedPricing),
        ...(turnServiceTier ? { serviceTier: turnServiceTier } : {}),
        ...(verificationSponsorship === null
          ? {}
          : {
              verificationSponsorship:
                serializeVerificationSponsorshipSnapshot(verificationSponsorship),
            }),
        traceId: ctx.traceId,
        ...(ctx.dispatchRecord
          ? {
              dispatchId: ctx.dispatchRecord.dispatchId,
              attemptNo: ctx.dispatchRecord.attemptNo,
            }
          : {}),
        authorityKind: "bridge_signed",
        authorityTurnId,
        billingRequestId: requestId,
        executionRevision: ctx.localExec.executionRevision,
        billingRevision: ctx.localExec.billingRevision,
        securityEpoch: String(ctx.localExec.securityEpoch),
      },
      ...(ctx.dispatchRecord
        ? {
            dispatchId: ctx.dispatchRecord.dispatchId,
            attemptNo: ctx.dispatchRecord.attemptNo,
          }
        : {}),
    });

    if (!admitted) {
      let reuseAsTakenOver = false;
      if (ctx.dispatchRecord !== undefined) {
        const existing = await readJournalForTakeover(pgPool, requestId).catch(() => null);
        const takeover = resolveTakenOverCodexBilling(
          existing,
          {
            userId: ctx.uid.toString(),
            dispatchId: ctx.dispatchRecord.dispatchId,
            attemptNo: ctx.dispatchRecord.attemptNo,
            model: effectiveModel,
            gatewaySupportsSpeedTiers: ctx.containerHasCodexSpeedTiers,
          },
          (tier) =>
            composeCodexTurnPricing(modelPricing, agentMul, effectiveModel, tier, {
              gatewaySupportsSpeedTiers: ctx.containerHasCodexSpeedTiers,
            }).pricing,
        );
        if (takeover.kind === "reuse") {
          reuseAsTakenOver = true;
          derivedPricing = takeover.pricing;
          turnServiceTier = takeover.serviceTier;
        }
      }
      if (!reuseAsTakenOver) {
        await unwindOnPrepareError("codex_fallback_journal_conflict");
        return null;
      }
    }
    journalRequestId = requestId;

    if (!ctx.isCurrentCodexTurnState(codexTurnState)) {
      await unwindOnPrepareError("bridge_disconnect_before_finalize");
      return null;
    }

    const reservationForTurn = preCheckResult.reservation;
    type SnapState =
      | { kind: "handle"; handle: CodexFinalizeHandle }
      | { kind: "abandoned"; promise: Promise<void> };
    let snapState: SnapState | null = null;
    const snap: LocalFallbackCodexTurnSnapshot = {
      requestId,
      model: effectiveModel,
      accountId: accountIdForQuota,
      traceId: ctx.traceId,
      codexRouteToken: codexRoute?.token ?? null,
      releaseBridgeTurnState(reason: string): boolean {
        if (!ctx.isCurrentCodexTurnState(codexTurnState)) {
          if (GROK_LEASE_ENGINES[codexTurnState.engine] === true) {
            ctx.retryPendingGrokLeaseRelease(requestId);
          }
          return false;
        }
        ctx.releaseCodexTurnState(codexTurnState, reason);
        return true;
      },
      authority: {
        executionRevision: ctx.localExec.executionRevision,
        projectionRevision: null,
        securityEpoch: BigInt(ctx.localExec.securityEpoch),
        kind: "bridge_signed",
      },
      authorityTurnId,
      getFinalizer(engineSessionIdFromFrame: string): CodexFinalizeHandle | null {
        if (snapState !== null) {
          return snapState.kind === "handle" ? snapState.handle : null;
        }
        const handle = makeCodexFinalizer({
          pgPool,
          preCheckRedis,
          userId: ctx.uid,
          requestId,
          engineSessionId: engineSessionIdFromFrame,
          model: effectiveModel,
          derivedPricing,
          reservation: reservationForTurn,
          authority: snap.authority,
          dispatchId: ctx.dispatchRecord?.dispatchId ?? null,
          attemptNo: ctx.dispatchRecord?.attemptNo ?? null,
          verificationSponsorship,
        });
        snapState = { kind: "handle", handle };
        return handle;
      },
      async abandon(
        reason: string,
        failureCode = fallbackCodexAbandonFailureCode(reason),
      ): Promise<void> {
        if (snapState !== null) {
          if (snapState.kind === "handle") {
            await snapState.handle.fail(reason, failureCode);
            return;
          }
          await snapState.promise.catch(() => {});
          return;
        }
        const promise = (async (): Promise<void> => {
          try {
            await abortInflightJournal(
              pgPool,
              requestId,
              permanentCodexWaiverReason(reason),
              failureCode,
            );
          } catch {
            // Reconciler fallback handles residual inflight row if abort fails transiently.
          } finally {
            await releasePreCheck(preCheckRedis, reservationForTurn).catch(() => {});
          }
        })();
        snapState = { kind: "abandoned", promise };
        await promise;
      },
    };
    ctx.inflightCodexTurns.set(requestId, snap);

    const codexRouteFrame =
      codexRoute !== null
        ? {
            baseUrl: codexRoute.baseUrl,
            modelProvider: codexRoute.modelProvider,
            providerName: codexRoute.providerName ?? null,
            wireApi: codexRoute.wireApi ?? "responses",
            preferredAuthMethod: codexRoute.preferredAuthMethod ?? "apikey",
            disableResponseStorage: codexRoute.disableResponseStorage ?? true,
          }
        : officialOAuthGroupId !== null
          ? { kind: "official_oauth" as const }
          : null;

    let compensated = false;
    const compensate = async (reason: string): Promise<void> => {
      if (compensated) return;
      compensated = true;
      ctx.inflightCodexTurns.delete(requestId);
      try {
        await snap.abandon(reason);
      } catch (err) {
        ctx.log?.error("user-chat-bridge: codex local fallback abandon failed", {
          requestId,
          reason,
          err,
        });
      } finally {
        ctx.releaseCodexTurnState(codexTurnState, reason);
      }
    };

    const extraFrameFields: Record<string, unknown> = {
      requestId,
      _creditBudget: preCheckResult.balance.toString(),
      serviceTier: turnServiceTier ?? undefined,
      ...(codexRouteFrame !== null ? { __oc_codex_route: codexRouteFrame } : {}),
    };

    return {
      extraFrameFields,
      billingRequestId: requestId,
      compensate,
      onForwarded(forwarded: boolean): void {
        codexTurnState.turnForwarded = forwarded;
      },
    };
  } catch (err) {
    ctx.log?.warn("user-chat-bridge: codex local fallback transport preparation failed", {
      model: ctx.localExec.canonicalModel,
      err: err instanceof Error ? err.message : String(err),
    });
    await unwindOnPrepareError("codex_fallback_prepare_failed");
    return null;
  }
}

async function prepareAntigravityLocalFallbackTransport(
  ctx: BridgeLocalFallbackTransportContext,
): Promise<PreparedLocalFallbackTransport | null> {
  if (ctx.isCleaned()) return null;
  if (!ctx.pgPool || !ctx.admitAntigravityTurn) return null;

  const pgPool = ctx.pgPool;
  const antigravityModelId = ctx.localExec.canonicalModel;
  const requestId =
    ctx.billingRequestId ??
    ctx.dispatchRecord?.billingRequestId ??
    randomBytes(16).toString("hex");
  const readBalance = ctx.readSpendableBalance ?? readTotalSpendableBalance;
  const runReleaseInflight = ctx.releaseInflightFn ?? releaseInflight;

  let mintedToken: string | null = null;
  let inflightRequestId: string | null = null;
  let pendingRecordRequestId: string | null = null;
  let existedBeforePrepare = false;
  let recordedTurnOwned = false;
  let compensated = false;

  const dropMinted = async (): Promise<void> => {
    if (compensated) return;
    compensated = true;
    const tokenToExpire = mintedToken;
    const inflightToRelease = inflightRequestId;
    const reqToCheck = pendingRecordRequestId;
    const ownedNewRow = recordedTurnOwned;
    const wasReplay = existedBeforePrepare;
    mintedToken = null;
    inflightRequestId = null;
    pendingRecordRequestId = null;
    const tasks: Promise<unknown>[] = [];
    // OCV5-893 W3: Release per-account in-flight occupancy acquired by `admitAntigravityTurn`.
    if (inflightToRelease !== null) {
      try {
        runReleaseInflight(inflightToRelease);
      } catch {
        /* best effort */
      }
    }
    if (tokenToExpire !== null && ctx.expireAntigravityRoute) {
      tasks.push(Promise.resolve(ctx.expireAntigravityRoute(tokenToExpire)).catch(() => {}));
    }
    if (reqToCheck !== null) {
      ctx.pendingAntigravityRelays.delete(reqToCheck);
      if (!wasReplay) {
        if (ownedNewRow) {
          tasks.push(
            abandonAntigravityTurn(pgPool, reqToCheck, ctx.uid, ctx.traceId).catch(() => {}),
          );
        } else {
          // OCV5-893 W3: `recordAntigravityTurn` failed/lost ack after registration began;
          // read back PG by `(request_id, user_id)` and verify exact attempt ownership
          // (`pending` + matching model & traceId) before atomic trace-fenced abandon!
          tasks.push(
            (async () => {
              const check = await pgPool
                .query<{ status: string; model_id: string; trace_id: string | null }>(
                  `SELECT status, model_id, trace_id
                     FROM antigravity_turns
                    WHERE request_id = $1 AND user_id = $2`,
                  [reqToCheck, ctx.uid.toString()],
                )
                .catch(() => null);
              const row = check?.rows[0];
              if (
                row &&
                row.status === "pending" &&
                row.model_id === antigravityModelId &&
                row.trace_id === ctx.traceId
              ) {
                await abandonAntigravityTurn(pgPool, reqToCheck, ctx.uid, ctx.traceId).catch(
                  () => {},
                );
              }
            })(),
          );
        }
      }
    }
    await Promise.all(tasks);
  };

  try {
    const spendable = await readBalance(ctx.uid);
    if (spendable <= 0n || ctx.isCleaned()) {
      return null;
    }

    const rawSwarmText =
      ctx.parsedCapture.content &&
      typeof ctx.parsedCapture.content === "object" &&
      typeof (ctx.parsedCapture.content as { text?: unknown }).text === "string"
        ? (ctx.parsedCapture.content as { text: string }).text
        : "";
    const explicitSlashSwarm = Boolean(parseSwarmSlashCommand(rawSwarmText)?.matched);
    const isExplicitSwarmTurn = ctx.parsedCapture.swarmMode === true || explicitSlashSwarm;
    const isLegacyUnknownCheckpointRecovery =
      typeof ctx.parsedCapture.swarmMode !== "boolean" &&
      !explicitSlashSwarm &&
      ctx.recoveryJob?.recoveryMode === "checkpoint";
    const allowSwarmMemberModels = isExplicitSwarmTurn || isLegacyUnknownCheckpointRecovery;
    const forwardedSwarmMode: boolean | undefined = isExplicitSwarmTurn
      ? true
      : ctx.parsedCapture.swarmMode === false
        ? false
        : ctx.recoveryJob
          ? undefined
          : false;
    const catalogSnapshot = ctx.catalogSnapshot;
    const swarmAllowedModelIds = allowSwarmMemberModels
      ? resolveLocalSwarmAllowedAntigravityModels({
          primaryModelId: antigravityModelId,
          isAllowedForUser: ctx.modelCheckerHandle
            ? (id) => ctx.modelCheckerHandle!.isAllowed(id)
            : null,
          isCatalogRoutableLocal: catalogSnapshot
            ? (id) => {
                if (
                  !catalogSnapshot.isRoutable(id) ||
                  !catalogSnapshot.isAntigravityModel(id)
                ) {
                  return false;
                }
                const desc = catalogSnapshot.resolve(id);
                return (
                  desc !== null &&
                  desc.canonicalModel === id &&
                  desc.placement !== "remote_pool"
                );
              }
            : null,
          hasPricing: ctx.pricing ? (id) => ctx.pricing!.get(id) !== null : null,
        })
      : undefined;

    const minted = await ctx.admitAntigravityTurn({
      containerId: ctx.containerId,
      userId: ctx.uid,
      requestId,
      modelId: antigravityModelId,
      budgetCredits: spendable,
      ...(swarmAllowedModelIds ? { allowedModelIds: swarmAllowedModelIds } : {}),
    });
    mintedToken = minted.token;
    inflightRequestId = requestId;
    if (ctx.isCleaned()) {
      await dropMinted();
      return null;
    }

    // OCV5-893 W3: Register `pendingRecordRequestId` BEFORE calling `recordAntigravityTurn`,
    // and rely on atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING request_id` to prove
    // whether THIS attempt inserted the row vs. collided with a pre-existing replay row.
    pendingRecordRequestId = requestId;
    const recRes = await recordAntigravityTurn(pgPool, {
      requestId,
      userId: ctx.uid,
      modelId: antigravityModelId,
      sessionId: ctx.peerId,
      traceId: ctx.traceId,
    });
    if (recRes.inserted) {
      recordedTurnOwned = true;
    } else {
      // Conflict (0 rows inserted): verify the existing row is a compatible pending replay;
      // NEVER claim ownership of or abandon another attempt's row!
      existedBeforePrepare = true;
      recordedTurnOwned = false;
      const existingCheck = await pgPool
        .query<{ status: string; model_id: string; trace_id: string | null }>(
          `SELECT status, model_id, trace_id
             FROM antigravity_turns
            WHERE request_id = $1 AND user_id = $2`,
          [requestId, ctx.uid.toString()],
        )
        .catch(() => null);
      const existingRow = existingCheck?.rows[0];
      if (
        !existingRow ||
        existingRow.status !== "pending" ||
        existingRow.model_id !== antigravityModelId
      ) {
        await dropMinted();
        return null;
      }
    }
    ctx.pendingAntigravityRelays.set(requestId, {
      token: minted.token,
      modelId: antigravityModelId,
      sessionId: ctx.peerId,
      traceId: ctx.traceId,
    });
    if (ctx.isCleaned()) {
      await dropMinted();
      return null;
    }

    const extraFrameFields: Record<string, unknown> = {
      requestId,
      _creditBudget: spendable.toString(),
      __oc_antigravity_route: {
        baseUrl: minted.baseUrl,
        routeToken: minted.token,
        accessToken: minted.accessToken,
        accessTokenExpiresAt: minted.accessTokenExpiresAt,
        ...(minted.idToken ? { idToken: minted.idToken } : {}),
      },
      swarmMode: forwardedSwarmMode,
      ...(allowSwarmMemberModels
        ? { _antigravitySwarmAllowedModels: minted.allowedModelIds ?? [antigravityModelId] }
        : {}),
    };

    return {
      extraFrameFields,
      billingRequestId: requestId,
      compensate: async () => {
        await dropMinted();
      },
    };
  } catch (err) {
    ctx.log?.warn("user-chat-bridge: antigravity local fallback transport preparation failed", {
      model: antigravityModelId,
      err: err instanceof Error ? err.message : String(err),
    });
    await dropMinted();
    return null;
  }
}

const LOCAL_FALLBACK_TRANSPORT_PREPARERS: Readonly<
  Record<
    string,
    (ctx: BridgeLocalFallbackTransportContext) => Promise<PreparedLocalFallbackTransport | null>
  >
> = Object.freeze({
  codex: prepareCodexLocalFallbackTransport,
  antigravity: prepareAntigravityLocalFallbackTransport,
});

export async function prepareBridgeLocalFallbackTransport(
  ctx: BridgeLocalFallbackTransportContext,
): Promise<PreparedLocalFallbackTransport | null> {
  const preparer = Object.prototype.hasOwnProperty.call(
    LOCAL_FALLBACK_TRANSPORT_PREPARERS,
    ctx.localExec.engine,
  )
    ? LOCAL_FALLBACK_TRANSPORT_PREPARERS[ctx.localExec.engine]
    : undefined;
  if (!preparer) return null;
  return await preparer(ctx);
}
