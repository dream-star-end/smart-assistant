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
