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
    expect(accentDot).toHaveClass("size-1.5", "rounded-full", "bg-accent");
    expect(accentDot).not.toHaveClass("oc-alive-dot");
    expect(accentDot).not.toHaveClass("motion-safe:animate-pulse");

    rerender(
      <HeaderCountBadge count={12} testId="dot" tone="success" ariaLabel="12 条未读会话" />,
    );
    const successDot = screen.getByTestId("dot");
    expect(successDot).toHaveTextContent("");
    expect(successDot).toHaveAttribute("aria-label", "12 条未读会话");
    expect(successDot).toHaveAttribute("data-unread-count", "12");
    expect(successDot).toHaveClass("size-1.5", "rounded-full", "bg-success");
    expect(successDot).not.toHaveClass("oc-alive-dot");

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
      expect(dot).toHaveClass("size-1.5", "bg-success");
      expect(dot).not.toHaveClass("oc-alive-dot");
      expect(dot).not.toHaveClass("motion-safe:animate-pulse");
    }
  });

  it("mobileLeftExtra 落在 md:hidden 左组紧邻汉堡钮，与桌面 md:flex 折叠左组严格互斥", () => {
    const onMobileAction = vi.fn();
    const onDesktopAction = vi.fn();
    render(
      <WorkspaceShellHeader
        onOpenMobileNav={vi.fn()}
        mobileLeftExtra={
          <button type="button" data-testid="mobile-extra" onClick={onMobileAction}>
            移动新建
          </button>
        }
        sidebarCollapsed
        onExpandSidebar={vi.fn()}
        collapsedExtra={
          <button type="button" data-testid="desktop-extra" onClick={onDesktopAction}>
            桌面新建
          </button>
        }
      >
        <span>内容</span>
      </WorkspaceShellHeader>,
    );

    const mobileLeft = screen.getByTestId("shell-mobile-left");
    const collapsedLeft = screen.getByTestId("shell-collapsed-left");
    expect(mobileLeft).toHaveClass("md:hidden");
    expect(collapsedLeft).toHaveClass("hidden", "md:flex");
    expect(mobileLeft).toContainElement(screen.getByTestId("mobile-extra"));
    expect(collapsedLeft).toContainElement(screen.getByTestId("desktop-extra"));

    fireEvent.click(screen.getByTestId("mobile-extra"));
    expect(onMobileAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("desktop-extra"));
    expect(onDesktopAction).toHaveBeenCalledTimes(1);
  });

  it("updateAvailable + onReloadForUpdate 不再渲染常驻全宽新版本通栏（依赖后台无感软刷）", () => {
    const onReload = vi.fn();
    render(
      <WorkspaceShellHeader updateAvailable onReloadForUpdate={onReload}>
        <span>内容</span>
      </WorkspaceShellHeader>,
    );
    expect(screen.queryByTestId("shell-update-banner")).toBeNull();
    expect(screen.queryByTestId("update-pill")).toBeNull();
    expect(onReload).not.toHaveBeenCalled();
  });
});
