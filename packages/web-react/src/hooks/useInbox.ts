import { useAuthAccessGeneration } from "./useAuthAccessGeneration";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AuthSession } from "../lib/types";

const POLL_MS = 60_000;

/**
 * 站内信未读数轮询（铃铛红点单一权威）。
 *
 * - enabled（已登录 + 非 demo）时：立即拉一次未读数，之后每 60s 轮询，且仅在
 *   `document.visibilityState==='visible'` 时发请求（后台标签页不打后端）；切回前台
 *   立即刷新。对齐 v3 inbox.js 的 startInbox/refreshUnread 行为。
 * - 未启用时归零并停轮询，不发任何请求（未登录 / demo / 注销）。
 *
 * 暴露 refreshUnread 供站内信面板标记已读后回拉"真值"，setUnreadCount 供面板做
 * 乐观更新（全部已读→0）。
 */
export function useInbox(auth: AuthSession | null, enabled: boolean) {
  const [unreadCount, setUnreadCount] = useState(0);
  const accessGeneration = useAuthAccessGeneration(auth);
  const authRef = useRef(auth);
  authRef.current = auth;
  // 代际守卫：登出/换号时 bump，丢弃旧登录态在途请求的迟到响应（防跨账号未读残留）。
  const genRef = useRef(0);

  const refreshUnread = useCallback(async () => {
    const a = authRef.current;
    if (!a?.snapshot().token) return;
    const myGen = genRef.current;
    const accessAtStart = a.getAccessGeneration?.() ?? -1;
    try {
      const n = await api.getInboxUnreadCount(a);
      if (authRef.current !== a || genRef.current !== myGen || (a.getAccessGeneration?.() ?? -1) !== accessAtStart) return; // 期间登出/换号 → 丢弃旧代响应
      setUnreadCount(n);
    } catch {
      /* 未读数失败：保留旧值，不打断 UI（下次轮询/可见性切换再试） */
    }
  }, []);

  useEffect(() => {
    if (!enabled || !auth || !auth.snapshot().token) {
      genRef.current++;
      setUnreadCount(0);
      return;
    }
    const refreshCurrent = () => {
      if ((auth.getAccessGeneration?.() ?? -1) === accessGeneration) void refreshUnread();
    };
    refreshCurrent();
    const tick = () => {
      if (document.visibilityState === "visible") refreshCurrent();
    };
    const timer = window.setInterval(tick, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") refreshCurrent();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      genRef.current++; // 失效本代在途请求
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, auth, refreshUnread, accessGeneration]);

  const applyUnreadCountSnapshot = useCallback((count: number) => {
    genRef.current++; // Retire earlier poll responses before applying the confirmed operation's fresh GET.
    setUnreadCount(count);
  }, []);
  return { unreadCount, refreshUnread, setUnreadCount, applyUnreadCountSnapshot };
}
