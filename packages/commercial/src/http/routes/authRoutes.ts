import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "../util.js";
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "../cookies.js";
import { register, RegisterError } from "../../auth/register.js";
import {
  confirmPasswordReset,
  issueVerifiedUserSession,
  requestPasswordReset,
  resendVerification,
  verifyEmail,
  VerifyError,
} from "../../auth/verify.js";
import { login, LoginError, logout, refresh, RefreshError } from "../../auth/login.js";
import { recordProductFrictionEvent } from "../../productFriction/events.js";
import { query } from "../../db/queries.js";
import { verifyCommercialJwtSync } from "../../auth/jwtSync.js";
import { getSystemSetting } from "../../admin/systemSettings.js";
import {
  DEFAULT_RATE_LIMITS,
  enforceRateLimit,
  hashEmailForRateLimit,
  reissueClientIp,
  resolveLaneAndApply,
  type CommercialHttpDeps,
  type RequestContext,
} from "./shared.js";
import type { RateLimitConfig } from "../../middleware/rateLimit.js";

function parseFunnelUserId(raw: string | bigint | null | undefined): bigint | null {
  if (raw == null) return null;
  if (typeof raw === "bigint") return raw;
  return /^\d+$/.test(raw) ? BigInt(raw) : null;
}

async function emitAuthFunnel(input: {
  correlation: string;
  userId?: string | bigint | null;
  stage: "register" | "verify" | "resend" | "login";
  code: string;
  outcome: "succeeded" | "failed";
}): Promise<void> {
  await recordProductFrictionEvent({
    correlation: input.correlation,
    userId: parseFunnelUserId(input.userId),
    surface: "auth",
    stage: input.stage,
    code: input.code,
    outcome: input.outcome,
  }).catch(() => {});
}

export function mapRegisterFunnelCode(
  code: string,
): "CONFLICT" | "TURNSTILE" | "EMAIL_DOMAIN_BLOCKED" | "IP_REGISTRATION_LIMIT" | null {
  if (code === "TURNSTILE_FAILED") return "TURNSTILE";
  if (code === "CONFLICT" || code === "EMAIL_DOMAIN_BLOCKED" || code === "IP_REGISTRATION_LIMIT") {
    return code;
  }
  return null;
}

async function applyIssuedSessionCookies(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  session: { refresh_token: string; refresh_exp: number; remember: boolean; user: { id: string } },
): Promise<"active" | "candidate"> {
  const ttl = Math.max(0, session.refresh_exp - Math.floor(Date.now() / 1000));
  setRefreshCookie(res, session.refresh_token, ttl, {
    secure: deps.refreshCookieSecure,
    persistent: session.remember,
  });
  return resolveLaneAndApply(req, res, String(session.user.id), deps.refreshCookieSecure);
}

function appendOcSessionCookie(
  req: IncomingMessage,
  res: ServerResponse,
  value: string,
  maxAge: number,
): void {
  const socket = req.socket as { encrypted?: boolean };
  const xfp = req.headers["x-forwarded-proto"];
  const isLoopback = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress ?? "");
  const secure = socket.encrypted || (isLoopback && xfp === "https") ? "; Secure" : "";
  const line = `oc_session=${value}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${maxAge}`;
  const existing = res.getHeader("Set-Cookie");
  if (existing == null) {
    res.setHeader("Set-Cookie", line);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, line]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), line]);
  }
}

