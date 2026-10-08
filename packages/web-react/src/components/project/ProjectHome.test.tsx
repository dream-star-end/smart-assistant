import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectTab } from "../../hooks/useAppRoute";
import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { ChatProject, ProjectAsset, Session } from "../../lib/types";
import { ToastProvider, TooltipProvider } from "../ui";
import { ProjectHome, type ProjectHomeProps } from "./ProjectHome";
import {
  PROJECT_RECIPES,
  filterSessionsByTitle,
  outputKind,
  projectSessionsOf,
  projectSummary,
} from "./projectHomeModel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project: ChatProject = {
  id: "p1",
  name: "V5 自用版改版",
  instructions: "中文回答；先给结论再给依据。",
  color: "accent",
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  sessionCount: 2,
};

function session(over: Partial<Session> & { id: string }): Session {
  return {
    title: `会话 ${over.id}`,
    ownerUserId: "u1",
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    messageCount: 2,
    ...over,
  };
}

function asset(over: Partial<ProjectAsset> & Pick<ProjectAsset, "id" | "name">): ProjectAsset {
  return {
    projectId: "p1",
    source: "upload",
    sessionId: null,
    url: "/api/media/x",
    containerPath: null,
    mime: null,
    sizeBytes: 10,
    excerpt: null,
    pinned: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

const SESSIONS: Session[] = [
  session({ id: "s-old", title: "项目功能重构调研", projectId: "p1", lastAt: 1_000 }),
  session({ id: "s-new", title: "侧栏搜索交互", projectId: "p1", lastAt: 5_000 }),
  session({ id: "s-other", title: "别的项目的会话", projectId: "p2", lastAt: 9_000 }),
  session({ id: "s-arch", title: "已归档的旧会话", projectId: "p1", lastAt: 500, archived: true }),
];

const ASSETS: ProjectAsset[] = [
  asset({ id: "a-pin", name: "设计规范.pdf", pinned: true }),
  asset({ id: "a-up", name: "竞品截图.zip" }),
  asset({
    id: "o-doc",
    name: "PROPOSAL.md",
    source: "output",
    sessionId: "s-old",
    createdAt: 3_000,
  }),
  asset({ id: "o-img", name: "sidebar-mock.png", source: "output", sessionId: "s-new", createdAt: 2_000 }),
  asset({ id: "o-xls", name: "usage-sept.xlsx", source: "output", createdAt: 1_500 }),
];

type Overrides = Partial<ProjectHomeProps> & { assets?: ProjectAsset[] };

function renderHome(over: Overrides = {}) {
  const { assets = ASSETS, ...rest } = over;
  vi.spyOn(api, "listProjectAssets").mockResolvedValue(assets);
  const auth = createMemoryAuthSession(() => {}, "tok");
  const handlers = {
    onStart: vi.fn(),
    onNewSession: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onOpenMobileNav: vi.fn(),
    onTabChange: vi.fn(),
    onLoadArchived: vi.fn(),
  };
  function Harness() {
    const [tab, setTab] = useState<ProjectTab>(rest.tab ?? "overview");
    return (
      <ProjectHome
        project={project}
        sessions={SESSIONS}
        demo={false}
        auth={auth}
        authSession={auth}
        {...handlers}
        {...rest}
        tab={tab}
        onTabChange={(t) => {
          handlers.onTabChange(t);
          setTab(t);
        }}
      />
    );
  }
  render(
    <ToastProvider>
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
    </ToastProvider>,
  );
  return handlers;
}

describe("projectHomeModel", () => {
  it("项目会话按最近活动排序，默认不含归档与其他项目", () => {
    expect(projectSessionsOf(SESSIONS, "p1").map((s) => s.id)).toEqual(["s-new", "s-old"]);
    expect(projectSessionsOf(SESSIONS, "p1", true).map((s) => s.id)).toEqual([
      "s-new",
      "s-old",
      "s-arch",
    ]);
    expect(filterSessionsByTitle(SESSIONS, "  侧栏 ").map((s) => s.id)).toEqual(["s-new"]);
  });

  it("产出类型按扩展名优先、mime 兜底", () => {
    expect(outputKind({ name: "PROPOSAL.md", mime: null })).toBe("doc");
    expect(outputKind({ name: "a.PNG", mime: null })).toBe("image");
    expect(outputKind({ name: "usage.xlsx", mime: "application/octet-stream" })).toBe("table");
    expect(outputKind({ name: "landing/index.html", mime: null })).toBe("code");
    expect(outputKind({ name: "noext", mime: "image/webp" })).toBe("image");
    expect(outputKind({ name: "noext", mime: "application/pdf" })).toBe("doc");
    expect(outputKind({ name: "bundle.zip", mime: "application/zip" })).toBe("other");
  });

  it("摘要只拼确实有的数据", () => {
    expect(projectSummary({ hasInstructions: true, pinnedCount: 8, sessionCount: 14 })).toBe(
      "已设项目指令 · 8 份常用文件 · 14 个会话",
    );
    expect(projectSummary({ hasInstructions: false, pinnedCount: null, sessionCount: 0 })).toBe(
      "还没有会话",
    );
  });
});

describe("ProjectHome", () => {
  it("概览：标题、摘要、最近会话、项目指令、常用文件、最新产出", async () => {
    const h = renderHome();
    expect(screen.getByRole("heading", { level: 1, name: "V5 自用版改版" })).toBeInTheDocument();

    const recent = screen.getByTestId("project-home-recent");
    const titles = within(recent)
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    expect(titles[0]).toContain("侧栏搜索交互");
    expect(titles[1]).toContain("项目功能重构调研");
    expect(within(recent).queryByText("别的项目的会话")).toBeNull();
    expect(within(recent).queryByText("已归档的旧会话")).toBeNull();
    fireEvent.click(within(recent).getByText("项目功能重构调研"));
    expect(h.onOpenSession).toHaveBeenCalledWith("s-old");

    const instr = screen.getByTestId("project-home-instructions");
    expect(within(instr).getByText("中文回答；先给结论再给依据。")).toBeInTheDocument();
    fireEvent.click(within(instr).getByRole("button", { name: "编辑" }));
    expect(h.onOpenSettings).toHaveBeenCalledTimes(1);

    const pinned = screen.getByTestId("project-home-pinned");
    await waitFor(() => expect(within(pinned).getByText("设计规范.pdf")).toBeInTheDocument());
    expect(within(pinned).queryByText("竞品截图.zip")).toBeNull();

    const outputs = screen.getByTestId("project-home-outputs");
    expect(within(outputs).getByText("PROPOSAL.md")).toBeInTheDocument();
    expect(within(outputs).getByText("usage-sept.xlsx")).toBeInTheDocument();
    // 有来源会话的产出可点开会话。
    fireEvent.click(within(outputs).getByText("sidebar-mock.png"));
    expect(h.onOpenSession).toHaveBeenLastCalledWith("s-new");

    expect(screen.getByTestId("project-home-summary")).toHaveTextContent(
      "已设项目指令 · 1 份常用文件 · 2 个会话",
    );
  });

  it("开始框：提交文本回调 onStart 并清空；空白不提交", () => {
    const h = renderHome();
    const box = screen.getByRole("textbox", { name: "在「V5 自用版改版」里开始" });
    expect(box).toHaveAttribute("placeholder", "在「V5 自用版改版」里开始…");
    const sendBtn = screen.getByRole("button", { name: "开始新会话" });
    expect(sendBtn).toBeDisabled();
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(h.onStart).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: "  整理一下需求  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(h.onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(h.onStart).toHaveBeenCalledWith("整理一下需求");
    expect(box).toHaveValue("");

    fireEvent.change(box, { target: { value: "第二条" } });
    fireEvent.click(sendBtn);
    expect(h.onStart).toHaveBeenLastCalledWith("第二条");
  });

  it("快捷开始：两个固定提示词 + 继续上次打开最近会话", () => {
    const h = renderHome();
    fireEvent.click(screen.getByRole("button", { name: /汇总最近进展/ }));
    expect(h.onStart).toHaveBeenLastCalledWith(PROJECT_RECIPES[0].prompt);
    fireEvent.click(screen.getByRole("button", { name: /生成本周周报/ }));
    expect(h.onStart).toHaveBeenLastCalledWith(PROJECT_RECIPES[1].prompt);
    fireEvent.click(screen.getByRole("button", { name: "继续上次：侧栏搜索交互" }));
    expect(h.onOpenSession).toHaveBeenLastCalledWith("s-new");
  });

  it("没有会话时不显示「继续上次」，各卡片给出下一步提示", async () => {
    renderHome({
      sessions: [],
      project: { ...project, instructions: null },
      assets: [],
    });
    expect(screen.queryByRole("button", { name: /继续上次/ })).toBeNull();
    expect(screen.getByText(/还没有会话。在上面的输入框说点什么/)).toBeInTheDocument();
    expect(screen.getByText(/还没有项目指令/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("project-home-instructions")).getByRole("button", { name: "添加" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/还没有常用文件/)).toBeInTheDocument());
    expect(screen.getByText(/还没有产出。/)).toBeInTheDocument();
    expect(screen.getByTestId("project-home-summary")).toHaveTextContent("还没有会话");
  });

  it("页签切换：会话页签列出全部会话（含归档）并可按标题筛选", () => {
    const h = renderHome();
    fireEvent.click(screen.getByRole("tab", { name: /会话/ }));
    expect(h.onTabChange).toHaveBeenLastCalledWith("chats");
    expect(screen.getByRole("tab", { name: /会话/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("project-home-recent")).toBeNull();
    expect(screen.getByText("已归档的旧会话")).toBeInTheDocument();
    expect(screen.queryByText("别的项目的会话")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "按标题筛选会话" }), {
      target: { value: "重构" },
    });
    expect(screen.getByText("项目功能重构调研")).toBeInTheDocument();
    expect(screen.queryByText("侧栏搜索交互")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "按标题筛选会话" }), {
      target: { value: "不存在" },
    });
    expect(screen.getByText("没有标题匹配「不存在」的会话")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(h.onNewSession).toHaveBeenCalledTimes(1);
  });

  it("会话页签空态给出新建入口", () => {
    const h = renderHome({ sessions: [], tab: "chats" });
    expect(screen.getByText("这个项目还没有会话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(h.onNewSession).toHaveBeenCalledTimes(1);
  });

  it("文件页签渲染项目文件面板", async () => {
    renderHome({ tab: "files" });
    await waitFor(() => expect(screen.getByText("竞品截图.zip")).toBeInTheDocument());
    expect(screen.getByText(/设为常用的文件/)).toBeInTheDocument();
  });

  it("产出页签：类型筛选与「在会话中打开」", async () => {
    const h = renderHome({ tab: "outputs" });
    await waitFor(() => expect(screen.getByText("PROPOSAL.md")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "全部 3" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "图片 1" }));
    expect(screen.getByText("sidebar-mock.png")).toBeInTheDocument();
    expect(screen.queryByText("PROPOSAL.md")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /在会话中打开/ }));
    expect(h.onOpenSession).toHaveBeenCalledWith("s-new");

    fireEvent.click(screen.getByRole("button", { name: "表格 1" }));
    expect(screen.getByText("usage-sept.xlsx")).toBeInTheDocument();
    // 没有来源会话的产出不给「在会话中打开」。
    expect(screen.queryByRole("button", { name: /在会话中打开/ })).toBeNull();
  });

  it("产出页签：多版本的产出显示 v<N>，版本历史列出时间/大小/下载，恢复旧版本", async () => {
    const path = "/home/agent/.openclaude/generated/report.md";
    const v = (id: string, n: number, createdAt: number, sizeBytes: number, url: string | null) =>
      asset({ id, name: "report.md", source: "output", containerPath: path, url, sizeBytes, createdAt });
    const latest = { ...v("o-v3", 3, 9_000, 3_072, "/api/media/" + "c".repeat(64) + ".md"), versionCount: 3 };
    const versions = [
      latest,
      v("o-v2", 2, 8_000, 2_048, "/api/media/" + "b".repeat(64) + ".md"),
      v("o-v1", 1, 7_000, 1_024, null),
    ];
    const list = vi.spyOn(api, "listProjectAssetVersions").mockResolvedValue(versions);
    const restore = vi
      .spyOn(api, "restoreProjectAssetVersion")
      .mockResolvedValue({ asset: { ...versions[1]!, id: "o-v4" }, created: true });
    renderHome({ tab: "outputs", assets: [...ASSETS, latest] });
    await waitFor(() => expect(screen.getByText("report.md")).toBeInTheDocument());
    // 单版本产出没有版本号。
    expect(screen.getAllByTestId("output-version-badge")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "report.md 共 3 个版本，查看版本历史" }));
    const dialog = await screen.findByTestId("output-versions");
    await waitFor(() => expect(within(dialog).getAllByTestId("output-version")).toHaveLength(3));
    expect(list).toHaveBeenCalledWith(expect.anything(), "o-v3");
    const rows = within(dialog).getAllByTestId("output-version");
    expect(rows.map((r) => r.textContent?.slice(0, 2))).toEqual(["v3", "v2", "v1"]);
    expect(within(rows[0]!).getByText("最新")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("3 KB")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("2 KB")).toBeInTheDocument();
    for (const label of ["下载 v3", "下载 v2", "下载 v1"]) {
      expect(within(dialog).getByRole("button", { name: label })).toBeEnabled();
    }
    // 最新版不给恢复；没有单独副本的旧登记也不给。
    expect(within(rows[0]!).queryByRole("button", { name: /恢复/ })).toBeNull();
    expect(within(rows[2]!).queryByRole("button", { name: /恢复/ })).toBeNull();
    expect(within(rows[2]!).getByText("未单独保存")).toBeInTheDocument();

    const reloadsBefore = vi.mocked(api.listProjectAssets).mock.calls.length;
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /恢复/ }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(expect.anything(), "o-v2"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(vi.mocked(api.listProjectAssets).mock.calls.length).toBeGreaterThan(reloadsBefore));
  });

  it("概览：多版本产出也显示 v<N>（只读，不嵌套按钮）", async () => {
    const latest = {
      ...asset({ id: "o-many", name: "weekly.md", source: "output", createdAt: 9_999, containerPath: "/home/agent/.openclaude/generated/weekly.md" }),
      versionCount: 2,
    };
    renderHome({ assets: [...ASSETS, latest] });
    const card = await screen.findByTestId("project-home-outputs");
    await waitFor(() => expect(within(card).getByText("weekly.md")).toBeInTheDocument());
    expect(within(card).getByTestId("output-version-badge")).toHaveTextContent("v2");
    expect(within(card).queryByRole("button", { name: /版本历史/ })).toBeNull();
  });

  it("产出页签空态", async () => {
    renderHome({ tab: "outputs", assets: [] });
    await waitFor(() => expect(screen.getByText("还没有产出")).toBeInTheDocument());
  });

  it("设置按钮与 ⋯ 菜单接到 App 回调", () => {
    const h = renderHome();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(h.onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByRole("button", { name: "项目 V5 自用版改版 更多" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(h.onRename).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByRole("button", { name: "项目 V5 自用版改版 更多" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("会话页签触发已归档会话加载；加载中且暂无会话时显示加载态而不是空态", () => {
    const h = renderHome({ sessions: [], tab: "chats", loadingArchived: true, assets: [] });
    expect(h.onLoadArchived).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("project-chats-loading")).toHaveTextContent("正在加载会话…");
    expect(screen.queryByText("这个项目还没有会话")).toBeNull();
  });

  it("加载中但已有会话：列表照常显示并提示正在加载已归档会话", () => {
    renderHome({ tab: "chats", loadingArchived: true });
    expect(screen.getByText("侧栏搜索交互")).toBeInTheDocument();
    expect(screen.getByText("正在加载已归档会话…")).toBeInTheDocument();
  });

  it("概览：产出的来源会话不在已加载列表里时才触发已归档加载", async () => {
    const h = renderHome({
      assets: [asset({ id: "o-x", name: "old.md", source: "output", sessionId: "s-gone" })],
    });
    await waitFor(() => expect(h.onLoadArchived).toHaveBeenCalledTimes(1));
    cleanup();
    vi.restoreAllMocks();
    const h2 = renderHome();
    await waitFor(() => expect(screen.getByText("PROPOSAL.md")).toBeInTheDocument());
    expect(h2.onLoadArchived).not.toHaveBeenCalled();
  });
});

const scopeBoards = { current: [] as Array<{ id: string }> };
const setToken = vi.fn();
vi.mock("../../hooks/useProjectScope", () => ({
  useProjectScope: () => ({
    refreshWorkProjects: async () => scopeBoards.current,
    setToken,
  }),
}));

describe("ProjectHome surfaces (P2)", () => {
  afterEach(() => setToken.mockClear());
  it("a project with a board links to its board, memory, skills and cron; the board is prepared first", async () => {
    const order: string[] = [];
    const onPrepareBoard = vi.fn(async () => {
      order.push("prepare");
      return true;
    });
    const onShowSurface = vi.fn((s: string) => void order.push(`show ${s}`));
    scopeBoards.current = [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }];
    renderHome({
      project: { ...project, boardProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      onPrepareBoard,
      onShowSurface,
    } as Overrides);
    const links = await screen.findByTestId("project-surface-links");
    expect(links).toHaveTextContent("看板");
    fireEvent.click(screen.getByRole("button", { name: "记忆" }));
    await waitFor(() => expect(onShowSurface).toHaveBeenCalledWith("memory"));
    expect(order).toEqual(["prepare", "show memory"]);
    expect(setToken).toHaveBeenCalledWith("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("does not switch scope or open the page when the refreshed list lacks the board", async () => {
    scopeBoards.current = [];
    const onShowSurface = vi.fn();
    renderHome({
      project: { ...project, boardProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      onPrepareBoard: async () => true,
      onShowSurface,
    } as Overrides);
    fireEvent.click(await screen.findByRole("button", { name: "定时任务" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(onShowSurface).not.toHaveBeenCalled();
    expect(setToken).not.toHaveBeenCalled();
  });

  it("no links when the board cannot be prepared, and none without a board", async () => {
    const onShowSurface = vi.fn();
    renderHome({
      project: { ...project, boardProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      onPrepareBoard: async () => false,
      onShowSurface,
    } as Overrides);
    fireEvent.click(await screen.findByRole("button", { name: "定时任务" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(onShowSurface).not.toHaveBeenCalled();
    cleanup();
    renderHome({ onPrepareBoard: async () => true, onShowSurface } as Overrides);
    expect(screen.queryByTestId("project-surface-links")).toBeNull();
  });
});

const boardTickets = { current: [] as Array<Record<string, unknown>> };
vi.mock("../../lib/taskboard", () => ({
  taskboardApi: { listTickets: async () => ({ items: boardTickets.current }) },
}));

describe("ProjectHome activity (P3)", () => {
  it("最近活动合并会话、看板任务与定时任务，按时间倒序；点任务打开看板", async () => {
    const board = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    boardTickets.current = [{ id: "t1", identifier: "PRJ-3", title: "补齐验收截图", status: "doing", updatedAt: 7_000 }];
    vi.spyOn(api, "listCron").mockResolvedValue([
      { id: "c1", label: "每周汇总", enabled: true, lastRunAt: 3_000 },
    ] as never);
    scopeBoards.current = [{ id: board }];
    const onShowSurface = vi.fn();
    renderHome({ project: { ...project, boardProjectId: board }, onPrepareBoard: async () => true, onShowSurface } as Overrides);
    const card = await screen.findByTestId("project-home-recent");
    await waitFor(() => expect(within(card).getByTestId("activity-ticket")).toBeInTheDocument());
    const text = card.textContent ?? "";
    expect(text.indexOf("PRJ-3 补齐验收截图")).toBeLessThan(text.indexOf("侧栏搜索交互"));
    expect(text.indexOf("侧栏搜索交互")).toBeLessThan(text.indexOf("每周汇总"));
    expect(text.indexOf("每周汇总")).toBeLessThan(text.indexOf("项目功能重构调研"));
    fireEvent.click(within(card).getByTestId("activity-ticket"));
    await waitFor(() => expect(onShowSurface).toHaveBeenCalledWith("board"));
  });

  it("没有看板时只有会话，不请求任务与定时任务", async () => {
    const spy = vi.spyOn(api, "listCron");
    renderHome();
    const card = await screen.findByTestId("project-home-recent");
    expect(within(card).queryByTestId("activity-ticket")).toBeNull();
    expect(card).toHaveTextContent("侧栏搜索交互");
    expect(spy).not.toHaveBeenCalled();
  });
});
