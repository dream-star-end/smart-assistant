/**
 * T-13 — 邮箱验证 + 密码重置流程。
 *
 * 三个独立函数:
 *   - verifyEmail(token, deps)
 *   - requestPasswordReset(email, deps)
 *   - confirmPasswordReset(token, newPassword, deps)
 *
 * 共同点:
 *   - 用户提交的是 raw token(base64url),数据库存的是 sha256 hex
 *   - 一次性消费:成功后 used_at = NOW()
 *   - 不暴露 "token 是否存在" 与 "用户是否存在" 的差异(05-SEC §15)
 *
 * 错误码(枚举,稳定):
 *   - VALIDATION:入参格式错(token/password 长度等)
 *   - INVALID_TOKEN:token 不存在/已过期/已使用
 *   - WEAK_PASSWORD:新密码长度不合规(reset 专用)
 *
 * 防枚举:requestPasswordReset 不论 email 是否存在都成功返回,
 * 邮件只在用户存在时实际发出(无副作用泄露给攻击者)。
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { tx, query } from "../db/queries.js";
import { hashPassword } from "./passwords.js";
import { newVerifyToken, VERIFY_EMAIL_TTL_SECONDS } from "./register.js";
import { verifyTurnstile, TurnstileError } from "./turnstile.js";
import type { Mailer } from "./mail.js";

/** 密码重置 token TTL:1 小时(短于 verify_email)05-SEC §15 */
export const RESET_PASSWORD_TTL_SECONDS = 60 * 60;

const tokenSchema = z.string().min(1).max(2048);
const passwordSchema = z.string().min(8).max(72);
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "invalid email format");
const turnstileTokenSchema = z.string().min(1).max(2048);

export type VerifyErrorCode =
  | "VALIDATION"
  | "INVALID_TOKEN"
  | "WEAK_PASSWORD"
  | "TURNSTILE_FAILED";

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.name = "VerifyError";
    this.code = code;
  }
}

export interface CommonDeps {
  /** 测试可注入 now(秒) */
  now?: () => number;
}

export interface RequestResetDeps extends CommonDeps {
  mailer: Mailer;
  /** 邮件中的链接 base url(部署时 https://claudeai.chat) */
  resetUrlBase?: string;
  /** Cloudflare Turnstile server-side secret(env);bypass 模式可不传 */
  turnstileSecret?: string;
  /** 测试 bypass:跳过 turnstile,token 非空就 true */
  turnstileBypass?: boolean;
  /** 用户 IP — 转给 turnstile */
  remoteIp?: string;
  /** 测试可注入 fetch(传给 turnstile) */
  fetchImpl?: typeof fetch;
}

/** 把 raw token 转成 token_hash(hex sha256 of raw bytes — base64url decoded) */
function hashRawToken(raw: string): string {
  // raw 是 base64url 编码的 32 字节随机数;Buffer.from 兼容 base64url(node 16+)
  const bytes = Buffer.from(raw, "base64url");
  return createHash("sha256").update(bytes).digest("hex");
}

function nowSec(deps?: CommonDeps): number {
  return deps?.now ? deps.now() : Math.floor(Date.now() / 1000);
}

// ─── verifyEmail ───────────────────────────────────────────────────────

export interface VerifyEmailResult {
  user_id: string;
  /** true 当且仅当本次调用真的把用户从 unverified 翻成 verified */
  newly_verified: boolean;
}

/**
 * 用 raw token 完成邮箱验证。
 *
 * 流程(单事务):
 *   1) 校验 token 长度
 *   2) hash → 查 email_verifications WHERE purpose='verify_email' AND used_at IS NULL AND expires_at > now()
 *   3) UPDATE used_at = NOW()
 *   4) UPDATE users SET email_verified = TRUE
 *
 * 不返回 "用户不存在" 与 "token 已用" 的差别 → 一律 INVALID_TOKEN。
 */
export async function verifyEmail(
  rawToken: string,
  deps: CommonDeps = {},
): Promise<VerifyEmailResult> {
  const parsed = tokenSchema.safeParse(rawToken);
  if (!parsed.success) {
    throw new VerifyError("VALIDATION", "invalid token format");
  }
  const tokenHash = hashRawToken(parsed.data);
  const ts = nowSec(deps);
  const nowIso = new Date(ts * 1000).toISOString();

  return await tx<VerifyEmailResult>(async (client) => {
    const found = await client.query<{
      id: string;
      user_id: string;
      already_verified: boolean;
    }>(
      `SELECT ev.id::text AS id,
              ev.user_id::text AS user_id,
              u.email_verified AS already_verified
         FROM email_verifications ev
         JOIN users u ON u.id = ev.user_id
        WHERE ev.token_hash = $1
          AND ev.purpose = 'verify_email'
          AND ev.used_at IS NULL
          AND ev.expires_at > $2::timestamptz
        FOR UPDATE`,
      [tokenHash, nowIso],
    );
    if (found.rows.length === 0) {
      throw new VerifyError("INVALID_TOKEN", "verification token invalid or expired");
    }
    const { id: evId, user_id: userId, already_verified } = found.rows[0];

    await client.query(
      "UPDATE email_verifications SET used_at = $1::timestamptz WHERE id = $2",
      [nowIso, evId],
    );
    if (!already_verified) {
      await client.query(
        "UPDATE users SET email_verified = TRUE, updated_at = $1::timestamptz WHERE id = $2",
        [nowIso, userId],
      );
    }
    return { user_id: userId, newly_verified: !already_verified };
  });
}

