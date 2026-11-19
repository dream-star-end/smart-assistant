import { describe, expect, it } from "vitest";
import type { ChatProject, PublicModel, Session } from "../../lib/types";
import {
  type PaletteSiteItem,
  buildPaletteGroups,
  describePaletteModel,
  fuzzyMatchScore,
  isFlagshipModel,
  paletteActions,
  paletteMatches,
} from "./paletteModel";

const NOW = Date.parse("2026-11-20T04:00:00.000Z");

function makeSession(over: Partial<Session> & { id: string }): Session {
  return {
    title: `会话 ${over.id}`,
    ownerUserId: "u1",
    updatedAt: new Date(NOW).toISOString(),
    lastAt: NOW,
    messageCount: 2,
    projectId: null,
    ...over,
  };
}

function makeProject(id: string, name: string, extra: Partial<ChatProject> = {}): ChatProject {
  return { id, name, sortOrder: 0, createdAt: NOW, updatedAt: NOW, sessionCount: 1, ...extra };
}

describe("paletteModel 模糊搜索与强模型显式标注", () => {
  it("fuzzyMatchScore 区分前缀 > 子串 > 多词 > ASCII 顺序子序列，并拒绝无关串", () => {
    expect(fuzzyMatchScore("GPT-5.4", "gpt")).toBeGreaterThan(fuzzyMatchScore("My GPT-5.4", "gpt"));
    expect(fuzzyMatchScore("Claude Opus 4.6", "opus 4")).toBeGreaterThan(0);
    expect(fuzzyMatchScore("GPT-5.4", "gp5")).toBeGreaterThan(0);
    expect(fuzzyMatchScore("weekly-2026-w40", "wk40")).toBeGreaterThan(0);
    expect(paletteMatches("论文综述", "zzzz-nothing")).toBe(false);
  });

  it("isFlagshipModel 与 describePaletteModel 明确标注旗舰强模型且不隐式降级或隐藏模型", () => {
    const opus: PublicModel = { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", cost_x: 3.5 };
    const gpt5: PublicModel = { id: "gpt-5.4", display_name: "GPT-5.4", cost_x: 2.0 };
    const mini: PublicModel = { id: "gpt-5-mini", display_name: "GPT-5 Mini", cost_x: 0.3 };
    const degraded: PublicModel = { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", degraded: true };

    expect(isFlagshipModel(opus)).toBe(true);
    expect(isFlagshipModel(gpt5)).toBe(true);
    expect(isFlagshipModel(mini)).toBe(false);

    const opusMeta = describePaletteModel(opus, "claude-opus-4-6");
    expect(opusMeta.isFlagship).toBe(true);
    expect(opusMeta.isCurrent).toBe(true);
    expect(opusMeta.isDegraded).toBe(false);

    const degMeta = describePaletteModel(degraded, "claude-opus-4-6");
    expect(degMeta.isDegraded).toBe(true);
    expect(degMeta.isFlagship).toBe(true);
  });

  it("buildPaletteGroups 完整聚合 活态会话 / 站点 / 显式切换模型 / 工作区入口 且去重", () => {
    const projects = [makeProject("p1", "科研总控", { template: "research" })];
    const sessions = [
      makeSession({ id: "s-app", title: "审批数据库迁移", projectId: "p1" }),
      makeSession({ id: "s-run", title: "文献抓取任务", runState: "running" }),
      makeSession({ id: "s-idle", title: "普通草稿" }),
    ];
    const sites: PaletteSiteItem[] = [
      { id: "site-1", slug: "paper-demo", title: "论文交互演示站", customDomain: "demo.lab.dev", visibility: "public" },
    ];
    const models: PublicModel[] = [
      { id: "gpt-5-mini", display_name: "GPT-5 Mini", cost_x: 0.3 },
      { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", cost_x: 3.5 },
      { id: "gpt-5.4", display_name: "GPT-5.4", cost_x: 2.0 },
      { id: "degraded-pro", display_name: "Gemini 3 Pro", degraded: true },
    ];

    const groups = buildPaletteGroups({
      query: "",
      filter: "all",
      projects,
      sessions,
      currentProjectId: null,
      recents: [{ kind: "session", id: "s-app", at: NOW }],
      sessionNeedsYou: (id) => (id === "s-app" ? "approval" : null),
      sites,
      models,
      activeModelId: "gpt-5.4",
      canSelectModel: true,
      actions: paletteActions({
        query: "",
        currentProject: null,
        canNewInProject: false,
        canMoveSession: false,
        canOpenHome: false,
        canOpenBoard: true,
        canOpenSites: true,
        canOpenManage: true,
        canOpenQuickAsk: true,
      }),
    });

    expect(groups.map((g) => g.id)).toEqual(["live", "recent", "sites", "models", "workspace", "actions"]);
    // 活态组内 待拍板 排在 运行中 之前
    expect(groups[0]!.items.map((i) => i.key)).toEqual(["session:s-app", "session:s-run"]);
    // 最近组不再重复 s-app / s-run
    expect(groups[1]!.items.map((i) => i.key)).toEqual(["session:s-idle"]);
    // 模型组：当前模型 > 旗舰模型 > 非旗舰 > 降级沉底且标 disabled
    expect(groups[3]!.items.map((i) => i.key)).toEqual([
      "model:gpt-5.4",
      "model:claude-opus-4-6",
      "model:gpt-5-mini",
      "model:degraded-pro",
    ]);
    const degItem = groups[3]!.items[3]!;
    expect(degItem.kind === "model" && degItem.disabled).toBe(true);
    // 工作区入口包含 看板 / 站点 / 记忆 / 技能 / 定时 / 插件 / 快问
    expect(groups[4]!.items.map((i) => i.key)).toEqual([
      "action:open-board",
      "action:open-sites",
      "action:open-memory",
      "action:open-skills",
      "action:open-cron",
      "action:open-connectors",
      "action:open-quick-ask",
    ]);
  });

  it("支持按活态状态词、域名、模型缩略词与工作区入口即时模糊搜索", () => {
    const sessions = [makeSession({ id: "s-app", title: "重构解析器" })];
    const sites: PaletteSiteItem[] = [
      { id: "site-1", slug: "finance-dash", title: "财报看板", customDomain: "ir.acme.ai" },
    ];
    const models: PublicModel[] = [
      { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", cost_x: 3.5 },
    ];

    const byApproval = buildPaletteGroups({
      query: "待拍板",
      filter: "all",
      projects: [],
      sessions,
      currentProjectId: null,
      recents: [],
      sessionNeedsYou: (id) => (id === "s-app" ? "approval" : null),
      actions: [],
    });
    expect(byApproval[0]!.items.map((i) => i.key)).toEqual(["session:s-app"]);

    const byDomain = buildPaletteGroups({
      query: "acme.ai",
      filter: "all",
      projects: [],
      sessions: [],
      currentProjectId: null,
      recents: [],
      sites,
      actions: [],
    });
    expect(byDomain.find((g) => g.id === "sites")?.items.map((i) => i.key)).toEqual(["site:finance-dash"]);

    const byModelFuzzy = buildPaletteGroups({
      query: "op4",
      filter: "all",
      projects: [],
      sessions: [],
      currentProjectId: null,
      recents: [],
      models,
      canSelectModel: true,
      actions: [],
    });
    expect(byModelFuzzy.find((g) => g.id === "models")?.items.map((i) => i.key)).toEqual([
      "model:claude-opus-4-6",
    ]);
  });
});
