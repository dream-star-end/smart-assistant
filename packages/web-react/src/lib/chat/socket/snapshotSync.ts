import type { DurableLiveFrame } from "../../types";
import { confirmDispatchDelivery, confirmSnapshotDelivery } from "../deliveryConfirm";
import {
  isOutboundFrame,
  type OutboundMessageWire,
  type OutboundTurnStatusWire,
  type OutboundWire,
} from "../frames";
import { fetchRecoverableLiveUnits } from "../liveUnitsHydrate";
import type { ChatSession } from "../model";
import { safeSessionKeyForAgent } from "../pure";
import {
  applyOutboundMessage,
  applyTurnStatus,
  applyTurnUsage,
  currentFrameSeqAcceptOrder,
  resetAgentFrameSeqCursorsForSession,
  resetFrameSeqCursor,
} from "../reducer";
import {
  isOpenSnapshotDispatch,
  isSessionSnapshot,
  isSnapshotFenced,
  isTerminalSnapshotDispatch,
  mayClaimSnapshotDispatch,
  reconcileOpenSnapshotRelayContainer,
  rememberTerminalSnapshotDispatch,
  SNAPSHOT_ACK_TIMEOUT_MS,
  SNAPSHOT_MAX_PAGES,
  SNAPSHOT_PAGE_LIMIT,
  type SessionSnapshot,
  type SnapshotDispatch,
  type SnapshotQuery,
  shouldKeepLocalRowsOnDegradedRebuild,
  snapshotFrameRecords,
  snapshotIsStale,
  snapshotLeadAgent,
  snapshotNeedsRebuild,
  snapshotQuery,
  snapshotWatchTargets,
} from "../sessionSnapshot";
import { liveProcessOwnersFromUnits } from "../socketRecoveryHelpers";
import type { SnapshotApplyContext, SocketCtx } from "./types";

function isTurnStatusWireFrame(raw: unknown): raw is OutboundTurnStatusWire {
  return (
    Boolean(raw) &&
    typeof raw === "object" &&
    (raw as { type?: unknown }).type === "outbound.turn_status"
  );
}

function isOutboundMessageFrame(frame: OutboundWire): frame is OutboundMessageWire {
  return frame.type === "outbound.message";
}

function collectHelloAgentCursors(
  pid: string,
  s: ChatSession,
  defaultAgentId: string | undefined,
): { lead: string; query: SnapshotQuery; agents: Map<string, number> } {
  const query = snapshotQuery(s, defaultAgentId);
  const lead = snapshotLeadAgent(s, defaultAgentId);
  const agents = new Map<string, number>([[lead, query.afterSeq]]);
  const safeId = String(pid).replace(/[^a-zA-Z0-9_-]/g, "_");
  for (const [key, seq] of Object.entries(s._lastFrameSeqByKey ?? {})) {
    const m = key.match(/^agent:([^:]+):webchat:dm:(.+)$/);
    if (m && m[2] === safeId && !agents.has(m[1]!) && Number.isFinite(seq)) {
      agents.set(m[1]!, seq);
    }
  }
  const defAgent = s.agentId || defaultAgentId || "main";
  if (!agents.has(defAgent)) agents.set(defAgent, 0);
  return { lead, query, agents };
}

export function composeHelloFramePayload(
  ctx: SocketCtx,
  includeInFlight = true,
  onlySessionId?: string,
): { data: string; sessionIds: string[]; asked: Map<string, string> } {
  const peers: Array<Record<string, unknown>> = [];
  const sessionIds: string[] = [];
  const asked = new Map<string, string>();
  const ordered = [...ctx.sessions].sort(
    ([a], [b]) => Number(b === ctx.activeSessionId) - Number(a === ctx.activeSessionId),
  );
  for (const [pid, s] of ordered) {
    if (onlySessionId && pid !== onlySessionId) continue;
    sessionIds.push(pid);
    const { lead, query, agents } = collectHelloAgentCursors(pid, s, ctx.deps.defaultAgentId);
    const inFlight = includeInFlight && Boolean(s._sendingInFlight);
    if (inFlight && query.dispatch) asked.set(pid, query.dispatch);
    for (const [agentId, lastFrameSeq] of agents) {
      peers.push({
        peerId: pid,
        agentId,
        inFlight,
        lastFrameSeq,
        ...(inFlight && query.dispatch ? { inFlightClientMessageId: query.dispatch } : {}),
        ...(agentId === lead && query.streamKey ? { lastStreamKey: query.streamKey } : {}),
      });
    }
  }
  const clientBuild =
    typeof document !== "undefined"
      ? document.querySelector<HTMLMetaElement>('meta[name="oc-build"]')?.content || undefined
      : undefined;
  return {
    data: JSON.stringify({
      type: "inbound.hello",
      channel: "webchat",
      automaticRecoveryOwner: "master-v1",
      clientBuild,
      peers,
    }),
    sessionIds,
    asked,
  };
}

