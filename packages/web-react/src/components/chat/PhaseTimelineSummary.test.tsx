import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { loadBeforeAll } from "../../test/moduleLoad";
import { preloadProcessStages } from "./lazyProcessStages";
import { ProcessDisclosure, preloadPhaseTimelineSummary, processSections } from "./ProcessDisclosure";
import { formatPhaseDuration } from "./PhaseTimelineSummary";
import { extractStepSubtitle } from "./processStageList";
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
  test("OCV5-844: completed multi-step turn hides collapsed phase strip and steps icon, while expanded filter bar still filters phases", () => {
    render(<Harness messages={MULTI_PHASE_MESSAGES} active={false} />);

    // Completed & collapsed: only the single summary line, no explore/verify phase strip and no process-pane-steps button
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("phase-timeline-strip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-pane-steps")).not.toBeInTheDocument();

    // Expanding still shows the full interactive PhaseTimelineFilterBar
    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
    const filterBar = screen.getByTestId("phase-filter-bar");
    expect(within(filterBar).getByTestId("phase-filter-all")).toHaveAttribute("aria-pressed", "true");

    // Filtering by edit shows the 1 edit step
    fireEvent.click(screen.getByTestId("phase-filter-edit"));
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

  test("running turn manually collapsed still shows compact live phase strip and opens directly into clicked phase filter", () => {
    render(<Harness messages={MULTI_PHASE_MESSAGES} active initialOpen={false} />);

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
          msg("r2", "tool", { toolName: "Grep", inputJson: { pattern: "foo" }, _completed: true }),
          msg("e1", "tool", { toolName: "Edit", inputJson: { file_path: "src/a.ts", old_string: "a", new_string: "b" }, _completed: true }),
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

  test("OCV5-834: hides filter bar for short 2-3 step turns by default, and shows it when clicked from running collapsed strip", () => {
    const view = render(
      <Harness
        active={false}
        messages={[
          msg("r1", "tool", { toolName: "Read", inputJson: { file_path: "src/a.ts" }, _completed: true }),
          msg("v1", "tool", { toolName: "Bash", inputJson: { command: "pnpm test" }, _completed: true }),
        ]}
      />,
    );
    // Completed short turn: no collapsed strip and no filter bar when opened
    expect(screen.queryByTestId("phase-timeline-strip")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.queryByTestId("phase-filter-bar")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("process-step-row")).toHaveLength(2);
    view.unmount();

    // Running short turn collapsed: clicking a phase crumb opens directly into filter bar so user can reset
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
    fireEvent.click(screen.getByTestId("phase-pill-verify"));
    expect(screen.getByTestId("phase-filter-bar")).toBeInTheDocument();
    expect(screen.getByTestId("process-phase-filtered")).toHaveAttribute("data-phase-filter", "verify");
    fireEvent.click(screen.getByTestId("phase-filter-reset"));
    expect(screen.queryByTestId("phase-filter-bar")).not.toBeInTheDocument();
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

  test("OCV5-831 #7a/#7b/#9c: renders human step subtitles, single-line compact durations, and surface card wrapper", () => {
    const t0 = 1_700_000_000_000;
    const realMessages: ChatMessage[] = [
      msg("b1", "tool", {
        toolName: "mcp_openclaude-memory_oc_bash",
        inputJson: { command: "curl -s https://example.com/version", toolSummary: "核验线上版本与样式" },
        _completed: true,
        ts: t0 + 26_000,
        completedAt: t0 + 32_600,
        durationMs: 6_600,
      }),
      msg("c1", "tool", {
        toolName: "call_mcp_tool",
        inputJson: {
          ServerName: "openclaude-memory",
          ToolName: "task_comment",
          Arguments: { id: "OCV5-826", body: "已验证通过" },
        },
        _completed: true,
        ts: t0 + 33_000,
        completedAt: t0 + 34_800,
        durationMs: 1_800,
      }),
      msg("c2", "tool", {
        toolName: "mcp__openclaude-memory__task_comment",
        inputJson: { id: "OCV5-831", body: "补充截图" },
        _completed: true,
        ts: t0 + 35_000,
        completedAt: t0 + 36_200,
        durationMs: 1_200,
      }),
      msg("b2", "tool", {
        toolName: "mcp__openclaude-memory__oc_bash",
        inputJson: { command: "cd /app && pnpm vitest run --secret-flag" },
        _completed: true,
        ts: t0 + 37_000,
        completedAt: t0 + 48_000,
        durationMs: 11_000,
      }),
    ];

    render(
      <ProcessDisclosure
        sections={processSections(realMessages, (m) => [m], (m) => m.id)}
        active={false}
        open
        setOpen={() => {}}
        detailOpen={() => false}
        setDetailOpen={() => {}}
        renderItem={(item) => <div data-testid={`raw-${item.id}`}>{item.toolName}</div>}
        keyOf={(item) => item.id}
        messagesOf={(item) => [item]}
        bounds={{ startedAt: t0, endedAt: t0 + 49_000 }}
      />,
    );

    // OCV5-834: Codex frameless editorial activity stream (no bulky white card box, soft left rail, no 24px circle bubbles)
    const stages = screen.getByTestId("process-stages");
    expect(stages.className).not.toContain("oc-surface-card");
    expect(stages.className).toContain("oc-codex-rail");
    for (const iconNode of within(stages).getAllByTestId("process-step-node")) {
      expect(iconNode.className).toContain("size-4");
      expect(iconNode.className).not.toContain("rounded-full");
      expect(iconNode.className).not.toContain("ring-1");
    }

    // #7a: every step row displays action title + concise single-line muted subtitle
    const rows = screen.getAllByTestId("process-step-row");
    expect(rows).toHaveLength(4);

    const summaries = rows.map((row) => within(row).getByTestId("process-step-summary"));
    expect(summaries.map((node) => node.textContent)).toEqual([
      "核验线上版本与样式",
      "OCV5-826",
      "OCV5-831",
      "pnpm vitest",
    ]);
    for (const node of summaries) {
      expect(node.className).toContain("min-w-0");
      expect(node.className).toContain("truncate");
    }
    // Never leaks command flags
    expect(stages.textContent ?? "").not.toContain("--secret-flag");

    // #7b: split execution/wait duration stays strictly single-line (no flex-col) with full breakdown in title & tech details
    const firstDuration = within(rows[0]!).getByTestId("step-duration");
    expect(firstDuration.className).not.toContain("flex-col");
    expect(firstDuration.className).toContain("whitespace-nowrap");
    expect(firstDuration.className).toContain("tabular-nums");
    expect(firstDuration).toHaveTextContent("6.6s");
    expect(firstDuration.getAttribute("title")).toContain("工具执行 6.6 秒");
    expect(firstDuration.getAttribute("title")).toContain("此前生成与等待 26 秒");

    // Opening the step shows full split breakdown in tech detail header without duplicating step-duration testid
    fireEvent.click(within(rows[0]!).getAllByRole("button")[0]!);
    const tech = within(rows[0]!).getByTestId("process-step-tech");
    expect(within(tech).getByTestId("process-step-timing-detail")).toHaveTextContent("执行 6.6 秒 · 等待 26 秒");
    expect(within(tech).queryByTestId("step-duration")).toBeNull();
  });

  test("extractStepSubtitle avoids duplicating file names and ignores internal prompts", () => {
    const readMsg = msg("r1", "tool", { toolName: "Read", inputJson: { file_path: "/repo/src/index.ts" } });
    expect(extractStepSubtitle("Read", { file_path: "/repo/src/index.ts" }, "读取 index.ts", readMsg)).toBe("");

    const strArgsMsg = msg("c1", "tool", {
      toolName: "call_mcp_tool",
      inputJson: { ServerName: "openclaude-memory", ToolName: "task_comment", Arguments: '{"id":"OCV5-900"}' },
    });
    expect(extractStepSubtitle("mcp__openclaude-memory__task_comment", null, "任务单评论", strArgsMsg)).toBe("OCV5-900");

    const promptLeakMsg = msg("t1", "tool", {
      toolName: "Bash",
      inputJson: { command: "echo hi", description: "You are an internal prompt /home/agent/secret" },
    });
    expect(
      extractStepSubtitle("Bash", { command: "echo hi", description: "You are an internal prompt /home/agent/secret" }, "运行命令", promptLeakMsg),
    ).toBe("");
  });

  test("OCV5-834: collapses >= 3 consecutive completed read-only explore steps into a Codex cluster while keeping edits, errors, and running steps visible", () => {
    const messages: ChatMessage[] = [
      msg("r1", "tool", { toolName: "Read", inputJson: { file_path: "src/a.ts" }, _completed: true, ts: 1_700_000_001_000, durationMs: 200 }),
      msg("r2", "tool", { toolName: "Read", inputJson: { file_path: "src/b.ts" }, _completed: true, ts: 1_700_000_002_000, durationMs: 300 }),
      msg("s1", "tool", { toolName: "Grep", inputJson: { pattern: "ChatHeader" }, _completed: true, ts: 1_700_000_003_000, durationMs: 400 }),
      msg("r3", "tool", { toolName: "Read", inputJson: { file_path: "src/c.ts" }, _completed: true, ts: 1_700_000_004_000, durationMs: 500 }),
      msg("e1", "tool", { toolName: "Edit", inputJson: { file_path: "src/a.ts", old_string: "1", new_string: "2" }, _completed: true, ts: 1_700_000_005_000, durationMs: 900 }),
      msg("bad-r", "tool", { toolName: "Read", inputJson: { file_path: "src/missing.ts" }, _completed: true, error: true, output: "ENOENT", ts: 1_700_000_006_000 }),
      msg("v1", "tool", { toolName: "Bash", inputJson: { command: "pnpm vitest run" }, _completed: true, ts: 1_700_000_007_000, durationMs: 1_200 }),
    ];

    render(<Harness messages={messages} initialOpen />);

    // The 4 consecutive completed read/grep steps fold into one clean Codex cluster row
    const cluster = screen.getByTestId("process-explore-cluster");
    expect(cluster).toHaveTextContent("已探索 4 处文件与代码");
    // Edit, errored Read, and Bash remain directly visible (3 step rows before expanding cluster)
    expect(screen.getAllByTestId("process-step-row")).toHaveLength(3);

    // Expanding the cluster reveals all 4 underlying explore step rows
    fireEvent.click(within(cluster).getAllByRole("button")[0]!);
    expect(within(cluster).getAllByTestId("process-step-row")).toHaveLength(4);
    expect(screen.getAllByTestId("process-step-row")).toHaveLength(7);
  });

  test("OCV5-834: pure read or pure search runs use crisp Codex labels and running explore steps never fold", () => {
    const view = render(
      <Harness
        active
        initialOpen
        messages={[
          msg("r1", "tool", { toolName: "Read", inputJson: { file_path: "src/a.ts" }, _completed: true }),
          msg("r2", "tool", { toolName: "Read", inputJson: { file_path: "src/b.ts" }, _completed: true }),
          msg("r3", "tool", { toolName: "Read", inputJson: { file_path: "src/c.ts" }, _completed: true }),
          msg("r4", "tool", { toolName: "Read", inputJson: { file_path: "src/d.ts" }, _completed: false }),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByTestId("process-explore-cluster")).toHaveTextContent("已读取 3 个文件");
    // The 4th running Read remains directly visible outside the cluster
    expect(screen.getAllByTestId("process-step-row")).toHaveLength(1);
    view.unmount();

    render(
      <Harness
        initialOpen
        messages={[
          msg("s1", "tool", { toolName: "Grep", inputJson: { pattern: "one" }, _completed: true }),
          msg("s2", "tool", { toolName: "Grep", inputJson: { pattern: "two" }, _completed: true }),
          msg("s3", "tool", { toolName: "WebSearch", inputJson: { query: "three" }, _completed: true }),
        ]}
      />,
    );
    expect(screen.getByTestId("process-explore-cluster")).toHaveTextContent("已检索 3 处代码与资料");
  });
});
