import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AuthSession } from "../lib/types";

/** 待确认建议数的刷新间隔。审计是周级任务，取 10 分钟即可，且只在页面可见时发。 */
const POLL_MS = 600_000;

/**
 * Auto‑Dream 待确认建议数（管理中心「优化」Tab 徽标 + 侧栏入口信号的**同一份计数**）。
 *
 * 为什么要它：全面优化是这块最有价值的能力，但它是"收件箱"型分区 —— 平时为空，
 * 有待确认项时才值得看。改造前侧栏零曝光、Tab 上也没有任何信号，用户只有点进去才可能
 * 撞见有 3 条建议在等自己。这里把"有没有事要办"做成信号（徽标），而**不是**动态落地页：
 * 落地页随数据漂移会毁掉肌肉记忆。
 *
 * 请求纪律（这条 GET 是走 commercial router 代理进用户容器的，不是普通平台 API）：
 * - enabled 应由调用方接 `gate.ready`（容器 running）。容器没起时该路由恒 503
 *   CONTAINER_NOT_RUNNING，不 gate 就是每次开页面必打一发注定失败的请求。
 * - 只在 `document.visibilityState === 'visible'` 时轮询，后台标签页不打后端；
 *   切回前台立即刷新（对齐 useInbox 的既有范式）。
 * - 任何失败都静默保留旧值：这是个装饰性信号，不该把容器抖动变成用户可见的错误。
 *
 * 暴露 refresh 供"离开管理中心时回拉真值"（应用/忽略建议会改变计数）。
 */
export function useOptimizerPending(auth: AuthSession | null, agentId: string, enabled: boolean) {
  const [pendingCount, setPendingCount] = useState(0);
  const authRef = useRef(auth);
  authRef.current = auth;
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  // 代际守卫：登出/换号/换 agent 时 bump，丢弃旧上下文在途请求的迟到响应。
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    const a = authRef.current;
    if (!a) return;
    const myGen = genRef.current;
    try {
      const state = await api.getAutoDreamOptimizer(a, agentRef.current);
      if (genRef.current !== myGen) return;
      setPendingCount(
        state.proposals.filter((p) => p.state === "pending" || p.state === "conflict").length,
      );
    } catch {
      /* 容器未起 / 网络抖动：保留旧值，不打断 UI */
    }
  }, []);

  useEffect(() => {
    if (!enabled || !auth) {
      genRef.current++;
      setPendingCount(0);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      genRef.current++; // 失效本代在途请求（换 agent 时计数不会串到新 agent 上）
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, auth, agentId, refresh]);

  return { pendingCount, refresh };
}
