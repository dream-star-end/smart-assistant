import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./model";
import {
  automaticTurnRecoveryTarget,
  interruptedContinuationTarget,
  recoverySkippedNotice,
} from "./socket";

describe("checkpoint recovery continuation", () => {
  it("keeps a quota checkpoint available manually while refusing automatic recovery and an empty checkpoint", () => {
    const source: ChatMessage = {
      id: "cm-quota-checkpoint", role: "user", text: "continue the work", ts: 1,
      _source: "server",
      _routing: { model: "box-api-claude-opus-5-5", effortLevel: null, teamMode: false },
    };
    const progress: ChatMessage = {
      id: "quota-progress", role: "thinking", text: "saved progress", ts: 2,
      _source: "server",
    };
    const error: ChatMessage = {
      id: "quota-error", role: "assistant", text: "quota exhausted", ts: 3,
      _source: "server", _clientMessageId: source.id, _errorCode: "quota_exhausted",
    };
    const messages = [source, progress, error];
    expect(interruptedContinuationTarget(messages, error, "s-quota"))
      .toMatchObject({ user: source, mode: "checkpoint" });
    expect(automaticTurnRecoveryTarget(messages, error, "s-quota")).toBeUndefined();
    expect(interruptedContinuationTarget([source, error], error, "s-quota")).toBeUndefined();
    expect(interruptedContinuationTarget([source, { ...progress, _source: undefined }, error], error, "s-quota"))
      .toBeUndefined();
    const transient = { ...error, _errorCode: "rate_limited" };
    expect(automaticTurnRecoveryTarget([source, progress, transient], transient, "s-quota"))
      .toMatchObject({ mode: "checkpoint" });
  });
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
    expect(recoverySkippedNotice("source_tape_malformed")).toContain("刷新后再试");
    expect(recoverySkippedNotice("recovery_mode_mismatch")).toContain("从断点继续");
    expect(recoverySkippedNotice("automatic_checkpoint_unsafe")).toContain("手动从进度继续");
    expect(recoverySkippedNotice("unknown_reason")).toContain("安全校验未通过");
  });

  it("hides the manual continue CTA after a skip notice is attached to the source error", () => {
    const sourceId = "cm-skipped-checkpoint";
    const error: ChatMessage = {
      id: "err-skipped",
      role: "assistant",
      text: "interrupted",
      ts: 3,
      _source: "server",
      _clientMessageId: sourceId,
      _errorCode: "SERVICE_RESTART",
      _recoverySkippedNotice: recoverySkippedNotice("source_tape_malformed"),
    };
    const messages: ChatMessage[] = [
      {
        id: sourceId,
        role: "user",
        text: "continue the task",
        ts: 1,
        _source: "server",
        _routing: { model: "gpt-5.6-sol", effortLevel: null, teamMode: false },
      },
      {
        id: "process",
        role: "thinking",
        text: "working",
        ts: 2,
        _source: "server",
      },
      error,
    ];
    expect(interruptedContinuationTarget(messages, error, "s-skipped")).toBeUndefined();
  });
});
