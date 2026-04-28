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

import { z } from 'zod'
import { createHash } from 'node:crypto'
import { tx, query } from '../db/queries.js'
import { hashPassword } from './passwords.js'
import { newVerifyToken, newVerifyCode, VERIFY_EMAIL_TTL_SECONDS } from './register.js'
import { verifyTurnstile, TurnstileError } from './turnstile.js'
import type { Mailer } from './mail.js'

/** 密码重置 token TTL:1 小时(短于 verify_email)05-SEC §15 */
export const RESET_PASSWORD_TTL_SECONDS = 60 * 60

const tokenSchema = z.string().min(1).max(2048)
const passwordSchema = z.string().min(8).max(72)
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i, 'invalid email format')
const turnstileTokenSchema = z.string().min(1).max(2048)
// 邮箱验证码:严格 6 位数字;容忍前后空白(复制粘贴常带)
const verifyCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'invalid code format')

export type VerifyErrorCode = 'VALIDATION' | 'INVALID_TOKEN' | 'WEAK_PASSWORD' | 'TURNSTILE_FAILED'

export class VerifyError extends Error {
  readonly code: VerifyErrorCode
  constructor(code: VerifyErrorCode, message: string) {
    super(message)
    this.name = 'VerifyError'
    this.code = code
  }
}

export interface CommonDeps {
  /** 测试可注入 now(秒) */
  now?: () => number
}

export interface RequestResetDeps extends CommonDeps {
  mailer: Mailer
  /** 邮件中的链接 base url(部署时 https://claudeai.chat) */
  resetUrlBase?: string
  /** Cloudflare Turnstile server-side secret(env);bypass 模式可不传 */
  turnstileSecret?: string
  /** 测试 bypass:跳过 turnstile,token 非空就 true */
  turnstileBypass?: boolean
  /** 用户 IP — 转给 turnstile */
  remoteIp?: string
  /** 测试可注入 fetch(传给 turnstile) */
  fetchImpl?: typeof fetch
}

/** 把 raw token 转成 token_hash(hex sha256 of raw bytes — base64url decoded) */
function hashRawToken(raw: string): string {
  // raw 是 base64url 编码的 32 字节随机数;Buffer.from 兼容 base64url(node 16+)
  const bytes = Buffer.from(raw, 'base64url')
  return createHash('sha256').update(bytes).digest('hex')
}

function nowSec(deps?: CommonDeps): number {
  return deps?.now ? deps.now() : Math.floor(Date.now() / 1000)
}

// ─── verifyEmail ───────────────────────────────────────────────────────

export interface VerifyEmailResult {
  user_id: string
  /** true 当且仅当本次调用真的把用户从 unverified 翻成 verified */
  newly_verified: boolean
}

/**
 * 用 email + 6 位验证码完成邮箱验证。
 *
 * 2026-04-23 改造:从"链接 + base64url token"换成"6 位数字 code"。
 *   - code 空间只有 10^6,因此必须:
 *     (a) 同时校验 email 绑定,避免跨用户撞码通过
 *     (b) 30 min TTL(见 register.ts VERIFY_EMAIL_TTL_SECONDS)
 *     (c) handler 层套 IP 速率限制(10/min)防暴破
 *   - token_hash 列仍复用 —— 存 sha256(code) hex,与旧的 sha256(32B) 同为 64
 *     hex chars,无需 schema 迁移。
 *
 * 流程(单事务):
 *   1) 校验 email 格式 + code 6 位数字
 *   2) hash(code) → 查 email_verifications JOIN users
 *      WHERE u.email=$1 AND ev.token_hash=$2 AND purpose='verify_email'
 *        AND used_at IS NULL AND expires_at > now()
 *   3) UPDATE used_at
 *   4) UPDATE users.email_verified = TRUE(幂等)
 *
 * 不区分 "邮箱不存在" vs "码错/过期" → 一律 INVALID_TOKEN(防枚举)。
 */
