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
 *   - turnstile 校验复用 T-12 模块
 *
 * Refresh token 轮换(2026-04-21 安全审计 LOW,migration 0019):
 *   - 每次 /api/auth/refresh 都 **rotate**:旧 row revoked_at=NOW() +
 *     reason='rotated' + rotated_to_id 指向新 row;同事务 INSERT 新 row,
 *     family_id 沿用旧的;新 raw token 写回 HttpOnly cookie
 *   - 盗用检测(reuse-after-rotate):客户端拿一张「已 revoked 但未到期」
 *     的 refresh 来换 → 99% 是攻击者(正主已经拿到新 refresh,不会回头用
 *     旧的)→ 把整个 family 全 revoke(reason='theft'),抛 INVALID_REFRESH。
 *     正主下次刷新也会失败 → 跳登录 → 攻击者偷的所有未来 token 都失效
 *   - 错误语义统一:RefreshError("INVALID_REFRESH") 不区分"过期/已撤销/
 *     不存在/盗用",对客户端永远只是"重新登录"
 *
 * Logout:吊销当前 refresh row + 整个 family(避免某些会话留在飞中)。
 *   理由:用户主动 logout 表示"这一刻起所有当前设备都该失效";如果只
 *   revoke 一张,其他 tab 仍能 refresh 很久。reason='logout'。
 */

import { z } from "zod";
import { query, tx } from "../db/queries.js";
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
  /**
   * 新的 raw refresh token(轮换后下发)。HTTP 层应把它写回 HttpOnly cookie,
   * 并丢弃客户端送来的旧 token(已被本调用 revoked)。
   */
  refresh_token: string;
  /** unix seconds */
  refresh_exp: number;
}

export interface RefreshExtraDeps {
  /** 写新 row 的 IP / UA(audit 追溯)。可空 — 测试用。 */
  remoteIp?: string;
  userAgent?: string;
  /** 测试可注入新 refresh TTL。 */
  refreshTtlSeconds?: number;
  /**
   * 盗用检测时的回调。HTTP 层可以挂日志 / metrics / 通知用户的钩子。
   * 不抛错;同步运行,不要做重 I/O。
   */
  onTheftDetected?: (ev: {
    user_id: string;
    family_id: string;
    revoked_count: number;
    remoteIp?: string;
    userAgent?: string;
  }) => void;
}

/**
 * 用客户端的 refresh raw token 换 access + 轮换出新的 refresh。
 *
 * 行为(2026-04-21 LOW 重做):
 *   1. tx 开启,SELECT ... FOR UPDATE 锁定该 token_hash
 *   2. 命中 revoked_at IS NOT NULL 但 expires_at > NOW() → 盗用!
 *      → UPDATE 整个 family 的存活行 revoked_at=NOW(),reason='theft'
 *      → 抛 INVALID_REFRESH(对外不区分原因)
 *   3. 命中正常未撤销未过期行 → 校 user.status='active'
 *   4. issueRefresh 生成新 raw + hash
 *   5. INSERT 新 refresh_tokens 行(family_id 沿用,revoked_at=NULL),
 *      捕获 RETURNING id
 *   6. UPDATE 旧行 revoked_at=NOW(), revoked_reason='rotated',
 *      rotated_to_id = 新行.id
 *   7. COMMIT,signAccess,返回新 access + 新 refresh
 *
 * 错误语义:不区分"过期/已撤销/不存在/盗用",对外永远 INVALID_REFRESH。
 */
