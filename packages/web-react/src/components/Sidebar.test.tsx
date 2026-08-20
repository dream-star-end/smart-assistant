import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ChatProject, Session, User } from "../lib/types";
import { Sidebar } from "./Sidebar";
import { SESSION_ROW_HEIGHT, SESSION_ROW_HEIGHT_PREVIEW } from "./sidebar/constants";
import { flattenSidebarItems } from "./sidebar/flattenItems";
import { HighlightedText } from "./sidebar/highlight";
import { modelShortLabel } from "./sidebar/modelShortLabel";

afterEach(() => {
  cleanup();
});

const user: User = {
  id: "u1",
  displayName: "测试用户",
  roles: ["user"],
  role: "admin",
};

const sessions: Session[] = [];

function renderSidebar(extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return render(
    <Sidebar
      sessions={sessions}
      user={user}
      onSelect={() => {}}
      onNew={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      {...extra}
    />,
  );
}

/** radix DropdownMenu Trigger 在 pointerdown 开启(click 不够),jsdom 里直接发。 */
function openAccountMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "账号菜单" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function openSessionMenu(title: string) {
  const row = screen.getByRole("button", { name: title }).closest("div");
  const more = Array.from(row!.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "更多",
  );
  expect(more).toBeTruthy();
  fireEvent.pointerDown(more!, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("Sidebar 账号菜单（平台超管 / 反馈）", () => {
  it("showAdmin=true 时账号菜单里渲染指向 /admin.html 的管理后台入口", () => {
    renderSidebar({ showAdmin: true });
    expect(screen.queryByRole("link", { name: /管理后台/ })).toBeNull();
    openAccountMenu();
    const link = screen.getByRole("menuitem", { name: /管理后台/ });
    expect(link).toHaveAttribute("href", "/admin.html");
  });

  it("showAdmin 缺省时账号菜单不出现管理后台入口（非 admin / demo 一律隐藏）", () => {
    renderSidebar({ onOpenAccount: () => {} });
    openAccountMenu();
    expect(screen.queryByRole("menuitem", { name: /管理后台/ })).toBeNull();
  });

  it("showAdmin=false 时账号菜单不出现管理后台入口", () => {
    renderSidebar({ onOpenAccount: () => {}, showAdmin: false });
    openAccountMenu();
    expect(screen.queryByRole("menuitem", { name: /管理后台/ })).toBeNull();
  });

  it("提供反馈回调时在账号菜单里触发打开，底栏不再放反馈图标", () => {
    const onOpenFeedback = vi.fn();
    renderSidebar({ onOpenFeedback });
    expect(screen.queryByRole("button", { name: "反馈与帮助" })).toBeNull();
    openAccountMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "意见反馈" }));
    expect(onOpenFeedback).toHaveBeenCalledTimes(1);
  });

  it("未提供反馈回调时账号菜单不显示反馈入口", () => {
    renderSidebar({ onOpenAccount: () => {} });
    openAccountMenu();
    expect(screen.queryByRole("menuitem", { name: "意见反馈" })).toBeNull();
  });
});

describe("Sidebar 管理中心入口副标题", () => {
  it("无待办时展示与实际分区对齐的速览文案", () => {
    renderSidebar({ onOpenManage: () => {} });
    openAccountMenu();
    const entry = screen.getByRole("menuitem", { name: /管理中心/ });
    expect(entry).toHaveTextContent("记忆 · 技能");
  });

  it("有待确认建议时改用数量徽章（Auto‑Dream 在账号菜单的唯一曝光）", () => {
    renderSidebar({ onOpenManage: () => {}, optimizerPending: 3 });
    openAccountMenu();
    const entry = screen.getByRole("menuitem", { name: /管理中心/ });
    expect(entry).toHaveTextContent("3 项待确认");
    expect(entry).not.toHaveTextContent("记忆 · 技能");
  });
});

