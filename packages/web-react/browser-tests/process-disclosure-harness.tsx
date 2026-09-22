import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../src/components/MessageRenderer";
import type { ChatMessage } from "../src/lib/chat/model";
import { TooltipProvider } from "../src/components/ui";

function row(id: string, role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ts: 1_700_000_000_000, ...extra };
}

const messages: ChatMessage[] = [
  row("u1", "user", "做一版库存看板", { status: "replied" }),
  row("stage-1", "assistant", "先核对库存口径，再出桌面和手机两套布局。", { _clientMessageId: "u1" }),
  row("bash-1", "tool", "终端", {
    _clientMessageId: "u1",
    toolName: "Bash",
    inputJson: { command: "probe-stock-layout" },
    _completed: true,
    output: "ok",
  }),
  row("read-1", "tool", "读取", {
    _clientMessageId: "u1",
    toolName: "Read",
    inputJson: { file_path: "/tmp/stock-threshold.txt" },
    _completed: true,
    output: "threshold",
  }),
  row("answer-1", "assistant", "看板已经做好。桌面和手机布局都过了检查。", { _clientMessageId: "u1" }),
  row("pdf-1", "tool", "PDF", {
    _clientMessageId: "u1",
    toolName: "Bash",
    inputJson: { command: "oc-pdf paper.qmd -o /home/agent/out/paper.pdf" },
    _completed: true,
    output: "wrote pdf",
  }),
];

function Harness() {
  const [mode, setMode] = useState<"legacy" | "manus">("manus");
  const [openSignal, setOpenSignal] = useState(0);
  return (
    <TooltipProvider>
      <div data-testid="process-harness" data-mode={mode} data-open-signal={openSignal}>
        <MessageList
          processDisclosure={mode === "manus"}
          messages={messages}
          sending={false}
          sessionId="browser-session"
          cb={{}}
          onRespondPermission={() => {}}
        />
      </div>
      <span className="hidden" data-api-ready={ready(setMode, setOpenSignal) ? "1" : "0"} />
    </TooltipProvider>
  );
}

function ready(
  setMode: (mode: "legacy" | "manus") => void,
  setOpenSignal: (value: number) => void,
): boolean {
  const page = {
    setMode,
    requestOpen() {
      setOpenSignal(Date.now());
    },
  };
  (window as unknown as { __processPage: typeof page }).__processPage = page;
  return true;
}

createRoot(document.getElementById("root")!).render(<Harness />);
