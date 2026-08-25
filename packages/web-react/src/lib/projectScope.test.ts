import { describe, expect, it } from "vitest";
import {
  UNBOUND_BOARD_COPY,
  boardWorkQuery,
  parseProjectScopeToken,
  preferredScopeToken,
  projectScopeSelectOptions,
  resolveProjectScope,
  withProjectParam,
} from "./projectScope";

const chats = [
  { id: "chat-ocv5-facade", name: "OCV5 facade", boardProjectId: "852859fa-cf1d-481c-96fd-23f2966b8b5f" },
  { id: "chat-unbound", name: "test", boardProjectId: null },
];
const works = [
  { id: "852859fa-cf1d-481c-96fd-23f2966b8b5f", key: "OCV5", name: "V5个人版和商业版项目开发", archivedAt: null },
  { id: "b12fc2f7-c466-49de-892b-b44326b782c4", key: "TEST", name: "V5个人版", archivedAt: null },
  { id: "archived-board", key: "OLD", name: "archived", archivedAt: 1 },
];

describe("parseProjectScopeToken", () => {
  it("accepts all/none/uuid-like and rejects junk", () => {
    expect(parseProjectScopeToken("all")).toBe("all");
    expect(parseProjectScopeToken("none")).toBe("none");
    expect(parseProjectScopeToken("852859fa-cf1d-481c-96fd-23f2966b8b5f")).toBe(
      "852859fa-cf1d-481c-96fd-23f2966b8b5f",
    );
    expect(parseProjectScopeToken("")).toBeNull();
    expect(parseProjectScopeToken("nope")).toBeNull();
    expect(parseProjectScopeToken("../etc")).toBeNull();
  });
});

describe("resolveProjectScope", () => {
  it("maps all and ungrouped", () => {
    expect(resolveProjectScope({ token: "all", chatProjects: chats, workProjects: works }).kind).toBe("all");
    const un = resolveProjectScope({ token: "none", chatProjects: chats, workProjects: works });
    expect(un.kind).toBe("ungrouped");
    expect(un.chatProjectIdForFilter).toBeNull();
  });

  it("resolves work id and bound facade filter", () => {
    const r = resolveProjectScope({
      token: "852859fa-cf1d-481c-96fd-23f2966b8b5f",
      chatProjects: chats,
      workProjects: works,
    });
    expect(r.kind).toBe("work");
    expect(r.bound).toBe(true);
    expect(r.chatProjectIdForFilter).toBe("chat-ocv5-facade");
    expect(preferredScopeToken(r)).toBe("852859fa-cf1d-481c-96fd-23f2966b8b5f");
  });

  it("promotes a bound chat facade token to work", () => {
    const r = resolveProjectScope({ token: "chat-ocv5-facade", chatProjects: chats, workProjects: works });
    expect(r.kind).toBe("work");
    expect(r.workProject?.key).toBe("OCV5");
  });

  it("keeps unbound chat folders as chat scope", () => {
    const r = resolveProjectScope({ token: "chat-unbound", chatProjects: chats, workProjects: works });
    expect(r.kind).toBe("chat");
    expect(r.bound).toBe(false);
    expect(r.chatProjectIdForFilter).toBe("chat-unbound");
  });

  it("fail-closes unknown and archived work ids", () => {
    const ghost = resolveProjectScope({ token: "does-not-exist-id", chatProjects: chats, workProjects: works });
    expect(ghost.kind).toBe("all");
    expect(ghost.invalid).toBe(true);
    const archived = resolveProjectScope({ token: "archived-board", chatProjects: chats, workProjects: works });
    expect(archived.kind).toBe("all");
    expect(archived.invalid).toBe(true);
  });
});

describe("withProjectParam", () => {
  it("omits all and writes none/id", () => {
    expect(withProjectParam(new URLSearchParams("panel=manage"), "all").get("project")).toBeNull();
    expect(withProjectParam(new URLSearchParams(), "none").get("project")).toBe("none");
  });
});

describe("boardWorkQuery", () => {
  it("only work scope returns a projectId; all/none/unbound chat are blocked", () => {
    const work = resolveProjectScope({
      token: "852859fa-cf1d-481c-96fd-23f2966b8b5f",
      chatProjects: chats,
      workProjects: works,
    });
    expect(boardWorkQuery(work)).toEqual({ projectId: "852859fa-cf1d-481c-96fd-23f2966b8b5f" });
    expect(boardWorkQuery(resolveProjectScope({ token: "all", chatProjects: chats, workProjects: works }))).toEqual({
      blocked: UNBOUND_BOARD_COPY,
    });
    expect(boardWorkQuery(resolveProjectScope({ token: "none", chatProjects: chats, workProjects: works }))).toEqual({
      blocked: UNBOUND_BOARD_COPY,
    });
    expect(boardWorkQuery(resolveProjectScope({ token: "chat-unbound", chatProjects: chats, workProjects: works }))).toEqual({
      blocked: UNBOUND_BOARD_COPY,
    });
  });

  it("work selector omits unbound chat ids", () => {
    const full = projectScopeSelectOptions({ chatProjects: chats, workProjects: works });
    const workOnly = projectScopeSelectOptions({ chatProjects: chats, workProjects: works, variant: "work" });
    expect(full.some((o) => o.value === "chat-unbound")).toBe(true);
    expect(workOnly.some((o) => o.value === "chat-unbound")).toBe(false);
    expect(workOnly.map((o) => o.value)).toEqual([
      "all",
      "none",
      "852859fa-cf1d-481c-96fd-23f2966b8b5f",
      "b12fc2f7-c466-49de-892b-b44326b782c4",
    ]);
  });
});
