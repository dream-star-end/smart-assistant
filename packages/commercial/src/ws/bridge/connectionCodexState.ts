import { WebSocket } from "ws";
import { buildAutoRebindFrames } from "../sessionRepoBindBridge.js";
import { isGrokEngineKind } from "./enginePolicy.js";
import type { ActiveCodexTurnState, BridgeConnectionCtx } from "./types.js";
import { sendJsonSafely } from "./wireHelpers.js";

export function isCurrentCodexTurnState(
  ctx: BridgeConnectionCtx,
  state: ActiveCodexTurnState,
): boolean {
  return !ctx.cleaned && ctx.activeCodexTurnsByPeer.get(state.peerKey) === state;
}

export function expireCodexRouteToken(
  ctx: BridgeConnectionCtx,
  token: string | null,
  reason: string,
): void {
  if (token === null) return;
  const expire = ctx.shared.deps.expireCodexRoute;
  if (expire === undefined) return;
  void expire(token).catch((err) => {
    ctx.bridgeLog?.warn("user-chat-bridge: expire codex route failed", {
      reason,
      err: (err as Error)?.message ?? String(err),
    });
  });
}

export function retryPendingGrokLeaseRelease(
  ctx: BridgeConnectionCtx,
  requestId: string,
): void {
  const pending = ctx.pendingGrokLeaseReleases.get(requestId);
  const releaseFn = ctx.shared.deps.releaseGrokRouteLease;
  if (pending === undefined || releaseFn === undefined) return;
  if (pending.inFlight !== null) {
    pending.retryRequested = true;
    return;
  }
  const attempt = releaseFn(pending.accountId, pending.slotId)
    .then(() => {
      if (ctx.pendingGrokLeaseReleases.get(requestId) === pending) {
        ctx.pendingGrokLeaseReleases.delete(requestId);
      }
    })
    .catch((err) => {
      ctx.bridgeLog?.warn(
        "user-chat-bridge: release durable Grok route lease failed; terminal frame remains retryable",
        {
          requestId,
          reason: pending.reason,
          err: (err as Error)?.message ?? String(err),
        },
      );
    })
    .finally(() => {
      if (ctx.pendingGrokLeaseReleases.get(requestId) !== pending) return;
      pending.inFlight = null;
      if (pending.retryRequested) {
        pending.retryRequested = false;
        retryPendingGrokLeaseRelease(ctx, requestId);
      }
    });
  pending.inFlight = attempt;
}

function clearCodexStateTimersAndMaps(
  ctx: BridgeConnectionCtx,
  state: ActiveCodexTurnState,
): { accountId: bigint | null; slotId: string | null; routeToken: string | null } {
  if (state.releaseTimer !== null) {
    clearTimeout(state.releaseTimer);
    state.releaseTimer = null;
  }
  if (state.slotHeartbeat !== null) {
    clearInterval(state.slotHeartbeat);
    state.slotHeartbeat = null;
  }
  const accountId = state.acquiredAccountId;
  const slotId = state.acquiredSlotId;
  const routeToken = state.apiRelayRouteToken;
  state.acquiredAccountId = null;
  state.acquiredSlotId = null;
  state.apiRelayRouteToken = null;
  state.acquireInflight = false;
  const current = ctx.activeCodexTurnsByPeer.get(state.peerKey);
  if (current === state && current.stateId === state.stateId) {
    ctx.activeCodexTurnsByPeer.delete(state.peerKey);
  }
  if (state.promptQueueGrantId !== null) {
    ctx.promptQueueDispatchCancellations.delete(state.promptQueueGrantId);
  }
  return { accountId, slotId, routeToken };
}

export function releaseCodexTurnState(
  ctx: BridgeConnectionCtx,
  state: ActiveCodexTurnState,
  reason: string,
  expireRouteTokenOnRelease = true,
  preserveAccountSlot = false,
): void {
  const { accountId, slotId, routeToken } = clearCodexStateTimersAndMaps(ctx, state);
  const isGrok = isGrokEngineKind(state.engine);
  const hasDurableGrok =
    isGrok &&
    accountId !== null &&
    slotId !== null &&
    ctx.shared.deps.releaseGrokRouteLease !== undefined;
  const durableGrokRelease = !preserveAccountSlot && hasDurableGrok;
  if (hasDurableGrok) {
    const releaseKey = state.billingRequestId ?? `state:${state.stateId}`;
    if (!ctx.pendingGrokLeaseReleases.has(releaseKey)) {
      ctx.pendingGrokLeaseReleases.set(releaseKey, {
        accountId,
        slotId,
        reason,
        inFlight: null,
        retryRequested: false,
      });
    }
    if (!preserveAccountSlot) retryPendingGrokLeaseRelease(ctx, releaseKey);
  } else if (
    !preserveAccountSlot &&
    accountId !== null &&
    slotId !== null &&
    ctx.shared.deps.codexBinding !== undefined
  ) {
    try {
      ctx.shared.deps.codexBinding.release(accountId, slotId);
    } catch (err) {
      void err;
    }
  }
  if (expireRouteTokenOnRelease && !durableGrokRelease) {
    expireCodexRouteToken(ctx, routeToken, reason);
  }
}

export function tryAutoRebindFlush(ctx: BridgeConnectionCtx): void {
  const pgPoolBound = ctx.shared.deps.pgPool;
  if (!pgPoolBound) return;
  if (ctx.lastHelloPeerIds === null || ctx.lastHelloPeerIds.size === 0) return;
  if (!ctx.autoRebindFetchDone || ctx.pendingRebindMap.size === 0 || ctx.autoRebindFlushInFlight) {
    return;
  }
  ctx.autoRebindFlushInFlight = true;
  const peers = Array.from(ctx.lastHelloPeerIds);
  void (async () => {
    let progressMade = false;
    try {
      const built = await buildAutoRebindFrames(
        pgPoolBound,
        Number(ctx.uid),
        peers,
        ctx.pendingRebindMap,
      );
      if (built.matchedSessionIds.length > 0) progressMade = true;
      for (const sid of built.matchedSessionIds) ctx.pendingRebindMap.delete(sid);
      for (const f of built.frames) {
        const buf = Buffer.from(JSON.stringify(f), "utf8");
        ctx.forwardInboundFrame(buf, false, buf.length);
        ctx.bridgeLog?.info("user-chat-bridge: repo_bind_auto_rebind_forwarded", {
          sessionId: f.sessionId,
          selectionVersion: f.selectionVersion,
          agentId: f.agentId,
        });
      }
      if (built.errors.length > 0 && ctx.userWs.readyState === WebSocket.OPEN) {
        for (const e of built.errors) sendJsonSafely(ctx.userWs, e);
      }
    } catch (err) {
      ctx.bridgeLog?.warn("user-chat-bridge: auto-rebind flush failed", { err });
    } finally {
      ctx.autoRebindFlushInFlight = false;
      if (
        progressMade &&
        ctx.lastHelloPeerIds !== null &&
        ctx.lastHelloPeerIds.size > 0 &&
        ctx.pendingRebindMap.size > 0
      ) {
        tryAutoRebindFlush(ctx);
      }
    }
  })();
}