export async function verifyEmail(
  rawEmail: string,
  rawCode: string,
  deps: CommonDeps = {},
): Promise<VerifyEmailResult> {
  const emailParsed = emailSchema.safeParse(rawEmail)
  const codeParsed = verifyCodeSchema.safeParse(rawCode)
  if (!emailParsed.success || !codeParsed.success) {
    // 两种失败都归 VALIDATION —— 前端提示"验证码格式错误",
    // 不区分是 email 还是 code 出问题(防枚举 + 简化 UI)。
    throw new VerifyError('VALIDATION', 'invalid email or code format')
  }
  const email = emailParsed.data
  const code = codeParsed.data
  // 直接 sha256(code 字符串),不走 base64url 解码 —— 与 register.ts/newVerifyCode 一致
  const codeHash = createHash('sha256').update(code).digest('hex')
  const ts = nowSec(deps)
  const nowIso = new Date(ts * 1000).toISOString()

  return await tx<VerifyEmailResult>(async (client) => {
    // 锁序必须统一为 users → email_verifications,否则与 resendVerification
    // (users FOR UPDATE → UPDATE email_verifications) 交错会 PG deadlock
    // detection 随机 kill 一侧。所以这里拆成两步:
    //   ① 先按 email 锁 users 行
    //   ② 再按 user_id + token_hash 锁 email_verifications 行
    // 两步都可能是"未找到",统一抛 INVALID_TOKEN(防枚举,handler 里同条消息)。
    const userRow = await client.query<{ id: string; already_verified: boolean }>(
      `SELECT id::text AS id, email_verified AS already_verified
         FROM users
        WHERE email = $1 AND status != 'deleted'
        FOR UPDATE`,
      [email],
    )
    if (userRow.rows.length === 0) {
      // timing 对齐:不存在的 email 也执行一次 ev lookup,避免通过 DB
      // round-trip 数/服务端耗时区分"email 存在 + code 错"与"email 不存在"。
      // 注册端本身会暴露 EMAIL_EXISTS,这个 timing 屏蔽更多是纵深防御。
      await client.query(
        `SELECT 1 FROM email_verifications
          WHERE token_hash = $1 AND purpose = 'verify_email'
            AND used_at IS NULL AND expires_at > $2::timestamptz
          LIMIT 1`,
        [codeHash, nowIso],
      )
      throw new VerifyError('INVALID_TOKEN', 'verification code invalid or expired')
    }
    const { id: userId, already_verified } = userRow.rows[0]

    const evRow = await client.query<{ id: string }>(
      `SELECT id::text AS id
         FROM email_verifications
        WHERE user_id = $1
          AND token_hash = $2
          AND purpose = 'verify_email'
          AND used_at IS NULL
          AND expires_at > $3::timestamptz
        FOR UPDATE`,
      [userId, codeHash, nowIso],
    )
    if (evRow.rows.length === 0) {
      throw new VerifyError('INVALID_TOKEN', 'verification code invalid or expired')
    }
    const evId = evRow.rows[0].id

    await client.query('UPDATE email_verifications SET used_at = $1::timestamptz WHERE id = $2', [
      nowIso,
      evId,
    ])
    if (!already_verified) {
      await client.query(
        'UPDATE users SET email_verified = TRUE, updated_at = $1::timestamptz WHERE id = $2',
        [nowIso, userId],
      )
    }
    return { user_id: userId, newly_verified: !already_verified }
  })
}

// ─── requestPasswordReset ─────────────────────────────────────────────

export interface RequestResetResult {
  /** 总是 true:防枚举,接口语义上一律视为"已受理" */
  accepted: true
}

export interface RequestResetInput {
  email: string
  turnstile_token: string
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
  const rawEmail = typeof input === 'string' ? input : input.email
  const turnstileToken = typeof input === 'string' ? null : input.turnstile_token

  // 1) Turnstile 校验 — 在任何 DB lookup 前完成,避免 timing 区分 "邮箱存在与否"
  if (turnstileToken !== null) {
    const tokParsed = turnstileTokenSchema.safeParse(turnstileToken)
    if (!tokParsed.success) {
      throw new VerifyError('TURNSTILE_FAILED', 'turnstile token missing or malformed')
    }
    let turnstileOk = false
    try {
      turnstileOk = await verifyTurnstile(tokParsed.data, deps.turnstileSecret, {
        remoteIp: deps.remoteIp,
        bypass: deps.turnstileBypass === true,
        fetchImpl: deps.fetchImpl,
      })
    } catch (err) {
      if (err instanceof TurnstileError) {
        throw new VerifyError('TURNSTILE_FAILED', 'turnstile verification failed')
      }
      throw err
    }
    if (!turnstileOk) {
      throw new VerifyError('TURNSTILE_FAILED', 'turnstile verification rejected')
    }
  }

  // email 格式失败也按 accepted 处理 —— 不告诉攻击者 "格式都没过"
  const parsed = emailSchema.safeParse(rawEmail)
  if (!parsed.success) {
    return { accepted: true }
  }
  const email = parsed.data

