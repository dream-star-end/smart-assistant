import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ChatProject, Session, User } from "../lib/types";
import { Sidebar } from "./Sidebar";
import { SESSION_ROW_HEIGHT, DEFAULT_PROJECT_ID, PROJECT_ROW_HEIGHT } from "./sidebar/constants";
import { flattenSidebarItems } from "./sidebar/flattenItems";
import { HighlightedText } from "./sidebar/highlight";

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

  it("无项目会话落入 default，组内按时间倒序平铺（不再套今天/昨天）", () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    renderSidebar({
      sessions: [
        session({ id: "s-today", title: "今天的会话" }),
        session({ id: "s-old", title: "很久以前的会话", updatedAt: old }),
      ],
    });
    expect(screen.getByRole("button", { name: /未分类/ })).toBeInTheDocument();
    expect(screen.queryByText("今天")).toBeNull();
    expect(screen.queryByText("更早")).toBeNull();
    expect(
      screen.getByRole("button", { name: "今天的会话" }).compareDocumentPosition(
        screen.getByRole("button", { name: "很久以前的会话" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("Sidebar 任务面板入口", () => {
  it("传入 onOpenBoard 时渲染入口，并用 data-product-control 标注", () => {
    const onOpenBoard = vi.fn();
    renderSidebar({ onOpenBoard, boardActive: true });
    const btn = screen.getByRole("button", { name: "任务" });
    expect(btn).toHaveAttribute("data-product-control");
    expect(btn).toHaveAttribute("aria-current", "true");
    expect(btn).not.toHaveTextContent("看板");
    fireEvent.click(btn);
    expect(onOpenBoard).toHaveBeenCalled();
  });

  it("省略 onOpenBoard 时不渲染入口（demo）", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: /任务/ })).toBeNull();
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

  it("真实项目在前、default 固定在后；未分组会话在 default 下且不套时间分组", () => {
    renderSidebar({
      sessions: projectSessions,
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
    });
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("工作")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目里的会话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "未分组会话" })).toBeInTheDocument();
    expect(screen.queryByText("今天")).toBeNull();
    const workBtn = screen.getByRole("button", { name: /工作/ });
    const defaultBtn = screen.getByRole("button", { name: /未分类/ });
    expect(workBtn).toHaveAttribute("aria-expanded", "true");
    expect(
      workBtn.compareDocumentPosition(defaultBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: /未分类/ })).toBeNull();
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

  it("项目行提供在项目内新建会话入口，点击以项目 id 回调", () => {
    const onNewInProject = vi.fn();
    renderSidebar({
      sessions: projectSessions,
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
      onNewInProject,
    });
    fireEvent.click(screen.getByRole("button", { name: "在 工作 新建会话" }));
    expect(onNewInProject).toHaveBeenCalledTimes(1);
    expect(onNewInProject).toHaveBeenCalledWith("p-work");
  });

  it("项目菜单第一项为新建会话，点击同样以项目 id 回调", async () => {
    const onNewInProject = vi.fn();
    renderSidebar({
      sessions: projectSessions,
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
      onRenameProject: () => {},
      onNewInProject,
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: "项目 工作 更多" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const item = await screen.findByRole("menuitem", { name: "新建会话" });
    fireEvent.click(item);
    expect(onNewInProject).toHaveBeenCalledWith("p-work");
  });

  it("default 未分类组不提供项目内新建入口（顶部「新建会话」已覆盖）", () => {
    const onNewInProject = vi.fn();
    renderSidebar({
      sessions: [session({ id: "s-out", title: "未分组会话" })],
      projects: [],
      onCreateProject: () => {},
      onNewInProject,
    });
    expect(screen.queryByRole("button", { name: "在 未分类 新建会话" })).toBeNull();
  });

  it("无真实项目时仍渲染 default；default 不可重命名、删除、改色或排序", () => {
    renderSidebar({
      sessions: [],
      projects: [],
      onCreateProject: () => {},
      onRenameProject: () => {},
      onDeleteProject: () => {},
      onOpenProjectSettings: () => {},
      onReorderProjects: () => {},
    });
    expect(screen.queryByText("还没有项目")).toBeNull();
    expect(screen.getByRole("button", { name: /未分类/ })).toBeInTheDocument();
    expect(screen.getByText("暂无会话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "项目 未分类 更多" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "重命名" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "删除" })).toBeNull();
  });

  it("default 组菜单只有「项目资产」一项", async () => {
    const onOpenProjectAssets = vi.fn();
    renderSidebar({
      sessions: [],
      projects: [],
      onCreateProject: () => {},
      onRenameProject: () => {},
      onDeleteProject: () => {},
      onOpenProjectSettings: () => {},
      onOpenProjectAssets,
      onReorderProjects: () => {},
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: "项目 未分类 更多" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "项目资产" })).toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: "项目设置" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "重命名" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "删除" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "上移" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "下移" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "项目资产" }));
    expect(onOpenProjectAssets).toHaveBeenCalledWith(null);
  });

  it("default 可折叠，toggle 走与真实项目相同的 collapsedProjectIds 通道", () => {
    const onToggle = vi.fn();
    renderSidebar({
      sessions: [session({ id: "s-out", title: "未分组会话" })],
      projects: [],
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: onToggle,
      onCreateProject: () => {},
    });
    fireEvent.click(screen.getByRole("button", { name: /未分类/ }));
    expect(onToggle).toHaveBeenCalledWith(DEFAULT_PROJECT_ID);
  });

  it("拖到 default 行即移出项目（projectId 为 null）", () => {
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
    const row = screen.getByRole("button", { name: "项目里的会话" }).closest("div")!;
    fireEvent.dragStart(row, { dataTransfer: dt });
    const defaultRow = screen.getByRole("button", { name: /未分类/ }).closest("div")!;
    fireEvent.dragOver(defaultRow, { dataTransfer: dt });
    fireEvent.drop(defaultRow, { dataTransfer: dt });
    expect(onMoveToProject).toHaveBeenCalledTimes(1);
    expect(onMoveToProject.mock.calls[0][0].id).toBe("s-in");
    expect(onMoveToProject.mock.calls[0][1]).toBeNull();
  });
});

function leadImgs(title: string): HTMLElement[] {
  const btn = screen.getByRole("button", { name: title });
  const row = btn.closest("div")!;
  return Array.from(row.querySelectorAll("[role=img]"));
}

describe("Sidebar 会话状态点", () => {
  it("四种状态各自渲染唯一一个点且位置在标题左；已读完成不占可见点", () => {
    renderSidebar({
      sessions: [
        session({ id: "s-run", title: "正在跑", runState: "running" }),
        session({ id: "s-ok", title: "已跑完", lastOutcome: "completed" }),
        session({ id: "s-unread", title: "未读完成", lastOutcome: "completed" }),
        session({ id: "s-err", title: "崩了", lastOutcome: "crashed" }),
        session({ id: "s-rst", title: "被重启", lastOutcome: "crashed", lastErrorCode: "SERVICE_RESTART" }),
        session({ id: "s-new", title: "从没跑过", lastOutcome: null }),
      ],
      unreadIds: new Set(["s-unread", "s-err"]),
      isSending: (id) => id === "s-run",
    });

    const runImgs = leadImgs("正在跑");
    expect(runImgs).toHaveLength(1);
    expect(runImgs[0]).toHaveClass("bg-info", "oc-session-running");
    expect(runImgs[0]).toHaveAccessibleName("运行中");
    expect(
      runImgs[0]!.compareDocumentPosition(screen.getByRole("button", { name: "正在跑" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(leadImgs("已跑完")).toHaveLength(0);
    expect(screen.queryByRole("img", { name: "已完成" })).toBeNull();
    expect(screen.queryByRole("img", { name: "已中断" })).toBeNull();

    const unreadImgs = leadImgs("未读完成");
    expect(unreadImgs).toHaveLength(1);
    expect(unreadImgs[0]).toHaveClass("bg-success");
    expect(unreadImgs[0]).toHaveAccessibleName("未读");
    expect(screen.getAllByRole("img", { name: "未读" })).toHaveLength(1);

    const errImgs = leadImgs("崩了");
    expect(errImgs).toHaveLength(1);
    expect(errImgs[0]).toHaveClass("bg-danger");
    expect(errImgs[0]).toHaveAccessibleName("出错");

    const rstImgs = leadImgs("被重启");
    expect(rstImgs).toHaveLength(1);
    expect(rstImgs[0]).toHaveClass("bg-warning");
    expect(rstImgs[0]).toHaveAccessibleName("服务重启中断，可继续");

    const idleRow = screen.getByRole("button", { name: "从没跑过" }).closest("div")!;
    expect(idleRow.querySelector("[data-session-lead]")).not.toBeNull();
    expect(idleRow.querySelector("[role=img]")).toBeNull();
  });

  it("已读后绿点立即消失；红点不因已读消失", () => {
    const sessions = [
      session({ id: "s-unread", title: "未读完成", lastOutcome: "completed" }),
      session({ id: "s-err", title: "崩了", lastOutcome: "crashed" }),
    ];
    const { rerender } = renderSidebar({
      sessions,
      unreadIds: new Set(["s-unread", "s-err"]),
    });
    expect(screen.getByRole("img", { name: "未读" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "出错" })).toBeInTheDocument();
    rerender(
      <Sidebar
        sessions={sessions}
        user={user}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        unreadIds={new Set()}
      />,
    );
    expect(screen.queryByRole("img", { name: "未读" })).toBeNull();
    expect(screen.getByRole("img", { name: "出错" })).toBeInTheDocument();
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
  it("置顶会话集中显示在最上方「置顶」分组，不进入 default", () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    renderSidebar({
      sessions: [
        session({ id: "s-pin", title: "钉住的", pinned: true, updatedAt: old }),
        session({ id: "s-today", title: "今天的" }),
      ],
      onTogglePin: () => {},
    });
    expect(screen.getByText("置顶")).toBeInTheDocument();
    const pinHeading = screen.getByText("置顶");
    const defaultBtn = screen.getByRole("button", { name: /未分类/ });
    expect(
      pinHeading.compareDocumentPosition(screen.getByRole("button", { name: "钉住的" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(pinHeading.compareDocumentPosition(defaultBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(collapsed.some((i) => i.kind === "project" && i.collapsed && i.project.id === "p-work")).toBe(
      true,
    );
    expect(collapsed.some((i) => i.kind === "project" && i.project.id === DEFAULT_PROJECT_ID)).toBe(true);
    expect(collapsed.some((i) => i.kind === "header" && i.label === "今天")).toBe(false);
    expect(collapsed.some((i) => i.kind === "session" && i.session.id === "s-out")).toBe(true);

    const defaultClosed = flattenSidebarItems({
      searching: false,
      showProjects: true,
      pinned: [],
      projects: [proj],
      projectSessions: new Map([["p-work", [inProj]]]),
      sessions: [inProj, out],
      ungroupedGroups: [["今天", [out]]],
      collapsedProjectIds: new Set([DEFAULT_PROJECT_ID]),
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
    });
    expect(defaultClosed.some((i) => i.kind === "session" && i.session.id === "s-out")).toBe(false);
    expect(defaultClosed.some((i) => i.kind === "session" && i.session.id === "s-in")).toBe(true);

    const open = flattenSidebarItems({
      searching: false,
      showProjects: true,
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
    const projectIds = open.filter((i) => i.kind === "project").map((i) =>
      i.kind === "project" ? i.project.id : "",
    );
    expect(projectIds).toEqual(["p-work", DEFAULT_PROJECT_ID]);
  });

  it("折叠项目行带 runningCount，行高仍是项目行高；展开会话不重复出现", () => {
    const proj = project({ id: "p-work", name: "工作" });
    const runA = session({ id: "s-run-a", title: "跑着 A", projectId: "p-work", runState: "running" });
    const runB = session({ id: "s-run-b", title: "跑着 B", projectId: "p-work", runState: "running" });
    const idle = session({ id: "s-idle", title: "空闲", projectId: "p-work" });
    const isRunning = (s: Session) => s.runState === "running";
    const collapsed = flattenSidebarItems({
      searching: false,
      showProjects: true,
      pinned: [],
      projects: [proj],
      projectSessions: new Map([["p-work", [runA, runB, idle]]]),
      sessions: [runA, runB, idle],
      ungroupedGroups: [],
      collapsedProjectIds: new Set(["p-work"]),
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
      isRunning,
    });
    const row = collapsed.find((i) => i.kind === "project" && i.project.id === "p-work");
    expect(row).toMatchObject({
      kind: "project",
      collapsed: true,
      runningCount: 2,
      height: PROJECT_ROW_HEIGHT,
    });
    expect(collapsed.some((i) => i.kind === "session")).toBe(false);

    const expanded = flattenSidebarItems({
      searching: false,
      showProjects: true,
      pinned: [],
      projects: [proj],
      projectSessions: new Map([["p-work", [runA, runB, idle]]]),
      sessions: [runA, runB, idle],
      ungroupedGroups: [],
      collapsedProjectIds: new Set(),
      archived: [],
      archivedExpanded: false,
      searchHits: [],
      searchRemote: "idle",
      localEmpty: false,
      isRunning,
    });
    const openRow = expanded.find((i) => i.kind === "project" && i.project.id === "p-work");
    expect(openRow).toMatchObject({ kind: "project", collapsed: false, runningCount: 2 });
    const sessionIds = expanded.filter((i) => i.kind === "session").map((i) =>
      i.kind === "session" ? i.session.id : "",
    );
    expect(sessionIds).toEqual(["s-run-a", "s-run-b", "s-idle"]);
  });


  it("置顶分组在项目与时间分组之前；搜索时不拍项目行", () => {
    const pin = session({ id: "s-pin", title: "钉住的", pinned: true });
    const items = flattenSidebarItems({
      searching: true,
      showProjects: true,
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

  it("后端即使带摘要，会话行仍保持单行高度", () => {
    const s = session({ id: "s1", title: "有摘要", lastMessagePreview: "hello" });
    const items = flattenSidebarItems({
      searching: false,
      showProjects: false,
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
    expect(rows.every((r) => r.height === SESSION_ROW_HEIGHT)).toBe(true);
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
      const mounted = screen.queryAllByRole("button", { name: /^长列表会话 / });
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(many.length);
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
    const toggle = screen.getByRole("button", { name: /已归档/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(onLoadArchived).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(onLoadArchived).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
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

  it("搜索行常驻「多选」，不依赖行 hover，移动端也能进多选", () => {
    const onBatch = vi.fn();
    renderSidebar({ sessions: listSessions, onBatch });
    const chrome = document.querySelector("[data-product-entry-scope='sidebar-primary']");
    expect(chrome).not.toBeNull();
    expect(
      Array.from(chrome!.querySelectorAll("span,button")).some((el) => el.textContent?.trim() === "会话"),
    ).toBe(false);
    const entry = screen.getByRole("button", { name: "多选" });
    expect(entry).toBeVisible();
    expect(chrome!.contains(entry)).toBe(true);
    expect(chrome!.contains(screen.getByPlaceholderText("搜索会话"))).toBe(true);
    fireEvent.click(entry);
    expect(screen.getByTestId("sidebar-batch-bar")).toHaveTextContent("已选 0 条");
    expect(screen.getByLabelText("选择 季度复盘 Alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("选择 Beta 上线检查"));
    expect(screen.getByTestId("sidebar-batch-bar")).toHaveTextContent("已选 1 条");
  });

  it("非多选模式会话行完全不出现复选框", () => {
    renderSidebar({ sessions: listSessions, onBatch: () => {} });
    expect(screen.queryByLabelText("选择 季度复盘 Alpha")).toBeNull();
    expect(screen.queryByLabelText("选择 Beta 上线检查")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("Sidebar 会话累计用时与单行布局", () => {
  it("不显示最新消息摘要；右侧展示 createdAt → lastAt 的累计用时", () => {
    const endAt = Date.now() - 5 * 60_000;
    const createdAt = endAt - 10 * 60_000;
    renderSidebar({
      sessions: [
        session({
          id: "s-m",
          title: "带模型",
          modelId: "vendor/cool-model-v2",
          createdAt,
          lastAt: endAt,
          lastMessagePreview: "最后一句话写在这里",
        }),
      ],
    });
    expect(screen.queryByText("Cool Model")).toBeNull();
    expect(screen.queryByText(/cool-model/i)).toBeNull();
    expect(screen.queryByText("最后一句话写在这里")).toBeNull();
    const duration = screen
      .getByRole("button", { name: "带模型" })
      .closest("div")!
      .querySelector("[data-session-duration]");
    expect(duration).toHaveTextContent("10m");
    expect(duration).toHaveAttribute("title", expect.stringContaining("→"));
  });

  it("累计用时按分 / 小时 / 天展示，不再表示距今多久", () => {
    const endAt = Date.now() - 7 * 24 * 60 * 60_000;
    renderSidebar({
      sessions: [
        session({ id: "s-sec", title: "不足一分钟", createdAt: endAt - 10_000, lastAt: endAt }),
        session({ id: "s-min", title: "五分钟", createdAt: endAt - 5 * 60_000, lastAt: endAt }),
        session({ id: "s-hr", title: "两小时", createdAt: endAt - 2 * 60 * 60_000, lastAt: endAt }),
        session({ id: "s-day", title: "三天", createdAt: endAt - 3 * 24 * 60 * 60_000, lastAt: endAt }),
      ],
    });
    const duration = (title: string) =>
      screen.getByRole("button", { name: title }).closest("div")!.querySelector("[data-session-duration]");
    expect(duration("不足一分钟")).toHaveTextContent("1m");
    expect(duration("五分钟")).toHaveTextContent("5m");
    expect(duration("两小时")).toHaveTextContent("2h");
    expect(duration("三天")).toHaveTextContent("3d");
  });

  it("运行中的会话从会话创建时刻累计到现在", () => {
    const now = Date.now();
    renderSidebar({
      sessions: [
        session({
          id: "s-running-duration",
          title: "正在运行",
          createdAt: now - 2 * 60 * 60_000,
          lastAt: now - 60 * 60_000,
          runState: "running",
        }),
      ],
    });
    const duration = screen
      .getByRole("button", { name: "正在运行" })
      .closest("div")!
      .querySelector("[data-session-duration]");
    expect(duration).toHaveTextContent("2h");
    expect(duration).toHaveAttribute("title", expect.stringContaining("现在"));
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
  it("未读会话标题加粗、标题左侧唯一绿点，点击时 markRead", () => {
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
    const dots = leadImgs("季度复盘 Alpha");
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAccessibleName("未读");
    expect(dots[0]!.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

function sessionTitlesInList(): string[] {
  return [...document.querySelectorAll("[data-flat-kind='session']")].map((row) => {
    const btn = row.querySelector("button[aria-label]");
    return btn?.getAttribute("aria-label") ?? "";
  });
}

function projectNamesInList(): string[] {
  return [...document.querySelectorAll("[data-flat-kind='project']")].map((row) => {
    const name = row.querySelector("button span.min-w-0");
    return name?.textContent?.trim() ?? "";
  });
}

function iso(hour: number): string {
  return new Date(Date.UTC(2026, 7, 20, hour)).toISOString();
}

describe("Sidebar 运行中置顶", () => {
  it("组内运行中排最前，多个运行中仍按更新时间倒序，空闲保持时间倒序", () => {
    renderSidebar({
      sessions: [
        session({ id: "idle-new", title: "最新空闲", updatedAt: iso(12) }),
        session({ id: "run-old", title: "较早运行", updatedAt: iso(10), runState: "running" }),
        session({ id: "idle-old", title: "更早空闲", updatedAt: iso(9) }),
        session({ id: "run-new", title: "较新运行", updatedAt: iso(11), runState: "running" }),
      ],
    });
    expect(sessionTitlesInList()).toEqual(["较新运行", "较早运行", "最新空闲", "更早空闲"]);
    expect(screen.getAllByRole("button", { name: "较新运行" })).toHaveLength(1);
  });

  it("置顶组同样：运行中置顶，跑完后回落到按时间该在的位置", () => {
    const sessions = [
      session({ id: "pin-idle", title: "钉住的新", pinned: true, updatedAt: iso(12) }),
      session({ id: "pin-run", title: "钉住的跑", pinned: true, updatedAt: iso(10), runState: "running" }),
    ];
    const { rerender } = renderSidebar({ sessions, onTogglePin: () => {} });
    expect(sessionTitlesInList()).toEqual(["钉住的跑", "钉住的新"]);

    rerender(
      <Sidebar
        sessions={[
          session({ id: "pin-idle", title: "钉住的新", pinned: true, updatedAt: iso(12) }),
          session({ id: "pin-run", title: "钉住的跑", pinned: true, updatedAt: iso(10), runState: "idle" }),
        ]}
        user={user}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onTogglePin={() => {}}
      />,
    );
    expect(sessionTitlesInList()).toEqual(["钉住的新", "钉住的跑"]);
  });

  it("含运行会话的真实项目上浮，default 即使有运行中也仍在所有真实项目之后", () => {
    const projects = [
      project({ id: "p-a", name: "甲", sortOrder: 0 }),
      project({ id: "p-b", name: "乙", sortOrder: 1 }),
    ];
    renderSidebar({
      sessions: [
        session({ id: "s-a", title: "甲的空闲", projectId: "p-a", updatedAt: iso(12) }),
        session({ id: "s-b", title: "乙的运行", projectId: "p-b", updatedAt: iso(8), runState: "running" }),
        session({ id: "s-d", title: "default 运行", updatedAt: iso(20), runState: "running" }),
      ],
      projects,
      collapsedProjectIds: new Set(),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
    });
    expect(projectNamesInList()).toEqual(["乙", "甲", "未分类"]);
    expect(sessionTitlesInList()).toEqual(["乙的运行", "甲的空闲", "default 运行"]);
  });

  it("折叠项目行显示同款闪烁蓝点与运行中数量；展开后提示消失、会话点仍在", () => {
    const projects = [project({ id: "p-work", name: "工作", sessionCount: 3 })];
    const sessions = [
      session({ id: "s-run-a", title: "跑着 A", projectId: "p-work", updatedAt: iso(11), runState: "running" }),
      session({ id: "s-run-b", title: "跑着 B", projectId: "p-work", updatedAt: iso(10), runState: "running" }),
      session({ id: "s-idle", title: "空闲", projectId: "p-work", updatedAt: iso(12) }),
    ];
    const { rerender } = renderSidebar({
      sessions,
      projects,
      collapsedProjectIds: new Set(["p-work"]),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
    });
    expect(screen.queryByRole("button", { name: "跑着 A" })).toBeNull();
    const collapsedBtn = screen.getByRole("button", { name: /工作/ });
    expect(collapsedBtn.querySelector("[data-project-running='2']")).not.toBeNull();
    expect(collapsedBtn.querySelector("[data-project-running='2']")).toHaveTextContent("2");
    const collapsedDot = collapsedBtn.querySelector("[role='img']");
    expect(collapsedDot).toHaveAccessibleName("运行中");
    expect(collapsedDot).toHaveClass("bg-info", "oc-session-running");

    rerender(
      <Sidebar
        sessions={sessions}
        user={user}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        projects={projects}
        collapsedProjectIds={new Set()}
        onToggleProjectCollapsed={() => {}}
        onCreateProject={() => {}}
      />,
    );
    const expandedBtn = screen.getByRole("button", { name: /工作/ });
    expect(expandedBtn.querySelector("[data-project-running]")).toBeNull();
    expect(screen.getByRole("button", { name: "跑着 A" })).toBeInTheDocument();
    expect(leadImgs("跑着 A")[0]).toHaveClass("bg-info", "oc-session-running");
    expect(sessionTitlesInList()).toEqual(["跑着 A", "跑着 B", "空闲"]);
  });

  it("折叠的 default 组有运行中时同样给出蓝点与数量", () => {
    renderSidebar({
      sessions: [
        session({ id: "s-run", title: "default 跑", runState: "running" }),
        session({ id: "s-idle", title: "default 闲" }),
      ],
      projects: [],
      collapsedProjectIds: new Set([DEFAULT_PROJECT_ID]),
      onToggleProjectCollapsed: () => {},
      onCreateProject: () => {},
    });
    const btn = screen.getByRole("button", { name: /未分类/ });
    expect(btn.querySelector("[data-project-running='1']")).not.toBeNull();
    expect(btn.querySelector("[role='img']")).toHaveAccessibleName("运行中");
    expect(screen.queryByRole("button", { name: "default 跑" })).toBeNull();
  });

  it("会话结束后回落到按更新时间该在的位置；isSending 变化立刻重排", () => {
    const olderRunning = session({
      id: "s-old",
      title: "较早那条",
      updatedAt: iso(10),
      runState: "running",
    });
    const newerIdle = session({ id: "s-new", title: "较新空闲", updatedAt: iso(12) });
    const { rerender } = renderSidebar({ sessions: [olderRunning, newerIdle] });
    expect(sessionTitlesInList()).toEqual(["较早那条", "较新空闲"]);

    rerender(
      <Sidebar
        sessions={[
          { ...olderRunning, runState: "idle", lastOutcome: "completed" },
          newerIdle,
        ]}
        user={user}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(sessionTitlesInList()).toEqual(["较新空闲", "较早那条"]);

    rerender(
      <Sidebar
        sessions={[
          { ...olderRunning, runState: "idle", lastOutcome: "completed" },
          newerIdle,
        ]}
        user={user}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        isSending={(id) => id === "s-old"}
        socketVersion={2}
      />,
    );
    expect(sessionTitlesInList()).toEqual(["较早那条", "较新空闲"]);
  });
});


describe("HighlightedText", () => {
  it("不高亮时不使用 innerHTML", () => {
    const { container } = render(<HighlightedText text={"a <b> x"} query="b" />);
    expect(container.innerHTML).not.toContain("<b>");
    expect(container.querySelector("mark")?.textContent).toBe("b");
  });
});
