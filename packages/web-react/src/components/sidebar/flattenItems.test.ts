import { describe, expect, it } from "vitest";
import type { ChatProject, Session } from "../../lib/types";
import {
  DEFAULT_PROJECT_ID,
  GROUP_HEADER_HEIGHT,
  GROUP_HEADER_HEIGHT_TOUCH,
  HINT_ROW_HEIGHT,
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
  it("空非默认项目 hint 带 projectId", () => {
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
    const workHint = items.find((i) => i.kind === "hint" && i.key === "p-empty-p-work");
    expect(workHint).toMatchObject({
      kind: "hint",
      text: "暂无会话",
      projectId: "p-work",
      height: HINT_ROW_HEIGHT,
    });
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

    it("有项目但零会话：不是引导空态，仍是项目头 + 空项目行 + 未分类 empty-list", () => {
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

  // S-01：空分组提示的变体——只有整个活动列表为空时未分类才是 empty-list（叠大 CTA），
  // 空项目一律 empty-project（普通行高），多个空项目不再把会话挤出视口。
  it("整个列表为空：未分类 hint 为 empty-list，空项目 hint 仍为 empty-project", () => {
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
    expect(hints.map((h) => (h.kind === "hint" ? h.variant : ""))).toEqual([
      "empty-project",
      "empty-project",
      "empty-list",
    ]);
    for (const h of hints) expect(h.height).toBe(HINT_ROW_HEIGHT);
  });

  it("别处有会话时，空未分类与空项目都是 empty-project", () => {
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
    const hints = items.filter((i) => i.kind === "hint");
    expect(hints).toHaveLength(2);
    expect(hints.every((h) => h.kind === "hint" && h.variant === "empty-project")).toBe(true);
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
