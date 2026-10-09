import { describe, expect, test } from "vitest";
import { DEFAULT_MANAGE_TAB, MANAGE_TABS, isManageTab, normalizeManageTab } from "./manageTabs";

describe("manageTabs", () => {
  test("只保留 记忆 / 技能 / 定时 / 插件 四个分区，默认落地 = 首位", () => {
    expect(MANAGE_TABS.map((t) => t.id)).toEqual(["memory", "skills", "cron", "connectors"]);
    expect(DEFAULT_MANAGE_TAB).toBe("memory");
  });

  test("已下线的 文献 / 优化 分区 id 不再被识别", () => {
    expect(isManageTab("library")).toBe(false);
    expect(isManageTab("optimization")).toBe(false);
    for (const t of MANAGE_TABS) expect(isManageTab(t.id)).toBe(true);
  });

  test("旧入口带来的已下线 / 未知分区值回落到默认分区", () => {
    expect(normalizeManageTab("library")).toBe(DEFAULT_MANAGE_TAB);
    expect(normalizeManageTab("optimization")).toBe(DEFAULT_MANAGE_TAB);
    expect(normalizeManageTab("")).toBe(DEFAULT_MANAGE_TAB);
    expect(normalizeManageTab(undefined)).toBe(DEFAULT_MANAGE_TAB);
    expect(normalizeManageTab(null)).toBe(DEFAULT_MANAGE_TAB);
    expect(normalizeManageTab("__proto__")).toBe(DEFAULT_MANAGE_TAB);
  });

  test("有效分区原样保留", () => {
    expect(normalizeManageTab("cron")).toBe("cron");
    expect(normalizeManageTab("connectors")).toBe("connectors");
  });
});
