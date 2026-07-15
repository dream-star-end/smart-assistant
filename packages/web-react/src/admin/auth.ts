import { useCallback, useEffect, useState } from "react";
import { api, cancelAuthRefresh, isAuthRecoveryTransient } from "../lib/api";
import { publishAuthLogout, subscribeAuthLogout } from "../lib/authBroadcast";
import { createMemoryAuthSession } from "../lib/authSession";
import type { AuthSession, User } from "../lib/types";

const ADMIN_RECOVERY_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

function waitForRecovery(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 管理后台鉴权（与用户端 useAuth 语义一致，但**不复用** useAuth —— 后者绑定
 * 登录/注册/邮箱验证/重置全流程，admin 只需「静默续期 → getMe → 校验 role」）。
 *
 * 鉴权模型（照抄用户端不变量）：
 *  - access token + authEpoch 仅存内存并共同构成身份权威，绝不落地。
 *  - refresh token 走 HttpOnly cookie；启动做一次 api.refresh() 静默续期。
 *  - adminSession 是稳定引用：数据层 adminApi 经它取/回写 token；命中 401 时 api 层
 *    透明刷新并回写这里，adminApi 不新建第二套刷新机制。
 *  - 仅明确 refresh invalid 或 role!=='admin' → 回用户端首页；瞬时错误留在恢复态。
 */

// 会话过期回调：由 useAdminAuth 在挂载时注入。AuthSession.expire(epoch) 原子触发。
let onSessionExpired: () => void = () => {
  window.location.replace("/");
};

/**
 * admin 域鉴权会话：access token 的唯一权威源（稳定引用，整个生命周期复用）。
 * api.getMe / adminApi 的 callWithRefresh 都吃它；401 时 api 内部按 epoch refresh + commitToken。
 */
export const adminSession: AuthSession = createMemoryAuthSession(() => onSessionExpired());

/** 当前内存 access token（供极少数需要自拼请求的场景读取；常规一律走 adminApi）。 */
export function getAdminToken(): string | null {
  return adminSession.snapshot().token || null;
}

export type AdminAuthState = {
  /** 已加载的用户（可能非 admin —— 交给 AdminApp 决定跳转）。未认证为 null。 */
  user: User | null;
  /** 引导完成（无论成功/失败）。false 时 AdminApp 渲染加载态。 */
  ready: boolean;
  /** 已认证 **且** role==='admin'。仅此时渲染 AdminShell。 */
  authed: boolean;
  /** 登出：吊销 refresh cookie（错误已在 api 层吞掉）后回首页。 */
  logout: () => void;
};

/**
 * 启动鉴权引导：api.refresh() → getMe → 校验 role。瞬时错误保持 not-ready 并退避恢复。
 */
export function useAdminAuth(): AdminAuthState {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const bootEpoch = adminSession.beginIdentity();
    void cancelAuthRefresh(adminSession);
    onSessionExpired = () => {
      if (controller.signal.aborted) return;
      setUser(null);
      setAuthed(false);
      setReady(true);
    };
    const unsubscribe = subscribeAuthLogout(() => {
      adminSession.beginIdentity();
      void cancelAuthRefresh(adminSession);
      setUser(null);
      setAuthed(false);
      setReady(true);
    });
    void (async () => {
      let refreshAttempt = 0;
      while (!controller.signal.aborted && adminSession.snapshot().epoch === bootEpoch) {
        const outcome = await api.refresh(adminSession, bootEpoch);
        if (controller.signal.aborted) return;
        if (outcome.kind === "stale") return;
        if (outcome.kind === "invalid") {
          adminSession.expire(bootEpoch);
          return;
        }
        if (outcome.kind === "transient") {
          const local = ADMIN_RECOVERY_BACKOFF_MS[Math.min(refreshAttempt, ADMIN_RECOVERY_BACKOFF_MS.length - 1)];
          refreshAttempt += 1;
          try {
            await waitForRecovery(Math.max(local, outcome.retryAfterMs), controller.signal);
          } catch {
            return;
          }
          continue;
        }

        let meAttempt = 0;
        while (!controller.signal.aborted && adminSession.snapshot().epoch === bootEpoch) {
          try {
            const me = await api.getMe(adminSession);
            if (controller.signal.aborted || adminSession.snapshot().epoch !== bootEpoch) return;
            setUser(me);
            setAuthed(me.role === "admin");
            setReady(true);
            return;
          } catch (error) {
            if (controller.signal.aborted || adminSession.snapshot().epoch !== bootEpoch) return;
            if (!isAuthRecoveryTransient(error)) {
              adminSession.beginIdentity();
              setReady(true);
              return;
            }
            const delayMs = ADMIN_RECOVERY_BACKOFF_MS[Math.min(meAttempt, ADMIN_RECOVERY_BACKOFF_MS.length - 1)];
            meAttempt += 1;
            try {
              await waitForRecovery(delayMs, controller.signal);
            } catch {
              return;
            }
          }
        }
      }
    })();
    return () => {
      controller.abort();
      unsubscribe();
      onSessionExpired = () => {};
    };
  }, []);

  const logout = useCallback(() => {
    adminSession.beginIdentity();
    void cancelAuthRefresh(adminSession);
    publishAuthLogout();
    void api.logout(adminSession);
    window.location.replace("/");
  }, []);

  return { user, ready, authed, logout };
}