export function sendHelloFrameOnSocket(
  ctx: SocketCtx,
  includeInFlight = true,
  onlySessionId?: string,
): boolean {
  const hello = composeHelloFramePayload(ctx, includeInFlight, onlySessionId);
  if (!ctx.safeWsSend(hello.data)) return false;
  const sentAt = Date.now();
  const sentOrder = currentFrameSeqAcceptOrder();
  for (const id of hello.sessionIds) {
    ctx.subscribedSessions.add(id);
    ctx.helloSentAt.set(id, { at: sentAt, order: sentOrder });
    const cmid = hello.asked.get(id);
    if (cmid) ctx.helloAskedCmid.set(id, cmid);
    else ctx.helloAskedCmid.delete(id);
  }
  return true;
}

function applyOpenSnapshotHead(
  sess: ChatSession,
  d: SnapshotDispatch,
  snap: SessionSnapshot,
): void {
  confirmDispatchDelivery(sess, d.clientMessageId, d.acceptedAt != null);
  sess._turnStartedAt = d.since;
  const peer = { id: sess.id, kind: "dm" as const };
  if (snap.usage) {
    applyTurnUsage(sess, {
      type: "outbound.turn_usage",
      sessionKey: safeSessionKeyForAgent(sess.id, d.agentId || "main"),
      channel: "webchat",
      peer,
      clientMessageId: d.clientMessageId,
      usage: snap.usage.usage,
    });
  }
  if (isTurnStatusWireFrame(snap.turnStatus)) {
    applyTurnStatus(sess, snap.turnStatus);
  }
  if (snap.credits) {
    sess._turnCredits = {
      clientMessageId: d.clientMessageId,
      ...snap.credits,
      receivedAt: Date.now(),
    };
  }
}

function applyTerminalSnapshotHead(
  ctx: SocketCtx,
  sess: ChatSession,
  d: SnapshotDispatch,
  snap: SessionSnapshot,
): boolean {
  if (snap.reconcile) {
    const rawMsg: unknown = {
      type: "outbound.message",
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      clientMessageId: d.clientMessageId,
      blocks: [],
      isFinal: true,
      meta: { reconcile: snap.reconcile, clientMessageId: d.clientMessageId },
      ts: snap.asOf,
    };
    if (isOutboundFrame(rawMsg) && isOutboundMessageFrame(rawMsg)) {
      applyOutboundMessage(sess, rawMsg, ctx.effects());
    }
    return true;
  }
  rememberTerminalSnapshotDispatch(sess, d);
  ctx.finishDispatch(sess.id, d.clientMessageId);
  ctx.clearSendingState(sess);
  return false;
}

function settleUnmatchedAskedDispatch(
  ctx: SocketCtx,
  sess: ChatSession,
  d: SessionSnapshot["dispatch"],
  fresh: boolean,
  asked: string | undefined,
): boolean {
  if (!fresh || !asked || d?.clientMessageId === asked) return false;
  if (sess._stopSettlement || !sess._sendingInFlight || sess._activeClientMessageId !== asked) {
    return false;
  }
  ctx.finishDispatch(sess.id, asked);
  ctx.clearSendingState(sess);
  return true;
}

export function applySnapshotHeadToSession(
  ctx: SocketCtx,
  sess: ChatSession,
  snap: SessionSnapshot,
  fresh: boolean,
  readHistory = true,
  asked?: string,
): boolean {
  for (const item of snap.pendingPermissions.items) {
    if (isOutboundFrame(item)) ctx.dispatch(item);
  }
  const d = snap.dispatch;
  const own =
    fresh &&
    Boolean(d) &&
    sess._sendingInFlight &&
    sess._activeClientMessageId === d?.clientMessageId &&
    !snapshotIsStale(sess, snap);
  let needsHistory = snap.pendingPermissions.completeness !== "complete" || snap.gap?.reason === "tape";
  let historyCmid = d?.clientMessageId;
  if (settleUnmatchedAskedDispatch(ctx, sess, d, fresh, asked)) {
    needsHistory = true;
    historyCmid = asked;
  }
  if (own && isOpenSnapshotDispatch(d) && !isSnapshotFenced(sess, d)) {
    applyOpenSnapshotHead(sess, d, snap);
  } else if (own && d && (d.status === "terminal" || d.status === "manual_reconcile")) {
    if (applyTerminalSnapshotHead(ctx, sess, d, snap)) return true;
    needsHistory = true;
  }
  if (!needsHistory || !readHistory) return false;
  ctx.syncHistory(sess.id, historyCmid ? { clientMessageId: historyCmid } : undefined);
  return true;
}

