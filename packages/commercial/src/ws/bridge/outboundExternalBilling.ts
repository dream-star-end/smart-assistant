import {
  settleAntigravityTurnRecord,
  settleLateAntigravityRelayUsage,
} from "../../billing/antigravitySettle.js";
import {
  publishZcodeCatalogSettle,
  settleZcodeCatalogUsage,
} from "../../billing/zcodeCatalogSettle.js";
import {
  applyZcodeFinalizeOutcome,
  closeZcodeAuditWithRetry,
} from "../../billing/zcodeExternalAudit.js";
import { isPlainRecord } from "../bridgeInputGuards.js";
import { classifyExternalBillingEngine } from "./enginePolicy.js";
import type { BridgeConnectionCtx } from "./types.js";

type ExternalBillingEngineKind = NonNullable<ReturnType<typeof classifyExternalBillingEngine>>;

type ExternalBillingStatus = "success" | "error" | "unavailable";
type ExternalTerminalCode =
  | "USER_CANCELLED"
  | "AUTH_UNAVAILABLE"
  | "QUOTA_UNAVAILABLE"
  | "ENGINE_ERROR"
  | null;

interface ParsedExternalBillingFrame {
  requestId: string;
  status: ExternalBillingStatus;
  terminalCode: ExternalTerminalCode;
  durationMs: number;
  usage: Record<string, unknown> | null;
  engineKind: ExternalBillingEngineKind;
}

function parseExternalBillingTerminalCode(raw: unknown): ExternalTerminalCode {
  switch (raw) {
    case "USER_CANCELLED":
    case "AUTH_UNAVAILABLE":
    case "QUOTA_UNAVAILABLE":
    case "ENGINE_ERROR":
      return raw;
    default:
      return null;
  }
}

function parseExternalBillingFrame(
  external: Record<string, unknown>,
): ParsedExternalBillingFrame | null {
  const requestId =
    typeof external.requestId === "string" && /^[0-9a-f]{32}$/.test(external.requestId)
      ? external.requestId
      : null;
  const status: ExternalBillingStatus | null =
    external.status === "success" ||
    external.status === "error" ||
    external.status === "unavailable"
      ? external.status
      : null;
  const terminalCode = parseExternalBillingTerminalCode(external.terminalCode);
  const durationMs =
    typeof external.durationMs === "number" &&
    Number.isFinite(external.durationMs) &&
    external.durationMs >= 0
      ? Math.floor(external.durationMs)
      : null;
  const usage = isPlainRecord(external.usage) ? external.usage : null;
  const engineKind = classifyExternalBillingEngine(external.engine);
  if (!requestId || !status || durationMs === null || engineKind === null) return null;
  return { requestId, status, terminalCode, durationMs, usage, engineKind };
}

async function finalizeZcodeAuditOutcome(
  ctx: BridgeConnectionCtx,
  requestId: string,
  status: ExternalBillingStatus,
  terminalCode: ExternalTerminalCode,
  usage: Record<string, unknown> | null,
  relay: { token: string; modelId: string; sessionId: string | null; traceId: string | null } | undefined,
  outcome: Awaited<ReturnType<typeof closeZcodeAuditWithRetry>>,
): Promise<void> {
  const { deps } = ctx.shared;
  const pool = deps.pgPool!;
  const pricing = deps.pricing;
  applyZcodeFinalizeOutcome(ctx.pendingZcodeRequestIds, requestId, outcome);
  if (outcome === "failed") {
    ctx.bridgeLog?.warn("user-chat-bridge: ZCode audit close fail-closed", {
      requestId,
      outcome,
    });
  }
  const canaryTerminal = outcome === "closed" || outcome === "already_terminal";
  if (canaryTerminal || !pricing) return;
  if (relay?.modelId !== "glm-5.3-zai" && outcome !== "unknown") return;
  try {
    const settled = await settleZcodeCatalogUsage({
      pool,
      pricing,
      userId: ctx.uid,
      requestId,
      modelId: "glm-5.3-zai",
      sessionId: relay?.sessionId ?? null,
      engineStatus: status,
      terminalCode,
      usage,
    });
    if (settled === null) {
      ctx.bridgeLog?.warn("user-chat-bridge: ZCode catalog settle skipped, pricing missing", {
        requestId,
      });
      return;
    }
    await publishZcodeCatalogSettle({
      settled,
      requestId,
      userId: ctx.uid.toString(),
      modelId: "glm-5.3-zai",
      sessionId: relay?.sessionId ?? null,
      traceId: relay?.traceId ?? null,
      persist: deps.appendCostCredits,
      publish: (event) => {
        ctx.shared.broadcastToUser(ctx.uid, event);
      },
      onPersistError: (err) => {
        ctx.bridgeLog?.warn("user-chat-bridge: ZCode persist costCredits threw", {
          requestId,
          err,
        });
      },
    });
  } catch (err) {
    ctx.bridgeLog?.warn("user-chat-bridge: ZCode catalog settle failed", { requestId, err });
  }
}

