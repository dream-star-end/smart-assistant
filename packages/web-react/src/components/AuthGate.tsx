import { ArrowLeft, ArrowRight, Check, MailCheck } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import type { Theme } from "../hooks/useTheme";
import { authErrorMessage } from "../lib/api";
import { BRAND } from "../lib/brand";
import { BrandMark } from "./BrandMark";
import { LEGAL_DOCS, TERMS_VERSION, type LegalKind } from "../lib/legal";
import { LegalDocBody } from "./LegalPage";
import { ThemeToggle } from "./ThemeToggle";
import { TurnstileWidget } from "./TurnstileWidget";
import { Button, Input, Modal, Spinner } from "./ui";

/** 占位 token：canary 开启 TURNSTILE_TEST_BYPASS 时发它即可过（服务端 bypass 接受任意串）。*/
const BYPASS_TOKEN = "bypass";

/** 多模式鉴权表层：登录 / 注册 / 邮箱验证 / 忘记密码 / 重置密码。 */
export type AuthMode = "login" | "register" | "verify" | "forgot" | "reset";

const MIN_PW = 8;

export function AuthGate({
  onLogin,
  onRegister,
  onVerifyEmail,
  onResendVerification,
  onRequestReset,
  onConfirmReset,
  loading,
  error,
  onRetrySession,
  onBack,
  theme,
  onCycleTheme,
  turnstileBypass,
  turnstileSiteKey,
  onRetryPublicConfig,
  allowRegistration = true,
  requireEmailVerified = false,
  initialMode = "login",
  resetToken,
}: {
  // 第三参为 Turnstile token：canary(bypass=true)发占位串 'bypass'；生产(bypass=false)为真
  // widget token；config 未就绪(undefined)时点击只登记登录意图，绝不提交或发占位 token。
  onLogin: (email: string, password: string, turnstileToken: string) => void;
  /** 注册（返回 verifyEmailSent 决定是否进入验证步）。 */
  onRegister?: (input: {
    email: string;
    password: string;
    displayName?: string;
    turnstileToken: string;
    /** 用户勾选同意的协议版本（lib/legal TERMS_VERSION），后端落 users 留证。 */
    termsVersion: string;
  }) => Promise<{ verifyEmailSent: boolean }>;
  /** 邮箱验证（6 位验证码）。 */
  onVerifyEmail?: (email: string, code: string) => Promise<void>;
  /** 重发验证码。 */
  onResendVerification?: (email: string) => Promise<void>;
  /** 发起密码重置（发重置邮件）。 */
  onRequestReset?: (email: string, turnstileToken: string) => Promise<void>;
  /** 用邮件 token 完成密码重置。 */
  onConfirmReset?: (token: string, newPassword: string) => Promise<void>;
  loading?: boolean;
  error?: string | null;
  /** Recover a valid refresh-cookie session after a transient boot fault. */
  onRetrySession?: () => void;
  onBack?: () => void;
  theme: Theme;
  onCycleTheme: () => void;
  /** GET /api/public/config 的 turnstile_bypass；undefined=config 尚未加载。*/
  turnstileBypass?: boolean;
  /** GET /api/public/config 的 turnstile_site_key（!bypass 时 render widget）。*/
  turnstileSiteKey?: string;
  /** 登录意图发生时立即重新加载公开安全配置，不改变或绕过现有 Turnstile 门禁。 */
  onRetryPublicConfig?: () => void;
  /** 是否允许注册（公开配置 allow_registration）；false 时隐藏注册入口。 */
  allowRegistration?: boolean;
  /** 是否强制邮箱验证后才能登录（公开配置 require_email_verified）。 */
  requireEmailVerified?: boolean;
  /** 初始模式：登录页与「免费开始」入口均用 login，重置链接用 reset。 */
  initialMode?: AuthMode;
  /** 重置密码邮件链接里的 token（mode=reset 时必有）。 */
  resetToken?: string;
}) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPwConfirm, setNewPwConfirm] = useState("");
  // 真实 Turnstile token（仅 !bypass 且 widget onSuccess 后非空）。
  const [token, setToken] = useState<string | null>(null);
  // config 未知时允许用户点一次登录：凭据快照等安全配置/token 就绪后恰好消费一次。
  const pendingLoginRef = useRef<{ email: string; password: string } | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  // 非 login 子流程的自管 loading / 错误 / 成功提示（login 仍用上层 loading/error props）。
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [cooldown, setCooldown] = useState(0); // 重发验证码冷却秒数
  // 注册页协议勾选：默认不勾选（监管要求不得默认同意），未勾选提交时给出明确提示
  // 而非禁用按钮——可发现性优于静默禁用。登录页走「登录即代表同意」文案式（业界 Web 端惯例）。
  const [agreeTerms, setAgreeTerms] = useState(false);

  // ── Turnstile 三态 fail-closed（与历史一致）──────────────────────────────
  const bypassKnown = typeof turnstileBypass === "boolean";
  const needsWidget = turnstileBypass === false;
  const submitToken = turnstileBypass === true ? BYPASS_TOKEN : token;
  // 仅 login/register/forgot 需要人机验证；verify(用验证码)/reset(用邮件 token)不需要。
  const modeNeedsTurnstile = mode === "login" || mode === "register" || mode === "forgot";
  const turnstileReady = bypassKnown && (turnstileBypass === true || !!token);

  function clearPendingLogin() {
    pendingLoginRef.current = null;
    setLoginPending(false);
  }

  // 切换模式：复位瞬时态（token/错误/提示/busy），保留已填的 email/password 便于衔接。
  // opGen 递增 → 让任何在途异步提交的迟到回调失效（防旧请求劫持新模式）。
  function go(next: AuthMode) {
    opGen.current += 1;
    clearPendingLogin();
    setMode(next);
    setLocalErr(null);
    setNotice(null);
    setToken(null);
    setBusy(false);
    setResetSent(false);
  }

  // 重发验证码冷却倒计时：effect 驱动，自清理、卸载安全（无悬挂 interval）。
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  // 卸载/换代守卫：异步提交（注册/验证/重置等）的迟到回调，若组件已卸载或期间用户已切模式/
  // 重新提交（opGen 递增），一律丢弃 —— 杜绝卸载后 setState 与「旧请求劫持新模式」。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const opGen = useRef(0);
  // 当前回调是否仍有效（组件在挂载且本次操作未被新操作/模式切换取代）。
  const alive = (gen: number) => mountedRef.current && opGen.current === gen;

  // 配置确认禁止注册后，若仍停在注册表单（如 initialMode=register 或用户切到注册页），硬兜底回登录。
  // opGen 递增：万一 config 动态刷新时有在途注册请求，迟到回调一并失效。
  useEffect(() => {
    if (mode === "register" && !allowRegistration) {
      opGen.current += 1;
      setMode("login");
      setLocalErr(null);
      setNotice("当前暂未开放注册，可先登录已有账号。");
    }
  }, [mode, allowRegistration]);

  const busyNow = mode === "login" ? !!loading : busy;
  const shownErr = mode === "login" ? error || localErr : localErr;

  // config 未知时用户已点登录：等待 bypass 或真 widget token 就绪后，先原子消费 intent
  // 再提交。ref 先清空可抵御 StrictMode/effect 重跑，绝不重复登录。
  useEffect(() => {
    if (mode !== "login" || busyNow || !turnstileReady || !submitToken) return;
    const pending = pendingLoginRef.current;
    if (!pending) return;
    pendingLoginRef.current = null;
    setLoginPending(false);
    onLogin(pending.email, pending.password, submitToken);
  }, [mode, busyNow, turnstileReady, submitToken, onLogin]);

  // ── 各模式提交 ───────────────────────────────────────────────────────────
  function submitLogin() {
    const normalizedEmail = email.trim();
    if (busyNow || loginPending || !normalizedEmail || !password) return;
    if (!turnstileReady || !submitToken) {
      if (!bypassKnown) {
        pendingLoginRef.current = { email: normalizedEmail, password };
        setLoginPending(true);
        onRetryPublicConfig?.();
      }
      return;
    }
    onLogin(normalizedEmail, password, submitToken);
  }

  async function submitRegister() {
    // 配置确认禁止注册时拒绝提交（与隐藏入口 + 模式兜底配合，三重 fail-closed）。
    if (!onRegister || !allowRegistration) return;
    setLocalErr(null);
    if (password.length < MIN_PW) {
      setLocalErr(`密码至少 ${MIN_PW} 位`);
      return;
    }
    if (password !== confirmPw) {
      setLocalErr("两次输入的密码不一致");
      return;
    }
    if (!agreeTerms) {
      setLocalErr("请先阅读并勾选同意《用户协议》与《隐私政策》");
      return;
    }
    if (!turnstileReady || !submitToken) return;
    const gen = ++opGen.current;
    setBusy(true);
    try {
      const r = await onRegister({
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
        turnstileToken: submitToken,
        termsVersion: TERMS_VERSION,
      });
      if (!alive(gen)) return;
      if (requireEmailVerified || r.verifyEmailSent) {
        go("verify");
        setNotice(
          r.verifyEmailSent
            ? `验证码已发送至 ${email.trim()}，请查收（含垃圾箱）。`
            : "账号已创建，但验证邮件发送失败，请点下方重新发送。",
        );
        setCooldown(60);
      } else {
        go("login");
        setNotice("注册成功，请登录。");
      }
    } catch (e) {
      if (!alive(gen)) return;
      setBusy(false);
      setLocalErr(authErrorMessage(e) || "注册失败，请重试。");
    }
  }

  async function submitVerify() {
    if (!onVerifyEmail) return;
    setLocalErr(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setLocalErr("请输入 6 位数字验证码");
      return;
    }
    const gen = ++opGen.current;
    setBusy(true);
    try {
      await onVerifyEmail(email.trim(), code.trim());
      if (!alive(gen)) return;
      go("login");
      setNotice("邮箱验证成功，请登录。");
    } catch (e) {
      if (!alive(gen)) return;
      setBusy(false);
      setLocalErr(authErrorMessage(e) || "验证失败，请检查验证码。");
    }
  }

  async function resendCode() {
    if (!onResendVerification || cooldown > 0) return;
    setLocalErr(null);
    const gen = opGen.current;
    try {
      await onResendVerification(email.trim());
      if (!alive(gen)) return;
      setNotice("验证码已重新发送，请查收。");
      setCooldown(60);
    } catch (e) {
      if (!alive(gen)) return;
      setLocalErr(authErrorMessage(e) || "发送失败，请稍后再试。");
    }
  }

  async function submitForgot() {
    if (!onRequestReset) return;
    setLocalErr(null);
    if (!email.trim()) {
      setLocalErr("请输入邮箱");
      return;
    }
    if (!turnstileReady || !submitToken) return;
    const gen = ++opGen.current;
    setBusy(true);
    try {
      await onRequestReset(email.trim(), submitToken);
      if (!alive(gen)) return;
      setBusy(false);
      setResetSent(true);
    } catch (e) {
      if (!alive(gen)) return;
      setBusy(false);
      setLocalErr(authErrorMessage(e) || "发送失败，请重试。");
    }
  }

  async function submitReset() {
    if (!onConfirmReset || !resetToken) return;
    setLocalErr(null);
    if (newPw.length < MIN_PW) {
      setLocalErr(`新密码至少 ${MIN_PW} 位`);
      return;
    }
    if (newPw !== newPwConfirm) {
      setLocalErr("两次输入的密码不一致");
      return;
    }
    const gen = ++opGen.current;
    setBusy(true);
    try {
      await onConfirmReset(resetToken, newPw);
      if (!alive(gen)) return;
      // 清掉 URL 上的重置 token，回到登录。
      try {
        window.history.replaceState({}, "", "/");
      } catch {
        /* ignore */
      }
      go("login");
      setNotice("密码已重置，请用新密码登录。");
    } catch (e) {
      if (!alive(gen)) return;
      setBusy(false);
      setLocalErr(authErrorMessage(e) || "重置失败，链接可能已过期，请重新申请。");
    }
  }

  const titles: Record<AuthMode, { h: string; sub: string }> = {
    login: { h: `欢迎使用 ${BRAND.name}`, sub: BRAND.tagline },
    register: { h: "创建账号", sub: "注册即可免费开始，每月赠 300 积分" },
    verify: { h: "验证邮箱", sub: `验证码已发往 ${email.trim() || "你的邮箱"}` },
    forgot: { h: "找回密码", sub: "输入注册邮箱，我们发你一个重置链接" },
    reset: { h: "设置新密码", sub: "为你的账号设置一个新密码" },
  };

  // 真 widget 仅在需要人机验证的模式渲染；token 拿到前禁用提交。
  const widget = modeNeedsTurnstile && needsWidget && (
    <div className="flex justify-center">
      <TurnstileWidget
        key={mode}
        siteKey={turnstileSiteKey ?? ""}
        theme={theme === "system" ? "auto" : theme}
        onToken={setToken}
        onExpire={() => setToken(null)}
        onError={() => setToken(null)}
      />
    </div>
  );
  const turnstileGate = modeNeedsTurnstile && !bypassKnown ? (
    <output className="flex items-center justify-center gap-2 text-[13px] text-muted">
      <Spinner size={15} />
      <span>正在准备登录…</span>
    </output>
  ) : (
    widget
  );

  const errBox = shownErr && (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger"
    >
      {shownErr}
    </div>
  );
  const noticeBox = notice && (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-xl border border-success/30 bg-success-soft px-3.5 py-2.5 text-[13px] text-success"
    >
      <Check size={15} className="mt-0.5 shrink-0" />
      <span>{notice}</span>
    </div>
  );

  return (
    <div className="relative h-full overflow-y-auto bg-bg">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -10%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%)",
        }}
      />
      {onBack && mode !== "reset" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={mode === "login" ? onBack : () => go("login")}
          className="absolute left-4 top-4 z-10 gap-1.5 text-muted"
        >
          <ArrowLeft size={15} />
          {mode === "login" ? "返回首页" : "返回登录"}
        </Button>
      )}
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle theme={theme} onCycle={onCycleTheme} />
      </div>

      {/* 滚动容器内居中：内容短则垂直居中，内容高(注册4字段/小屏)则可滚动不被裁。 */}
      <div className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="relative w-full max-w-[400px] animate-in">
        <div className="mb-7 flex flex-col items-center text-center">
          {/* 品牌一致性:与落地页同一个「从」字方块(共享 BrandMark),
              替换原紫色渐变 Sparkles —— 用户从落地页点「登录」进来不再像换了个产品。 */}
          <BrandMark className="mb-4 size-12" fontSize="text-[24px]" />
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">{titles[mode].h}</h1>
          <p className="mt-1.5 text-[14px] text-muted">{titles[mode].sub}</p>
        </div>

        {/* ── 登录 ── */}
        {mode === "login" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitLogin();
            }}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft"
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted">邮箱</span>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                autoComplete="email"
                placeholder="邮箱"
                className="rounded-xl bg-bg"
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-muted">密码</span>
                {onRequestReset && (
                  <button
                    type="button"
                    onClick={() => go("forgot")}
                    className="text-[12.5px] text-accent hover:underline"
                  >
                    忘记密码？
                  </button>
                )}
              </div>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
                placeholder="密码"
                aria-label="密码"
                className="rounded-xl bg-bg"
              />
            </div>

            {errBox}
            {shownErr && onRetrySession && (
              <Button type="button" variant="secondary" onClick={onRetrySession} className="w-full">
                重试恢复登录状态
              </Button>
            )}
            {noticeBox}
            {turnstileGate}

            <Button
              type="submit"
              variant="primary"
              disabled={
                busyNow ||
                loginPending ||
                !email.trim() ||
                !password ||
                (bypassKnown && !turnstileReady)
              }
              className="mt-1 w-full gap-2 rounded-xl text-[14.5px]"
            >
              {busyNow || loginPending ? <Spinner size={17} /> : (<>登录<ArrowRight size={16} /></>)}
            </Button>

            {allowRegistration && onRegister && (
              <p className="mt-1 text-center text-[13px] text-muted">
                还没有账号？
                <button type="button" onClick={() => go("register")} className="ml-1 font-medium text-accent hover:underline">
                  立即注册
                </button>
              </p>
            )}

            <p className="mt-1 text-center text-[12px] leading-5 text-faint">
              登录即代表你已阅读并同意<LegalLinks />
            </p>
          </form>
        )}

        {/* ── 注册 ── */}
        {mode === "register" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitRegister();
            }}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft"
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted">邮箱</span>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                autoComplete="email"
                placeholder="邮箱"
                className="rounded-xl bg-bg"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted">昵称（可选）</span>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                type="text"
                autoComplete="nickname"
                placeholder="怎么称呼你"
                className="rounded-xl bg-bg"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted">密码</span>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete="new-password"
                placeholder={`至少 ${MIN_PW} 位`}
                className="rounded-xl bg-bg"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted">确认密码</span>
              <Input
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                type="password"
                autoComplete="new-password"
                placeholder="再输一次密码"
                className="rounded-xl bg-bg"
              />
            </label>

            <label className="flex items-start gap-2 text-[12.5px] leading-5 text-muted">
              <input
                type="checkbox"
                checked={agreeTerms}
                onChange={(e) => setAgreeTerms(e.target.checked)}
                className="mt-0.5 accent-[var(--accent,#6d5efc)]"
              />
              <span>
                我已阅读并同意<LegalLinks />
              </span>
            </label>

            {errBox}
            {turnstileGate}

            <Button
              type="submit"
              variant="primary"
              disabled={busyNow || !email.trim() || !password || !confirmPw || !turnstileReady}
              className="mt-1 w-full gap-2 rounded-xl text-[14.5px]"
            >
              {busyNow ? <Spinner size={17} /> : (<>创建账号<ArrowRight size={16} /></>)}
            </Button>

            <p className="mt-1 text-center text-[13px] text-muted">
              已有账号？
              <button type="button" onClick={() => go("login")} className="ml-1 font-medium text-accent hover:underline">
                去登录
              </button>
            </p>
          </form>
        )}

        {/* ── 邮箱验证 ── */}
        {mode === "verify" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitVerify();
            }}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft"
          >
            {noticeBox}
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted">6 位验证码</span>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="请输入邮箱里的 6 位验证码"
                className="rounded-xl bg-bg text-center text-[18px] tracking-[0.4em]"
              />
            </label>

            {errBox}

            <Button
              type="submit"
              variant="primary"
              disabled={busyNow || !/^\d{6}$/.test(code.trim())}
              className="mt-1 w-full gap-2 rounded-xl text-[14.5px]"
            >
              {busyNow ? <Spinner size={17} /> : (<>验证并继续<ArrowRight size={16} /></>)}
            </Button>

            {onResendVerification && (
              <button
                type="button"
                onClick={() => void resendCode()}
                disabled={cooldown > 0}
                className="mt-1 text-center text-[13px] text-accent hover:underline disabled:text-faint disabled:no-underline"
              >
                {cooldown > 0 ? `重新发送（${cooldown}s）` : "没收到？重新发送验证码"}
              </button>
            )}
          </form>
        )}

        {/* ── 忘记密码（发重置邮件）── */}
        {mode === "forgot" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitForgot();
            }}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft"
          >
            {resetSent ? (
              <div className="flex flex-col items-center gap-3 py-3 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
                  <MailCheck size={26} />
                </span>
                <p className="text-[14px] text-fg">
                  如果 <span className="font-medium">{email.trim()}</span> 已注册，重置链接已发出。
                </p>
                <p className="text-[12.5px] text-faint">请查收邮件（含垃圾箱），点击链接设置新密码。</p>
                <Button variant="secondary" onClick={() => go("login")} className="mt-1 rounded-xl">
                  返回登录
                </Button>
              </div>
            ) : (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-muted">邮箱</span>
                  <Input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                    autoComplete="email"
                    placeholder="注册邮箱"
                    className="rounded-xl bg-bg"
                  />
                </label>

                {errBox}
                {turnstileGate}

                <Button
                  type="submit"
                  variant="primary"
                  disabled={busyNow || !email.trim() || !turnstileReady}
                  className="mt-1 w-full gap-2 rounded-xl text-[14.5px]"
                >
                  {busyNow ? <Spinner size={17} /> : (<>发送重置链接<ArrowRight size={16} /></>)}
                </Button>

                <p className="mt-1 text-center text-[13px] text-muted">
                  想起来了？
                  <button type="button" onClick={() => go("login")} className="ml-1 font-medium text-accent hover:underline">
                    返回登录
                  </button>
                </p>
              </>
            )}
          </form>
        )}

        {/* ── 重置密码（邮件链接 token）── */}
        {mode === "reset" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitReset();
            }}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft"
          >
            {!resetToken ? (
              <div className="flex flex-col items-center gap-3 py-3 text-center">
                <p className="text-[14px] text-fg">重置链接无效或缺少 token。</p>
                <Button variant="secondary" onClick={() => go("forgot")} className="rounded-xl">
                  重新申请重置
                </Button>
              </div>
            ) : (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-muted">新密码</span>
                  <Input
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    type="password"
                    autoComplete="new-password"
                    placeholder={`至少 ${MIN_PW} 位`}
                    className="rounded-xl bg-bg"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-muted">确认新密码</span>
                  <Input
                    value={newPwConfirm}
                    onChange={(e) => setNewPwConfirm(e.target.value)}
                    type="password"
                    autoComplete="new-password"
                    placeholder="再输一次新密码"
                    className="rounded-xl bg-bg"
                  />
                </label>

                {errBox}

                <Button
                  type="submit"
                  variant="primary"
                  disabled={busyNow || newPw.length < MIN_PW || !newPwConfirm}
                  className="mt-1 w-full gap-2 rounded-xl text-[14.5px]"
                >
                  {busyNow ? <Spinner size={17} /> : (<>重置密码<ArrowRight size={16} /></>)}
                </Button>
              </>
            )}
          </form>
        )}

        <p className="mt-4 text-center text-[12px] text-faint">全能助手 · 流式对话 · 持久会话</p>
      </div>
      </div>
    </div>
  );
}

