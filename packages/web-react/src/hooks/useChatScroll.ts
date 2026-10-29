/**
 * Chat scroll: stick-to-bottom controller, archive anchor correction, direct user scroll and older-history loading
 *
 * Moved verbatim out of App() (App.tsx) — FINDINGS §10, OCV5-472. App calls this hook at the
 * exact position the statements had, so React hook order and every value are unchanged.
 */
import { useRef, useMemo, useCallback, useEffect, useLayoutEffect } from "react";
import { createStickToBottomController } from "../components/chat/stickToBottom";
import { attachWheelFence } from "../components/chat/wheelFence";
import { captureVisibleVirtualRowAnchor, restoreVisibleVirtualRowAnchor } from "../components/chat/archivePaging";
import type { VisibleVirtualRowAnchor } from "../components/chat/archivePaging";
import type { UseChatSocket } from "./useChatSocket";
import type { Message } from "../lib/types";

export type ChatScrollInput = {
  activeId: string | undefined;
  archiveLoading: boolean;
  archiveRequestTokenRef: React.RefObject<number>;
  archiveScrollAnchorRef: React.RefObject<{ token: number; capturedScrollTop: number; timelineGeneration: number | undefined; row: VisibleVirtualRowAnchor | null; ready: boolean; cancelled: boolean; restoring: boolean; settle: () => void; } | null>;
  chat: UseChatSocket;
  chatScrollParent: HTMLDivElement | null;
  demo: boolean;
  inWorkspace: boolean;
  messages: Message[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  sending: boolean;
  setArchiveError: React.Dispatch<React.SetStateAction<boolean>>;
  setArchiveLoading: React.Dispatch<React.SetStateAction<boolean>>;
  settleArchiveAnchor: (token?: number | undefined) => void;
  sockRef: React.RefObject<UseChatSocket | null>;
  streamText: string;
  wsSending: boolean;
};

export function useChatScroll({
  activeId,
  archiveLoading,
  archiveRequestTokenRef,
  archiveScrollAnchorRef,
  chat,
  chatScrollParent,
  demo,
  inWorkspace,
  messages,
  scrollRef,
  sending,
  setArchiveError,
  setArchiveLoading,
  settleArchiveAnchor,
  sockRef,
  streamText,
  wsSending,
}: ChatScrollInput) {
  // autoscroll: controller 是 scrollTop 的唯一写入方。正确性来自 check-before-write,
  // 输入 mark 只立刻挂起写入以降低抖动,没有 400ms 手势寿命。
  const stick = useRef(createStickToBottomController()).current;
  const stickToBottomRef = useMemo(() => ({
    get current() {
      return stick.following.current;
    },
    set current(value: boolean) {
      stick.following.current = value;
    },
    scrollToBottom: stick.scrollToBottom,
    jumpToBottom: stick.jumpToBottom,
    correctTo: stick.correctTo,
    releaseUserIntent: stick.releaseUserIntent,
  }), [stick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); scrollRef is App useState setter/useRef passed in, stable
  const scrollToChatBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) stick.scrollToBottom(el);
  }, [stick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); archiveScrollAnchorRef is App useState setter/useRef passed in, stable
  const cancelArchiveCorrection = useCallback(() => {
    const anchor = archiveScrollAnchorRef.current;
    if (anchor) anchor.cancelled = true;
  }, []);
  const markUserChatScroll = useCallback(() => {
    stick.markUserIntent();
    cancelArchiveCorrection();
  }, [stick, cancelArchiveCorrection]);
  // Wheel / trackpad fence (see wheelFence.ts). The React `onWheel` above keeps
  // the zero-tolerance leave mark; the fence itself lives in native listeners so
  // begin and release share one ordering with the browser's scrollend.
  useEffect(() => {
    const el = chatScrollParent;
    if (!el) return;
    return attachWheelFence(el, stick);
  }, [chatScrollParent, stick]);
  const beginDirectUserChatScroll = useCallback(() => {
    stick.beginDirectManipulation();
    cancelArchiveCorrection();
  }, [stick, cancelArchiveCorrection]);
  const endDirectUserChatScroll = useCallback(() => {
    stick.endDirectManipulation();
  }, [stick]);
  // Native scrollbar capture may deliver pointerup outside the scroller. Keep
  // the direct-manipulation lifetime tied to the actual press, not to whether
  // React happens to receive the matching end event on the chat element.
  useEffect(() => {
    const end = () => endDirectUserChatScroll();
    // Native touch scrolling intentionally emits pointercancel when the browser
    // takes ownership of panning. The finger is still down at that point; the
    // matching touchend/touchcancel is the actual direct-manipulation boundary.
    const endPointer = (event: PointerEvent) => {
      if (event.pointerType !== "touch") end();
    };
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
      window.removeEventListener("blur", end);
    };
  }, [endDirectUserChatScroll]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); archiveScrollAnchorRef, scrollRef are App useState setter/useRef passed in, stable
  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.onScroll(el);
    const anchor = archiveScrollAnchorRef.current;
    if (
      anchor && !anchor.cancelled && !anchor.restoring &&
      Math.abs(el.scrollTop - anchor.capturedScrollTop) > 1
    ) {
      // 用户已经离开点击位置：响应仍须等 DOM 提交后释放 FIFO，但不再把视口拉回旧坐标。
      anchor.cancelled = true;
    }
  }, [stick]);
  // 切会话:重置粘滞并瞬时跳底(历史回看从底部开始);同时清归档按钮子态与视口锚点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId 是切会话触发器,函数体不读它。
  useLayoutEffect(() => {
    stick.reset();
    scrollToChatBottom();
    setArchiveLoading(false);
    setArchiveError(false);
    archiveRequestTokenRef.current += 1;
    settleArchiveAnchor();
    return () => {
      archiveRequestTokenRef.current += 1;
      settleArchiveAnchor();
    };
  }, [activeId, scrollToChatBottom, settleArchiveAnchor, stick]);
  // 内容变更跟随:demo 走 messages/streamText,真实路径走 version/wsSending。
  // 流式期间高频触发,用瞬时赋值而非 smooth(60fps 下排队的平滑动画反而卡顿)。
  // layout 阶段贴底,避免普通 DOM 时间线先画出旧顶部再跳到底部。
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/streamText/chat.version/wsSending 是内容变更触发器;stickToBottomRef.current 是稳定对象上的 getter,执行时现读。
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollToChatBottom();
  }, [messages, streamText, chat.version, wsSending, scrollToChatBottom]);

  // 归档「查看更早历史记录」:记录点击时屏幕里真实可见的消息行。前插渲染后持续把
  // 该行恢复到原位置；底部仍在增长的实时 Agent 响应不会污染这次校正。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); archiveRequestTokenRef, archiveScrollAnchorRef, scrollRef, setArchiveError, setArchiveLoading, sockRef are App useState setter/useRef passed in, stable
  const onLoadOlderHistory = useCallback(async () => {
    if (demo || !activeId) return;
    stick.following.current = false;
    settleArchiveAnchor();
    const token = ++archiveRequestTokenRef.current;
    const el = scrollRef.current;
    let resolveAnchor: (() => void) | null = null;
    const anchorSettled = el
      ? new Promise<void>((resolve) => { resolveAnchor = resolve; })
      : Promise.resolve();
    const settle = () => {
      const resolve = resolveAnchor;
      resolveAnchor = null;
      resolve?.();
    };
    archiveScrollAnchorRef.current = el
      ? {
        token,
        capturedScrollTop: el.scrollTop,
        timelineGeneration: sockRef.current?.getSession(activeId)?._timelineGeneration,
        row: captureVisibleVirtualRowAnchor(el),
        ready: false,
        cancelled: false,
        restoring: false,
        settle,
      }
      : null;
    setArchiveError(false);
    setArchiveLoading(true);
    try {
      // loadOlderHistory 是非抛出式契约:失败以 {ok:false} 返回(hasMore 不封死,可重试)。
      const res = await chat.loadOlderHistory(activeId);
      if (archiveRequestTokenRef.current !== token) return;
      if (!res.ok) {
        setArchiveError(true);
        settleArchiveAnchor(token);
      } else if (res.loaded > 0) {
        const anchor = archiveScrollAnchorRef.current;
        if (anchor?.token === token) anchor.ready = true;
      } else {
        settleArchiveAnchor(token);
      }
    } catch {
      if (archiveRequestTokenRef.current !== token) return;
      setArchiveError(true);
      settleArchiveAnchor(token);
    } finally {
      if (archiveRequestTokenRef.current === token) setArchiveLoading(false);
    }
    // Keep the shared history FIFO occupied until this request's DOM insertion
    // has either been anchored or deliberately cancelled by user navigation.
    await anchorSettled;
  }, [demo, activeId, chat, settleArchiveAnchor, stick]);
  // 对应归档响应完成且前插行渲染后(paint 前)才校正 scrollTop。请求在途时的 tape/live
  // 增长没有 ready token，不能冒领这个锚点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: archiveLoading/chat.version 是前插渲染完成的触发器,函数体经 ref 读锚点。
  useLayoutEffect(() => {
    const anchor = archiveScrollAnchorRef.current;
    if (!anchor?.ready) return;
    const el = scrollRef.current;
    if (!el) {
      settleArchiveAnchor(anchor.token);
      return;
    }
    if (
      anchor.cancelled || !anchor.row ||
      anchor.timelineGeneration !== sockRef.current?.getSession(activeId)?._timelineGeneration
    ) {
      settleArchiveAnchor(anchor.token);
      return;
    }
    if (anchor.restoring) return;
    anchor.restoring = true;
    void restoreVisibleVirtualRowAnchor(
      el,
      anchor.row,
      () => {
        const current = archiveScrollAnchorRef.current;
        return !current || current.token !== anchor.token || current.cancelled ||
          current.timelineGeneration !== sockRef.current?.getSession(activeId)?._timelineGeneration;
      },
      undefined,
      stick.correctTo,
    ).finally(() => settleArchiveAnchor(anchor.token));
  }, [activeId, archiveLoading, chat.version, settleArchiveAnchor, stick]);

  // iOS Safari 的地址栏/底栏/截图/输入键盘会触发 visualViewport 高度与 offset 抖动。
  // CSS dvh 仍可能短暂大于真实可视区；键盘弹起时 Safari 还会 pan visual viewport,
  // 让 fixed root 的 top:0 看起来被顶到屏幕上方。这里把实测 height + offsetTop
  // 写入 CSS var；若用户本就在底部或本轮正在生成，下一帧重新贴底。
  // biome-ignore lint/correctness/useExhaustiveDependencies: stickToBottomRef.current 是稳定对象上的 getter,事件发生时现读,不是依赖。
  useEffect(() => {
    if (!inWorkspace) return;
    let raf: number | null = null;
    const setVisualViewportVars = () => {
      const vv = window.visualViewport;
      const h = vv?.height || window.innerHeight;
      if (Number.isFinite(h) && h > 0) {
        document.documentElement.style.setProperty("--oc-visual-height", `${Math.round(h)}px`);
        document.documentElement.style.setProperty("--oc-visual-height-85", `${Math.round(h * 0.85)}px`);
      }
      const top = vv?.offsetTop || 0;
      if (Number.isFinite(top)) {
        document.documentElement.style.setProperty("--oc-visual-offset-top", `${Math.max(0, Math.round(top))}px`);
      }
    };
    const realign = () => {
      setVisualViewportVars();
      if (!stickToBottomRef.current) return;
      if (typeof requestAnimationFrame === "function") {
        if (raf !== null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          raf = null;
          scrollToChatBottom();
        });
      } else {
        scrollToChatBottom();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") realign();
    };
    realign();
    window.visualViewport?.addEventListener("resize", realign);
    window.visualViewport?.addEventListener("scroll", realign);
    window.addEventListener("resize", realign);
    window.addEventListener("pageshow", realign);
    window.addEventListener("focus", realign);
    document.addEventListener("focusin", realign);
    document.addEventListener("focusout", realign);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      window.visualViewport?.removeEventListener("resize", realign);
      window.visualViewport?.removeEventListener("scroll", realign);
      window.removeEventListener("resize", realign);
      window.removeEventListener("pageshow", realign);
      window.removeEventListener("focus", realign);
      document.removeEventListener("focusin", realign);
      document.removeEventListener("focusout", realign);
      document.removeEventListener("visibilitychange", onVisible);
      document.documentElement.style.removeProperty("--oc-visual-height");
      document.documentElement.style.removeProperty("--oc-visual-height-85");
      document.documentElement.style.removeProperty("--oc-visual-offset-top");
    };
  }, [inWorkspace, scrollToChatBottom]);

  return {
    beginDirectUserChatScroll,
    endDirectUserChatScroll,
    markUserChatScroll,
    onChatScroll,
    onLoadOlderHistory,
    stickToBottomRef,
  };
}
