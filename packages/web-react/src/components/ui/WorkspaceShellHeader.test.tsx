import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { HeaderCountBadge, WorkspaceShellHeader } from "./WorkspaceShellHeader";

afterEach(cleanup);

describe("HeaderCountBadge（OCV5-820 6px 克制状态点）", () => {
  it("count 缺失或 ≤0 时不渲染", () => {
    const { container, rerender } = render(<HeaderCountBadge testId="dot" />);
    expect(container.firstChild).toBeNull();
    rerender(<HeaderCountBadge count={0} testId="dot" />);
    expect(container.firstChild).toBeNull();
    rerender(<HeaderCountBadge count={-3} testId="dot" />);
    expect(container.firstChild).toBeNull();
  });

  it("高计数（如 120 / 40）仅渲染 6px 实心点而非 99+ 数字泡泡，并保留 aria-label 与 data-unread-count", () => {
    const { rerender } = render(
      <HeaderCountBadge count={120} testId="dot" tone="accent" ariaLabel="120 条未读会话" />,
    );
    const accentDot = screen.getByTestId("dot");
    expect(accentDot).toHaveTextContent("");
    expect(accentDot).toHaveAttribute("aria-label", "120 条未读会话");
    expect(accentDot).toHaveAttribute("data-unread-count", "120");
    expect(accentDot).toHaveClass("size-1.5", "rounded-full", "bg-accent", "oc-alive-dot");
    expect(accentDot).not.toHaveClass("motion-safe:animate-pulse");

    rerender(
      <HeaderCountBadge count={40} testId="dot" tone="danger" ariaLabel="40 条未读站内信" />,
    );
    const dangerDot = screen.getByTestId("dot");
    expect(dangerDot).toHaveTextContent("");
    expect(dangerDot).toHaveAttribute("data-unread-count", "40");
    expect(dangerDot).toHaveClass("size-1.5", "rounded-full", "bg-danger");
    expect(dangerDot).not.toHaveClass("oc-alive-dot");
  });
});

describe("WorkspaceShellHeader", () => {
  it("移动端汉堡钮与桌面折叠展开钮均以 6px 呼吸点指示未读，同时保留完整无障碍计数与点击回调", () => {
    const onOpenMobileNav = vi.fn();
    const onExpandSidebar = vi.fn();
    render(
      <WorkspaceShellHeader
        onOpenMobileNav={onOpenMobileNav}
        sidebarCollapsed
        onExpandSidebar={onExpandSidebar}
        sessionUnreadCount={105}
      >
        <span>内容</span>
      </WorkspaceShellHeader>,
    );

    const mobileBtn = screen.getByRole("button", { name: "打开菜单,105 条未读会话" });
    expect(mobileBtn).toHaveAttribute("title", "打开菜单（105 条未读会话）");
    expect(mobileBtn.parentElement?.textContent).not.toContain("99+");
    fireEvent.click(mobileBtn);
    expect(onOpenMobileNav).toHaveBeenCalledTimes(1);

    const expandBtn = screen.getByRole("button", { name: "展开侧栏,105 条未读会话" });
    expect(expandBtn).toHaveAttribute("title", "展开侧栏（105 条未读会话）");
    expect(expandBtn.parentElement?.textContent).not.toContain("99+");
    fireEvent.click(expandBtn);
    expect(onExpandSidebar).toHaveBeenCalledTimes(1);

    const dots = screen.getAllByTestId("session-unread-badge");
    expect(dots).toHaveLength(2);
    for (const dot of dots) {
      expect(dot).toHaveTextContent("");
      expect(dot).toHaveClass("size-1.5", "bg-accent", "oc-alive-dot");
      expect(dot).not.toHaveClass("motion-safe:animate-pulse");
    }
  });
});
