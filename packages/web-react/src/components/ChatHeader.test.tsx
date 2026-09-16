import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { MAIN_AGENT } from "../lib/agents";
import type { PublicModel } from "../lib/types";
import { ChatHeader, modKeyLabel } from "./ChatHeader";

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
    expect(trigger.textContent).not.toContain("GPT-6-Astra");
  });

  it("teamModeActive=true 时顶栏 ModelSelector 显示实际生效的队长引擎(chip 表达团队模式,trigger 不再重复该词)", () => {
    renderHeader({ teamModeActive: true, onDisableTeamMode: () => {} });
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    // C-25:「顶栏所见 = 实际所发」—— 引擎名必须在 trigger 上;「团队模式」一词只由 chip 承担。
    expect(trigger.textContent).toContain("队长引擎 · GPT-6-Astra");
    expect(trigger.textContent).not.toContain("团队模式");
    expect(trigger.textContent).not.toContain("GLM-5.2");
    expect(screen.getByRole("button", { name: "团队模式已开启" })).toBeInTheDocument();
  });

  it("常态下 ModelSelector 仍显示用户自选模型", () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("GLM-5.2");
  });
});

describe("ChatHeader 会话未读角标", () => {
  // 前景不写死 text-white:深色 accent/danger 是浅色底,白字只有 2.8/3.1:1,走 -fg token(a11y shell#1/#11)。
  const badgeLayoutClass =
    "pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums";

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
    expect(sessionBadge).toHaveClass("bg-accent", "text-accent-fg");
    expect(sessionBadge).not.toHaveClass("text-white");
    const inboxBtn = screen.getByRole("button", { name: "站内信" });
    const inboxBadge = inboxBtn.parentElement?.querySelector("span");
    expect(inboxBadge).toHaveTextContent("2");
    expect(inboxBadge).toHaveClass(...badgeLayoutClass.split(" "));
    expect(inboxBadge).toHaveClass("bg-danger", "text-danger-fg");
    expect(inboxBadge).not.toHaveClass("text-white");
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

  // C-12:窄屏导出键 hidden sm:flex 直接消失且无溢出菜单承接。
  it("窄屏「更多操作」菜单承接导出(桌面键 hidden sm:flex,菜单 sm:hidden),菜单项调用 onExport", async () => {
    const onExport = vi.fn();
    renderHeader({ onExport });
    expect(screen.getByRole("button", { name: "导出会话" })).toHaveClass("hidden", "sm:flex");
    const more = screen.getByRole("button", { name: "更多操作" });
    expect(more.parentElement).toHaveClass("sm:hidden");
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(more);
    const item = await screen.findByRole("menuitem", { name: /导出会话/ });
    fireEvent.click(item);
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("无 onExport 时也不渲染「更多操作」", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });
});

// C-24:查找按钮 title 固定「(⌘F)」,Windows/Linux 用户看到 Mac 符号。
describe("ChatHeader 快捷键标签平台化", () => {
  it("非 Mac 平台显示 Ctrl+F,Mac 显示 ⌘F", () => {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0)", configurable: true });
    expect(modKeyLabel()).toBe("Ctrl+");
    const { unmount } = renderHeader({ onOpenFind: vi.fn() });
    expect(screen.getByRole("button", { name: "会话内查找" })).toHaveAttribute("title", "会话内查找 (Ctrl+F)");
    unmount();
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    expect(modKeyLabel()).toBe("⌘");
    renderHeader({ onOpenFind: vi.fn() });
    expect(screen.getByRole("button", { name: "会话内查找" })).toHaveAttribute("title", "会话内查找 (⌘F)");
    if (original) Object.defineProperty(Navigator.prototype, "platform", original);
    Reflect.deleteProperty(navigator, "platform");
    Reflect.deleteProperty(navigator, "userAgent");
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