export async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const [allowReg, blocklistSetting] = await Promise.all([
    getSystemSetting("allow_registration"),
    getSystemSetting("register_email_domain_blocklist"),
  ]);
  if (allowReg.value !== true) {
    throw new HttpError(403, "REGISTRATION_DISABLED", "已关闭新用户注册");
  }
  const cfg = deps.rateLimits?.register ?? DEFAULT_RATE_LIMITS.register;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = await readJsonBody(req);
  try {
    const result = await register(body, {
      mailer: deps.mailer,
      turnstileSecret: deps.turnstileSecret,
      turnstileBypass: deps.turnstileBypass,
      turnstileBypassAccounts: deps.turnstileBypassAccounts,
      turnstileEnforce: deps.turnstileEnforce,
      fetchImpl: deps.fetchImpl,
      remoteIp: ctx.clientIp,
      verifyEmailUrlBase: deps.verifyEmailUrlBase,
      emailDomainBlocklist: blocklistSetting.value,
    });
    await emitAuthFunnel({
      correlation: ctx.requestId,
      userId: result.user_id,
      stage: "register",
      code: "REGISTERED",
      outcome: "succeeded",
    });
    sendJson(res, 201, {
      user_id: result.user_id,
      verify_email_sent: result.verify_email_sent,
    });
  } catch (err) {
    if (err instanceof RegisterError) {
      const funnelCode = mapRegisterFunnelCode(err.code);
      if (funnelCode) {
        await emitAuthFunnel({
          correlation: ctx.requestId,
          stage: "register",
          code: funnelCode,
          outcome: "failed",
        });
      }
      const map: Record<string, { status: number }> = {
        VALIDATION: { status: 400 },
        TURNSTILE_FAILED: { status: 400 },
        CONFLICT: { status: 409 },
        EMAIL_DOMAIN_BLOCKED: { status: 400 },
        IP_REGISTRATION_LIMIT: { status: 403 },
      };
      const m = map[err.code];
      throw new HttpError(m.status, err.code, err.message, { issues: err.issues });
    }
    throw err;
  }
}

export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.login ?? DEFAULT_RATE_LIMITS.login;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = await readJsonBody(req);
  const loginEmail = (body as { email?: unknown } | null)?.email;
  if (typeof loginEmail === "string" && loginEmail.length > 0) {
    const emailCfg = deps.rateLimits?.loginEmail ?? DEFAULT_RATE_LIMITS.loginEmail;
    await enforceRateLimit(deps, emailCfg, hashEmailForRateLimit(loginEmail));
  }
  try {
    const result = await login(body, {
      jwtSecret: deps.jwtSecret,
      turnstileSecret: deps.turnstileSecret,
      turnstileBypass: deps.turnstileBypass,
      turnstileBypassAccounts: deps.turnstileBypassAccounts,
      turnstileEnforce: deps.turnstileEnforce,
      fetchImpl: deps.fetchImpl,
      remoteIp: ctx.clientIp,
      bindIp: ctx.authBoundIp,
      clientIp: reissueClientIp(req, ctx),
      userAgent: ctx.userAgent ?? undefined,
      requireEmailVerified: deps.requireEmailVerified,
      replaceRefreshToken: readRefreshCookie(req),
    });
    const lane = await applyIssuedSessionCookies(req, res, deps, result);
    await emitAuthFunnel({
      correlation: ctx.requestId,
      userId: result.user.id,
      stage: "login",
      code: "email",
      outcome: "succeeded",
    });
    sendJson(res, 200, {
      user: result.user,
      access_token: result.access_token,
      access_exp: result.access_exp,
      refresh_exp: result.refresh_exp,
      remember: result.remember,
      lane,
    });
  } catch (err) {
    if (err instanceof LoginError) {
      const map: Record<string, { status: number }> = {
        VALIDATION: { status: 400 },
        TURNSTILE_FAILED: { status: 400 },
        INVALID_CREDENTIALS: { status: 401 },
        EMAIL_NOT_VERIFIED: { status: 403 },
      };
      const m = map[err.code];
      throw new HttpError(m.status, err.code, err.message, { issues: err.issues });
    }
    throw err;
  }
}

