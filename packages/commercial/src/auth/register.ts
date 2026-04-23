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
import { randomBytes, createHash, randomInt } from "node:crypto";
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

/**
 * 邮箱验证码 TTL:30 分钟。
 *
 * 2026-04-23 改造:由 24h 链接改为 6 位验证码后,TTL 砍短:
 *   - 6 位数字 = 10^6 枚举空间,TTL 越长暴力破解窗口越大
 *   - 30 min 够用户切 tab 去查邮件(含垃圾箱);不够就点"重发验证码"
 *
 * 注:2026-04-23 pivot 后 `/auth/verify-email` 只接受 {email, code},
 * 任何 v3 启动初期发出的 24h 老 link token 已无 handler 路径可消费,
 * 老用户必须点"重发验证码"拿到 6 位码才能完成验证(DB 里老行的 sha256
 * (32B) hash 与 sha256(6 位码) hash 不可能相等,自然失效)。
 *
 * 密码重置仍走链接,TTL 1h,见 verify.ts RESET_PASSWORD_TTL_SECONDS。
 */
export const VERIFY_EMAIL_TTL_SECONDS = 30 * 60;

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

/** 生成验证 token raw(返回 base64url) + 入库哈希(hex sha256)。密码重置仍走此函数。 */
export function newVerifyToken(): { raw: string; hash: string } {
  const buf = randomBytes(32);
  return {
    raw: buf.toString("base64url"),
    hash: createHash("sha256").update(buf).digest("hex"),
  };
}

/**
 * 生成 6 位纯数字邮箱验证码 + sha256(code) 入库哈希。
 *
 * 设计:
 *   - 纯数字:用户 IM/手机复制粘贴友好,不区分大小写/0O/Il 歧义
 *   - 6 位:足够对抗短窗口暴力(30min TTL + handler 层 10/min/IP 限流
 *     + resend 会作废历史码,任意时刻只有最新一张 active code)
 *   - `randomInt(0, 1_000_000)` 取值域均匀;左 padStart '0' 到 6 位
 *   - 哈希只是 `sha256(code)` 不加盐 —— 查询时用 `email + hash(code)` 两段一起
 *     scope,即使两个用户撞同一验证码也不会串(见 verify.ts verifyEmail)
 *
 * 不复用 newVerifyToken() —— 后者生成的是 base64url 的 32 字节串,用户无法口述/
 * 手输,只能靠点击链接;现在邮箱验证走 "code 输入框",必须纯数字。
 */
export function newVerifyCode(): { raw: string; hash: string } {
  const n = randomInt(0, 1_000_000);
  const raw = String(n).padStart(6, "0");
  return {
    raw,
    hash: createHash("sha256").update(raw).digest("hex"),
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

  // 3) DB 事务:user + 6 位验证码一起落。verify_email purpose 从 2026-04-23 起
  // 从 base64url token 改为 6 位数字 code(用户 IM/手机复制粘贴友好),
  // token_hash 列同存 sha256(code) hex,schema 无需改动。
  const passwordHash = await hashPassword(input.password);
  const verify = newVerifyCode();
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

  // 4) 发验证码邮件(失败不回滚 user 创建 —— 用户可走 /resend-verification)
  //
  // 2026-04-23 改造:从"点击链接"改为"6 位验证码"。邮件正文必须:
  //   1) 显眼位置写验证码(用户手机切屏时一眼能抄)
  //   2) **主动提示垃圾邮件箱** —— 商用版落地 SPF/DKIM 还不完美,Gmail/
  //      163/QQ 把注册确认邮件扔垃圾箱概率较高;主动提示能省掉大量
  //      "没收到邮件"工单。boss 2026-04-23 明确要求加此提示。
  //   3) 告知 30min 过期 + 如何重发
  let sent = true;
  try {
    await deps.mailer.send({
      to: input.email,
      subject: "[OpenClaude] 邮箱验证码",
      text:
        `你好,\n\n` +
        `你的 OpenClaude 邮箱验证码是:\n\n` +
        `    ${verify.raw}\n\n` +
        `请回到注册页面输入此验证码完成验证。\n` +
        `验证码 30 分钟内有效,一次性使用。\n\n` +
        `📬 若未在收件箱看到此邮件,请检查「垃圾邮件 / Spam」文件夹,\n` +
        `   并把 OpenClaude 寄件地址加入联系人 / 白名单以后续避免误判。\n\n` +
        `如果这不是你本人操作,忽略此邮件即可,账号不会被激活。`,
    });
  } catch {
    sent = false;
    // 不 rethrow:user 已建,后续可 resend;返回 verify_email_sent=false 让前端提示
  }

  return { user_id: userId, verify_email_sent: sent };
}
