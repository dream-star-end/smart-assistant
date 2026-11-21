/**
 * WeChat Codex relay turns, Auto-Dream V2 optimizer runtime, QQ Official Bot, and
 * WeChat broker dependency builders for @openclaude/commercial.
 *
 * Extracted from packages/commercial/src/index.ts (OCV5-830).
 */
import type { DurableCodexBilling } from "@openclaude/protocol";
import {
  allMasterWsessRows,
  getWechatBindingByUserId,
  softDeleteMasterSession,
  upsertMasterClientSession,
} from "@openclaude/storage";
import type IORedis from "ioredis";
import {
  createCodexRouteContextForModel,
  expireCodexRouteContext,
  listEnabledGroupsForModel,
} from "../account-pool/groups.js";
import type { UserMediaLocation } from "../agent-sandbox/index.js";
import { V3_CONTAINER_PORT } from "../agent-sandbox/v3supervisor.js";
import { getUserSignalTrafficClass } from "../analytics/signalTraffic.js";
import { createPgIdentityRepo } from "../auth/containerIdentity.js";
import type { makeLoadUserModelAuthz } from "../auth/userModelAuthz.js";
import {
  applyAutoDreamPreferenceAction,
  reportAutoDreamPlatformFindings,
} from "../autoDream/optimizerStore.js";
import { composeMultiplier, getAgentCostMultiplier } from "../billing/agentMultiplier.js";
import { canUseModel } from "../billing/authzModels.js";
import {
  DURABLE_CODEX_RECOVERY_VERSION,
  deriveEngineSessionId,
  makeCodexFinalizer,
  type CodexFinalizeHandle,
} from "../billing/codexFinalizer.js";
import { settleDurableCodexBilling } from "../billing/durableCodexBilling.js";
import { serializeBillingPricing } from "../billing/persistedBillingPricing.js";
import {
  InsufficientCreditsError,
  estimateMaxCost,
  preCheckWithCost,
  releasePreCheck,
  type PreCheckRedis,
  type ReservationHandle,
} from "../billing/preCheck.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import { startInflightJournal, type JournalFailureCode } from "../billing/proxyBilling.js";
import {
  getFile as nodeAgentGetFile,
  resolveServiceableHostTarget,
} from "../compute-pool/nodeAgentClient.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";
import { getPool } from "../db/index.js";
import {
  AUTO_DREAM_OPTIMIZER_ABANDON_PATH,
  AUTO_DREAM_OPTIMIZER_ACTION_PATH,
  AUTO_DREAM_OPTIMIZER_ADMIT_PATH,
  AUTO_DREAM_OPTIMIZER_FINDINGS_PATH,
  AUTO_DREAM_OPTIMIZER_SETTLE_PATH,
  projectAutoDreamCodexRoute,
  type AutoDreamOptimizerRuntime,
} from "../http/internalAutoDreamOptimizer.js";
import { rootLogger } from "../logging/logger.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import type { ImRemoteControlHandler } from "../pendingDecisions/index.js";
import type { QqBotConfig } from "../qqbot/config.js";
import { makeSaveQqMediaToUserUploads } from "../qqbot/mediaIngest.js";
import { makeQqOutboundMediaResolver } from "../qqbot/outboundMedia.js";
import { makeQqOutboundReceiver, makeQqProactiveReceiver } from "../qqbot/receiver.js";
import { makeQqBotService, qqInboundChannelProfile, type QqBotService } from "../qqbot/service.js";
import { getPreferences, patchPreferences } from "../user/preferences.js";
import type { makeWechatBroker } from "../wechat/broker.js";
import { makeIlinkSendAdapter, makeIlinkSendMediaAdapter } from "../wechat/ilinkSendAdapter.js";
import { makeSaveWechatMediaToUserUploads } from "../wechat/imageIngest.js";
import {
  makeInboundDispatcher,
  type PrepareWechatCodexTurnResult,
} from "../wechat/inboundDispatcher.js";
import { handleWechatModelCommand } from "../wechat/modelCommand.js";
import { pickWechatInboundModel } from "../wechat/modelResolver.js";
import { makeNodeHttpContainerTransport } from "../wechat/nodeHttpContainerTransport.js";
import { makeWechatOutboundMediaResolver } from "../wechat/outboundMedia.js";
import {
  makeOutboundReceiverHandler,
  type WechatCodexBillingBody,
} from "../wechat/outboundReceiver.js";
import {
  canonicalWechatSenderId,
  makeProactiveReceiverHandler,
  type ProactiveReceiverHandler,
} from "../wechat/proactiveReceiver.js";
import { createNoopRateLimiter } from "../wechat/rateLimiter.js";
import { getCurrentSessionId } from "../wechat/sessionPointer.js";
import { MASTER_USER_PREFIX } from "../wechat/userIds.js";
import type { ResolveContainerEndpoint } from "../ws/userChatBridge.js";

const CODEX_PRECHECK_TOKEN_ESTIMATE = 64_000;
const DEFAULT_CODEX_SESSION_MAX_MS = 600_000;

