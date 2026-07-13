import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AuthSession, User } from "../lib/types";
import { useLaneGate } from "./useLaneGate";

/**
 * 鉴权状态机（从 App.tsx 整体收口，语义逐条保留）：
 * - access token 仅存内存（tokenRef 是唯一权威源），刷新即丢；refresh token 在 HttpOnly
 *   cookie 里 —— 启动先做一次静默续期（booting 态），成功直接恢复工作区，失败才落首页/登录。
 *   商业产品每次 F5 都要密码+人机验证是致命流失点；IndexedDB「reload 不丢会话」的投入也靠
 *   这条腿才有意义。
 * - onExpired（api 层刷新失败）→ clearAuth 清空鉴权回登录页，绝不循环重试。
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

  // access token 仅存内存：放在 ref 里作为唯一权威源，AuthSession.getToken/setToken 读写它，
  // 静默刷新成功后 api 层直接回写 ref，下一次鉴权请求即拿到新 token（无 stale 闭包）。
  const tokenRef = useRef<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [user, setUser] = useState<User | null>(opts.initialUser);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // demo/重置链接跳过静默续期（重置场景用户就是要走 reset 流程，不劫持进工作区）。
  const [booting, setBooting] = useState(!demo && !resetToken);
  // cohort lane 决策信号（P3 RFC D1）：undefined=决策进行中；{lane}=已拿到 auth 响应
  // （lane 为 string 或 null——字段缺失=后端未部署=向后兼容仍算已决策）。login/boot 成功时置，
  // clearAuth 复位。laneReady 由 useLaneGate 据此 + authed + 3s 兜底派生。
  const [laneSignal, setLaneSignal] = useState<{ lane: string | null } | undefined>(undefined);

  // 清空全部鉴权状态，回到登录/首页（静默刷新失败或主动登出都走这里）。
  // 会话/消息/面板等 chat 域收尾经 onClearAuth 注入（在 App 层完成）。
  const clearAuth = useCallback(() => {
    tokenRef.current = null;
    setAuthed(false);
    setUser(null);
    setLaneSignal(undefined); // lane 决策复位：下次认证重新走 laneReady 闸
    cbRef.current.onClearAuth();
  }, []);

  // AuthSession：access token 的唯一权威源（仅存内存）。整个生命周期复用同一引用，
  // 传给 api.* 的鉴权请求；命中 401 时 api 内部透明刷新并 setToken 回写本 ref。
  // onExpired 在刷新失败时触发 → clearAuth 把用户带回登录页（绝不循环重试）。
  const authRef = useRef<AuthSession>({
    getToken: () => tokenRef.current ?? "",
    setToken: (t) => {
      tokenRef.current = t;
    },
    onExpired: () => clearAuth(),
  });
  // clearAuth 每次渲染可能是新引用；让 session.onExpired 始终指向最新版本。
  authRef.current.onExpired = clearAuth;
  // 仅当已认证时把 session 暴露给业务逻辑；未认证时为 null。P3/P4 的 REST/WS 调用消费它。
  const auth = authed ? authRef.current : null;

  // cohort lane 就绪闸（P3 RFC D1）：已认证 + lane 决策达成（或 3s 兜底）才放行 WS 连接。
  const laneReady = useLaneGate(authed, laneSignal);
  const lane = laneSignal?.lane ?? null;

  const login = useCallback(
    async (email: string, password: string, turnstileToken: string) => {
      setAuthLoading(true);
      setAuthError(null);
      try {
        // 服务端 /api/auth/login schema 必填 turnstile_token。turnstileToken 由 AuthGate 给出：
        // canary（turnstile_bypass:true）发占位 'bypass'（服务端接受任意串）；生产（bypass 关闭）
        // 为真实 Cloudflare Turnstile widget 的 onSuccess token。canary 登录行为不变。
        // 登录拿到内存态 accessToken + 用户信息；token 只写进 tokenRef（内存），绝不落地。
        // refresh token 由后端通过 HttpOnly cookie 下发（api.login credentials:'include'）。
        const res = await api.login(email, password, turnstileToken);
        tokenRef.current = res.accessToken;
        setAuthed(true);
        setUser(res.user);
        // lane 决策达成（cookie 已随登录响应 Set-Cookie 下发）：解锁 WS 连接前置。
        setLaneSignal({ lane: res.lane ?? null });
        cbRef.current.onLoginSuccess?.();
      } catch (e) {
        setAuthError((e as Error).message || "登录失败");
      } finally {
        setAuthLoading(false);
      }
    },
    [],
  );

  // 启动静默续期：凭同源 HttpOnly refresh cookie 换 access token → getMe 恢复用户。
  // api.refresh() 失败恒返 null（绝不抛），无 cookie 时开销一次 401 往返。仅挂载跑一次。
  useEffect(() => {
    if (!booting) return;
    let cancelled = false;
    void (async () => {
      const r = await api.refresh();
      // accessToken 必须真实存在：200 但空 body（异常网关/mock）不算有会话，防半开登录态。
      if (!r?.accessToken) {
        if (!cancelled) setBooting(false);
        return;
      }
      tokenRef.current = r.accessToken;
      try {
        const me = await api.getMe(authRef.current);
        if (cancelled) return;
        setUser(me);
        setAuthed(true);
        // lane 决策达成（cookie 随 /api/me 响应下发）：解锁 WS 连接前置。
        setLaneSignal({ lane: me.lane ?? null });
        cbRef.current.onBootAuthed?.();
      } catch {
        // token 换到了但 getMe 失败（瞬时网络/服务端抖动）：不半开登录态，回首页手动登录。
        tokenRef.current = null;
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // booting 仅由本 effect 置 false，等效"挂载跑一次"。
  }, [booting]);

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
    // 先请求后端吊销 refresh cookie（错误已在 api 层吞掉），并经 onLogout 清本 user 的
    // IndexedDB 命名空间（隐私，类比 P5 媒体缓存按 authKey 失效），再清空内存态回到首页。
    if (!demo) {
      void api.logout();
      cbRef.current.onLogout?.();
    }
    clearAuth();
  }, [demo, clearAuth]);

  // 刷新账户余额（GET /api/me）：充值到账 / 打开计费面板后调用，让顶栏 balance-pill
  // 与账户分区拿到权威 credits（字符串大数，原样存进 user）。失败静默（401 会触发 onExpired）。
  const refreshMe = useCallback(async () => {
    if (demo || !authed) return;
    try {
      const me = await api.getMe(authRef.current);
      setUser(me);
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
