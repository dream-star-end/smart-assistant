/**
 * T-12 — 注册流程。
 *
 * 流程(详见 04-API §1 register、05-SEC §1/§7/§15):
 *   1. zod 校验入参(email RFC 简化、password 8-72)
 *   2. Turnstile 校验(可 bypass)
 *   3. 在事务内:
 *      - 检查 email unique
 *      - argon2 hash password
 *      - INSERT users
 *      - 生成验证 token + sha256,INSERT email_verifications(purpose='verify_email')
 *      - 调 mailer 发送验证邮件
 *   4. 返回 user_id
 *
 * 失败错误码(枚举,稳定):
 *   - VALIDATION:入参格式错
 *   - TURNSTILE_FAILED:turnstile 远程拒绝(网络错也算)
 *   - CONFLICT:邮箱已存在
 *
 * 不在本文件:
 *   - HTTP/Express 路由(T-14+)
 *   - 同 IP 限流(T-14+ 速率限制中间件)
 */

import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { tx } from "../db/queries.js";
import { hashPassword } from "./passwords.js";
import { verifyTurnstile, TurnstileError } from "./turnstile.js";
import type { Mailer } from "./mail.js";

/** RFC 5322 简化邮箱正则,长度 ≤ 254(05-SEC §7) */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "invalid email format");

/** 密码 8-72 字节,argon2 上限 72(05-SEC §1) */
const passwordSchema = z.string().min(8).max(72);

export const registerInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  turnstile_token: z.string().min(1).max(2048),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;

export type RegisterErrorCode =
  | "VALIDATION"
  | "TURNSTILE_FAILED"
  | "CONFLICT";

export class RegisterError extends Error {
  readonly code: RegisterErrorCode;
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
  constructor(code: RegisterErrorCode, message: string, issues?: ReadonlyArray<{ path: string; message: string }>) {
    super(message);
    this.name = "RegisterError";
    this.code = code;
    this.issues = issues;
  }
}

/** 验证 token 默认 24h 有效(密码重置稍短由 T-13 决定)。 */
export const VERIFY_EMAIL_TTL_SECONDS = 24 * 60 * 60;

export interface RegisterDeps {
  mailer: Mailer;
  /** turnstile secret(env);bypass 模式可不传 */
  turnstileSecret?: string;
  /** test bypass turnstile(env TURNSTILE_TEST_BYPASS=1) */
  turnstileBypass?: boolean;
  /** 用户 IP — 转给 turnstile + 反滥用日志 */
  remoteIp?: string;
  /** 测试可注入 fetch(传给 turnstile) */
  fetchImpl?: typeof fetch;
  /** 邮件中验证链接的 base url(部署时配 https://claudeai.chat) */
  verifyEmailUrlBase?: string;
  /** 测试可注入 now(秒) */
  now?: () => number;
}

export interface RegisterResult {
  user_id: string;
  verify_email_sent: boolean;
}

/** 生成验证 token raw(返回 base64url) + 入库哈希(hex sha256) */
export function newVerifyToken(): { raw: string; hash: string } {
  const buf = randomBytes(32);
  return {
    raw: buf.toString("base64url"),
    hash: createHash("sha256").update(buf).digest("hex"),
  };
}

export async function register(
  raw: unknown,
  deps: RegisterDeps,
): Promise<RegisterResult> {
  // 1) 入参校验
  const parsed = registerInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RegisterError(
      "VALIDATION",
      "invalid register input",
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
      throw new RegisterError("TURNSTILE_FAILED", "turnstile verification failed");
    }
    throw err;
  }
  if (!turnstileOk) {
    throw new RegisterError("TURNSTILE_FAILED", "turnstile verification rejected");
  }

  // 3) DB 事务:user + verification token 一起落
  const passwordHash = await hashPassword(input.password);
  const verify = newVerifyToken();
  const nowSec = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const expiresAtIso = new Date((nowSec + VERIFY_EMAIL_TTL_SECONDS) * 1000).toISOString();

  let userId: string;
  try {
    userId = await tx<string>(async (client) => {
      // INSERT user;email UNIQUE 约束撞了会抛 23505
      const ins = await client.query<{ id: string }>(
        `INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id::text AS id`,
        [input.email, passwordHash],
      );
      const uid = ins.rows[0].id;
      await client.query(
        `INSERT INTO email_verifications(user_id, token_hash, purpose, expires_at)
         VALUES ($1, $2, 'verify_email', $3)`,
        [uid, verify.hash, expiresAtIso],
      );
      return uid;
    });
  } catch (err) {
    // pg 唯一约束冲突
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      throw new RegisterError("CONFLICT", "email already registered");
    }
    throw err;
  }

  // 4) 发邮件(失败不回滚 user 创建 —— 用户可走 /resend-verification)
  const verifyUrl = `${(deps.verifyEmailUrlBase ?? "").replace(/\/$/, "")}/verify-email?token=${verify.raw}`;
  let sent = true;
  try {
    await deps.mailer.send({
      to: input.email,
      subject: "[OpenClaude] 验证你的邮箱",
      text: `Hi,\n\n请点击以下链接完成邮箱验证(24 小时内有效):\n\n${verifyUrl}\n\n如果这不是你本人操作,忽略此邮件即可。`,
    });
  } catch {
    sent = false;
    // 不 rethrow:user 已建,后续可 resend;返回 verify_email_sent=false 让前端提示
  }

  return { user_id: userId, verify_email_sent: sent };
}
