import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { extractLatestTodos, PinnedTaskTracker } from "./PinnedTaskTracker";

afterEach(cleanup);

function todoMsg(id: string, todos: Array<{ content: string; status: string; activeForm?: string }>): ChatMessage {
  return { id, role: "tool", toolName: "TodoWrite", text: "TodoWrite", ts: 0, inputJson: { todos } } as ChatMessage;
}

function planMsg(id: string, steps: ChatMessage["steps"]): ChatMessage {
  return { id, role: "plan", text: "执行计划", ts: 0, steps } as ChatMessage;
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

  test("structured plan steps 进入 HUD，并覆盖更旧 TodoWrite", () => {
    const msgs: ChatMessage[] = [
      todoMsg("a", [{ content: "旧 Todo", status: "in_progress" }]),
      planMsg("p", [
        { step: "确认现象", status: "completed" },
        { step: "修复计划卡", status: "inProgress" },
        { step: "回归测试", status: "pending" },
      ]),
    ];
    const todos = extractLatestTodos(msgs);
    expect(todos).toEqual([
      { content: "确认现象", status: "completed", activeForm: "" },
      { content: "修复计划卡", status: "in_progress", activeForm: "" },
      { content: "回归测试", status: "pending", activeForm: "" },
    ]);
  });

  test("更新的 TodoWrite 可覆盖旧 structured plan", () => {
    const msgs: ChatMessage[] = [
      planMsg("p", [{ step: "旧计划", status: "inProgress" }]),
      todoMsg("t", [{ content: "新任务", status: "pending" }]),
    ];
    expect(extractLatestTodos(msgs).map((t) => t.content)).toEqual(["新任务"]);
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

  test("旧 turn 任务不跨轮复活:turn1 有 todo → turn2 新 user 消息后无任务源 → 空", () => {
    const msgs: ChatMessage[] = [
      { id: "u1", role: "user", text: "帮我做任务", ts: 0 } as ChatMessage,
      todoMsg("t1", [
        { content: "旧任务一", status: "completed" },
        { content: "旧任务二", status: "in_progress" },
      ]),
      { id: "a1", role: "assistant", text: "进行中", ts: 1 } as ChatMessage,
      // turn2:用户问无关问题,本轮无 TodoWrite/plan → HUD 不得复活 turn1 的旧任务
      { id: "u2", role: "user", text: "今天天气如何", ts: 2 } as ChatMessage,
      { id: "a2", role: "assistant", text: "晴", ts: 3 } as ChatMessage,
    ];
    expect(extractLatestTodos(msgs)).toEqual([]);
  });

  test("多轮连续任务:新 turn 里的新 TodoWrite 正常进 HUD(替代旧 turn 任务集)", () => {
    const msgs: ChatMessage[] = [
      { id: "u1", role: "user", text: "开始", ts: 0 } as ChatMessage,
      todoMsg("t1", [{ content: "旧任务", status: "in_progress" }]),
      { id: "u2", role: "user", text: "继续", ts: 1 } as ChatMessage,
      todoMsg("t2", [
        { content: "旧任务", status: "completed" },
        { content: "新任务", status: "in_progress" },
      ]),
    ];
    expect(extractLatestTodos(msgs).map((t) => `${t.content}:${t.status}`)).toEqual([
      "旧任务:completed",
      "新任务:in_progress",
    ]);
  });

  test("旧 turn 的 structured plan 同样不跨轮复活", () => {
    const msgs: ChatMessage[] = [
      planMsg("p1", [{ step: "旧计划", status: "inProgress" }]),
      { id: "u2", role: "user", text: "换个话题", ts: 1 } as ChatMessage,
    ];
    expect(extractLatestTodos(msgs)).toEqual([]);
  });

  test("空/畸形 structured plan 不生成 HUD todos", () => {
    expect(extractLatestTodos([planMsg("empty", [])])).toEqual([]);
    expect(
      extractLatestTodos([
        { id: "bad-plan", role: "plan", text: "执行计划", ts: 0, steps: [null, { status: "inProgress" }] as any },
      ]),
    ).toEqual([]);
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
    render(<PinnedTaskTracker todos={TODOS} active={true} />);
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
    const { container } = render(<PinnedTaskTracker todos={[]} active={true} />);
    expect(container.firstChild).toBeNull();
  });

  test("全部完成 → 不渲染(不留完成残条,打开旧会话不闪)", () => {
    const { container } = render(<PinnedTaskTracker todos={[{ content: "唯一任务", status: "completed" }]} active={true} />);
    expect(container.firstChild).toBeNull();
  });

  test("当前 turn 非运行态 → 未完成历史任务也不渲染", () => {
    const { container } = render(<PinnedTaskTracker todos={TODOS} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});
