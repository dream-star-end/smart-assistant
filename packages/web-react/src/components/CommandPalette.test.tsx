import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { pushPaletteRecent, readPaletteRecents, paletteRecentsKey, PALETTE_RECENTS_MAX } from "../lib/paletteRecents";
import type { ChatProject, ProjectAsset, Session, SessionSearchHit } from "../lib/types";
import { CommandPalette, type CommandPaletteProps } from "./CommandPalette";
import { buildPaletteGroups, nextPaletteFilter } from "./palette/paletteModel";

const NOW = Date.now();
const USER = "u1";

function project(id: string, name: string, extra: Partial<ChatProject> = {}): ChatProject {
  return { id, name, sortOrder: 0, createdAt: NOW, updatedAt: NOW, sessionCount: 1, ...extra };
}
function session(id: string, title: string, projectId: string | null, minsAgo = 10, extra: Partial<Session> = {}): Session {
  return {
    id,
    title,
    ownerUserId: USER,
    updatedAt: new Date(NOW - minsAgo * 60000).toISOString(),
    lastAt: NOW - minsAgo * 60000,
    messageCount: 2,
    projectId,
    ...extra,
  };
}
function asset(id: string, name: string, projectId: string | null, extra: Partial<ProjectAsset> = {}): ProjectAsset {
  return {
    id,
    projectId,
    source: "upload",
    sessionId: null,
    name,
    url: null,
    containerPath: null,
    mime: null,
    sizeBytes: null,
    excerpt: null,
    pinned: false,
    createdAt: NOW - 3 * 86400000,
    updatedAt: NOW,
    ...extra,
  };
}

const V5 = project("p-v5-0001", "V5 自用版改版", { color: "accent" });
const PAPER = project("p-paper-01", "论文综述");
const OLD = project("p-old-0001", "旧周报项目", { archivedAt: NOW - 1000 });
const PROJECTS = [V5, PAPER, OLD];
const SESSIONS = [
  session("s-draft", "第 40 周周报草稿", V5.id, 5),
  session("s-read", "本周阅读周报", PAPER.id, 60 * 24 * 7),
  session("s-misc", "随便聊聊", null, 30),
];

function setup(over: Partial<CommandPaletteProps> = {}) {
  const props: CommandPaletteProps = {
    open: true,
    onOpenChange: vi.fn(),
    userId: USER,
    projects: PROJECTS,
    sessions: SESSIONS,
    currentProjectId: null,
    onOpenProject: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenUngroupedAssets: vi.fn(),
    onNewSession: vi.fn(),
    onNewSessionInProject: vi.fn(),
    onCreateProject: vi.fn(),
    onMoveSession: vi.fn(),
    onOpenBoard: vi.fn(),
    ...over,
  };
  const utils = render(<CommandPalette {...props} />);
  const input = screen.getByRole("combobox", { name: "搜索与跳转" });
  return { props, input, ...utils };
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}
function keys() {
  return options().map((o) => o.getAttribute("data-palette-key"));
}
function options() {
  return screen.queryAllByRole("option");
}
function selected() {
  return options().find((o) => o.getAttribute("aria-selected") === "true");
}
function groupLabels() {
  return within(screen.getByRole("listbox"))
    .queryAllByRole("group")
    .map((g) => g.getAttribute("aria-label"));
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("paletteRecents", () => {
  it("keeps a small, deduped, per-user most-recent-first list", () => {
    pushPaletteRecent(USER, { kind: "session", id: "a" }, 1);
    pushPaletteRecent(USER, { kind: "project", id: "p" }, 2);
    pushPaletteRecent(USER, { kind: "session", id: "a" }, 3);
    expect(readPaletteRecents(USER).map((r) => `${r.kind}:${r.id}`)).toEqual(["session:a", "project:p"]);
    expect(readPaletteRecents("someone-else")).toEqual([]);
    for (let i = 0; i < 20; i++) pushPaletteRecent(USER, { kind: "session", id: `s${i}` }, 10 + i);
    expect(readPaletteRecents(USER)).toHaveLength(PALETTE_RECENTS_MAX);
  });

  it("is best effort: broken JSON or a throwing storage gives no recents", () => {
    localStorage.setItem(paletteRecentsKey(USER), "{not json");
    expect(readPaletteRecents(USER)).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => pushPaletteRecent(USER, { kind: "project", id: "p" })).not.toThrow();
    spy.mockRestore();
    expect(readPaletteRecents(null)).toEqual([]);
  });
});

describe("paletteModel", () => {
  it("Tab order cycles 全部 → 项目 → 会话 → 文件 and back", () => {
    expect(nextPaletteFilter("all", 1)).toBe("project");
    expect(nextPaletteFilter("file", 1)).toBe("all");
    expect(nextPaletteFilter("all", -1)).toBe("file");
  });

  it("archived projects come last and the message hit already matched by title is not repeated", () => {
    const groups = buildPaletteGroups({
      query: "周报",
      filter: "all",
      projects: PROJECTS,
      sessions: SESSIONS,
      messageHits: [
        { sessionId: "s-draft", title: "第 40 周周报草稿", snippet: "…周报…", matchedAt: NOW, kind: "message" },
      ],
      assets: [],
      currentProjectId: null,
      recents: [],
      actions: [],
    });
    const results = groups.find((g) => g.id === "results")!;
    const keys = results.items.map((i) => i.key);
    expect(keys.filter((k) => k === "session:s-draft")).toHaveLength(1);
    expect(keys[keys.length - 1]).toBe(`project:${OLD.id}`);
  });
});

