/**
 * 连接器平台 · 声明式连接持久化(RFC §6.1/§10 三表 pin 之 connections)。
 *
 * 声明式连接与 v1 手写连接**共用同一张 connections 表**(不建平行表)。差别只在:
 *   - `provider` 存 **listing slug**(0133 放开硬编码 CHECK,应用层校验 slug 指向真实 listing);
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
import { tx } from '../../db/queries.js'
import { ConnectorError } from '../errors.js'
import type { AuthModeValue } from '../spec/types.js'
import { connectionAad } from '../store.js'
import {
  type DeclarativeSecretBag,
  requiredBindSources,
  validateSecretBag,
} from './credentialBag.js'

/** 声明式连接行(读取执行/撤销所需列)。 */
export interface DeclarativeConnectionRow {
  id: string
  user_id: number
  /** listing slug。 */
  provider: string
  display_name: string
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

const DECL_COLS = `id::text AS id, user_id::int AS user_id, provider, display_name,
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
  authMode: AuthModeValue
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

/** 解密声明式连接的凭据袋(解密 + 按 authMode 需要的 source 复校验)。 */
export function decryptBagFromRow(
  row: DeclarativeConnectionRow,
  authMode: AuthModeValue,
): DeclarativeSecretBag {
  if (row.secret_enc === null || row.secret_nonce === null)
    throw new ConnectorError('CONNECTION_REVOKED', 'connection has no secret')
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
    validateSecretBag(parsed, requiredBindSources(authMode))
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
