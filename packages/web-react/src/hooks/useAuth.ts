import { useCallback, useEffect, useRef, useState } from "react";
import { api, cancelAuthRefresh, isAuthRecoveryTransient } from "../lib/api";
import { publishAuthLogout, subscribeAuthLogout } from "../lib/authBroadcast";
import { createMemoryAuthSession } from "../lib/authSession";
import { reportClientFriction } from "../lib/clientFriction";
import type { AuthSession, User } from "../lib/types";
import { useLaneGate } from "./useLaneGate";

const AUTH_RECOVERY_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

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
 * 鉴权状态机（从 App.tsx 整体收口，语义逐条保留）：
 * - access token 仅存 AuthSession 内存态（token + epoch 是唯一权威源），刷新即丢；refresh token 在 HttpOnly
 *   cookie 里 —— 启动先做一次静默续期（booting 态），成功直接恢复工作区，失败才落首页/登录。
 *   商业产品每次 F5 都要密码+人机验证是致命流失点；IndexedDB「reload 不丢会话」的投入也靠
 *   这条腿才有意义。
 * - 只有 refresh 明确返回 INVALID_REFRESH / VALIDATION 才清鉴权；race、网络和 5xx 留在
 *   恢复态重试，绝不把服务抖动伪装成“退出登录”。
 * - chat 域收尾（清会话/消息/面板/IndexedDB wipe）**不在本 hook**：经 onClearAuth/onLogout
 *   回调注入 —— auth 域不反向依赖 chat 域。
 */
export type UseAuthOptions = {
  demo: boolean;
  /** 密码重置链接 token：存在时跳过启动静默续期（用户就是要走 reset 流程，不劫持进工作区）。 */
  resetToken?: string;
  /** 初始用户（demo 传 fixture；非 demo 传 null）。 */
  initialUser: User | null;
  /** auth 清空（静默刷新失败或主动登出）时的 chat 域收尾：清会话/消息/面板并回首页。 */
  onClearAuth: () => void;
  /** 登出独有的持久层收尾（清本 user 的 IndexedDB 命名空间等；仅非 demo 时调用）。 */
  onLogout?: () => void;
  /** 启动静默续期成功 → 进工作区（App 侧 setView("app")）。 */
  onBootAuthed?: () => void;
  /**
   * 登录成功后的 chat 域重置。不在此预载会话：登录后由 useChatSocket 从 IndexedDB 注水
   * （onHydrated）+ listSessions 合并 server canonical 列表填侧栏；selectSession 再按需拉取
   * 单会话历史。
   */
  onLoginSuccess?: () => void;
};

export type UseAuth = {
  /** 仅当已认证时暴露给业务逻辑；未认证时为 null。REST/WS 调用消费它。 */
  auth: AuthSession | null;
  /** AuthSession 的稳定引用（整个生命周期复用），异步回调里经它读最新 token。 */
  authRef: React.MutableRefObject<AuthSession>;
  authed: boolean;
  user: User | null;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
  authLoading: boolean;
  authError: string | null;
  authRecoveryAvailable: boolean;
  retryBoot: () => void;
  /** 启动静默续期进行中（App 渲染极简 splash）。 */
  booting: boolean;
  /**
   * cohort 分批切流 lane 就绪（P3 RFC D1）。auth 流程完成 lane 决策（cookie 已下发）→ true，
   * 作为 useChatSocket 建立 WS 的前置之一（防首连落错 slot）。3s 兜底放行防死锁（见 useLaneGate）。
   */
  laneReady: boolean;
  /** 当前 cohort lane（`g<generation>.<slot>` 或 null；null=未分配/后端未部署 lane）。观测用。 */
  lane: string | null;
  clearAuth: () => void;
  login: (email: string, password: string, turnstileToken: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    displayName?: string;
    turnstileToken: string;
    /** 勾选同意的协议版本（lib/legal TERMS_VERSION），后端落 users 留证。 */
    termsVersion: string;
  }) => Promise<{ verifyEmailSent: boolean }>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  requestReset: (email: string, token: string) => Promise<void>;
  confirmReset: (token: string, newPassword: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
};

