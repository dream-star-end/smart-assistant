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

describe("ChatHeader 协作方式 chip", () => {
  it("不适用(collabMode 省略,如其它智能体 / demo)时不渲染任何协作 chip", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "团队模式已开启" })).toBeNull();
    expect(screen.queryByRole("button", { name: /协作方式/ })).toBeNull();
  });

  // UI-2a:单人也写出来(体验官:单人模式下看不出走的是什么协作模式);点开去换智能体 / 协作方式。
  it("单人模式常显「单人」chip,点击打开智能体选择", () => {
    const onAgentClick = vi.fn();
    renderHeader({ collabMode: "solo", onAgentClick });
    const chip = screen.getByRole("button", { name: "协作方式：单人，点击更换" });
    expect(screen.getByTestId("chat-model-row")).toContainElement(chip);
    expect(chip.textContent).toBe("单人");
    expect(screen.queryByRole("button", { name: "团队模式已开启" })).toBeNull();
    fireEvent.click(chip);
    expect(onAgentClick).toHaveBeenCalledTimes(1);
  });

  it("团队模式时 agent 名旁渲染「团队模式」chip", () => {
    renderHeader({ collabMode: "team", onCollabSolo: () => {} });
    const chip = screen.getByRole("button", { name: "团队模式已开启" });
    expect(chip.textContent).toContain("团队模式");
  });

  it("窄屏 chip 另有「团队」文案，桌面全称仍在 DOM", () => {
    renderHeader({ collabMode: "team", onCollabSolo: () => {} });
    const chip = screen.getByRole("button", { name: "团队模式已开启" });
    expect(chip.textContent).toContain("团队");
    expect(chip.textContent).toContain("团队模式");
  });

  it("点击 chip 弹出说明（引擎 + 计费告知）与关闭按钮；点击关闭回到单人", async () => {
    const onCollabSolo = vi.fn();
    renderHeader({ collabMode: "team", onCollabSolo });

    fireEvent.click(screen.getByRole("button", { name: "团队模式已开启" }));

    // 说明一句话:如实告知队长引擎与计费差异
    const note = await screen.findByText(/队长引擎为 GPT-6-Astra/);
    expect(note.textContent).toContain("计费高于默认模型");

    expect(note.textContent).not.toContain("委派");
    fireEvent.click(screen.getByRole("button", { name: "关闭团队模式" }));
    expect(onCollabSolo).toHaveBeenCalledTimes(1);
  });

  it("顾问模式时渲染顾问模式 chip", () => {
    renderHeader({ collabMode: "advisor", onCollabSolo: () => {} });
    expect(screen.getByRole("button", { name: "顾问模式已开启" }).textContent).toContain("顾问模式");
  });

  it("顾问 chip 展示冻结型号，不改主模型选择器", () => {
    renderHeader({
      collabMode: "advisor",
      advisorModelLabel: "gpt-6-astra",
      onCollabSolo: () => {},
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

  it("团队模式时顶栏 ModelSelector 显示实际生效的队长引擎(chip 表达团队模式,trigger 不再重复该词)", () => {
    renderHeader({ collabMode: "team", onCollabSolo: () => {} });
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    // C-25:「顶栏所见 = 实际所发」—— 引擎名必须在 trigger 上;「团队模式」一词只由 chip 承担。
    expect(trigger.textContent).toContain("队长引擎 · GPT-6-Astra");
    expect(trigger.textContent).not.toContain("团队模式");
    expect(trigger.textContent).not.toContain("GLM-5.2");
    expect(screen.getByRole("button", { name: "团队模式已开启" })).toBeInTheDocument();
  });

  // #1291:队长以服务端下发的 id 为准;团队态 trigger 锁定(不能自选),说明弹层与 trigger 是同一个队长。
  it("团队模式按服务端队长 id 锁定模型入口,trigger 与说明弹层显示同一队长和倍率", async () => {
    renderHeader({
      models: [...MODELS, { id: "server-leader", display_name: "Server Leader", cost_x: 7.5 }],
      collabMode: "team",
      teamLeaderModelId: "server-leader",
      onCollabSolo: () => {},
    });
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger).toBeDisabled();
    expect(trigger.textContent).toContain("Server Leader");
    expect(trigger.textContent).toContain("7.5×");
    expect(trigger.textContent).not.toContain("GLM-5.2");
    fireEvent.click(screen.getByRole("button", { name: "团队模式已开启" }));
    expect(await screen.findByText(/队长引擎为 Server Leader/)).toBeInTheDocument();
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

// OCV5-369:右上角「导出会话」改为「分享会话」(行为有意改变,原导出用例随之更新)。
describe("ChatHeader 分享会话", () => {
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

  // C-12:窄屏独立按钮 hidden sm:flex,由「更多操作」菜单承接。
  it("窄屏「更多操作」菜单承接分享(桌面键 hidden sm:flex,菜单 sm:hidden),菜单项调用 onShare", async () => {
    const onShare = vi.fn();
    renderHeader({ onShare });
    expect(screen.getByRole("button", { name: "分享会话" })).toHaveClass("hidden", "sm:flex");
    const more = screen.getByRole("button", { name: "更多操作" });
    expect(more.parentElement).toHaveClass("sm:hidden");
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(more);
    const item = await screen.findByRole("menuitem", { name: /分享/ });
    fireEvent.click(item);
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it("无 onShare 时也不渲染「更多操作」", () => {
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
    // OCV5-295:窄屏模型行不再铺整宽灰底胶囊。
    expect(row).not.toHaveClass("bg-hover/50");
    expect(row).not.toHaveClass("rounded-xl");
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

  it("可见时落在模型行(窄屏整宽那一行),不挤右侧图标组;点一下回调刷新", () => {
    const onReloadForUpdate = vi.fn();
    renderHeader({ updateAvailable: true, onReloadForUpdate, onOpenFind: vi.fn() });
    const pill = screen.getByRole("button", { name: "有新版本，点击刷新页面" });
    const row = screen.getByTestId("chat-model-row");
    expect(row).toContainElement(pill);
    expect(row).not.toContainElement(screen.getByRole("button", { name: "会话内查找" }));
    // 窄屏两字短文案 + 桌面全称都在 DOM,由断点切换;44px 命中区在透明外层 button 上。
    expect(pill.textContent).toContain("新版本");
    expect(pill.textContent).toContain("有新版本 · 刷新");
    expect(pill).toHaveClass("min-h-11", "ml-auto");
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

describe("ChatHeader 余额单位(UI-2a)", () => {
  it("余额带「积分」单位;窄屏只留图标,悬停仍能看到带单位的余额", () => {
    renderHeader({ credits: "998473", onOpenBilling: vi.fn() });
    const pill = screen.getByRole("button", { name: "账户与计费" });
    expect(pill.textContent).toBe("998,473 积分");
    expect(pill).toHaveAttribute("title", "余额 998,473 积分");
  });
});

describe("ChatHeader 详情面板入口(UI-2a:默认收起,有产出才出「产出 N」)", () => {
  it("收起且这一轮没有产出:顶栏不出面板入口", () => {
    renderHeader({ onTogglePane: vi.fn(), paneOutputs: 0 });
    expect(screen.queryByTestId("detail-pane-toggle")).toBeNull();
  });

  it("收起且有产出:桌面出「产出 N」,点了打开面板;手机收进「更多操作」", async () => {
    const onTogglePane = vi.fn();
    renderHeader({ onTogglePane, paneOutputs: 2 });
    const toggle = screen.getByTestId("detail-pane-toggle");
    expect(toggle.textContent).toBe("产出 2");
    expect(toggle).toHaveClass("hidden", "sm:flex");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onTogglePane).toHaveBeenCalledTimes(1);

    const more = screen.getByRole("button", { name: "更多操作" });
    expect(more.parentElement).toHaveClass("sm:hidden");
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: "产出 2" }));
    expect(onTogglePane).toHaveBeenCalledTimes(2);
  });

  it("展开时给收起键(不看产出数),手机菜单里不再出产出项", () => {
    const onTogglePane = vi.fn();
    renderHeader({ onTogglePane, paneOpen: true, paneOutputs: 0 });
    const toggle = screen.getByRole("button", { name: "收起详情面板" });
    expect(toggle).toHaveAttribute("data-testid", "detail-pane-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(onTogglePane).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });
});

describe("ChatHeader 手机顶栏收拢(UI-2a)", () => {
  it("所在项目桌面在标题旁,手机收进「更多操作」", async () => {
    const onOpenProjectScope = vi.fn();
    renderHeader({ projectBreadcrumb: { chatName: "周报" }, onOpenProjectScope });
    expect(screen.getByTestId("chat-project-breadcrumb")).toHaveClass("hidden", "sm:inline-flex");
    const more = screen.getByRole("button", { name: "更多操作" });
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: "所在项目：周报" }));
    expect(onOpenProjectScope).toHaveBeenCalledTimes(1);
  });
});
