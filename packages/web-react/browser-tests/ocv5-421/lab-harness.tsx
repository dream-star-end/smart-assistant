// OCV5-421 render lab: real ChatSocket + reducer + MessageList, simulated gateway wire, no account.
// Scenes are driven from the node driver through window.__lab (frames go through the real dispatch path).
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../../src/components/MessageRenderer";
import { ChatSocket } from "../../src/lib/chat/socket";
import { addMessage } from "../../src/lib/chat/model";
import { ToastProvider, TooltipProvider } from "../../src/components/ui";

const id = "lab";
const key = `agent:main:webchat:dm:${id}`;
const socket = new ChatSocket({
  getToken: () => "fixture", getAuthEpoch: () => 0,
  silentRefresh: async (epoch: number) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
  onAuthExpired: () => {}, defaultAgentId: "main", syncSession: async () => {},
} as any);
socket.loadStored({ id, title: "lab", agentId: "main", messages: [], createdAt: 1, lastAt: 2 } as any);
(socket as any).ws = { readyState: 1, send() {} };
let seq = 0;
const sock = socket as any;
const sess = () => socket.sessions.get(id)! as any;
const notify = () => sock.scheduleNotify();

const noop = () => {};
// Same callback surface App passes (no-op here) so cards render the buttons users actually see.
const cb = { onRegenerate: noop, onTopUp: noop, onStartNewSession: noop, onOpenModelPicker: noop,
  onContinueInterrupted: noop, getToken: () => "fixture" };
const lab = {
  begin(text: string): string {
    const s = sess();
    const u = addMessage(s, "user", text);
    s._activeClientMessageId = u.id;
    s._sendingInFlight = true;
    s._turnStartedAt = Date.now();
    notify();
    return u.id;
  },
  frame(cmid: string, blocks: unknown[], isFinal = false, extra: Record<string, unknown> = {}) {
    sock.dispatch({ type: "outbound.message", channel: "webchat", peer: { id, kind: "dm" }, sessionKey: key,
      clientMessageId: cmid, ts: Date.now(), isFinal, frameSeq: ++seq, blocks, ...extra });
    notify();
  },
  raw(frame: Record<string, unknown>) {
    sock.dispatch({ channel: "webchat", peer: { id, kind: "dm" }, sessionKey: key, ts: Date.now(), frameSeq: ++seq, ...frame });
    notify();
  },
  // A whole turn, finalized: thinking → tools → answer text (chunked like a real stream).
  turn(spec: { user: string; thinking?: string; tools?: { name: string; input: unknown; output?: string; isError?: boolean; noResult?: boolean }[]; text?: string; final?: boolean; chunk?: number }) {
    const cmid = lab.begin(spec.user);
    const mid = `a-${cmid}`;
    if (spec.thinking) lab.frame(cmid, [{ kind: "thinking", blockId: `th-${cmid}`, messageId: `th-${cmid}`, text: spec.thinking }]);
    (spec.tools ?? []).forEach((t, i) => {
      const bid = `tu-${cmid}-${i}`;
      lab.frame(cmid, [{ kind: "tool_use", blockId: bid, toolName: t.name, inputJson: t.input }]);
      if (!t.noResult) lab.frame(cmid, [{ kind: "tool_result", blockId: `${bid}:result`, toolUseBlockId: bid, toolName: t.name, output: t.output ?? "", isError: !!t.isError }]);
    });
    const text = spec.text ?? "";
    const step = spec.chunk ?? 400;
    for (let i = 0; i < text.length; i += step) lab.frame(cmid, [{ kind: "text", blockId: mid, messageId: mid, text: text.slice(i, i + step) }]);
    if (spec.final !== false) lab.frame(cmid, [], true);
    return cmid;
  },
  // Stream `text` as deltas every `everyMs` (real timers, like a network stream); resolves when done.
  stream(cmid: string, text: string, opts: { chunk?: number; everyMs?: number; final?: boolean; messageId?: string } = {}) {
    const step = opts.chunk ?? 6;
    const every = opts.everyMs ?? 16;
    const mid = opts.messageId ?? `a-${cmid}`;
    let i = 0;
    return new Promise<void>((resolve) => {
      const tick = () => {
        if (i >= text.length) { if (opts.final !== false) lab.frame(cmid, [], true); resolve(); return; }
        lab.frame(cmid, [{ kind: "text", blockId: mid, messageId: mid, text: text.slice(i, i + step) }]);
        i += step;
        setTimeout(tick, every);
      };
      tick();
    });
  },
  dark(on: boolean) { document.documentElement.classList.toggle("dark", on); },
  session: () => sess(),
};
(window as any).__lab = lab;

function App() {
  const snapshot = useSyncExternalStore(socket.subscribe, socket.getSnapshot);
  const s = snapshot.sessions.get(id)! as any;
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <div ref={setEl} data-lab-scroll className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {el && (
          <MessageList processDisclosure messages={s.messages} sending={!!s._sendingInFlight}
            liveTurnUsage={s._liveTurnUsage} cb={cb as any} onRespondPermission={() => {}}
            scrollParent={el} sessionId={id} historyGeneration={`${id}::lab`} />
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <ToastProvider><TooltipProvider><App /></TooltipProvider></ToastProvider>,
);
