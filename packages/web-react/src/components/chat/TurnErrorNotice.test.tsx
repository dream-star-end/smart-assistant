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

test("OCV5-734 / P0-7: box_capacity_held waits silently without alert card or Box copy, auto-continues once, then falls back gently", () => {
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

  // Brief auto-wait period shows quiet inline status, never an interruption alert card or "Box" copy.
  const waiting = screen.getByTestId("box-capacity-waiting-status");
  expect(waiting).toHaveTextContent("上一步仍在收尾，马上自动继续…");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.body.textContent ?? "").not.toMatch(/\bBox\b|本轮暂时中断/);
  expect(onContinueInterrupted).not.toHaveBeenCalled();

  for (let i = 0; i < BOX_CAPACITY_HELD_WAIT_SECONDS; i++) {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  }

  expect(onContinueInterrupted).toHaveBeenCalledTimes(1);
  expect(onContinueInterrupted).toHaveBeenCalledWith(msg);
  expect(screen.queryByTestId("box-capacity-waiting-status")).toBeNull();
  // If still rendered after auto-continue, shows calm fallback without "Box" or redundant comfort note.
  expect(document.body.textContent ?? "").not.toMatch(/\bBox\b|等待时间已结束/);
  expect(screen.getByRole("button", { name: "继续" })).not.toBeDisabled();

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

test("P0-7: TurnErrorNotice strips internal Box name even when provided via fixedBody", () => {
  render(
    <TurnErrorNotice
      role="status"
      tone="attention"
      code="box_capacity_held"
      fixedBody="当前会话在 Box 上的前一步执行仍在收尾，本轮暂时中断；已有进度已保留，请稍后继续。"
      actions={() => []}
    />,
  );
  expect(document.body.textContent ?? "").not.toMatch(/\bBox\b/);
  expect(screen.getByText("前一步执行仍在收尾，已有进度已保留，请稍后继续。")).toBeInTheDocument();
});

test("OCV5-838: 限流/模型不可用错误提供次级 CTA「切换备用模型继续」并触发模型选择器", () => {
  const onContinue = vi.fn();
  const onOpenModelPicker = vi.fn();
  render(
    <TurnErrorNotice
      role="alert"
      tone="attention"
      code="rate_limited"
      actions={() => [{ label: "继续", onClick: onContinue }]}
      onOpenModelPicker={onOpenModelPicker}
    />,
  );
  const switchBtn = screen.getByRole("button", { name: "切换备用模型继续" });
  fireEvent.click(switchBtn);
  expect(onOpenModelPicker).toHaveBeenCalledTimes(1);
});
