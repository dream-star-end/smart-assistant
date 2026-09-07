import { describe, expect, it } from "vitest";
import type { ChatProject, Session } from "../../lib/types";
import { DEFAULT_PROJECT_ID, HINT_ROW_HEIGHT } from "./constants";
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