export async function readSnapshotPagesChain(
  ctx: SocketCtx,
  sess: ChatSession,
  first: SessionSnapshot,
): Promise<{ last: SessionSnapshot; records: DurableLiveFrame[]; degraded: boolean }> {
  const records: DurableLiveFrame[] = [];
  let page = first;
  for (let pages = 1; pages <= SNAPSHOT_MAX_PAGES + 1; pages += 1) {
    records.push(...snapshotFrameRecords(page));
    try {
      const gap = page.gap;
      let afterSeq = page.nextAfterSeq;
      if (
        gap?.reason === "byte_limit" &&
        gap.recordId &&
        typeof gap.frameSeq === "number" &&
        page.streamKey
      ) {
        const exact = await ctx.deps.readLiveFramePayload?.(sess.id, {
          recordId: gap.recordId,
          ...(gap.sha256 ? { sha256: gap.sha256 } : {}),
        });
        if (!exact) return { last: page, records, degraded: true };
        records.push({
          recordId: gap.recordId,
          streamKey: page.streamKey,
          source: "gateway",
          clientMessageId: page.dispatch?.clientMessageId ?? null,
          payload: exact.payload,
        });
        afterSeq = gap.frameSeq;
      }
      if (!page.hasMore || !page.streamKey) return { last: page, records, degraded: false };
      const read = ctx.deps.readSessionSnapshot;
      if (!read || pages >= SNAPSHOT_MAX_PAGES) return { last: page, records, degraded: true };
      const next = await read(sess.id, {
        afterSeq,
        streamKey: page.streamKey,
        limit: SNAPSHOT_PAGE_LIMIT,
        ...(page.dispatch ? { dispatch: page.dispatch.clientMessageId } : {}),
      });
      if (!isSessionSnapshot(next) || next.streamKey !== page.streamKey) {
        return { last: page, records, degraded: !next };
      }
      page = next;
    } catch {
      return { last: page, records, degraded: true };
    }
  }
  return { last: page, records, degraded: true };
}

async function tryRecoverSnapshotViaLiveUnits(
  ctx: SocketCtx,
  sess: ChatSession,
  last: SessionSnapshot,
  d: SnapshotDispatch,
  activeKey: string,
  isCurrent: () => boolean,
): Promise<boolean | null> {
  const rawUnits = await fetchRecoverableLiveUnits(ctx.deps.readLiveUnits, sess.id, {
    clientMessageId: d.clientMessageId,
    streamKey: last.streamKey,
  });
  if (!isCurrent()) return null;
  if (!rawUnits) return false;
  if (
    last.streamKey &&
    sess._snapshotStream?.streamKey &&
    sess._snapshotStream.streamKey !== last.streamKey
  ) {
    ctx.noteAuthoritativeFrameSeqReset(sess, { sessionKey: activeKey });
    resetFrameSeqCursor(sess, { sessionKey: activeKey });
    ctx.resetOwnerLocalRows(sess, [d.clientMessageId], liveProcessOwnersFromUnits(rawUnits.units));
  }
  ctx.applyLiveUnits(
    sess.id,
    rawUnits.units,
    [d.clientMessageId],
    rawUnits.resume,
    rawUnits.streamGeneration,
  );
  sess._liveUnitsPackApplied = true;
  sess._liveUnitsHasMoreBefore = rawUnits.hasMoreBefore;
  sess._liveUnitsBeforeCursor = rawUnits.beforeCursor;
  sess._liveJournalDegraded = false;
  return true;
}

