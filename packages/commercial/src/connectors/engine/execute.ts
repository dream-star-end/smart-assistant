/**
 * 连接器平台 · 声明式执行服务(RFC §4 执行链收口)。
 *
 * executeDeclarativeAction 是"用某条已绑连接调用一个 action"的唯一入口:
 *   ① getDeclarativeConnection:id+user 取活跃连接(含四个 pin);
 *   ② loadVerifiedContractWithMeta(pin 的 version):载入即验签,4 闸 fail-closed。任何加载失败
 *      (revoke / 未审 / policy stale / hash/sig 篡改)对一条**已存在绑定**都归一为 RELINK_REQUIRED
 *      —— 该连接不再有可信 contract 可执行,用户须重绑;
 *   ③ **pin 复核**:row.exec_contract_hash 必须等于当前 contract 的 hash,否则 RELINK_REQUIRED
 *      (defense-in-depth:contract revision 漂移即拒);
 *   ④ effect 门:slice③ 只放 read;write/send → 明确拒(slice④ 接确认门 + 账本);
 *   ⑤ 解密凭据袋 → ResolvedCredentials → 引擎唯一 HTTP 出口(凭据仅 origin ∈ api 受众才注入)
 *      → 结果 allowlist 投影。凭据全程只在 master 内存活,不进容器、不出结果/错误。
 *
 * params 先按**签进 contract 的** action.params schema 校验(输入契约单一权威),再 materialize。
 */

import type { Pool } from 'pg'
import { getPool } from '../../db/index.js'
import { ConnectorError } from '../errors.js'
import { ConnectorSpecError, type ExecActionT, type ExecContractT } from '../spec/types.js'
import { loadVerifiedContractWithMeta } from '../spec/review.js'
import {
  type DeclarativeConnectionRow,
  decryptBagFromRow,
  getDeclarativeConnection,
} from './binding.js'
import { type EngineHttpDeps, engineHttpRequest } from './driver.js'
import { resolveApiCredentials } from './tokenEngine.js'

export interface ExecuteDeclarativeInput {
  connectionId: string
  userId: number
  actionId: string
  params: unknown
  deps?: EngineHttpDeps
}

/** 已存在绑定加载 contract 失败 → 一律 RELINK_REQUIRED(连接不可信,须重绑)。bind/execute/write 共用。 */
export async function loadContractForConnection(
  row: DeclarativeConnectionRow,
  pool: Pool,
): Promise<{ contract: ExecContractT; execContractHash: string }> {
  const versionId = Number(row.connector_version_id)
  if (!Number.isInteger(versionId))
    throw new ConnectorError('RELINK_REQUIRED', 'connection has no pinned version')
  try {
    const meta = await loadVerifiedContractWithMeta(versionId, pool)
    return { contract: meta.contract, execContractHash: meta.execContractHash }
  } catch (e) {
    if (e instanceof ConnectorSpecError)
      throw new ConnectorError('RELINK_REQUIRED', `pinned contract unusable: ${e.code}`)
    throw e
  }
}

/** 契约受众里唯一 API origin(单 origin 连接器;多 origin 按 action 绑定是后续切片)。 */
export function soleApiOrigin(contract: ExecContractT): string {
  const origins = contract.credentialAudiencePolicy.apiOrigins
  if (origins.length !== 1)
    throw new ConnectorError('BAD_REQUEST', 'connector requires exactly one api origin')
  return origins[0]!
}

export async function executeDeclarativeAction(
  input: ExecuteDeclarativeInput,
  pool: Pool = getPool(),
): Promise<unknown> {
  const row = await getDeclarativeConnection(input.connectionId, input.userId, pool)
  if (row === null) throw new ConnectorError('CONNECTION_NOT_FOUND', 'connection not found')

  const { contract, execContractHash } = await loadContractForConnection(row, pool)

  // ③ pin 复核:hash 漂移 → 重绑。
  const pinnedHash = row.exec_contract_hash === null ? '' : row.exec_contract_hash.toString('hex')
  if (pinnedHash !== execContractHash)
    throw new ConnectorError('RELINK_REQUIRED', 'pinned exec_contract_hash drifted')

  const action: ExecActionT | undefined = contract.actions.find((a) => a.id === input.actionId)
  if (action === undefined) throw new ConnectorError('ACTION_UNKNOWN', `unknown action ${input.actionId}`)

  // ④ effect 门:read 直执行;write/send 必须走确认门(proposeDeclarativeWrite → approve →
  //    executeDeclarativeWrite),不能从这里直接发。
  if (action.effect !== 'read')
    throw new ConnectorError(
      'BAD_REQUEST',
      `action effect ${action.effect} requires confirmation (use proposeDeclarativeWrite)`,
    )

  // params 结构轻校验:必须是普通对象(driver 的 cloneNullProto 再深拒污染键/非 JSON 值)。
  // 按签进 contract 的 action.params schema 做**类型级**入参校验属于 API 边界职责(P2 统一校验器
  // 一处收口),此处不引第二套 JSON-Schema 校验;执行安全由 driver materialize 兜底(§4)。
  const params = input.params ?? {}
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    throw new ConnectorError('VALIDATION_FAILED', 'params must be an object')

  const bag = decryptBagFromRow(row, contract)
  const resolvedCreds = await resolveApiCredentials({
    contract,
    bag,
    deps: input.deps,
    cache: { connectionId: row.id, pool },
  })
  const targetOrigin = soleApiOrigin(contract)

  return engineHttpRequest({
    contract,
    action,
    credentialAudience: 'api',
    targetOrigin,
    resolvedCreds,
    params,
    deps: input.deps,
  })
}
