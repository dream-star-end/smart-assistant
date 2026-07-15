import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentScopeSummary, normalizeAgentScope } from "./AgentScopePicker";

afterEach(cleanup);

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