/**
 * 《用户协议》《隐私政策》链接对：普通点击就地弹窗展示正文（Modal 正文区自带
 * overflow-y-auto 滚动条），带修饰键/中键仍按 <a href> 原生行为新标签打开 /terms /privacy。
 * 用 <a> 而非 button：登录/注册按钮的可及名唯一性有测试红线（getByRole("button")），
 * 且 <a href> 属交互内容，位于 <label> 内点击时按 HTML 规范不会触发 label 的
 * checkbox 激活转发——链接可点、勾选不误触。弹窗经 Radix Portal 渲染在 body 下,
 * 不落在 <label> DOM 内,同样不会误触勾选。
 */
function LegalLinks() {
  const [openDoc, setOpenDoc] = useState<LegalKind | null>(null);

  const openInModal = (kind: LegalKind) => (e: ReactMouseEvent<HTMLAnchorElement>) => {
    // 修饰键/非主键点击保留浏览器原生"新标签打开"语义,只有普通左键点击走弹窗。
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setOpenDoc(kind);
  };

  return (
    <>
      <a
        href="/terms"
        target="_blank"
        rel="noreferrer"
        onClick={openInModal("terms")}
        className="text-accent hover:underline"
      >
        《用户协议》
      </a>
      与
      <a
        href="/privacy"
        target="_blank"
        rel="noreferrer"
        onClick={openInModal("privacy")}
        className="text-accent hover:underline"
      >
        《隐私政策》
      </a>
      <Modal
        open={openDoc !== null}
        onOpenChange={(open) => {
          if (!open) setOpenDoc(null);
        }}
        title={openDoc ? LEGAL_DOCS[openDoc].title : ""}
        description={openDoc ? `更新日期:${LEGAL_DOCS[openDoc].updated} · 生效日期:${LEGAL_DOCS[openDoc].updated}` : ""}
        className="max-w-2xl"
      >
        {openDoc && <LegalDocBody kind={openDoc} />}
      </Modal>
    </>
  );
}
