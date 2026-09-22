import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../src/components/MessageRenderer";
import { createStickToBottomController } from "../src/components/chat/stickToBottom";
import type { ChatMessage } from "../src/lib/chat/model";
import { TooltipProvider } from "../src/components/ui";

type Scene = "gallery" | "stream" | "find" | "attention";
type Mode = "legacy" | "manus";

function row(id: string, role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ts: 1_700_000_000_000, ...extra };
}

const gallery: ChatMessage[] = [
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

function streamMessages(extra: string): ChatMessage[] {
  const body = `${"这是正在写入的长回答，应该整段可见。".repeat(8)}\nSTREAM_TAIL_MARKER${extra}`;
  return [
    row("u-stream", "user", "继续写看板说明", { status: "sent" }),
    row("stage-stream", "assistant", "先核对库存口径，再出桌面和手机两套布局。", { _clientMessageId: "u-stream" }),
    row("bash-stream", "tool", "终端", {
      _clientMessageId: "u-stream",
      toolName: "Bash",
      inputJson: { command: "probe-stock-layout" },
      _completed: true,
      output: "ok",
    }),
    row("answer-stream", "assistant", body, { _clientMessageId: "u-stream" }),
  ];
}

function findMessages(): ChatMessage[] {
  const messages: ChatMessage[] = [
    row("u-find", "user", "先查旧记录", { status: "replied" }),
    row("stage-find", "assistant", "阶段锚点ALPHATOKEN 在折叠的过程里。", { _clientMessageId: "u-find" }),
    row("bash-find", "tool", "终端", {
      _clientMessageId: "u-find",
      toolName: "Bash",
      inputJson: { command: "probe-stock-layout" },
      _completed: true,
      output: "ok",
    }),
    row("answer-find", "assistant", "这一轮的回答在后面。", { _clientMessageId: "u-find" }),
  ];
  for (let i = 0; i < 24; i += 1) {
    const id = `fill-${i}`;
    messages.push(
      row(`user-${id}`, "user", `后续问题 ${i}`, { status: "replied" }),
      row(`assistant-${id}`, "assistant", `填充正文 ${i}。${"占位段落。".repeat(6)}`, { _clientMessageId: `user-${id}` }),
    );
  }
  return messages;
}

function attentionMessages(): ChatMessage[] {
  return [
    row("u-att", "user", "等我确认", { status: "sent" }),
    row("stage-att", "assistant", "我先查一下隐藏命令", { _clientMessageId: "u-att" }),
    row("bash-att", "tool", "终端", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      inputJson: { command: "hidden-probe-cmd" },
      _completed: true,
      output: "ok",
    }),
    row("err-att", "tool", "失败命令", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      inputJson: { command: "broken-probe" },
      _completed: true,
      error: true,
      output: "probe-error-detail",
    }),
    row("ask-att", "permission", "执行命令", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      requestId: "req-browser-deny",
      _resolved: false,
      inputPreview: "ls",
      inputJson: { command: "ls" },
      ts: Date.now(),
    }),
    row("approval-att", "tool", "审批", {
      _clientMessageId: "u-att",
      toolName: "mcp__openclaude-memory__present_task_approval",
      inputJson: { id: "OCV5-265" },
      _completed: false,
      output: "ok",
    }),
    row("answer-att", "assistant", "还差你的确认", { _clientMessageId: "u-att" }),
  ];
}

function messagesFor(scene: Scene, extra: string): ChatMessage[] {
  if (scene === "stream") return streamMessages(extra);
  if (scene === "find") return findMessages();
  if (scene === "attention") return attentionMessages();
  return gallery;
}

function Harness() {
  const [mode, setMode] = useState<Mode>("manus");
  const [scene, setScene] = useState<Scene>("gallery");
  const [sending, setSending] = useState(false);
  const [extra, setExtra] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [respondCount, setRespondCount] = useState(0);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const stick = useRef(createStickToBottomController()).current;
  const followBottomRef = useMemo(() => ({
    get current() {
      return stick.following.current;
    },
    set current(value: boolean) {
      stick.following.current = value;
    },
    scrollToBottom: stick.scrollToBottom,
    jumpToBottom: stick.jumpToBottom,
    correctTo: stick.correctTo,
    releaseUserIntent: stick.releaseUserIntent,
  }), [stick]);
  const messages = messagesFor(scene, extra);
  const scrolled = scene === "find";

  const page = {
    setMode,
    setScene(next: Scene) {
      setScene(next);
      setExtra("");
      setSending(next === "stream");
      setFindOpen(next === "find");
      setRespondCount(0);
    },
    setSending,
    appendAnswer(text: string) {
      setExtra((value) => value + text);
    },
    respondCount,
  };
  (window as unknown as { __processPage: typeof page }).__processPage = page;

  const list = (
    <MessageList
      processDisclosure={mode === "manus"}
      messages={messages}
      sending={sending}
      sessionId={`browser-${scene}`}
      cb={{}}
      onRespondPermission={() => setRespondCount((count) => count + 1)}
      scrollParent={scrolled ? scroller ?? undefined : undefined}
      followBottomRef={scrolled ? followBottomRef : undefined}
      find={findOpen ? { onClose: () => setFindOpen(false) } : undefined}
    />
  );

  return (
    <TooltipProvider>
      <div data-testid="process-harness" data-mode={mode} data-scene={scene} data-respond-count={respondCount}>
        {scrolled ? (
          <div
            ref={setScroller}
            data-testid="process-chat-scroll"
            className="chat-scroll-area overflow-x-hidden"
            style={{ height: 420, overflowY: "scroll" }}
            onScroll={() => {
              if (scroller) stick.onScroll(scroller);
            }}
          >
            {list}
          </div>
        ) : list}
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
