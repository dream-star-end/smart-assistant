/**
 * 连接器平台 · 声明式 bind 服务(RFC §bind:install→bind→identityProbe→加密落库)。
 *
 * 两个入口,共用**同一个绑定核心**:
 *   - `bindDeclarativeConnector`(直填路径):用户在表单里把凭据填全(static-token 的 token /
 *     token-exchange 的交换输入)→ 校验袋形状 → bindWithBag。
 *     **oauth2-auth-code 在这里被硬拒**:它的 access_token 只能由授权码流程产出(handlers 的
 *     `/oauth/callback` 声明式分支),放开直填等于允许伪造/绕过 state+PKCE 校验。
 *   - `bindWithBag`(绑定核心,OAuth 回调也调它):**identity 探针 + 落库的单一权威**。
 *
 * bindWithBag 做四件事:
 *   ① storedBagSources 复校验袋形状(即将落库的袋 == 执行期解密时期待的袋,一处对齐);
 *   ② resolveApiCredentials(static-token 直用 / token-exchange 换一次 / oauth2 用袋里的 access_token);
 *   ③ **identityProbe**:执行 contract.identity.probeActionId 这个 read action(经引擎唯一 HTTP 出口,
 *      凭据只在 origin ∈ api 受众时注入)。既验证 token 有效(401→UPSTREAM_AUTH_FAILED),又从
 *      **allowlist 投影后的**结果里按 accountKeyPointer 取稳定账号标识;
 *   ④ computeAccountKey(slug:accountId) → insertDeclarativeConnection(带四个 pin)。
 *
 * 账号身份是**签进 contract 的作者声明**(identity 块),bind 服务不接受任何运行时未签配置 →
 * 单一权威。
 */

import type { Pool } from 'pg'
import { getPool } from '../../db/index.js'
import { ConnectorError } from '../errors.js'
import type { VerifiedContract } from '../spec/review.js'
import { loadVerifiedContractWithMeta } from '../spec/review.js'
import type { ConnectorIdentityT, ExecActionT } from '../spec/types.js'
import { computeAccountKey } from '../store.js'
import { META_TOKEN_EXPIRES_AT, insertDeclarativeConnection } from './binding.js'
import {
  type DeclarativeSecretBag,
  requiredBindSources,
  storedBagSources,
  validateSecretBag,
} from './credentialBag.js'
import { type EngineHttpDeps, engineHttpRequest } from './driver.js'
import { soleApiOrigin } from './execute.js'
import { resolveResultPointer } from './pointer.js'
import { resolveApiCredentials } from './tokenEngine.js'

/** pointer 取到的账号标识必须是非空标量(string/number)。 */
function pointerScalar(root: unknown, pointer: string, what: string): string {
  const v = resolveResultPointer(root, pointer)
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  throw new ConnectorError('UPSTREAM_ERROR', `identity ${what} missing in probe result`)
}

export interface BindDeclarativeResult {
  connectionId: string
  rebound: boolean
  accountHint?: string
}

export interface BindWithBagInput {
  userId: number
  /**
   * 已验签契约 + DB 事实(slug/versionId/hash)。**契约唯一权威 = meta.contract**
   * (不额外收一个 contract 参数,杜绝"meta 与 contract 不配对"的调用错误)。
   */
  meta: VerifiedContract
  /** **落库形状**的凭据袋(oauth2 回调路径已把换回的 access_token/refresh_token 并进来)。 */
  bag: DeclarativeSecretBag
  /**
   * access_token 的过期时刻(oauth2 回调把上游 expires_in 换算后传进来)。落进连接 `meta`
   * (**非机密,不进加密袋** —— 见 binding.META_TOKEN_EXPIRES_AT),执行期据此判断要不要 refresh 轮换。
   *
   * **不传 = 该 token 永不过期**(GitHub 这类不发 expires_in 的 provider):执行期永远不会去 refresh。
   * 所以只有上游**明确给了** expires_in 才该传 —— 别为了"保险"编一个过期时间出来。
   */
  tokenExpiresAt?: Date
  displayName?: string
  deps?: EngineHttpDeps
}

/**
 * 绑定核心:凭据袋 → identity 探针 → 落 pin 连接。直填路径与 OAuth 回调路径共用(单一权威)。
 */
