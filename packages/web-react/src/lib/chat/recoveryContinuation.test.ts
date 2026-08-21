import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./model";
import {
  automaticTurnRecoveryTarget,
  recoverySkippedNotice,
} from "./socket";

describe("checkpoint recovery continuation", () => {
  it("automatically resumes an uncertain tool checkpoint instead of replaying the source", () => {
    const sourceId = "cm-uncertain-checkpoint";
    const messages: ChatMessage[] = [
      {
        id: sourceId,
        role: "user",
        text: "deploy",
        ts: 1,
        _source: "server",
        _routing: { model: "gpt-5.6-sol", effortLevel: null, teamMode: false },
      },
      {
        id: "process-completed",
        role: "runtime-event",
        text: "",
        ts: 2,
        _source: "server",
        _turnTapeProcess: true,
        _dispatchOutcome: "completed",
      },
      {
        id: "tool-uncertain",
        role: "tool",
        text: "",
        ts: 2,
        _source: "server",
        _completed: false,
        toolName: "Bash",
      },
      {
        id: "err-uncertain",
        role: "assistant",
        text: "temporary failure",
        ts: 3,
        _source: "server",
        _clientMessageId: sourceId,
        _errorCode: "upstream_failed",
      },
    ];

    expect(automaticTurnRecoveryTarget(messages, messages[3]!, "s-recovery"))
      .toMatchObject({
        user: messages[0],
        error: messages[3],
        mode: "checkpoint",
        rootClientMessageId: sourceId,
        attempt: 1,
      });
  });

  it("turns skipped recovery ACK reasons into visible, actionable feedback", () => {
    expect(recoverySkippedNotice("source_not_latest")).toContain("会话已有更新");
    expect(recoverySkippedNotice("completed_replay_forbidden")).toContain("没有重放原请求");
    expect(recoverySkippedNotice("source_tape_malformed")).toContain("校验断点记录失败");
    expect(recoverySkippedNotice("unknown_reason")).toContain("安全校验未通过");
  });
});