  // SSO 合成 email 不允许走密码重置链路(Codex R6 BLOCKING)。
  // socialLogin.ts 给 LDC 一键登录用户写入合成 email
  // `<provider>-<id>@users.claudeai.chat` + email_verified=true。这个域是
  // 我们自己控制的占位域,**永远不应作为收件地址**。允许重置会:
  //   1. 一旦 users.claudeai.chat 的 MX/catch-all 被任何错误配置/续期失误/
  //      CDN 中转激活,就成了 SSO 账号接管路径(枚举 id → reset → 收件 → 设密)。
  //   2. 即使 MX 永远没设,也是"对外发邮件到攻击者可猜测的合成地址"的
  //      mail-relay vector,无业务收益直接砍掉。
  // 判定按 email 后缀,与 socialLogin.ts:SYNTHETIC_EMAIL_DOMAIN 保持同步;
  // 未来如果接其他 provider,还是同一个合成域 → 同条规则继续生效。
  // 防枚举:返 accepted=true,与"用户不存在"路径无差别;不查 DB 也无 timing 差异。
  if (email.endsWith('@users.claudeai.chat')) {
    return { accepted: true }
  }

  const userRow = await query<{ id: string }>(
    "SELECT id::text AS id FROM users WHERE email = $1 AND status != 'deleted'",
    [email],
  )
  if (userRow.rows.length === 0) {
    return { accepted: true }
  }
  const userId = userRow.rows[0].id

  const verify = newVerifyToken()
  const ts = nowSec(deps)
  const expiresIso = new Date((ts + RESET_PASSWORD_TTL_SECONDS) * 1000).toISOString()

  // 安全审计 MED:先作废同一用户之前所有未消费/未过期的 reset_password token,
  // 再插入新行 —— 同一事务 + per-user 行锁保证并发申请被串行化,
  // 任意时刻只有最后一张 reset 链接有效。
  //
  // 修复 (codex round 1 finding #5 FAIL): 之前事务里直接 UPDATE+INSERT 在
  // READ COMMITTED 下,并发两个 reset request 各自看不到对方的 INSERT,
  // 仍可同时插出两张 active token —— 串行化失效。
  // 用 SELECT 1 FROM users WHERE id=$1 FOR UPDATE 锁住该 user 行,
  // 强制后到的事务 wait 第一个事务 commit,从而能 UPDATE 掉它刚插入的新行。
  await tx(async (client) => {
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId])
    await client.query(
      `UPDATE email_verifications
          SET used_at = NOW()
        WHERE user_id = $1
          AND purpose = 'reset_password'
          AND used_at IS NULL
          AND expires_at > NOW()`,
      [userId],
    )
    await client.query(
      `INSERT INTO email_verifications(user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'reset_password', $3)`,
      [userId, verify.hash, expiresIso],
    )
  })

  const url = `${(deps.resetUrlBase ?? '').replace(/\/$/, '')}/reset-password?token=${verify.raw}`
  try {
    await deps.mailer.send({
      to: email,
      subject: '[OpenClaude] 重置你的密码',
      text:
        `Hi,\n\n请点击以下链接重置密码(1 小时内有效):\n\n${url}\n\n` +
        `如果这不是你本人操作,忽略此邮件即可,密码不会被改动。`,
    })
  } catch {
    // 邮件失败不影响 accepted 语义 —— 用户可重新申请
  }

  return { accepted: true }
}

// ─── resendVerification ───────────────────────────────────────────────

export interface ResendVerifyDeps extends CommonDeps {
  mailer: Mailer
  /** 邮件中验证链接的 base url(部署时 https://claudeai.chat) */
  verifyEmailUrlBase?: string
}

export interface ResendVerifyResult {
  /** 总是 true:防枚举,接口语义上一律视为"已受理" */
  accepted: true
}

/**
 * 重发邮箱验证码。
 *
 * 防枚举(05-SEC §15):
 *   - email 格式错 → accepted=true
 *   - 用户不存在 / 已 deleted → accepted=true(不发邮件)
 *   - 用户已验证 → accepted=true(不发邮件,避免被滥用骚扰已验证用户)
 *   - 仅当用户存在且未验证时才真的写新 code + 发邮件
 *
 * 2026-04-23:旧 token/code 必须作废,只有最新一次发出的 code 有效(与
 * requestPasswordReset 相同模式)。理由:
 *   - code 只有 6 位数字,如果并发或重发后留着 N 张有效 code,攻击者暴破
 *     窗口 ≈ N/10^6 成倍放大。
 *   - 事务里 SELECT user FOR UPDATE + UPDATE 旧 + INSERT 新,串行化保证
 *     任意时刻只有一张 active code。
 *
 * 速率限制由调用方(handler)套 IP/email 维度。
 */
