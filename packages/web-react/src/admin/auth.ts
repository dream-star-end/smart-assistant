import { useCallback, useEffect, useRef, useState } from "react";
import { api, cancelAuthRefresh, isAuthRecoveryTransient } from "../lib/api";
import { publishAuthLogout, subscribeAuthLogout } from "../lib/authBroadcast";
import { createMemoryAuthSession } from "../lib/authSession";
import { bindClientFrictionTokenProvider, reportClientFriction } from "../lib/clientFriction";
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
  recoverable: boolean;
  retry: () => void;
  /** 登出：先隐藏管理面，等待 refresh family 吊销/清 cookie 后再回首页。 */
  logout: () => Promise<void>;
};

/**
 * 启动鉴权引导：api.refresh() → getMe → 校验 role。瞬时错误保持 not-ready 并退避恢复。
 */
export function useAdminAuth(): AdminAuthState {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [recoverable, setRecoverable] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);
  const bootstrapMeFriction = useRef<{ id: string; attempts: number } | null>(null);
  useEffect(
    () => bindClientFrictionTokenProvider(() => adminSession.snapshot().token),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setRecoverable(false);
    // 启动只消费当前身份代次，不另开身份边界，也不取消共享 refresh。React StrictMode
    // 会 setup → cleanup → setup 重放 effect；两次消费者因此绑定同一 epoch/singleflight，
    // 不会在首个响应已旋转 cookie 后再拿旧 cookie 发第二次 refresh。
    const bootEpoch = adminSession.snapshot().epoch;
    onSessionExpired = () => {
      if (controller.signal.aborted) return;
      bootstrapMeFriction.current = null;
      setUser(null);
      setAuthed(false);
      setRecoverable(false);
      setReady(true);
    };
    const unsubscribe = subscribeAuthLogout(() => {
      bootstrapMeFriction.current = null;
      adminSession.beginIdentity();
      void cancelAuthRefresh(adminSession);
      setUser(null);
      setAuthed(false);
      setRecoverable(false);
      setReady(true);
    });
    void (async () => {
      let refreshAttempt = 0;
      while (!controller.signal.aborted && adminSession.snapshot().epoch === bootEpoch) {
        const outcome = await api.refresh(adminSession, bootEpoch, "admin_auth");
        if (controller.signal.aborted) return;
        if (outcome.kind === "stale") return;
        if (outcome.kind === "invalid") {
          adminSession.expire(bootEpoch);
          return;
        }
        if (outcome.kind === "transient") {
          // throttled 限频早返不计重试(未发真实网络请求;语义与坑同 useAuth 的 boot 循环)。
          if (outcome.throttled) {
            try {
              await waitForRecovery(Math.max(1, outcome.retryAfterMs), controller.signal);
            } catch {
              return;
            }
            continue;
          }
          const local = ADMIN_RECOVERY_BACKOFF_MS[Math.min(refreshAttempt, ADMIN_RECOVERY_BACKOFF_MS.length - 1)];
          refreshAttempt += 1;
          if (refreshAttempt >= 2) {
            setRecoverable(true);
            setReady(true);
            return;
          }
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
            const prior = bootstrapMeFriction.current;
            if (prior) {
              reportClientFriction({
                eventId: prior.id,
                surface: "admin_auth",
                stage: "bootstrap_me",
                code: "BOOTSTRAP_ME_TRANSIENT",
                outcome: "recovered",
                attempts: Math.min(32, prior.attempts + 1),
              }, adminSession.snapshot().token);
              bootstrapMeFriction.current = null;
            }
            setUser(me);
            setAuthed(me.role === "admin");
            setRecoverable(false);
            setReady(true);
            return;
          } catch (error) {
            if (controller.signal.aborted || adminSession.snapshot().epoch !== bootEpoch) return;
            if (!isAuthRecoveryTransient(error)) {
              adminSession.beginIdentity();
              setReady(true);
              return;
            }
            const prior = bootstrapMeFriction.current;
            const attempts = Math.min(32, (prior?.attempts ?? 0) + 1);
            const id = reportClientFriction({
              eventId: prior?.id,
              surface: "admin_auth",
              stage: "bootstrap_me",
              code: "BOOTSTRAP_ME_TRANSIENT",
              outcome: "failed",
              attempts,
            }, adminSession.snapshot().token);
            bootstrapMeFriction.current = { id, attempts };
            const delayMs = ADMIN_RECOVERY_BACKOFF_MS[Math.min(meAttempt, ADMIN_RECOVERY_BACKOFF_MS.length - 1)];
            meAttempt += 1;
            if (meAttempt >= 2) {
              setRecoverable(true);
              setReady(true);
              return;
            }
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
  }, [retrySeq]);

  const retry = useCallback(() => setRetrySeq((value) => value + 1), []);

  const logout = useCallback(async () => {
    bootstrapMeFriction.current = null;
    adminSession.beginIdentity();
    void cancelAuthRefresh(adminSession);
    publishAuthLogout();
    // ready=false 先隐藏管理数据，同时避免 AdminApp 的 ready&&!authed effect 抢先导航。
    setUser(null);
    setAuthed(false);
    setReady(false);
    await api.logout(adminSession);
    window.location.replace("/");
  }, []);

  return { user, ready, authed, recoverable, retry, logout };
}
