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
  { id: "gpt-6-astra", display_name: "GPT-6-Astra" },
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

  it("窄屏 chip 另有「团队」文案，桌面全称仍在 DOM", () => {
    renderHeader({ teamModeActive: true, onDisableTeamMode: () => {} });
    const chip = screen.getByRole("button", { name: "团队模式已开启" });
    expect(chip.textContent).toContain("团队");
    expect(chip.textContent).toContain("团队模式");
  });

  it("点击 chip 弹出说明（引擎 + 计费告知）与关闭按钮；点击关闭翻转 flag", async () => {
    const onDisableTeamMode = vi.fn();
    renderHeader({ teamModeActive: true, onDisableTeamMode });

    fireEvent.click(screen.getByRole("button", { name: "团队模式已开启" }));

    // 说明一句话:如实告知队长引擎与计费差异
    const note = await screen.findByText(/队长引擎为 GPT-6-Astra/);
    expect(note.textContent).toContain("计费高于默认模型");

    fireEvent.click(screen.getByRole("button", { name: "关闭团队模式" }));
    expect(onDisableTeamMode).toHaveBeenCalledTimes(1);
  });

  it("advisorModeActive=true 时渲染顾问模式 chip", () => {
    renderHeader({ advisorModeActive: true, onDisableAdvisorMode: () => {} });
    expect(screen.getByRole("button", { name: "顾问模式已开启" }).textContent).toContain("顾问模式");
  });

  it("顾问 chip 展示冻结型号，不改主模型选择器", () => {
    renderHeader({
      advisorModeActive: true,
      advisorModelLabel: "gpt-6-astra",
      onDisableAdvisorMode: () => {},
    });
    const chip = screen.getByRole("button", { name: "顾问模式已开启" });
    expect(chip.textContent).toContain("gpt-6-astra");
    fireEvent.click(chip);
    expect(screen.getByText(/本回合冻结顾问 gpt-6-astra/)).toBeInTheDocument();
    expect(screen.getByText(/不承诺更省/)).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("GLM-5.2");
    expect(trigger.textContent).not.toContain("团队模式 · GPT-6-Astra");
  });

  it("teamModeActive=true 时顶栏 ModelSelector 显示实际生效的队长引擎", () => {
    renderHeader({ teamModeActive: true, onDisableTeamMode: () => {} });
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("团队模式 · GPT-6-Astra");
    expect(trigger.textContent).not.toContain("GLM-5.2");
  });

  it("常态下 ModelSelector 仍显示用户自选模型", () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("GLM-5.2");
  });
});

describe("ChatHeader 会话未读角标", () => {
  const badgeLayoutClass =
    "pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white tabular-nums";

  it("无 sessionUnreadCount 时不渲染占位，打开菜单按钮仍在", () => {
    renderHeader({ onOpenMobileNav: () => {} });
    expect(screen.queryByTestId("session-unread-badge")).toBeNull();
    expect(screen.getByRole("button", { name: "打开菜单" })).toBeInTheDocument();
  });

  it("角标挂在「打开菜单」按钮上，类名与站内信角标一致", () => {
    renderHeader({ onOpenMobileNav: () => {}, onOpenInbox: () => {}, unreadCount: 2, sessionUnreadCount: 3 });
    const menu = screen.getByRole("button", { name: /打开菜单/ });
    const sessionBadge = menu.parentElement?.querySelector("[data-testid=session-unread-badge]");
    expect(sessionBadge).toHaveTextContent("3");
    expect(sessionBadge).toHaveClass(...badgeLayoutClass.split(" "));
    const inboxBtn = screen.getByRole("button", { name: "站内信" });
    const inboxBadge = inboxBtn.parentElement?.querySelector("span");
    expect(inboxBadge).toHaveTextContent("2");
    expect(inboxBadge).toHaveClass(...badgeLayoutClass.split(" "));
  });

  it("折叠态角标挂在「展开侧栏」按钮上", () => {
    renderHeader({
      sidebarCollapsed: true,
      onExpandSidebar: () => {},
      sessionUnreadCount: 4,
    });
    const expand = screen.getByRole("button", { name: /展开侧栏/ });
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

  it("会话未读角标用 accent，铃铛未读用 danger", () => {
    renderHeader({
      onOpenMobileNav: () => {},
      onOpenInbox: () => {},
      unreadCount: 2,
      sessionUnreadCount: 3,
    });
    expect(screen.getByTestId("session-unread-badge")).toHaveClass("bg-accent");
    const inboxBtn = screen.getByRole("button", { name: "站内信" });
    const inboxBadge = inboxBtn.parentElement?.querySelector("span");
    expect(inboxBadge).toHaveClass("bg-danger");
  });
});

describe("ChatHeader 会话内查找", () => {
  it("无 onOpenFind 时不渲染查找按钮", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "会话内查找" })).toBeNull();
  });

  it("有 onOpenFind 时渲染查找按钮且点击回调", () => {
    const onOpenFind = vi.fn();
    renderHeader({ onOpenFind });
    fireEvent.click(screen.getByRole("button", { name: "会话内查找" }));
    expect(onOpenFind).toHaveBeenCalledTimes(1);
  });
});

describe("ChatHeader 导出会话", () => {
  it("无 onExport 时不渲染导出按钮", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "导出会话" })).toBeNull();
  });

  it("有 onExport 时渲染导出按钮且点击回调", () => {
    const onExport = vi.fn();
    renderHeader({ onExport });
    fireEvent.click(screen.getByRole("button", { name: "导出会话" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});


describe("ChatHeader compact navigation", () => {
  it("keeps the agent accessible and groups the model independently of actions", () => {
    renderHeader({onOpenMobileNav: vi.fn(), onOpenInbox: vi.fn(), onOpenFind: vi.fn()});
    expect(screen.getByRole("button", {name: `切换智能体，当前${MAIN_AGENT.name}`})).toBeInTheDocument();
    const row = screen.getByTestId("chat-model-row");
    expect(row).toContainElement(screen.getByRole("button", {name: "选择对话模型"}));
    expect(row).not.toContainElement(screen.getByRole("button", {name: "会话内查找"}));
  });
});
