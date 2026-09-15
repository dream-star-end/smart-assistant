import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TodoItem } from "./PinnedTaskTracker";
import {
  deriveActivePlanStep,
  splitElapsedSeconds,
  stripElapsedSeconds,
  TurnActivity,
  type TurnActivityInfo,
} from "./TurnActivity";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function todo(content: string, status: string, activeForm?: string): TodoItem {
  return { content, status, activeForm };
}

describe("deriveActivePlanStep（团队模式队长当前步骤推导）", () => {
  test("优先取 in_progress 的 activeForm（进行时文案）", () => {
    const step = deriveActivePlanStep([
      todo("确认现象", "completed"),
      todo("修复计划卡", "in_progress", "正在修复计划卡"),
      todo("回归测试", "pending"),
    ]);
    expect(step).toBe("正在修复计划卡");
  });

  test("in_progress 无 activeForm → 取 content", () => {
    expect(deriveActivePlanStep([todo("跑测试", "in_progress")])).toBe("跑测试");
  });

  test("无 in_progress → 取第一条未完成（即将执行）", () => {
    const step = deriveActivePlanStep([
      todo("A", "completed"),
      todo("B", "pending"),
      todo("C", "pending"),
    ]);
    expect(step).toBe("B");
  });

  test("全部完成 / 空 → null", () => {
    expect(deriveActivePlanStep([todo("A", "completed")])).toBeNull();
    expect(deriveActivePlanStep([])).toBeNull();
  });
});

describe("TurnActivity（激活 computeTypingLabel 死代码：阶段反馈接线）", () => {
  function renderTA(info: Partial<TurnActivityInfo>) {
    const full: TurnActivityInfo = { startedAt: Date.now(), agentName: "助手", ...info };
    render(<TurnActivity info={full} />);
  }

  test("基础：computeTypingLabel 产出「思考中」+ 秒数", () => {
    renderTA({ startedAt: Date.now() - 10_000 }); // ~10s
    expect(screen.getByLabelText("生成中").textContent).toContain("思考中");
    expect(screen.getByLabelText("生成中").textContent).toContain("10s");
  });

  test("compacting → 正在压缩上下文", () => {
    renderTA({ startedAt: Date.now() - 3000, turnStatus: "compacting" });
    expect(screen.getByLabelText("生成中").textContent).toContain("正在压缩上下文");
  });

  test("engine_starting → 正在启动引擎(不误标思考中)", () => {
    renderTA({ startedAt: Date.now() - 8000, turnStatus: "engine_starting" });
    const text = screen.getByLabelText("生成中").textContent ?? "";
    expect(text).toContain("正在启动引擎");
    expect(text).toContain("8s");
    expect(text).not.toContain("思考中");
  });

  test("engine_resuming → 正在恢复会话(长等待也不升级成深度思考)", () => {
    renderTA({ startedAt: Date.now() - 35_000, turnStatus: "engine_resuming" });
    const text = screen.getByLabelText("生成中").textContent ?? "";
    expect(text).toContain("正在恢复会话");
    expect(text).not.toContain("深度思考");
  });

  test("waiting_for_user → 不再显示模型卡住", () => {
    renderTA({ startedAt: Date.now() - 20 * 60_000, turnStatus: "waiting_for_user" });
    expect(screen.getByText("等待你确认后继续")).toBeTruthy();
  });

  test("retrying → 滚动旧 max 也统一为「模型繁忙，正在重试中（n/10）」", () => {
    renderTA({
      startedAt: Date.now(),
      turnStatus: { kind: "retrying", attempt: 2, max: 3, retryAt: Date.now() + 4500 },
    });
    const node = screen.getByLabelText("生成中");
    const t = node.textContent ?? "";
    expect(t).toContain("模型繁忙，正在重试中（2/10）");
    expect(t).not.toContain("后重试");
    // 软提示走 warning 色(text-warning),不是红卡。
    expect(node.className).toContain("text-warning");
  });

  test("连接恢复与 Stop 复用活动行，不冒充模型重试", () => {
    const { unmount } = render(
      <TurnActivity info={{
        startedAt: Date.now(),
        agentName: "助手",
        recoveryStatus: { kind: "retrying", attempt: 4 },
      }} />,
    );
    expect(screen.getByLabelText("生成中")).toHaveTextContent("正在恢复实时内容…");
    expect(screen.queryByText(/模型繁忙/)).not.toBeInTheDocument();
    unmount();

    renderTA({
      recoveryStatus: { kind: "stopping", masterPersisted: true },
      turnStatus: { kind: "retrying", attempt: 2, max: 10, retryAt: Date.now() + 1000 },
    });
    expect(screen.getByLabelText("生成中")).toHaveTextContent("正在停止…");
    expect(screen.queryByText(/模型繁忙/)).not.toBeInTheDocument();
  });

  test("团队模式：leaderStep → 「队长正在执行:<step>」", () => {
    renderTA({ startedAt: Date.now() - 8000, leaderStep: "修复计划卡" });
    const t = screen.getByLabelText("生成中").textContent ?? "";
    expect(t).toContain("队长正在执行");
    expect(t).toContain("修复计划卡");
  });

  test("冷启后缀兼容：coldStart → 追加「容器首次加载中」", () => {
    renderTA({ startedAt: Date.now(), coldStart: true });
    expect(screen.getByLabelText("生成中").textContent).toContain("容器首次加载中");
  });

  test("静默升级：久无新帧 → 深度思考中", () => {
    renderTA({ startedAt: Date.now() - 40_000, lastFrameAt: Date.now() - 35_000 });
    expect(screen.getByLabelText("生成中").textContent).toContain("深度思考中");
  });

  test("progressHint 在仍有新帧时展示中文动作，不回显工具名/路径", () => {
    renderTA({
      startedAt: Date.now() - 10_000,
      lastFrameAt: Date.now() - 1_000,
      progressHint: "Read foo.ts",
    });
    const t = screen.getByLabelText("生成中").textContent ?? "";
    expect(t).toContain("读取文件");
    expect(t).not.toContain("Read");
    expect(t).not.toContain("foo.ts");
  });

  test("卡住时 leftover progressHint 不掩盖无新数据", () => {
    renderTA({
      startedAt: Date.now() - 40_000,
      lastFrameAt: Date.now() - 35_000,
      progressHint: "Read foo.ts",
    });
    const t = screen.getByLabelText("生成中").textContent ?? "";
    expect(t).toContain("深度思考中");
    expect(t).not.toContain("Read foo.ts");
  });

  test("上桌后底栏不标思考中", () => {
    renderTA({
      startedAt: Date.now() - 12_000,
      lastFrameAt: Date.now() - 1_000,
      hasPlated: true,
    });
    const t = screen.getByLabelText("生成中").textContent ?? "";
    expect(t).toContain("正在生成内容");
    expect(t).not.toContain("思考中");
  });

  test("units 首包后 retrying 不再显示正在恢复实时内容", () => {
    renderTA({
      recoveryStatus: { kind: "retrying", attempt: 2 },
      hasVisibleProcess: true,
    });
    expect(screen.queryByText("正在恢复实时内容…")).not.toBeInTheDocument();
  });
});

