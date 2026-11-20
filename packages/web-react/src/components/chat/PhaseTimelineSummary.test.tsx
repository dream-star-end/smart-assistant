import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { loadBeforeAll } from "../../test/moduleLoad";
import { preloadProcessStages } from "./lazyProcessStages";
import { ProcessDisclosure, preloadPhaseTimelineSummary, processSections } from "./ProcessDisclosure";
import { formatPhaseDuration } from "./PhaseTimelineSummary";
import { useState } from "react";

loadBeforeAll(preloadProcessStages);
loadBeforeAll(preloadPhaseTimelineSummary);

afterEach(cleanup);

function msg(id: string, role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text: "", ts: 1_700_000_000_000, ...extra };
}

function Harness({ messages, active = false, initialOpen = false }: { messages: ChatMessage[]; active?: boolean; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const sections = processSections(
    messages,
    (m) => [m],
    (m) => m.id,
  );
  return (
    <ProcessDisclosure
      sections={sections}
      active={active}
      open={open}
      setOpen={setOpen}
      detailOpen={(k) => Boolean(details[k])}
      setDetailOpen={(k, next) => setDetails((cur) => ({ ...cur, [k]: next }))}
      renderItem={(item) => <div data-testid={`raw-${item.id}`}>{item.toolName ?? item.role}</div>}
      keyOf={(item) => item.id}
      messagesOf={(item) => [item]}
    />
  );
}

const MULTI_PHASE_MESSAGES: ChatMessage[] = [
  msg("r1", "tool", { toolName: "Read", inputJson: { file_path: "src/index.ts" }, _completed: true, ts: 1_700_000_001_000, durationMs: 1_200 }),
  msg("r2", "tool", { toolName: "Grep", inputJson: { pattern: "SECRET_QUERY" }, _completed: true, ts: 1_700_000_003_000, durationMs: 800 }),
  msg("e1", "tool", { toolName: "Edit", inputJson: { file_path: "src/index.ts", old_string: "a", new_string: "b" }, _completed: true, ts: 1_700_000_005_000, durationMs: 1_500 }),
  msg("v1", "tool", { toolName: "Bash", inputJson: { command: "pnpm vitest run --secret-flag" }, _completed: true, ts: 1_700_000_008_000, durationMs: 3_000 }),
];

describe("PhaseTimelineSummary integration in ProcessDisclosure", () => {
  test("renders compact phase strip when collapsed and opens directly into clicked phase filter", () => {
    render(<Harness messages={MULTI_PHASE_MESSAGES} />);

    const strip = screen.getByTestId("phase-timeline-strip");
    expect(within(strip).getByTestId("phase-pill-explore")).toHaveTextContent("探索2");
    expect(within(strip).getByTestId("phase-pill-edit")).toHaveTextContent("编辑1");
    expect(within(strip).getByTestId("phase-pill-verify")).toHaveTextContent("验证1");
    expect(within(strip).getByTestId("phase-metric-files")).toHaveTextContent("改 1 文件");
    // Must never leak raw arguments or danger color inside disclosure
    expect(strip.textContent ?? "").not.toMatch(/SECRET_QUERY|secret-flag/);
    expect(document.querySelector("[data-testid=process-disclosure] .text-danger")).toBeNull();

    // Clicking the edit pill opens disclosure and filters directly to edit steps
    fireEvent.click(screen.getByTestId("phase-pill-edit"));
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByTestId("phase-timeline-strip")).not.toBeInTheDocument();

    const filterBar = screen.getByTestId("phase-filter-bar");
    expect(within(filterBar).getByTestId("phase-filter-edit")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("phase-group-header")).toHaveTextContent("代码与产物编辑");

    const filtered = screen.getByTestId("process-phase-filtered");
    expect(filtered).toHaveAttribute("data-phase-filter", "edit");
    expect(within(filtered).getAllByTestId("process-step-row")).toHaveLength(1);

    // Switching filter to explore shows the 2 explore steps
    fireEvent.click(screen.getByTestId("phase-filter-explore"));
    expect(screen.getByTestId("process-phase-filtered")).toHaveAttribute("data-phase-filter", "explore");
    expect(within(screen.getByTestId("process-phase-filtered")).getAllByTestId("process-step-row")).toHaveLength(2);

    // Resetting restores the chronological step view (single-section renders step rows directly without redundant group fold)
    fireEvent.click(screen.getByTestId("phase-filter-reset"));
    expect(screen.queryByTestId("process-phase-filtered")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("process-step-row")).toHaveLength(4);
  });

  test("hides compact strip and filter bar for simple single-step turns", () => {
    render(
      <Harness
        messages={[msg("only", "tool", { toolName: "Bash", inputJson: { command: "echo hi" }, _completed: true })]}
      />,
    );
    expect(screen.queryByTestId("phase-timeline-strip")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.queryByTestId("phase-filter-bar")).not.toBeInTheDocument();
  });

  test("marks active phase pill during a live running turn and separates running indicator from selected tab", () => {
    render(
      <Harness
        active
        initialOpen={false}
        messages={[
          msg("r1", "tool", { toolName: "Read", inputJson: { file_path: "src/a.ts" }, _completed: true }),
          msg("v1", "tool", { toolName: "Bash", inputJson: { command: "pnpm test" }, _completed: false }),
        ]}
      />,
    );
    const verifyCrumb = screen.getByTestId("phase-pill-verify");
    const exploreCrumb = screen.getByTestId("phase-pill-explore");
    expect(verifyCrumb).toHaveAttribute("data-phase-active", "true");
    expect(exploreCrumb).toHaveAttribute("data-phase-active", "false");
    expect(within(verifyCrumb).getByTestId("phase-active-dot-verify")).toHaveClass("oc-phase-active-dot");
    expect(within(exploreCrumb).queryByTestId("phase-active-dot-explore")).toBeNull();

    // Open disclosure: "全部" is aria-pressed="true", while "验证" is running (data-phase-active="true") with aria-pressed="false"
    fireEvent.click(screen.getByTestId("process-toggle"));
    const filterBar = screen.getByTestId("phase-filter-bar");
    expect(within(filterBar).getByTestId("phase-filter-all")).toHaveAttribute("aria-pressed", "true");
    const verifyFilter = within(filterBar).getByTestId("phase-filter-verify");
    expect(verifyFilter).toHaveAttribute("data-phase-active", "true");
    expect(verifyFilter).toHaveAttribute("aria-pressed", "false");
    expect(within(verifyFilter).getByTestId("phase-active-dot-verify")).toHaveClass("oc-phase-active-dot");
    expect(within(filterBar).queryByTestId("phase-active-dot-explore")).toBeNull();
  });

  test("formats phase durations in compact tabular form", () => {
    expect(formatPhaseDuration(undefined)).toBe("");
    expect(formatPhaseDuration(0)).toBe("");
    expect(formatPhaseDuration(40)).toBe("<0.1s");
    expect(formatPhaseDuration(800)).toBe("0.8s");
    expect(formatPhaseDuration(1_500)).toBe("1.5s");
    expect(formatPhaseDuration(2_000)).toBe("2s");
    expect(formatPhaseDuration(14_400)).toBe("14s");
    expect(formatPhaseDuration(425_000)).toBe("07:05");
    expect(formatPhaseDuration(1_294_000)).toBe("21:34");
    expect(formatPhaseDuration(3_785_000)).toBe("1:03:05");
  });
});
