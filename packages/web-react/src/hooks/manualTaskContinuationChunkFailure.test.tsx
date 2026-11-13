import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ChatMessage } from "../lib/chat/model";
import { captureIdentityAttempt, resolveIdentity } from "../lib/resolvedIdentity";
import { useChatCardActions, type ChatCardActionsInput } from "./useChatCardActions";

vi.mock("./manualTaskContinuationAction", () => { throw new Error("continuation chunk unavailable"); });
afterEach(cleanup);

test("a failed Continue chunk reports once and never falls back to task replay or send", async () => {
  const auth = createMemoryAuthSession(() => {}, "token");
  const user = { id: "chunk-user", role: "user", text: "保留原目标", ts: 1 } as ChatMessage;
  const error = { id: "chunk-error", role: "assistant", text: "", ts: 2,
    _errorCode: "insufficient_credits", _clientMessageId: user.id } as ChatMessage;
  const rows = [user, error];
  const sock = { getMessages: vi.fn((sessionId: string) => sessionId === "s1" ? rows : []),
    send: vi.fn(), continueInterruptedTurn: vi.fn() };
  const input = { activeId: "s1", agent: { id: "main" }, authRef: { current: auth },
    identity: resolveIdentity(captureIdentityAttempt(auth, "token"), "alice"),
    demo: false, communityBlogEnabled: false, chat: {}, sockRef: { current: sock },
    loadExactUserMessage: vi.fn(), send: vi.fn(), toast: vi.fn(),
  } as unknown as ChatCardActionsInput;
  const { result } = renderHook(() => useChatCardActions(input));
  expect(result.current.cardCallbacks.resolveInterruptedContinuation!(error)).toBe(user);
  await result.current.cardCallbacks.onContinueInterrupted!(error);
  expect(input.toast).toHaveBeenCalledTimes(1);
  expect(input.toast).toHaveBeenCalledWith("继续功能加载失败，请稍后再试", "error");
  expect(input.loadExactUserMessage).not.toHaveBeenCalled();
  expect(input.send).not.toHaveBeenCalled();
  expect(sock.send).not.toHaveBeenCalled();
  expect(sock.continueInterruptedTurn).not.toHaveBeenCalled();
  expect(rows).toEqual([user, error]);
});
