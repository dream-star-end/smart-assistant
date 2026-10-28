import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ChatMessage } from "../lib/chat/model";
import { captureIdentityAttempt, resolveIdentity } from "../lib/resolvedIdentity";
import { type ChatCardActionsInput, useChatCardActions } from "./useChatCardActions";

// Codex 审查 #1214 r1 P1:超长消息在会话里只是占位行(原文在 sidecar,text 为空)。错误卡「修改消息」
// 经 resolveRetryTarget 拿到的就是这行;直接塞进输入框会写入空串、冲掉现有草稿。
const placeholder = {
  id: "u-long",
  role: "user",
  text: "",
  ts: 1,
  status: "error",
  _userPayloadDeferred: true,
  _deferredRetryEligible: true,
} as ChatMessage;

function setup(load: ChatCardActionsInput["loadExactUserMessage"]) {
  const auth = createMemoryAuthSession(() => {}, "alice-a");
  const input = {
    authRef: { current: auth },
    identity: resolveIdentity(captureIdentityAttempt(auth, "alice-a"), "alice"),
    demo: false,
    activeId: "s1",
    communityBlogEnabled: true,
    chat: {},
    agent: { id: "fixture" },
    loadExactUserMessage: vi.fn(load),
    setComposerPrefill: vi.fn(),
    toast: vi.fn(),
    openManage: vi.fn(), openBlog: vi.fn(), openPane: vi.fn(), openSettings: vi.fn(),
    setCollapsed: vi.fn(), setBoardOpen: vi.fn(),
  } as unknown as ChatCardActionsInput;
  const { result } = renderHook(() => useChatCardActions(input));
  return { input, edit: (msg: ChatMessage) => result.current.cardCallbacks.onEditResend!(msg) };
}

afterEach(cleanup);

it("「修改消息」遇到占位行:先取完整原文(与重试同一条水合路径)再填输入框", async () => {
  const { input, edit } = setup(async (m) => ({ ...m, text: "完整的超长原文", _userPayloadDeferred: undefined }));
  await edit(placeholder);
  expect(input.loadExactUserMessage).toHaveBeenCalledTimes(1);
  expect(input.loadExactUserMessage).toHaveBeenCalledWith(placeholder);
  expect(input.setComposerPrefill).toHaveBeenCalledTimes(1);
  expect(input.setComposerPrefill).toHaveBeenCalledWith(expect.objectContaining({ text: "完整的超长原文" }));
});

const loadFailures: Array<[string, ChatCardActionsInput["loadExactUserMessage"]]> = [
  ["取不到原文", async () => null],
  ["读取抛错", async () => Promise.reject(new Error("offline"))],
];

it.each(loadFailures)("%s:不动现有草稿,提示加载失败", async (_name, load) => {
  const { input, edit } = setup(load);
  await edit(placeholder);
  expect(input.setComposerPrefill).not.toHaveBeenCalled();
  expect(input.toast).toHaveBeenCalledWith("原始消息加载失败，请重试", "error");
});

it("普通消息照旧直接填入原文", async () => {
  const { input, edit } = setup(async (m) => m);
  await edit({ id: "u1", role: "user", text: "短消息", ts: 1 } as ChatMessage);
  expect(input.setComposerPrefill).toHaveBeenCalledWith(expect.objectContaining({ text: "短消息" }));
});
