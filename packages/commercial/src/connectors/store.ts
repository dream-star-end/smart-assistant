/**
 * store — connections 表存取(设计终稿 §2)。
 *
 * 加密纪律:
 *   - AES-256-GCM(crypto/aead.ts)+ loadKmsKey;**AAD = `conn:{aad_seed}:{user_id}:{provider}`**。
 *   - aad_seed 每次 secret 写入(绑定/重绑/刷新)重新生成 → 跨代密文移植必解密失败。
 *   - 明文 Buffer / key 用后 zeroBuffer;不做进程内明文缓存。
 *   - **一切 secret UPDATE 必须带** `WHERE revision=$exp AND secret_generation=$exp
 *     AND revoked_at IS NULL AND status='active'`,rowCount=0 → 丢弃不重试
 *     (真 fencing 在 DB 条件;Redis 锁只减少无谓并发)。
 *
 * account_key = HMAC-SHA256(canonicalAccountIdentity),key=HKDF(OPENCLAUDE_KMS_KEY,
 * 'connector-account-index-v1')。每 provider 单一 canonicalAccountIdentity() 供
 * 绑定/索引/轮换三处共用(webdav=规范化origin+username / imap=小写邮箱 /
 * notion=workspace(bot)id / feishu=union_id)。
 *
 * 并发 rebind:唯一索引 connections_user_provider_account 是权威;23505 → 既有行上
 * 更新 secret(重生成 aad_seed、revision+1、generation+1)。
 */

