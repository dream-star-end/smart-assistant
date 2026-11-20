import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import type { StepTiming } from "../../lib/chat/stepTiming";
import { buildPhaseTimeline, classifyMessagePhase } from "./phaseTimeline";

function msg(id: string, role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text: "", ts: 1_700_000_000_000, ...extra };
}

describe("classifyMessagePhase", () => {
  test("classifies explore tools (read/grep/glob/web/lit/memory/git-read)", () => {
    expect(classifyMessagePhase(msg("1", "tool", { toolName: "Read", inputJson: { file_path: "src/app.ts" } }))).toBe("explore");
    expect(classifyMessagePhase(msg("2", "tool", { toolName: "Grep", inputJson: { pattern: "foo" } }))).toBe("explore");
    expect(classifyMessagePhase(msg("3", "tool", { toolName: "Glob", inputJson: { pattern: "*.ts" } }))).toBe("explore");
    expect(classifyMessagePhase(msg("4", "tool", { toolName: "WebSearch", inputJson: { query: "vitest" } }))).toBe("explore");
    expect(classifyMessagePhase(msg("5", "tool", { toolName: "Bash", inputJson: { command: "oc-lit search transformer" } }))).toBe("explore");
    expect(classifyMessagePhase(msg("6", "tool", { toolName: "Bash", inputJson: { command: "oc-memory core-search --query arch" } }))).toBe("explore");
    expect(classifyMessagePhase(msg("7", "tool", { toolName: "Bash", inputJson: { command: "git diff --stat" } }))).toBe("explore");
    expect(classifyMessagePhase(msg("8", "tool", { toolName: "Bash", inputJson: { command: "cat README.md" } }))).toBe("explore");
  });

  test("classifies edit tools (edit/write/patch/heredoc/slides/docx/xlsx/report/media)", () => {
    expect(classifyMessagePhase(msg("1", "tool", { toolName: "Edit", inputJson: { file_path: "src/a.ts", old_string: "a", new_string: "b" } }))).toBe("edit");
    expect(classifyMessagePhase(msg("2", "tool", { toolName: "Write", inputJson: { file_path: "src/b.ts", content: "x" } }))).toBe("edit");
    expect(classifyMessagePhase(msg("3", "tool", { toolName: "Bash", inputJson: { command: "cat > notes.md <<'EOF'\nhi\nEOF" } }))).toBe("edit");
    expect(classifyMessagePhase(msg("4", "tool", { toolName: "Bash", inputJson: { command: "oc-slides deck.qmd -o deck.pptx" } }))).toBe("edit");
    expect(classifyMessagePhase(msg("5", "tool", { toolName: "Bash", inputJson: { command: "oc-xlsx data.json -o report.xlsx" } }))).toBe("edit");
    expect(classifyMessagePhase(msg("6", "tool", { toolName: "Bash", inputJson: { command: "oc-docx doc.md -o out.docx" } }))).toBe("edit");
    expect(classifyMessagePhase(msg("7", "tool", { toolName: "codex:imageGeneration", inputJson: { type: "imageGeneration" } }))).toBe("edit");
  });

  test("classifies verify tools (bash test/build/script and browser verification)", () => {
    expect(classifyMessagePhase(msg("1", "tool", { toolName: "Bash", inputJson: { command: "pnpm test" } }))).toBe("verify");
    expect(classifyMessagePhase(msg("2", "tool", { toolName: "Bash", inputJson: { command: "npx tsc --noEmit" } }))).toBe("verify");
    expect(classifyMessagePhase(msg("3", "tool", { toolName: "Bash", inputJson: { command: "oc-browser screenshot" } }))).toBe("verify");
    expect(classifyMessagePhase(msg("4", "tool", { toolName: "mcp__browser__browser_snapshot" }))).toBe("verify");
    expect(
      classifyMessagePhase(msg("5", "tool", { toolName: "mcp__openclaude-memory__oc_bash", inputJson: { command: "vitest run" } })),
    ).toBe("verify");
    expect(
      classifyMessagePhase(msg("6", "tool", { toolName: "mcp__openclaude-memory__oc_grep", inputJson: { pattern: "foo" } })),
    ).toBe("explore");
  });

  test("classifies collab tools (agent-group, delegate, swarm, Task)", () => {
    expect(classifyMessagePhase(msg("1", "agent-group", { _delegate: true }))).toBe("collab");
    expect(classifyMessagePhase(msg("2", "delegate-progress"))).toBe("collab");
    expect(classifyMessagePhase(msg("3", "tool", { toolName: "Task" }))).toBe("collab");
    expect(classifyMessagePhase(msg("4", "tool", { toolName: "mcp__openclaude-memory__delegate_tasks" }))).toBe("collab");
    expect(classifyMessagePhase(msg("5", "tool", { toolName: "Bash", inputJson: { command: "oc-memory delegate --goal audit" } }))).toBe("collab");
    expect(classifyMessagePhase(msg("6", "tool", { toolName: "SwarmManage" }))).toBe("collab");
    expect(classifyMessagePhase(msg("7", "tool", { toolName: "post_message" }))).toBe("collab");
  });

  test("classifies plan/thinking and ignores non-work roles", () => {
    expect(classifyMessagePhase(msg("1", "thinking"))).toBe("plan");
    expect(classifyMessagePhase(msg("2", "plan"))).toBe("plan");
    expect(classifyMessagePhase(msg("3", "tool", { toolName: "TodoWrite" }))).toBe("plan");
    expect(classifyMessagePhase(msg("4", "user"))).toBeNull();
    expect(classifyMessagePhase(msg("5", "assistant"))).toBeNull();
    expect(classifyMessagePhase(msg("6", "goal"))).toBeNull();
    expect(classifyMessagePhase(msg("7", "tool", { _turnStatusRecord: true }))).toBeNull();
  });
});

