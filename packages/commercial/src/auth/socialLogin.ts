/**
 * Social login(provider 通用)业务编排 — 把 OAuth provider 的 user info
 * 落到本地 users + oauth_identities,签发 access + refresh,行为对齐 login.ts。
 *
 * 当前 provider:linuxdo。设计为 provider 无关:增 GitHub/Google 时只 extend
 * 数据库 CHECK 约束 + 在 handler 层换 OAuth client,**这个文件不动**。
 *
 * 关键设计:
 *
 * 1) **并发首登 race 防御**(codex R1 BLOCKING #3):同一个 LDC 用户在两个浏览
 *    器 tab 同时点 SSO,LDC 给两个不同的 code,后端两个 callback 并发跑 tx。
 *    如果只靠 SELECT-then-INSERT,两个 tx 都没找到 identity → 都 INSERT users
 *    → 一个 23505 失败回滚 → 用户看 500。修法:tx 入口拿
 *    `pg_advisory_xact_lock(hashtext('linuxdo:'||provider_user_id))`,同 ID 并
 *    发的第二个 tx 阻塞到第一个完成,第二个再 SELECT 直接命中已建 identity。
 *
 * 2) **合成 email**(codex R2 SPACE):LDC userinfo 可能不返 email(用户隐私
 *    设置),即使返了"按 email 自动 link 已有账号"也是经典 OAuth 接管漏洞 —
 *    攻击者能在 LDC 注册一个声称是受害者邮箱的账号(LDC 验证流程未必严格)
 *    然后通过 SSO 接管受害者本地账号。保守策略:**永远建新账号**,合成 email
 *    `linuxdo-<id>@users.claudeai.chat`,absolute uniqueness via provider_user_id。
 *    用户日后想合并 LDC 与邮箱账号通过显式 settings flow,不是隐式 email match。
 *
 * 3) **password_hash 占位**:users.password_hash NOT NULL,SSO 用户从未设密码。
 *    存 argon2(randomBytes(32)) 一个**永不可能匹配**的真实哈希,login.ts 不需
 *    要任何特殊路径,verify 永远 false → INVALID_CREDENTIALS。schema 不动。
 *
 * 4) **首登统一赠送 ¥5**:同 tx INSERT users(credits=500) +
 *    INSERT credit_ledger(reason='promotion'),所有 LDC 用户首登一律 ¥5 / 500
 *    cents,与 trust_level 无关(见 LINUXDO_BONUS_CENTS 注释)。memo 仍标注
 *    用户当时的 effective TL,便于运营审计 + 历史分群。
 *    **赠金只在首登一次性结算**,后续 trust_level 升级不补差。
 */

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { query, tx } from '../db/queries.js'
import { REFRESH_TOKEN_TTL_SECONDS, issueRefresh, signAccess } from './jwt.js'
import { hashPassword } from './passwords.js'

/**
 * LDC 首登统一赠金(1¥ = 100 cents)。
 *
 * 历史:曾按 trust_level 分阶(TL0=¥3 / TL1=¥5 / TL2=¥10 / TL3=¥20 / TL4=¥30),
 * 2026-04-29 boss 决策改为统一 ¥5,不分级。已注册用户不补差(本来就不补差)。
 *
 * **赠金只在首登一次性结算**:用户后续 SSO 登录只 UPDATE oauth_identities
 * 的 trust_level / username / avatar 快照,credits/ledger 不动。
 */
const LINUXDO_BONUS_CENTS = 500n // ¥5

export interface BonusForTrustLevelResult {
  bonusCents: bigint
  /** clamp/normalize 后的 TL(0..4),仅用于 ledger memo + 审计标签;不再决定金额 */
  effectiveTrustLevel: 0 | 1 | 2 | 3 | 4
}

/**
 * 计算 LDC 首登赠金 + effective TL 标签。
 *
 * - bonusCents 永远 = LINUXDO_BONUS_CENTS(¥5),与 trust_level 无关。
 * - effectiveTrustLevel 仍按原规则规范化(null/undefined/非整数/负数 → 0;
 *   >=4 → clamp 到 4),供 ledger memo 写入审计标签;LDC 数据异常时(raw=NaN
 *   / Infinity / >4)退回 TL0 标记,与 raw TL 一并落 memo 便于运营排查。
 *
 * 纯函数,无副作用。在 tx 外或内调用都安全。函数名保留向后兼容(测试 +
 * 内部调用方都 import 这个名字),语义已改成"始终 ¥5"。
 */