export function createCommercialCodexAndWechatTurns(deps: {
  env: NodeJS.ProcessEnv;
  pricing: PricingCache;
  preCheckRedis: PreCheckRedis;
  randomBytesHex: (size: number) => string;
}) {
  const readCodexSessionMaxMs = (): number => {
    const raw = deps.env.CODEX_SESSION_MAX_MS;
    if (!raw) return DEFAULT_CODEX_SESSION_MAX_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_CODEX_SESSION_MAX_MS;
  };
  const newCodexRequestId = (): string => deps.randomBytesHex(16);
  const codexRouteLog = rootLogger.child({ subsys: "commercial", module: "codexRoute" });

  const createWechatApiRelayRoute = async (args: {
    containerId: number;
    userId: bigint;
    modelId: string;
  }) => {
    const groups = await listEnabledGroupsForModel({ modelId: args.modelId, provider: "codex" });
    for (const group of groups) {
      if (group.kind !== "api_relay") continue;
      const route = await createCodexRouteContextForModel({
        containerId: args.containerId,
        userId: args.userId,
        modelId: args.modelId,
        groupId: group.id,
      });
      if (!route) continue;
      return {
        token: route.token,
        routeFrame: {
          baseUrl: `http://127.0.0.1:${V3_CONTAINER_PORT}/internal/v3/codex-relay/route/${route.token}`,
          modelProvider: route.credential.model_provider,
          providerName: route.credential.provider_name ?? null,
          wireApi: route.credential.wire_api ?? "responses",
          preferredAuthMethod: route.credential.preferred_auth_method ?? "apikey",
          disableResponseStorage: route.credential.disable_response_storage ?? true,
        },
      };
    }
    return null;
  };

  type WechatCodexTurnSnapshot = {
    finalizer: CodexFinalizeHandle;
    reservation: ReservationHandle;
    requestId: string;
    userId: bigint;
    containerId: number;
    model: string;
    traceId: string;
    routeToken: string;
    timeout: ReturnType<typeof setTimeout>;
  };
  const wechatCodexTurns = new Map<string, WechatCodexTurnSnapshot>();

  const expireCodexRouteToken = (token: string | null | undefined, reason: string): void => {
    if (!token) return;
    expireCodexRouteContext(token).catch((err) => {
      codexRouteLog.warn("expire_codex_route_failed", {
        reason,
        errMessage: (err as Error)?.message ?? String(err),
      });
    });
  };

  const failWechatCodexTurn = async (requestId: string, reason: string): Promise<void> => {
    const snap = wechatCodexTurns.get(requestId);
    if (!snap) return;
    wechatCodexTurns.delete(requestId);
    clearTimeout(snap.timeout);
    const failureCode: JournalFailureCode =
      reason === "wechat_container_cold_start"
        ? "UPSTREAM_UNAVAILABLE"
        : reason.startsWith("wechat_container_rejected_") ||
            reason === "wechat_container_terminal_before_start"
          ? "UPSTREAM_REJECTED"
          : "INTERNAL_ERROR";
    try {
      await snap.finalizer.fail(reason, failureCode);
    } finally {
      expireCodexRouteToken(snap.routeToken, reason);
    }
  };

  const expireWechatCodexRecoverySnapshot = async (requestId: string): Promise<void> => {
    const snap = wechatCodexTurns.get(requestId);
    if (!snap) return;
    wechatCodexTurns.delete(requestId);
    clearTimeout(snap.timeout);
    await releasePreCheck(deps.preCheckRedis, snap.reservation).catch(() => {});
    expireCodexRouteToken(snap.routeToken, "wechat_codex_snapshot_expired");
  };

  const safeBillingNum = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
    return Math.trunc(v);
  };

  const handleWechatCodexBilling = async (
    body: WechatCodexBillingBody,
    identity: { userId: number; containerId: number },
  ): Promise<void> => {
    const pool = getPool();
    const journal = await pool.query<{
      user_id: string;
      container_id: string | null;
      ctx: unknown;
    }>(
      `SELECT user_id::text AS user_id, container_id::text AS container_id, ctx
         FROM request_finalize_journal WHERE request_id=$1`,
      [body.requestId],
    );
    const row = journal.rows[0];
    if (!row) throw new Error(`wechat codex billing journal missing for ${body.requestId}`);
    if (row.user_id !== String(identity.userId) || row.container_id !== String(identity.containerId)) {
      throw new Error(`wechat codex billing identity mismatch for ${body.requestId}`);
    }
    const ctx =
      row.ctx !== null && typeof row.ctx === "object" && !Array.isArray(row.ctx)
        ? (row.ctx as Record<string, unknown>)
        : {};
    const agentId =
      typeof ctx.agentId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(ctx.agentId)
        ? ctx.agentId
        : "codex";
    const derivedEngineSessionId = deriveEngineSessionId(
      `wechat:${identity.userId}:${identity.containerId}:${agentId}`,
    );
    const journalEngineSessionId =
      typeof ctx.engineSessionId === "string" && /^oceng-[0-9a-f]{48}$/.test(ctx.engineSessionId)
        ? ctx.engineSessionId
        : derivedEngineSessionId;
    if (body.engineSessionId !== undefined && body.engineSessionId !== journalEngineSessionId) {
      throw new Error(`wechat codex billing engine session mismatch for ${body.requestId}`);
    }
    const u = body.usage ?? {};
    const billing: DurableCodexBilling = {
      requestId: body.requestId,
      ...(body.turnKey ? { turnKey: body.turnKey } : {}),
      ...(body.parentTurnKey ? { parentTurnKey: body.parentTurnKey } : {}),
      ...(body.parentSessionId ? { parentSessionId: body.parentSessionId } : {}),
      ...(body.delegateAgentId ? { delegateAgentId: body.delegateAgentId } : {}),
      engineSessionId: journalEngineSessionId,
      status: body.status,
      ...(body.terminalCode !== undefined ? { terminalCode: body.terminalCode } : {}),
      durationMs: body.durationMs,
      usage: {
        input_tokens: safeBillingNum(u.input_tokens),
        output_tokens: safeBillingNum(u.output_tokens),
        reasoning_output_tokens: safeBillingNum(u.reasoning_output_tokens),
        cache_read_input_tokens: safeBillingNum(u.cache_read_input_tokens),
        cache_creation_input_tokens: safeBillingNum(u.cache_creation_input_tokens),
      },
      ...(body.rateLimits !== undefined ? { rateLimits: body.rateLimits } : {}),
    };
    try {
      await settleDurableCodexBilling(
        {
          pgPool: pool,
          preCheckRedis: deps.preCheckRedis,
          pricing: deps.pricing,
          logger: rootLogger.child({ subsys: "wechatDurableCodexBilling" }),
        },
        BigInt(identity.userId),
        billing,
      );
    } catch (err) {
      codexRouteLog.error("wechat_codex_finalizer_commit_failed", {
        requestId: body.requestId,
        errMessage: (err as Error)?.message ?? String(err),
      });
      throw err;
    }
    const snap = wechatCodexTurns.get(body.requestId);
    if (snap) {
      wechatCodexTurns.delete(body.requestId);
      clearTimeout(snap.timeout);
      expireCodexRouteToken(snap.routeToken, "wechat_codex_billing_settled");
    }
  };

  const prepareWechatCodexTurn = async (args: {
    containerId: number;
    bindingUserId: string;
    userId: bigint;
    modelId: string;
    agentId: string;
    traceId: string;
  }): Promise<PrepareWechatCodexTurnResult> => {
    const route = await createWechatApiRelayRoute(args);
    if (!route) {
      return {
        kind: "unavailable",
        reply: "GPT 模型通道暂时不可用，请稍后再试，或发送 /model 切换到其它模型。",
      };
    }

    const modelPricing = deps.pricing.get(args.modelId);
    if (!modelPricing) {
      expireCodexRouteToken(route.token, "wechat_codex_pricing_missing");
      return { kind: "unavailable", reply: "GPT 模型计费配置暂时不可用，请稍后再试。" };
    }

    const agentForCharge = args.agentId || "codex";
    let derivedPricing: ModelPricing;
    try {
      const agentMul = await getAgentCostMultiplier(getPool(), agentForCharge);
      derivedPricing = {
        ...modelPricing,
        multiplier: composeMultiplier(modelPricing.multiplier, agentMul),
      };
    } catch (err) {
      expireCodexRouteToken(route.token, "wechat_codex_multiplier_failed");
      codexRouteLog.error("wechat_codex_multiplier_failed", {
        agentId: agentForCharge,
        errMessage: (err as Error)?.message ?? String(err),
      });
      return { kind: "unavailable", reply: "GPT 模型计费配置暂时不可用，请稍后再试。" };
    }

    const requestId = newCodexRequestId();
    let maxCost: bigint;
    try {
      maxCost = estimateMaxCost(CODEX_PRECHECK_TOKEN_ESTIMATE, derivedPricing);
    } catch (err) {
      expireCodexRouteToken(route.token, "wechat_codex_estimate_failed");
      codexRouteLog.error("wechat_codex_estimate_failed", {
        errMessage: (err as Error)?.message ?? String(err),
      });
      return { kind: "unavailable", reply: "GPT 模型计费配置暂时不可用，请稍后再试。" };
    }

    let preCheckResult: Awaited<ReturnType<typeof preCheckWithCost>>;
    try {
      preCheckResult = await preCheckWithCost(deps.preCheckRedis, {
        userId: args.userId,
        requestId,
        maxCost,
      });
    } catch (err) {
      expireCodexRouteToken(route.token, "wechat_codex_precheck_failed");
      if (err instanceof InsufficientCreditsError) {
        return {
          kind: "unavailable",
          reply: "余额不足，请到网页端充值后再使用 GPT 模型，或发送 /model 切换其它模型。",
        };
      }
      codexRouteLog.error("wechat_codex_precheck_failed", {
        errMessage: (err as Error)?.message ?? String(err),
      });
      return { kind: "unavailable", reply: "GPT 模型计费检查暂时不可用，请稍后再试。" };
    }

    const engineSessionId = deriveEngineSessionId(
      `wechat:${args.bindingUserId}:${args.containerId}:${agentForCharge}`,
    );
    try {
      const admitted = await startInflightJournal(getPool(), {
        requestId,
        userId: args.userId,
        containerId: BigInt(args.containerId),
        model: args.modelId,
        precheckCredits: preCheckResult.maxCost,
        ctxJson: {
          agentId: agentForCharge,
          codexAccountId: null,
          source: "wechat_codex_api_relay",
          durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
          billingPricing: serializeBillingPricing(derivedPricing),
          engineSessionId,
        },
      });
      if (!admitted) {
        await releasePreCheck(deps.preCheckRedis, preCheckResult.reservation).catch(() => {});
        expireCodexRouteToken(route.token, "wechat_codex_journal_conflict");
        codexRouteLog.error("wechat_codex_journal_conflict", { requestId });
        return { kind: "unavailable", reply: "GPT 模型计费初始化暂时不可用，请稍后再试。" };
      }
    } catch (err) {
      await releasePreCheck(deps.preCheckRedis, preCheckResult.reservation).catch(() => {});
      expireCodexRouteToken(route.token, "wechat_codex_journal_failed");
      codexRouteLog.error("wechat_codex_journal_failed", {
        requestId,
        errMessage: (err as Error)?.message ?? String(err),
      });
      return { kind: "unavailable", reply: "GPT 模型计费初始化暂时不可用，请稍后再试。" };
    }

    const finalizer = makeCodexFinalizer({
      pgPool: getPool(),
      preCheckRedis: deps.preCheckRedis,
      userId: args.userId,
      requestId,
      engineSessionId,
      model: args.modelId,
      derivedPricing,
      reservation: preCheckResult.reservation,
    });
    const timeout = setTimeout(() => {
      void expireWechatCodexRecoverySnapshot(requestId);
    }, readCodexSessionMaxMs());
    timeout.unref?.();
    wechatCodexTurns.set(requestId, {
      finalizer,
      reservation: preCheckResult.reservation,
      requestId,
      userId: args.userId,
      containerId: args.containerId,
      model: args.modelId,
      traceId: args.traceId,
      routeToken: route.token,
      timeout,
    });

    return { kind: "ready", requestId, routeFrame: route.routeFrame };
  };

  return {
    readCodexSessionMaxMs,
    newCodexRequestId,
    expireCodexRouteToken,
    failWechatCodexTurn,
    handleWechatCodexBilling,
    prepareWechatCodexTurn,
  };
}

