/**
 * INC-20261028-STALE-ENGINE-STARTING — hello snapshot for an open
 * (admitted/accepted) dispatch.
 *
 * Once the last browser detaches, the bridge closes the container WS after the
 * drain window; frames emitted after that are neither persisted nor
 * replayable, so a reconnecting tab may still hold engine_starting from before
 * the disconnect. On hello the bridge sends that tab an authoritative phase
 * from persisted evidence only: status:null when the stream head proves the
 * engine got past startup, else engine_starting. meta.detached tells the
 * client the process between disconnect and now may be missing; meta.since is
 * the dispatch's admitted_at. Sent only to the hello's own userWs (other tabs
 * of the same uid may not be on this turn).
 */
import { WebSocket } from "ws";
import { readOpenDispatchEngineReady } from "../db/liveTurnFrames.js";
import type { TurnDispatchRow } from "../dispatch/turnDispatchStore.js";

type SnapshotRow = Pick<TurnDispatchRow, "status" | "dispatchId" | "attemptNo" | "agentId" | "admittedAt">;
type SnapshotLog = { info(msg: string, meta: Record<string, unknown>): void } | null | undefined;
type Queryable = Parameters<typeof readOpenDispatchEngineReady>[0];

export function openDispatchTurnStatusSnapshotFrame(input: {
  peerId: string;
  agentId: string;
  clientMessageId: string;
  engineReady: boolean;
  admittedAt: Date;
  now?: number;
}): Record<string, unknown> {
  const safeId = input.peerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    type: "outbound.turn_status",
    sessionKey: `agent:${input.agentId || "main"}:webchat:dm:${safeId}`,
    channel: "webchat",
    peer: { id: input.peerId, kind: "dm" },
    clientMessageId: input.clientMessageId,
    status: input.engineReady ? null : "engine_starting",
    meta: { detached: true, since: input.admittedAt.getTime() },
    ts: input.now ?? Date.now(),
  };
}

/**
 * Returns true when `row` is an open dispatch (the hello terminal fallback
 * must skip it), whether or not the snapshot could be sent.
 */
export async function sendHelloOpenDispatchSnapshot(
  q: Queryable,
  userWs: Pick<WebSocket, "readyState" | "send">,
  row: SnapshotRow,
  ids: { uid: string; peerId: string; clientMessageId: string },
  log: SnapshotLog,
): Promise<boolean> {
  if (row.status !== "admitted" && row.status !== "accepted") return false;
  const engineReady = await readOpenDispatchEngineReady(q, {
    dispatchId: row.dispatchId,
    attemptNo: row.attemptNo,
  });
  if (userWs.readyState !== WebSocket.OPEN) return true;
  try {
    userWs.send(JSON.stringify(openDispatchTurnStatusSnapshotFrame({
      peerId: ids.peerId,
      agentId: row.agentId,
      clientMessageId: ids.clientMessageId,
      engineReady,
      admittedAt: row.admittedAt,
    })));
    log?.info("user-chat-bridge: hello open dispatch status snapshot sent", {
      uid: ids.uid,
      sessionId: ids.peerId,
      clientMessageId: ids.clientMessageId,
      engineReady,
    });
  } catch { /* 发不出就静默降级 */ }
  return true;
}
