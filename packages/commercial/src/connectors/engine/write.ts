/**
 * 连接器平台 · 声明式写门(RFC §8b slice④:propose → approve → ledger-pinned execute)。
 *
 * write/send effect 的 action **不能**从 executeDeclarativeAction 直接发,必须走三步确认门:
 *   ① proposeDeclarativeWrite:载入即验签 pin 的 contract → 校验 effect∈{write,send} → 由
 *      **确定性** buildRequestPlan 导出脱敏 plan-diff 作确认卡 → proposeWrite 落账本(加密 params +
 *      pin connection_id/connection_revision);
 *   ② approveConfirmation(账本 CAS pending→approved,复用 v1,不在本模块);
 *   ③ executeDeclarativeWrite:beginExecute(CAS approved→executing + 幂等/replay/过期/连接代数复核,
 *      **权威源=账本行的 action**,不信调用方)→ 按账本 action 从 pin 的 contract 取 ExecAction →
 *      引擎唯一 HTTP 出口发送 → finalizeExecute(销毁 params;maybeDelivered→unknown 不盲重试)。
 *
 * **plan-diff 单 dispatch 不变量**:确认卡展示的 plan 与真正 dispatch 的 plan 逐字节一致。因为二者
 * 都由(连接 pin 的**不可变** contract 版本 + 账本里 hash 复核过的同一份 params)确定性导出 —— 版本
 * bytes 变即新版本,老连接 pin 不动;版本被 revoke 则载入失败 → RELINK_REQUIRED。故无需在账本另存 plan。
 */

import type { Pool } from 'pg'
import { getPool } from '../../db/index.js'
import { ConnectorError } from '../errors.js'
import {
  beginExecute,
  finalizeExecute,
  type LedgerStatus,
  proposeWrite,
  writeFinalizeStatus,
} from '../ledger.js'
import { canonicalSha256Hex } from '../spec/canonical.js'
import type { ExecActionT } from '../spec/types.js'
import { getDeclarativeConnection, decryptBagFromRow } from './binding.js'
import { bagToResolvedCredentials } from './credentialBag.js'
import { type EngineHttpDeps, engineHttpRequest } from './driver.js'
import { loadContractForConnection, soleApiOrigin } from './execute.js'
import { type RedactedRequestPlan, buildRequestPlan, redactedPlan } from './requestPlan.js'

function asObjectParams(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    throw new ConnectorError('VALIDATION_FAILED', 'params must be an object')
  return params as Record<string, unknown>
}

export interface ProposeDeclarativeWriteInput {
  connectionId: string
  userId: number
  actionId: string
  params: unknown
}

export interface ProposedDeclarativeWrite {
  confirmId: string
  summary: string
  expiresAt: Date
  effect: 'write' | 'send'
  /** 脱敏 plan-diff(无凭据):确认卡展示,与真正 dispatch 逐字节同源。 */
  plan: RedactedRequestPlan
}

export async function proposeDeclarativeWrite(
  input: ProposeDeclarativeWriteInput,
  pool: Pool = getPool(),
): Promise<ProposedDeclarativeWrite> {
  const row = await getDeclarativeConnection(input.connectionId, input.userId, pool)
  if (row === null) throw new ConnectorError('CONNECTION_NOT_FOUND', 'connection not found')

  const { contract, execContractHash } = await loadContractForConnection(row, pool)
  const pinnedHash = row.exec_contract_hash === null ? '' : row.exec_contract_hash.toString('hex')
  if (pinnedHash !== execContractHash)
    throw new ConnectorError('RELINK_REQUIRED', 'pinned exec_contract_hash drifted')

  const action: ExecActionT | undefined = contract.actions.find((a) => a.id === input.actionId)
  if (action === undefined)
    throw new ConnectorError('ACTION_UNKNOWN', `unknown action ${input.actionId}`)
  if (action.effect === 'read')
    throw new ConnectorError(
      'BAD_REQUEST',
      'read action needs no confirmation (use executeDeclarativeAction)',
    )

  const params = asObjectParams(input.params)
  // 确定性导出 plan(同时对 params 做 materialize 期安全校验:CRLF/污染/占位符解析)。
  const plan = buildRequestPlan(action, params, soleApiOrigin(contract))
  const redacted = redactedPlan(plan)
  const query = redacted.query.map(([k]) => k).join(',')
  const summary =
    `${action.effect.toUpperCase()} ${action.id}: ${redacted.method} ${redacted.origin}${redacted.path}` +
    (query ? `?${query}` : '') +
    (redacted.hasBody ? ` (+body ${redacted.bodyBytes}B)` : '')

  const proposed = await proposeWrite(
    {
      userId: input.userId,
      connectionId: row.id,
      connectionRevision: row.revision,
      provider: row.provider,
      action: action.id,
      params,
      summary,
    },
    pool,
  )
  return {
    confirmId: proposed.id,
    summary: proposed.summary,
    expiresAt: proposed.expiresAt,
    effect: action.effect,
    plan: redacted,
  }
}

