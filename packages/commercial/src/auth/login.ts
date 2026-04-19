/**
 * T-14 — 登录 / Refresh / Logout 业务函数。
 *
 * 不挂路由 — 这里只是纯函数,T-16 才挂到 Express。
 *
 * 设计要点(05-SEC §2/§3):
 *   - 错误密码 / 不存在用户 / 被封号 一律返回 INVALID_CREDENTIALS,不区分细节
 *   - 即使 email 不存在也跑一次 argon2 verify(用 dummy hash),抹平时间侧信道
 *   - 未验证邮箱:**允许登录**,但 user 对象上 `email_verified=false`,前端提示
 *   - 软删除/封号:UNAUTHORIZED 走同一个错误码(防枚举)
 *   - access JWT + opaque refresh token,refresh 入库存 sha256 hash
 *   - refresh 旋转:本任务**不**强制 rotate(MVP 简化),但 logout 必须置 revoked_at
 *   - turnstile 校验复用 T-12 模块
 */

import { z } from "zod";
import { query } from "../db/queries.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { signAccess, issueRefresh, refreshTokenHash, REFRESH_TOKEN_TTL_SECONDS } from "./jwt.js";
import { verifyTurnstile, TurnstileError } from "./turnstile.js";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "invalid email format");

const passwordSchema = z.string().min(1).max(72);

export const loginInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  turnstile_token: z.string().min(1).max(2048),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

export type LoginErrorCode =
  | "VALIDATION"
  | "TURNSTILE_FAILED"
  | "INVALID_CREDENTIALS"
  | "EMAIL_NOT_VERIFIED";

export class LoginError extends Error {
  readonly code: LoginErrorCode;
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
  constructor(
    code: LoginErrorCode,
    message: string,
    issues?: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "LoginError";
    this.code = code;
    this.issues = issues;
  }
}

export type RefreshErrorCode = "VALIDATION" | "INVALID_REFRESH";

export class RefreshError extends Error {
  readonly code: RefreshErrorCode;
  constructor(code: RefreshErrorCode, message: string) {
    super(message);
    this.name = "RefreshError";
    this.code = code;
  }
}

export interface LoginUser {
  id: string;
  email: string;
  email_verified: boolean;
  role: "user" | "admin";
  display_name: string | null;
  avatar_url: string | null;
  credits: string; // BIGINT 用字符串
}

export interface LoginResult {
  user: LoginUser;
  /** access JWT */
  access_token: string;
  /** unix seconds */
  access_exp: number;
  /** opaque refresh token raw(只此一次返回) */
  refresh_token: string;
  /** unix seconds */
  refresh_exp: number;
}

export interface LoginDeps {
  jwtSecret: string | Uint8Array;
  /** turnstile secret(env);bypass 模式可不传 */
  turnstileSecret?: string;
  turnstileBypass?: boolean;
  /** 测试可注入 fetch(传给 turnstile) */
  fetchImpl?: typeof fetch;
  /** 用户 IP / UA — 写到 refresh_tokens 表用于安全审计 */
  remoteIp?: string;
  userAgent?: string;
  /** 测试可注入 now(秒) */
  now?: () => number;
  /** 测试可注入 access TTL */
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  /**
   * T-12.1:开启后,email_verified=false 的用户不允许 login,
   * 会抛 EMAIL_NOT_VERIFIED。默认 false(向后兼容现有测试,
   * 测试普遍 register 后立即 login 不验证邮箱)。生产 env REQUIRE_EMAIL_VERIFIED=1 打开。
   */
  requireEmailVerified?: boolean;
}

/**
 * 用于不存在的 email 走假 verify,抹平时间侧信道。
 * 模块加载时一次性算好 — 否则每次 login 都跑一次 argon2 太慢。
 * 任意一个不会撞库的固定密码即可,这只用于消耗 CPU。
 */
let dummyHashPromise: Promise<string> | null = null;
async function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("dummy-hash-for-timing-equalization");
  }
  return dummyHashPromise;
}

function nowSec(deps?: { now?: () => number }): number {
  return deps?.now ? deps.now() : Math.floor(Date.now() / 1000);
}

