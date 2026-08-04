import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { TodoItem } from "./PinnedTaskTracker";
import { deriveActivePlanStep, TurnActivity, type TurnActivityInfo } from "./TurnActivity";

afterEach(cleanup);

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

  test("retrying → 滚动旧 max 也统一为「模型繁忙，正在自动重试中（n/10）」", () => {
    renderTA({
      startedAt: Date.now(),
      turnStatus: { kind: "retrying", attempt: 2, max: 3, retryAt: Date.now() + 4500 },
    });
    const node = screen.getByLabelText("生成中");
    const t = node.textContent ?? "";
    expect(t).toContain("模型繁忙，正在自动重试中（2/10）");
    expect(t).not.toContain("后重试");
    // 软提示走 warning 色(text-warning),不是红卡。
    expect(node.className).toContain("text-warning");
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
});
