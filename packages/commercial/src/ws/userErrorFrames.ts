import { WebSocket } from 'ws';
import { withUserError } from '@openclaude/protocol';

export function sendErrorFrame(
  ws: WebSocket,
  code: string,
  message: string,
  turn?: {
    peerId?: string | null;
    clientMessageId?: string | null;
    retryable?: boolean;
    action?: string;
  },
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(withUserError({
      type: "error",
      code,
      message,
      ...(turn?.peerId ? { peer: { id: turn.peerId, kind: "dm" } } : {}),
      ...(turn?.clientMessageId ? { clientMessageId: turn.clientMessageId } : {}),
      ...(turn?.retryable === false || turn?.retryable === true ? { retryable: turn.retryable } : {}),
      ...(turn?.action ? { action: turn.action } : {}),
    })));
  }
  catch { /* client gone */ }
}