describe("CommandPalette", () => {
  it("empty query shows recents (projects and chats) first, then actions", () => {
    pushPaletteRecent(USER, { kind: "session", id: "s-read" }, 1);
    pushPaletteRecent(USER, { kind: "project", id: PAPER.id }, 2);
    pushPaletteRecent(USER, { kind: "session", id: "gone" }, 3);
    setup();
    expect(groupLabels()).toEqual(["最近", "操作"]);
    const recent = within(screen.getByRole("group", { name: "最近" })).getAllByRole("option");
    expect(recent.map((o) => o.getAttribute("data-palette-key"))).toEqual([`project:${PAPER.id}`, "session:s-read"]);
    expect(selected()).toBe(recent[0]);
  });

  it("without recents falls back to the latest chats", () => {
    setup();
    const recent = within(screen.getByRole("group", { name: "最近" })).getAllByRole("option");
    expect(recent[0]).toHaveAttribute("data-palette-key", "session:s-draft");
  });

  it("groups the current project first, then others, then actions; archived projects are labelled", async () => {
    const searchMessages = vi.fn(async (): Promise<SessionSearchHit[]> => [
      { sessionId: "s-misc", title: "随便聊聊", projectId: null, snippet: "顺便写了周报提纲", matchedAt: NOW, kind: "message" },
    ]);
    const searchAssets = vi.fn(async (): Promise<ProjectAsset[]> => [
      asset("a-out", "weekly-2026-w40-周报.md", V5.id, { source: "output", sessionId: "s-draft" }),
      asset("a-xls", "9 月周报.xlsx", PAPER.id),
    ]);
    const { input } = setup({ currentProjectId: V5.id, searchMessages, searchAssets });
    type(input, "周报");
    // Client-side matches are there immediately.
    expect(groupLabels()[0]).toBe("当前项目 · V5 自用版改版");
    await waitFor(() => expect(screen.getByRole("option", { name: /顺便写了周报提纲/ })).toBeInTheDocument());
    expect(searchMessages).toHaveBeenCalledWith("周报", expect.any(AbortSignal));
    expect(searchAssets).toHaveBeenCalledWith("周报", expect.any(AbortSignal), 20);
    expect(groupLabels()).toEqual(["当前项目 · V5 自用版改版", "其他", "操作"]);
    const current = within(screen.getByRole("group", { name: "当前项目 · V5 自用版改版" })).getAllByRole("option");
    expect(current.map((o) => o.getAttribute("data-palette-key"))).toEqual(["session:s-draft", "asset:a-out"]);
    const other = within(screen.getByRole("group", { name: "其他" })).getAllByRole("option");
    expect(other.map((o) => o.getAttribute("data-palette-key"))).toEqual([
      "session:s-read",
      "session:s-misc",
      "asset:a-xls",
      `project:${OLD.id}`,
    ]);
    expect(within(other[3]!).getByText("已归档")).toBeInTheDocument();
    // Other-project rows carry their project name; the content hit carries its snippet.
    expect(other[0]).toHaveTextContent("论文综述 › 本周阅读周报");
    expect(other[2]).toHaveTextContent("论文综述 › 9 月周报.xlsx");
    expect(screen.getByRole("option", { name: /新建项目「周报」/ })).toBeInTheDocument();
  });

  it("↑↓ move the selection (wrapping), Enter opens the selected chat", () => {
    const { input, props } = setup();
    type(input, "周报");
    const all = options();
    expect(selected()).toBe(all[0]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe(all[1]);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selected()).toBe(all[all.length - 1]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toHaveAttribute("data-palette-key", "session:s-draft");
    expect(input).toHaveAttribute("aria-activedescendant", selected()!.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onOpenSession).toHaveBeenCalledWith("s-draft");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Enter during IME composition does nothing", () => {
    const { input, props } = setup();
    type(input, "周报");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(props.onOpenSession).not.toHaveBeenCalled();
  });

  it("Tab cycles the type filter", () => {
    const { input } = setup();
    type(input, "周报");
    const pressed = () => screen.getByRole("button", { pressed: true }).textContent;
    expect(pressed()).toBe("全部");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(pressed()).toBe("项目");
    expect(options().every((o) => o.getAttribute("data-palette-kind") === "project")).toBe(true);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(pressed()).toBe("会话");
    expect(options().every((o) => o.getAttribute("data-palette-kind") === "session")).toBe(true);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(pressed()).toBe("全部");
  });

  it("a project opens its home page", () => {
    const { input, props } = setup();
    type(input, "论文");
    fireEvent.click(screen.getByRole("option", { name: /论文综述/ }));
    expect(props.onOpenProject).toHaveBeenCalledWith(PAPER.id);
  });

  it("files open their project's 文件 tab, outputs the 产出 tab, ungrouped ones the source chat or the ungrouped files", async () => {
    const searchAssets = vi.fn(async () => [
      asset("a-up", "brief-a.pdf", PAPER.id),
      asset("a-out", "brief-b.md", V5.id, { source: "output", sessionId: "s-draft" }),
      asset("a-chat", "brief-c.png", null, { sessionId: "s-misc" }),
      asset("a-none", "brief-d.txt", null),
    ]);
    const { input, props } = setup({ searchAssets });
    type(input, "brief");
    await screen.findByRole("option", { name: /brief-a\.pdf/ });
    fireEvent.click(screen.getByRole("option", { name: /brief-a\.pdf/ }));
    expect(props.onOpenProject).toHaveBeenLastCalledWith(PAPER.id, "files");
    fireEvent.click(screen.getByRole("option", { name: /brief-b\.md/ }));
    expect(props.onOpenProject).toHaveBeenLastCalledWith(V5.id, "outputs");
    fireEvent.click(screen.getByRole("option", { name: /brief-c\.png/ }));
    expect(props.onOpenSession).toHaveBeenLastCalledWith("s-misc");
    fireEvent.click(screen.getByRole("option", { name: /brief-d\.txt/ }));
    expect(props.onOpenUngroupedAssets).toHaveBeenCalledTimes(1);
  });

  it("a file found by its excerpt shows a snippet around the hit", async () => {
    const searchAssets = vi.fn(async () => [
      asset("a-ex", "notes.txt", null, { excerpt: "第一段无关内容。这里提到了季度复盘的要点，以及后续计划。" }),
    ]);
    const { input } = setup({ searchAssets });
    type(input, "季度复盘");
    expect(await screen.findByText("季度复盘")).toBeInTheDocument();
  });

  it("actions: new chat in the current project, new project with the query, open home, open board", () => {
    const { input, props } = setup({ currentProjectId: V5.id });
    expect(screen.getByRole("option", { name: "新建会话于「V5 自用版改版」" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "新建会话于「V5 自用版改版」" }));
    expect(props.onNewSessionInProject).toHaveBeenCalledWith(V5.id);
    fireEvent.click(screen.getByRole("option", { name: "打开项目主页" }));
    expect(props.onOpenProject).toHaveBeenCalledWith(V5.id);
    fireEvent.click(screen.getByRole("option", { name: "打开看板" }));
    expect(props.onOpenBoard).toHaveBeenCalled();
    type(input, "看板");
    expect(keys()).toEqual(["action:open-board", "action:new-project"]);
    expect(screen.queryByRole("option", { name: "打开项目主页" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "新建项目「看板」" }));
    expect(props.onCreateProject).toHaveBeenCalledWith("看板");
  });

  it("on the project's home page there is no 打开项目主页; outside a project 新建会话 is plain", () => {
    setup({ currentProjectId: V5.id, onProjectHome: true });
    expect(screen.queryByRole("option", { name: "打开项目主页" })).toBeNull();
    cleanup();
    const { props } = setup();
    fireEvent.click(screen.getByRole("option", { name: "新建会话" }));
    expect(props.onNewSession).toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: "移动当前会话到…" })).toBeNull();
  });

  it("move the current chat: two steps, filterable, Esc steps back instead of closing", () => {
    const current = SESSIONS[0]!;
    const { input, props } = setup({ currentProjectId: V5.id, activeSession: current });
    type(input, "移动");
    fireEvent.keyDown(input, { key: "Enter" });
    const moveInput = screen.getByRole("combobox", { name: "选择要移入的项目" });
    expect(moveInput).toHaveValue("");
    // Its own project and archived projects are not targets; 未分类 is.
    expect(keys()).toEqual([`move:${PAPER.id}`, "move:none"]);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? moveInput, { key: "Escape" });
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "搜索与跳转" })).toBeInTheDocument();
    // Again, by mouse, then filter and pick with Enter.
    fireEvent.click(screen.getByRole("option", { name: "移动当前会话到…" }));
    type(screen.getByRole("combobox", { name: "选择要移入的项目" }), "论文");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "选择要移入的项目" }), { key: "Enter" });
    expect(props.onMoveSession).toHaveBeenCalledWith(current, PAPER.id);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Esc closes the palette", () => {
    const { input, props } = setup();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Esc while an input method is composing does not close the palette", () => {
    const { input, props } = setup();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true, keyCode: 229 });
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("renders as a full-screen sheet with 44px rows under md, with a 取消 button", () => {
    setup();
    const dialog = screen.getByTestId("command-palette");
    expect(dialog.className).toMatch(/(^|\s)inset-0(\s|$)/);
    expect(dialog.className).toContain("md:inset-auto");
    for (const o of options()) expect(o.className).toContain("min-h-11");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
  });

  it("shows no-result copy", () => {
    const { input } = setup();
    type(input, "zzzz-nothing");
    expect(keys()).toEqual(["action:new-project"]);
    expect(screen.getByRole("option", { name: "新建项目「zzzz-nothing」" })).toBeInTheDocument();
  });
});