import { createHmac, hkdfSync, randomUUID } from 'node:crypto'
import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Pool } from 'pg'
import { decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'
import { getPool } from '../db/index.js'
import { tx } from '../db/queries.js'
import { ConnectorError } from './errors.js'
import type { DbConnectorProvider } from './registry.js'

// ─── secret payload schemas(加密 JSON;严格,未知字段拒绝) ────────────────

const strict = { additionalProperties: false } as const

const BasePayload = {
  schema_version: Type.Literal(1),
  account_identity: Type.String({ minLength: 1, maxLength: 512 }),
  account_identity_version: Type.Literal(1),
}

export const WebdavSecretSchema = Type.Object(
  {
    ...BasePayload,
    serverUrl: Type.String({ minLength: 8, maxLength: 1024 }),
    username: Type.String({ minLength: 1, maxLength: 256 }),
    password: Type.String({ minLength: 1, maxLength: 512 }),
  },
  strict,
)
export type WebdavSecret = Static<typeof WebdavSecretSchema>

export const ImapSecretSchema = Type.Object(
  {
    ...BasePayload,
    email: Type.String({ minLength: 3, maxLength: 254 }),
    password: Type.String({ minLength: 1, maxLength: 512 }),
    imapHost: Type.String({ minLength: 1, maxLength: 253 }),
    imapPort: Type.Integer({ minimum: 1, maximum: 65535 }),
    smtpHost: Type.String({ minLength: 1, maxLength: 253 }),
    smtpPort: Type.Integer({ minimum: 1, maximum: 65535 }),
  },
  strict,
)
export type ImapSecret = Static<typeof ImapSecretSchema>

export const NotionSecretSchema = Type.Object(
  {
    ...BasePayload,
    token: Type.String({ minLength: 8, maxLength: 512 }),
  },
  strict,
)
export type NotionSecret = Static<typeof NotionSecretSchema>

export const FeishuSecretSchema = Type.Object(
  {
    ...BasePayload,
    clientId: Type.String({ minLength: 1, maxLength: 256 }),
    clientSecret: Type.String({ minLength: 1, maxLength: 512 }),
    accessToken: Type.String({ minLength: 8, maxLength: 4096 }),
    refreshToken: Type.String({ minLength: 8, maxLength: 4096 }),
  },
  strict,
)
export type FeishuSecret = Static<typeof FeishuSecretSchema>

export type ConnectorSecret = WebdavSecret | ImapSecret | NotionSecret | FeishuSecret

const SECRET_SCHEMAS: Record<DbConnectorProvider, ReturnType<typeof Type.Object>> = {
  webdav: WebdavSecretSchema,
  imap: ImapSecretSchema,
  notion: NotionSecretSchema,
  feishu: FeishuSecretSchema,
}

// ─── AAD / account key ───────────────────────────────────────────────────

/** AAD 公式一:`conn:{aad_seed}:{user_id}:{provider}`(设计 §2)。 */
export function connectionAad(aadSeed: string, userId: number, provider: string): Buffer {
  return Buffer.from(`conn:${aadSeed}:${userId}:${provider}`, 'utf8')
}

const ACCOUNT_INDEX_INFO = 'connector-account-index-v1'

/**
 * account_key = HMAC-SHA256(identity, key=HKDF(KMS,'connector-account-index-v1'))
 * → 64 hex 字符(表 CHECK 16..128 ✓)。确定性索引:同账号重绑撞唯一索引 → rebind。
 */
export function computeAccountKey(identity: string, env: NodeJS.ProcessEnv = process.env): string {
  const kms = loadKmsKey(env)
  try {
    const derived = Buffer.from(hkdfSync('sha256', kms, Buffer.alloc(0), ACCOUNT_INDEX_INFO, 32))
    try {
      return createHmac('sha256', derived).update(identity, 'utf8').digest('hex')
    } finally {
      zeroBuffer(derived)
    }
  } finally {
    zeroBuffer(kms)
  }
}

/**
 * 每 provider 的规范化账号身份(绑定/索引/KMS 轮换三处共用的**唯一**函数)。
 *   webdav = 规范化 origin + username;imap = 小写邮箱;
 *   notion = bot(workspace)id;feishu = union_id。
 */
export function canonicalAccountIdentity(
  provider: DbConnectorProvider,
  parts: Record<string, string>,
): string {
  switch (provider) {
    case 'webdav': {
      const origin = (parts.origin ?? '').toLowerCase()
      const username = parts.username ?? ''
      if (!origin || !username)
        throw new ConnectorError('INTERNAL', 'webdav identity parts missing')
      return `webdav:${origin}:${username}`
    }
    case 'imap': {
      const email = (parts.email ?? '').trim().toLowerCase()
      if (!email) throw new ConnectorError('INTERNAL', 'imap identity parts missing')
      return `imap:${email}`
    }
    case 'notion': {
      const botId = parts.botId ?? ''
      if (!botId) throw new ConnectorError('INTERNAL', 'notion identity parts missing')
      return `notion:${botId}`
    }
    case 'feishu': {
      const unionId = parts.unionId ?? ''
      if (!unionId) throw new ConnectorError('INTERNAL', 'feishu identity parts missing')
      return `feishu:${unionId}`
    }
  }
}

// ─── 行类型 ──────────────────────────────────────────────────────────────

export interface ConnectionRow {
  id: string // bigint → string
  user_id: number
  provider: DbConnectorProvider
  display_name: string
  account_key: string
  aad_seed: string
  secret_enc: Buffer | null
  secret_nonce: Buffer | null
  key_version: number
  revision: number
  secret_generation: string // bigint → string
  meta: Record<string, unknown>
  status: 'active' | 'error'
  last_verified_at: Date | null
  last_error_code: string | null
  created_at: Date
  updated_at: Date
  revoked_at: Date | null
}

const ROW_COLS = `id::text AS id, user_id::int AS user_id, provider, display_name, account_key,
  aad_seed::text AS aad_seed, secret_enc, secret_nonce, key_version, revision,
  secret_generation::text AS secret_generation, meta, status, last_verified_at,
  last_error_code, created_at, updated_at, revoked_at`

// ─── CRUD ────────────────────────────────────────────────────────────────

export interface UpsertConnectionInput {
  userId: number
  provider: DbConnectorProvider
  displayName?: string
  /** canonicalAccountIdentity 的 HMAC(computeAccountKey)。 */
  accountKey: string
  /** 完整 secret payload(schema 严格校验后加密)。 */
  payload: ConnectorSecret
  /** 展示元数据(account_hint 等;严禁凭据/敏感字段)。 */
  meta?: Record<string, unknown>
}

function encryptPayload(
  payload: ConnectorSecret,
  provider: DbConnectorProvider,
  userId: number,
  aadSeed: string,
): { ciphertext: Buffer; nonce: Buffer } {
  const schema = SECRET_SCHEMAS[provider]
  if (!Value.Check(schema, payload)) {
    throw new ConnectorError('INTERNAL', `secret payload failed schema for ${provider}`)
  }
  const key = loadKmsKey()
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  try {
    return encrypt(plaintext, key, connectionAad(aadSeed, userId, provider))
  } finally {
    zeroBuffer(plaintext)
    zeroBuffer(key)
  }
}

/**
 * 绑定(insert;同账号重绑 23505 → 既有行更新 secret)。
 * 返回落库行 + 是否 rebind。
 */
export async function upsertConnection(
  input: UpsertConnectionInput,
  pool: Pool = getPool(),
): Promise<{ connection: ConnectionRow; rebound: boolean }> {
  const aadSeed = randomUUID()
  const enc = encryptPayload(input.payload, input.provider, input.userId, aadSeed)
  const displayName = (input.displayName ?? '').slice(0, 64)
  const meta = input.meta ?? {}
  try {
    const r = await pool.query<ConnectionRow>(
      `INSERT INTO connections
         (user_id, provider, display_name, account_key, aad_seed, secret_enc, secret_nonce,
          meta, status, last_verified_at, last_error_code)
       VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8,'active',now(),NULL)
       RETURNING ${ROW_COLS}`,
      [
        input.userId,
        input.provider,
        displayName,
        input.accountKey,
        aadSeed,
        enc.ciphertext,
        enc.nonce,
        JSON.stringify(meta),
      ],
    )
    return { connection: r.rows[0]!, rebound: false }
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string }
    if (pgErr?.code !== '23505' || pgErr?.constraint !== 'connections_user_provider_account') {
      throw err
    }
  }
  // rebind:唯一索引权威 → **短事务 SELECT ... FOR UPDATE 后带 expected revision/generation
  // 条件更新**(P1#7:双代数 CAS + 行锁,消除 last-write-wins;并发 rebind 由行锁串行,
  // 每次基于锁内当前代数递进,不丢更新、不用旧代数覆盖)。
  const aadSeed2 = randomUUID()
  const enc2 = encryptPayload(input.payload, input.provider, input.userId, aadSeed2)
  const rebound = await tx<ConnectionRow | null>(async (client) => {
    const sel = await client.query<{ revision: number; secret_generation: string }>(
      `SELECT revision, secret_generation::text AS secret_generation
         FROM connections
        WHERE user_id = $1 AND provider = $2 AND account_key = $3 AND revoked_at IS NULL
        FOR UPDATE`,
      [input.userId, input.provider, input.accountKey],
    )
    const cur = sel.rows[0]
    if (!cur) return null // 并发解绑窗口:既有行已撤销
    const upd = await client.query<ConnectionRow>(
      `UPDATE connections SET
          secret_enc = $1, secret_nonce = $2, aad_seed = $3::uuid,
          revision = revision + 1, secret_generation = secret_generation + 1,
          display_name = CASE WHEN $4 <> '' THEN $4 ELSE display_name END,
          meta = $5, status = 'active', last_error_code = NULL,
          last_verified_at = now(), updated_at = now()
        WHERE user_id = $6 AND provider = $7 AND account_key = $8 AND revoked_at IS NULL
          AND revision = $9 AND secret_generation = $10
        RETURNING ${ROW_COLS}`,
      [
        enc2.ciphertext,
        enc2.nonce,
        aadSeed2,
        displayName,
        JSON.stringify(meta),
        input.userId,
        input.provider,
        input.accountKey,
        cur.revision,
        cur.secret_generation,
      ],
    )
    return upd.rows[0] ?? null
  }, pool)
  if (!rebound) {
    // 撞唯一又更新不到:并发解绑窗口 → 让调用方重试一次绑定
    throw new ConnectorError('INTERNAL', 'rebind lost race with concurrent revoke')
  }
  return { connection: rebound, rebound: true }
}

