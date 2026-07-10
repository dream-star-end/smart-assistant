import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
