import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { Session, User } from "../lib/types";
import { Sidebar } from "./Sidebar";

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

describe("Sidebar 管理后台入口（平台超管）", () => {
  it("showAdmin=true 时渲染指向 /admin.html 的管理后台入口", () => {
    renderSidebar({ showAdmin: true });
    const link = screen.getByRole("link", { name: /管理后台/ });
    expect(link).toHaveAttribute("href", "/admin.html");
  });

  it("showAdmin 缺省时不渲染管理后台入口（非 admin / demo 一律隐藏）", () => {
    renderSidebar();
    expect(screen.queryByRole("link", { name: /管理后台/ })).toBeNull();
  });

  it("showAdmin=false 时不渲染管理后台入口", () => {
    renderSidebar({ showAdmin: false });
    expect(screen.queryByRole("link", { name: /管理后台/ })).toBeNull();
  });

  it("提供反馈回调时渲染直接入口并触发打开", () => {
    const onOpenFeedback = vi.fn();
    renderSidebar({ onOpenFeedback });
    fireEvent.click(screen.getByRole("button", { name: "反馈与帮助" }));
    expect(onOpenFeedback).toHaveBeenCalledTimes(1);
  });

  it("未提供反馈回调时不显示反馈入口", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: "反馈与帮助" })).toBeNull();
  });
});

describe("Sidebar 管理中心入口副标题", () => {
  it("无待办时展示与实际分区对齐的速览文案", () => {
    renderSidebar({ onOpenManage: () => {} });
    const entry = screen.getByRole("button", { name: /管理中心/ });
    expect(entry).toHaveTextContent("记忆 · 技能 · 定时 · 插件");
  });

  it("有待确认建议时改用数量徽章（Auto‑Dream 在侧栏的唯一曝光）", () => {
    renderSidebar({ onOpenManage: () => {}, optimizerPending: 3 });
    const entry = screen.getByRole("button", { name: /管理中心/ });
    expect(entry).toHaveTextContent("3 项待确认");
    expect(entry).not.toHaveTextContent("记忆 · 技能 · 定时 · 插件");
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

  it("活跃会话行有左侧 accent 竖条，且桌面行用 py-1.5；非活跃行无竖条、圆角同为 rounded-md", () => {
    renderSidebar({ sessions: listSessions, activeId: "s-beta" });
    const activeBtn = screen.getByRole("button", { name: "Beta 上线检查" });
    const activeRow = activeBtn.closest("div");
    expect(activeRow).toHaveClass("rounded-md", "bg-active");
    expect(activeRow?.querySelector(".bg-accent")).not.toBeNull();
    expect(activeBtn).toHaveClass("py-1.5");
    expect(activeBtn.className).toContain("[@media(hover:none)]:py-2");

    const idleBtn = screen.getByRole("button", { name: "季度复盘 Alpha" });
    const idleRow = idleBtn.closest("div");
    expect(idleRow).toHaveClass("rounded-md");
    expect(idleRow?.querySelector(".bg-accent")).toBeNull();
  });

  it("管理/市场入口权重低于「新建会话」：text-body + text-muted，新建保持 secondary 主按钮", () => {
    renderSidebar({
      onOpenManage: () => {},
      onOpenMarketplace: () => {},
      onOpenTutorial: () => {},
      onOpenOrg: () => {},
      showAdmin: true,
    });
    const create = screen.getByRole("button", { name: "新建会话" });
    expect(create).toHaveClass("text-section");
    expect(create.className).toMatch(/border-border/);
    expect(create.className).toMatch(/bg-surface/);
    const manage = screen.getByRole("button", { name: /管理中心/ });
    const market = screen.getByRole("button", { name: /^市场/ });
    expect(manage).toHaveClass("text-body", "text-muted", "py-1.5");
    expect(market).toHaveClass("text-body", "text-muted", "py-1.5");
    expect(screen.getByRole("button", { name: /使用教程/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /组织/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /管理后台/ })).toHaveAttribute("href", "/admin.html");
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
    // 每行一个「重命名」，按可见标题定位到 Beta 那一行的操作区。
    const betaRow = screen.getByRole("button", { name: "Beta 上线检查" }).closest("div");
    expect(betaRow).not.toBeNull();
    const renameBtn = Array.from(betaRow!.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "重命名",
    );
    expect(renameBtn).toBeTruthy();
    fireEvent.click(renameBtn!);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0][0].id).toBe("s-beta");
    // 误触发切换会话会把用户从当前会话踢走(操作区在行内，必须 stopPropagation)。
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("删除入口只对被点的那一条生效，且不顺带切换会话（不可逆操作）", () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    renderSidebar({ sessions: listSessions, onDelete, onSelect });
    const alphaRow = screen.getByRole("button", { name: "季度复盘 Alpha" }).closest("div");
    const deleteBtn = Array.from(alphaRow!.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "删除",
    );
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn!);
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
    expect(screen.getByText("暂无会话")).toBeInTheDocument();
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