export async function login(raw: unknown, deps: LoginDeps): Promise<LoginResult> {
  // 1) zod 校验
  const parsed = loginInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LoginError(
      "VALIDATION",
      "invalid login input",
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  const input = parsed.data;

  // 2) Turnstile
  let turnstileOk = false;
  try {
    turnstileOk = await verifyTurnstile(input.turnstile_token, deps.turnstileSecret, {
      remoteIp: deps.remoteIp,
      bypass: deps.turnstileBypass === true,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    if (err instanceof TurnstileError) {
      throw new LoginError("TURNSTILE_FAILED", "turnstile verification failed");
    }
    throw err;
  }
  if (!turnstileOk) {
    throw new LoginError("TURNSTILE_FAILED", "turnstile verification rejected");
  }

  // 3) 查 user(包含 banned/deleting/deleted)
  const userRow = await query<{
    id: string;
    email: string;
    email_verified: boolean;
    password_hash: string;
    role: "user" | "admin";
    display_name: string | null;
    avatar_url: string | null;
    credits: string;
    status: string;
  }>(
    `SELECT id::text AS id, email, email_verified, password_hash, role,
            display_name, avatar_url, credits::text AS credits, status
       FROM users WHERE email = $1`,
    [input.email],
  );

  // 4) 时序无关:无论用户存不存在,都跑一次 argon2 verify
  const candidateHash = userRow.rows[0]?.password_hash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(input.password, candidateHash);

  if (
    userRow.rows.length === 0 ||
    !passwordOk ||
    userRow.rows[0].status !== "active"
  ) {
    // 故意不区分原因
    throw new LoginError("INVALID_CREDENTIALS", "invalid credentials");
  }

  const user = userRow.rows[0];

  // 4.5) email_verified gate(opt-in,生产 env REQUIRE_EMAIL_VERIFIED=1)
  // 故意放在 password 校验**之后**,避免暴露 "邮箱存在 + 密码对" 给攻击者
  // (没密码进不来,所以不算枚举泄漏)。
  if (deps.requireEmailVerified === true && !user.email_verified) {
    throw new LoginError("EMAIL_NOT_VERIFIED", "email not verified");
  }

  // 5) 签发 access + refresh
  const issueNow = nowSec(deps);
  const access = await signAccess(
    { sub: user.id, role: user.role },
    deps.jwtSecret,
    { now: issueNow, ttlSeconds: deps.accessTtlSeconds },
  );
  const refresh = issueRefresh({
    now: issueNow,
    ttlSeconds: deps.refreshTtlSeconds ?? REFRESH_TOKEN_TTL_SECONDS,
  });

  await query(
    `INSERT INTO refresh_tokens(user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5))`,
    [
      user.id,
      refresh.hash,
      deps.userAgent ?? null,
      deps.remoteIp ?? null,
      refresh.expires_at,
    ],
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified,
      role: user.role,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      credits: user.credits,
    },
    access_token: access.token,
    access_exp: access.exp,
    refresh_token: refresh.token,
    refresh_exp: refresh.expires_at,
  };
}

// ─── refresh ──────────────────────────────────────────────────────────

const refreshTokenSchema = z.string().min(1).max(2048);

export interface RefreshDeps {
  jwtSecret: string | Uint8Array;
  now?: () => number;
  accessTtlSeconds?: number;
}

export interface RefreshResult {
  access_token: string;
  access_exp: number;
}

/**
 * 用客户端的 refresh raw token 换一个新 access。
 *
 * 不轮换 refresh(MVP):同一 refresh 可重复换 access,直到过期或 logout。
 * 若未来要做 refresh rotation,改成本事务内 UPDATE 旧 row revoked_at + INSERT 新 row。
 */
export async function refresh(rawRefresh: string, deps: RefreshDeps): Promise<RefreshResult> {
  const parsed = refreshTokenSchema.safeParse(rawRefresh);
  if (!parsed.success) {
    throw new RefreshError("VALIDATION", "invalid refresh token format");
  }

  let tokenHash: string;
  try {
    tokenHash = refreshTokenHash(parsed.data);
  } catch {
    throw new RefreshError("INVALID_REFRESH", "refresh token decoding failed");
  }

  const ts = nowSec(deps);
  const nowIso = new Date(ts * 1000).toISOString();

  const row = await query<{
    user_id: string;
    role: "user" | "admin";
    status: string;
  }>(
    `SELECT rt.user_id::text AS user_id, u.role, u.status
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1
        AND rt.revoked_at IS NULL
        AND rt.expires_at > $2::timestamptz`,
    [tokenHash, nowIso],
  );
  if (row.rows.length === 0) {
    throw new RefreshError("INVALID_REFRESH", "refresh token invalid or expired");
  }
  if (row.rows[0].status !== "active") {
    throw new RefreshError("INVALID_REFRESH", "refresh token invalid or expired");
  }

  const access = await signAccess(
    { sub: row.rows[0].user_id, role: row.rows[0].role },
    deps.jwtSecret,
    { now: ts, ttlSeconds: deps.accessTtlSeconds },
  );

  return { access_token: access.token, access_exp: access.exp };
}

// ─── logout ───────────────────────────────────────────────────────────

export interface LogoutResult {
  /** true 当且仅当确实从 active 翻成 revoked */
  revoked: boolean;
}

/**
 * Logout:吊销给定 refresh token。
 *
 * 幂等:已 revoked / 已过期 / 不存在 一律返回 revoked=false(不报错)。
 * 这是为了让客户端"清 cookie 再 logout"也能成功。
 */
export async function logout(rawRefresh: string): Promise<LogoutResult> {
  const parsed = refreshTokenSchema.safeParse(rawRefresh);
  if (!parsed.success) {
    return { revoked: false };
  }
  let tokenHash: string;
  try {
    tokenHash = refreshTokenHash(parsed.data);
  } catch {
    return { revoked: false };
  }

  const result = await query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW()
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [tokenHash],
  );
  return { revoked: (result.rowCount ?? 0) > 0 };
}

// 给后续 task 复用的 helper:确认 dummy hash 已预热
export async function warmupLoginDummyHash(): Promise<void> {
  await getDummyHash();
}
