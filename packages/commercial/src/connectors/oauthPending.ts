/**
 * oauthPending — BYOA OAuth 授权码流的一次性 pending 存取(设计终稿 §2)。
 *
 * 不变量:
 *   - **start**:`INSERT ... ON CONFLICT (user_id,provider) DO UPDATE` 单语句原子替换
 *     (并发双 start 只剩一行,旧 state 必败 —— state_hash 被新值覆盖)。
 *   - draft = 加密 {clientId?, clientSecret?, pkceVerifier, displayName?},
 *     **AAD = `oauth:{state_hash_hex}:{user_id}:{provider}:{aad_seed}`**(公式二)。
 *     client 凭据**可选**:仅 BYOA(用户自带 App)才落它们;声明式 platform 模式的 client 凭据
 *     在平台表(connector_platform_oauth_apps),没必要每次授权都复制一份加密副本进 draft。
 *   - **callback consume**:单事务两语句 —— `SELECT ... FOR UPDATE` 校验四因子
 *     (state_hash 命中 + cookie_nonce_hash 匹配 + 未消费 + 未过期)读 draft 入 Buffer
 *     → `UPDATE SET consumed_at=now(), draft_enc=NULL, draft_nonce=NULL` → COMMIT。
 *     exchange 在**事务外**;崩溃任意点 DB 无 draft 残留。
 *   - 过期未消费行含密文:sweeper **DELETE 整行**即销毁。
 *   - state / cookie nonce 原值不落库(只落 sha256),日志禁记原值。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'
import { getPool } from '../db/index.js'
import { tx } from '../db/queries.js'
import { appendSetCookie } from '../http/cookies.js'
import { ConnectorError } from './errors.js'

export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000 // 10min

/** AAD 公式二:`oauth:{state_hash_hex}:{user_id}:{provider}:{aad_seed}`。 */
export function oauthDraftAad(
  stateHashHex: string,
  userId: number,
  provider: string,
  aadSeed: string,
): Buffer {
  return Buffer.from(`oauth:${stateHashHex}:${userId}:${provider}:${aadSeed}`, 'utf8')
}

export interface OauthDraft {
  /**
   * OAuth client 凭据 —— **仅 BYOA 落它们**(v1 feishu 手写路径 / 声明式 clientProvisioning='byoa')。
   * 声明式 **platform 模式不落**:凭据在平台表(connector_platform_oauth_apps),回调时现取;
   * 每次授权复制一份加密副本进 pending 只会平白多一处密文暴露面,零收益。
   *
   * ⚠️ 两条消费路径各自硬校验自己的必需项(consume 只做"存在即 string"的形状底线):
   *   - v1 feishu 分支:缺 clientId/clientSecret → INTERNAL(v1 只有 BYOA,缺了必是数据错乱);
   *   - 声明式分支:byoa 缺 → fail-closed;platform 有也不看(权威是平台表)。
   */
  clientId?: string
  clientSecret?: string
  pkceVerifier: string
  displayName?: string
  /**
   * **声明式标记**(oauth2-auth-code 切片 B):存在 → 该 pending 属于声明式连接器,回调走
   * 引擎路径(loadVerifiedContractWithMeta → exchangeAuthCode → bindWithBag);
   * 不存在 → v1 手写 provider(feishu)路径。draft 在 AEAD 密文内,新增字段不动表结构。
   */
  connectorVersionId?: number
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest()
}

/**
 * OAuth 回跳地址(authorize 与 token 交换两阶段必须**同一个值**,RFC 6749 §4.1.3)。
 * v1 feishu 与声明式 oauth2 共用同一条回调路由 → 共用同一权威读取口(禁第二份 env 解析)。
 */
export function readConnectorsOauthRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.OC_CONNECTORS_OAUTH_REDIRECT_URI?.trim()
  if (!v) throw new ConnectorError('OAUTH_NOT_CONFIGURED', 'OC_CONNECTORS_OAUTH_REDIRECT_URI unset')
  return v
}

// ─── state cookie(照 auth/github.ts 范式;per-provider 名) ────────────────

const COOKIE_PATH = '/api/connectors/oauth/callback'
const COOKIE_MAX_AGE_SECONDS = 600

export function oauthCookieName(provider: string): string {
  return `oc_conn_oauth_${provider}`
}

