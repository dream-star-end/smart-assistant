import { describe, expect, test } from "vitest";
import {
  LIVE_ACTIVITY_FALLBACK,
  LIVE_ACTIVITY_LABELS,
  formatLiveActivityAction,
  mappedLiveActivityLabel,
} from "./liveActivityLabel";

describe("formatLiveActivityAction（活动行只显示中文动作，不堆工具名/路径/参数）", () => {
  test("empty → empty（交给思考中文案）", () => {
    expect(formatLiveActivityAction("")).toBe("");
    expect(formatLiveActivityAction("   ")).toBe("");
    expect(formatLiveActivityAction(null)).toBe("");
    expect(formatLiveActivityAction(undefined)).toBe("");
  });

  test("shell/bash → 执行 Shell，丢掉命令", () => {
    expect(formatLiveActivityAction("Bash npx tsc -b")).toBe("执行 Shell");
    expect(formatLiveActivityAction("Shell git status")).toBe("执行 Shell");
    expect(formatLiveActivityAction("exec_command ls -la")).toBe("执行 Shell");
    expect(formatLiveActivityAction("AwaitShell")).toBe("执行 Shell");
  });

  test("任务/计划更新 → 更新任务", () => {
    expect(formatLiveActivityAction("TaskUpdate id=OCV5-1")).toBe("更新任务");
    expect(formatLiveActivityAction("TodoWrite todos=[...]")).toBe("更新任务");
    expect(formatLiveActivityAction("mcp__openclaude-memory__task_update OCV5-1")).toBe(
      "更新任务",
    );
    expect(formatLiveActivityAction("EnterPlanMode")).toBe("更新任务");
  });

  test("读写/编辑文件 → 读取文件 / 写入文件，丢掉绝对路径", () => {
    expect(
      formatLiveActivityAction(
        "StrReplace /home/agent/work/display-hardening/packages/commercial/src/db/pgSessionsBackend.ts",
      ),
    ).toBe("写入文件");
    expect(formatLiveActivityAction("Read foo.ts")).toBe("读取文件");
    expect(formatLiveActivityAction("Write /tmp/out.md")).toBe("写入文件");
    expect(formatLiveActivityAction("Edit packages/web-react/src/App.tsx")).toBe("写入文件");
    expect(formatLiveActivityAction("Delete /home/agent/.openclaude/generated/x.txt")).toBe(
      "写入文件",
    );
  });

  test("搜索 → 搜索代码", () => {
    expect(formatLiveActivityAction("Grep keepalive")).toBe("搜索代码");
    expect(formatLiveActivityAction("Glob **/*.ts")).toBe("搜索代码");
    expect(formatLiveActivityAction("WebSearch live activity")).toBe("搜索代码");
    expect(formatLiveActivityAction("search_tool skill_search memory")).toBe("搜索代码");
    expect(formatLiveActivityAction("use_tool skill_search")).toBe("搜索代码");
  });

  test("委派/子任务 → 运行子任务", () => {
    expect(formatLiveActivityAction("Task 修复活动行")).toBe("运行子任务");
    expect(formatLiveActivityAction("Agent description=...")).toBe("运行子任务");
    expect(formatLiveActivityAction("delegate_task coding-assistant")).toBe("运行子任务");
    expect(formatLiveActivityAction("子任务 Task 运行中")).toBe("运行子任务");
    expect(formatLiveActivityAction("子任务运行中")).toBe("运行子任务");
    expect(formatLiveActivityAction("mcp__openclaude-memory__delegate_tasks")).toBe(
      "运行子任务",
    );
  });

  test("未知工具 / 思考原文 / 路径 → 执行操作，永不回显参数", () => {
    expect(formatLiveActivityAction("Frobnicate --flag /secret")).toBe(LIVE_ACTIVITY_FALLBACK);
    expect(
      formatLiveActivityAction("I am inspecting the reducer next"),
    ).toBe(LIVE_ACTIVITY_FALLBACK);
    expect(formatLiveActivityAction("/home/agent/secret.env")).toBe(LIVE_ACTIVITY_FALLBACK);
    expect(formatLiveActivityAction("CallMcpTool skill_search coding")).toBe("执行操作");
  });

  test("已是稳定中文标签则原样（可带被误拼的尾巴也会收成标签）", () => {
    expect(formatLiveActivityAction("执行 Shell")).toBe("执行 Shell");
    expect(formatLiveActivityAction("写入文件 /still/a/path.ts")).toBe("写入文件");
    expect(formatLiveActivityAction("执行操作")).toBe("执行操作");
  });

  test("输出永不包含绝对路径或原始工具名", () => {
    const samples = [
      "StrReplace /home/agent/work/x.ts",
      "Bash npm test -- packages/web-react",
      "TaskUpdate {\"id\":\"OCV5-1\"}",
    ];
    for (const sample of samples) {
      const label = formatLiveActivityAction(sample);
      expect(LIVE_ACTIVITY_LABELS as readonly string[]).toContain(label);
      expect(label).not.toMatch(/StrReplace|Bash|TaskUpdate|\//);
    }
  });

  test("mappedLiveActivityLabel 只映射裸工具名", () => {
    expect(mappedLiveActivityLabel("StrReplace")).toBe("写入文件");
    expect(mappedLiveActivityLabel("TaskUpdate")).toBe("更新任务");
    expect(mappedLiveActivityLabel("Task")).toBe("运行子任务");
    expect(mappedLiveActivityLabel("run_terminal_command")).toBe("执行 Shell");
    expect(mappedLiveActivityLabel("read_file")).toBe("读取文件");
    expect(mappedLiveActivityLabel("search_replace")).toBe("写入文件");
    expect(mappedLiveActivityLabel("Frobnicate")).toBeNull();
    expect(mappedLiveActivityLabel("CallMcpTool")).toBeNull();
  });
});
