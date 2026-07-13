/**
 * 连接器平台 · token 引擎(RFC §3.4/§5:凭据解析收口)。
 *
 * `resolveApiCredentials` 是"从连接凭据袋得到可注入 API 的 ResolvedCredentials"的单一入口:
 *   - static-token:袋里就是 access_token,直接用;
 *   - oauth2-auth-code:袋里的 access_token **可能已过期** → 按连接 meta.token_expires_at 判定,
 *     过期就用袋里的 refresh_token 自动续期(见下方 refreshOauth2Locked),否则直接用;
 *   - token-exchange:先查**加密 token 缓存**(cache key=(connection_id, 'exchange') 引擎派生);命中且
 *     未近过期(带 skew)→ 用缓存 access_token;否则用袋里的交换凭据经 engineTokenExchange 换新 token
 *     → 加密写回缓存 → 返回。凭据(交换输入 + 换回的 access_token)全程只在 master 内存活、加密落缓存。
 *
 * bind 阶段(尚无连接行)传 connection=undefined:token-exchange 换一次仅供 identity probe,不落缓存;
 * oauth2 此刻袋里就是刚换回的新 token,**结构上不可能过期**,无须(也无法)续期。
 */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { decryptToBuffer, encrypt } from '../../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../../crypto/keys.js'
import { getPool } from '../../db/index.js'
import { tx } from '../../db/queries.js'
import { ConnectorError } from '../errors.js'
import { getPlatformOauthApp } from '../platformOauthApps.js'
import type { ExecContractT } from '../spec/types.js'
import {
  type DeclarativeConnectionRow,
  decryptBagFromRow,
  lockDeclarativeConnectionForUpdate,
  readTokenExpiresAt,
  updateDeclarativeConnectionSecret,
} from './binding.js'
import {
  type DeclarativeSecretBag,
  bagToResolvedCredentials,
  oauth2ClientProvisioning,
  storedBagSources,
  validateSecretBag,
} from './credentialBag.js'
import type { EngineHttpDeps } from './driver.js'
import { refreshOauth2Token } from './oauth2.js'
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
  /**
   * 连接上下文。有值(execute/write 路径)→ token-exchange 可读写缓存、oauth2 可自动续期;
   * 无值(bind 探针路径)→ 两者都不做(尚无连接行可锁/可写)。
   */
  connection?: { row: DeclarativeConnectionRow; pool: Pool }
}

/** 是否已过期/将过期(带 skew)。**无 expiry = 永不过期**(GitHub 情形,绝不主动去 refresh)。 */
function isTokenExpiring(expiresAt: Date | null): boolean {
  if (expiresAt === null) return false
  return expiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now()
}