describe("buildPhaseTimeline", () => {
  test("groups multi-phase turn with counts, failed counts, changed files, timings, runs, and summary", () => {
    const messages: ChatMessage[] = [
      msg("r1", "tool", { toolName: "Read", inputJson: { file_path: "src/a.ts" }, _completed: true }),
      msg("r2", "tool", { toolName: "Grep", inputJson: { pattern: "token" }, _completed: true }),
      msg("e1", "tool", { toolName: "Edit", inputJson: { file_path: "src/a.ts", old_string: "1", new_string: "2" }, _completed: true }),
      msg("e2", "tool", { toolName: "Write", inputJson: { file_path: "src/b.ts", content: "export const x = 1;" }, _completed: true }),
      msg("v1", "tool", { toolName: "Bash", inputJson: { command: "vitest run" }, _completed: true, error: true }),
      msg("e3", "tool", { toolName: "Edit", inputJson: { file_path: "src/a.ts", old_string: "2", new_string: "3" }, _completed: true }),
      msg("v2", "tool", { toolName: "Bash", inputJson: { command: "vitest run" }, _completed: true }),
      msg("c1", "agent-group", { _delegate: true, _completed: true, _delegateStatus: "ok" }),
    ];

    const timings = new Map<string, StepTiming>([
      ["r1", { ms: 1_200 }],
      ["r2", { ms: 800 }],
      ["e1", { ms: 1_500 }],
      ["e2", { ms: 1_000 }],
      ["e3", { ms: 500 }],
      ["v1", { ms: 4_000 }],
      ["v2", { ms: 3_500 }],
    ]);

    const timeline = buildPhaseTimeline(messages, { stepTimings: timings, active: false });
    expect(timeline.totalSteps).toBe(8);
    expect(timeline.totalFailed).toBe(1);
    expect(timeline.activePhase).toBeNull();
    expect(timeline.showCompactBar).toBe(true);
    expect(timeline.showFilterBar).toBe(true);

    // Aggregated distinct phases in first-seen order
    expect(timeline.phases.map((p) => p.kind)).toEqual(["explore", "edit", "verify", "collab"]);
    expect(timeline.phases[0]).toMatchObject({ kind: "explore", stepCount: 2, failedCount: 0, durationMs: 2_000 });
    expect(timeline.phases[1]).toMatchObject({ kind: "edit", stepCount: 3, changedFileCount: 2, durationMs: 3_000 });
    expect(timeline.phases[2]).toMatchObject({ kind: "verify", stepCount: 2, failedCount: 1, durationMs: 7_500 });
    expect(timeline.phases[3]).toMatchObject({ kind: "collab", stepCount: 1, durationMs: undefined });

    // Chronological runs preserve explore -> edit -> verify -> edit -> verify -> collab
    expect(timeline.runs.map((r) => r.kind)).toEqual(["explore", "edit", "verify", "edit", "verify", "collab"]);

    expect(timeline.metrics).toEqual({
      exploreCount: 2,
      editCount: 3,
      changedFileCount: 2,
      commandCount: 2,
      collabCount: 1,
      planCount: 0,
    });

    expect(timeline.summaryText).toContain("探索 → 编辑 → 验证 → 协作");
    expect(timeline.summaryText).toContain("检索 2 次");
    expect(timeline.summaryText).toContain("改动 2 个文件");
    expect(timeline.summaryText).toContain("执行 2 条命令");
    expect(timeline.summaryText).toContain("协作 1 项");
  });

  test("stays quiet on a single-step turn and never fabricates duration", () => {
    const timeline = buildPhaseTimeline([
      msg("v1", "tool", { toolName: "Bash", inputJson: { command: "ls -la" }, _completed: true }),
    ]);
    expect(timeline.showCompactBar).toBe(false);
    expect(timeline.showFilterBar).toBe(false);
    expect(timeline.phases).toHaveLength(1);
    expect(timeline.phases[0]!.durationMs).toBeUndefined();
  });

  test("marks active phase during live running turn", () => {
    const timeline = buildPhaseTimeline(
      [
        msg("r1", "tool", { toolName: "Read", inputJson: { file_path: "a.ts" }, _completed: true }),
        msg("v1", "tool", { toolName: "Bash", inputJson: { command: "pnpm build" }, _completed: false }),
      ],
      { active: true },
    );
    expect(timeline.activePhase).toBe("verify");
    expect(timeline.phases.find((p) => p.kind === "verify")?.active).toBe(true);
    expect(timeline.phases.find((p) => p.kind === "explore")?.completed).toBe(true);
    expect(timeline.summaryText).toContain("当前处于命令与验证");
  });
});
