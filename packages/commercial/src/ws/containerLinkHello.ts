import { inboundSessionKey } from "@openclaude/gateway";
import type { Queryable } from "../dispatch/turnDispatchStore.js";

type Peer = { peerId: string; agentId: string; lastFrameSeq: number; resumeActiveTurnCandidateMessageIds?: string[] };

/** Browser cursors describe a tab, never the shared consumer's persistence position. */
export class ContainerLinkHello {
  private readonly registered = new Set<string>();
  constructor(private readonly pool: Queryable, private readonly uid: bigint, private readonly containerId: number) {}

  async prepare(peers: unknown[]): Promise<{ type: "inbound.hello"; peers: Peer[] }> {
    const result: Peer[] = [];
    for (const value of peers) {
      if (!value || typeof value !== "object") continue;
      const raw = value as { peerId?: unknown; agentId?: unknown };
      if (typeof raw.peerId !== "string" || !raw.peerId) continue;
      const agentId = typeof raw.agentId === "string" && raw.agentId ? raw.agentId : "main";
      const sessionKey = inboundSessionKey({ agentId, channel: "webchat", peer: { id: raw.peerId, kind: "dm" } });
      const peer: Peer = { peerId: raw.peerId, agentId, lastFrameSeq: -1 };
      if (!this.registered.has(sessionKey)) {
        const replay = await readContainerLinkReplay(this.pool, this.uid, this.containerId, raw.peerId, sessionKey);
        peer.lastFrameSeq = replay.afterSeq;
        if (replay.afterSeq === 0 && replay.activeMessageIds.length > 0) {
          peer.resumeActiveTurnCandidateMessageIds = replay.activeMessageIds;
        }
        this.registered.add(sessionKey);
      }
      result.push(peer);
    }
    // Re-registration still refreshes repo-bind grace and non-ring snapshots.
    // No browser inFlight hints reach the container's synthetic-terminal path.
    return { type: "inbound.hello", peers: result };
  }
}

/** Explicit persisted cursor seam for later PG-driven link reconstruction. No startup scan here. */
export async function readContainerLinkReplay(pool: Queryable, uid: bigint, containerId: number, sessionId: string, sessionKey: string): Promise<{ afterSeq: number; activeMessageIds: string[] }> {
  const result = await pool.query<{ after_seq: string | number | null; active_message_ids: string[] }>(
    `SELECT -- container_link_replay
       (SELECT MAX(f.frame_seq) FROM client_session_live_frames f
         JOIN client_session_live_streams s ON s.stream_key=f.stream_key
        WHERE f.source='gateway' AND f.agent_container_id=$1 AND f.session_key=$2
          AND s.user_id=$3 AND s.session_id=$4) AS after_seq,
       ARRAY(SELECT d.client_message_id FROM turn_dispatches d
              WHERE d.user_id=$5 AND d.agent_container_id=$1 AND d.session_id=$4
                AND d.status IN ('admitted','accepted') AND d.terminal_at IS NULL
              ORDER BY d.admitted_at DESC LIMIT 8) AS active_message_ids`,
    [containerId, sessionKey, `c:${uid}`, sessionId, String(uid)],
  );
  const row = result.rows[0];
  return { afterSeq: Number(row?.after_seq ?? 0), activeMessageIds: row?.active_message_ids ?? [] };
}

/** Non-journal session snapshots also fan out; request replies (including pong) stay private. */
export function containerLinkSnapshotSession(data: import("ws").RawData, binary: boolean): string | null {
  if (binary) return null;
  try {
    const frame = JSON.parse(String(data));
    if (!["outbound.turn_status", "outbound.permission_request", "outbound.prompt_queue.snapshot"].includes(frame.type)) return null;
    const session = frame.peer?.id ?? frame.owner?.clientSessionId ?? frame.owner?.peer?.id;
    return typeof session === "string" ? session : null;
  } catch { return null; }
}