async function publishAntigravitySettleOutcome(
  ctx: BridgeConnectionCtx,
  requestId: string,
  status: ExternalBillingStatus,
  done: Awaited<ReturnType<typeof settleAntigravityTurnRecord>>,
): Promise<void> {
  const { deps } = ctx.shared;
  const pool = deps.pgPool!;
  const pricing = deps.pricing!;
  if (done === null) {
    ctx.bridgeLog?.warn(
      "user-chat-bridge: Antigravity settle skipped (claimed elsewhere, unknown turn or pricing missing)",
      { requestId },
    );
    return;
  }
  await publishZcodeCatalogSettle({
    settled: done.settled,
    requestId,
    userId: ctx.uid.toString(),
    modelId: done.turn.modelId,
    sessionId: done.turn.sessionId,
    traceId: done.turn.traceId,
    turnKey: done.turn.turnKey ?? null,
    parentTurnKey: done.turn.parentTurnKey ?? null,
    persist: deps.appendCostCredits,
    publish: (event) => {
      ctx.shared.broadcastToUser(ctx.uid, event);
    },
    onPersistError: (err) => {
      ctx.bridgeLog?.warn("user-chat-bridge: Antigravity persist costCredits threw", {
        requestId,
        err,
      });
    },
  });
  if (status === "success") {
    await settleLateAntigravityRelayUsage({
      pool,
      pricing,
      requestId,
      userId: ctx.uid,
      appendCostCredits: deps.appendCostCredits,
    }).catch((err) => {
      void err;
    });
  }
}

function takePendingZcodeRelay(
  ctx: BridgeConnectionCtx,
  requestId: string,
): { token: string; modelId: string; sessionId: string | null; traceId: string | null } | undefined {
  const relay = ctx.pendingZcodeRelays.get(requestId);
  if (relay) {
    ctx.shared.deps.expireZcodeRoute?.(relay.token);
    ctx.pendingZcodeRelays.delete(requestId);
  }
  return relay;
}

export function handleExternalEngineBillingFrame(
  ctx: BridgeConnectionCtx,
  external: Record<string, unknown>,
): void {
  const { deps } = ctx.shared;
  const parsed = parseExternalBillingFrame(external);
  if (!deps.pgPool || parsed === null) {
    ctx.bridgeLog?.warn("user-chat-bridge: malformed external engine billing frame dropped");
    return;
  }
  const pool = deps.pgPool;
  const pricing = deps.pricing;
  const uid = ctx.uid;
  const { requestId, status, terminalCode, durationMs, usage, engineKind } = parsed;
  switch (engineKind) {
    case "zcode": {
      const relay = takePendingZcodeRelay(ctx, requestId);
      ctx.shared.trackZcodeAuditWork(
        closeZcodeAuditWithRetry(pool, {
          requestId,
          userId: uid,
          status,
          terminalCode,
          durationMs,
          usage,
        }).then((outcome) =>
          finalizeZcodeAuditOutcome(ctx, requestId, status, terminalCode, usage, relay, outcome),
        ),
      );
      return;
    }
    case "antigravity": {
      const relay = ctx.pendingAntigravityRelays.get(requestId);
      if (relay) ctx.pendingAntigravityRelays.delete(requestId);
      void (async () => {
        await Promise.allSettled([
          relay ? Promise.resolve(deps.expireAntigravityRoute?.(relay.token)) : Promise.resolve(),
          Promise.resolve(deps.expireAntigravityRouteForRequest?.(requestId, uid)),
        ]);
        if (!pricing) return;
        try {
          const done = await settleAntigravityTurnRecord({
            pool,
            pricing,
            requestId,
            userId: uid,
            engineStatus: status,
            terminalCode,
          });
          await publishAntigravitySettleOutcome(ctx, requestId, status, done);
        } catch (err) {
          ctx.bridgeLog?.warn("user-chat-bridge: Antigravity settle failed", { requestId, err });
        }
      })();
      return;
    }
    case "cursor":
      ctx.shared.adapters.settleCursorExternalBilling({
        ctx,
        requestId,
        status,
        terminalCode,
        durationMs,
        usage,
        external,
      });
      return;
  }
}
