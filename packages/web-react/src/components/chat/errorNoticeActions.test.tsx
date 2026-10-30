import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { USER_ERROR_CATALOG } from "@openclaude/protocol/browser";
import type { ChatMessage } from "../../lib/chat/model";
import { AssistantCard } from "./cards";

vi.mock("../../lib/clientFriction", () => ({
  reportClientFriction: vi.fn(), reportClientFrictionOnce: vi.fn(),
}));
afterEach(cleanup);

// Commercial keeps its existing Alert card; exercise its real callback wiring
// instead of importing the selfhost-only lazy ErrorNotice action selector.
describe("t1360u commercial error-card Continue inventory", () => {
  test.each(Object.values(USER_ERROR_CATALOG))("$code continues with zero/partial output and either billing receipt", (userError) => {
    for (const text of ["", "已经完成第一步"]) for (const waived of [false, true]) {
      const go = vi.fn();
      const regenerate = vi.fn();
      const retry = vi.fn();
      const msg = { id: "a", role: "assistant", text, ts: 1, _errorCode: userError.code,
        usage: { waived }, _errorCardSnapshot: { disposition: "card", tone: "red",
          title: "任务执行失败", message: userError.message } } as ChatMessage;
      const view = render(<AssistantCard msg={msg}
        ctx={{ isLast: true, sending: false, inActiveTurn: true }}
        cb={{ onContinueInterrupted: go, resolveInterruptedContinuation: () => ({ id: "u", role: "user", text: "原任务", ts: 0 }),
          onRegenerate: regenerate, onRetrySend: retry, onTopUp: vi.fn() }} />);
      const action = screen.getByRole("button", { name: "继续", exact: true });
      expect(screen.queryByRole("button", { name: /^(重试|重新尝试|重新发送)$/ })).toBeNull();
      fireEvent.click(action);
      expect(go).toHaveBeenCalledTimes(1);
      expect(go).toHaveBeenCalledWith(msg);
      expect(regenerate).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      view.unmount();
    }
  });
  test("missing source and historical errors never replay the latest task", () => {
    for (const inActiveTurn of [false, true]) {
      const view = render(<AssistantCard
        msg={{ id: "a", role: "assistant", text: "部分回答", ts: 1, _errorCode: "engine_error" }}
        ctx={{ isLast: true, sending: false, inActiveTurn }}
        cb={{ onRegenerate: vi.fn(), onRetrySend: vi.fn(), onContinueInterrupted: vi.fn(),
          resolveRetryTarget: () => ({ id: "u", role: "user", text: "原任务", ts: 0 }) }} />);
      expect(screen.queryByRole("button", { name: /^(继续|重试|重新尝试|重新发送)$/ })).toBeNull();
      view.unmount();
    }
  });
});
