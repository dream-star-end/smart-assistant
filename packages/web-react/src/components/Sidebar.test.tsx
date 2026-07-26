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
