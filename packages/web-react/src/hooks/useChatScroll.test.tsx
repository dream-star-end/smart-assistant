import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Message } from "../lib/types";
import { useChatScroll } from "./useChatScroll";
import type { UseChatSocket } from "./useChatSocket";

function makeScroller(initial: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const el = document.createElement("div");
  let scrollHeight = initial.scrollHeight;
  let clientHeight = initial.clientHeight;
  let scrollTop = initial.scrollTop;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
    set: (v: number) => {
      scrollHeight = v;
    },
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
    set: (v: number) => {
      clientHeight = v;
    },
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  return el as HTMLDivElement & {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  };
}

function makeFakeChat(version: number): UseChatSocket {
  return {
    version,
    loadOlderHistory: vi.fn(async () => ({ ok: true as const, loaded: 0 })),
    getSession: vi.fn(() => undefined),
  } as unknown as UseChatSocket;
}

function makeStableDeps() {
  return {
    archiveRequestTokenRef: { current: 0 },
    archiveScrollAnchorRef: { current: null },
    setArchiveError: vi.fn(),
    setArchiveLoading: vi.fn(),
    settleArchiveAnchor: vi.fn(),
    sockRef: { current: null },
  };
}

describe("useChatScroll (U4)", () => {
  test("用户上滑离开底部后发送新消息：立刻恢复粘滞并跳到新消息底部", () => {
    const el = makeScroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    const scrollRef = { current: el };
    const deps = makeStableDeps();
    const msg1: Message = { id: "m1", role: "user", content: "hi", createdAt: "10:00" };

    const { result, rerender } = renderHook(
      (props: { version: number; wsSending: boolean; messages: Message[] }) =>
        useChatScroll({
          activeId: "s1",
          archiveLoading: false,
          ...deps,
          chat: makeFakeChat(props.version),
          chatScrollParent: el,
          demo: false,
          inWorkspace: false,
          messages: props.messages,
          scrollRef,
          sending: false,
          streamText: "",
          wsSending: props.wsSending,
        }),
      { initialProps: { version: 1, wsSending: false, messages: [msg1] } },
    );

    act(() => {
      result.current.markUserChatScroll();
      el.scrollTop = 120;
      result.current.onChatScroll();
    });
    expect(result.current.stickToBottomRef.current).toBe(false);

    act(() => {
      result.current.scrollToBottomOnSend();
    });
    el.scrollHeight = 1180;
    const msg2: Message = { id: "m2", role: "user", content: "follow up", createdAt: "10:01" };
    rerender({ version: 2, wsSending: true, messages: [msg1, msg2] });

    expect(result.current.stickToBottomRef.current).toBe(true);
    expect(el.scrollTop).toBe(780);
  });

  test("非滚动按键（Ctrl+C 复制、按钮上按 Space）不会冻结流式与回合结束自动贴底", () => {
    const el = makeScroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    const scrollRef = { current: el };
    const deps = makeStableDeps();
    const emptyMessages: Message[] = [];
    const btn = document.createElement("button");
    el.appendChild(btn);

    const { result, rerender } = renderHook(
      (props: { version: number; wsSending: boolean }) =>
        useChatScroll({
          activeId: "s1",
          archiveLoading: false,
          ...deps,
          chat: makeFakeChat(props.version),
          chatScrollParent: el,
          demo: false,
          inWorkspace: false,
          messages: emptyMessages,
          scrollRef,
          sending: false,
          streamText: "",
          wsSending: props.wsSending,
        }),
      { initialProps: { version: 1, wsSending: true } },
    );

    act(() => {
      result.current.markUserChatScroll({ key: "c", ctrlKey: true, target: el });
      result.current.markUserChatScroll({ key: " ", target: btn });
    });

    el.scrollHeight = 1320;
    rerender({ version: 2, wsSending: true });
    expect(el.scrollTop).toBe(920);
    expect(result.current.stickToBottomRef.current).toBe(true);
  });

  test("用户在流式期间主动上滑阅读：流式帧与回合完成都不抢滚动；在底部时回合完成补帧贴底", () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
    const cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    try {
      const el = makeScroller({ scrollHeight: 1200, clientHeight: 400, scrollTop: 800 });
      const scrollRef = { current: el };
      const deps = makeStableDeps();
      const emptyMessages: Message[] = [];

      const { result, rerender } = renderHook(
        (props: { version: number; wsSending: boolean }) =>
          useChatScroll({
            activeId: "s1",
            archiveLoading: false,
            ...deps,
            chat: makeFakeChat(props.version),
            chatScrollParent: el,
            demo: false,
            inWorkspace: false,
            messages: emptyMessages,
            scrollRef,
            sending: false,
            streamText: "",
            wsSending: props.wsSending,
          }),
        { initialProps: { version: 1, wsSending: true } },
      );

      // 主动上滑阅读：不抢滚动
      act(() => {
        result.current.markUserChatScroll({ key: "PageUp", target: el });
        el.scrollTop = 240;
        result.current.onChatScroll();
      });
      expect(result.current.stickToBottomRef.current).toBe(false);

      el.scrollHeight = 1500;
      rerender({ version: 2, wsSending: true });
      expect(el.scrollTop).toBe(240);

      el.scrollHeight = 1600;
      rerender({ version: 3, wsSending: false });
      while (rafCallbacks.length > 0) {
        const cb = rafCallbacks.shift();
        cb?.(16);
      }
      expect(el.scrollTop).toBe(240);

      // 回到底部开始下一轮：回合完成过程折叠/新交付挂载后 rAF 补齐贴底
      act(() => {
        el.scrollTop = 1200;
        result.current.markUserChatScroll();
        result.current.onChatScroll();
      });
      expect(result.current.stickToBottomRef.current).toBe(true);

      rerender({ version: 4, wsSending: true });
      el.scrollHeight = 1750;
      rerender({ version: 5, wsSending: false });
      expect(el.scrollTop).toBe(1350);

      // 模拟回合完成提交后下一帧内交付卡高度继续撑高
      el.scrollHeight = 1880;
      while (rafCallbacks.length > 0) {
        const cb = rafCallbacks.shift();
        cb?.(32);
      }
      expect(el.scrollTop).toBe(1480);
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
    }
  });
});
