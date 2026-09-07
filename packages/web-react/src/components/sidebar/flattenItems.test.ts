import { describe, expect, it } from "vitest";
import type { ChatProject, Session } from "../../lib/types";
import { DEFAULT_PROJECT_ID, HINT_ROW_HEIGHT, PROJECT_ROW_HEIGHT } from "./constants";
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
      showProjects: false,
      pinned: [],
      projects: [],
      projectSessions: new Map(),
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
});

describe("flattenSidebarItems 回收站", () => {
  const trashSession = session({ id: "t1", deletedAt: 1_000 });
  const base = {
    searching: false,
    showProjects: false,
    pinned: [],
    projects: [],
    projectSessions: new Map(),
    sessions: [] as Session[],
    ungroupedGroups: [],
    archived: [] as Session[],
    archivedExpanded: false,
    searchHits: [],
    searchRemote: "idle" as const,
    localEmpty: false,
  };

  it("折叠时只有 trashToggle 行（在已归档之后），不带会话行", () => {
    const items = flattenSidebarItems({
      ...base,
      trashed: [trashSession],
      trashedExpanded: false,
    });
    const toggle = items.find((i) => i.kind === "trashToggle");
    expect(toggle).toMatchObject({
      kind: "trashToggle",
      key: "trash-toggle",
      count: 1,
      expanded: false,
      height: PROJECT_ROW_HEIGHT,
    });
    expect(items.some((i) => i.kind === "session" && i.session.id === "t1")).toBe(false);
    // 回收站在已归档之后。
    const keys = items.map((i) => i.key);
    expect(keys.indexOf("archived-toggle")).toBeLessThan(keys.indexOf("trash-toggle"));
  });

  it("展开且加载中显示「正在加载回收站…」提示", () => {
    const items = flattenSidebarItems({
      ...base,
      trashed: [],
      trashedExpanded: true,
      trashedLoading: true,
    });
    const toggle = items.find((i) => i.kind === "trashToggle");
    expect(toggle).toMatchObject({ kind: "trashToggle", expanded: true, count: 0 });
    expect(items.find((i) => i.kind === "hint" && i.key === "trash-loading")).toMatchObject({
      kind: "hint",
      text: "正在加载回收站…",
      height: HINT_ROW_HEIGHT,
    });
  });

  it("展开且为空显示「回收站是空的」", () => {
    const items = flattenSidebarItems({
      ...base,
      trashed: [],
      trashedExpanded: true,
      trashedLoading: false,
    });
    expect(items.find((i) => i.kind === "hint" && i.key === "trash-empty")).toMatchObject({
      kind: "hint",
      text: "回收站是空的",
      height: HINT_ROW_HEIGHT,
    });
  });

  it("展开且有会话时逐行拍平（不缩进、计入 count）", () => {
    const items = flattenSidebarItems({
      ...base,
      trashed: [trashSession],
      trashedExpanded: true,
    });
    expect(items.find((i) => i.kind === "trashToggle")).toMatchObject({
      count: 1,
      expanded: true,
    });
    const row = items.find((i) => i.kind === "session" && i.session.id === "t1");
    expect(row?.kind).toBe("session");
    expect(row && row.kind === "session" ? row.indent : "missing").toBeUndefined();
  });

  it("缺省不传 trashed 字段也产出折叠的 trashToggle（向后兼容）", () => {
    const items = flattenSidebarItems(base);
    expect(items.find((i) => i.kind === "trashToggle")).toMatchObject({
      kind: "trashToggle",
      count: 0,
      expanded: false,
    });
  });
});
