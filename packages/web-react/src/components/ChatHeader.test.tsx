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

  it("模型选择器已迁出顶栏", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "选择对话模型" })).toBeNull();
  });
});

describe("ChatHeader 上下文重开", () => {
  it("传入 onShowContext 才渲染「显示上下文」", () => {
    const { rerender } = renderHeader();
    expect(screen.queryByRole("button", { name: "显示上下文" })).toBeNull();
    rerender(
      <ChatHeader
        agent={MAIN_AGENT}
        onAgentClick={() => {}}
        models={MODELS}
        theme="light"
        onCycleTheme={() => {}}
        onShowContext={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "显示上下文" })).toBeInTheDocument();
  });
});