// ─── requestPasswordReset ─────────────────────────────────────────────

export interface RequestResetResult {
  /** 总是 true:防枚举,接口语义上一律视为"已受理" */
  accepted: true;
}

export interface RequestResetInput {
  email: string;
  turnstile_token: string;
}

/**
 * 申请密码重置。
 *
 * 防枚举:无论 email 是否存在、是否已验证,接口都返回 `{accepted: true}`。
 * 仅当邮箱在 users 表里存在时才真的写 reset 行 + 发邮件。
 *
 * Turnstile(05-SEC §15 + 2026-04-21 安全审计 HIGH#3):
 *   注册/登录/重置 三个公开 unauth 端点必须强校验 turnstile,否则攻击者可以
 *   通过本端点滥发邮件(每个 user 1 小时一封 reset 邮件,但 IP 限流靠 handler
 *   层的 3/min 太弱,不能挡 botnet);turnstile 验证失败 → TURNSTILE_FAILED,
 *   **必须在 email 查库之前就拒绝**,避免给"非空 turnstile + 真实 email"留
 *   timing 边信道。
 *
 * 旧 token 失效(2026-04-21 安全审计 MED):
 *   每次签发新 reset_password token 前,必须把同一 user 之前所有未消费/未过期
 *   的 reset_password 行 mark used_at = NOW()。否则:攻击者钓到一份 reset
 *   邮件后,即使本人重新申请,旧链接仍可用,等于绕过"用户主动作废"的预期。
 *   UPDATE + INSERT 必须在同一事务里,避免并发请求拿到同时有效的多张 token。
 */
export async function requestPasswordReset(
  input: string | RequestResetInput,
  deps: RequestResetDeps,
): Promise<RequestResetResult> {
  // 兼容历史调用(只传 email 字符串)— 测试 / 内部调用允许;
  // public HTTP handler 必须传 RequestResetInput 走 turnstile 校验。
  const rawEmail = typeof input === "string" ? input : input.email;
  const turnstileToken = typeof input === "string" ? null : input.turnstile_token;

  // 1) Turnstile 校验 — 在任何 DB lookup 前完成,避免 timing 区分 "邮箱存在与否"
  if (turnstileToken !== null) {
    const tokParsed = turnstileTokenSchema.safeParse(turnstileToken);
    if (!tokParsed.success) {
      throw new VerifyError("TURNSTILE_FAILED", "turnstile token missing or malformed");
    }
    let turnstileOk = false;
    try {
      turnstileOk = await verifyTurnstile(tokParsed.data, deps.turnstileSecret, {
        remoteIp: deps.remoteIp,
        bypass: deps.turnstileBypass === true,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      if (err instanceof TurnstileError) {
        throw new VerifyError("TURNSTILE_FAILED", "turnstile verification failed");
      }
      throw err;
    }
    if (!turnstileOk) {
      throw new VerifyError("TURNSTILE_FAILED", "turnstile verification rejected");
    }
  }

  // email 格式失败也按 accepted 处理 —— 不告诉攻击者 "格式都没过"
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) {
    return { accepted: true };
  }
  const email = parsed.data;

  const userRow = await query<{ id: string }>(
    "SELECT id::text AS id FROM users WHERE email = $1 AND status != 'deleted'",
    [email],
  );
  if (userRow.rows.length === 0) {
    return { accepted: true };
  }
  const userId = userRow.rows[0].id;

  const verify = newVerifyToken();
  const ts = nowSec(deps);
  const expiresIso = new Date((ts + RESET_PASSWORD_TTL_SECONDS) * 1000).toISOString();

  // 安全审计 MED:先作废同一用户之前所有未消费/未过期的 reset_password token,
  // 再插入新行 —— 同一事务保证并发申请也只能让最后一张生效。
  await tx(async (client) => {
    await client.query(
      `UPDATE email_verifications
          SET used_at = NOW()
        WHERE user_id = $1
          AND purpose = 'reset_password'
          AND used_at IS NULL
          AND expires_at > NOW()`,
      [userId],
    );
    await client.query(
      `INSERT INTO email_verifications(user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'reset_password', $3)`,
      [userId, verify.hash, expiresIso],
    );
  });

  const url = `${(deps.resetUrlBase ?? "").replace(/\/$/, "")}/reset-password?token=${verify.raw}`;
  try {
    await deps.mailer.send({
      to: email,
      subject: "[OpenClaude] 重置你的密码",
      text:
        `Hi,\n\n请点击以下链接重置密码(1 小时内有效):\n\n${url}\n\n` +
        `如果这不是你本人操作,忽略此邮件即可,密码不会被改动。`,
    });
  } catch {
    // 邮件失败不影响 accepted 语义 —— 用户可重新申请
  }

  return { accepted: true };
}

// ─── resendVerification ───────────────────────────────────────────────

export interface ResendVerifyDeps extends CommonDeps {
  mailer: Mailer;
  /** 邮件中验证链接的 base url(部署时 https://claudeai.chat) */
  verifyEmailUrlBase?: string;
}

export interface ResendVerifyResult {
  /** 总是 true:防枚举,接口语义上一律视为"已受理" */
  accepted: true;
}

/**
 * 重发邮箱验证邮件。
 *
 * 防枚举(05-SEC §15):
 *   - email 格式错 → accepted=true
 *   - 用户不存在 / 已 deleted → accepted=true(不发邮件)
 *   - 用户已验证 → accepted=true(不发邮件,避免被滥用骚扰已验证用户)
 *   - 仅当用户存在且未验证时才真的写新 token + 发邮件
 *
 * 不消费旧 token —— 旧 token 若仍有效用户也能用(简化重发幂等性)。
 * 速率限制由调用方(handler)套 IP/email 维度。
 */
export async function resendVerification(
  rawEmail: string,
  deps: ResendVerifyDeps,
): Promise<ResendVerifyResult> {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) return { accepted: true };
  const email = parsed.data;

  const userRow = await query<{ id: string; email_verified: boolean }>(
    "SELECT id::text AS id, email_verified FROM users WHERE email = $1 AND status != 'deleted'",
    [email],
  );
  if (userRow.rows.length === 0 || userRow.rows[0].email_verified) {
    return { accepted: true };
  }
  const userId = userRow.rows[0].id;

  const verify = newVerifyToken();
  const ts = nowSec(deps);
  const expiresIso = new Date((ts + VERIFY_EMAIL_TTL_SECONDS) * 1000).toISOString();

  await query(
    `INSERT INTO email_verifications(user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, 'verify_email', $3)`,
    [userId, verify.hash, expiresIso],
  );

  const url = `${(deps.verifyEmailUrlBase ?? "").replace(/\/$/, "")}/verify-email?token=${verify.raw}`;
  try {
    await deps.mailer.send({
      to: email,
      subject: "[OpenClaude] 验证你的邮箱(重发)",
      text:
        `Hi,\n\n请点击以下链接完成邮箱验证(24 小时内有效):\n\n${url}\n\n` +
        `如果这不是你本人操作,忽略此邮件即可。`,
    });
  } catch {
    // 邮件失败不影响 accepted 语义 —— 用户可重试
  }

  return { accepted: true };
}

