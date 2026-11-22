import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { type Agent, MAIN_AGENT } from "../lib/agents";
import type { PublicModel } from "../lib/types";
import { ChatHeader, compactMobileModelLabel, modKeyLabel } from "./ChatHeader";

// 本仓 vitest 未开 globals 自动 cleanup,显式隔离每个用例的 DOM。
afterEach(cleanup);

const MODELS: PublicModel[] = [
  { id: "glm-5.2", display_name: "GLM-5.2" },
  { id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
  { id: "gpt-6.2-astra", display_name: "GPT-6.2-Astra" },
];

const CODER_AGENT: Agent = {
  id: "coder",
  name: "代码专家",
  description: "资深全栈工程师",
};

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

function openOverflowMenu() {
  const more = screen.getByTestId("header-overflow-trigger");
  fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
  fireEvent.click(more);
  return more;
}

describe("ChatHeader 团队模式与顾问模式指示 chip", () => {
  it("teamModeActive=false 时不渲染 chip", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "团队模式已开启" })).toBeNull();
  });

  it("teamModeActive=true 时渲染「团队模式」chip", () => {
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

    const note = await screen.findByText(/队长引擎为 GPT-6\.2-Astra/);
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
    expect(screen.getByText(/本回合固定使用 gpt-6-astra/)).toBeInTheDocument();
    expect(screen.getByText(/不承诺更省/)).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("GLM-5.2");
    expect(trigger.textContent).not.toContain("GPT-6-Astra");
  });

  it("teamModeActive=true 时顶栏 ModelSelector 显示实际生效的队长引擎(chip 表达团队模式,trigger 不再重复该词)", () => {
    renderHeader({ teamModeActive: true, onDisableTeamMode: () => {} });
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("队长引擎 · GPT-6.2-Astra");
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

describe("ChatHeader 未读状态点与零双红点（OCV5-843）", () => {
  it("无 sessionUnreadCount 时不渲染占位，打开菜单按钮仍在", () => {
    renderHeader({ onOpenMobileNav: () => {} });
    expect(screen.queryByTestId("session-unread-badge")).toBeNull();
    expect(screen.getByRole("button", { name: "打开菜单" })).toBeInTheDocument();
  });

  it("左上角汉堡钮与折叠展开钮保留 6px 会话未读呼吸点；即使传入历史站内信/余额 prop，顶栏与右上角「···」彻底零红点、零全局杂项", async () => {
    renderHeader({
      onOpenMobileNav: () => {},
      sidebarCollapsed: true,
      onExpandSidebar: () => {},
      sessionUnreadCount: 128,
      onOpenInbox: () => {},
      unreadCount: 86,
      credits: "1696777",
      onOpenBilling: () => {},
    });

    const menu = screen.getByRole("button", { name: "打开菜单,128 条未读会话" });
    expect(menu).toHaveAttribute("title", "打开菜单（128 条未读会话）");
    const sessionDot = menu.parentElement?.querySelector("[data-testid=session-unread-badge]");
    expect(sessionDot).toBeTruthy();
    expect(sessionDot).toHaveTextContent("");
    expect(sessionDot).toHaveAttribute("data-unread-count", "128");
    expect(sessionDot).toHaveClass("size-1.5", "rounded-full", "bg-accent", "oc-alive-dot");

    const expand = screen.getByRole("button", { name: "展开侧栏,128 条未读会话" });
    expect(expand.parentElement?.querySelector("[data-testid=session-unread-badge]")).toHaveAttribute(
      "data-unread-count",
      "128",
    );

    // 顶栏彻底不再渲染站内信铃铛、钱包余额胶囊与「···」红点
    expect(screen.queryByTestId("inbox-unread-badge")).toBeNull();
    expect(screen.queryByTestId("overflow-inbox-dot")).toBeNull();
    expect(screen.queryByRole("button", { name: /站内信/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "账户与计费" })).toBeNull();

    openOverflowMenu();
    await screen.findByTestId("overflow-agent-item");
    expect(screen.queryByTestId("overflow-inbox-item")).toBeNull();
    expect(screen.queryByTestId("overflow-billing-item")).toBeNull();
    expect(screen.queryByTestId("overflow-update-item")).toBeNull();
  });
});

describe("ChatHeader 快问小窗按钮与移动端菜单发送态（OCV5-843）", () => {
  it("无 onToggleQuickAsk 时不渲染；有回调时桌面展示按钮、按下态与后台旋转图标", () => {
    renderHeader();
    expect(screen.queryByTestId("quick-ask-toggle")).toBeNull();
    cleanup();
    const onToggleQuickAsk = vi.fn();
    renderHeader({ onToggleQuickAsk, quickAskOpen: false, quickAskSending: true });
    const btn = screen.getByTestId("quick-ask-toggle");
    expect(btn).toHaveClass("hidden", "sm:flex");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(btn);
    expect(onToggleQuickAsk).toHaveBeenCalledTimes(1);
    cleanup();
    renderHeader({ onToggleQuickAsk, quickAskOpen: true, quickAskSending: true });
    expect(screen.getByTestId("quick-ask-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("移动端「···」菜单里的快问小窗保留 quickAskSending 后台回答中微指示", async () => {
    const onToggleQuickAsk = vi.fn();
    renderHeader({ onToggleQuickAsk, quickAskOpen: false, quickAskSending: true });
    openOverflowMenu();
    const item = await screen.findByTestId("overflow-quick-ask-item");
    expect(item).toHaveClass("sm:hidden");
    expect(item).toHaveTextContent("快问小窗");
    expect(screen.getByTestId("overflow-quick-ask-sending")).toHaveTextContent("回答中");
    expect(item.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(item);
    expect(onToggleQuickAsk).toHaveBeenCalledTimes(1);
  });
});

describe("ChatHeader 当前会话「···」溢出菜单与快捷键标签", () => {
  it("「···」菜单桌面与移动常驻，收敛切换智能体、项目、会话内查找与分享会话", async () => {
    const onAgentClick = vi.fn();
    const onOpenProjectScope = vi.fn();
    const onOpenFind = vi.fn();
    const onShare = vi.fn();
    renderHeader({
      onAgentClick,
      projectBreadcrumb: { chatName: "前端重构" },
      onOpenProjectScope,
      onOpenFind,
      onShare,
    });

    // 右侧不常驻独立查找/分享按钮，统一收敛在「···」菜单
    expect(screen.queryByRole("button", { name: "会话内查找" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分享会话" })).toBeNull();

    const more = openOverflowMenu();
    expect(more.parentElement).not.toHaveClass("sm:hidden");
    expect(more.parentElement).not.toHaveClass("@[720px]:hidden");

    const agentItem = await screen.findByTestId("overflow-agent-item");
    expect(agentItem).toHaveTextContent("切换智能体");
    expect(agentItem).toHaveTextContent(MAIN_AGENT.name);

    // 640-1023px 项目菜单项不再 sm:hidden，任何宽度均可直达项目
    const projectItem = screen.getByTestId("overflow-project-item");
    expect(projectItem).toHaveTextContent("项目：前端重构");
    expect(projectItem).not.toHaveClass("sm:hidden");

    const findItem = screen.getByTestId("overflow-find-item");
    expect(findItem).toHaveTextContent("会话内查找");
    const shareItem = screen.getByTestId("overflow-share-item");
    expect(shareItem).toHaveTextContent("分享会话");

    fireEvent.click(shareItem);
    expect(onShare).toHaveBeenCalledTimes(1);

    openOverflowMenu();
    fireEvent.click(await screen.findByTestId("overflow-find-item"));
    expect(onOpenFind).toHaveBeenCalledTimes(1);

    openOverflowMenu();
    fireEvent.click(await screen.findByTestId("overflow-project-item"));
    expect(onOpenProjectScope).toHaveBeenCalledTimes(1);

    openOverflowMenu();
    fireEvent.click(await screen.findByTestId("overflow-agent-item"));
    expect(onAgentClick).toHaveBeenCalledTimes(1);
  });

  it("非 Mac 平台显示 Ctrl+F，Mac 显示 ⌘F", async () => {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0)", configurable: true });
    expect(modKeyLabel()).toBe("Ctrl+");
    const { unmount } = renderHeader({ onOpenFind: vi.fn() });
    openOverflowMenu();
    expect(await screen.findByTestId("overflow-find-shortcut")).toHaveTextContent("Ctrl+F");
    unmount();

    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    expect(modKeyLabel()).toBe("⌘");
    renderHeader({ onOpenFind: vi.fn() });
    openOverflowMenu();
    expect(await screen.findByTestId("overflow-find-shortcut")).toHaveTextContent("⌘F");

    if (original) Object.defineProperty(Navigator.prototype, "platform", original);
    Reflect.deleteProperty(navigator, "platform");
    Reflect.deleteProperty(navigator, "userAgent");
  });
});

describe("ChatHeader 桌面与移动端对称布局（OCV5-843）", () => {
  it("空会话态移动端仅留左汉堡 + 居中模型胶囊 + 右「···」，不渲染多余新建按钮", () => {
    renderHeader({
      onOpenMobileNav: vi.fn(),
      onNew: vi.fn(),
      sessionTitle: "新对话",
    });

    const headerRow = screen.getByTestId("chat-model-row").parentElement;
    expect(headerRow).toHaveClass("flex-nowrap", "min-h-12");
    expect(screen.queryByTestId("mobile-new-chat-btn")).toBeNull();
    expect(screen.queryByTestId("detail-pane-toggle")).toBeNull();
    expect(screen.getByTestId("chat-model-row")).toHaveClass("justify-center", "sm:justify-start");
    expect(screen.getByTestId("header-overflow-trigger")).toBeInTheDocument();
  });

  it("活跃会话态移动端左 2（汉堡 + newChat）与右 2（工作台 + 「···」）完全对称，且与桌面折叠态新建按钮互斥无重复", () => {
    const onNew = vi.fn();
    const onTogglePane = vi.fn();
    renderHeader({
      onOpenMobileNav: vi.fn(),
      sidebarCollapsed: true,
      onExpandSidebar: vi.fn(),
      onNew,
      onTogglePane,
      sessionTitle: "性能回归排查",
    });

    const mobileLeft = screen.getByTestId("shell-mobile-left");
    const collapsedLeft = screen.getByTestId("shell-collapsed-left");
    const mobileNewBtn = screen.getByTestId("mobile-new-chat-btn");
    const desktopNewBtn = screen.getByTestId("desktop-collapsed-new-chat-btn");

    // 移动新建钮落在 md:hidden 左组紧邻汉堡钮；桌面折叠新建钮落在 hidden md:flex 左组
    expect(mobileLeft).toHaveClass("md:hidden");
    expect(mobileLeft).toContainElement(mobileNewBtn);
    expect(collapsedLeft).toHaveClass("hidden", "md:flex");
    expect(collapsedLeft).toContainElement(desktopNewBtn);

    fireEvent.click(mobileNewBtn);
    expect(onNew).toHaveBeenCalledTimes(1);

    const paneBtn = screen.getByTestId("detail-pane-toggle");
    expect(paneBtn).not.toHaveClass("hidden");
    fireEvent.click(paneBtn);
    expect(onTogglePane).toHaveBeenCalledTimes(1);
  });

  it("默认全能助手不在桌面顶栏抢占头像位；非默认智能体展示紧凑芯片且可点击切换", () => {
    const onAgentClick = vi.fn();
    const { rerender } = render(
      <ChatHeader
        agent={MAIN_AGENT}
        onAgentClick={onAgentClick}
        models={MODELS}
        selectedModelId="glm-5.2"
        onSelectModel={() => {}}
      />,
    );
    expect(screen.queryByTestId("chat-agent-chip")).toBeNull();

    rerender(
      <ChatHeader
        agent={CODER_AGENT}
        onAgentClick={onAgentClick}
        models={MODELS}
        selectedModelId="glm-5.2"
        onSelectModel={() => {}}
      />,
    );
    const chip = screen.getByTestId("chat-agent-chip");
    expect(chip).toHaveClass("hidden", "sm:inline-flex");
    expect(chip).toHaveTextContent("代码专家");
    fireEvent.click(chip);
    expect(onAgentClick).toHaveBeenCalledTimes(1);
  });

  it("项目面包屑按容器宽度 @[720px] 内联展示，不再被锁死在 lg+", () => {
    renderHeader({
      selectedModelId: "gpt-6.2-astra",
      projectBreadcrumb: { chatName: "设计系统" },
      onOpenProjectScope: vi.fn(),
    });
    expect(screen.getByTestId("chat-project-breadcrumb")).toHaveClass("hidden", "@[720px]:inline-flex");
    expect(screen.getByRole("button", { name: "选择对话模型" })).toHaveTextContent("GPT-6.2-Astra");
  });
});

describe("ChatHeader 全局新版本条委派至 WorkspaceShellHeader（OCV5-843）", () => {
  it("updateAvailable=false 或缺 onReloadForUpdate 时不渲染", () => {
    renderHeader({ onReloadForUpdate: vi.fn() });
    expect(screen.queryByTestId("shell-update-banner")).toBeNull();
    expect(screen.queryByTestId("update-pill")).toBeNull();
    cleanup();
    renderHeader({ updateAvailable: true });
    expect(screen.queryByTestId("shell-update-banner")).toBeNull();
  });

  it("可见时由壳层统一承接（不挤占模型行与右侧图标组），无模型列表时同样展示", () => {
    const onReloadForUpdate = vi.fn();
    const { container } = render(
      <ChatHeader
        agent={MAIN_AGENT}
        onAgentClick={() => {}}
        updateAvailable
        onReloadForUpdate={onReloadForUpdate}
      />,
    );
    const header = container.querySelector("header");
    const banner = screen.getByTestId("shell-update-banner");
    const pill = screen.getByRole("button", { name: "有新版本，点击刷新页面" });
    expect(header).toContainElement(banner);
    expect(banner).toContainElement(pill);
    expect(pill).toHaveTextContent("发现新版本 · 立即刷新");
    fireEvent.click(pill);
    expect(onReloadForUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("ChatHeader 未分类会话的项目建议", () => {
  it("显示建议；移入与不用各自回调；已在项目里时显示所在项目而不是建议", () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    renderHeader({ projectSuggestion: { name: "论文综述", onAccept, onDismiss } });
    const suggestion = screen.getByTestId("chat-project-suggestion");
    expect(suggestion).toHaveClass("hidden", "sm:inline-flex");
    fireEvent.click(screen.getByRole("button", { name: "移入项目「论文综述」" }));
    fireEvent.click(screen.getByRole("button", { name: "不用移入" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    cleanup();
    renderHeader({
      projectBreadcrumb: { chatName: "别的项目" },
      projectSuggestion: { name: "论文综述", onAccept, onDismiss },
    });
    expect(screen.queryByTestId("chat-project-suggestion")).toBeNull();
    expect(screen.getByTestId("chat-project-breadcrumb")).toHaveTextContent("别的项目");
  });
});

describe("ChatHeader 视觉层次与运行态焦点（OCV5-811）", () => {
  it("展示可选会话标题与运行态徽章，同时显式保留强模型选择器", () => {
    renderHeader({
      sessionTitle: "性能回归排查",
      running: true,
      onOpenFind: vi.fn(),
      onToggleQuickAsk: vi.fn(),
      onTogglePane: vi.fn(),
      paneOpen: true,
    });
    expect(screen.getByTestId("chat-session-title")).toHaveTextContent("性能回归排查");
    const runningBadge = screen.getByTestId("header-running-badge");
    expect(runningBadge).toHaveTextContent("运行中");
    expect(screen.getByTestId("chat-model-row")).toContainElement(runningBadge);
    expect(screen.getByTestId("chat-model-row")).toContainElement(
      screen.getByRole("button", { name: "选择对话模型" }),
    );
    expect(screen.getByTestId("header-workspace-toggles")).toContainElement(
      screen.getByTestId("detail-pane-toggle"),
    );
  });

  it("默认标题「新对话」与 running=false 时不额外渲染噪声徽章", () => {
    renderHeader({ sessionTitle: "新对话", running: false });
    expect(screen.queryByTestId("chat-session-title")).toBeNull();
    expect(screen.queryByTestId("header-running-badge")).toBeNull();
  });
});

describe("OCV5-831 ChatHeader 顶栏遮挡层与手机模型名去括号", () => {
  it("顶栏具备高不透明度磨砂遮挡与轻阴影以消除下方残影裁切", () => {
    const { container } = renderHeader();
    const header = container.querySelector("header");
    expect(header).toHaveClass("bg-bg/95", "backdrop-blur-md", "border-b", "border-border/80", "shadow-xs");
  });

  it("compactMobileModelLabel 去除末尾括号平台后缀并保留核心名，纯括号文案兜底返回原串", () => {
    expect(compactMobileModelLabel("Gemini 4 Neon (Antigravity)")).toBe("Gemini 4 Neon");
    expect(compactMobileModelLabel("GPT-5.6-Sol (Codex)")).toBe("GPT-5.6-Sol");
    expect(compactMobileModelLabel("Claude Opus 4（Cursor）")).toBe("Claude Opus 4");
    expect(compactMobileModelLabel("GLM-5.2")).toBe("GLM-5.2");
    expect(compactMobileModelLabel("(Antigravity)")).toBe("(Antigravity)");
  });
});