export async function handleResendVerification(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.resendVerify ?? DEFAULT_RATE_LIMITS.resendVerify;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = (await readJsonBody(req)) as { email?: unknown } | undefined;
  const email =
    body && typeof (body as Record<string, unknown>).email === "string"
      ? (body as { email: string }).email
      : "";
  const r = await resendVerification(email, {
    mailer: deps.mailer,
    verifyEmailUrlBase: deps.verifyEmailUrlBase,
  });
  let resendUserId: string | null = null;
  if (email) {
    const looked = await query<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE email = $1 AND status != 'deleted' LIMIT 1`,
      [email.trim().toLowerCase()],
    ).catch(() => ({ rows: [] as Array<{ id: string }> }));
    resendUserId = looked.rows[0]?.id ?? null;
  }
  if (resendUserId) {
    await emitAuthFunnel({
      correlation: ctx.requestId,
      userId: resendUserId,
      stage: "resend",
      code: "RESEND",
      outcome: "succeeded",
    });
  }
  sendJson(res, 200, { accepted: r.accepted, email_sent: r.email_sent });
}

export async function handleCheckVerification(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg: RateLimitConfig = { scope: "check_verification", windowSeconds: 60, max: 30 };
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    sendJson(res, 200, { verified: false });
    return;
  }
  const result = await query<{ email_verified: boolean }>(
    `SELECT email_verified FROM users WHERE email = $1`,
    [email],
  );
  const verified = result.rows.length > 0 && result.rows[0].email_verified === true;
  sendJson(res, 200, { verified });
}

async function readRefreshTokenFromRequest(req: IncomingMessage): Promise<string | null> {
  const fromCookie = readRefreshCookie(req);
  if (fromCookie) return fromCookie;
  const body = (await readJsonBody(req)) as { refresh_token?: unknown } | undefined;
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).refresh_token === "string") {
    return (body as { refresh_token: string }).refresh_token;
  }
  return null;
}

export async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.refresh ?? DEFAULT_RATE_LIMITS.refresh;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const rawRefresh = await readRefreshTokenFromRequest(req);
  if (!rawRefresh) {
    throw new HttpError(400, "VALIDATION", "refresh_token is required");
  }
  try {
    const r = await refresh(rawRefresh, {
      jwtSecret: deps.jwtSecret,
      remoteIp: ctx.authBoundIp,
      clientIp: reissueClientIp(req, ctx),
      userAgent: ctx.userAgent ?? undefined,
      onReissued: (ev) => {
        ctx.log.info("refresh_reissued", { family_id: ev.family_id, user_id: ev.user_id });
      },
    });
    const cookieTtl = Math.max(1, r.refresh_exp - Math.floor(Date.now() / 1000));
    setRefreshCookie(res, r.refresh_token, cookieTtl, {
      secure: deps.refreshCookieSecure,
      persistent: r.remember,
    });
    const lane = await resolveLaneAndApply(req, res, r.user_id, deps.refreshCookieSecure);
    sendJson(res, 200, {
      access_token: r.access_token,
      access_exp: r.access_exp,
      remember: r.remember,
      lane,
    });
  } catch (err) {
    if (err instanceof RefreshError) {
      const status = err.code === "VALIDATION" ? 400 : 401;
      if (err.code === "INVALID_REFRESH") {
        clearRefreshCookie(res, { secure: deps.refreshCookieSecure });
      }
      throw new HttpError(status, err.code, err.message);
    }
    throw err;
  }
}

export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.logout ?? DEFAULT_RATE_LIMITS.logout;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const rawRefresh = (await readRefreshTokenFromRequest(req)) ?? "";
  const r = await logout(rawRefresh);
  clearRefreshCookie(res, { secure: deps.refreshCookieSecure });
  sendJson(res, 200, { revoked: r.revoked });
}

export async function handleVerifyEmail(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.verifyEmail ?? DEFAULT_RATE_LIMITS.verifyEmail;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = (await readJsonBody(req)) as { email?: unknown; code?: unknown } | undefined;
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).email !== "string" ||
    typeof (body as Record<string, unknown>).code !== "string"
  ) {
    throw new HttpError(400, "VALIDATION", "email and code are required");
  }
  const { email, code } = body as { email: string; code: string };
  const emailCfg = deps.rateLimits?.verifyEmailEmail ?? DEFAULT_RATE_LIMITS.verifyEmailEmail;
  await enforceRateLimit(deps, emailCfg, hashEmailForRateLimit(email));
  const blocklistSetting = await getSystemSetting("register_email_domain_blocklist");
  try {
    const r = await verifyEmail(email, code, {
      emailDomainBlocklist: blocklistSetting.value,
    });
    if (r.newly_verified) {
      deps.prewarmContainer?.(BigInt(r.user_id));
    }
    const session = await issueVerifiedUserSession(r.user_id, {
      jwtSecret: deps.jwtSecret,
      bindIp: ctx.authBoundIp,
      clientIp: reissueClientIp(req, ctx),
      userAgent: ctx.userAgent ?? undefined,
      replaceRefreshToken: readRefreshCookie(req),
    });
    const lane = await applyIssuedSessionCookies(req, res, deps, session);
    await emitAuthFunnel({
      correlation: ctx.requestId,
      userId: r.user_id,
      stage: "verify",
      code: "VERIFIED",
      outcome: "succeeded",
    });
    sendJson(res, 200, {
      user_id: r.user_id,
      newly_verified: r.newly_verified,
      user: session.user,
      access_token: session.access_token,
      access_exp: session.access_exp,
      refresh_exp: session.refresh_exp,
      remember: session.remember,
      lane,
    });
  } catch (err) {
    if (err instanceof VerifyError) {
      await emitAuthFunnel({
        correlation: ctx.requestId,
        stage: "verify",
        code: err.code,
        outcome: "failed",
      });
      const status = err.code === "ACCOUNT_UNAVAILABLE" ? 403 : 400;
      throw new HttpError(status, err.code, err.message);
    }
    throw err;
  }
}

export async function handleRequestPasswordReset(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.requestReset ?? DEFAULT_RATE_LIMITS.requestReset;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = (await readJsonBody(req)) as { email?: unknown; turnstile_token?: unknown } | undefined;
  const email =
    body && typeof (body as Record<string, unknown>).email === "string"
      ? (body as { email: string }).email
      : "";
  const turnstileToken =
    body && typeof (body as Record<string, unknown>).turnstile_token === "string"
      ? (body as { turnstile_token: string }).turnstile_token
      : "";
  try {
    const r = await requestPasswordReset(
      { email, turnstile_token: turnstileToken },
      {
        mailer: deps.mailer,
        resetUrlBase: deps.resetPasswordUrlBase,
        turnstileSecret: deps.turnstileSecret,
        turnstileBypass: deps.turnstileBypass,
        turnstileBypassAccounts: deps.turnstileBypassAccounts,
        turnstileEnforce: deps.turnstileEnforce,
        remoteIp: ctx.clientIp,
        fetchImpl: deps.fetchImpl,
      },
    );
    sendJson(res, 200, { accepted: r.accepted });
  } catch (err) {
    if (err instanceof VerifyError) {
      throw new HttpError(400, err.code, err.message);
    }
    throw err;
  }
}

export async function handleConfirmPasswordReset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as { token?: unknown; new_password?: unknown } | undefined;
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).token !== "string" ||
    typeof (body as Record<string, unknown>).new_password !== "string"
  ) {
    throw new HttpError(400, "VALIDATION", "token and new_password are required");
  }
  const { token, new_password } = body as { token: string; new_password: string };
  try {
    const r = await confirmPasswordReset(token, new_password);
    sendJson(res, 200, {
      user_id: r.user_id,
      revoked_refresh_tokens: r.revoked_refresh_tokens,
    });
  } catch (err) {
    if (err instanceof VerifyError) {
      throw new HttpError(400, err.code, err.message);
    }
    throw err;
  }
}

export async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/);
  const token = m?.[1]?.trim() ?? "";
  if (!token) {
    throw new HttpError(401, "UNAUTHORIZED", "bearer token required");
  }
  const claims = verifyCommercialJwtSync(token, deps.jwtSecret);
  if (!claims) {
    throw new HttpError(401, "UNAUTHORIZED", "invalid or expired token");
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(1, claims.exp - now), 30 * 86400);
  appendOcSessionCookie(req, res, token, ttl);
  sendJson(res, 200, { ok: true, maxAge: ttl });
}

export async function handleClearSession(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  appendOcSessionCookie(req, res, "", 0);
  sendJson(res, 200, { ok: true });
}
