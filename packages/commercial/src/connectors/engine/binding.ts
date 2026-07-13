/**
 * 连接器平台 · 声明式连接持久化(RFC §6.1/§10 三表 pin 之 connections)。
 *
 * 声明式连接与 v1 手写连接**共用同一张 connections 表**(不建平行表)。差别只在:
 *   - `provider` 存 **listing slug**(0136 放开硬编码 CHECK,应用层校验 slug 指向真实 listing);
 *   - 四个 pin 列(connector_version_id / spec_hash / exec_contract_hash / auth_contract_version)
 *     钉死绑定所依据的**已验签 contract revision**;contract bytes 变(重新编译签名)=新 hash,
 *     旧连接执行时 pin 不符 → RELINK_REQUIRED(fail-closed,§信任模型)。
 *   - secret 是**声明式凭据袋**(credentialBag),AEAD 加密,AAD 复用 store.connectionAad。
 *
 * 加密底座 / AAD / account_key 全部复用 store 的单一权威(connectionAad / computeAccountKey /
 * crypto.aead),这里只负责"声明式行"的写入/读取/撤销。fencing 的 revision/secret_generation
 * 走表默认(slice③ 只读、无并发刷新);写路径与刷新在后续切片接入。
 *
 * 迁移债(§8b slice⑥):v1 的 SECRET_SCHEMAS 枚举驱动 store 与本声明式路径最终收敛为单一
 * store(v1 provider 变成声明式 connector),届时删枚举路径。当前是**同一张表上的过渡双写入口**,
 * 非永久并行权威。
 */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { decryptToBuffer, encrypt } from '../../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../../crypto/keys.js'
import { getPool } from '../../db/index.js'
import { type QueryRunner, tx } from '../../db/queries.js'
import { ConnectorError } from '../errors.js'
import type { ExecContractT } from '../spec/types.js'
import { connectionAad } from '../store.js'
import { type DeclarativeSecretBag, storedBagSources, validateSecretBag } from './credentialBag.js'

/**
 * 连接 meta 里 access_token 的**过期时刻**(ISO-8601 字符串)。
 *
 * 为什么放 meta 而不是加密袋:它**不是机密**(知道"某 token 何时过期"毫无攻击价值),而放进袋里
 * 意味着每次判断是否需要续期都得先解密 —— 且袋的形状权威(storedBagSources)是**凭据 source 枚举**,
 * 塞一个时间戳进去会破坏"袋里每个键都是一个可注入凭据"的不变量。
 *
 * **缺这个键 = 视作永不过期**(GitHub 这类不下发 expires_in、access_token 长期有效的 provider)——
 * 这是有意的语义:绝不能因为"没有过期时间"就每次都去 refresh(那类 provider 连 refresh_token 都没有)。
 */
export const META_TOKEN_EXPIRES_AT = 'token_expires_at'

/** 从连接 meta 读 access_token 过期时刻;缺失/非法 → null(= 永不过期,见 META_TOKEN_EXPIRES_AT)。 */
export function readTokenExpiresAt(meta: Record<string, unknown> | null | undefined): Date | null {
  const raw = meta?.[META_TOKEN_EXPIRES_AT]
  if (typeof raw !== 'string' || raw.length === 0) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t) : null
}

/** 声明式连接行(读取执行/撤销所需列)。 */
export interface DeclarativeConnectionRow {
  id: string
  user_id: number
  /** listing slug。 */
  provider: string
  display_name: string
  /** 凭据代数(账本 pin + beginExecute 复核)。 */
  revision: number
  aad_seed: string
  secret_enc: Buffer | null
  secret_nonce: Buffer | null
  connector_version_id: string | null
  spec_hash: Buffer | null
  exec_contract_hash: Buffer | null
  auth_contract_version: number | null
  status: 'active' | 'error'
  meta: Record<string, unknown>
}

const DECL_COLS = `id::text AS id, user_id::int AS user_id, provider, display_name, revision,
  aad_seed::text AS aad_seed, secret_enc, secret_nonce,
  connector_version_id::text AS connector_version_id, spec_hash, exec_contract_hash,
  auth_contract_version, status, meta`

export interface InsertDeclarativeConnectionInput {
  userId: number
  /** listing slug。 */
  slug: string
  connectorVersionId: number
  /** contract.spec_hash(hex)。 */
  specHashHex: string
  /** canonicalSha256Hex(contract)(hex)。 */
  execContractHashHex: string
  authContractVersion: number
  /** computeAccountKey(canonicalAccountIdentity) 的 HMAC。 */
  accountKey: string
  bag: DeclarativeSecretBag
  displayName?: string
  /** 展示元数据(account_hint 等;严禁凭据)。 */
  meta?: Record<string, unknown>
}

