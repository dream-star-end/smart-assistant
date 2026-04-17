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
import { newVerifyToken } from "./register.js";
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

export type VerifyErrorCode = "VALIDATION" | "INVALID_TOKEN" | "WEAK_PASSWORD";

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

/**
 * 申请密码重置。
 *
 * 防枚举:无论 email 是否存在、是否已验证,接口都返回 `{accepted: true}`。
 * 仅当邮箱在 users 表里存在时才真的写 reset 行 + 发邮件。
 */
export async function requestPasswordReset(
  rawEmail: string,
  deps: RequestResetDeps,
): Promise<RequestResetResult> {
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

  await query(
    `INSERT INTO email_verifications(user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, 'reset_password', $3)`,
    [userId, verify.hash, expiresIso],
  );

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
