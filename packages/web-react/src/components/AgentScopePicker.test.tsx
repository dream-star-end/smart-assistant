import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentScopePicker, AgentScopeSummary, normalizeAgentScope } from "./AgentScopePicker";

afterEach(cleanup);

// C-13:已卸载 / 不存在的智能体此前以原始 id + 🤖 作为可点选项出现,开发者术语泄漏且可被反复勾选。
describe("AgentScopePicker 幽灵 id", () => {
  const agents = [
    { id: "main", slug: "main", name: "全能助手", description: "", installed: true, isDefault: true },
  ];

  it("不在列表的选中 id 渲染为「已卸载」徽章(只露前 8 位)且不可勾选,「移除」把它从范围里剔掉", () => {
    const onChange = vi.fn();
    render(
      <AgentScopePicker agents={agents} selectedIds={["main", "ghost-agent-removed"]} onChange={onChange} />,
    );
    expect(screen.queryByRole("button", { name: /ghost-agent-removed/ })).toBeNull();
    const orphan = screen.getByTestId("agent-scope-orphan");
    expect(orphan).toHaveTextContent("已卸载 · ghost-ag…");
    expect(orphan.textContent).not.toContain("ghost-agent-removed");
    fireEvent.click(screen.getByRole("button", { name: "移除已卸载的智能体 ghost-ag…" }));
    expect(onChange).toHaveBeenCalledWith(["main"]);
    // 真实智能体照常可切换。
    expect(screen.getByRole("button", { name: /全能助手/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("只读(无 onChange)时不渲染「移除」", () => {
    render(<AgentScopePicker agents={agents} selectedIds={["ghost-x"]} />);
    expect(screen.getByTestId("agent-scope-orphan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /移除已卸载/ })).toBeNull();
  });
});

describe("Agent capability scope normalization", () => {
  it("defaults an absent legacy scope to main but preserves an explicit dormant []", () => {
    expect(normalizeAgentScope(undefined)).toEqual(["main"]);
    expect(normalizeAgentScope([])).toEqual([]);
    expect(normalizeAgentScope([" main ", "main", "research-agent"])).toEqual([
      "main",
      "research-agent",
    ]);
  });

  it("renders dormant capability artifacts without claiming they belong to main", () => {
    render(<AgentScopeSummary agentIds={[]} agents={[]} />);
    expect(screen.getByText("能力库中 · 暂未启用")).toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });
});
