import { describe, expect, it } from "vitest";
import type { ChatProject, Session } from "../../lib/types";
import {
  DEFAULT_PROJECT_ID,
  GROUP_HEADER_HEIGHT,
  GROUP_HEADER_HEIGHT_TOUCH,
  HINT_ROW_HEIGHT,
  SESSION_ROW_HEIGHT,
} from "./constants";
import { flattenSidebarItems } from "./flattenItems";

function session(over: Partial<Session> & { id: string }): Session {
  return {
    title: `会话 ${over.id}`,
    ownerUserId: "u1",
    updatedAt: new Date().toISOString(),
    messageCount: 1,
    ...over,
  };
}

function project(over: Partial<ChatProject> & { id: string; name: string }): ChatProject {
  return {
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    sessionCount: 0,
    ...over,
  };
}

describe("flattenSidebarItems empty project hints", () => {
  // UI-1：空项目不再占一行「暂无会话 新建会话」（体验官截图里每个空项目都多一行）；计数 0 已经说明，
  // 项目行自带「+」/ 菜单「新建会话」。原用例「空非默认项目 hint 带 projectId」锁的是被删掉的那一行。
  it("展开的空项目只有项目行，不再跟一行「暂无会话」", () => {
    const items = flattenSidebarItems({
      searching: false,
      showProjects: true,
      pinned: [],
      projects: [project({ id: "p-work", name: "工作" })],
      projectSessions: new Map([["p-work", []]]),
      sessions: [],
      ungroupedGroups: [],
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: true,
    });
    expect(items.some((i) => i.kind === "hint" && i.key === "p-empty-p-work")).toBe(false);
    expect(items.find((i) => i.kind === "project" && i.project.id === "p-work")).toMatchObject({ collapsed: false });
  });

  it("默认未分类空 hint 不带 projectId", () => {
    const items = flattenSidebarItems({
      searching: false,
      showProjects: true,
      pinned: [],
      projects: [project({ id: "p-work", name: "工作" })],
      projectSessions: new Map([["p-work", []]]),
      sessions: [],
      ungroupedGroups: [],
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: true,
    });
    const def = items.find((i) => i.kind === "hint" && i.key === `p-empty-${DEFAULT_PROJECT_ID}`);
    expect(def).toMatchObject({ kind: "hint", text: "暂无会话" });
    expect(def && def.kind === "hint" ? def.projectId : "missing").toBeUndefined();
  });

  // S-13：零会话零项目此前仍渲染「项目 +」「未分类 0」「已归档 0」骨架，首屏像损坏的列表而不是引导。
  describe("零会话零项目的引导空态（S-13）", () => {
    const base = {
      searching: false,
      pinned: [],
      projectSessions: new Map<string, Session[]>(),
      sessions: [],
      ungroupedGroups: [] as [string, Session[]][],
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle" as const,
      localEmpty: true,
    };

    it("有项目功能但没有项目：只剩一条 empty-all 提示 + 已归档开关", () => {
      const items = flattenSidebarItems({ ...base, showProjects: true, projects: [] });
      expect(items.map((i) => i.kind)).toEqual(["hint", "archivedToggle"]);
      expect(items[0]).toMatchObject({ kind: "hint", key: "empty-all", variant: "empty-all", text: "还没有会话" });
    });

    it("没有项目功能（showProjects=false）同样走引导空态", () => {
      const items = flattenSidebarItems({ ...base, showProjects: false, projects: [] });
      expect(items.map((i) => i.kind)).toEqual(["hint", "archivedToggle"]);
    });

    it("已展开「已归档」且有归档会话：引导块之下照常列出归档", () => {
      const arc = session({ id: "s-arc", archived: true });
      const items = flattenSidebarItems({
        ...base,
        showProjects: true,
        projects: [],
        archived: [arc],
        archivedExpanded: true,
      });
      expect(items.map((i) => i.kind)).toEqual(["hint", "archivedToggle", "session"]);
    });

    it("有项目但零会话：不是引导空态，仍是项目头 + 项目行 + 未分类 empty-list", () => {
      const items = flattenSidebarItems({
        ...base,
        showProjects: true,
        projects: [project({ id: "p-a", name: "甲" })],
      });
      expect(items.some((i) => i.kind === "hint" && i.variant === "empty-all")).toBe(false);
      expect(items.some((i) => i.kind === "header" && i.label === "项目")).toBe(true);
      expect(items.some((i) => i.kind === "hint" && i.variant === "empty-list")).toBe(true);
    });
  });

  it("有会话的项目不生成空 hint", () => {
    const s = session({ id: "s1", projectId: "p-work" });
    const items = flattenSidebarItems({
      searching: false,
      showProjects: true,
      pinned: [],
      projects: [project({ id: "p-work", name: "工作" })],
      projectSessions: new Map([["p-work", [s]]]),
      sessions: [s],
      ungroupedGroups: [],
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
    });
    expect(items.some((i) => i.kind === "hint" && i.key === "p-empty-p-work")).toBe(false);
  });

  // S-01：只有整个活动列表为空时未分类才出 empty-list（叠大 CTA）；UI-1 起空项目不再出提示行。
  it("整个列表为空：只有未分类的 empty-list，空项目没有提示行", () => {
    const items = flattenSidebarItems({
      searching: false,
      showProjects: true,
      pinned: [],
      projects: [project({ id: "p-a", name: "甲" }), project({ id: "p-b", name: "乙" })],
      projectSessions: new Map(),
      sessions: [],
      ungroupedGroups: [],
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: true,
    });
    const hints = items.filter((i) => i.kind === "hint");
    expect(hints.map((h) => (h.kind === "hint" ? h.variant : ""))).toEqual(["empty-list"]);
    for (const h of hints) expect(h.height).toBe(HINT_ROW_HEIGHT);
  });

  it("别处有会话时，空未分类与空项目都不出提示行", () => {
    const s = session({ id: "s1", projectId: "p-a" });
    const items = flattenSidebarItems({
      searching: false,
      showProjects: true,
      pinned: [],
      projects: [project({ id: "p-a", name: "甲" }), project({ id: "p-b", name: "乙" })],
      projectSessions: new Map([["p-a", [s]]]),
      sessions: [s],
      ungroupedGroups: [],
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
    });
    expect(items.filter((i) => i.kind === "hint")).toHaveLength(0);
  });
});

