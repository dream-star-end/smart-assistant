import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  logoutWithCookieSerialization,
  refreshWithFriction,
  resetRefreshJourney,
} from "../lib/api";
import { reportClientFriction } from "../lib/clientFriction";
import type { AuthSession, User } from "../lib/types";

/**
 * 管理后台鉴权（与用户端 useAuth 语义一致，但**不复用** useAuth —— 后者绑定
 * 登录/注册/邮箱验证/重置全流程，admin 只需「静默续期 → getMe → 校验 role」）。
 *
 * 鉴权模型（照抄用户端不变量）：
 *  - access token 仅存内存（模块级 accessToken 是唯一权威源，绝不落地）。
 *  - refresh token 走 HttpOnly cookie；启动做一次 api.refresh() 静默续期。
 *  - adminSession 是稳定引用：数据层 adminApi 经它取/回写 token；命中 401 时 api 层
 *    透明刷新并回写这里，adminApi 不新建第二套刷新机制。
 *  - 刷新失败（onExpired）或 role!=='admin' → 回用户端首页 '/'（管理后台不做独立登录页）。
 */

// access token 唯一权威源（内存态）。模块级：既给 React hook 用，也给无 React 上下文的
// adminApi 直接读（数据层是纯函数模块，不吃 context）。
let accessToken: string | null = null;

// 会话过期回调：由 useAdminAuth 在挂载时注入（默认回首页）。api 层刷新失败时经
// adminSession.onExpired() 触发。
let onSessionExpired: () => void = () => {
  window.location.replace("/");
};

/**
 * admin 域鉴权会话：access token 的唯一权威源（稳定引用，整个生命周期复用）。
 * api.getMe / adminApi 的 callWithRefresh 都吃它；401 时 api 内部 refresh + setToken 回写。
 */
export const adminSession: AuthSession = {
  getToken: () => accessToken ?? "",
  setToken: (t) => {
    accessToken = t;
  },
  onExpired: () => onSessionExpired(),
};

/** 当前内存 access token（供极少数需要自拼请求的场景读取；常规一律走 adminApi）。 */
export function getAdminToken(): string | null {
  return accessToken;
}

export type AdminAuthState = {
  /** 已加载的用户（可能非 admin —— 交给 AdminApp 决定跳转）。未认证为 null。 */
  user: User | null;
  /** 引导完成（无论成功/失败）。false 时 AdminApp 渲染加载态。 */
  ready: boolean;
  /** 已认证 **且** role==='admin'。仅此时渲染 AdminShell。 */
  authed: boolean;
  recoverable: boolean;
  retry: () => void;
  /** 登出：吊销 refresh cookie（错误已在 api 层吞掉）后回首页。 */
  logout: () => void;
};

/**
 * 启动鉴权引导：api.refresh() → getMe → 校验 role。仅挂载跑一次。
 * 语义与 useAuth 的 booting effect 对齐（accessToken 换到但 getMe 失败 → 不半开登录态）。
 */
export function useAdminAuth(): AdminAuthState {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [recoverable, setRecoverable] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);
  const bootstrapMeFriction = useRef<{ id: string; attempts: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setRecoverable(false);
    // 刷新失败 → 清内存态回首页（绝不循环重试）。cancelled 守卫避免卸载后跳转。
    onSessionExpired = () => {
      resetRefreshJourney(adminSession);
      bootstrapMeFriction.current = null;
      accessToken = null;
      if (!cancelled) window.location.replace("/");
    };
    void (async () => {
      let r = await refreshWithFriction(adminSession, "admin_auth", accessToken);
      if (r.kind === "transient" || r.kind === "race" || r.kind === "stale") {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        if (cancelled) return;
        r = await refreshWithFriction(adminSession, "admin_auth", accessToken);
      }
      // 200 但空 body 不算有会话（防半开登录态）。
      if (r.kind !== "success") {
        if (!cancelled) {
          setRecoverable(r.kind !== "invalid");
          setReady(true);
        }
        return;
      }
      accessToken = r.result.accessToken;
      for (let localAttempt = 0; localAttempt < 2; localAttempt++) {
        try {
          const me = await api.getMe(adminSession);
          if (cancelled) return;
          const prior = bootstrapMeFriction.current;
          if (prior) {
            reportClientFriction({
              eventId: prior.id, surface: "admin_auth", stage: "bootstrap_me",
              code: "BOOTSTRAP_ME_TRANSIENT", outcome: "recovered",
              attempts: Math.min(32, prior.attempts + 1),
            }, accessToken);
            bootstrapMeFriction.current = null;
          }
          setUser(me);
          setAuthed(me.role === "admin");
          setRecoverable(false);
          if (me.role !== "admin") resetRefreshJourney(adminSession);
          setReady(true);
          return;
        } catch {
          if (cancelled) return;
          if (accessToken === null) {
            setReady(true);
            return;
          }
          const prior = bootstrapMeFriction.current;
          const attempts = Math.min(32, (prior?.attempts ?? 0) + 1);
          const id = reportClientFriction({
            eventId: prior?.id, surface: "admin_auth", stage: "bootstrap_me",
            code: "BOOTSTRAP_ME_TRANSIENT", outcome: "failed", attempts,
          }, accessToken);
          bootstrapMeFriction.current = { id, attempts };
          if (localAttempt === 0) {
            await new Promise((resolve) => window.setTimeout(resolve, 350));
            continue;
          }
          setRecoverable(true);
          setReady(true);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [retrySeq]);

  const retry = useCallback(() => setRetrySeq((value) => value + 1), []);

  const logout = useCallback(() => {
    bootstrapMeFriction.current = null;
    void logoutWithCookieSerialization(adminSession);
    accessToken = null;
    window.location.replace("/");
  }, []);

  return { user, ready, authed, recoverable, retry, logout };
}