export async function resendVerification(
  rawEmail: string,
  deps: ResendVerifyDeps,
): Promise<ResendVerifyResult> {
  const parsed = emailSchema.safeParse(rawEmail)
  if (!parsed.success) return { accepted: true }
  const email = parsed.data

  const verify = newVerifyCode()
  const ts = nowSec(deps)
  const expiresIso = new Date((ts + VERIFY_EMAIL_TTL_SECONDS) * 1000).toISOString()

  // 身份判断必须与写入处于同一事务并持 FOR UPDATE 行锁,否则存在
  // verify-vs-resend 竞态:事务外 SELECT 得知 email_verified=false,
  // 用户在这窗口内点验证链接/输码完成验证,事务内仍插入新 code + 发邮件,
  // 给已验证用户多发一封垃圾邮件并留一张 active 码。
  // (并发 resend 本身靠 users 行锁串行化。)
  const emailSent = await tx(async (client) => {
    const r = await client.query<{ id: string; email_verified: boolean }>(
      `SELECT id::text AS id, email_verified
         FROM users
        WHERE email = $1 AND status != 'deleted'
        FOR UPDATE`,
      [email],
    )
    if (r.rows.length === 0 || r.rows[0].email_verified) return false
    const userId = r.rows[0].id

    await client.query(
      `UPDATE email_verifications
          SET used_at = NOW()
        WHERE user_id = $1
          AND purpose = 'verify_email'
          AND used_at IS NULL
          AND expires_at > NOW()`,
      [userId],
    )
    await client.query(
      `INSERT INTO email_verifications(user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'verify_email', $3)`,
      [userId, verify.hash, expiresIso],
    )
    return true
  })

  if (!emailSent) return { accepted: true }

  try {
    await deps.mailer.send({
      to: email,
      subject: '[OpenClaude] 邮箱验证码(重发)',
      text:
        `你好,\n\n` +
        `你新的 OpenClaude 邮箱验证码是:\n\n` +
        `    ${verify.raw}\n\n` +
        `请回到注册页面输入此验证码完成验证。\n` +
        `验证码 30 分钟内有效,一次性使用。此前发出的旧验证码已作废。\n\n` +
        `📬 若未在收件箱看到此邮件,请检查「垃圾邮件 / Spam」文件夹,\n` +
        `   并把 OpenClaude 寄件地址加入联系人 / 白名单以后续避免误判。\n\n` +
        `如果这不是你本人操作,忽略此邮件即可。`,
    })
  } catch {
    // 邮件失败不影响 accepted 语义 —— 用户可重试
  }

  return { accepted: true }
}

// ─── confirmPasswordReset ─────────────────────────────────────────────

export interface ConfirmResetResult {
  user_id: string
  /** 同事务内被 revoke 的 refresh token 数量 */
  revoked_refresh_tokens: number
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
  const tokenParsed = tokenSchema.safeParse(rawToken)
  if (!tokenParsed.success) {
    throw new VerifyError('VALIDATION', 'invalid token format')
  }
  const pwdParsed = passwordSchema.safeParse(newPassword)
  if (!pwdParsed.success) {
    throw new VerifyError('WEAK_PASSWORD', 'password must be 8-72 chars')
  }

  const tokenHash = hashRawToken(tokenParsed.data)
  const newHash = await hashPassword(pwdParsed.data)
  const ts = nowSec(deps)
  const nowIso = new Date(ts * 1000).toISOString()

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
    )
    if (found.rows.length === 0) {
      throw new VerifyError('INVALID_TOKEN', 'reset token invalid or expired')
    }
    const { id: evId, user_id: userId } = found.rows[0]

    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = $2::timestamptz WHERE id = $3',
      [newHash, nowIso, userId],
    )
    await client.query('UPDATE email_verifications SET used_at = $1::timestamptz WHERE id = $2', [
      nowIso,
      evId,
    ])
    // 2026-04-21 LOW(migration 0019):带上 revoked_reason 以便审计区分,
    // 不再让 refresh-rotation 的 theft 检测误把 password_reset 撤销的 token
    // reuse 当成攻击信号(theft 仅匹配 reason='rotated')。
    const revoked = await client.query(
      `UPDATE refresh_tokens SET revoked_at = $1::timestamptz, revoked_reason = 'password_reset'
        WHERE user_id = $2 AND revoked_at IS NULL`,
      [nowIso, userId],
    )

    return {
      user_id: userId,
      revoked_refresh_tokens: revoked.rowCount ?? 0,
    }
  })
}