// UI-1：项目展开最多列 5 条，其余走「查看全部」进项目主页；当前会话不因收起 / 超出上限从侧栏消失。
describe("flattenSidebarItems 项目会话上限与当前会话", () => {
  const p = project({ id: "p-big", name: "大项目" });
  const kids = Array.from({ length: 7 }, (_, i) => session({ id: `k${i}`, projectId: "p-big" }));
  const base = {
    searching: false,
    showProjects: true,
    pinned: [],
    projects: [p],
    projectSessions: new Map([["p-big", kids]]),
    sessions: kids,
    ungroupedGroups: [] as [string, Session[]][],
    archived: [],
    archivedExpanded: false,
    searchHits: [],
    searchRemote: "idle" as const,
    localEmpty: false,
  };
  const shownIds = (items: ReturnType<typeof flattenSidebarItems>) =>
    items.flatMap((i) => (i.kind === "session" ? [i.session.id] : []));

  it("展开时只列前 5 条，末尾一行「查看全部」带总数", () => {
    const items = flattenSidebarItems({ ...base, projectLimit: 5 });
    expect(shownIds(items)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
    const more = items.findIndex((i) => i.kind === "more");
    expect(items[more]).toMatchObject({ kind: "more", projectId: "p-big", count: 7, height: SESSION_ROW_HEIGHT });
    expect(items[more - 1]).toMatchObject({ kind: "session", session: { id: "k4" } });
  });

  it("不足上限不出「查看全部」；没有上限（无项目主页）时全部列出", () => {
    const few = flattenSidebarItems({ ...base, projectLimit: 10 });
    expect(shownIds(few)).toHaveLength(7);
    expect(few.some((i) => i.kind === "more")).toBe(false);
    const all = flattenSidebarItems(base);
    expect(shownIds(all)).toHaveLength(7);
    expect(all.some((i) => i.kind === "more")).toBe(false);
  });

  it("当前会话排在上限之外时补在末尾，「查看全部」仍在", () => {
    const items = flattenSidebarItems({ ...base, projectLimit: 5, activeId: "k6" });
    expect(shownIds(items)).toEqual(["k0", "k1", "k2", "k3", "k4", "k6"]);
    expect(items.some((i) => i.kind === "more")).toBe(true);
  });

  it("项目收起时只留当前会话这一行，没有「查看全部」", () => {
    const collapsedProjectIds = new Set(["p-big"]);
    expect(shownIds(flattenSidebarItems({ ...base, projectLimit: 5, collapsedProjectIds }))).toEqual([]);
    const items = flattenSidebarItems({ ...base, projectLimit: 5, collapsedProjectIds, activeId: "k3" });
    expect(shownIds(items)).toEqual(["k3"]);
    expect(items.some((i) => i.kind === "more")).toBe(false);
  });
});

// S-04：触屏下「项目」标题行右侧的 IconButton 升到 44px，标题行高必须同步，否则按钮溢出盖到上一行。
describe("flattenSidebarItems 触屏标题行高", () => {
  const base = {
    searching: false,
    showProjects: true,
    pinned: [session({ id: "s-pin", pinned: true })],
    projects: [project({ id: "p-a", name: "甲" })],
    projectSessions: new Map<string, Session[]>(),
    sessions: [],
    ungroupedGroups: [] as [string, Session[]][],
    archived: [],
    archivedExpanded: false,
    searchHits: [],
    searchRemote: "idle" as const,
    localEmpty: true,
  };

  it("coarsePointer 时「项目」header 为 44px，其他 header 保持 32px", () => {
    const items = flattenSidebarItems({ ...base, coarsePointer: true });
    const headers = items.filter((i) => i.kind === "header");
    const byLabel = new Map(headers.map((h) => [h.kind === "header" ? h.label : "", h.height]));
    expect(byLabel.get("项目")).toBe(GROUP_HEADER_HEIGHT_TOUCH);
    expect(byLabel.get("置顶")).toBe(GROUP_HEADER_HEIGHT);
  });

  it("桌面（缺省）时「项目」header 仍为 32px", () => {
    const items = flattenSidebarItems(base);
    const projectsHeader = items.find((i) => i.kind === "header" && i.label === "项目");
    expect(projectsHeader?.height).toBe(GROUP_HEADER_HEIGHT);
  });
});