function encryptBag(
  bag: DeclarativeSecretBag,
  userId: number,
  slug: string,
  aadSeed: string,
): { ciphertext: Buffer; nonce: Buffer } {
  const key = loadKmsKey()
  const plaintext = Buffer.from(JSON.stringify(bag), 'utf8')
  try {
    return encrypt(plaintext, key, connectionAad(aadSeed, userId, slug))
  } finally {
    zeroBuffer(plaintext)
    zeroBuffer(key)
  }
}

/**
 * 落声明式连接。撞唯一索引(user_id, provider, account_key)WHERE revoked_at IS NULL → 视作**重绑**:
 * 撤销旧活跃行(secret 置 NULL + revoked_at,留审计)再插新行,整体在一个事务里。
 * 返回 { id, rebound }。
 */
export async function insertDeclarativeConnection(
  input: InsertDeclarativeConnectionInput,
  pool: Pool = getPool(),
): Promise<{ id: string; rebound: boolean }> {
  const displayName = (input.displayName ?? '').slice(0, 64)
  const meta = input.meta ?? {}
  const specHash = Buffer.from(input.specHashHex, 'hex')
  const execHash = Buffer.from(input.execContractHashHex, 'hex')

  return tx(async (c: PoolClient) => {
    // 撤销同账号旧活跃行(若有)→ 让唯一索引腾位;记 rebound。
    const revoked = await c.query(
      `UPDATE connections
          SET secret_enc = NULL, secret_nonce = NULL, revoked_at = now(), updated_at = now()
        WHERE user_id = $1 AND provider = $2 AND account_key = $3 AND revoked_at IS NULL
        RETURNING id`,
      [input.userId, input.slug, input.accountKey],
    )
    const rebound = (revoked.rowCount ?? 0) > 0

    const aadSeed = randomUUID()
    const enc = encryptBag(input.bag, input.userId, input.slug, aadSeed)
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO connections
         (user_id, provider, display_name, account_key, aad_seed,
          secret_enc, secret_nonce, meta,
          connector_version_id, spec_hash, exec_contract_hash, auth_contract_version)
       VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8::jsonb,$9,$10,$11,$12)
       RETURNING id::text AS id`,
      [
        input.userId,
        input.slug,
        displayName,
        input.accountKey,
        aadSeed,
        enc.ciphertext,
        enc.nonce,
        JSON.stringify(meta),
        input.connectorVersionId,
        specHash,
        execHash,
        input.authContractVersion,
      ],
    )
    return { id: inserted.rows[0]!.id, rebound }
  }, pool)
}

/** 列出用户的活跃声明式连接(管理界面/列表用;不含 secret)。 */
export async function listDeclarativeConnections(
  userId: number,
  pool: Pool = getPool(),
): Promise<
  Array<{
    id: string
    slug: string
    displayName: string
    connectorVersionId: string | null
    meta: Record<string, unknown>
    createdAt: Date
  }>
> {
  const r = await pool.query<{
    id: string
    provider: string
    display_name: string
    connector_version_id: string | null
    meta: Record<string, unknown>
    created_at: Date
  }>(
    `SELECT id::text AS id, provider, display_name,
            connector_version_id::text AS connector_version_id, meta, created_at
       FROM connections
      WHERE user_id = $1 AND revoked_at IS NULL AND connector_version_id IS NOT NULL
      ORDER BY created_at DESC`,
    [userId],
  )
  return r.rows.map((row) => ({
    id: row.id,
    slug: row.provider,
    displayName: row.display_name,
    connectorVersionId: row.connector_version_id,
    meta: row.meta ?? {},
    createdAt: row.created_at,
  }))
}

/** 读取一条**活跃**声明式连接(id + user + 未撤销 + active + connector_version_id 非空)。 */
export async function getDeclarativeConnection(
  id: string,
  userId: number,
  pool: Pool = getPool(),
): Promise<DeclarativeConnectionRow | null> {
  const r = await pool.query<DeclarativeConnectionRow>(
    `SELECT ${DECL_COLS} FROM connections
      WHERE id = $1::bigint AND user_id = $2 AND revoked_at IS NULL
        AND status = 'active' AND connector_version_id IS NOT NULL`,
    [id, userId],
  )
  return r.rows[0] ?? null
}

/**
 * **行锁**读取一条活跃声明式连接(`SELECT … FOR UPDATE`;必须在事务 client 上调用)。
 *
 * 唯一用途 = oauth2 token 续期的临界区(tokenEngine):同一连接的并发请求在这里排队,保证
 * "重查过期 → refresh → 写新袋" 三步是**原子**的。锁在行上,不同连接互不阻塞;锁随事务
 * COMMIT/ROLLBACK 释放。
 */
export async function lockDeclarativeConnectionForUpdate(
  id: string,
  userId: number,
  client: PoolClient,
): Promise<DeclarativeConnectionRow | null> {
  const r = await client.query<DeclarativeConnectionRow>(
    `SELECT ${DECL_COLS} FROM connections
      WHERE id = $1::bigint AND user_id = $2 AND revoked_at IS NULL
        AND status = 'active' AND connector_version_id IS NOT NULL
      FOR UPDATE`,
    [id, userId],
  )
  return r.rows[0] ?? null
}

export interface UpdateDeclarativeConnectionSecretInput {
  connectionId: string
  userId: number
  /** **完整**新袋(落库形状;调用方负责按 storedBagSources 组齐)。 */
  bag: DeclarativeSecretBag
  /** 新 access_token 的过期时刻;不给 = 不动 meta 里的既有值。 */
  tokenExpiresAt?: Date
}

/**
 * 就地更新连接的凭据袋(oauth2 refresh 轮换的唯一写入口)。收 `QueryRunner` → 可以是事务 client
 * (tokenEngine 在行锁事务内调用)也可以是 Pool。
 *
 * 三条关键决策:
 *   ① **AAD 不变**:复用行上既有的 `aad_seed`(+ user_id + provider),即 connectionAad 公式原样 ——
 *      同一条连接自始至终同一个 AAD。换 seed 只在"新一代连接"(insertDeclarativeConnection)时做;
 *      refresh 只是同一凭据的续期,不是新绑定。nonce 由 encrypt 每次新生成,不存在 nonce 复用问题。
 *   ② **meta 增量合并**(`meta || jsonb_build_object`)而非整块覆盖 —— 整块覆盖会把 bind 期写进去的
 *      account_hint 等字段抹掉。
 *   ③ **不 bump revision**:revision 是"凭据主体代数"(账本 pin + beginExecute 复核 REVISION_MISMATCH),
 *      语义是"用户换了账号/重新绑定"。token 续期是同一账号同一授权的延续,若在这里 bump,一条正在
 *      等用户确认的 write 提案会因为后台自动续期而失效 —— 那是纯粹的用户体验倒退。
 */
export async function updateDeclarativeConnectionSecret(
  input: UpdateDeclarativeConnectionSecretInput,
  runner: QueryRunner,
): Promise<void> {
  // aad_seed / provider 是 AAD 公式的输入,必须取行上的真值(不接受调用方自带,防传错)。
  const cur = await runner.query<{ aad_seed: string; provider: string }>(
    `SELECT aad_seed::text AS aad_seed, provider FROM connections
      WHERE id = $1::bigint AND user_id = $2 AND revoked_at IS NULL`,
    [input.connectionId, input.userId],
  )
  const row = cur.rows[0]
  if (!row) throw new ConnectorError('CONNECTION_REVOKED', 'connection not active')

  const enc = encryptBag(input.bag, input.userId, row.provider, row.aad_seed)
  // 空 patch = jsonb 合并的恒等元(不给 tokenExpiresAt 时 meta 原封不动)。
  const metaPatch =
    input.tokenExpiresAt === undefined
      ? '{}'
      : JSON.stringify({ [META_TOKEN_EXPIRES_AT]: input.tokenExpiresAt.toISOString() })

  const r = await runner.query(
    `UPDATE connections
        SET secret_enc = $3, secret_nonce = $4,
            meta = COALESCE(meta, '{}'::jsonb) || $5::jsonb,
            updated_at = now()
      WHERE id = $1::bigint AND user_id = $2 AND revoked_at IS NULL`,
    [input.connectionId, input.userId, enc.ciphertext, enc.nonce, metaPatch],
  )
  if ((r.rowCount ?? 0) === 0)
    throw new ConnectorError('CONNECTION_REVOKED', 'connection not active')
}

/**
 * 解密声明式连接的凭据袋(解密 + 按 **落库形状**(storedBagSources)复校验)。
 * 形状权威直接从 pin 的 contract 算 —— 调用方不再自带 sources 数组(消除"传错一套 source"的可能:
 * oauth2 的落库袋 ≠ 用户直填袋)。
 */
export function decryptBagFromRow(
  row: DeclarativeConnectionRow,
  contract: ExecContractT,
): DeclarativeSecretBag {
  if (row.secret_enc === null || row.secret_nonce === null)
    throw new ConnectorError('CONNECTION_REVOKED', 'connection has no secret')
  const stored = storedBagSources(contract)
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
    validateSecretBag(parsed, stored.required, stored.optional)
    return parsed
  } catch (e) {
    if (e instanceof ConnectorError) throw e
    throw new ConnectorError('INTERNAL', 'secret bag decrypt/parse failed')
  } finally {
    if (pt) zeroBuffer(pt)
    zeroBuffer(key)
  }
}

/** 撤销声明式连接(unbind):secret 置 NULL + revoked_at,留 tombstone 行。 */
export async function revokeDeclarativeConnection(
  id: string,
  userId: number,
  pool: Pool = getPool(),
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE connections
        SET secret_enc = NULL, secret_nonce = NULL, revoked_at = now(), updated_at = now()
      WHERE id = $1::bigint AND user_id = $2 AND revoked_at IS NULL
        AND connector_version_id IS NOT NULL`,
    [id, userId],
  )
  return (r.rowCount ?? 0) > 0
}
