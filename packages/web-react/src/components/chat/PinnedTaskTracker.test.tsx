import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { extractLatestTodos, PinnedTaskTracker } from "./PinnedTaskTracker";

afterEach(cleanup);

function todoMsg(id: string, todos: Array<{ content: string; status: string; activeForm?: string }>): ChatMessage {
  return { id, role: "tool", toolName: "TodoWrite", text: "TodoWrite", ts: 0, inputJson: { todos } } as ChatMessage;
}

describe("extractLatestTodos", () => {
  test("取最新一次顶层 TodoWrite 的 todos(replace 语义)", () => {
    const msgs: ChatMessage[] = [
      todoMsg("a", [{ content: "旧任务", status: "pending" }]),
      { id: "u", role: "user", text: "hi", ts: 1 } as ChatMessage,
      todoMsg("b", [
        { content: "任务一", status: "completed" },
        { content: "任务二", status: "in_progress", activeForm: "正在做任务二" },
      ]),
    ];
    const todos = extractLatestTodos(msgs);
    expect(todos.map((t) => t.content)).toEqual(["任务一", "任务二"]);
    expect(todos[1].activeForm).toBe("正在做任务二");
  });

  test("无 TodoWrite / 非 tool / 畸形项 → 安全", () => {
    expect(extractLatestTodos([])).toEqual([]);
    expect(extractLatestTodos([{ id: "x", role: "assistant", text: "hi", ts: 0 } as ChatMessage])).toEqual([]);
    // 子 agent 的 TodoWrite(非顶层 role==='tool')不计入
    expect(
      extractLatestTodos([{ id: "g", role: "agent-group", text: "", ts: 0, toolName: "TodoWrite" } as ChatMessage]),
    ).toEqual([]);
    // 畸形 todos 项被过滤,不崩
    const bad = { id: "b", role: "tool", toolName: "TodoWrite", text: "", ts: 0, inputJson: { todos: [null, 1, { content: "真的", status: "pending" }] } } as ChatMessage;
    expect(extractLatestTodos([bad]).map((t) => t.content)).toEqual(["真的"]);
  });
});

describe("PinnedTaskTracker 交互", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const TODOS = [
    { content: "任务一", status: "completed" },
    { content: "任务二", status: "in_progress", activeForm: "正在做任务二" },
    { content: "任务三", status: "pending" },
  ];

  test("初始展开全部 → 3s 后自动折叠成只显示正在执行的一条", () => {
    render(<PinnedTaskTracker todos={TODOS} />);
    // 初始:全部任务可见 + 进度
    expect(screen.getByText("任务 1/3")).toBeInTheDocument();
    expect(screen.getByText("任务一")).toBeInTheDocument();
    expect(screen.getByText("任务三")).toBeInTheDocument();
    // 自动折叠
    act(() => { vi.advanceTimersByTime(3100); });
    // 折叠后:只剩正在执行的那条(activeForm),其余隐藏
    expect(screen.getByText("正在做任务二")).toBeInTheDocument();
    expect(screen.queryByText("任务三")).toBeNull();
    expect(screen.queryByText("任务一")).toBeNull();
  });

  test("空任务 → 不渲染", () => {
    const { container } = render(<PinnedTaskTracker todos={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("全部完成 → 不渲染(不留完成残条,打开旧会话不闪)", () => {
    const { container } = render(<PinnedTaskTracker todos={[{ content: "唯一任务", status: "completed" }]} />);
    expect(container.firstChild).toBeNull();
  });
});