export function createAutoDreamOptimizerRuntime(deps: {
  pricing: PricingCache;
  preCheckRedis: PreCheckRedis;
  createCommercialCodexRoute: (args: {
    containerId: number;
    userId: bigint;
    modelId: string;
  }) => Promise<any>;
  expireCodexRouteToken: (token: string | null | undefined, reason: string) => void;
  newCodexRequestId: () => string;
  readCodexSessionMaxMs: () => number;
  hmacSha256Hex: (input: string) => string;
}): AutoDreamOptimizerRuntime {
  type AutoDreamCodexSnapshot = {
    reservation: ReservationHandle;
    finalizer: CodexFinalizeHandle;
    routeToken: string | null;
    userId: bigint;
    containerId: number;
    engineSessionId: string;
    timeout: NodeJS.Timeout;
  };
  const autoDreamCodexTurns = new Map<string, AutoDreamCodexSnapshot>();

  const requireAutoDreamString = (
    body: Record<string, unknown>,
    key: string,
    re: RegExp,
  ): string => {
    const value = body[key];
    if (typeof value !== "string" || !re.test(value)) {
      throw new Error(`AUTO_DREAM_INVALID_${key.toUpperCase()}`);
    }
    return value;
  };

  return {
    handle: async ({ path, identity, body }) => {
      const userId = BigInt(identity.userId);
      if (path === AUTO_DREAM_OPTIMIZER_ADMIT_PATH) {
        const runId = requireAutoDreamString(body, "runId", /^[0-9a-f-]{36}$/);
        const callId = requireAutoDreamString(body, "callId", /^[0-9a-f-]{36}:\d{1,8}$/);
        const agentId = requireAutoDreamString(body, "agentId", /^[A-Za-z0-9_-]{1,64}$/);
        const model = requireAutoDreamString(body, "model", /^gpt-5\.6-terra$/);
        const { getAutoDreamPolicy } = await import("../user/autoDream.js");
        const policy = await getAutoDreamPolicy(userId);
        if (!policy.enabled || policy.mode !== "optimizer_v2" || policy.modelId !== model) {
          throw new Error("AUTO_DREAM_INVALID_POLICY");
        }
        const route = projectAutoDreamCodexRoute(
          await deps.createCommercialCodexRoute({
            containerId: identity.containerId,
            userId,
            modelId: model,
          }),
        );
        if (!route) throw new Error("AUTO_DREAM_ROUTE_UNAVAILABLE");
        const basePricing = deps.pricing.get(model);
        if (!basePricing) {
          deps.expireCodexRouteToken(route.token, "auto_dream_pricing_missing");
          throw new Error("AUTO_DREAM_PRICING_UNAVAILABLE");
        }
        const agentMul = await getAgentCostMultiplier(getPool(), agentId);
        const derivedPricing: ModelPricing = {
          ...basePricing,
          multiplier: composeMultiplier(basePricing.multiplier, agentMul),
        };
        const requestId = deps.newCodexRequestId();
        const maxCost = estimateMaxCost(CODEX_PRECHECK_TOKEN_ESTIMATE, derivedPricing);
        let precheck: Awaited<ReturnType<typeof preCheckWithCost>>;
        try {
          precheck = await preCheckWithCost(deps.preCheckRedis, { userId, requestId, maxCost });
        } catch (err) {
          deps.expireCodexRouteToken(route.token, "auto_dream_precheck_failed");
          throw err;
        }
        const engineSessionId = deriveEngineSessionId(
          `auto-dream:${identity.userId}:${identity.containerId}:${agentId}`,
        );
        try {
          const admitted = await startInflightJournal(getPool(), {
            requestId,
            userId,
            containerId: BigInt(identity.containerId),
            model,
            precheckCredits: precheck.maxCost,
            ctxJson: {
              agentId,
              runId,
              callId,
              source: "auto_dream_optimizer",
              durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
              billingPricing: serializeBillingPricing(derivedPricing),
              engineSessionId,
            },
          });
          if (!admitted) throw new Error("AUTO_DREAM_JOURNAL_CONFLICT");
        } catch (err) {
          await releasePreCheck(deps.preCheckRedis, precheck.reservation).catch(() => {});
          deps.expireCodexRouteToken(route.token, "auto_dream_journal_failed");
          throw err;
        }
        const finalizer = makeCodexFinalizer({
          pgPool: getPool(),
          preCheckRedis: deps.preCheckRedis,
          userId,
          requestId,
          engineSessionId,
          model,
          derivedPricing,
          reservation: precheck.reservation,
        });
        const timeout = setTimeout(() => {
          const live = autoDreamCodexTurns.get(requestId);
          if (!live) return;
          autoDreamCodexTurns.delete(requestId);
          deps.expireCodexRouteToken(live.routeToken, "auto_dream_admission_expired");
          void releasePreCheck(deps.preCheckRedis, live.reservation).catch(() => {});
        }, deps.readCodexSessionMaxMs());
        timeout.unref?.();
        autoDreamCodexTurns.set(requestId, {
          reservation: precheck.reservation,
          finalizer,
          routeToken: route.token,
          userId,
          containerId: identity.containerId,
          engineSessionId,
          timeout,
        });
        return {
          requestId,
          engineSessionId,
          routeFrame: route.routeFrame,
        };
      }
      if (path === AUTO_DREAM_OPTIMIZER_FINDINGS_PATH) {
        const runId = requireAutoDreamString(body, "runId", /^[0-9a-f-]{36}$/);
        const agentId = requireAutoDreamString(body, "agentId", /^[A-Za-z0-9_-]{1,64}$/);
        const { getAutoDreamPolicy } = await import("../user/autoDream.js");
        const policy = await getAutoDreamPolicy(userId);
        if (!policy.enabled || policy.mode !== "optimizer_v2") {
          throw new Error("AUTO_DREAM_INVALID_POLICY");
        }
        const pseudonymKey = loadKmsKey();
        try {
          return await reportAutoDreamPlatformFindings(getPool(), {
            subjectHash: deps.hmacSha256Hex(`auto-dream-platform-finding-user\0${identity.userId}`),
            agentId,
            runId,
            model: policy.modelId,
            findings: body.findings,
            rawFindings: body.rawFindings,
            trafficClass: await getUserSignalTrafficClass(identity.userId, getPool()),
            pseudonymKey,
          });
        } finally {
          zeroBuffer(pseudonymKey);
        }
      }
      if (path === AUTO_DREAM_OPTIMIZER_ACTION_PATH) {
        const action = requireAutoDreamString(body, "action", /^preference\.patch$/);
        void action;
        return await applyAutoDreamPreferenceAction(getPool(), {
          userId: identity.userId,
          proposalId: requireAutoDreamString(body, "proposalId", /^[0-9a-f]{32}$/),
          targetId: requireAutoDreamString(body, "targetId", /^preferences\.[a-z_]{1,64}$/),
          beforeFingerprint: requireAutoDreamString(body, "beforeFingerprint", /^[0-9a-f]{64}$/),
          after:
            typeof body.after === "string" && body.after.length <= 32_000
              ? body.after
              : (() => {
                  throw new Error("AUTO_DREAM_INVALID_AFTER");
                })(),
        });
      }

      const requestId = requireAutoDreamString(body, "requestId", /^[0-9a-f]{32}$/);
      const journal = await getPool().query<{
        user_id: string;
        container_id: string | null;
        ctx: Record<string, unknown> | null;
      }>(
        `SELECT user_id::text,container_id::text,ctx
           FROM request_finalize_journal WHERE request_id=$1`,
        [requestId],
      );
      const journalRow = journal.rows[0];
      if (
        !journalRow ||
        journalRow.user_id !== String(identity.userId) ||
        journalRow.container_id !== String(identity.containerId) ||
        journalRow.ctx?.source !== "auto_dream_optimizer"
      ) {
        throw new Error("AUTO_DREAM_INVALID_JOURNAL_IDENTITY");
      }

      if (path === AUTO_DREAM_OPTIMIZER_SETTLE_PATH) {
        const usage =
          body.usage && typeof body.usage === "object" && !Array.isArray(body.usage)
            ? (body.usage as Record<string, unknown>)
            : {};
        const safe = (value: unknown): number =>
          typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
        const status = body.status === "success" ? "success" : "error";
        await settleDurableCodexBilling(
          {
            pgPool: getPool(),
            preCheckRedis: deps.preCheckRedis,
            pricing: deps.pricing,
            logger: rootLogger.child({ subsys: "autoDreamDurableCodexBilling" }),
          },
          userId,
          {
            requestId,
            engineSessionId:
              typeof journalRow.ctx.engineSessionId === "string"
                ? journalRow.ctx.engineSessionId
                : deriveEngineSessionId(`auto-dream:${identity.userId}:${identity.containerId}:main`),
            status,
            durationMs: safe(body.durationMs),
            usage: {
              input_tokens: safe(usage.input_tokens),
              output_tokens: safe(usage.output_tokens),
              reasoning_output_tokens: safe(usage.reasoning_output_tokens),
              cache_read_input_tokens: safe(usage.cache_read_input_tokens),
              cache_creation_input_tokens: safe(usage.cache_creation_input_tokens),
            },
            ...(body.terminalCode === "USER_CANCELLED" || body.terminalCode === "CODEX_ERROR"
              ? { terminalCode: body.terminalCode }
              : {}),
            ...(body.rateLimits !== undefined ? { rateLimits: body.rateLimits as any } : {}),
          },
        );
        const live = autoDreamCodexTurns.get(requestId);
        if (live) {
          autoDreamCodexTurns.delete(requestId);
          clearTimeout(live.timeout);
          deps.expireCodexRouteToken(live.routeToken, "auto_dream_billing_settled");
        }
        return { settled: true };
      }
      if (path === AUTO_DREAM_OPTIMIZER_ABANDON_PATH) {
        const live = autoDreamCodexTurns.get(requestId);
        if (live) {
          autoDreamCodexTurns.delete(requestId);
          clearTimeout(live.timeout);
          try {
            await live.finalizer.fail("auto_dream_abandoned", "INTERNAL_ERROR");
          } finally {
            deps.expireCodexRouteToken(live.routeToken, "auto_dream_abandoned");
          }
        } else {
          const { abortInflightJournal } = await import("../billing/proxyBilling.js");
          await abortInflightJournal(getPool(), requestId, "auto_dream_abandoned", "INTERNAL_ERROR");
          await releasePreCheck(deps.preCheckRedis, {
            userId: String(identity.userId),
            requestId,
          }).catch(() => {});
        }
        return { abandoned: true };
      }
      throw new Error("AUTO_DREAM_INVALID_PATH");
    },
  };
}

