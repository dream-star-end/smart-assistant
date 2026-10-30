import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ChatMessage } from "../lib/chat/model";
import { splitStoppedNarration } from "../components/chat/turnSegment";
import { captureIdentityAttempt, resolveIdentity } from "../lib/resolvedIdentity";
import { useChatCardActions, type ChatCardActionsInput } from "./useChatCardActions";

const user = { id: "u1", role: "user", text: "完成原目标", ts: 1, status: "error" } as ChatMessage;
const error = { id: "e1", role: "assistant", text: "", ts: 2, _errorCode: "insufficient_credits", _clientMessageId: "u1" } as ChatMessage;
function setup(rows = [user, error]) {
  const auth = createMemoryAuthSession(() => {}, "token");
  const sock = { getMessages: vi.fn(() => rows), continueInterruptedTurn: vi.fn(), send: vi.fn(async () => true) };
  const input = {
    activeId: "s1", agent: { id: "main" }, authRef: { current: auth },
    identity: resolveIdentity(captureIdentityAttempt(auth, "token"), "alice"),
    demo: false, communityBlogEnabled: false, chat: {}, sockRef: { current: sock },
    loadExactUserMessage: vi.fn(async (message: ChatMessage) => message), send: vi.fn(async () => true), toast: vi.fn(),
  } as unknown as ChatCardActionsInput;
  return { auth, input, sock };
}
afterEach(cleanup);

test("manual Continue retains original goal and media in the same session, without replay", async () => {
  const original = { ...user, _media: [{ kind: "image", url: "https://example.test/original.png" }] } as ChatMessage;
  const { input, sock } = setup([original, error]);
  const { result } = renderHook(() => useChatCardActions(input));
  await result.current.cardCallbacks.onContinueInterrupted!(error);
  expect(input.send).toHaveBeenCalledWith(expect.stringContaining("不要重新执行已经完成的步骤"), original._media,
    undefined, "继续", undefined, { sessionId: "s1" });
  expect(vi.mocked(input.send).mock.calls[0]![0]).toContain(original.text);
  expect(vi.mocked(input.send).mock.calls[0]![0]).not.toBe(original.text);
  expect(sock.continueInterruptedTurn).not.toHaveBeenCalled();
  expect(sock.getMessages("s1")).toEqual([original, error]);
});

test("double clicks hydrate and submit only once; late hydration cannot cross sessions", async () => {
  const { input } = setup();
  let finish!: (value: ChatMessage) => void;
  vi.mocked(input.loadExactUserMessage).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result, rerender } = renderHook(({ value }) => useChatCardActions(value), { initialProps: { value: input } });
  const old = result.current.cardCallbacks.onContinueInterrupted!;
  const first = old(error);
  const second = old(error);
  expect(input.loadExactUserMessage).toHaveBeenCalledTimes(1);
  rerender({ value: { ...input, activeId: "s2" } });
  finish(user);
  await Promise.all([first, second]);
  expect(input.send).not.toHaveBeenCalled();
  await old(error);
  expect(input.loadExactUserMessage).toHaveBeenCalledTimes(1);
});

test("identity changes and a newer user revoke a pending Continue", async () => {
  for (const change of ["identity", "new-user"] as const) {
    const rows = [user, error];
    const { input, auth } = setup(rows);
    let finish!: (value: ChatMessage) => void;
    vi.mocked(input.loadExactUserMessage).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useChatCardActions(input));
    const pending = result.current.cardCallbacks.onContinueInterrupted!(error);
    if (change === "identity") auth.commitToken(auth.beginIdentity(), "bob");
    else rows.push({ ...user, id: "u2", text: "新任务" });
    finish(user);
    await pending;
    expect(input.send).not.toHaveBeenCalled();
    unmount();
  }
});


test("zero-output Continue freezes original advisor routing after a later team preference", async () => {
  const routing = { model: "claude-original", teamMode: false, effortLevel: "high" as const,
    collabMode: "advisor" as const, advisorModel: "advisor-original", collabConfigVersion: "original-config" };
  const original = { ...user, _routing: routing };
  const { input, sock } = setup([original, error]);
  const { result } = renderHook(() => useChatCardActions(input));
  await result.current.cardCallbacks.onContinueInterrupted!(error);
  expect(sock.send).toHaveBeenCalledWith(expect.objectContaining({ sessId: "s1", agentId: "main",
    displayText: "继续", ...routing, text: expect.stringContaining("原任务目标") }));
  expect(input.send).not.toHaveBeenCalled();
  expect(sock.getMessages("s1")).toEqual([original, error]);
});


test("a split stopped view hydrates its canonical human source and retains same-session media/routing", async () => {
  const original = { ...user, _media: [{ kind: "image", url: "https://example.test/context.png" }],
    _routing: { model: "glm-5.2", teamMode: false, effortLevel: "high" } } as ChatMessage;
  const stopped = { ...error, _errorCode: "USER_CANCELLED", text: "已经完成前半段" };
  const tool = { id: "completed-tool", role: "tool", text: "", ts: 3, _completed: true,
    _clientMessageId: original.id } as ChatMessage;
  const rows = [original, stopped, tool];
  const view = splitStoppedNarration(rows).at(-1)!;
  const { input, sock } = setup(rows);
  const { result } = renderHook(() => useChatCardActions(input));
  expect(result.current.cardCallbacks.resolveInterruptedContinuation!(view)).toBe(original);
  await result.current.cardCallbacks.onContinueInterrupted!(view);
  expect(input.loadExactUserMessage).toHaveBeenCalledWith(original);
  expect(sock.send).toHaveBeenCalledWith(expect.objectContaining({ sessId: "s1", agentId: "main",
    ...original._routing, displayText: "继续", media: original._media, text: expect.stringContaining(original.text) }));
  expect(sock.continueInterruptedTurn).not.toHaveBeenCalled();
  expect(sock.getMessages("s1")).toEqual(rows);
});

test("checkpoint continuation receives the canonical raw error instead of a presentation clone", async () => {
  const original = { ...user, _routing: { model: "glm-5.2", teamMode: false, effortLevel: "high" } } as ChatMessage;
  const tool = { id: "durable-read", role: "tool", text: "", ts: 2, toolName: "Read", output: "saved",
    _completed: true, _source: "server", _turnTapeId: "tape", _clientMessageId: original.id,
    _toolEffect: { authority: "gateway-v1", registryEntrySha256: "a".repeat(64), safety: "read_only", outcome: "completed" } } as ChatMessage;
  const canonical = { ...error, _source: "server", _errorCode: "MODEL_AUTHORITY_EXPIRED", _turnTapeComplete: true } as ChatMessage;
  const { input, sock } = setup([original, tool, canonical]);
  const { result } = renderHook(() => useChatCardActions(input));
  await result.current.cardCallbacks.onContinueInterrupted!({ ...canonical });
  expect(sock.continueInterruptedTurn).toHaveBeenCalledWith({ sessId: "s1", agentId: "main", errorMessageId: canonical.id });
  expect(sock.send).not.toHaveBeenCalled();
  expect(input.send).not.toHaveBeenCalled();
});