// M-04:活动行是 aria-live=polite 区域,而文案含每秒变化的「(Ns)」→ 读屏每秒被朗读一次。
// 现在秒数段包进 aria-hidden 的 span(不进无障碍树),阶段文案文本节点只在阶段切换时才变。
describe("TurnActivity 读屏播报只跟阶段文案(M-04)", () => {
  function renderTA(info: Partial<TurnActivityInfo>) {
    render(<TurnActivity info={{ startedAt: Date.now(), agentName: "助手", ...info }} />);
  }

  test("splitElapsedSeconds:秒数段被单独切出,拼回去逐字等于原文", () => {
    const text = "主助手 深度思考中 (40s · 35s 无新数据) · 复杂问题可能需要一两分钟,可随时停止";
    const segments = splitElapsedSeconds(text);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments.filter((s) => s.elapsed).map((s) => s.text)).toEqual([" (40s · 35s 无新数据)"]);
    expect(stripElapsedSeconds(text)).toBe("主助手 深度思考中 · 复杂问题可能需要一两分钟,可随时停止");
    expect(stripElapsedSeconds("主助手 正在启动引擎 (8s)…")).toBe("主助手 正在启动引擎…");
    // 重试计数「（2/10）」不是秒数,不能被误剥。
    expect(stripElapsedSeconds("模型繁忙，正在重试中（2/10）")).toBe("模型繁忙，正在重试中（2/10）");
    expect(splitElapsedSeconds("主助手 思考中")).toEqual([{ text: "主助手 思考中", elapsed: false }]);
  });

  test("秒数段对读屏 aria-hidden,可见文案逐字不变", () => {
    renderTA({ startedAt: Date.now() - 10_000 });
    const row = screen.getByLabelText("生成中");
    expect(row).toHaveAttribute("aria-live", "polite");
    expect(row.textContent).toContain("思考中 (10s)");
    const hidden = row.querySelector("[data-elapsed]");
    expect(hidden).not.toBeNull();
    expect(hidden).toHaveAttribute("aria-hidden", "true");
    expect(hidden?.textContent).toBe(" (10s)");
  });

  test("每秒 tick 只改秒数 span 的文本节点,阶段文案的文本节点保持同一引用", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:10Z"));
    const startedAt = Date.now() - 10_000;
    renderTA({ startedAt, lastFrameAt: Date.now() });
    const row = screen.getByLabelText("生成中");
    const phaseNode = Array.from(row.querySelector(".break-words")!.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE,
    );
    expect(phaseNode?.textContent).toBe("助手 思考中");
    const secondsBefore = row.querySelector("[data-elapsed]")?.textContent;

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    const phaseNodeAfter = Array.from(row.querySelector(".break-words")!.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE,
    );
    // 阶段未变:文本节点未被替换、内容未变(live region 无可播报的变更)。
    expect(phaseNodeAfter).toBe(phaseNode);
    expect(phaseNodeAfter?.textContent).toBe("助手 思考中");
    // 秒数确实在跳,只是跳在 aria-hidden 里。
    expect(row.querySelector("[data-elapsed]")?.textContent).not.toBe(secondsBefore);
  });
});