// ── 会话列表本体 ───────────────────────────────────────────────────────────────
// 之前本文件的 5 条用例全跑在 sessions: [] 上:列表渲染、选中态、改名/删除入口、
// 搜索过滤**一条都没被覆盖**,而这些是侧栏唯一的日常用途,删除还是不可逆动作
// (useSessionList 的确认文案:「本地与云端记录都将删除,不可恢复」)。
// 断言的是用户可见事实,不锁 class/DOM 排列。
function session(over: Partial<Session> & { id: string }): Session {
  return {
    title: `会话 ${over.id}`,
    ownerUserId: "u1",
    updatedAt: new Date().toISOString(),
    messageCount: 2,
    ...over,
  };
}

const listSessions: Session[] = [
  session({ id: "s-alpha", title: "季度复盘 Alpha" }),
  session({ id: "s-beta", title: "Beta 上线检查" }),
  session({ id: "s-empty", title: "" }),
];

describe("Sidebar 会话列表", () => {
  it("渲染每条会话标题，空标题回退为「新对话」而不是空白行", () => {
    renderSidebar({ sessions: listSessions });
    expect(screen.getByRole("button", { name: "季度复盘 Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta 上线检查" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新对话" })).toBeInTheDocument();
    expect(screen.queryByText("暂无会话")).toBeNull();
  });

  it("当前会话以 aria-current 暴露选中态（读屏/键盘用户与视觉一致），其他会话不带", () => {
    renderSidebar({ sessions: listSessions, activeId: "s-beta" });
    expect(screen.getByRole("button", { name: "Beta 上线检查" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: "季度复盘 Alpha" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("活跃会话行有左侧 accent 竖条；非活跃行无竖条、圆角同为 rounded-md", () => {
    renderSidebar({ sessions: listSessions, activeId: "s-beta" });
    const activeBtn = screen.getByRole("button", { name: "Beta 上线检查" });
    const activeRow = activeBtn.closest("div");
    expect(activeRow).toHaveClass("rounded-md", "bg-active");
    expect(activeRow?.querySelector(".bg-accent")).not.toBeNull();

    const idleBtn = screen.getByRole("button", { name: "季度复盘 Alpha" });
    const idleRow = idleBtn.closest("div");
    expect(idleRow).toHaveClass("rounded-md");
    expect(idleRow?.querySelector(".bg-accent")).toBeNull();
  });

  it("管理/市场/组织/后台不再占侧栏主区；点账号菜单才出现，设置与退出也在菜单里", () => {
    const onOpenAccount = vi.fn();
    const onLogout = vi.fn();
    const onOpenMediaTasks = vi.fn();
    renderSidebar({
      onOpenManage: () => {},
      onOpenMarketplace: () => {},
      onOpenTutorial: () => {},
      onOpenOrg: () => {},
      onOpenMediaTasks,
      onOpenAccount,
      onLogout,
      showAdmin: true,
      theme: "light",
      onCycleTheme: () => {},
    });
    const create = screen.getByRole("button", { name: "新建会话" });
    expect(create).toHaveClass("text-section");
    expect(create.className).toMatch(/border-border/);
    expect(create.className).toMatch(/bg-surface/);

    expect(screen.queryByRole("button", { name: /管理中心/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^市场/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^组织/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /管理后台/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.queryByRole("button", { name: "反馈与帮助" })).toBeNull();

    expect(screen.getByRole("button", { name: "打开使用教程" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /切换主题/ })).toBeInTheDocument();

    openAccountMenu();
    expect(screen.getByRole("menuitem", { name: /管理中心/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^市场/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^组织/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /管理后台/ })).toHaveAttribute("href", "/admin.html");
    fireEvent.click(screen.getByRole("menuitem", { name: "视频任务" }));
    expect(onOpenMediaTasks).toHaveBeenCalledTimes(1);

    openAccountMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);

    openAccountMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("点击用户区先弹出账号菜单，而不是直接进入设置", () => {
    const onOpenAccount = vi.fn();
    renderSidebar({ onOpenAccount });
    openAccountMenu();
    expect(onOpenAccount).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "设置" })).toBeInTheDocument();
  });

  it("点击会话行把该会话 id 上抛（核心导航）", () => {
    const onSelect = vi.fn();
    renderSidebar({ sessions: listSessions, onSelect });
    fireEvent.click(screen.getByRole("button", { name: "季度复盘 Alpha" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("s-alpha");
  });

  it("改名入口只对被点的那一条生效，且不顺带切换会话", () => {
    const onRename = vi.fn();
    const onSelect = vi.fn();
    renderSidebar({ sessions: listSessions, onRename, onSelect });
    openSessionMenu("Beta 上线检查");
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0][0].id).toBe("s-beta");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("删除入口只对被点的那一条生效，且不顺带切换会话（不可逆操作）", () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    renderSidebar({ sessions: listSessions, onDelete, onSelect });
    openSessionMenu("季度复盘 Alpha");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0].id).toBe("s-alpha");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("搜索按标题过滤（大小写不敏感），清空后全部恢复", () => {
    renderSidebar({ sessions: listSessions });
    const search = screen.getByPlaceholderText("搜索会话");

    fireEvent.change(search, { target: { value: "beta" } });
    expect(screen.getByRole("button", { name: "Beta 上线检查" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "季度复盘 Alpha" })).toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "季度复盘 Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta 上线检查" })).toBeInTheDocument();
  });

  it("过滤无命中时给出空态提示，而不是一片空白", () => {
    renderSidebar({ sessions: listSessions });
    fireEvent.change(screen.getByPlaceholderText("搜索会话"), {
      target: { value: "不存在的关键词" },
    });
    expect(screen.getByText("没有匹配的会话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Beta 上线检查" })).toBeNull();
  });

  it("按更新时间分组展示（今天 / 更早各自成组）", () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    renderSidebar({
      sessions: [
        session({ id: "s-today", title: "今天的会话" }),
        session({ id: "s-old", title: "很久以前的会话", updatedAt: old }),
      ],
    });
    expect(screen.getByText("今天")).toBeInTheDocument();
    expect(screen.getByText("更早")).toBeInTheDocument();
  });
});

describe("Sidebar 任务面板入口", () => {
  it("传入 onOpenBoard 时渲染入口，并用 data-product-control 标注", () => {
    const onOpenBoard = vi.fn();
    renderSidebar({ onOpenBoard, boardActive: true });
    const btn = screen.getByRole("button", { name: /任务面板/ });
    expect(btn).toHaveAttribute("data-product-control");
    expect(btn).toHaveAttribute("aria-current", "true");
    fireEvent.click(btn);
    expect(onOpenBoard).toHaveBeenCalled();
  });

  it("省略 onOpenBoard 时不渲染入口（demo）", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: /任务面板/ })).toBeNull();
  });
});

function project(over: Partial<ChatProject> & { id: string; name: string }): ChatProject {
  return {
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    sessionCount: 0,
    ...over,
  };
}

function dragData() {
  const store: Record<string, string> = {};
  const types: string[] = [];
  return {
    types,
    dropEffect: "move",
    effectAllowed: "move",
    setData(type: string, value: string) {
      store[type] = value;
      if (!types.includes(type)) types.push(type);
    },
    getData(type: string) {
      return store[type] ?? "";
    },
  };
}

describe("Sidebar 项目分组", () => {
  const projects = [project({ id: "p-work", name: "工作", sessionCount: 1 })];
  const projectSessions: Session[] = [
    session({ id: "s-in", title: "项目里的会话", projectId: "p-work" }),
    session({ id: "s-out", title: "未分组会话" }),
  ];

  it("项目在上、未分组按时间分组在下；展开后缩进显示项目会话且不套时间分组", () => {
    renderSidebar({
      sessions: projectSessions,
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
    });
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("工作")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目里的会话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "未分组会话" })).toBeInTheDocument();
    expect(screen.getByText("今天")).toBeInTheDocument();
    const workBtn = screen.getByRole("button", { name: /工作/ });
    expect(workBtn).toHaveAttribute("aria-expanded", "true");
  });

  it("折叠项目后隐藏其下会话，并回调 toggle", () => {
    const onToggle = vi.fn();
    const { rerender } = renderSidebar({
      sessions: projectSessions,
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: onToggle,
      onCreateProject: () => {},
    });
    fireEvent.click(screen.getByRole("button", { name: /工作/ }));
    expect(onToggle).toHaveBeenCalledWith("p-work");

    rerender(
      <Sidebar
        sessions={projectSessions}
        user={user}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        projects={projects}
        collapsedProjectIds={new Set(["p-work"])}
        onToggleProjectCollapsed={onToggle}
        onCreateProject={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "项目里的会话" })).toBeNull();
    expect(screen.getByRole("button", { name: /工作/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("搜索时跨项目平铺匹配，不显示项目层级", () => {
    renderSidebar({
      sessions: projectSessions,
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
    });
    fireEvent.change(screen.getByPlaceholderText("搜索会话"), { target: { value: "项目里" } });
    expect(screen.getByRole("button", { name: "项目里的会话" })).toBeInTheDocument();
    expect(screen.queryByText("项目")).toBeNull();
    expect(screen.queryByRole("button", { name: /工作/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "未分组会话" })).toBeNull();
  });

  it("把会话拖到项目行上放下即归属该项目", () => {
    const onMoveToProject = vi.fn();
    renderSidebar({
      sessions: projectSessions,
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
      onMoveToProject,
    });
    const dt = dragData();
    const row = screen.getByRole("button", { name: "未分组会话" }).closest("div")!;
    fireEvent.dragStart(row, { dataTransfer: dt });
    const projectRow = screen.getByRole("button", { name: /工作/ }).closest("div")!;
    fireEvent.dragOver(projectRow, { dataTransfer: dt });
    fireEvent.drop(projectRow, { dataTransfer: dt });
    expect(onMoveToProject).toHaveBeenCalledTimes(1);
    expect(onMoveToProject.mock.calls[0][0].id).toBe("s-out");
    expect(onMoveToProject.mock.calls[0][1]).toBe("p-work");
  });

  it("会话更多菜单可以把会话移到项目", async () => {
    const onMoveToProject = vi.fn();
    renderSidebar({
      sessions: projectSessions,
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
      onMoveToProject,
    });
    openSessionMenu("未分组会话");
    const sub = screen.getByRole("menuitem", { name: "移动到项目" });
    fireEvent.focus(sub);
    fireEvent.keyDown(sub, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "工作" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("menuitem", { name: "工作" }));
    expect(onMoveToProject).toHaveBeenCalledTimes(1);
    expect(onMoveToProject.mock.calls[0][0].id).toBe("s-out");
    expect(onMoveToProject.mock.calls[0][1]).toBe("p-work");
  });

  it("项目为空时给出克制提示", () => {
    renderSidebar({
      sessions: [],
      projects: [],
      onCreateProject: () => {},
    });
    expect(screen.getByText("还没有项目")).toBeInTheDocument();
    expect(screen.getByText("暂无会话")).toBeInTheDocument();
  });
});

describe("Sidebar 会话状态点", () => {
  it("四态：运行中闪绿、完成/中断常亮绿、异常红、服务重启琥珀", () => {
    renderSidebar({
      sessions: [
        session({ id: "s-run", title: "正在跑", runState: "running" }),
        session({ id: "s-ok", title: "已跑完", lastOutcome: "completed" }),
        session({ id: "s-stop", title: "用户停了", lastOutcome: "interrupted" }),
        session({ id: "s-err", title: "崩了", lastOutcome: "crashed" }),
        session({ id: "s-rst", title: "被重启", lastOutcome: "crashed", lastErrorCode: "SERVICE_RESTART" }),
        session({ id: "s-new", title: "从没跑过", lastOutcome: null }),
      ],
      isSending: (id) => id === "s-run",
    });
    expect(screen.getByRole("img", { name: "运行中" })).toHaveClass("bg-success", "oc-session-running");
    expect(screen.getByRole("img", { name: "已完成" })).toHaveClass("bg-success");
    expect(screen.getByRole("img", { name: "已中断" })).toHaveClass("bg-success");
    expect(screen.getByRole("img", { name: "出错" })).toHaveClass("bg-danger");
    expect(screen.getByRole("img", { name: "服务重启中断，可继续" })).toHaveClass("bg-warning");
    expect(screen.queryByRole("img", { name: "从没跑过" })).toBeNull();
    const idleRow = screen.getByRole("button", { name: "从没跑过" }).closest("div")!;
    expect(idleRow.querySelector("[role=img]")).toBeNull();
  });

  it("本 tab isSending 立刻覆盖列表 idle，显示运行中", () => {
    renderSidebar({
      sessions: [session({ id: "s1", title: "刚发出去", runState: "idle", lastOutcome: "completed" })],
      isSending: () => true,
    });
    expect(screen.getByRole("img", { name: "运行中" })).toBeInTheDocument();
  });
});

describe("Sidebar 置顶", () => {
  it("置顶会话集中显示在最上方「置顶」分组，不再出现在时间分组里", () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    renderSidebar({
      sessions: [
        session({ id: "s-pin", title: "钉住的", pinned: true, updatedAt: old }),
        session({ id: "s-today", title: "今天的" }),
      ],
      onTogglePin: () => {},
    });
    expect(screen.getByText("置顶")).toBeInTheDocument();
    expect(screen.getByText("今天")).toBeInTheDocument();
    const pinHeading = screen.getByText("置顶");
    const todayHeading = screen.getByText("今天");
    expect(
      pinHeading.compareDocumentPosition(screen.getByRole("button", { name: "钉住的" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      pinHeading.compareDocumentPosition(todayHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    openSessionMenu("钉住的");
    expect(screen.getByRole("menuitem", { name: /取消置顶/ })).toBeInTheDocument();
  });
});

describe("Sidebar 虚拟列表拍平", () => {
  it("折叠项目后拍平结果不含其下会话，展开则含且带 indent", () => {
    const proj = project({ id: "p-work", name: "工作" });
    const inProj = session({ id: "s-in", title: "项目里的会话", projectId: "p-work" });
    const out = session({ id: "s-out", title: "未分组会话" });
    const collapsed = flattenSidebarItems({
      searching: false,
      showProjects: true,
      showPreview: false,
      pinned: [],
      projects: [proj],
      projectSessions: new Map([["p-work", [inProj]]]),
      sessions: [inProj, out],
      ungroupedGroups: [["今天", [out]]],
      collapsedProjectIds: new Set(["p-work"]),
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
    });
    expect(collapsed.some((i) => i.kind === "session" && i.session.id === "s-in")).toBe(false);
    expect(collapsed.some((i) => i.kind === "project" && i.collapsed)).toBe(true);

    const open = flattenSidebarItems({
      searching: false,
      showProjects: true,
      showPreview: false,
      pinned: [],
      projects: [proj],
      projectSessions: new Map([["p-work", [inProj]]]),
      sessions: [inProj, out],
      ungroupedGroups: [["今天", [out]]],
      collapsedProjectIds: new Set(),
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
    });
    const child = open.find((i) => i.kind === "session" && i.session.id === "s-in");
    expect(child).toMatchObject({ kind: "session", indent: true, height: SESSION_ROW_HEIGHT });
    expect(open[0]?.kind).not.toBe("session");
  });

  it("置顶分组在项目与时间分组之前；搜索时不拍项目行", () => {
    const pin = session({ id: "s-pin", title: "钉住的", pinned: true });
    const items = flattenSidebarItems({
      searching: true,
      showProjects: true,
      showPreview: false,
      pinned: [],
      projects: [project({ id: "p-work", name: "工作" })],
      projectSessions: new Map(),
      sessions: [pin],
      ungroupedGroups: [["搜索结果", [pin]]],
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
    });
    expect(items.some((i) => i.kind === "project")).toBe(false);
    expect(items.find((i) => i.kind === "header")?.label).toBe("搜索结果");
  });

  it("统一摘要开关下所有会话行同高", () => {
    const s = session({ id: "s1", title: "有摘要", lastMessagePreview: "hello" });
    const items = flattenSidebarItems({
      searching: false,
      showProjects: false,
      showPreview: true,
      pinned: [],
      projects: [],
      projectSessions: new Map(),
      sessions: [s],
      ungroupedGroups: [["今天", [s]]],
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
    });
    const rows = items.filter((i) => i.kind === "session");
    expect(rows.every((r) => r.height === SESSION_ROW_HEIGHT_PREVIEW)).toBe(true);
  });

  it("超过阈值且能读到视口高度时只挂载窗口内的会话", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      session({ id: `s-${i}`, title: `长列表会话 ${i}` }),
    );
    const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 180;
      },
    });
    try {
      renderSidebar({ sessions: many, virtualizeThreshold: 8 });
      const list = document.querySelector("[data-sidebar-list]");
      expect(list).toHaveAttribute("data-virtualized", "true");
      expect(screen.queryByRole("button", { name: "长列表会话 39" })).toBeNull();
      expect(screen.getByRole("button", { name: "长列表会话 0" })).toBeInTheDocument();
    } finally {
      if (proto) Object.defineProperty(HTMLElement.prototype, "clientHeight", proto);
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });
});

describe("Sidebar 归档与批量", () => {
  it("默认不显示已归档会话，展开「已归档」后出现", () => {
    const onLoadArchived = vi.fn();
    renderSidebar({
      sessions: [
        session({ id: "s-live", title: "进行中" }),
        session({ id: "s-arc", title: "已收进箱底", archived: true }),
      ],
      onLoadArchived,
    });
    expect(screen.getByRole("button", { name: "进行中" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已收进箱底" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已归档/ }));
    expect(onLoadArchived).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "已收进箱底" })).toBeInTheDocument();
  });

  it("会话更多菜单可归档，也可进入多选并批量操作", () => {
    const onArchive = vi.fn();
    const onBatch = vi.fn();
    renderSidebar({
      sessions: listSessions,
      onArchive,
      onBatch,
    });
    openSessionMenu("季度复盘 Alpha");
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive.mock.calls[0][0].id).toBe("s-alpha");

    openSessionMenu("Beta 上线检查");
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    expect(screen.getByTestId("sidebar-batch-bar")).toHaveTextContent("已选 1 条");
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    expect(onBatch).toHaveBeenCalledWith(["s-beta"], "archive", undefined);
  });
});

describe("Sidebar 模型徽标与摘要", () => {
  it("有 modelId 时显示短标签，有摘要时作为第二行", () => {
    renderSidebar({
      sessions: [
        session({
          id: "s-m",
          title: "带模型",
          modelId: "vendor/cool-model-v2",
          lastMessagePreview: "最后一句话写在这里",
        }),
      ],
      models: [{ id: "vendor/cool-model-v2", display_name: "Cool Model" }],
    });
    expect(screen.getByText("Cool Model")).toBeInTheDocument();
    expect(screen.getByText("最后一句话写在这里")).toBeInTheDocument();
  });

  it("modelShortLabel 回落 id 可读片段，不臆造映射表", () => {
    expect(modelShortLabel("acme/foo-bar")).toBe("foo-bar");
  });
});

describe("Sidebar 服务端搜索三态", () => {
  it("本地标题过滤立即生效，防抖后展示消息命中并高亮 snippet", async () => {
    const onSearchMessages = vi.fn(async () => [
      {
        sessionId: "s-hit",
        title: "命中会话",
        snippet: "包含关键词 beta 的一段",
        matchedAt: 1,
        kind: "message" as const,
      },
    ]);
    renderSidebar({ sessions: listSessions, onSearchMessages });
    fireEvent.change(screen.getByPlaceholderText("搜索会话"), { target: { value: "beta" } });
    expect(screen.getByRole("button", { name: "Beta 上线检查" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "季度复盘 Alpha" })).toBeNull();
    expect(screen.getByText("正在搜索消息…")).toBeInTheDocument();
    await waitFor(() => expect(onSearchMessages).toHaveBeenCalled());
    expect(screen.getByText("消息内容匹配")).toBeInTheDocument();
    expect(screen.getByText("命中会话")).toBeInTheDocument();
    const mark = screen.getByText("beta");
    expect(mark.tagName).toBe("MARK");
  });

  it("请求失败给出克制提示", async () => {
    const onSearchMessages = vi.fn(async () => {
      throw new Error("boom");
    });
    renderSidebar({ sessions: listSessions, onSearchMessages });
    fireEvent.change(screen.getByPlaceholderText("搜索会话"), { target: { value: "zzz-none" } });
    await waitFor(() => expect(screen.getByText("消息搜索失败")).toBeInTheDocument());
  });

  it("后续输入会 abort 上一次搜索", async () => {
    const seen: AbortSignal[] = [];
    const onSearchMessages = vi.fn(async (_q: string, signal: AbortSignal) => {
      seen.push(signal);
      await new Promise((r) => setTimeout(r, 80));
      return [];
    });
    renderSidebar({ sessions: listSessions, onSearchMessages });
    fireEvent.change(screen.getByPlaceholderText("搜索会话"), { target: { value: "al" } });
    await waitFor(() => expect(onSearchMessages).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText("搜索会话"), { target: { value: "alpha" } });
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe("Sidebar 未读", () => {
  it("未读会话标题加粗、行尾圆点，点击时 markRead", () => {
    const onMarkRead = vi.fn();
    const onSelect = vi.fn();
    renderSidebar({
      sessions: listSessions,
      unreadIds: new Set(["s-alpha"]),
      onMarkRead,
      onSelect,
    });
    const btn = screen.getByRole("button", { name: "季度复盘 Alpha" });
    expect(btn.querySelector(".font-semibold")).not.toBeNull();
    expect(screen.getByRole("img", { name: "未读" })).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onMarkRead).toHaveBeenCalledWith("s-alpha");
    expect(onSelect).toHaveBeenCalledWith("s-alpha");
  });
});

describe("Sidebar 项目排序", () => {
  it("项目更多菜单上移/下移回调 orderedIds", () => {
    const onReorderProjects = vi.fn();
    const projects = [
      project({ id: "p-a", name: "甲", sortOrder: 0 }),
      project({ id: "p-b", name: "乙", sortOrder: 1 }),
    ];
    renderSidebar({
      sessions: [],
      projects,
      onCreateProject: () => {},
      onReorderProjects,
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: "项目 甲 更多" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "下移" }));
    expect(onReorderProjects).toHaveBeenCalledWith(["p-b", "p-a"]);
  });
});

describe("HighlightedText", () => {
  it("不高亮时不使用 innerHTML", () => {
    const { container } = render(<HighlightedText text={"a <b> x"} query="b" />);
    expect(container.innerHTML).not.toContain("<b>");
    expect(container.querySelector("mark")?.textContent).toBe("b");
  });
});

