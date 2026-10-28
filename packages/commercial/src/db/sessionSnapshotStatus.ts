import type { DispatchCredits } from '@openclaude/protocol';

export function openDispatchTurnStatusSnapshotFrame(input: {
  peerId: string;
  agentId: string;
  clientMessageId: string;
  engineReady: boolean;
  admittedAt: Date;
  now?: number;
  credits?: DispatchCredits | null;
}): Record<string, unknown> {
  const safeId = input.peerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    type: "outbound.turn_status",
    sessionKey: `agent:${input.agentId || "main"}:webchat:dm:${safeId}`,
    channel: "webchat",
    peer: { id: input.peerId, kind: "dm" },
    clientMessageId: input.clientMessageId,
    status: input.engineReady ? null : "engine_starting",
    meta: { detached: true, since: input.admittedAt.getTime(), ...(input.credits ? { credits: input.credits } : {}) },
    ts: input.now ?? Date.now(),
  };
}

export function terminalDispatchReconcile(outcome: string | null): 'turn_completed' | 'interrupted' | null {
  if (outcome === 'completed') return 'turn_completed';
  return outcome === 'interrupted' || outcome === 'crashed' ? 'interrupted' : null;
}
