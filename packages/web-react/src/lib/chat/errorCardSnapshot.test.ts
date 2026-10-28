import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { friendlyBridgeErrorMessage } from "./pure";
import { applyServerIncremental, mergeFullServerWins } from "../persist";
import { commitErrorCardSnapshot, errorLabel, freezeErrorCardSnapshots } from "./render";

function message(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    text: "",
    ts: 1,
    ...partial,
  } as ChatMessage;
}

describe("commitErrorCardSnapshot", () => {
  test("service_restart is silent and a later code cannot turn it into a card", () => {
    const row = message({ _errorCode: "service_restart", text: "子进程被信号 SIGTERM 终止" });
    commitErrorCardSnapshot(row);
    expect(row._errorCardSnapshot).toEqual({ disposition: "silent" });
    row._errorCode = "runner_crashed";
    row.text = "子进程崩溃";
    commitErrorCardSnapshot(row);
    expect(row._errorCardSnapshot).toEqual({ disposition: "silent" });
  });

  test("the first real card snapshot is not rewritten when the code, text, or waiver changes", () => {
    const row = message({ _errorCode: "upstream_failed", text: "boom" });
    commitErrorCardSnapshot(row);
    const first = row._errorCardSnapshot;
    expect(first?.disposition).toBe("card");
    if (first?.disposition !== "card") return;
    expect(first.tone).toBe("red");
    row._errorCode = "model_capacity";
    row.text = "容量满了";
    row.usage = { waived: true };
    commitErrorCardSnapshot(row);
    expect(row._errorCardSnapshot).toEqual(first);
  });

  test("user stop and container recycle do not commit a card", () => {
    for (const code of ["stopped", "user_cancelled", "codex_container_recycled"]) {
      const row = message({ _errorCode: code, text: "raw" });
      commitErrorCardSnapshot(row);
      expect(row._errorCardSnapshot).toEqual({ disposition: "silent" });
    }
  });

  test("a canonical tape row with a different id keeps the first card snapshot", () => {
    const snapshot = {
      disposition: "card" as const,
      tone: "red" as const,
      title: "模型服务暂时中断",
      message: "任务执行暂时中断，你的消息已保留，可直接重试。",
    };
    const local = [message({
      id: "m-local",
      _clientMessageId: "u1",
      _errorCode: "upstream_failed",
      text: snapshot.message,
      _errorCardSnapshot: snapshot,
    })];
    const server = [message({
      id: "srv-1",
      _source: "server",
      _clientMessageId: "u1",
      _errorCode: "model_capacity",
      text: "容量满了",
      _seq: 2,
    })];
    for (const merged of [
      mergeFullServerWins(server, local),
      applyServerIncremental(local, server),
    ]) {
      const row = merged.find((item) => item.id === "srv-1");
      expect(row?._errorCardSnapshot).toEqual(snapshot);
    }
  });

  test("history sync does not commit a card for a source turn that is still recovering", () => {
    const source = message({
      id: "srv-err",
      _clientMessageId: "u1",
      _errorCode: "model_capacity",
      text: "busy",
    });
    const child = message({
      id: "m-recover-1",
      role: "user",
      _automaticRecovery: true,
      _recoveryOfClientMessageId: "u1",
      text: "retry",
    });
    freezeErrorCardSnapshots([source, child]);
    expect(source._errorCardSnapshot).toBeUndefined();
    freezeErrorCardSnapshots([source]);
    expect(source._errorCardSnapshot?.disposition).toBe("card");
  });

  test("a deferred source error is held instead of committed before the recovery decision", () => {
    const source = message({
      id: "srv-err",
      _clientMessageId: "u1",
      _errorCode: "model_capacity",
      text: "busy",
    });
    freezeErrorCardSnapshots([source], "u1");
    expect(source._errorCardSnapshot).toBeUndefined();
    expect(source._errorHeldForRecovery).toBe(true);
  });

  test("a stopped recovery lineage stays silent when the source error arrives later", () => {
    const source = message({
      id: "srv-err",
      _clientMessageId: "u1",
      _errorCode: "upstream_failed",
      text: "boom",
    });
    freezeErrorCardSnapshots([source], undefined, new Set(["u1"]));
    expect(source._errorCardSnapshot).toEqual({ disposition: "silent" });
    expect(source._errorHeldForRecovery).toBeUndefined();
  });
});

const BOX_DETAIL =
  'API Error: 409 {"error":{"code":"BOX_REPLAY_PENDING","message":"previous Box call still resolving"}}';
const BOX_PARTIAL = "博客大纲已写完，正在排版。\n\n[turn failed: BOX_REPLAY_PENDING]";
const softBoxSnapshot = {
  disposition: "card" as const,
  tone: "yellow" as const,
  title: "结果正在收尾",
  message: "远端结果仍在确认中。已生成的内容已保留；稍后刷新即可看到完整结果，不会重复扣费。",
};

