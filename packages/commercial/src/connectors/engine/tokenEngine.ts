/**
 * 连接器平台 · token 引擎(RFC §3.4/§5:凭据解析收口)。
 *
 * `resolveApiCredentials` 是"从连接凭据袋得到可注入 API 的 ResolvedCredentials"的单一入口:
 *   - static-token:袋里就是 access_token,直接用;
 *   - token-exchange:先查**加密 token 缓存**(cache key=(connection_id, 'exchange') 引擎派生);命中且
 *     未近过期(带 skew)→ 用缓存 access_token;否则用袋里的交换凭据经 engineTokenExchange 换新 token
 *     → 加密写回缓存 → 返回。凭据(交换输入 + 换回的 access_token)全程只在 master 内存活、加密落缓存。
 *
 * bind 阶段(尚无 connectionId)传 cache=undefined:换一次仅供 identity probe,不落缓存;首个 execute
 * 会再换一次并落缓存(可接受;省一次的优化留后)。
 */

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { decryptToBuffer, encrypt } from '../../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../../crypto/keys.js'
import { getPool } from '../../db/index.js'
import { ConnectorError } from '../errors.js'
import type { ExecContractT } from '../spec/types.js'
import { type DeclarativeSecretBag, bagToResolvedCredentials } from './credentialBag.js'
import type { EngineHttpDeps } from './driver.js'
import type { ResolvedCredentials } from './placement.js'
import { engineTokenExchange } from './tokenExchange.js'

/** token-exchange 的缓存 slot（引擎派生、不可配）。 */
export const EXCHANGE_NODE_ID = 'exchange'
/** 过期提前量:距 expires_at 不足此值即视作过期重换。 */
const EXPIRY_SKEW_MS = 60_000
/** 上游未给 expiresIn 时的保守缓存 TTL。 */
const DEFAULT_TTL_SEC = 3600

function tokenCacheAad(aadSeed: string, connectionId: string, nodeId: string): Buffer {
  return Buffer.from(`tokcache:${aadSeed}:${connectionId}:${nodeId}`, 'utf8')
}

async function readTokenCache(
  connectionId: string,
  nodeId: string,
  pool: Pool,
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  const r = await pool.query<{
    token_enc: Buffer
    token_nonce: Buffer
    aad_seed: string
    expires_at: Date
  }>(
    `SELECT token_enc, token_nonce, aad_seed::text AS aad_seed, expires_at
       FROM connector_token_cache WHERE connection_id = $1::bigint AND node_id = $2`,
    [connectionId, nodeId],
  )
  const row = r.rows[0]
  if (!row) return null
  const key = loadKmsKey()
  let pt: Buffer | null = null
  try {
    pt = decryptToBuffer(row.token_enc, row.token_nonce, key, tokenCacheAad(row.aad_seed, connectionId, nodeId))
    return { accessToken: pt.toString('utf8'), expiresAt: row.expires_at }
  } catch {
    return null // 解密失败(KMS 轮换等)→ 视作 miss,重换。
  } finally {
    if (pt) zeroBuffer(pt)
    zeroBuffer(key)
  }
}

async function writeTokenCache(
  connectionId: string,
  nodeId: string,
  accessToken: string,
  expiresAt: Date,
  pool: Pool,
): Promise<void> {
  const aadSeed = randomUUID()
  const key = loadKmsKey()
  const ptBuf = Buffer.from(accessToken, 'utf8')
  let enc: ReturnType<typeof encrypt>
  try {
    enc = encrypt(ptBuf, key, tokenCacheAad(aadSeed, connectionId, nodeId))
  } finally {
    zeroBuffer(ptBuf)
    zeroBuffer(key)
  }
  await pool.query(
    `INSERT INTO connector_token_cache
       (connection_id, node_id, token_enc, token_nonce, aad_seed, expires_at, refreshed_at)
     VALUES ($1::bigint, $2, $3, $4, $5::uuid, $6, now())
     ON CONFLICT (connection_id, node_id) DO UPDATE
       SET token_enc = EXCLUDED.token_enc, token_nonce = EXCLUDED.token_nonce,
           aad_seed = EXCLUDED.aad_seed, expires_at = EXCLUDED.expires_at, refreshed_at = now()`,
    [connectionId, nodeId, enc.ciphertext, enc.nonce, aadSeed, expiresAt],
  )
}

export interface ResolveApiCredentialsInput {
  contract: ExecContractT
  /** 解密后的连接凭据袋(static-token: {access_token};token-exchange: 交换输入)。 */
  bag: DeclarativeSecretBag
  deps?: EngineHttpDeps
  /** 有值 → 读写 token 缓存(execute/write 路径);无值 → 不缓存(bind 探针路径)。 */
  cache?: { connectionId: string; pool: Pool }
}

export async function resolveApiCredentials(
  input: ResolveApiCredentialsInput,
): Promise<ResolvedCredentials> {
  const { contract, bag, deps } = input
  if (contract.authMode === 'static-token') {
    return bagToResolvedCredentials('static-token', bag)
  }
  if (contract.authMode === 'oauth2-auth-code') {
    // 授权码流:落库袋里就有 access_token(OAuth 回调换来的),直接用。
    //
    // **已知限制(切片 B 明确不做,登记在此)**:access_token 过期后**不自动 refresh 轮换**
    // (refresh 引擎是后续切片)。过期表现 = 上游 401 → driver 的 UPSTREAM_AUTH_FAILED →
    // 现有 RELINK_REQUIRED 路径把连接标 error 并引导用户重绑,fail-closed 不会静默用坏 token。
    // 袋里已经存了 client_id/client_secret/refresh_token(如上游给),refresh 切片可直接接。
    return bagToResolvedCredentials('oauth2-auth-code', bag)
  }
  if (contract.authMode === 'token-exchange') {
    if (input.cache) {
      const cached = await readTokenCache(input.cache.connectionId, EXCHANGE_NODE_ID, input.cache.pool)
      if (cached && cached.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now())
        return { accessToken: cached.accessToken }
    }
    const out = await engineTokenExchange({ contract, exchangeInputs: bag, deps })
    if (input.cache) {
      const ttlSec = out.expiresInSec ?? DEFAULT_TTL_SEC
      const expiresAt = new Date(Date.now() + ttlSec * 1000)
      await writeTokenCache(
        input.cache.connectionId,
        EXCHANGE_NODE_ID,
        out.accessToken,
        expiresAt,
        input.cache.pool,
      )
    }
    return { accessToken: out.accessToken }
  }
  throw new ConnectorError('BAD_REQUEST', `authMode ${contract.authMode} not resolvable yet`)
}

/** 供 unbind 清理/测试用:删连接的 token 缓存(连接删除本身有 FK 级联)。 */
export async function clearTokenCache(connectionId: string, pool: Pool = getPool()): Promise<void> {
  await pool.query('DELETE FROM connector_token_cache WHERE connection_id = $1::bigint', [connectionId])
}
