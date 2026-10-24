import type {AuthorizeSwitch} from '../../hooks/useModelSwitchCost';
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatSocket, type ChatSocketDeps } from "./socket";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  /** Handshake only: the bridge has not confirmed the container relay yet. */
  handshake() {
    this.readyState = 1;
    this.onopen?.();
  }
  relayReady() {
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
  }
  serverClose(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function makeSocket(overrides: Partial<ChatSocketDeps> = {}) {
  return new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ...overrides,
  });
}

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
afterEach(()=>{FakeWS.instances=[];vi.unstubAllGlobals();vi.useRealTimers();});
test('cancel before send creates no user row or session',async()=>{
 const authorizeSwitch=vi.fn(async()=>null);
 const sock=makeSocket({authorizeSwitch});
 expect(await sock.sendMessage({sessId:'s1',agentId:'main',model:'gpt-6-astra',text:'keep draft'})).toBe(false);
 expect(sock.sessions.has('s1')).toBe(false);
});
test('silent refusal pauses one queued turn, releases its slot and lets a later explicit send proceed',async()=>{
 vi.useFakeTimers();vi.stubGlobal('WebSocket',FakeWS as unknown as typeof WebSocket);
 let allowed=false;
 const authorizeSwitch=vi.fn<AuthorizeSwitch>(async(input,_opts)=>allowed?{requestId:input.requestId,choice:true as const}:null);
 const sock=makeSocket({authorizeSwitch});sock.setGateReady(true);
 const ws=FakeWS.instances.at(-1)!;ws.handshake();ws.relayReady();
 await sock.sendMessage({sessId:'s1',agentId:'main',model:'gpt-6-astra',text:'first',switchAuthorization:{requestId:'m-cost-first',choice:true}});await flush();
 const sess=sock.sessions.get('s1')!;
 expect(sess.messages.find(m=>m.id==='m-cost-first')?.status).toBe('error');expect(sess._dispatchPaused).toBe(true);
 expect(ws.sent.map(s=>JSON.parse(s)).filter(f=>f.type==='inbound.message')).toHaveLength(0);
 allowed=true;
 await sock.sendMessage({sessId:'s1',agentId:'main',model:'gpt-6-astra',text:'second',switchAuthorization:{requestId:'m-cost-second',choice:true}});await flush();
 const sent=ws.sent.map(s=>JSON.parse(s)).filter(f=>f.type==='inbound.message');
 expect(sent).toHaveLength(1);expect(sent[0].clientMessageId).toBe('m-cost-second');
 expect(authorizeSwitch.mock.calls.every(call=>call[1]?.interactive===false)).toBe(true);
 sock.stop();
});
test('cancelling explicit retry preserves its failed identity and routing',async()=>{
 const sock=makeSocket();await sock.sendMessage({sessId:'s1',agentId:'main',model:'gpt-6-astra',text:'original'});
 const sess=sock.sessions.get('s1')!;
 const user=sess.messages.find(m=>m.role==='user')!;user.status='error';sess._dispatchPaused=true;
 const id=user.id;
 const route=JSON.stringify(user._routing);
 // Install the same production callback after creating a legacy failed row.
 (sock as unknown as {deps:ChatSocketDeps}).deps.authorizeSwitch=async()=>null;
 await sock.retryMessage({sessId:'s1',msgId:id,agentId:'main'});
 expect(user.id).toBe(id);expect(user.status).toBe('error');expect(JSON.stringify(user._routing)).toBe(route);expect(sess._dispatchPaused).toBe(true);
});
