import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { MAIN_AGENT } from "../lib/agents";
import { createMemoryAuthSession } from "../lib/authSession";
import type { AuthSession } from "../lib/types";

// api 网络层全 mock —— 只验证团队模式开关区块的文案与交互契约。
const listMyAgents = vi.fn();
vi.mock("../lib/api", () => ({
  api: {
    listMyAgents: (...a: unknown[]) => listMyAgents(...a),
  },
}));

import { AgentPicker } from "./AgentPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

function renderPicker(
  extra: Partial<Parameters<typeof AgentPicker>[0]> = {},
  rows: unknown[] = [],
) {
  listMyAgents.mockResolvedValue(rows);
  return render(
    <AgentPicker
      open
      current={MAIN_AGENT}
      auth={auth}
      teamMode={false}
      onClose={() => {}}
      onPick={() => {}}
      onToggleTeamMode={() => {}}
      {...extra}
    />,
  );
}

describe("AgentPicker 团队模式开关文案（知情同意）", () => {
  it("描述明确告知：队长切换 GPT-5.6-Sol 引擎、计费高于默认模型、委派按对应模型计费", async () => {
    renderPicker();
    const desc = await screen.findByText(/开启后队长引擎将切换为 GPT-5\.6-Sol/);
    expect(desc.textContent).toContain("计费高于默认模型");
    expect(desc.textContent).toContain("每次委派按对应智能体的模型计费");
  });

  it("开关翻转经 onToggleTeamMode 上抛（App 的全局 flag 是唯一权威）", async () => {
    const onToggleTeamMode = vi.fn();
    renderPicker({ onToggleTeamMode });
    const sw = await screen.findByRole("switch", { name: "启用团队模式" });
    expect(sw).toHaveAttribute("data-state", "unchecked");
    fireEvent.click(sw);
    expect(onToggleTeamMode).toHaveBeenCalledWith(true);
  });

  it("teamMode 开启时开关呈选中态", async () => {
    renderPicker({ teamMode: true });
    const sw = await screen.findByRole("switch", { name: "启用团队模式" });
    expect(sw).toHaveAttribute("data-state", "checked");
  });
});

describe("AgentPicker capability readiness", () => {
  it("保留未就绪 Agent 供用户理解状态，但禁止选择执行", async () => {
    const onPick = vi.fn();
    const rows = [
      {
        id: "main",
        slug: "main",
        name: "全能助手",
        description: "",
        installed: true,
        isDefault: true,
        capabilityReadiness: {
          installed: true,
          ready: true,
          requirements: [],
          needsAuthorization: [],
        },
      },
      {
        id: "research-agent",
        slug: "research-agent",
        name: "科研助手",
        description: "需要检索插件",
        installed: true,
        capabilityReadiness: {
          installed: true,
          ready: false,
          requirements: [],
          needsAuthorization: ["paper-search"],
        },
      },
    ];
    renderPicker({ onPick }, rows);

    const agent = await screen.findByRole("button", { name: /科研助手/ });
    expect(agent).toBeDisabled();
    expect(screen.getByText("Plugin 待授权")).toBeInTheDocument();
    fireEvent.click(agent);
    expect(onPick).not.toHaveBeenCalled();
  });
});
