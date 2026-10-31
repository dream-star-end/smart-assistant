// Real chat projection, reducers and Composer; transport/storage are deterministic fixtures.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { MessageList } from "../src/components/MessageRenderer";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import { type ChatMessage } from "../src/lib/chat/model";
import { applyPermissionSettled } from "../src/lib/chat/reducer";
import { ChatSocket } from "../src/lib/chat/socket";
import { backgroundStopControl } from "../src/lib/chat/backgroundDelegates";

const STORAGE = "oc-676-server-fixture";
const initial = (): ChatMessage[] => [
  { id: "u-task", role: "user", text: "独立校验", ts: 1, status: "sent" },
  { id: "a-task", role: "assistant", text: "任务已在后台处理，可继续对话。", ts: 2 },
  { id: "ask-user:676", requestId: "ask-user:676", role: "permission", toolName: "AskUserQuestion", text: "选择校验方式", ts: Date.now(),
    inputJson: { questions: [{ question: "选择校验方式", options: [{ label: "继续" }] }] }, _resolved: false, _askUserExpiresAt: Date.now() + 3600_000 },
];

function Harness() {
  const [state] = useState(() => {
    const socket = new ChatSocket({ getToken: () => "fixture", getAuthEpoch: () => 0,
      silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }), onAuthExpired() {}, defaultAgentId: "main" });
    const session = socket.ensureSession("web-676", "main");
    let rows = initial();
    try { rows = JSON.parse(localStorage.getItem(STORAGE) || "null") || rows; } catch { /* fresh fixture */ }
    socket.applyServerMessages(session.id, "main", rows, true);
    return { socket, session };
  });
  const [, redraw] = useState(0);
  const [sent, setSent] = useState("");
  const [stopped, setStopped] = useState("");
  const [running, setRunning] = useState(true);
  const update = () => { localStorage.setItem(STORAGE, JSON.stringify(state.session.messages)); redraw((n) => n + 1); };
  return <TooltipProvider><ToastProvider>
    <button onClick={() => {
      const group: ChatMessage = { id: "srv-bg-676", role: "agent-group", text: "校验结果", ts: 4, _source: "server", _backgroundDelegate: true,
        _delegateAgentId: "coding-assistant", _delegateRunId: "dlg-676", _completed: true, _resultPreview: "校验结果：三项已通过。" };
      state.socket.applyServerMessages(state.session.id, "main", [...state.session.messages, group], true);
      update();
    }}>后台结果到达</button>
    <button onClick={() => {
      applyPermissionSettled(state.session, { type: "outbound.permission_settled", sessionKey: "agent:main:webchat:dm:web-676", channel: "webchat",
        peer: { id: state.session.id, kind: "dm" }, requestId: "ask-user:676", behavior: "allow" }); update();
    }}>服务端确认回执</button>
    <output data-testid="sent">{sent}</output><output data-testid="stopped">{stopped}</output>
    <output data-testid="stored-background">{state.session.messages.filter((row) => row._backgroundDelegate).length}</output>
    <div id="pending-approval-bar-slot" />
    <MessageList messages={state.session.messages} sending={false} sessionId={state.session.id} cb={{}} onRespondPermission={({ requestId }) => {
      const question = state.session.messages.find((row) => row.requestId === requestId);
      if (question) question._controlPending = true;
      update();
    }} />
    <Composer backgroundRunning={running} onStop={() => {
      const control = backgroundStopControl(state.session.id, "main", ["dlgjob-676"]);
      setStopped(JSON.stringify(control?.payload)); setRunning(false);
    }} onSend={(text) => { setSent(text); }} />
  </ToastProvider></TooltipProvider>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
