import { describe, expect, test, vi } from "vitest";
import { USER_ERROR_CATALOG } from "@openclaude/protocol/browser";
import type { ChatMessage } from "../../lib/chat/model";
import { errorNoticeActions } from "./errorNoticeActions";

describe("t1360u error-card Continue inventory", () => {
  test.each(Object.values(USER_ERROR_CATALOG))("$code keeps Continue first regardless of output or waiver", (userError) => {
    for (const text of ["", "已经完成第一步"]) for (const waived of [false, true]) {
      const go = vi.fn();
      const regenerate = vi.fn();
      const retry = vi.fn();
      const actions = errorNoticeActions({
        msg: { id: "a", role: "assistant", text, ts: 1 } as ChatMessage,
        cb: { onRegenerate: regenerate, onRetrySend: retry, onTopUp: vi.fn() },
        userError, isLastTurn: true, waived, continueInterrupted: go,
        topUp: { label: "购买加量包", intent: "pack" },
      });
      expect(actions[0]?.label).toBe("继续");
      expect(actions.map((action) => action.label)).not.toEqual(expect.arrayContaining(["重新尝试", "重试", "重新发送"]));
      actions[0]!.onClick();
      expect(go).toHaveBeenCalledTimes(1);
      expect(regenerate).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
    }
  });
  test("missing source and historical errors never fall back to replaying the latest task", () => {
    for (const isLastTurn of [false, true]) {
      const actions = errorNoticeActions({
        msg: { id: "a", role: "assistant", text: "部分回答", ts: 1 } as ChatMessage,
        cb: { onRegenerate: vi.fn(), onRetrySend: vi.fn() },
        preciseRetryTarget: { id: "u", role: "user", text: "原任务", ts: 0 } as ChatMessage,
        userError: USER_ERROR_CATALOG.engine_error!, isLastTurn, waived: false,
      });
      expect(actions).toEqual([]);
    }
  });
});