export async function bindWithBag(
  input: BindWithBagInput,
  pool: Pool = getPool(),
): Promise<BindDeclarativeResult> {
  const { meta } = input
  const contract = meta.contract

  const identity: ConnectorIdentityT | undefined = contract.identity
  if (identity === undefined)
    throw new ConnectorError('BAD_REQUEST', 'connector declares no identity probe')

  // ① 即将落库的袋必须恰是执行期期待的形状(执行期 decryptBagFromRow 用同一权威复校验)。
  const stored = storedBagSources(contract)
  validateSecretBag(input.bag, stored.required, stored.optional)

  // ② 解析出可注入 API 的凭据(client_secret/refresh_token 结构上进不了 ResolvedCredentials)。
  //    bind 无 connectionId → token-exchange 换一次仅供探针,不落缓存。
  const resolvedCreds = await resolveApiCredentials({ contract, bag: input.bag, deps: input.deps })

  // ③ identityProbe:跑 probe read action(编译期已保证存在且 read)。
  const probe: ExecActionT | undefined = contract.actions.find(
    (a) => a.id === identity.probeActionId,
  )
  if (probe === undefined)
    throw new ConnectorError('INTERNAL', 'identity probe action missing from contract')
  const targetOrigin = soleApiOrigin(contract)
  const probeResult = await engineHttpRequest({
    contract,
    action: probe,
    credentialAudience: 'api',
    targetOrigin,
    resolvedCreds,
    params: {},
    deps: input.deps,
  })

  // ④ 从 allowlist 投影后的结果派生账号身份 → account_key(命名空间加 slug 防跨 connector 撞)。
  const accountId = pointerScalar(probeResult, identity.accountKeyPointer, 'accountKey')
  const accountKey = computeAccountKey(`${meta.slug}:${accountId}`)
  const rowMeta: Record<string, unknown> = {}
  if (identity.accountHintPointer !== undefined) {
    const hintRaw = resolveResultPointer(probeResult, identity.accountHintPointer)
    if (typeof hintRaw === 'string' && hintRaw.length > 0)
      rowMeta.account_hint = hintRaw.slice(0, 120)
  }
  // token 过期时刻走**这一条 meta 通路**(与 account_hint 同处),不在 SQL 里散写。
  if (input.tokenExpiresAt !== undefined)
    rowMeta[META_TOKEN_EXPIRES_AT] = input.tokenExpiresAt.toISOString()

  const { id, rebound } = await insertDeclarativeConnection(
    {
      userId: input.userId,
      slug: meta.slug,
      connectorVersionId: meta.versionId,
      specHashHex: contract.spec_hash,
      execContractHashHex: meta.execContractHash,
      authContractVersion: meta.authContractVersion,
      accountKey,
      bag: input.bag,
      displayName: input.displayName,
      meta: rowMeta,
    },
    pool,
  )
  return {
    connectionId: id,
    rebound,
    ...(typeof rowMeta.account_hint === 'string' ? { accountHint: rowMeta.account_hint } : {}),
  }
}

export interface BindDeclarativeInput {
  userId: number
  connectorVersionId: number
  /**
   * 用户直填的凭据(键 = requiredBindSources)。static-token: {access_token};
   * token-exchange: 交换输入(如 {client_id, client_secret} / {refresh_token})。
   * oauth2-auth-code **不走本路径**(见下)。
   */
  secrets: Record<string, string>
  displayName?: string
  deps?: EngineHttpDeps
}

/**
 * 直填绑定(表单/RPC)。**oauth2-auth-code 硬拒**:其 access_token 必须来自服务端持有的
 * 授权码流程(state + cookie nonce + PKCE 四因子),允许直填就等于把这些校验全绕开。
 */
export async function bindDeclarativeConnector(
  input: BindDeclarativeInput,
  pool: Pool = getPool(),
): Promise<BindDeclarativeResult> {
  const meta = await loadVerifiedContractWithMeta(input.connectorVersionId, pool)
  const contract = meta.contract

  if (contract.authMode === 'oauth2-auth-code')
    throw new ConnectorError('BAD_REQUEST', 'oauth2 connector must bind via oauth flow')

  // 直填路径:袋 == 用户必须填的 source(不多不少);此模式下它恰等于落库形状。
  validateSecretBag(input.secrets, requiredBindSources(contract))
  return bindWithBag(
    {
      userId: input.userId,
      meta,
      bag: input.secrets,
      displayName: input.displayName,
      deps: input.deps,
    },
    pool,
  )
}
