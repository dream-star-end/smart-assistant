import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ChatSocket, preciseRetryEligible } from "../src/lib/chat/socket";
import { MessageList } from "../src/components/MessageRenderer";
import type { ChatMessage } from "../src/lib/chat/model";
class Transport {
  static OPEN = 1;
  static latest: Transport;
  readyState = 0; bufferedAmount = 0; sent: string[] = [];
  onopen?: () => void; onmessage?: (e: { data: string }) => void;
  constructor() { Transport.latest = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  push(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  open() { this.readyState = 1; this.onopen?.(); this.push({ type: 'sys.relay_ready', automaticRecoveryOwner: 'master-v1' }); }
}
window.WebSocket = Transport as unknown as typeof WebSocket;
const authorityChecks: Array<{ at: number; sessId: string; context?: { clientMessageId?: string } }> = [];
const sock = new ChatSocket({ getToken: () => 'fixture', getAuthEpoch: () => 0,
  silentRefresh: async epoch => ({ kind: 'transient', epoch, retryAfterMs: 1000 }),
  onAuthExpired: () => {}, defaultAgentId: 'main', syncSession: async (sessId, context) => {
    authorityChecks.push({ at: Date.now(), sessId, context });
  } });
sock.setGateReady(true); Transport.latest.open();
const id = 's-browser-preparation', peer = { id, kind: 'dm' };
let source = '', child = 'm-recover-browser-preparation';
const pending = () => ({ cause: 'preparation' as const, mode: 'replay' as const,
  sourceClientMessageId: source, rootClientMessageId: source, attempt: 1, max: 10 });
const ack = () => Transport.latest.push({ type: 'outbound.ack', admitted: true, peer,
  clientMessageId: child, recovery: { ...pending(), automatic: true } });
const startSource = () => {
  sock.removeSession(id); authorityChecks.length = 0; child = 'm-recover-browser-preparation';
  sock.sendMessage({ sessId: id, agentId: 'main', text: '精确原始请求' });
  source = sock.sessions.get(id)!.messages.find(m => m.role === 'user')!.id;
  Transport.latest.push({ type: 'outbound.ack', admitted: true, peer, clientMessageId: source });
};
const begin = () => {
  startSource();
  Transport.latest.push({ type: 'outbound.error', peer, clientMessageId: source,
    code: 'DISPATCH_ENRICHMENT_TIMEOUT', message: 'prepare timeout' });
  Transport.latest.push({ ...pending(), type: 'sys.recovery_decision', peer,
    scheduled: true, errorCode: 'dispatch_enrichment_timeout' });
};
const restore = (payload: { source: string; rows: ChatMessage[]; childBound?: boolean; unified?: boolean }) => {
  source = payload.source;
  sock.removeSession(id);
  sock.applyServerMessages(id, 'main', payload.rows, true, 1, { serverUpdatedAt: 100,
    historyRevision: 2, ...(payload.unified ? { timelineGeneration: 2 } : {}),
    pendingRecovery: { ...pending(), ...(payload.childBound ? { clientMessageId: child } : {}) } });
};
const drive = {
  begin, ack, restore, startSource,
  authorityChecks: () => structuredClone(authorityChecks),
  queueHuman: () => sock.sendMessage({ sessId: id, agentId: "main", text: "排队的下一条请求" }),
  rawFrames: (frames: unknown[]) => frames.forEach(frame => Transport.latest.push(frame)),
  sent: () => Transport.latest.sent.map(raw => JSON.parse(raw)),
  sourceError: () => Transport.latest.push({ type: "outbound.error", peer, clientMessageId: source,
    code: "dispatch_enrichment_timeout", message: "late prepare timeout" }),
  state: () => ({ source, rows: structuredClone(sock.sessions.get(id)?.messages ?? []),
    sending: sock.sessions.get(id)?._sendingInFlight === true,
    turnStatus: sock.sessions.get(id)?._turnStatus }),
  success: () => Transport.latest.push({ type: 'outbound.message', channel: 'webchat', peer,
    clientMessageId: child, isFinal: true, ts: Date.now(), blocks: [{ kind: 'text', text: '准备后成功完成' }] }),
  exhausted: () => Transport.latest.push({ type: 'outbound.error', peer, clientMessageId: child,
    code: 'DISPATCH_PREPARATION_RETRY_EXHAUSTED', message: 'exhausted' }),
};
Object.assign(window, { preparation: drive });
function Harness() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const snap = useSyncExternalStore(sock.subscribe, sock.getSnapshot); void snap.version;
  const s = snap.sessions.get(id), busy = s?._sendingInFlight === true;
  return <><button onClick={() => sock.stopTurn(id)}>停止</button><div ref={setScroller} style={{ height: 720, overflow: 'auto' }}>
    <MessageList messages={s?.messages ?? []} sending={busy} cb={{
      onRetrySend: message => sock.retryMessage({ sessId: id, msgId: message.id, agentId: "main" }),
      resolveRetryTarget: clientMessageId => {
        const target = s?.messages.find(m => m.role === "user" && m.id === clientMessageId && m.status === "error");
        return target && preciseRetryEligible(target) ? target : undefined;
      },
    }} onRespondPermission={() => {}}
      scrollParent={scroller} historyGeneration={id} turnActivity={busy ? {
        startedAt: s?._turnStartedAt ?? null, turnStatus: s?._turnStatus, agentName: '助手' } : null} />
  </div></>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
