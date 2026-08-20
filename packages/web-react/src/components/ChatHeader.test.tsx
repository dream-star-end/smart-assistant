import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { MAIN_AGENT } from "../lib/agents";
import type { PublicModel } from "../lib/types";
import { ChatHeader } from "./ChatHeader";

// 本仓 vitest 未开 globals 自动 cleanup,显式隔离每个用例的 DOM。
afterEach(cleanup);

const MODELS: PublicModel[] = [
  { id: "glm-5.2", display_name: "GLM-5.2" },
  { id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
];

function renderHeader(extra: Partial<Parameters<typeof ChatHeader>[0]> = {}) {
  return render(
    <ChatHeader
      agent={MAIN_AGENT}
      onAgentClick={() => {}}
      models={MODELS}
      selectedModelId="glm-5.2"
      onSelectModel={() => {}}
      {...extra}
    />,
  );
}

describe("ChatHeader 团队模式指示 chip", () => {
  it("teamModeActive=false 时不渲染 chip", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "团队模式已开启" })).toBeNull();
  });

  it("teamModeActive=true 时 agent 名旁渲染「团队模式」chip", () => {
    renderHeader({ teamModeActive: true, onDisableTeamMode: () => {} });
    const chip = screen.getByRole("button", { name: "团队模式已开启" });
    expect(chip.textContent).toContain("团队模式");
  });

  it("点击 chip 弹出说明（引擎 + 计费告知）与关闭按钮；点击关闭翻转 flag", async () => {
    const onDisableTeamMode = vi.fn();
    renderHeader({ teamModeActive: true, onDisableTeamMode });

    fireEvent.click(screen.getByRole("button", { name: "团队模式已开启" }));

    // 说明一句话:如实告知队长引擎与计费差异
    const note = await screen.findByText(/队长引擎为 GPT-5\.6-Sol/);
    expect(note.textContent).toContain("计费高于默认模型");

    fireEvent.click(screen.getByRole("button", { name: "关闭团队模式" }));
    expect(onDisableTeamMode).toHaveBeenCalledTimes(1);
  });

  it("teamModeActive=true 时顶栏 ModelSelector 显示实际生效的队长引擎", () => {
    renderHeader({ teamModeActive: true, onDisableTeamMode: () => {} });
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("团队模式 · GPT-5.6-Sol");
    expect(trigger.textContent).not.toContain("GLM-5.2");
  });

  it("常态下 ModelSelector 仍显示用户自选模型", () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("GLM-5.2");
  });
});

describe("ChatHeader 会话未读角标", () => {
  const badgeClass =
    "pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white tabular-nums";

  it("无 sessionUnreadCount 时不渲染占位，打开菜单按钮仍在", () => {
    renderHeader({ onOpenMobileNav: () => {} });
    expect(screen.queryByTestId("session-unread-badge")).toBeNull();
    expect(screen.getByRole("button", { name: "打开菜单" })).toBeInTheDocument();
  });

  it("角标挂在「打开菜单」按钮上，类名与站内信角标一致", () => {
    renderHeader({ onOpenMobileNav: () => {}, onOpenInbox: () => {}, unreadCount: 2, sessionUnreadCount: 3 });
    const menu = screen.getByRole("button", { name: "打开菜单" });
    const sessionBadge = menu.parentElement?.querySelector("[data-testid=session-unread-badge]");
    expect(sessionBadge).toHaveTextContent("3");
    expect(sessionBadge).toHaveClass(...badgeClass.split(" "));
    const inboxBtn = screen.getByRole("button", { name: "站内信" });
    const inboxBadge = inboxBtn.parentElement?.querySelector("span");
    expect(inboxBadge).toHaveTextContent("2");
    expect(inboxBadge).toHaveClass(...badgeClass.split(" "));
  });

  it("折叠态角标挂在「展开侧栏」按钮上", () => {
    renderHeader({
      sidebarCollapsed: true,
      onExpandSidebar: () => {},
      sessionUnreadCount: 4,
    });
    const expand = screen.getByRole("button", { name: "展开侧栏" });
    const badge = expand.parentElement?.querySelector("[data-testid=session-unread-badge]");
    expect(badge).toHaveTextContent("4");
  });

  it("会话未读与站内信未读并存且互不影响", () => {
    renderHeader({
      onOpenMobileNav: () => {},
      onOpenInbox: () => {},
      unreadCount: 7,
      sessionUnreadCount: 1,
    });
    expect(screen.getByTestId("session-unread-badge")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "站内信" }).parentElement).toHaveTextContent("7");
  });
});
