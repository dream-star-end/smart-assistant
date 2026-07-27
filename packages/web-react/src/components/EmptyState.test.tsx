import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const reportClientFriction = vi.hoisted(() => vi.fn());
vi.mock("../lib/clientFriction", () => ({ reportClientFriction }));

import { MAIN_AGENT, agentFromApiRow } from "../lib/agents";
import { FIRST_TASK_STARTERS, PRESET_AGENT_STARTERS } from "../lib/starters";
import { EmptyState } from "./EmptyState";

afterEach(cleanup);
beforeEach(() => reportClientFriction.mockClear());

describe("EmptyState first-task starters", () => {
  test("shows the exact self-contained prompts before the user chooses one", () => {
    render(<EmptyState agent={MAIN_AGENT} onPrefill={() => {}} onChangeAgent={() => {}} />);
    for (const starter of FIRST_TASK_STARTERS) {
      expect(screen.getByText(starter.label)).toBeInTheDocument();
      expect(screen.getByText(starter.prompt)).toBeInTheDocument();
    }
  });

  test("card click only prefills and records activation; explicit confirmation requests submit", () => {
    const onPrefill = vi.fn();
    const onRun = vi.fn();
    render(
      <EmptyState
        agent={MAIN_AGENT}
        onPrefill={onPrefill}
        onRun={onRun}
        onChangeAgent={() => {}}
        getToken={() => "tok"}
      />,
    );

    const first = FIRST_TASK_STARTERS[0];
    fireEvent.click(screen.getByRole("button", { name: new RegExp(first.label) }));
    expect(onPrefill).toHaveBeenCalledWith(first.prompt);
    expect(onRun).not.toHaveBeenCalled();
    expect(reportClientFriction).toHaveBeenCalledWith(
      {
        surface: "activation",
        stage: "first_screen",
        code: "FIRST_TASK_CLICKED",
        outcome: "succeeded",
      },
      "tok",
    );

    const confirm = screen.getByRole("button", { name: "发送并开跑" });
    fireEvent.click(confirm);
    expect(onRun).toHaveBeenCalledOnce();
    expect(onRun).toHaveBeenCalledWith();
  });

  test("without a run bridge the cards still prefill and never pretend to send", () => {
    const onPrefill = vi.fn();
    render(<EmptyState agent={MAIN_AGENT} onPrefill={onPrefill} onChangeAgent={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(FIRST_TASK_STARTERS[0].label) }),
    );
    expect(onPrefill).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "发送并开跑" })).not.toBeInTheDocument();
  });

  test("platform presets receive their own task cards", () => {
    const office = agentFromApiRow({ id: "office-assistant", name: "办公助手", preset: true });
    render(<EmptyState agent={office} onPrefill={() => {}} onChangeAgent={() => {}} />);
    for (const starter of PRESET_AGENT_STARTERS["office-assistant"] ?? []) {
      expect(screen.getByText(starter.prompt)).toBeInTheDocument();
    }
  });

  test("an agent without starters falls back to capability readiness instead of blank space", () => {
    const market = agentFromApiRow({
      id: "market-agent",
      name: "市场智能体",
      capabilityReadiness: {
        ready: false,
        needsAuthorization: ["notion"],
        requirements: [
          { slug: "notion", kind: "plugin", status: "needs_authorization" },
          { slug: "image-gen", kind: "skill", status: "ready" },
        ],
      },
    });
    render(<EmptyState agent={market} onPrefill={() => {}} onChangeAgent={() => {}} />);
    expect(screen.getByText("它带了这些能力")).toBeInTheDocument();
    expect(screen.getByText("notion")).toBeInTheDocument();
    expect(screen.getByText("待授权")).toBeInTheDocument();
    expect(screen.getByText(/直接把要办的事讲给它/)).toBeInTheDocument();
  });
});
