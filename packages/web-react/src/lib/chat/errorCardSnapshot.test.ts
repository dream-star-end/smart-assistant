import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { commitErrorCardSnapshot } from "./render";

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
});
