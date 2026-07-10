/**
 * 定时任务列表富卡单测。重点:真实会话 fixture LIST_REMINDERS_TEXT 第三条(weekly-curation)
 * 标题内嵌真实换行——旧解析器整卡作废回退文字墙(boss 现网 bug)。多行缝合后必须渲染出 3
 * 张任务卡。另覆盖新格式契约(单行标题 + `系统` bit → 系统徽标)与坏行 leftover 附底。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { LIST_REMINDERS_TEXT } from "./__fixtures__/sessionToolTexts";
import { parseReminderListOutput, renderReminderListCard } from "./memoryReminderCards";

afterEach(cleanup);

describe("parseReminderListOutput 多行缝合(击穿案例)", () => {
  test("内嵌换行的系统任务标题被缝合,3 条全部解析(不整卡作废)", () => {
    const parsed = parseReminderListOutput(LIST_REMINDERS_TEXT);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ kind: "list", declaredCount: 3 });
    if (parsed?.kind !== "list") throw new Error("expected list");
    expect(parsed.jobs.map((j) => j.id)).toEqual(["daily-reflection", "weekly-curation", "skill-check"]);
    // weekly 标题换行折成空格,不再带断行。
    const weekly = parsed.jobs.find((j) => j.id === "weekly-curation")!;
    expect(weekly.title).toMatch(/WEEKLY CURATION/);
    expect(weekly.title).not.toContain("\n");
    expect(parsed.leftovers).toEqual([]);
  });

  test("新格式 `系统` bit → isSystem 标记(deliver 不被污染)", () => {
    const NEW = "共 1 个定时提醒/任务:\n- **每周知识整理** (ID: `weekly-curation`) — `31 4 * * 0` · 重复 · 启用中 · 仅记录 · 系统 · 下次 2026-07-13T04:31:00.000Z";
    const parsed = parseReminderListOutput(NEW);
    if (parsed?.kind !== "list") throw new Error("expected list");
    expect(parsed.jobs[0]).toMatchObject({ id: "weekly-curation", title: "每周知识整理", isSystem: true, deliver: "仅记录" });
  });

  test("彻底解析不了的行 → leftover 附底,不吞相邻条目、不作废整卡", () => {
    const BROKEN = "共 2 个定时提醒/任务:\n- **半截标题没有闭合\n- **好任务** (ID: `t2`) — `0 9 * * *` · 重复 · 启用中 · 仅记录";
    const parsed = parseReminderListOutput(BROKEN);
    if (parsed?.kind !== "list") throw new Error("expected list");
    expect(parsed.jobs.map((j) => j.id)).toEqual(["t2"]);
    expect(parsed.leftovers).toHaveLength(1);
    expect(parsed.leftovers[0]).toContain("半截标题");
  });
});

describe("renderReminderListCard", () => {
  test("击穿 fixture → 渲染 3 张任务卡(不是文字墙)", () => {
    render(<div>{renderReminderListCard(LIST_REMINDERS_TEXT)}</div>);
    expect(screen.getByText("当前共有 3 个定时任务")).toBeInTheDocument();
    expect(screen.getByText("daily-reflection")).toBeInTheDocument();
    expect(screen.getByText("weekly-curation")).toBeInTheDocument();
    expect(screen.getByText("skill-check")).toBeInTheDocument();
  });

  test("系统任务渲染「系统」徽标", () => {
    const NEW = "共 1 个定时提醒/任务:\n- **每日反思** (ID: `daily-reflection`) — `17 3 * * *` · 重复 · 启用中 · 仅记录 · 系统";
    render(<div>{renderReminderListCard(NEW)}</div>);
    expect(screen.getByText("每日反思")).toBeInTheDocument();
    expect(screen.getByText("系统")).toBeInTheDocument();
  });
});
