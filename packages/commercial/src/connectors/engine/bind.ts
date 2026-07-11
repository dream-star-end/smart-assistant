/**
 * 连接器平台 · 声明式 bind 服务(RFC §bind:install→bind→identityProbe→加密落库)。
 *
 * bindDeclarativeConnector 是"用户提供凭据 → 验证有效 → 派生账号身份 → 落 pin 连接"的收口:
 *   ① loadVerifiedContractWithMeta:载入即验签的 contract + DB 事实(slug/hash/version),4 闸 fail-closed;
 *   ② 凭据袋按 authMode 需要的 source 严格校验;
 *   ③ **identityProbe**:执行 contract.identity.probeActionId 这个 read action(经引擎唯一 HTTP 出口,
 *      凭据只在 origin ∈ api 受众时注入)。既验证 token 有效(401→UPSTREAM_AUTH_FAILED),又从
 *      **allowlist 投影后的**结果里按 accountKeyPointer 取稳定账号标识;
 *   ④ computeAccountKey(slug:accountId) → insertDeclarativeConnection(带四个 pin)。
 *
 * 账号身份是**签进 contract 的作者声明**(identity 块),bind 服务不接受任何运行时未签配置 →
 * 单一权威。slice③ 仅 static-token;其它 authMode 的 bind 流程后续切片接。
 */

import type { Pool } from 'pg'
import { getPool } from '../../db/index.js'
import { ConnectorError } from '../errors.js'
import type { ConnectorIdentityT, ExecActionT } from '../spec/types.js'
import { loadVerifiedContractWithMeta } from '../spec/review.js'
import { computeAccountKey } from '../store.js'
import { insertDeclarativeConnection } from './binding.js'
import { requiredBindSources, validateSecretBag } from './credentialBag.js'
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

export interface BindDeclarativeInput {
  userId: number
  connectorVersionId: number
  /**
   * 用户直填的凭据(键 = 该 contract 需要的 source 名)。static-token: {access_token};
   * token-exchange: 交换输入(如 {client_id, client_secret} / {refresh_token})。
   */
  secrets: Record<string, string>
  displayName?: string
  deps?: EngineHttpDeps
}

export interface BindDeclarativeResult {
  connectionId: string
  rebound: boolean
  accountHint?: string
}

export async function bindDeclarativeConnector(
  input: BindDeclarativeInput,
  pool: Pool = getPool(),
): Promise<BindDeclarativeResult> {
  const meta = await loadVerifiedContractWithMeta(input.connectorVersionId, pool)
  const contract = meta.contract

  const identity: ConnectorIdentityT | undefined = contract.identity
  if (identity === undefined)
    throw new ConnectorError('BAD_REQUEST', 'connector declares no identity probe')

  // ② 凭据袋:按 contract 需要的 source 严格校验(static-token 单 access_token;token-exchange 交换输入)。
  const sources = requiredBindSources(contract)
  const bag = input.secrets
  validateSecretBag(bag, sources)
  // 解析出可注入 API 的凭据:static-token 直接用;token-exchange 换一次(bind 无 connectionId → 不落缓存)。
  const resolvedCreds = await resolveApiCredentials({ contract, bag, deps: input.deps })

  // ③ identityProbe:跑 probe read action(编译期已保证存在且 read)。
  const probe: ExecActionT | undefined = contract.actions.find((a) => a.id === identity.probeActionId)
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

  const { id, rebound } = await insertDeclarativeConnection(
    {
      userId: input.userId,
      slug: meta.slug,
      connectorVersionId: meta.versionId,
      specHashHex: contract.spec_hash,
      execContractHashHex: meta.execContractHash,
      authContractVersion: meta.authContractVersion,
      accountKey,
      bag,
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