export async function resolveApiCredentials(
  input: ResolveApiCredentialsInput,
): Promise<ResolvedCredentials> {
  const { contract, bag, deps } = input
  if (contract.authMode === 'static-token') {
    return bagToResolvedCredentials('static-token', bag)
  }
  if (contract.authMode === 'oauth2-auth-code') {
    const conn = input.connection
    // bind 探针路径:袋里就是 OAuth 回调刚换回的 token,不可能过期 → 直接用。
    if (conn === undefined) return bagToResolvedCredentials('oauth2-auth-code', bag)

    // ① 未过期(含"无 expiry = 永不过期")→ 零额外开销,直接用袋里的 access_token。
    if (!isTokenExpiring(readTokenExpiresAt(conn.row.meta)))
      return bagToResolvedCredentials('oauth2-auth-code', bag)

    // ② 已过期但**袋里没有 refresh_token** → 无从续期。**不在这里报错**:expiry 只是上游给的
    //    估计值(时钟漂移 / provider 提前发放),token 很可能其实还能用。照常去打 API:真过期了
    //    上游会回 401 → driver 的既有 UPSTREAM_AUTH_FAILED / RELINK_REQUIRED 路径接管。
    //    在这里抢先报错 = 把一个"也许还能用"的连接直接判死,是纯粹的体验倒退。
    if (typeof bag.refresh_token !== 'string' || bag.refresh_token.length === 0)
      return bagToResolvedCredentials('oauth2-auth-code', bag)

    // ③ 有 refresh_token → 进临界区自动续期。
    return refreshOauth2Locked(contract, conn.row, conn.pool, deps)
  }
  if (contract.authMode === 'token-exchange') {
    const conn = input.connection
    if (conn) {
      const cached = await readTokenCache(conn.row.id, EXCHANGE_NODE_ID, conn.pool)
      if (cached && cached.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now())
        return { accessToken: cached.accessToken }
    }
    const out = await engineTokenExchange({ contract, exchangeInputs: bag, deps })
    if (conn) {
      const ttlSec = out.expiresInSec ?? DEFAULT_TTL_SEC
      const expiresAt = new Date(Date.now() + ttlSec * 1000)
      await writeTokenCache(conn.row.id, EXCHANGE_NODE_ID, out.accessToken, expiresAt, conn.pool)
    }
    return { accessToken: out.accessToken }
  }
  throw new ConnectorError('BAD_REQUEST', `authMode ${contract.authMode} not resolvable yet`)
}

/**
 * oauth2 access_token 续期的**临界区**(并发正确性的全部所在)。
 *
 * ```
 * BEGIN
 *   SELECT … FOR UPDATE            ← 行锁:同一连接的并发请求在此排队
 *   重新解密袋 + 重读 meta.token_expires_at
 *   仍过期?                        ← 锁内重查:别的请求可能已经续好了 → 直接用它续的,不重复 refresh
 *     └ 是 → refreshOauth2Token(网络调用,**在锁内**)
 *            → 写新袋 + 新 token_expires_at
 * COMMIT
 * ```
 *
 * **为什么网络调用也在锁内**(刻意的权衡,别"优化"掉):
 *   轮换型 provider(refreshRotation)用掉一个 refresh_token 就把它作废并下发新的。若把 refresh 挪到
 *   锁外,两个并发请求会**拿同一个旧 refresh_token 各打一次上游** —— 先到的那个让 token 轮换,后到的
 *   那个手里的 refresh_token 已经失效 → 上游 4xx → RELINK_REQUIRED → **用户被无辜踢去重新授权**。
 *   代价是持锁期间跨了一次 HTTP(有 pinnedHttpsFetch 的超时上界,量级几百毫秒),且只阻塞**同一条连接**
 *   的并发请求(行锁,不同连接/不同用户互不影响)。正确性 > 这点排队延迟。
 *
 * **失败即回滚**:refreshOauth2Token 抛错(RELINK_REQUIRED 等)→ 事务 ROLLBACK → 袋原封不动
 * (绝不会写进一个半吊子/坏掉的袋),错误照原样抛给调用方。
 */
