import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { MAIN_AGENT } from "../lib/agents";
import type { PublicModel } from "../lib/types";
import { ChatHeader, compactMobileModelLabel, modKeyLabel } from "./ChatHeader";

// 本仓 vitest 未开 globals 自动 cleanup,显式隔离每个用例的 DOM。
afterEach(cleanup);

const MODELS: PublicModel[] = [
  { id: "glm-5.2", display_name: "GLM-5.2" },
  { id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
  { id: "gpt-6.2-astra", display_name: "GPT-6.2-Astra" },
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
    // C-25:「顶栏所见 = 实际所发」—— 引擎名必须在 trigger 上;「团队模式」一词只由 chip 承担。
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

describe("ChatHeader 未读状态点降噪（OCV5-820 消灭 99+/40 红紫数字泡泡）", () => {
  it("无 sessionUnreadCount 时不渲染占位，打开菜单按钮仍在", () => {
    renderHeader({ onOpenMobileNav: () => {} });
    expect(screen.queryByTestId("session-unread-badge")).toBeNull();
    expect(screen.getByRole("button", { name: "打开菜单" })).toBeInTheDocument();
  });

  it("移动端汉堡钮与站内信铃铛均使用克制 6px 状态点，不渲染 99+/40 数字泡泡，保留 aria-label 与 hover title 精准计数", () => {
    renderHeader({
      onOpenMobileNav: () => {},
      onOpenInbox: () => {},
      unreadCount: 40,
      sessionUnreadCount: 128,
    });
    const menu = screen.getByRole("button", { name: "打开菜单,128 条未读会话" });
    expect(menu).toHaveAttribute("title", "打开菜单（128 条未读会话）");
    const sessionDot = menu.parentElement?.querySelector("[data-testid=session-unread-badge]");
    expect(sessionDot).toBeTruthy();
    expect(sessionDot).toHaveTextContent("");
    expect(sessionDot).toHaveAttribute("data-unread-count", "128");
    expect(sessionDot).toHaveClass("size-1.5", "rounded-full", "bg-accent", "motion-safe:animate-pulse");
    expect(menu.parentElement?.textContent).not.toContain("99+");

    const inboxBtn = screen.getByRole("button", { name: "站内信，40 条未读" });
    expect(inboxBtn).toHaveAttribute("title", "站内信（40 条未读）");
    const inboxDot = screen.getByTestId("inbox-unread-badge");
    expect(inboxDot).toHaveTextContent("");
    expect(inboxDot).toHaveAttribute("data-unread-count", "40");
    expect(inboxDot).toHaveClass("size-1.5", "rounded-full", "bg-accent", "ring-2", "ring-bg");
    expect(inboxBtn.parentElement?.textContent).not.toContain("40");
  });

  it("折叠态 6px 呼吸点挂在「展开侧栏」按钮上并保留无障碍计数语义", () => {
    renderHeader({
      sidebarCollapsed: true,
      onExpandSidebar: () => {},
      sessionUnreadCount: 4,
    });
    const expand = screen.getByRole("button", { name: "展开侧栏,4 条未读会话" });
    const dot = expand.parentElement?.querySelector("[data-testid=session-unread-badge]");
    expect(dot).toBeTruthy();
    expect(dot).toHaveTextContent("");
    expect(dot).toHaveAttribute("data-unread-count", "4");
    expect(dot).toHaveClass("size-1.5", "bg-accent");
  });

  it("会话未读与站内信未读并存且互不影响", () => {
    renderHeader({
      onOpenMobileNav: () => {},
      onOpenInbox: () => {},
      unreadCount: 7,
      sessionUnreadCount: 1,
    });
    expect(screen.getByTestId("session-unread-badge")).toHaveAttribute("data-unread-count", "1");
    expect(screen.getByTestId("inbox-unread-badge")).toHaveAttribute("data-unread-count", "7");
  });
});

describe("ChatHeader 快问小窗按钮", () => {
  it("无 onToggleQuickAsk 时不渲染；有回调时展示按钮、按下态与后台旋转图标", () => {
    renderHeader();
    expect(screen.queryByTestId("quick-ask-toggle")).toBeNull();
    cleanup();
    const onToggleQuickAsk = vi.fn();
    renderHeader({ onToggleQuickAsk, quickAskOpen: false, quickAskSending: true });
    const btn = screen.getByTestId("quick-ask-toggle");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(btn);
    expect(onToggleQuickAsk).toHaveBeenCalledTimes(1);
    cleanup();
    renderHeader({ onToggleQuickAsk, quickAskOpen: true, quickAskSending: true });
    expect(screen.getByTestId("quick-ask-toggle")).toHaveAttribute("aria-pressed", "true");
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

// OCV5-369:右上角「导出会话」改为「分享会话」(行为有意改变,原导出用例随之更新)。
describe("ChatHeader 分享会话与溢出菜单", () => {
  it("无 onShare 时不渲染分享按钮", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "分享会话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "导出会话" })).toBeNull();
  });

  it("有 onShare 时渲染分享按钮且点击回调", () => {
    const onShare = vi.fn();
    renderHeader({ onShare });
    fireEvent.click(screen.getByRole("button", { name: "分享会话" }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  // OCV5-817 / OCV5-820: 窄容器「更多操作」菜单承接分享、查找及移动端低频入口。
  it("窄容器「更多操作」菜单承接分享(宽容器 hidden @[720px]:flex, 菜单 @[720px]:hidden),菜单项调用 onShare", async () => {
    const onShare = vi.fn();
    renderHeader({ onShare });
    expect(screen.getByRole("button", { name: "分享会话" })).toHaveClass("hidden", "@[720px]:flex");
    const more = screen.getByRole("button", { name: "更多操作" });
    expect(more.parentElement).toHaveClass("@[720px]:hidden");
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(more);
    const item = await screen.findByRole("menuitem", { name: /分享/ });
    fireEvent.click(item);
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it("无 onShare/onOpenFind 时，「更多操作」仅在移动端 sm:hidden 显示以收纳站内信/余额/快问/智能体", () => {
    renderHeader();
    const more = screen.getByRole("button", { name: "更多操作" });
    expect(more.parentElement).toHaveClass("sm:hidden");
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

describe("ChatHeader 移动端单行化与平板宽度分配（OCV5-820）", () => {
  it("单行 flex-nowrap 布局：消灭双行折行 chat-model-row，隐藏移动端绿圆头像，右侧保留 Workbench + 新建 + 溢出菜单", async () => {
    const onNew = vi.fn();
    const onTogglePane = vi.fn();
    const onOpenInbox = vi.fn();
    const onOpenBilling = vi.fn();
    const onToggleQuickAsk = vi.fn();
    const onAgentClick = vi.fn();
    const onOpenProjectScope = vi.fn();

    renderHeader({
      onOpenMobileNav: vi.fn(),
      onNew,
      onTogglePane,
      onOpenInbox,
      unreadCount: 40,
      credits: "12345",
      onOpenBilling,
      onToggleQuickAsk,
      onAgentClick,
      projectBreadcrumb: { chatName: "前端重构" },
      onOpenProjectScope,
      onOpenFind: vi.fn(),
      onShare: vi.fn(),
    });

    const headerRow = screen.getByTestId("chat-model-row").parentElement;
    expect(headerRow).toHaveClass("flex-nowrap", "min-h-12");

    // 移动端隐藏顶栏大头像按钮（改由溢出菜单承接）
    const agentBtn = screen.getByRole("button", { name: `切换智能体，当前${MAIN_AGENT.name}` });
    expect(agentBtn).toHaveClass("hidden", "sm:flex");

    // 移动端 chat-model-row 不再折到第二行（无 order-2），并居中承载紧凑模型胶囊
    const modelRow = screen.getByTestId("chat-model-row");
    expect(modelRow).not.toHaveClass("order-2");
    expect(modelRow).toHaveClass("justify-center", "sm:justify-start");
    expect(modelRow).toContainElement(screen.getByRole("button", { name: "选择对话模型" }));
    expect(modelRow).not.toContainElement(screen.getByRole("button", { name: "会话内查找" }));

    // 移动端右侧保留 [◫ Workbench] + [＋ 新建] + [··· 溢出菜单]
    const paneBtn = screen.getByTestId("detail-pane-toggle");
    expect(paneBtn).not.toHaveClass("hidden");
    fireEvent.click(paneBtn);
    expect(onTogglePane).toHaveBeenCalledTimes(1);

    const mobileNewBtn = screen.getByTestId("mobile-new-chat-btn");
    expect(mobileNewBtn).toHaveClass("sm:hidden");
    fireEvent.click(mobileNewBtn);
    expect(onNew).toHaveBeenCalledTimes(1);

    // 移动端站内信、钱包、快问在顶栏隐藏，收纳进「···」溢出菜单且精准展示计数/余额
    expect(screen.getByTestId("header-secondary-actions")).toHaveClass("hidden", "sm:flex");
    expect(screen.getByTestId("quick-ask-toggle")).toHaveClass("hidden", "sm:flex");
    expect(screen.getByTestId("overflow-inbox-dot")).toHaveClass("size-1.5", "bg-accent", "ring-2", "ring-bg", "sm:hidden");

    const more = screen.getByTestId("header-overflow-trigger");
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(more);

    const inboxItem = await screen.findByTestId("overflow-inbox-item");
    expect(inboxItem).toHaveTextContent("站内信");
    expect(inboxItem).toHaveTextContent("40");
    expect(screen.getByTestId("overflow-billing-item")).toHaveTextContent("12,345");
    expect(screen.getByTestId("overflow-quick-ask-item")).toHaveTextContent("快问小窗");
    expect(screen.getByTestId("overflow-agent-item")).toHaveTextContent(MAIN_AGENT.name);
    expect(screen.getByTestId("overflow-project-item")).toHaveTextContent("前端重构");

    fireEvent.click(inboxItem);
    expect(onOpenInbox).toHaveBeenCalledTimes(1);
  });

  it("平板 640-1023px 合理分配宽度：收束余额数字与项目面包屑至 lg+，防止模型名被压成截断残片", () => {
    renderHeader({
      selectedModelId: "gpt-6.2-astra",
      credits: "987654",
      onOpenBilling: vi.fn(),
      projectBreadcrumb: { chatName: "设计系统" },
      onOpenProjectScope: vi.fn(),
    });
    const billingBtn = screen.getByRole("button", { name: "账户与计费" });
    const creditsText = billingBtn.querySelector("span");
    expect(creditsText).toHaveClass("hidden", "lg:inline");
    expect(screen.getByTestId("chat-project-breadcrumb")).toHaveClass("hidden", "lg:inline-flex");
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger).toHaveTextContent("GPT-6.2-Astra");
  });
});

describe("ChatHeader 新版本 pill(OCV5-626)", () => {
  it("updateAvailable=false 或缺 onReloadForUpdate 时不渲染", () => {
    renderHeader({ onReloadForUpdate: vi.fn() });
    expect(screen.queryByTestId("update-pill")).toBeNull();
    cleanup();
    renderHeader({ updateAvailable: true });
    expect(screen.queryByTestId("update-pill")).toBeNull();
  });

  it("可见时落在模型行,不挤右侧图标组;点一下回调刷新", () => {
    const onReloadForUpdate = vi.fn();
    renderHeader({ updateAvailable: true, onReloadForUpdate, onOpenFind: vi.fn() });
    const pill = screen.getByRole("button", { name: "有新版本，点击刷新页面" });
    const row = screen.getByTestId("chat-model-row");
    expect(row).toContainElement(pill);
    expect(row).not.toContainElement(screen.getByRole("button", { name: "会话内查找" }));
    expect(pill.textContent).toContain("新版本");
    expect(pill.textContent).toContain("有新版本 · 刷新");
    expect(pill).toHaveClass("min-h-11");
    fireEvent.click(pill);
    expect(onReloadForUpdate).toHaveBeenCalledTimes(1);
  });

  it("没有模型列表时也渲染模型行来承载 pill", () => {
    render(
      <ChatHeader agent={MAIN_AGENT} onAgentClick={() => {}} updateAvailable onReloadForUpdate={vi.fn()} />,
    );
    expect(screen.getByTestId("chat-model-row")).toContainElement(screen.getByTestId("update-pill"));
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
    expect(screen.getByTestId("header-secondary-actions")).toContainElement(
      screen.getByRole("button", { name: "会话内查找" }),
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

describe("OCV5-831 ChatHeader 顶栏遮挡层、手机模型名去括号与统一未读点", () => {
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

  it("左右顶栏未读点统一使用暖陶土 bg-accent + ring-2 ring-bg，不再出现左右红/陶土色值割裂", () => {
    renderHeader({
      onOpenMobileNav: vi.fn(),
      onOpenInbox: vi.fn(),
      unreadCount: 5,
      sessionUnreadCount: 3,
    });
    const leftDot = screen.getByTestId("session-unread-badge");
    const rightDot = screen.getByTestId("overflow-inbox-dot");
    expect(leftDot).toHaveClass("bg-accent", "ring-2", "ring-bg");
    expect(rightDot).toHaveClass("bg-accent", "ring-2", "ring-bg");
    expect(rightDot).not.toHaveClass("bg-danger");
  });
});