export function bonusForTrustLevel(tl: number | null | undefined): BonusForTrustLevelResult {
  if (tl == null || !Number.isInteger(tl) || tl < 0) {
    return { bonusCents: LINUXDO_BONUS_CENTS, effectiveTrustLevel: 0 }
  }
  if (tl >= 4) return { bonusCents: LINUXDO_BONUS_CENTS, effectiveTrustLevel: 4 }
  const lvl = tl as 0 | 1 | 2 | 3 | 4
  return { bonusCents: LINUXDO_BONUS_CENTS, effectiveTrustLevel: lvl }
}

/** 合成 email 域名 — 不收件,只占 UNIQUE 槽位。改这个域名前查清现存合成 email */
const SYNTHETIC_EMAIL_DOMAIN = 'users.claudeai.chat'

export type SocialProvider = 'linuxdo'

export interface SocialLoginInput {
  provider: SocialProvider
  providerUserId: string
  username: string
  /** LDC 可能不返,但保留参数(将来其他 provider 用),目前永远不写库 */
  email: string | null
  trustLevel: number | null
  avatarUrl: string | null
}

export type SocialLoginErrorCode =
  | 'USER_DISABLED' // 已存在但被封号 / 软删
  | 'INVALID_INPUT' // provider_user_id / username 校验失败(防御 LDC 异常)

export class SocialLoginError extends Error {
  constructor(
    public readonly code: SocialLoginErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SocialLoginError'
  }
}

export interface SocialLoginUser {
  id: string
  email: string
  email_verified: boolean
  role: 'user' | 'admin'
  display_name: string | null
  avatar_url: string | null
  credits: string
}

export interface SocialLoginResult {
  user: SocialLoginUser
  /** 是否本次新建用户 — handler 用于 audit log;前端不区分 */
  isNew: boolean
  access_token: string
  access_exp: number
  refresh_token: string
  refresh_exp: number
  /** SSO 默认"记住我"= true,与 cookie persistent=true 对齐 */
  remember: boolean
}

export interface SocialLoginDeps {
  jwtSecret: string | Uint8Array
  /** 写到 refresh_tokens.user_agent / ip,审计追溯用 */
  userAgent?: string
  /** 出口 IP(refresh_tokens.ip;同 login.ts bindIp 语义) */
  bindIp?: string
  /** 测试可注入 now(秒) */
  now?: () => number
  accessTtlSeconds?: number
  refreshTtlSeconds?: number
}

const inputSchema = z.object({
  provider: z.enum(['linuxdo']),
  providerUserId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/),
  username: z.string().min(1).max(64),
  email: z.string().nullable(),
  trustLevel: z.number().int().min(0).nullable(),
  avatarUrl: z.string().max(2048).nullable(),
})

function syntheticEmail(provider: SocialProvider, providerUserId: string): string {
  return `${provider}-${providerUserId}@${SYNTHETIC_EMAIL_DOMAIN}`
}

function nowSec(deps?: { now?: () => number }): number {
  return deps?.now ? deps.now() : Math.floor(Date.now() / 1000)
}

/**
 * 主入口。tx 内全程持 advisory lock,串行化同 (provider, provider_user_id) 的并发。
 *
 * 流程:
 *   1. tx 开启,pg_advisory_xact_lock(hashtext('linuxdo:'||id))
 *   2. SELECT identity FOR UPDATE
 *   3a. 命中: 校 user.status='active'(否则抛 USER_DISABLED),UPDATE identity
 *       的 username/avatar_url/trust_level 快照(LDC 侧改昵称/升 trust 同步)
 *   3b. 未命中: argon2(random32) → INSERT users(合成 email, email_verified=
 *       TRUE, credits=bonus) → INSERT credit_ledger(promotion, bonus) → INSERT
 *       identity。bonus 由 bonusForTrustLevel(input.trustLevel) 一次性算出,见
 *       顶部 TRUST_LEVEL_BONUS 阶梯。**23505 兜底**:advisory lock 理论上排除并发,但若数据库历史
 *       脏数据(0042 之前手工补过 oauth_identities 等)导致 INSERT users 撞
 *       email 唯一约束,捕获后 reselect identity 一次再决断;再撞抛 USER_DISABLED
 *       (说明数据状态需要人工介入)
 *   4. tx 出来后 issueRefresh + signAccess + INSERT refresh_tokens(remember_me=TRUE)
 */
