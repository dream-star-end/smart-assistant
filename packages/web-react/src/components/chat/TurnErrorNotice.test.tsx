import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import {
  _resetBoxCapacityHoldAutoContinueForTest,
  BOX_CAPACITY_HELD_WAIT_SECONDS,
  TurnErrorNotice,
  TurnStatusCard,
} from "./TurnErrorNotice";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  _resetBoxCapacityHoldAutoContinueForTest();
});

test("OCV5-734: box_capacity_held disables Continue while waiting for slot release and auto-continues once", () => {
  vi.useFakeTimers();
  const onContinueInterrupted = vi.fn();
  const msg = {
    id: "e-box-hold-1",
    role: "assistant",
    text: "",
    ts: 2,
    _errorCode: "box_capacity_held",
    _clientMessageId: "u-box-hold",
  } as ChatMessage;
  const userMsg = {
    id: "u-box-hold",
    role: "user",
    text: "继续修",
    ts: 1,
    status: "error",
  } as ChatMessage;

  const { rerender } = render(
    <TurnStatusCard
      msg={msg}
      currentTurn={true}
      cb={{
        onContinueInterrupted,
        resolveInterruptedContinuation: () => userMsg,
      }}
    />,
  );

  const waitBtn = screen.getByRole("button", {
    name: new RegExp(`正在等待上一轮释放（${BOX_CAPACITY_HELD_WAIT_SECONDS}s）`),
  });
  expect(waitBtn).toBeDisabled();
  fireEvent.click(waitBtn);
  expect(onContinueInterrupted).not.toHaveBeenCalled();

  for (let i = 0; i < BOX_CAPACITY_HELD_WAIT_SECONDS; i++) {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  }

  expect(onContinueInterrupted).toHaveBeenCalledTimes(1);
  expect(onContinueInterrupted).toHaveBeenCalledWith(msg);
  expect(screen.getByTestId("box-capacity-released-notice")).toHaveTextContent(
    "上一轮已释放，已自动继续本条消息。",
  );

  // Re-rendering or advancing timers further must never auto-continue a second time.
  rerender(
    <TurnStatusCard
      msg={msg}
      currentTurn={true}
      cb={{
        onContinueInterrupted,
        resolveInterruptedContinuation: () => userMsg,
      }}
    />,
  );
  act(() => {
    vi.advanceTimersByTime(20_000);
  });
  expect(onContinueInterrupted).toHaveBeenCalledTimes(1);
});

test("non-box_capacity_held errors keep Continue immediately clickable without countdown", () => {
  const onContinue = vi.fn();
  render(
    <TurnErrorNotice
      role="alert"
      tone="attention"
      code="upstream_failed"
      actions={() => [{ label: "继续", onClick: onContinue }]}
    />,
  );
  const btn = screen.getByRole("button", { name: "继续" });
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn);
  expect(onContinue).toHaveBeenCalledTimes(1);
});