export function setConnectorOauthCookie(
  res: ServerResponse,
  provider: string,
  nonce: string,
  opts: { secure?: boolean } = {},
): void {
  const parts = [
    `${oauthCookieName(provider)}=${encodeURIComponent(nonce)}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (opts.secure ?? true) parts.push('Secure')
  appendSetCookie(res, parts.join('; '))
}

export function clearConnectorOauthCookie(
  res: ServerResponse,
  provider: string,
  opts: { secure?: boolean } = {},
): void {
  const parts = [
    `${oauthCookieName(provider)}=`,
    'Max-Age=0',
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (opts.secure ?? true) parts.push('Secure')
  appendSetCookie(res, parts.join('; '))
}

export function readConnectorOauthCookie(req: IncomingMessage, provider: string): string | null {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header.length === 0) return null
  const wanted = oauthCookieName(provider)
  for (const segment of header.split(';')) {
    const trimmed = segment.trim()
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) continue
    if (trimmed.slice(0, eqIdx) !== wanted) continue
    try {
      return decodeURIComponent(trimmed.slice(eqIdx + 1))
    } catch {
      return null
    }
  }
  return null
}

// ─── start ───────────────────────────────────────────────────────────────

export interface StartOauthPendingResult {
  /** 回跳 query 用的 state 原值(只出现在 authorize URL,不落库)。 */
  state: string
  /** state 的 sha256 hex(AAD / 排障标识用,可安全记日志)。 */
  stateHashHex: string
  /** 浏览器 cookie nonce 原值(Set-Cookie 用,不落库)。 */
  cookieNonce: string
}

/**
 * 原子登记 pending(同 user+provider 旧行整体被覆盖,旧 state 必败)。
 *
 * provider:v1 = 手写 provider 名('feishu');声明式 = **listing slug**(调用方从
 * loadVerifiedContractWithMeta 的 DB 事实取,不接受用户输入;0135 已把 CHECK 放开到 slug 形状)。
 */
export async function startOauthPending(
  opts: { userId: number; provider: string; draft: OauthDraft },
  pool: Pool = getPool(),
): Promise<StartOauthPendingResult> {
  const state = randomBytes(32).toString('base64url')
  const cookieNonce = randomBytes(32).toString('base64url')
  const stateHash = sha256(state)
  const stateHashHex = stateHash.toString('hex')
  const cookieNonceHash = sha256(cookieNonce)
  const aadSeed = randomUUID()

  const key = loadKmsKey()
  const plaintext = Buffer.from(JSON.stringify(opts.draft), 'utf8')
  let enc: ReturnType<typeof encrypt>
  try {
    enc = encrypt(plaintext, key, oauthDraftAad(stateHashHex, opts.userId, opts.provider, aadSeed))
  } finally {
    zeroBuffer(plaintext)
    zeroBuffer(key)
  }

  await pool.query(
    `INSERT INTO connector_oauth_pending
       (state_hash, user_id, provider, cookie_nonce_hash, draft_enc, draft_nonce,
        aad_seed, created_at, expires_at, consumed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, now(), now() + interval '10 minutes', NULL)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       state_hash = EXCLUDED.state_hash,
       cookie_nonce_hash = EXCLUDED.cookie_nonce_hash,
       draft_enc = EXCLUDED.draft_enc,
       draft_nonce = EXCLUDED.draft_nonce,
       aad_seed = EXCLUDED.aad_seed,
       created_at = now(),
       expires_at = EXCLUDED.expires_at,
       consumed_at = NULL`,
    [stateHash, opts.userId, opts.provider, cookieNonceHash, enc.ciphertext, enc.nonce, aadSeed],
  )
  return { state, stateHashHex, cookieNonce }
}

// ─── consume ─────────────────────────────────────────────────────────────

export interface ConsumedOauthPending {
  userId: number
  /** v1 = provider 名;声明式 = listing slug。 */
  provider: string
  draft: OauthDraft
}

interface PendingRow {
  user_id: number
  provider: string
  cookie_nonce_hash: Buffer
  draft_enc: Buffer | null
  draft_nonce: Buffer | null
  aad_seed: string
  expires_at: Date
  consumed_at: Date | null
}

/**
 * 单事务四因子消费。任何因子不满足 → OAUTH_STATE_MISMATCH 且**不消费**
 * (FOR UPDATE 后 ROLLBACK;偷来的 state 无浏览器 cookie 打不穿,也不 DoS 合法用户)。
 * 成功:tx 内置消费(draft 置 NULL)→ COMMIT → **事务外**解密返回 draft。
 * 调用方用完 draft 中的凭据后自行丢弃(string 值,无法真正清零 —— 与 github.ts 同权衡)。
 */
export async function consumeOauthPending(
  opts: { state: string; cookieNonce: string },
  pool: Pool = getPool(),
): Promise<ConsumedOauthPending> {
  const stateHash = sha256(opts.state)
  const stateHashHex = stateHash.toString('hex')
  const cookieNonceHash = sha256(opts.cookieNonce)

  const held = await tx(async (client) => {
    const r = await client.query<PendingRow>(
      `SELECT user_id::int AS user_id, provider, cookie_nonce_hash, draft_enc, draft_nonce,
              aad_seed::text AS aad_seed, expires_at, consumed_at
         FROM connector_oauth_pending
        WHERE state_hash = $1
        FOR UPDATE`,
      [stateHash],
    )
    const row = r.rows[0]
    if (!row) throw new ConnectorError('OAUTH_STATE_MISMATCH', 'state not found')
    if (row.consumed_at !== null) throw new ConnectorError('OAUTH_STATE_MISMATCH', 'state consumed')
    if (row.expires_at.getTime() <= Date.now()) {
      throw new ConnectorError('OAUTH_STATE_MISMATCH', 'state expired')
    }
    if (
      row.cookie_nonce_hash.length !== cookieNonceHash.length ||
      !timingSafeEqual(row.cookie_nonce_hash, cookieNonceHash)
    ) {
      throw new ConnectorError('OAUTH_STATE_MISMATCH', 'cookie nonce mismatch')
    }
    if (!row.draft_enc || !row.draft_nonce) {
      throw new ConnectorError('OAUTH_STATE_MISMATCH', 'draft missing')
    }
    await client.query(
      `UPDATE connector_oauth_pending
          SET consumed_at = now(), draft_enc = NULL, draft_nonce = NULL
        WHERE state_hash = $1`,
      [stateHash],
    )
    return {
      userId: row.user_id,
      provider: row.provider,
      aadSeed: row.aad_seed,
      draftEnc: Buffer.from(row.draft_enc),
      draftNonce: Buffer.from(row.draft_nonce),
    }
  }, pool)

  // 事务外解密(短事务纪律:解密/exchange 不占行锁)
  const key = loadKmsKey()
  let pt: Buffer | null = null
  try {
    pt = decryptToBuffer(
      held.draftEnc,
      held.draftNonce,
      key,
      oauthDraftAad(stateHashHex, held.userId, held.provider, held.aadSeed),
    )
    const draft = JSON.parse(pt.toString('utf8')) as OauthDraft
    // pkceVerifier 恒必需(两条路径共用的四因子之一,少了就没法完成交换)。
    if (typeof draft.pkceVerifier !== 'string')
      throw new ConnectorError('INTERNAL', 'oauth draft shape invalid')
    // client 凭据**可选**(platform 模式压根不落);但只要出现,就必须是 string —— 防止畸形
    // draft(对象/数组/数字)一路漏到 exchange 层。"该不该有"由各消费分支自己硬校验。
    if (draft.clientId !== undefined && typeof draft.clientId !== 'string')
      throw new ConnectorError('INTERNAL', 'oauth draft shape invalid')
    if (draft.clientSecret !== undefined && typeof draft.clientSecret !== 'string')
      throw new ConnectorError('INTERNAL', 'oauth draft shape invalid')
    // 声明式标记若存在,必须是正整数 versionId(回调据它选路径 + 载入契约,形状必须硬)。
    if (
      draft.connectorVersionId !== undefined &&
      (!Number.isInteger(draft.connectorVersionId) || draft.connectorVersionId <= 0)
    ) {
      throw new ConnectorError('INTERNAL', 'oauth draft connectorVersionId invalid')
    }
    return { userId: held.userId, provider: held.provider, draft }
  } finally {
    zeroBuffer(key)
    if (pt) zeroBuffer(pt)
    zeroBuffer(held.draftEnc)
  }
}
