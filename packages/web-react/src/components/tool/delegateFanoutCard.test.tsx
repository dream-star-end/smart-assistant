/**
 * 并行委派(fan-out)富卡单测:解析聚合文本 → 汇总徽标 + 子任务 mini 卡;失败回退 null。
 * 格式权威 = mcp-memory/src/delegateFanout.ts aggregateDelegateFanoutResults。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DELEGATE_TASKS_TEXT } from "./__fixtures__/sessionToolTexts";
import { parseDelegateFanout, renderDelegateFanoutCard } from "./delegateFanoutCard";

afterEach(cleanup);

const FANOUT_WITH_FAILURE = [
  "并行委派 2 个子任务已全部返回:1 成功 / 1 失败。",
  "",
  "### 1. ✅ coding-assistant — 写一个排序函数",
  "✅ 委派完成 (agent: coding-assistant)",
  "",
  "已完成快排实现。",
  "",
  "### 2. ❌ research-assistant — 联网查资料",
  "委派失败: 该 agent 无联网权限。",
].join("\n");

describe("parseDelegateFanout", () => {
  test("解析首行汇总 + 每子任务(标记/label/goal/正文)", () => {
    const p = parseDelegateFanout(DELEGATE_TASKS_TEXT);
    expect(p).not.toBeNull();
    expect(p).toMatchObject({ total: 2, ok: 2, fail: 0 });
    expect(p!.items).toHaveLength(2);
    expect(p!.items[0]).toMatchObject({ index: 1, isError: false, label: "coding-assistant" });
    expect(p!.items[0].goal).toMatch(/仅回复/);
    expect(p!.items[0].body).toMatch(/编程助手卡片正常/);
  });

  test("含失败项:isError + 汇总计数正确", () => {
    const p = parseDelegateFanout(FANOUT_WITH_FAILURE);
    expect(p).toMatchObject({ total: 2, ok: 1, fail: 1 });
    expect(p!.items[1].isError).toBe(true);
  });

  test("非 fan-out 文本 → null(回退信号)", () => {
    expect(parseDelegateFanout("✅ 委派完成 (agent: office-assistant)")).toBeNull();
    expect(parseDelegateFanout("")).toBeNull();
  });
});

describe("renderDelegateFanoutCard", () => {
  test("汇总徽标行 + 每子任务 mini 卡 + 结果折叠", () => {
    render(<div>{renderDelegateFanoutCard(DELEGATE_TASKS_TEXT)}</div>);
    expect(screen.getByText("并行委派 2 个子任务")).toBeInTheDocument();
    expect(screen.getByText("2 成功")).toBeInTheDocument();
    expect(screen.getByText("coding-assistant")).toBeInTheDocument();
    expect(screen.getByText("research-assistant")).toBeInTheDocument();
    expect(screen.getAllByText("完成")).toHaveLength(2);
    expect(screen.getAllByText("查看结果").length).toBeGreaterThanOrEqual(2);
  });

  test("失败子任务:失败徽标 + 失败计数", () => {
    render(<div>{renderDelegateFanoutCard(FANOUT_WITH_FAILURE)}</div>);
    expect(screen.getByText("1 失败")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  test("解析失败 → null(回退 OutputBlock)", () => {
    expect(renderDelegateFanoutCard("just a plain result")).toBeNull();
  });
});
