import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { applyServerIncremental, mergeFullServerWins } from "../persist";
import { commitErrorCardSnapshot, freezeErrorCardSnapshots } from "./render";

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