export function useAuth(opts: UseAuthOptions): UseAuth {
  const { demo, resetToken } = opts;
  // 回调经 ref 镜像：App 每渲染可能传新闭包，这里始终读最新版本而不进 useCallback 依赖
  // （保持 clearAuth/login/logout 引用稳定；与 useChatSocket persistRef 同款模式）。
  const cbRef = useRef(opts);
  cbRef.current = opts;

  // access token + epoch 共同构成身份权威。epoch 在登录尝试/登出/失效时递增，所有异步
  // commit 都必须带起始 epoch，旧账号的晚到响应因此无法污染新身份。
  const expiredUiRef = useRef<() => void>(() => {});
  const [authed, setAuthed] = useState(false);
  const [user, setUser] = useState<User | null>(opts.initialUser);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authRecoveryAvailable, setAuthRecoveryAvailable] = useState(false);
  const bootstrapMeFriction = useRef<{ id: string; attempts: number } | null>(null);
  // demo/重置链接跳过静默续期（重置场景用户就是要走 reset 流程，不劫持进工作区）。
  const [booting, setBooting] = useState(!demo && !resetToken);
  // cohort lane 决策信号（P3 RFC D1）：undefined=决策进行中；{lane}=已拿到 auth 响应
  // （lane 为 string 或 null——字段缺失=后端未部署=向后兼容仍算已决策）。login/boot 成功时置，
  // clearAuth 复位。laneReady 由 useLaneGate 据此 + authed + 3s 兜底派生。
  const [laneSignal, setLaneSignal] = useState<{ lane: string | null } | undefined>(undefined);

  // AuthSession 整个页面生命周期复用同一引用。expire 内部原子校验 + bump，保证并发
  // invalid 消费者只触发一次 UI teardown。
  const authRef = useRef<AuthSession>(createMemoryAuthSession(() => expiredUiRef.current()));

  // 只改 React/chat 状态，不再 bump epoch；调用方必须先 beginIdentity，或来自 expire 的
  // 原子 bump。拆开可避免 invalid 路径重复递增。
  const clearAuthState = useCallback(() => {
    bootstrapMeFriction.current = null;
    setAuthed(false);
    setUser(null);
    setAuthLoading(false);
    setAuthError(null);
    setAuthRecoveryAvailable(false);
    setBooting(false);
    setLaneSignal(undefined); // lane 决策复位：下次认证重新走 laneReady 闸
    cbRef.current.onClearAuth();
  }, []);
  expiredUiRef.current = clearAuthState;

  const clearAuth = useCallback(() => {
    authRef.current.beginIdentity();
    void cancelAuthRefresh(authRef.current);
    clearAuthState();
  }, [clearAuthState]);

  // 仅当已认证时把 session 暴露给业务逻辑；未认证时为 null。P3/P4 的 REST/WS 调用消费它。
  const auth = authed ? authRef.current : null;

  // cohort lane 就绪闸（P3 RFC D1）：已认证 + lane 决策达成（或 3s 兜底）才放行 WS 连接。
  const laneReady = useLaneGate(authed, laneSignal);
  const lane = laneSignal?.lane ?? null;

  const login = useCallback(
    async (email: string, password: string, turnstileToken: string) => {
      const session = authRef.current;
      const loginEpoch = session.beginIdentity();
      bootstrapMeFriction.current = null;
      // abort 同步发生；api.login 随后进入同 tab cookie-mutation FIFO，必在旧 refresh settle 后发出。
      void cancelAuthRefresh(session);
      setAuthLoading(true);
      setAuthError(null);
      setAuthRecoveryAvailable(false);
      try {
        // 服务端 /api/auth/login schema 必填 turnstile_token。turnstileToken 由 AuthGate 给出：
        // canary（turnstile_bypass:true）发占位 'bypass'（服务端接受任意串）；生产（bypass 关闭）
        // 为真实 Cloudflare Turnstile widget 的 onSuccess token。canary 登录行为不变。
        // 登录拿到内存态 accessToken + 用户信息；token 只写进 tokenRef（内存），绝不落地。
        // refresh token 由后端通过 HttpOnly cookie 下发（api.login credentials:'include'）。
        const res = await api.login(email, password, turnstileToken);
        if (!session.commitToken(loginEpoch, res.accessToken)) return;
        setAuthed(true);
        setUser(res.user);
        // lane 决策达成（cookie 已随登录响应 Set-Cookie 下发）：解锁 WS 连接前置。
        setLaneSignal({ lane: res.lane ?? null });
        cbRef.current.onLoginSuccess?.();
      } catch (e) {
        if (session.snapshot().epoch === loginEpoch) {
          setAuthError((e as Error).message || "登录失败");
        }
      } finally {
        if (session.snapshot().epoch === loginEpoch) setAuthLoading(false);
      }
    },
    [],
  );

  // 启动静默续期：只有明确 invalid 才落到未登录；race/网络/5xx 保持 splash 并恢复。
  // cleanup 只取消本消费者的 sleep/state commit，不 abort 可能被 REST/WS 共用的 refresh flight。
  useEffect(() => {
    if (!booting) return;
    const controller = new AbortController();
    const session = authRef.current;
    const bootEpoch = session.snapshot().epoch;
    void (async () => {
      let refreshAttempt = 0;
      while (!controller.signal.aborted && session.snapshot().epoch === bootEpoch) {
        const outcome = await api.refresh(session, bootEpoch);
        if (controller.signal.aborted) return;
        if (outcome.kind === "stale") return;
        if (outcome.kind === "invalid") {
          session.expire(bootEpoch);
          return;
        }
        if (outcome.kind === "transient") {
          // throttled = api 层限频早返(nextAllowedAt 未到,没发真实网络请求)——不是新的
          // 失败证据,不计入重试次数;补睡剩余限频窗后重进循环(届时必发真实请求,收敛)。
          // 背景:消费层 setTimeout 有亚毫秒早醒(libuv ms 取整),睡满 retryAfterMs 醒来仍可能
          // 差 <1ms 撞进限频分支;把它当失败会"只发一次网络就放弃恢复"(CI flake 同根因,
          // 生产语义同错:显示恢复失败前应真的试满 2 次网络)。
          if (outcome.throttled) {
            try {
              await waitForRecovery(Math.max(1, outcome.retryAfterMs), controller.signal);
            } catch {
              return;
            }
            continue;
          }
          const localBackoff = AUTH_RECOVERY_BACKOFF_MS[Math.min(refreshAttempt, AUTH_RECOVERY_BACKOFF_MS.length - 1)];
          refreshAttempt += 1;
          if (refreshAttempt >= 2) {
            setAuthError("登录状态恢复失败，请检查网络后重试");
            setAuthRecoveryAvailable(true);
            setBooting(false);
            return;
          }
          try {
            await waitForRecovery(Math.max(localBackoff, outcome.retryAfterMs), controller.signal);
          } catch {
            return;
          }
          continue;
        }

        let meAttempt = 0;
        while (!controller.signal.aborted && session.snapshot().epoch === bootEpoch) {
          try {
            const me = await api.getMe(session);
            if (controller.signal.aborted || session.snapshot().epoch !== bootEpoch) return;
            const prior = bootstrapMeFriction.current;
            if (prior) {
              reportClientFriction({
                eventId: prior.id,
                surface: "auth",
                stage: "bootstrap_me",
                code: "BOOTSTRAP_ME_TRANSIENT",
                outcome: "recovered",
                attempts: Math.min(32, prior.attempts + 1),
              }, session.snapshot().token);
              bootstrapMeFriction.current = null;
            }
            setAuthRecoveryAvailable(false);
            setUser(me);
            setAuthed(true);
            setLaneSignal({ lane: me.lane ?? null });
            cbRef.current.onBootAuthed?.();
            setBooting(false);
            return;
          } catch (error) {
            if (controller.signal.aborted || session.snapshot().epoch !== bootEpoch) return;
            if (!isAuthRecoveryTransient(error)) {
              session.beginIdentity();
              clearAuthState();
              return;
            }
            const prior = bootstrapMeFriction.current;
            const attempts = Math.min(32, (prior?.attempts ?? 0) + 1);
            const id = reportClientFriction({
              eventId: prior?.id,
              surface: "auth",
              stage: "bootstrap_me",
              code: "BOOTSTRAP_ME_TRANSIENT",
              outcome: "failed",
              attempts,
            }, session.snapshot().token);
            bootstrapMeFriction.current = { id, attempts };
            const delayMs = AUTH_RECOVERY_BACKOFF_MS[Math.min(meAttempt, AUTH_RECOVERY_BACKOFF_MS.length - 1)];
            meAttempt += 1;
            if (meAttempt >= 2) {
              setAuthError("登录状态恢复失败，请检查网络后重试");
              setAuthRecoveryAvailable(true);
              setBooting(false);
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
    };
  }, [booting, clearAuthState]);

  const retryBoot = useCallback(() => {
    setAuthError(null);
    setAuthRecoveryAvailable(false);
    setBooting(true);
  }, []);

  // 其它同源 tab 主动登出：立即作废本 tab 的 epoch/token 和在飞 refresh，不等旧 access JWT
  // 自然过期；信号不携带任何 token。
  useEffect(() => {
    if (demo) return;
    return subscribeAuthLogout(() => {
      authRef.current.beginIdentity();
      void cancelAuthRefresh(authRef.current);
      clearAuthState();
    });
  }, [demo, clearAuthState]);

  // 注册 / 邮箱验证 / 找回密码：透传到 api（错误为带友好中文 message 的 ApiError，AuthGate 自捕展示）。
  const register = useCallback(
    (input: {
      email: string;
      password: string;
      displayName?: string;
      turnstileToken: string;
      termsVersion: string;
    }) =>
      api
        .register({
          email: input.email,
          password: input.password,
          displayName: input.displayName,
          turnstileToken: input.turnstileToken,
          termsVersion: input.termsVersion,
        })
        .then((r) => ({ verifyEmailSent: r.verifyEmailSent })),
    [],
  );
  const verifyEmail = useCallback(
    (email: string, code: string) => api.verifyEmail(email, code).then(() => undefined),
    [],
  );
  const resendVerification = useCallback(
    (email: string) => api.resendVerification(email).then(() => undefined),
    [],
  );
  const requestReset = useCallback(
    (email: string, token: string) => api.requestPasswordReset(email, token).then(() => undefined),
    [],
  );
  const confirmReset = useCallback(
    (token: string, newPassword: string) =>
      api.confirmPasswordReset(token, newPassword).then(() => undefined),
    [],
  );

  const logout = useCallback(() => {
    const session = authRef.current;
    session.beginIdentity();
    void cancelAuthRefresh(session);
    if (!demo) {
      publishAuthLogout();
      // api.logout 与旧 refresh 共用同 tab FIFO；UI 先退，server revoke/清 cookie 后台完成。
      void api.logout(session);
      cbRef.current.onLogout?.();
    }
    clearAuthState();
  }, [demo, clearAuthState]);

  // 刷新账户余额（GET /api/me）：充值到账 / 打开计费面板后调用，让顶栏 balance-pill
  // 与账户分区拿到权威 credits（字符串大数，原样存进 user）。失败静默；明确 invalid 才 expire。
  const refreshMe = useCallback(async () => {
    if (demo || !authed) return;
    const session = authRef.current;
    const expectedEpoch = session.snapshot().epoch;
    try {
      const me = await api.getMe(session);
      if (session.snapshot().epoch === expectedEpoch) setUser(me);
    } catch {
      /* 刷新失败静默：余额停留在上次已知值，不打断当前操作 */
    }
  }, [demo, authed]);

  return {
    auth,
    authRef,
    authed,
    user,
    setUser,
    authLoading,
    authError,
    authRecoveryAvailable,
    retryBoot,
    booting,
    laneReady,
    lane,
    clearAuth,
    login,
    register,
    verifyEmail,
    resendVerification,
    requestReset,
    confirmReset,
    logout,
    refreshMe,
  };
}
