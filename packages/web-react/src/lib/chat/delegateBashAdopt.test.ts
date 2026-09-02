import { describe, expect, test } from "vitest";
import { createSession } from "./model";
import { applyOutboundMessage } from "./reducer";
import type { OutboundMessageWire } from "./frames";

function sess() {
  return createSession({ id: "s1", agentId: "main" });
}

function msgFrame(over: Record<string, unknown>): OutboundMessageWire {
  return {
    type: "outbound.message",
    sessionKey: "agent:main:webchat:dm:s1",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    blocks: [],
    isFinal: false,
    ...over,
  } as unknown as OutboundMessageWire;
}

describe("Bash oc-memory delegate 收成单张 agent-group", () => {
  test("env 前缀 Bash delegate + 同 runId progress 只留一张组卡", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "cursor-tool-delegate",
            inputJson: {
              command: 'HOME=/home/agent oc-memory delegate --allow-self --model grok-build --goal "修卡片"',
            },
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    expect(s.messages.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(0);

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-mth54kr2-09f1f0e1",
            agentId: "main",
            goal: "修卡片",
            phase: "start",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-mth54kr2-09f1f0e1",
            agentId: "main",
            goal: "修卡片",
            phase: "tool",
            toolName: "TaskOutput",
            block: {
              kind: "tool_use",
              blockId: "call-da907440-6068-45e2-b977-c94ad710620b-64",
              toolName: "TaskOutput",
              inputJson: {
                task_ids: ["call-7fc87448-146b-411e-973e-a9271d19fe32-63"],
                timeout_ms: 300000,
                description: "",
              },
            },
          },
        ],
      }),
    );

    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(0);
    const group = s.messages.find((m) => m.role === "agent-group")!;
    expect(group._delegateRunId).toBe("dlg-mth54kr2-09f1f0e1");
    expect(group.childBlocks).toHaveLength(1);
    expect(group.childBlocks?.[0].blockId).toBe("call-da907440-6068-45e2-b977-c94ad710620b-64");
  });

  test("heredoc --goal 仍收成组卡", () => {
    const s = sess();
    const command = `oc-memory delegate --model grok-build --goal "$(cat <<'EOF'
【装配任务续】把 integrate 合进去
更多说明
EOF
)"`;
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [{ kind: "tool_use", toolName: "Bash", blockId: "bash-heredoc", inputJson: { command } }],
      }),
    );
    const group = s.messages.find((m) => m.role === "agent-group");
    expect(group).toBeTruthy();
    expect(group?.text).toContain("【装配任务续】");
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-heredoc",
            agentId: "main",
            goal: "【装配任务续】把 integrate 合进去\n更多说明",
            phase: "start",
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(0);
  });

  test("两条不同 blockId 的 TaskOutput child 不去重成一张", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-dlg",
            inputJson: { command: 'oc-memory delegate --goal "双卡"' },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-dual",
            agentId: "main",
            goal: "双卡",
            phase: "start",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-dual",
            phase: "tool",
            block: {
              kind: "tool_use",
              blockId: "call-task-a",
              toolName: "TaskOutput",
              inputJson: { task_ids: ["call-bash-1"], description: "" },
            },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 4,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-dual",
            phase: "tool",
            block: {
              kind: "tool_use",
              blockId: "call-task-b",
              toolName: "TaskOutput",
              inputJson: { task_ids: ["call-bash-1"], description: "" },
            },
          },
        ],
      }),
    );
    const group = s.messages.find((m) => m.role === "agent-group")!;
    const ids = (group.childBlocks ?? []).map((c) => c.blockId);
    expect(ids).toEqual(["call-task-a", "call-task-b"]);
  });

  test("delegate-wait 不误建新组；对上 jobId 则绑进已有组", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-dlg",
            inputJson: { command: 'oc-memory delegate --goal "修卡片"' },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "tool_result",
            toolUseBlockId: "bash-dlg",
            output: JSON.stringify({ status: "running", jobId: "dlgjob-abc" }),
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-wait",
            inputJson: { command: "oc-memory delegate-wait dlgjob-abc" },
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    expect(s.messages.filter((m) => m.blockId === "bash-wait")).toHaveLength(0);
  });

  test("delegate-wait 对不上 jobId 保持普通工具卡", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-wait-orphan",
            inputJson: { command: "oc-memory delegate-wait dlgjob-unknown" },
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(0);
    expect(s.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(s.messages[0].toolName).toBe("Bash");
  });

  test("progress 无 start 帧、仅 phase=tool 仍 adopt 进组", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-dlg",
            inputJson: { command: 'oc-memory delegate --goal "无 start"' },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-no-start",
            agentId: "main",
            goal: "无 start",
            phase: "tool",
            block: {
              kind: "tool_use",
              blockId: "call-wait",
              toolName: "TaskOutput",
              inputJson: { task_ids: ["call-1"], description: "" },
            },
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(0);
    const group = s.messages.find((m) => m.role === "agent-group")!;
    expect(group._delegateRunId).toBe("dlg-no-start");
    expect(group.childBlocks?.map((c) => c.blockId)).toEqual(["call-wait"]);
  });

  test("CLI stdout status=running jobId= 可把后续 delegate-wait 绑进组", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-dlg",
            inputJson: { command: 'oc-memory delegate --goal "修卡片"' },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "tool_result",
            toolUseBlockId: "bash-dlg",
            output: JSON.stringify({
              success: { stdout: "status=running jobId=dlgjob-cli\n", stderr: "", exitCode: 0 },
              isBackground: true,
            }),
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-wait",
            inputJson: { command: "oc-memory delegate-wait dlgjob-cli" },
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    expect(s.messages.find((m) => m.blockId === "bash-wait")).toBeUndefined();
    expect(s.messages.find((m) => m.role === "agent-group")?._delegateJobId).toBe("dlgjob-cli");
  });

  test("run_terminal_command 形态同样收成组卡", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "run_terminal_command",
            blockId: "grok-dlg",
            inputJson: { command: 'oc-memory delegate --model grok-build --goal "修卡片"' },
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    expect(s.messages[0].text).toContain("修卡片");
  });

  test("delegate-wait 的 tool_result 不再新建工具卡", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-dlg",
            inputJson: { command: 'oc-memory delegate --goal "修卡片"' },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "tool_result",
            toolUseBlockId: "bash-dlg",
            output: JSON.stringify({ status: "running", jobId: "dlgjob-abc" }),
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-wait",
            inputJson: { command: "oc-memory delegate-wait dlgjob-abc" },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 4,
        blocks: [
          {
            kind: "tool_result",
            toolUseBlockId: "bash-wait",
            toolName: "Bash",
            output: "status=done jobId=dlgjob-abc",
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    expect(s.messages.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(s.messages.filter((m) => m.blockId === "bash-wait")).toHaveLength(0);
  });

  test("core-search 不收成组", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Bash",
            blockId: "bash-search",
            inputJson: { command: "oc-memory core-search 委派" },
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(0);
    expect(s.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});