export function buildQqBotServiceAndReceivers(deps: {
  qqConfig: QqBotConfig;
  bridgeSecret: string;
  dockerEnsureRunning: ResolveContainerEndpoint;
  pricing: PricingCache;
  loadUserModelAuthz: ReturnType<typeof makeLoadUserModelAuthz>;
  allowedInboundModels: ReadonlySet<string>;
  prepareWechatCodexTurn: (args: {
    containerId: number;
    bindingUserId: string;
    userId: bigint;
    modelId: string;
    agentId: string;
    traceId: string;
  }) => Promise<PrepareWechatCodexTurnResult>;
  failWechatCodexTurn: (requestId: string, reason: string) => Promise<void>;
  handleWechatCodexBilling: (
    body: WechatCodexBillingBody,
    identity: { userId: number; containerId: number },
  ) => Promise<void>;
  userMediaResolver: ((userId: string) => Promise<UserMediaLocation>) | undefined;
  ensureContainerEndpointReady: ((uid: bigint) => Promise<void>) | undefined;
  pushRemoteHostUpload: (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => Promise<void>;
  remoteControl?: ImRemoteControlHandler;
}): {
  qqBotService: QqBotService;
  qqOutbound: ReturnType<typeof makeQqOutboundReceiver>;
  qqProactive: ReturnType<typeof makeQqProactiveReceiver>;
} {
  const qqDispatcher = makeInboundDispatcher({
    pgPool: getPool(),
    resolveContainerEndpoint: deps.dockerEnsureRunning,
    fallbackDockerEnsure: deps.dockerEnsureRunning,
    bridgeSecret: deps.bridgeSecret,
    resolveModel: async (bindingUserId) => {
      const uid = BigInt(bindingUserId);
      const [prefs, authz] = await Promise.all([getPreferences(uid), deps.loadUserModelAuthz(uid)]);
      return pickWechatInboundModel({
        preferredModel: prefs.prefs.default_model,
        visibleModels: deps.pricing.listForUser({ uid, ...authz }),
        canUseModel: (modelId) => canUseModel({ pricing: deps.pricing }, { uid, ...authz, modelId }),
        allowedModels: deps.allowedInboundModels,
      });
    },
    prepareCodexTurn: deps.prepareWechatCodexTurn,
    failCodexTurn: deps.failWechatCodexTurn,
    upsertMasterClientSession,
    softDeleteMasterSession: async (sessionId, userId) => {
      await softDeleteMasterSession(sessionId, userId);
    },
    transport: makeNodeHttpContainerTransport(),
    channel: qqInboundChannelProfile(),
  });
  const resolveQqOutboundMedia = deps.userMediaResolver
    ? makeQqOutboundMediaResolver({
        resolveUserMediaDirs: deps.userMediaResolver,
        pullRemoteHostMedia: async (args) => {
          const target = await resolveServiceableHostTarget(args.hostUuid);
          try {
            return await nodeAgentGetFile(target, args.remotePath);
          } finally {
            target.psk?.fill(0);
          }
        },
      })
    : undefined;
  const qqBotService = makeQqBotService({
    pool: getPool(),
    config: deps.qqConfig,
    dispatcher: qqDispatcher,
    prepareMedia:
      deps.userMediaResolver && deps.ensureContainerEndpointReady
        ? makeSaveQqMediaToUserUploads({
            ensureContainerReady: deps.ensureContainerEndpointReady,
            resolveUserMediaDirs: deps.userMediaResolver,
            pushRemoteHostUpload: deps.pushRemoteHostUpload,
          })
        : undefined,
    resolveOutboundMedia: resolveQqOutboundMedia,
    handleModelCommand: async (bindingUserId, text) => {
      const uid = BigInt(bindingUserId);
      const [prefs, authz] = await Promise.all([getPreferences(uid), deps.loadUserModelAuthz(uid)]);
      return await handleWechatModelCommand({
        text,
        channelName: "QQ",
        preferredModel: prefs.prefs.default_model,
        visibleModels: deps.pricing.listForUser({ uid, ...authz }),
        canUseModel: (modelId) => canUseModel({ pricing: deps.pricing }, { uid, ...authz, modelId }),
        allowedModels: deps.allowedInboundModels,
        setDefaultModel: async (modelId) => {
          await patchPreferences(uid, { default_model: modelId });
        },
      });
    },
    remoteControl: deps.remoteControl,
  });
  const qqIdentityRepo = createPgIdentityRepo();
  const qqOutbound = makeQqOutboundReceiver({
    pool: getPool(),
    identityRepo: qqIdentityRepo,
    handleCodexBilling: deps.handleWechatCodexBilling,
    onQueued: () => qqBotService.kickOutbox(),
  });
  const qqProactive = makeQqProactiveReceiver({
    pool: getPool(),
    identityRepo: qqIdentityRepo,
    onQueued: () => qqBotService.kickOutbox(),
  });
  return { qqBotService, qqOutbound, qqProactive };
}

export function buildWechatBrokerDeps(deps: {
  bridgeSecret: string;
  redis: IORedis;
  dockerEnsureRunning: ResolveContainerEndpoint;
  pricing: PricingCache;
  loadUserModelAuthz: ReturnType<typeof makeLoadUserModelAuthz>;
  allowedInboundModels: ReadonlySet<string>;
  prepareWechatCodexTurn: (args: {
    containerId: number;
    bindingUserId: string;
    userId: bigint;
    modelId: string;
    agentId: string;
    traceId: string;
  }) => Promise<PrepareWechatCodexTurnResult>;
  failWechatCodexTurn: (requestId: string, reason: string) => Promise<void>;
  handleWechatCodexBilling: (
    body: WechatCodexBillingBody,
    identity: { userId: number; containerId: number },
  ) => Promise<void>;
  userMediaResolver: ((userId: string) => Promise<UserMediaLocation>) | undefined;
  pushRemoteHostUpload: (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => Promise<void>;
  wechatLiveLinkKey: Buffer | undefined;
  remoteControl?: ImRemoteControlHandler;
}): {
  wechatProactive: ProactiveReceiverHandler;
  brokerConfig: Parameters<typeof makeWechatBroker>[0];
} {
  const containerTransport = makeNodeHttpContainerTransport();
  const ilinkSendText = makeIlinkSendAdapter();
  const ilinkSendMedia = makeIlinkSendMediaAdapter();
  const resolveWechatOutboundMedia = deps.userMediaResolver
    ? makeWechatOutboundMediaResolver({
        resolveUserMediaDirs: deps.userMediaResolver,
        pullRemoteHostMedia: async (args) => {
          const target = await resolveServiceableHostTarget(args.hostUuid);
          try {
            return await nodeAgentGetFile(target, args.remotePath);
          } finally {
            target.psk?.fill(0);
          }
        },
      })
    : undefined;

  const inboundDispatcher = makeInboundDispatcher({
    pgPool: getPool(),
    resolveContainerEndpoint: deps.dockerEnsureRunning,
    fallbackDockerEnsure: deps.dockerEnsureRunning,
    bridgeSecret: deps.bridgeSecret,
    resolveModel: async (bindingUserId) => {
      const uid = BigInt(bindingUserId);
      const [prefs, authz] = await Promise.all([getPreferences(uid), deps.loadUserModelAuthz(uid)]);
      return pickWechatInboundModel({
        preferredModel: prefs.prefs.default_model,
        visibleModels: deps.pricing.listForUser({ uid, ...authz }),
        canUseModel: (modelId) => canUseModel({ pricing: deps.pricing }, { uid, ...authz, modelId }),
        allowedModels: deps.allowedInboundModels,
      });
    },
    prepareCodexTurn: deps.prepareWechatCodexTurn,
    failCodexTurn: deps.failWechatCodexTurn,
    upsertMasterClientSession,
    softDeleteMasterSession: async (sessionId, userId) => {
      await softDeleteMasterSession(sessionId, userId);
    },
    transport: containerTransport,
  });

  const identityRepo = createPgIdentityRepo();
  const rateLimitRedis = wrapIoredis(deps.redis);
  void rateLimitRedis;
  const outboundReceiver = makeOutboundReceiverHandler({
    identityRepo,
    pool: getPool(),
    rateLimiter: createNoopRateLimiter(),
    handleCodexBilling: deps.handleWechatCodexBilling,
  });

  const wechatProactive = makeProactiveReceiverHandler({
    identityRepo,
    pool: getPool(),
    resolveRecipient: async (bindingUserId) => {
      const b = await getWechatBindingByUserId(MASTER_USER_PREFIX + bindingUserId);
      if (!b || b.status !== "active" || !b.loginUserId) return null;
      return { senderId: canonicalWechatSenderId(b.loginUserId), contextTokens: b.contextTokens };
    },
    isProactiveEnabled: async (userId) => {
      const snap = await getPreferences(BigInt(userId));
      return snap.prefs.wechat_proactive_push !== false;
    },
    getSessionId: getCurrentSessionId,
  });

  const brokerConfig: Parameters<typeof makeWechatBroker>[0] = {
    pgPool: getPool(),
    dispatcher: inboundDispatcher,
    outboundReceiver,
    allMasterWsessRows,
    softDeleteMasterSession: async (sessionId, userId) => {
      await softDeleteMasterSession(sessionId, userId);
    },
    sendText: ilinkSendText,
    sendMedia: ilinkSendMedia,
    resolveOutboundMediaPart: resolveWechatOutboundMedia,
    wechatLiveLinkKey: deps.wechatLiveLinkKey,
    wechatUxCommands: {
      handleModelCommand: async (evt) => {
        const uid = BigInt(evt.bindingUserId);
        const [prefs, authz] = await Promise.all([getPreferences(uid), deps.loadUserModelAuthz(uid)]);
        return await handleWechatModelCommand({
          text: evt.text,
          preferredModel: prefs.prefs.default_model,
          visibleModels: deps.pricing.listForUser({ uid, ...authz }),
          canUseModel: (modelId) => canUseModel({ pricing: deps.pricing }, { uid, ...authz, modelId }),
          allowedModels: deps.allowedInboundModels,
          setDefaultModel: async (modelId) => {
            await patchPreferences(uid, { default_model: modelId });
          },
        });
      },
    },
    wechatProcessVisibility: {
      getShowToolCalls: async (bindingUserId) => {
        const snap = await getPreferences(BigInt(bindingUserId));
        return snap.prefs.wechat_show_tool_calls !== false;
      },
      setShowToolCalls: async (bindingUserId, show) => {
        await patchPreferences(BigInt(bindingUserId), {
          wechat_show_tool_calls: show,
        });
      },
    },
    saveWechatMedia: deps.userMediaResolver
      ? makeSaveWechatMediaToUserUploads({
          resolveUserMediaDirs: deps.userMediaResolver,
          pushRemoteHostUpload: deps.pushRemoteHostUpload,
        })
      : undefined,
    getBinding: async (bindingUserId) => {
      const b = await getWechatBindingByUserId(bindingUserId);
      if (!b) return null;
      return {
        botToken: b.botToken,
        contextTokens: b.contextTokens,
        status: b.status,
        loginUserId: b.loginUserId,
      };
    },
    remoteControl: deps.remoteControl,
    brokerEnabled: () => true,
  };

  return { wechatProactive, brokerConfig };
}