function replayOrResetSnapshotFrames(
  ctx: SocketCtx,
  sess: ChatSession,
  pages: { last: SessionSnapshot; records: DurableLiveFrame[]; degraded: boolean },
  d: SessionSnapshot["dispatch"],
  activeKey: string | undefined,
  flags: { rebuild: boolean; rebuildActive: boolean; fenced: boolean; cutoff: number },
): void {
  const keepLocal = shouldKeepLocalRowsOnDegradedRebuild(
    sess,
    pages.last.streamKey,
    d?.clientMessageId,
    flags.rebuildActive,
    pages.degraded,
  );
  if (pages.records.length > 0) {
    if (flags.rebuildActive && activeKey && !keepLocal) {
      ctx.noteAuthoritativeFrameSeqReset(sess, { sessionKey: activeKey });
      resetFrameSeqCursor(sess, { sessionKey: activeKey });
    }
    ctx.applyDurableLiveFrames(
      sess.id,
      pages.records,
      flags.rebuildActive && d && !keepLocal ? [d.clientMessageId] : [],
    );
    return;
  }
  if (keepLocal || flags.fenced || !flags.rebuild) return;
  if (d && activeKey) {
    if ((sess._lastAcceptedFrameSeqOrderByKey?.[activeKey] ?? 0) <= flags.cutoff) {
      ctx.noteAuthoritativeFrameSeqReset(sess, { sessionKey: activeKey });
      resetFrameSeqCursor(sess, { sessionKey: activeKey });
      ctx.resetOwnerLocalRows(sess, [d.clientMessageId], new Set());
    }
    return;
  }
  resetAgentFrameSeqCursorsForSession(sess, {
    keepAcceptedAfterOrder: flags.cutoff,
    onResetKey: (sessionKey) => ctx.noteAuthoritativeFrameSeqReset(sess, { sessionKey }),
  });
}

function finishSnapshotRelayAndPersistence(
  ctx: SocketCtx,
  sess: ChatSession,
  last: SessionSnapshot,
  settled: string | undefined,
  opts: {
    fresh: boolean;
    asked?: string;
    fenced: boolean;
    degraded: boolean;
    recoveredViaUnits: boolean;
  },
): void {
  if (last.streamKey && last.dispatch) {
    sess._snapshotStream = {
      streamKey: last.streamKey,
      agentId: last.dispatch.agentId || "main",
    };
  }
  if (opts.degraded && !opts.recoveredViaUnits) {
    sess._liveJournalDegraded = true;
    ctx.scheduleDegradedJournalRetry(sess.id);
  } else {
    ctx.clearLiveJournalDegraded(sess);
  }
  if (!applySnapshotHeadToSession(ctx, sess, last, opts.fresh, true, opts.asked) && settled) {
    ctx.syncHistory(sess.id, { clientMessageId: settled });
  }
  if (!opts.fenced && ctx.relayContainerId && ctx.relayContainerId > 0) {
    const resetOpts = {
      keepAcceptedAfterOrder: ctx.relayContainerBoundOrder,
      onResetKey: (sessionKey: string) => ctx.noteAuthoritativeFrameSeqReset(sess, { sessionKey }),
    };
    ctx.reconcileContainerForSession(sess);
    if (opts.fresh && isOpenSnapshotDispatch(last.dispatch) && (!opts.degraded || opts.recoveredViaUnits)) {
      reconcileOpenSnapshotRelayContainer(
        sess,
        ctx.relayContainerId,
        last.dispatch.agentId || "main",
        resetOpts,
      );
    }
  }
  ctx.deps.persistSession?.(sess.id);
  ctx.scheduleNotify();
}

