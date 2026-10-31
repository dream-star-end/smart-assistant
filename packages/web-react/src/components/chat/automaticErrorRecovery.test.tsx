import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { USER_ERROR_CATALOG } from "@openclaude/protocol/browser";
import { AssistantCard, RecoveredStepContext } from "./cards";
import { errorNoticeActions } from "./errorNoticeActions";
import type { ChatMessage } from "../../lib/chat/model";

afterEach(cleanup);
const codes = ["rate_limited", "upstream_failed", "upstream_timeout", "network_error",
  "service_restart", "platform_credential_expired", "box_capacity_held", "engine_error", "internal_error"];

test.each(codes)("%s recovered: muted record, details on hover, no error card or user action", (code) => {
  render(<RecoveredStepContext.Provider value><AssistantCard
    msg={{ id: "error", role: "assistant", text: "", ts: 1,
      _errorCode: code, _errorDetail: "request-id" } as ChatMessage}
    ctx={{ isLast: false, sending: false, inActiveTurn: false }} cb={{}}
  /></RecoveredStepContext.Provider>);
  const line = screen.getByTestId("automatic-recovery-record");
  expect(line).toHaveClass("text-faint");
  expect(line.title).toContain(code);
  expect(line.textContent).not.toContain(code);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(USER_ERROR_CATALOG[code]!.message).not.toMatch(/请.*(?:重试|刷新|重新发送|精简|换模型|检查连接)/);
});

test("exhaustion gives one-click retry through continuation, never replays the original task", () => {
  const resume = vi.fn();
  const replay = vi.fn();
  const actions = errorNoticeActions({ msg: { id: "end" } as ChatMessage,
    cb: { onRetrySend: replay }, isLastTurn: true, waived: false,
    continueInterrupted: resume, userError: USER_ERROR_CATALOG.automatic_retry_exhausted! });
  render(<button type="button" onClick={actions[0]!.onClick}>{actions[0]!.label}</button>);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(resume).toHaveBeenCalledTimes(1);
  expect(replay).not.toHaveBeenCalled();
});

test("oversized attachment opens its original composer for split upload", () => {
  const edit = vi.fn();
  const source = { id: "source", role: "user", text: "附件" } as ChatMessage;
  const actions = errorNoticeActions({ msg: { id: "end" } as ChatMessage,
    cb: { onEditResend: edit }, editTarget: source, isLastTurn: true, waived: false,
    userError: USER_ERROR_CATALOG.request_too_large! });
  expect(actions.map((action) => action.label)).toEqual(["分批上传"]);
  actions[0]!.onClick();
  expect(edit).toHaveBeenCalledWith(source);
});

test.each([
  ["context_too_long", "本会话内容已超过模型的上下文上限。可以精简这条消息，或在上方切换支持更长上下文的模型后继续。"],
  ["platform_credential_expired", "平台为本轮签发的模型临时凭证已过期，本轮已停止，不会自动重试，也不是你的账号或登录问题。请直接再发一条消息继续。"],
  ["box_capacity_held", "上一轮在 Box 上的执行仍在收尾，本条消息未开始处理，不会自动重试。请稍后直接再发一条。"],
])("%s legacy platform hint is never shown as an assistant answer", (code, text) => {
  render(<AssistantCard msg={{ id: "old-error", role: "assistant", text, ts: 1, _errorCode: code } as ChatMessage}
    ctx={{ isLast: true, sending: false, inActiveTurn: true }} cb={{}} />);
  expect(screen.queryByText(text)).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(USER_ERROR_CATALOG[code]!.message);
});
