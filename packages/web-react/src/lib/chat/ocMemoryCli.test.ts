import { describe, expect, test } from "vitest";
import {
  hasDelegateBackgroundSignal,
  ocMemoryOp,
  parseOcMemoryCommand,
  shouldShowDelegateRunning,
} from "./ocMemoryCli";

describe("ocMemoryOp", () => {
  test("认 env 前缀 / 绝对路径 / bash -lc 包装里的 delegate", () => {
    expect(ocMemoryOp("oc-memory delegate --goal x")).toBe("delegate");
    expect(ocMemoryOp('HOME=/home/agent oc-memory delegate --goal "修卡片"')).toBe("delegate");
    expect(ocMemoryOp("/usr/local/bin/oc-memory delegate --goal x")).toBe("delegate");
    expect(
      ocMemoryOp(`/bin/bash -lc 'HOME=/home/agent oc-memory delegate --goal "修卡片"'`),
    ).toBe("delegate");
  });

  test("不把 delegate-wait / core-search 误认成 delegate", () => {
    expect(ocMemoryOp("oc-memory delegate-wait dlgjob-1")).toBe("delegate-wait");
    expect(ocMemoryOp("oc-memory core-search foo")).toBe("core-search");
    expect(ocMemoryOp("oc-memory request-review --draft x")).toBe("request-review");
  });
});

describe("parseOcMemoryCommand", () => {
  test("解析 --goal / --model / --agent-id", () => {
    const parsed = parseOcMemoryCommand(
      'HOME=/x oc-memory delegate --allow-self --model grok-build --agent-id main --goal "修卡片"',
    );
    expect(parsed?.op).toBe("delegate");
    expect(parsed?.goalRaw).toBe("修卡片");
    expect(parsed?.model).toBe("grok-build");
    expect(parsed?.agentId).toBe("main");
  });

  test("heredoc 取全文绑定、首行展示", () => {
    const cmd = `oc-memory delegate --goal "$(cat <<'EOF'
【装配任务续】把 integrate 合进去
第二行不要当标题
EOF
)"`;
    const parsed = parseOcMemoryCommand(cmd);
    expect(parsed?.op).toBe("delegate");
    expect(parsed?.goalRaw).toBe("【装配任务续】把 integrate 合进去");
    expect(parsed?.goalFull).toContain("第二行不要当标题");
  });

  test("delegate-wait 取 jobId，不产出 goal 组", () => {
    const parsed = parseOcMemoryCommand(
      "OPENCLAUDE_GATEWAY_PORT=18790 oc-memory delegate-wait dlgjob-abc",
    );
    expect(parsed?.op).toBe("delegate-wait");
    expect(parsed?.jobId).toBe("dlgjob-abc");
  });
});

describe("shouldShowDelegateRunning", () => {
  test("空输出且未完成 → 运行中", () => {
    expect(
      shouldShowDelegateRunning({
        command: "oc-memory delegate --goal x",
        output: "",
        completed: false,
        stripped: "",
      }),
    ).toBe(true);
  });

  test("CLI status=running 文本 → 运行中", () => {
    expect(
      shouldShowDelegateRunning({
        command: "oc-memory delegate --goal x",
        output: "status=running jobId=dlgjob-1",
        completed: true,
        stripped: "status=running jobId=dlgjob-1",
      }),
    ).toBe(true);
  });

  test("Process is still running 信号 → 运行中", () => {
    expect(
      shouldShowDelegateRunning({
        command: "oc-memory delegate --goal x",
        output: "Moved to background. Process is still running.",
        completed: true,
        stripped: "",
      }),
    ).toBe(true);
  });

  test("其它 oc-* 或已完成空输出 → 否", () => {
    expect(
      shouldShowDelegateRunning({
        command: 'oc-lit search "x"',
        output: "",
        completed: true,
        stripped: "",
      }),
    ).toBe(false);
    expect(
      shouldShowDelegateRunning({
        command: "oc-memory delegate --goal x",
        output: "",
        completed: true,
        stripped: "",
      }),
    ).toBe(false);
  });

  test("hasDelegateBackgroundSignal 认 isBackground 信封", () => {
    expect(hasDelegateBackgroundSignal('{"isBackground":true,"success":{"stdout":""}}')).toBe(true);
  });
});