export async function refresh(
  rawRefresh: string,
  deps: RefreshDeps & RefreshExtraDeps = {} as RefreshDeps,
): Promise<RefreshResult> {
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
  const refreshTtl = deps.refreshTtlSeconds ?? REFRESH_TOKEN_TTL_SECONDS;

  // 全流程在 tx 中:lock 旧 row → (theft 分支?) → INSERT 新 → UPDATE 旧
  const result = await tx(async (client) => {
    // FOR UPDATE 防并发同 token 双 rotate(经典竞态:两个 tab 同时 refresh)
    const lookupRes = await client.query<{
      id: string;
      user_id: string;
      family_id: string;
      role: "user" | "admin";
      status: string;
      revoked_at: string | null;
      revoked_reason: string | null;
      expired: boolean;
    }>(
      `SELECT rt.id::text AS id,
              rt.user_id::text AS user_id,
              rt.family_id::text AS family_id,
              u.role, u.status,
              rt.revoked_at::text AS revoked_at,
              rt.revoked_reason,
              (rt.expires_at <= $2::timestamptz) AS expired
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
        FOR UPDATE OF rt`,
      [tokenHash, nowIso],
    );

    if (lookupRes.rows.length === 0) {
      throw new RefreshError("INVALID_REFRESH", "refresh token invalid or expired");
    }
    const row = lookupRes.rows[0];

    // 盗用:revoked='rotated' 但还没过期 → 全 family revoke。
    // logout/password_reset/admin/theft 等显式撤销 reason 不触发 theft 链
    // (已经是用户/管理员主动登出,后续 reuse 视作普通失效),只 'rotated'
    // 才是"正主已经接到新 token,这张老的不该再回头被用"的强信号。
    if (
      row.revoked_at !== null &&
      !row.expired &&
      row.revoked_reason === "rotated"
    ) {
      const massRevoke = await client.query<{ id: string }>(
        `UPDATE refresh_tokens
            SET revoked_at = NOW(), revoked_reason = 'theft'
          WHERE family_id = $1::uuid
            AND revoked_at IS NULL
        RETURNING id::text AS id`,
        [row.family_id],
      );
      // 在事务外触发 onTheftDetected,避免回调误抛影响 tx;但回调
      // 拿 family_id + revoked_count 的快照足以审计。
      return {
        kind: "theft" as const,
        family_id: row.family_id,
        user_id: row.user_id,
        revoked_count: massRevoke.rowCount ?? 0,
      };
    }

    // 已过期 / 已 revoked 且也过期了 → 普通无效(不当作盗用,因为 token
    // 是不是被偷已经无所谓,反正失效)
    if (row.expired || row.revoked_at !== null) {
      throw new RefreshError("INVALID_REFRESH", "refresh token invalid or expired");
    }

    if (row.status !== "active") {
      throw new RefreshError("INVALID_REFRESH", "refresh token invalid or expired");
    }

    // 正常 rotation 路径
    const newRefresh = issueRefresh({ now: ts, ttlSeconds: refreshTtl });
    const ins = await client.query<{ id: string }>(
      `INSERT INTO refresh_tokens(user_id, token_hash, user_agent, ip, expires_at,
                                  family_id, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6::uuid, NULL, NULL)
       RETURNING id::text AS id`,
      [
        row.user_id,
        newRefresh.hash,
        deps.userAgent ?? null,
        deps.remoteIp ?? null,
        newRefresh.expires_at,
        row.family_id,
      ],
    );
    const newId = ins.rows[0].id;

    await client.query(
      `UPDATE refresh_tokens
          SET revoked_at = NOW(),
              revoked_reason = 'rotated',
              rotated_to_id = $1::bigint
        WHERE id = $2::bigint`,
      [newId, row.id],
    );

    return {
      kind: "rotated" as const,
      user_id: row.user_id,
      role: row.role,
      newRefresh,
    };
  });

  if (result.kind === "theft") {
    try {
      deps.onTheftDetected?.({
        user_id: result.user_id,
        family_id: result.family_id,
        revoked_count: result.revoked_count,
        remoteIp: deps.remoteIp,
        userAgent: deps.userAgent,
      });
    } catch {
      // 回调失败不影响响应语义
    }
    throw new RefreshError("INVALID_REFRESH", "refresh token invalid or expired");
  }

  const access = await signAccess(
    { sub: result.user_id, role: result.role },
    deps.jwtSecret,
    { now: ts, ttlSeconds: deps.accessTtlSeconds },
  );

  return {
    access_token: access.token,
    access_exp: access.exp,
    refresh_token: result.newRefresh.token,
    refresh_exp: result.newRefresh.expires_at,
  };
}

// ─── logout ───────────────────────────────────────────────────────────

export interface LogoutResult {
  /** true 当且仅当确实从 active 翻成 revoked */
  revoked: boolean;
}

/**
 * Logout:吊销给定 refresh token 及其同 family 所有未撤销行。
 *
 * 幂等:已 revoked / 已过期 / 不存在 一律返回 revoked=false(不报错)。
 * 这是为了让客户端"清 cookie 再 logout"也能成功。
 *
 * 2026-04-21 LOW:logout 必须 revoke 整个 family。理由是用户主动登出
 * 表达"这一刻起所有当前会话都该失效";如果只 revoke 一张,其他 tab
 * 仍能 refresh 很久。reason='logout' 区分于 'rotated'/'theft'。
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

  // 一条 SQL 完成:子查询拿到 family_id,UPDATE 所有同 family 未撤销行
  const result = await query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW(), revoked_reason = 'logout'
      WHERE family_id = (
              SELECT family_id FROM refresh_tokens WHERE token_hash = $1
            )
        AND revoked_at IS NULL`,
    [tokenHash],
  );
  return { revoked: (result.rowCount ?? 0) > 0 };
}

// 给后续 task 复用的 helper:确认 dummy hash 已预热
export async function warmupLoginDummyHash(): Promise<void> {
  await getDummyHash();
}
