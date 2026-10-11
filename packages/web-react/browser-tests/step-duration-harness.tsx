import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../src/components/MessageRenderer";
import type { ChatMessage } from "../src/lib/chat/model";
import { TooltipProvider } from "../src/components/ui";

// OCV5-367: one agent turn shaped like the operator's screenshot (several tool
// steps sharing one model call's 「共Xk token」), as a finished history turn and
// as a live turn with a step still running.
type Scene = "history" | "live";

function row(id: string, role: ChatMessage["role"], text: string, ts: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ts, ...extra } as ChatMessage;
}

function call(callId: string, targets: string[], totalTokens: number) {
  return { callId, targetIds: targets, usage: { totalTokens } } as ChatMessage["_callUsage"];
}

const T0 = 1_791_558_000_000;

function historyMessages(): ChatMessage[] {
  const owner = { _clientMessageId: "u1" };
  const tools = ["skill-1", "pwd-1", "list-1", "py-1"];
  return [
    row("u1", "user", "平台要求确认改成允许用户授权agent确认", T0, { status: "replied" }),
    row("think-1", "thinking", "**梳理授权链路**\n先看现有审批流程。", T0 + 4_000, { ...owner, _callUsage: call("c1", ["think-1"], 198_000) }),
    row("skill-1", "tool", "查看技能", T0 + 9_000, {
      ...owner, toolName: "Skill", inputJson: { skill: "openclaude-instance-topology" }, _completed: true, output: "ok",
      durationMs: 40, _callUsage: call("c2", tools, 205_000),
    }),
    row("pwd-1", "tool", "终端", T0 + 9_100, {
      ...owner, toolName: "Bash", inputJson: { command: "pwd; ls -la /home/agent/.openclaude/work" }, _completed: true, output: "ok",
      durationMs: 1_200, _callUsage: call("c2", tools, 205_000),
    }),
    row("list-1", "tool", "任务单列表", T0 + 31_000, {
      ...owner, toolName: "Bash", inputJson: { command: "oc-task ticket list running,ready" }, _completed: true, output: "ok",
      durationMs: 900, _callUsage: call("c3", ["list-1"], 211_000),
    }),
    row("py-1", "tool", "终端", T0 + 95_000, {
      ...owner, toolName: "Bash", inputJson: { command: "python3 - <<'PY'" }, _completed: true, output: "ok",
      durationMs: 125_000, _callUsage: call("c4", ["py-1"], 219_000),
    }),
    row("answer-1", "assistant", "可以。默认仍由用户确认；用户明确授权后 Agent 可以代确认。", T0 + 228_000, {
      ...owner, usage: { totalTokens: 227_000, inputTokens: 220_000, outputTokens: 7_000 },
    }),
  ];
}

function liveMessages(now: number): ChatMessage[] {
  const owner = { _clientMessageId: "u2" };
  return [
    row("u2", "user", "继续跑测试", now - 60_000, { status: "sent" }),
    row("think-2", "thinking", "**先跑单测**", now - 55_000, { ...owner, completedAt: now - 50_000 }),
    row("done-2", "tool", "终端", now - 50_000, {
      ...owner, toolName: "Bash", inputJson: { command: "npm run typecheck" }, _completed: true, output: "ok",
      completedAt: now - 42_000, _callUsage: call("c5", ["done-2"], 120_000),
    }),
    row("run-2", "tool", "终端", now - 30_000, {
      ...owner, toolName: "Bash", inputJson: { command: "npm test" }, _completed: false,
      _callUsage: call("c6", ["run-2"], 121_000),
    }),
  ];
}

function Harness() {
  const [scene, setScene] = useState<Scene>("history");
  const [now] = useState(() => Date.now());
  (window as unknown as { __stepPage: { setScene: (s: Scene) => void } }).__stepPage = { setScene };
  const messages = scene === "history" ? historyMessages() : liveMessages(now);
  return (
    <TooltipProvider>
      <div data-testid="step-harness" data-scene={scene} style={{ maxWidth: 760, padding: 16 }}>
        <MessageList
          key={scene}
          processDisclosure
          messages={messages}
          sending={scene === "live"}
          sessionId={`step-${scene}`}
          cb={{}}
        />
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