describe("sealed crashed tape does not keep a BOX_REPLAY_PENDING soft card", () => {
  test("commit recomputes a soft snapshot once the tape is a sealed failure", () => {
    const row = message({
      _clientMessageId: "u1",
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorDetail: BOX_DETAIL,
      _turnTapeComplete: true,
      _dispatchOutcome: "crashed",
      _errorCardSnapshot: softBoxSnapshot,
    });
    commitErrorCardSnapshot(row);
    expect(row._errorCardSnapshot).toMatchObject({
      disposition: "card",
      tone: "red",
      title: errorLabel("engine_error"),
      message: friendlyBridgeErrorMessage("engine_error"),
    });
    expect(JSON.stringify(row._errorCardSnapshot)).not.toMatch(/结果正在收尾|仍在确认|稍后刷新|不会重复扣费/);
  });

  test("commit leaves an unsealed soft snapshot and any other sealed snapshot unchanged", () => {
    const open = message({
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorDetail: BOX_DETAIL,
      _dispatchOutcome: "crashed",
      _errorCardSnapshot: softBoxSnapshot,
    });
    commitErrorCardSnapshot(open);
    expect(open._errorCardSnapshot).toEqual(softBoxSnapshot);

    const other = {
      disposition: "card" as const,
      tone: "red" as const,
      title: "任务执行失败",
      message: "第一次看到的失败说明，不可改写。",
    };
    const sealedOther = message({
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorDetail: BOX_DETAIL,
      _turnTapeComplete: true,
      _dispatchOutcome: "crashed",
      _errorCardSnapshot: other,
    });
    commitErrorCardSnapshot(sealedOther);
    expect(sealedOther._errorCardSnapshot).toEqual(other);
  });

  test("freeze commits a hard failure card for a sealed crash and replaces a soft title already on that row", () => {
    const fresh = message({
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorDetail: BOX_DETAIL,
      _turnTapeComplete: true,
      _dispatchOutcome: "crashed",
    });
    freezeErrorCardSnapshots([fresh]);
    expect(fresh._errorCardSnapshot).toMatchObject({
      disposition: "card",
      title: "任务执行失败",
      message: friendlyBridgeErrorMessage("engine_error"),
    });

    const stale = message({
      _errorCode: "ENGINE_ERROR",
      text: "",
      _errorDetail: BOX_DETAIL,
      _turnTapeComplete: true,
      _dispatchOutcome: "executed_error",
      _errorCardSnapshot: softBoxSnapshot,
    });
    freezeErrorCardSnapshots([stale]);
    expect(stale._errorCardSnapshot).toMatchObject({
      disposition: "card",
      title: "任务执行失败",
    });
    expect(JSON.stringify(stale._errorCardSnapshot)).not.toContain("结果正在收尾");

    const open = message({
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorDetail: BOX_DETAIL,
      _errorCardSnapshot: softBoxSnapshot,
    });
    freezeErrorCardSnapshots([open]);
    expect(open._errorCardSnapshot).toEqual(softBoxSnapshot);
  });

  test("full and incremental merge do not move a soft snapshot onto a sealed failure row", () => {
    const local = [message({
      id: "m-local",
      _clientMessageId: "u1",
      _errorCode: "ENGINE_ERROR",
      text: "博客大纲已写完，正在排版。",
      _errorCardSnapshot: softBoxSnapshot,
    })];
    const server = [message({
      id: "srv-1",
      _source: "server",
      _clientMessageId: "u1",
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorDetail: BOX_DETAIL,
      _turnTapeComplete: true,
      _dispatchOutcome: "crashed",
      _timelineRecord: true,
      _seq: 2,
    })];
    for (const merged of [
      mergeFullServerWins(server, local),
      applyServerIncremental(local, server),
    ]) {
      const row = merged.find((item) => item.id === "srv-1");
      expect(row?._errorCardSnapshot).toBeUndefined();
      expect(row?._turnTapeComplete).toBe(true);
      expect(row?._dispatchOutcome).toBe("crashed");
      expect(row?.text).toBe(BOX_PARTIAL);
    }
  });

  test("the same sealed id does not inherit the soft snapshot, while an open row and a different title still do", () => {
    const softLocal = message({
      id: "srv-same",
      _clientMessageId: "u1",
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorCardSnapshot: softBoxSnapshot,
    });
    const sealedServer = message({
      id: "srv-same",
      _source: "server",
      _clientMessageId: "u1",
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorDetail: BOX_DETAIL,
      _turnTapeComplete: true,
      _dispatchOutcome: "not_accepted",
      _timelineRecord: true,
      _seq: 3,
    });
    expect(mergeFullServerWins([sealedServer], [softLocal]).find((item) => item.id === "srv-same")?._errorCardSnapshot).toBeUndefined();

    const openServer = message({
      id: "srv-open",
      _source: "server",
      _clientMessageId: "u-open",
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorDetail: BOX_DETAIL,
      _seq: 4,
    });
    const openLocal = message({
      id: "m-open",
      _clientMessageId: "u-open",
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _errorCardSnapshot: softBoxSnapshot,
    });
    expect(mergeFullServerWins([openServer], [openLocal]).find((item) => item.id === "srv-open")?._errorCardSnapshot).toEqual(softBoxSnapshot);

    const hard = {
      disposition: "card" as const,
      tone: "red" as const,
      title: "任务执行失败",
      message: "第一次看到的失败说明，不可改写。",
    };
    const hardLocal = message({
      id: "m-hard",
      _clientMessageId: "u-hard",
      _errorCode: "ENGINE_ERROR",
      _errorCardSnapshot: hard,
    });
    const hardServer = message({
      id: "srv-hard",
      _source: "server",
      _clientMessageId: "u-hard",
      _errorCode: "ENGINE_ERROR",
      text: BOX_PARTIAL,
      _turnTapeComplete: true,
      _dispatchOutcome: "crashed",
      _seq: 5,
    });
    expect(mergeFullServerWins([hardServer], [hardLocal]).find((item) => item.id === "srv-hard")?._errorCardSnapshot).toEqual(hard);
  });
});
