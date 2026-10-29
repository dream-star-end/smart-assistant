/**
 * 浏览器端唯一的恢复协议：权威快照 + afterSeq 增量（GOAL W1）。
 *
 * WS hello 收到的 `outbound.session_snapshot` 和 HTTP `GET /api/sessions/:id/live-frames`
 * 返回的 `snapshot` 是服务端同一个 `buildSessionSnapshot` 的输出（契约见 #1200）。这里放
 * 两条传输共用的纯判定：快照形状、请求游标、合并规则（B3-SPEC §4 R1–R5）、B3 兜底目标。
 * 应用本身在 ChatSocket.applySessionSnapshot，两条传输只有这一个入口。
 */
import { isClientMessageId, type SessionSnapshot } from "@openclaude/protocol/browser";
import type { DurableLiveFrame } from "../types";
import type { ChatSession } from "./model";
import { getFrameSeqCursor, safeSessionKeyForAgent } from "./pure";

export type { SessionSnapshot };

/** B3：visible / online 之后这么久没收到某会话的快照或带序号的帧，就改走 HTTP 拿同一份快照。 */
export const SNAPSHOT_ACK_TIMEOUT_MS = 8_000;
/** 一次恢复最多读这么多页（每页 500 帧）；超出标降级，界面给重试入口。 */
export const SNAPSHOT_MAX_PAGES = 24;
export const SNAPSHOT_PAGE_LIMIT = 500;

/** HTTP 快照请求。afterSeq 只和 streamKey 成对使用；dispatch 是本地在飞回合的 cmid。 */
export type SnapshotQuery = {
  afterSeq: number;
  streamKey?: string;
  dispatch?: string;
  limit?: number;
};

export type SnapshotDispatch = NonNullable<SessionSnapshot["dispatch"]>;

export function isSessionSnapshot(raw: unknown): raw is SessionSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const snap = raw as Partial<SessionSnapshot>;
  return snap.v === 1 &&
    typeof snap.sessionId === "string" &&
    Array.isArray(snap.frames) &&
    !!snap.pendingPermissions && Array.isArray(snap.pendingPermissions.items) &&
    (snap.dispatch === null || (typeof snap.dispatch === "object" && typeof snap.dispatch?.clientMessageId === "string"));
}

export function isOpenSnapshotDispatch(d: SessionSnapshot["dispatch"]): d is SnapshotDispatch {
  return !!d && (d.status === "admitted" || d.status === "accepted");
}

/** 快照流所属 agent：游标、hello 首个 peer 都按它取，保证 afterSeq 与 streamKey 是同一个 sessionKey。 */
export function snapshotLeadAgent(
  sess: Pick<ChatSession, "agentId" | "_snapshotStream">,
  defaultAgentId?: string,
): string {
  return sess._snapshotStream?.agentId || sess.agentId || defaultAgentId || "main";
}

/** 与 hello 同口径的请求游标。没有记过流时仍报本地游标，服务端据此判 cursor_reset 并从头给。 */
export function snapshotQuery(
  sess: Pick<ChatSession, "id" | "agentId" | "_snapshotStream" | "_lastFrameSeqByKey" | "_lastFrameSeq" |
    "_sendingInFlight" | "_activeClientMessageId">,
  defaultAgentId?: string,
): SnapshotQuery {
  const key = safeSessionKeyForAgent(sess.id, snapshotLeadAgent(sess, defaultAgentId));
  const afterSeq = getFrameSeqCursor(sess._lastFrameSeqByKey, sess._lastFrameSeq, key);
  return {
    afterSeq: Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0,
    ...(sess._snapshotStream ? { streamKey: sess._snapshotStream.streamKey } : {}),
    ...(sess._sendingInFlight && isClientMessageId(sess._activeClientMessageId)
      ? { dispatch: sess._activeClientMessageId }
      : {}),
  };
}

/** 快照帧转成与 HTTP 旧页同形的记录，交给同一个 frameSeq reducer。 */
export function snapshotFrameRecords(snap: SessionSnapshot): DurableLiveFrame[] {
  if (!snap.streamKey) return [];
  const clientMessageId = snap.dispatch?.clientMessageId ?? null;
  return snap.frames.map((frame) => ({
    recordId: frame.recordId,
    streamKey: snap.streamKey!,
    source: "gateway" as const,
    clientMessageId,
    payload: frame.payload,
  }));
}

/** R3：本地在这条流上已经见过比快照水位更新的帧，快照的状态头作废（帧照常去重合并）。 */
export function snapshotIsStale(
  sess: Pick<ChatSession, "id" | "_lastFrameSeqByKey" | "_lastFrameSeq">,
  snap: SessionSnapshot,
): boolean {
  if (!snap.dispatch || typeof snap.lastFrameSeq !== "number") return false;
  const key = safeSessionKeyForAgent(sess.id, snap.dispatch.agentId || "main");
  return getFrameSeqCursor(sess._lastFrameSeqByKey, sess._lastFrameSeq, key) > snap.lastFrameSeq;
}

/** A reset may replace an old stream cursor, but cannot erase newer live evidence on the same stream. */
export function snapshotNeedsRebuild(
  sess: Pick<ChatSession, "id" | "_snapshotStream" | "_lastFrameSeqByKey" | "_lastFrameSeq">,
  snap: SessionSnapshot,
): boolean {
  return snap.gap?.reason === "cursor_reset" &&
    (sess._snapshotStream?.streamKey !== snap.streamKey || !snapshotIsStale(sess, snap));
}

/** An outstanding Stop holds live content until settlement; a past local cancellation cannot overrule a server snapshot. */
export function isSnapshotFenced(
  sess: Pick<ChatSession, "_stopSettlement">,
  d: SessionSnapshot["dispatch"],
): boolean {
  return !!d && sess._stopSettlement?.clientMessageId === d.clientMessageId;
}

/** R1/R4：本地已经收尾或用户停过的回合，晚到的 open 快照不能把它复活。 */
export function mayClaimSnapshotDispatch(
  sess: Pick<ChatSession, "messages" | "_cancelledAutomaticRecoveryIds" | "_sendingInFlight" | "_stopSettlement">,
  d: SnapshotDispatch,
): boolean {
  if (sess._sendingInFlight || sess._stopSettlement || isSnapshotFenced(sess, d)) return false;
  const user = sess.messages.find((message) => message.role === "user" && message.id === d.clientMessageId);
  return user?.status !== "replied" && user?.status !== "error";
}

/** B3 §2.2：到点检查当前选中的会话和所有在飞会话。 */
export function snapshotWatchTargets(
  sessions: ReadonlyMap<string, Pick<ChatSession, "_sendingInFlight">>,
  activeSessionId: string | undefined,
): string[] {
  const targets = new Set<string>();
  if (activeSessionId && sessions.has(activeSessionId)) targets.add(activeSessionId);
  for (const [id, sess] of sessions) if (sess._sendingInFlight) targets.add(id);
  return [...targets];
}