/** 调用链强制查询:id + user_id + 未撤销 + active(§7 凭据查询收口)。 */
export async function getActiveConnection(
  id: string,
  userId: number,
  pool: Pool = getPool(),
): Promise<ConnectionRow | null> {
  const r = await pool.query<ConnectionRow>(
    `SELECT ${ROW_COLS} FROM connections
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND status = 'active'
      LIMIT 1`,
    [id, userId],
  )
  return r.rows[0] ?? null
}

/** 设置页/删除用:含 error 态(仍排除已撤销)。 */
export async function getConnectionAnyStatus(
  id: string,
  userId: number,
  pool: Pool = getPool(),
): Promise<ConnectionRow | null> {
  const r = await pool.query<ConnectionRow>(
    `SELECT ${ROW_COLS} FROM connections
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [id, userId],
  )
  return r.rows[0] ?? null
}

/** 用户全部未撤销连接(active + error;error 行前端引导重绑)。 */
export async function listConnections(
  userId: number,
  pool: Pool = getPool(),
): Promise<ConnectionRow[]> {
  const r = await pool.query<ConnectionRow>(
    `SELECT ${ROW_COLS} FROM connections
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY created_at ASC`,
    [userId],
  )
  return r.rows
}

/**
 * 解密 secret payload(schema 复核)。AAD 错配 / 密文损坏 → AeadError 透传
 * (调用方按 INTERNAL 处理并告警 —— 这是不可自愈的数据完整性问题)。
 */
export function decryptConnectionSecret<T extends ConnectorSecret = ConnectorSecret>(
  row: ConnectionRow,
): T {
  if (!row.secret_enc || !row.secret_nonce) {
    throw new ConnectorError('CONNECTION_REVOKED', 'connection has no secret')
  }
  const key = loadKmsKey()
  let pt: Buffer | null = null
  try {
    pt = decryptToBuffer(
      row.secret_enc,
      row.secret_nonce,
      key,
      connectionAad(row.aad_seed, row.user_id, row.provider),
    )
    const parsed = JSON.parse(pt.toString('utf8')) as unknown
    const schema = SECRET_SCHEMAS[row.provider]
    if (!Value.Check(schema, parsed)) {
      throw new ConnectorError('INTERNAL', `stored secret failed schema for ${row.provider}`)
    }
    return parsed as T
  } finally {
    zeroBuffer(key)
    if (pt) zeroBuffer(pt)
  }
}

/**
 * 日常凭据刷新(feishu token):**generation fencing UPDATE**。
 * revision 不动(非换代),generation+1,aad_seed 重生成。
 * 返回 true=写入成功;false=stale writer(rowCount=0,丢弃不重试)。
 */
export async function updateConnectionSecret(
  opts: {
    id: string
    userId: number
    provider: DbConnectorProvider
    expectedRevision: number
    expectedGeneration: string
    payload: ConnectorSecret
    meta?: Record<string, unknown>
  },
  pool: Pool = getPool(),
): Promise<boolean> {
  const aadSeed = randomUUID()
  const enc = encryptPayload(opts.payload, opts.provider, opts.userId, aadSeed)
  const metaSql = opts.meta !== undefined ? ', meta = $9' : ''
  const params: unknown[] = [
    enc.ciphertext,
    enc.nonce,
    aadSeed,
    opts.id,
    opts.userId,
    opts.provider,
    opts.expectedRevision,
    opts.expectedGeneration,
  ]
  if (opts.meta !== undefined) params.push(JSON.stringify(opts.meta))
  const r = await pool.query(
    `UPDATE connections SET
        secret_enc = $1, secret_nonce = $2, aad_seed = $3::uuid,
        secret_generation = secret_generation + 1,
        last_verified_at = now(), updated_at = now()${metaSql}
      WHERE id = $4 AND user_id = $5 AND provider = $6
        AND revision = $7 AND secret_generation = $8
        AND revoked_at IS NULL AND status = 'active'`,
    params,
  )
  return (r.rowCount ?? 0) > 0
}

/**
 * 凭据永久失效(invalid_grant 等)→ status='error' + last_error_code,fail-closed。
 * 同带 generation 条件(并发刷新成功者 generation 已变 → 本次标错被丢弃,正确)。
 */
export async function markConnectionError(
  opts: { id: string; userId: number; expectedGeneration: string; errorCode: string },
  pool: Pool = getPool(),
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE connections SET
        status = 'error', last_error_code = $1, updated_at = now()
      WHERE id = $2 AND user_id = $3 AND secret_generation = $4
        AND revoked_at IS NULL AND status = 'active'`,
    [opts.errorCode.slice(0, 64), opts.id, opts.userId, opts.expectedGeneration],
  )
  return (r.rowCount ?? 0) > 0
}

