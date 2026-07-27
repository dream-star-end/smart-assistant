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
      theme="light"
      onCycleTheme={() => {}}
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

describe("ChatHeader 移动端拥挤状态", () => {
  it("用两行自适应布局保留全部入口且不恢复固定高度", () => {
    const { container } = renderHeader({
      teamModeActive: true,
      onDisableTeamMode: () => {},
      credits: "12345678901234567890",
      onOpenBilling: () => {},
      onOpenMobileNav: () => {},
      onOpenInbox: () => {},
      onOpenTutorial: () => {},
      unreadCount: 128,
    });

    const header = container.querySelector("header");
    expect(header).toHaveClass("min-h-14", "flex-wrap", "md:flex-nowrap");
    expect(header).not.toHaveClass("h-14");
    expect(header?.querySelector(":scope > .basis-full")).toHaveClass("md:hidden");

    expect(screen.getByRole("button", { name: "打开菜单" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "团队模式已开启" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择对话模型" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开使用教程" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "站内信" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "账户与计费" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /切换主题/ })).toBeInTheDocument();
  });

  it("拥挤状态下各动作仍触发原回调", () => {
    const onOpenMobileNav = vi.fn();
    const onOpenInbox = vi.fn();
    const onOpenTutorial = vi.fn();
    const onOpenBilling = vi.fn();
    const onCycleTheme = vi.fn();
    renderHeader({
      teamModeActive: true,
      onDisableTeamMode: () => {},
      credits: "12345678901234567890",
      onOpenBilling,
      onOpenMobileNav,
      onOpenInbox,
      onOpenTutorial,
      onCycleTheme,
    });

    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));
    fireEvent.click(screen.getByRole("button", { name: "打开使用教程" }));
    fireEvent.click(screen.getByRole("button", { name: "站内信" }));
    fireEvent.click(screen.getByRole("button", { name: "账户与计费" }));
    fireEvent.click(screen.getByRole("button", { name: /切换主题/ }));

    expect(onOpenMobileNav).toHaveBeenCalledTimes(1);
    expect(onOpenTutorial).toHaveBeenCalledTimes(1);
    expect(onOpenInbox).toHaveBeenCalledTimes(1);
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
    expect(onCycleTheme).toHaveBeenCalledTimes(1);
  });
});