export interface ExecuteDeclarativeWriteInput {
  connectionId: string
  userId: number
  confirmId: string
  deps?: EngineHttpDeps
}

export type ExecuteDeclarativeWriteResult =
  | { kind: 'ok'; result: unknown }
  | { kind: 'in_progress' }
  | {
      kind: 'replay'
      status: LedgerStatus
      errorCode: string | null
      resultDigest: string | null
    }

export async function executeDeclarativeWrite(
  input: ExecuteDeclarativeWriteInput,
  pool: Pool = getPool(),
): Promise<ExecuteDeclarativeWriteResult> {
  const row = await getDeclarativeConnection(input.connectionId, input.userId, pool)
  if (row === null) throw new ConnectorError('CONNECTION_NOT_FOUND', 'connection not found')

  // 载入 pin 的 contract(revoke/篡改 → RELINK_REQUIRED,账本仍留 approved 自然过期)。
  const { contract } = await loadContractForConnection(row, pool)

  // 账本状态机:CAS approved→executing + 幂等/replay/过期/连接代数复核。权威源=账本行。
  const begin = await beginExecute(
    { id: input.confirmId, userId: input.userId, connectionId: row.id, expectedProvider: row.provider },
    pool,
  )
  if (begin.kind === 'in_progress') return { kind: 'in_progress' }
  if (begin.kind === 'replay')
    return {
      kind: 'replay',
      status: begin.status,
      errorCode: begin.errorCode,
      resultDigest: begin.resultDigest,
    }

  // kind === 'ok':按**账本行的 action**(不信调用方)从 pin 的 contract 取 ExecAction。
  const action: ExecActionT | undefined = contract.actions.find((a) => a.id === begin.row.action)
  if (action === undefined || action.effect === 'read') {
    await finalizeExecute({ id: input.confirmId, status: 'failed', errorCode: 'ACTION_UNKNOWN' }, pool)
    throw new ConnectorError('ACTION_UNKNOWN', 'ledger action not a write action in pinned contract')
  }

  const bag = decryptBagFromRow(row, contract.authMode)
  const resolvedCreds = bagToResolvedCredentials(contract.authMode, bag)
  const targetOrigin = soleApiOrigin(contract)

  try {
    const result = await engineHttpRequest({
      contract,
      action,
      credentialAudience: 'api',
      targetOrigin,
      resolvedCreds,
      params: begin.params,
      deps: input.deps,
    })
    await finalizeExecute(
      { id: input.confirmId, status: 'succeeded', resultDigest: canonicalSha256Hex(result ?? null) },
      pool,
    )
    return { kind: 'ok', result }
  } catch (e) {
    // maybeDelivered(5xx / 建连后断)→ unknown(绝不盲重试);其余 → failed。
    const status = writeFinalizeStatus(e)
    const code = e instanceof ConnectorError ? e.code : 'INTERNAL'
    await finalizeExecute({ id: input.confirmId, status, errorCode: code }, pool)
    throw e
  }
}