export function applySessionSnapshotToSocket(
  ctx: SocketCtx,
  sessId: string,
  snap: SessionSnapshot,
  snapCtx: SnapshotApplyContext,
): Promise<void> {
  const sess = ctx.sessions.get(sessId);
  if (!sess || snap.sessionId !== sessId) return Promise.resolve();
  const fresh =
    snapCtx.via === "ws" ||
    ((sess._lastFrameAt ?? 0) <= snapCtx.requestedAt &&
      (ctx.wsSnapshotAt.get(sessId) ?? 0) <= snapCtx.requestedAt);
  const now = Date.now();
  ctx.snapshotAckAt.set(sessId, now);
  if (snapCtx.via === "ws") ctx.wsSnapshotAt.set(sessId, now);
  const lifecycle = ctx.lifecycleEpoch;
  const current = () => ctx.sessions.get(sessId) === sess && ctx.lifecycleEpoch === lifecycle;

  return ctx.runDurableLiveFrameHydration(sessId, async () => {
    if (!current()) return;
    confirmSnapshotDelivery(sess, snap.dispatch);
    const d = snap.dispatch;
    if (isOpenSnapshotDispatch(d) && isTerminalSnapshotDispatch(sess, d)) {
      applySnapshotHeadToSession(ctx, sess, snap, false);
      ctx.scheduleNotify();
      return;
    }
    const rebuild = snapshotNeedsRebuild(sess, snap, snapCtx.requestedOrder);
    if (
      fresh &&
      isOpenSnapshotDispatch(d) &&
      mayClaimSnapshotDispatch(sess, d) &&
      (rebuild || !snapshotIsStale(sess, snap))
    ) {
      if (!ctx.confirmDispatchAdmission(sessId, d.clientMessageId, d.acceptedAt != null)) {
        ctx.beginTurn(sess, d.clientMessageId, d.agentId);
        ctx.dispatchSlots.set(sessId, d.clientMessageId);
      }
      sess._turnStartedAt = d.since;
    }
    const fenced = isSnapshotFenced(sess, d);
    const pages = fenced
      ? { last: snap, records: [], degraded: false }
      : await readSnapshotPagesChain(ctx, sess, snap);
    if (!current()) return;

    const running = sess._sendingInFlight ? sess._activeClientMessageId : undefined;
    const activeKey = d ? safeSessionKeyForAgent(sess.id, d.agentId || "main") : undefined;
    const cutoff = snapCtx.requestedOrder ?? 0;
    const rebuildActive =
      rebuild &&
      Boolean(d) &&
      Boolean(activeKey) &&
      (sess._snapshotStream?.streamKey !== pages.last.streamKey ||
        (sess._lastAcceptedFrameSeqOrderByKey?.[activeKey!] ?? 0) <= cutoff ||
        !snapshotIsStale(sess, pages.last));

    let recoveredViaUnits = false;
    if (rebuildActive && pages.degraded && !fenced && d && activeKey) {
      const unitOutcome = await tryRecoverSnapshotViaLiveUnits(
        ctx,
        sess,
        pages.last,
        d,
        activeKey,
        current,
      );
      if (unitOutcome === null) return;
      recoveredViaUnits = unitOutcome;
    }
    if (!recoveredViaUnits) {
      replayOrResetSnapshotFrames(ctx, sess, pages, d, activeKey, {
        rebuild,
        rebuildActive,
        fenced,
        cutoff,
      });
    }
    const settled =
      running && !(sess._sendingInFlight && sess._activeClientMessageId === running)
        ? running
        : undefined;
    finishSnapshotRelayAndPersistence(ctx, sess, pages.last, settled, {
      fresh,
      asked: snapCtx.asked,
      fenced,
      degraded: pages.degraded,
      recoveredViaUnits,
    });
  });
}

export function armSnapshotWatchdogTimer(ctx: SocketCtx): void {
  if (!ctx.deps.readSessionSnapshot) return;
  const triggeredAt = Date.now();
  if (ctx.snapshotWatchTimer) clearTimeout(ctx.snapshotWatchTimer);
  ctx.snapshotWatchTimer = setTimeout(() => {
    ctx.snapshotWatchTimer = null;
    for (const sessId of snapshotWatchTargets(ctx.sessions, ctx.activeSessionId)) {
      if ((ctx.snapshotAckAt.get(sessId) ?? 0) < triggeredAt) {
        void fetchSessionSnapshotHttp(ctx, sessId, { retry: true });
      }
    }
  }, SNAPSHOT_ACK_TIMEOUT_MS);
}

export function fetchSessionSnapshotHttp(
  ctx: SocketCtx,
  sessId: string,
  opts: { retry?: boolean; verifyOnly?: boolean } = {},
): Promise<SessionSnapshot | null | undefined> {
  const read = ctx.deps.readSessionSnapshot;
  const sess = ctx.sessions.get(sessId);
  if (!read || !sess || ctx.snapshotHttpInFlight.has(sessId)) {
    return Promise.resolve(undefined);
  }
  ctx.snapshotHttpInFlight.add(sessId);
  const requestedAt = Date.now();
  const requestedOrder = currentFrameSeqAcceptOrder();
  const lifecycle = ctx.lifecycleEpoch;
  const query: SnapshotQuery = opts.verifyOnly
    ? { afterSeq: 0, limit: 1 }
    : snapshotQuery(sess, ctx.deps.defaultAgentId);
  return Promise.resolve()
    .then(() => read(sessId, query))
    .then(
      (snap) => {
        ctx.snapshotHttpInFlight.delete(sessId);
        if (lifecycle !== ctx.lifecycleEpoch) return undefined;
        if (!isSessionSnapshot(snap)) return null;
        if (!opts.verifyOnly) {
          void ctx.applySessionSnapshot(sessId, snap, {
            via: "http",
            requestedAt,
            requestedOrder,
            asked: query.dispatch,
          });
        }
        return snap;
      },
      () => {
        ctx.snapshotHttpInFlight.delete(sessId);
        if (opts.retry && lifecycle === ctx.lifecycleEpoch) {
          setTimeout(() => {
            if (lifecycle === ctx.lifecycleEpoch) void fetchSessionSnapshotHttp(ctx, sessId);
          }, SNAPSHOT_ACK_TIMEOUT_MS);
        }
        return undefined;
      },
    );
}