// ─── confirmPasswordReset ─────────────────────────────────────────────

export interface ConfirmResetResult {
  user_id: string;
  /** 同事务内被 revoke 的 refresh token 数量 */
  revoked_refresh_tokens: number;
}

/**
 * 用 raw token + 新密码完成重置。
 *
 * 单事务:
 *   1) hash → 查 reset_password 未用未过期 token
 *   2) UPDATE users.password_hash + updated_at
 *   3) UPDATE email_verifications.used_at(消费 token)
 *   4) UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id=$ AND revoked_at IS NULL
 *
 * 故意不复用 verifyEmail —— purpose 不同,逻辑(改密 + revoke)也不同。
 */
export async function confirmPasswordReset(
  rawToken: string,
  newPassword: string,
  deps: CommonDeps = {},
): Promise<ConfirmResetResult> {
  const tokenParsed = tokenSchema.safeParse(rawToken);
  if (!tokenParsed.success) {
    throw new VerifyError("VALIDATION", "invalid token format");
  }
  const pwdParsed = passwordSchema.safeParse(newPassword);
  if (!pwdParsed.success) {
    throw new VerifyError("WEAK_PASSWORD", "password must be 8-72 chars");
  }

  const tokenHash = hashRawToken(tokenParsed.data);
  const newHash = await hashPassword(pwdParsed.data);
  const ts = nowSec(deps);
  const nowIso = new Date(ts * 1000).toISOString();

  return await tx<ConfirmResetResult>(async (client) => {
    const found = await client.query<{ id: string; user_id: string }>(
      `SELECT id::text AS id, user_id::text AS user_id
         FROM email_verifications
        WHERE token_hash = $1
          AND purpose = 'reset_password'
          AND used_at IS NULL
          AND expires_at > $2::timestamptz
        FOR UPDATE`,
      [tokenHash, nowIso],
    );
    if (found.rows.length === 0) {
      throw new VerifyError("INVALID_TOKEN", "reset token invalid or expired");
    }
    const { id: evId, user_id: userId } = found.rows[0];

    await client.query(
      "UPDATE users SET password_hash = $1, updated_at = $2::timestamptz WHERE id = $3",
      [newHash, nowIso, userId],
    );
    await client.query(
      "UPDATE email_verifications SET used_at = $1::timestamptz WHERE id = $2",
      [nowIso, evId],
    );
    const revoked = await client.query(
      `UPDATE refresh_tokens SET revoked_at = $1::timestamptz
        WHERE user_id = $2 AND revoked_at IS NULL`,
      [nowIso, userId],
    );

    return {
      user_id: userId,
      revoked_refresh_tokens: revoked.rowCount ?? 0,
    };
  });
}
