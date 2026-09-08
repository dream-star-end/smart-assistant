// Real ChatSocket/reducer/MessageList; simulated gateway wire, no live account.
import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../src/components/MessageRenderer";
import { ChatSocket } from "../src/lib/chat/socket";
import { addMessage, type ChatMessage } from "../src/lib/chat/model";
const id = "cursor-browser";
const key = `agent:main:webchat:dm:${id}`;
const socket = new ChatSocket({
  getToken: () => "fixture", getAuthEpoch: () => 0,
  silentRefresh: async epoch => ({ kind: "transient", epoch, retryAfterMs: 500 }),
  onAuthExpired: () => {}, defaultAgentId: "main", syncSession: async () => {},
});
socket.loadStored({ id, title: "cursor fixture", agentId: "main", messages: [], createdAt: 1, lastAt: 2,
  _lastFrameSeqByKey: { [key]: 401 }, _lastFrameSeq: 401 });
const history: ChatMessage[] = [
  { id: "old-user", role: "user", text: "上次问题", ts: 1, _seq: 1 },
  { id: "old-answer", role: "assistant", text: "上次已完成", ts: 2, _seq: 2,
    _source: "server", _clientMessageId: "old-user", _turnTapeComplete: true },
];
const dispatch = (frame: unknown) => (socket as any).dispatch(frame);
(socket as any).ws = { readyState: 1, send(data: string) {
  const frame = JSON.parse(data);
  if (frame.type !== "inbound.hello") return;
  const peer = frame.peers.find((p: {peerId: string}) => p.peerId === id);
  if (peer?.lastFrameSeq > 0) queueMicrotask(() => dispatch({
    type: "outbound.resume_failed", channel: "webchat", peer: { id, kind: "dm" },
    sessionKey: key, from: peer.lastFrameSeq, to: 0, reason: "no_buffer",
  }));
}};
function continueOldSession() {
  socket.applyServerMessages(id, "main", history, true, 2);
  queueMicrotask(() => {
    const session = socket.sessions.get(id)!;
    const user = addMessage(session, "user", "继续");
    session._activeClientMessageId = user.id;
    session._sendingInFlight = true;
    session._turnStartedAt = Date.now();
    const base = { type: "outbound.message", channel: "webchat", peer: { id, kind: "dm" },
      sessionKey: key, clientMessageId: user.id, ts: Date.now(), isFinal: false };
    dispatch({ ...base, frameSeq: 1, blocks: [{ kind: "text", blockId: "new-text",
      messageId: "new-answer", text: "新的正文已实时显示" }] });
    dispatch({ ...base, frameSeq: 2, blocks: [{ kind: "tool_use", blockId: "new-tool",
      name: "Bash", input: { command: "pwd" } }] });
    (socket as any).scheduleNotify();
  });
}
function App() {
  const snapshot = useSyncExternalStore(socket.subscribe, socket.getSnapshot);
  const session = snapshot.sessions.get(id)!;
  return <><button onClick={continueOldSession}>继续旧会话</button>
    <MessageList messages={session.messages} sending={!!session._sendingInFlight}
      cb={{}} onRespondPermission={() => {}} /></>;
}
createRoot(document.getElementById("root")!).render(<App />);