async function refreshOauth2Locked(
  contract: ExecContractT,
  row: DeclarativeConnectionRow,
  pool: Pool,
  deps: EngineHttpDeps | undefined,
): Promise<ResolvedCredentials> {
  return tx(async (c: PoolClient) => {
    const fresh = await lockDeclarativeConnectionForUpdate(row.id, row.user_id, c)
    // 排队期间连接被撤销/停用 → fail-closed(绝不拿旧袋继续)。
    if (fresh === null) throw new ConnectorError('CONNECTION_REVOKED', 'connection revoked')

    // 锁内重新解密 + 重读 expiry:**权威是锁内的这一份**(锁外那份可能已被别的请求换掉)。
    const freshBag = decryptBagFromRow(fresh, contract)
    if (!isTokenExpiring(readTokenExpiresAt(fresh.meta)))
      // 别的并发请求已经续好了 → 直接用新的,不重复 refresh(这正是"只 refresh 一次"的保证)。
      return bagToResolvedCredentials('oauth2-auth-code', freshBag)

    const refreshToken = freshBag.refresh_token
    // 锁内复查 refresh_token(理论上不可能没有 —— 锁外已查过 —— 但锁内的袋才是权威)。
    if (typeof refreshToken !== 'string' || refreshToken.length === 0)
      return bagToResolvedCredentials('oauth2-auth-code', freshBag)

    // client 凭据按供给模式取。权威 = 契约的 clientProvisioning(不看袋里"碰巧有什么")。
    let clientId: string
    let clientSecret: string
    if (oauth2ClientProvisioning(contract) === 'platform') {
      // platform:client 凭据只活在平台表(绝不复制进用户袋)。admin 反 provision 了 → fail-closed。
      const app = await getPlatformOauthApp(fresh.provider, c)
      if (app === null)
        throw new ConnectorError('OAUTH_NOT_CONFIGURED', 'platform oauth app not provisioned')
      clientId = app.clientId
      clientSecret = app.clientSecret
    } else {
      // byoa:client 凭据在袋里(storedBagSources 保证 required,解密时已校验过)。
      const cid = freshBag.client_id
      const cs = freshBag.client_secret
      if (typeof cid !== 'string' || typeof cs !== 'string')
        throw new ConnectorError('RELINK_REQUIRED', 'byoa bag missing client credentials')
      clientId = cid
      clientSecret = cs
    }

    // 网络调用(**在锁内**,见上方权衡说明)。上游 4xx → RELINK_REQUIRED,tx 自动 ROLLBACK。
    const out = await refreshOauth2Token({ contract, refreshToken, clientId, clientSecret, deps })

    // **refresh_token 轮换语义**:上游给了新的 → 旧的此刻已失效,必须换成新的(否则下次续期必挂);
    // 没给 → 旧的仍有效,原样留着(契约的 refreshRotation 是作者对 provider 行为的**声明**,
    // 但真正的权威是上游这次响应到底给没给 —— 引擎以实际响应为准,两种 provider 都吃得下)。
    const newBag: DeclarativeSecretBag = {
      ...freshBag,
      access_token: out.accessToken,
      refresh_token: out.refreshToken ?? refreshToken,
    }
    // **写袋前必须复校验**(新 token 来自上游 JSON,是不可信输入):形状 == storedBagSources、
    // 值有界非空、无 CRLF/控制符。不校验的后果不是"多一层保险"而是实打实的坏账:
    //   · 含控制符的 token 落袋 → 每次注入都被 placement 硬拒 → 连接实质死掉;
    //   · 形状漂了 → 下次 decryptBagFromRow 复校验直接抛 → 连接再也解不开。
    // 在这里挡下 = 事务回滚 = **袋保持旧的可用状态**,远好过写进一个坏袋。
    const stored = storedBagSources(contract)
    validateSecretBag(newBag, stored.required, stored.optional)

    // 上游没给 expires_in → 用保守 TTL 兜底(与 token-exchange 缓存同一常量)。**必须写**:
    // 不写的话 meta 里还是那个旧的过期时刻 → 下一个请求又判定"已过期"→ 每次调用都 refresh 一遍。
    const ttlSec = out.expiresInSec ?? DEFAULT_TTL_SEC
    await updateDeclarativeConnectionSecret(
      {
        connectionId: fresh.id,
        userId: fresh.user_id,
        bag: newBag,
        tokenExpiresAt: new Date(Date.now() + ttlSec * 1000),
      },
      c,
    )
    return bagToResolvedCredentials('oauth2-auth-code', newBag)
  }, pool)
}

/** 供 unbind 清理/测试用:删连接的 token 缓存(连接删除本身有 FK 级联)。 */
export async function clearTokenCache(connectionId: string, pool: Pool = getPool()): Promise<void> {
  await pool.query('DELETE FROM connector_token_cache WHERE connection_id = $1::bigint', [connectionId])
}