/** display_name 更新。 */
export async function renameConnection(
  id: string,
  userId: number,
  displayName: string,
  pool: Pool = getPool(),
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE connections SET display_name = $1, updated_at = now()
      WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL`,
    [displayName.slice(0, 64), id, userId],
  )
  return (r.rowCount ?? 0) > 0
}

/**
 * 解绑 saga 第③步的短事务体:secret 置 NULL + revoked_at(tombstone 留行审计)。
 * 事务内**禁网络 I/O**;调用方须在此**之前**解密暂存 revoke 所需 Buffer(§8 ②),
 * 之后事务外 best-effort provider revoke(§8 ④)—— 本函数返回的行 secret 已为 NULL。
 * 没命中(已撤销/非本人)→ null。
 */
export async function revokeConnection(
  id: string,
  userId: number,
  pool: Pool = getPool(),
): Promise<ConnectionRow | null> {
  const r = await pool.query<ConnectionRow>(
    `UPDATE connections SET
        secret_enc = NULL, secret_nonce = NULL,
        revoked_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING ${ROW_COLS}`,
    [id, userId],
  )
  return r.rows[0] ?? null
}

/** 绑定/调用成功后的健康度回写。 */
export async function touchConnectionVerified(id: string, pool: Pool = getPool()): Promise<void> {
  await pool.query(
    `UPDATE connections SET last_verified_at = now(), updated_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  )
}