export async function socialLoginOrCreate(
  raw: SocialLoginInput,
  deps: SocialLoginDeps,
): Promise<SocialLoginResult> {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new SocialLoginError('INVALID_INPUT', 'invalid social login input')
  }
  const input = parsed.data

  const lockKey = `${input.provider}:${input.providerUserId}`

  // tx 内确定 user_id + isNew + display_name + avatar_url + email + status snapshot
  const found = await tx<{
    userId: string
    isNew: boolean
    email: string
    emailVerified: boolean
    displayName: string | null
    avatarUrl: string | null
    credits: string
    role: 'user' | 'admin'
  }>(async (client) => {
    // 1) advisory lock —— 同 (provider, provider_user_id) 并发首登串行化
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey])

    // 2) 看 identity 是否已存在
    const idRes = await client.query<{
      user_id: string
      status: string
      email: string
      email_verified: boolean
      display_name: string | null
      avatar_url: string | null
      credits: string
      role: 'user' | 'admin'
    }>(
      `SELECT oi.user_id::text AS user_id,
              u.status, u.email, u.email_verified,
              u.display_name, u.avatar_url, u.credits::text AS credits, u.role
         FROM oauth_identities oi
         JOIN users u ON u.id = oi.user_id
        WHERE oi.provider = $1 AND oi.provider_user_id = $2
        FOR UPDATE OF oi`,
      [input.provider, input.providerUserId],
    )

    if (idRes.rows.length > 0) {
      const row = idRes.rows[0]
      if (row.status !== 'active') {
        throw new SocialLoginError('USER_DISABLED', 'user disabled')
      }
      // UPDATE identity 元数据快照(用户在 LDC 侧改昵称/升级 trust 时同步过来)。
      // **trust_level 升级不触发补差赠金** — 赠金按首登时的 TL 一次性结算,
      // 详见上方 TRUST_LEVEL_BONUS 注释。这里只更新快照字段,credit_ledger 不动。
      await client.query(
        `UPDATE oauth_identities
            SET username = $1,
                trust_level = $2,
                avatar_url = $3,
                updated_at = NOW()
          WHERE provider = $4 AND provider_user_id = $5`,
        [input.username, input.trustLevel, input.avatarUrl, input.provider, input.providerUserId],
      )
      return {
        userId: row.user_id,
        isNew: false,
        email: row.email,
        emailVerified: row.email_verified,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        credits: row.credits,
        role: row.role,
      }
    }

    // 3b) 没找到 → 创建 user + ledger + identity
    const placeholderHash = await hashPassword(randomBytes(32).toString('base64url'))
    const synEmail = syntheticEmail(input.provider, input.providerUserId)
    // 按 LDC trust_level 计算赠金(纯函数,SAVEPOINT 之前算好,tx 内只用结果)
    const { bonusCents, effectiveTrustLevel } = bonusForTrustLevel(input.trustLevel)

    // SAVEPOINT 包 INSERT users —— Postgres 一旦在 tx 中 raise 错(包括 23505),
    // 整个 tx 进入 aborted 状态,后续任何 query 都返 "current transaction is aborted"。
    // 只有 ROLLBACK 到 SAVEPOINT 才能恢复 tx 继续跑 reselect 兜底。
    // (Codex R6 BLOCKING:之前裸 try/catch 在并发或脏数据撞 23505 时整 tx 报废,
    //  reselect 必失败抛 InFailedSqlTransaction → 整体抛上去用户看 500。)
    await client.query('SAVEPOINT social_user_insert')
    let newUserId: string
    try {
      const insUser = await client.query<{ id: string }>(
        `INSERT INTO users(email, password_hash, email_verified,
                           display_name, avatar_url, credits)
         VALUES ($1, $2, TRUE, $3, $4, $5::bigint)
         RETURNING id::text AS id`,
        [synEmail, placeholderHash, input.username, input.avatarUrl, bonusCents.toString()],
      )
      newUserId = insUser.rows[0].id
      await client.query('RELEASE SAVEPOINT social_user_insert')
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === '23505') {
        // 回滚 SAVEPOINT 让 tx 离开 aborted 状态;然后 reselect 不会撞
        // InFailedSqlTransaction。
        await client.query('ROLLBACK TO SAVEPOINT social_user_insert')
        // 23505 兜底:advisory lock 理论上排除并发,但若历史脏数据已经种了
        // 同 email 的 user(无 identity 关联),撞 UNIQUE。reselect identity 一次:
        // 若 reselect 命中说明并发已建好,直接走"已存在"路径(很罕见,但稳)。
        const reselect = await client.query<{
          user_id: string
          status: string
          email: string
          email_verified: boolean
          display_name: string | null
          avatar_url: string | null
          credits: string
          role: 'user' | 'admin'
        }>(
          `SELECT oi.user_id::text AS user_id,
                  u.status, u.email, u.email_verified,
                  u.display_name, u.avatar_url, u.credits::text AS credits, u.role
             FROM oauth_identities oi
             JOIN users u ON u.id = oi.user_id
            WHERE oi.provider = $1 AND oi.provider_user_id = $2`,
          [input.provider, input.providerUserId],
        )
        if (reselect.rows.length > 0) {
          const row = reselect.rows[0]
          if (row.status !== 'active') {
            throw new SocialLoginError('USER_DISABLED', 'user disabled')
          }
          return {
            userId: row.user_id,
            isNew: false,
            email: row.email,
            emailVerified: row.email_verified,
            displayName: row.display_name,
            avatarUrl: row.avatar_url,
            credits: row.credits,
            role: row.role,
          }
        }
        // reselect 无,说明合成 email 与历史脏 user 撞了。这是部署时数据迁移
        // 残留,需要 admin 介入处理。抛 USER_DISABLED 让用户看到"账号异常"提示。
        throw new SocialLoginError(
          'USER_DISABLED',
          'synthetic email collision; admin attention required',
        )
      }
      throw err
    }

    // ledger 行(同 register.ts,绕过 billing/credit() helper 防 tx 跳出)。
    // memo 标注 effective TL,raw TL 与 effective 不同(>4 clamp)时一并记录,
    // 便于运营审计区分新旧赠金策略 + 排查异常 LDC 数据。
    const yuanLabel = (bonusCents / 100n).toString()
    const tlLabel =
      input.trustLevel != null && input.trustLevel !== effectiveTrustLevel
        ? `TL${effectiveTrustLevel}, raw=${input.trustLevel}`
        : `TL${effectiveTrustLevel}`
    const ledgerMemo = `LINUX DO 一键注册赠送 ¥${yuanLabel} (${tlLabel})`
    await client.query(
      `INSERT INTO credit_ledger(user_id, delta, balance_after, reason, memo)
       VALUES ($1::bigint, $2::bigint, $3::bigint, 'promotion', $4)`,
      [newUserId, bonusCents.toString(), bonusCents.toString(), ledgerMemo],
    )

    // identity 行
    await client.query(
      `INSERT INTO oauth_identities(user_id, provider, provider_user_id,
                                    username, trust_level, avatar_url)
       VALUES ($1::bigint, $2, $3, $4, $5, $6)`,
      [
        newUserId,
        input.provider,
        input.providerUserId,
        input.username,
        input.trustLevel,
        input.avatarUrl,
      ],
    )

    return {
      userId: newUserId,
      isNew: true,
      email: synEmail,
      emailVerified: true,
      displayName: input.username,
      avatarUrl: input.avatarUrl,
      credits: bonusCents.toString(),
      role: 'user' as const,
    }
  })

  // 4) 签发 access + refresh,INSERT refresh_tokens(remember_me=TRUE,SSO 默认"记住")
  const issueNow = nowSec(deps)
  const access = await signAccess({ sub: found.userId, role: found.role }, deps.jwtSecret, {
    now: issueNow,
    ttlSeconds: deps.accessTtlSeconds,
  })
  const refresh = issueRefresh({
    now: issueNow,
    ttlSeconds: deps.refreshTtlSeconds ?? REFRESH_TOKEN_TTL_SECONDS,
  })
  await query(
    `INSERT INTO refresh_tokens(user_id, token_hash, user_agent, ip, expires_at, remember_me)
     VALUES ($1, $2, $3, $4, to_timestamp($5), TRUE)`,
    [found.userId, refresh.hash, deps.userAgent ?? null, deps.bindIp ?? null, refresh.expires_at],
  )

  return {
    user: {
      id: found.userId,
      email: found.email,
      email_verified: found.emailVerified,
      role: found.role,
      display_name: found.displayName,
      avatar_url: found.avatarUrl,
      credits: found.credits,
    },
    isNew: found.isNew,
    access_token: access.token,
    access_exp: access.exp,
    refresh_token: refresh.token,
    refresh_exp: refresh.expires_at,
    remember: true,
  }
}
