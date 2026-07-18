/**
 * ledger — connector_write_ledger 状态机(确认门 + 幂等账本 + 写审计,设计终稿 §3)。
 *
 * 状态:pending → approved → executing → succeeded|failed|unknown
 *              ↘ denied            (sweeper) ↘ unknown
 *      pending|approved 过期 → expired
 *
 * 不变量:
 *   - params 加密落库,**AAD = `cwl:{id}:{user_id}:{connection_id}:{params_aad_seed}`**(公式三)。
 *   - canonical v1(键排序 stringify)→ sha256 = params_hash;解密后必复核 hash。
 *   - approve:CAS pending→approved + **expires_at 重设 now()+10min**(执行窗口,
 *     批准非无限期授权)。
 *   - execute:CAS approved→executing 含 expires_at>now();同事务复核
 *     connection_revision 一致且 connection active(换绑/失效/过期一律拒绝,
 *     且直接终态 failed —— 该确认永无可能成功)。
 *   - 执行只用账本解密参数,不接受模型重新提交的 params。
 *   - 同 id 并发/重复:executing → IN_PROGRESS;终态 → replay{status,error_code,result_digest}。
 *   - 终态 CAS 一律销毁 params_enc/params_nonce(cwl_params_shape CHECK 双向强制)。
 *   - 限额:每用户非终态总量 ≤ 10(NON_TERMINAL_LIMIT)。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'
import { getPool } from '../db/index.js'
import { tx } from '../db/queries.js'
import { CANONICALIZATION_VERSION, canonicalHash, canonicalStringify } from './canonicalJson.js'
import { ConnectorError } from './errors.js'

export const WRITE_CONFIRM_TTL_MS = 10 * 60 * 1000 // propose → 确认窗口
export const EXECUTE_WINDOW_MS = 10 * 60 * 1000 // approve → 执行窗口
export const NON_TERMINAL_LIMIT = 10

export type LedgerStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'expired'
  | 'denied'

export const TERMINAL_STATUSES: readonly LedgerStatus[] = [
  'succeeded',
  'failed',
  'unknown',
  'expired',
  'denied',
]

export function isTerminalStatus(s: LedgerStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s)
}

/** AAD 公式三:`cwl:{id}:{user_id}:{connection_id}:{params_aad_seed}`。 */
export function ledgerParamsAad(
  id: string,
  userId: number,
  connectionId: string,
  paramsAadSeed: string,
): Buffer {
  return Buffer.from(`cwl:${id}:${userId}:${connectionId}:${paramsAadSeed}`, 'utf8')
}

export interface LedgerRow {
  id: string
  user_id: number
  connection_id: string
  connection_revision: number
  provider: string
  action: string
  connector_version_id: string | null
  spec_hash: Buffer | null
  exec_contract_hash: Buffer | null
  auth_contract_version: number | null
  params_enc: Buffer | null
  params_nonce: Buffer | null
  params_key_version: number
  params_aad_seed: string
  params_hash: Buffer
  canonicalization_version: number
  summary: string
  approval_source: 'user_confirmation' | 'account_preapproval'
  approval_policy_version: number | null
  idempotency_key: string
  status: LedgerStatus
  error_code: string | null
  result_digest: string | null
  created_at: Date
  approved_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  expires_at: Date
  dispatch_fence_required: boolean
  dispatch_armed_at: Date | null
}

const ROW_COLS = `id::text AS id, user_id::int AS user_id, connection_id::text AS connection_id,
  connection_revision, provider, action, connector_version_id::text AS connector_version_id,
  spec_hash, exec_contract_hash, auth_contract_version, params_enc, params_nonce, params_key_version,
  params_aad_seed::text AS params_aad_seed, params_hash, canonicalization_version, summary,
  approval_source, approval_policy_version, idempotency_key, status, error_code, result_digest,
  created_at, approved_at, started_at, finished_at, expires_at, dispatch_fence_required,
  dispatch_armed_at`

// ─── 纯逻辑:执行入口分类(单测友好,beginExecute 复用) ─────────────────────

export type ExecuteClassification =
  | { kind: 'ok' }
  | { kind: 'in_progress' }
  | { kind: 'replay'; status: LedgerStatus; errorCode: string | null; resultDigest: string | null }
  | { kind: 'not_approved' }
  | { kind: 'expired' }

/** 只看账本行自身(connection 复核在 beginExecute 事务里另做)。 */
export function classifyForExecute(
  row: Pick<LedgerRow, 'status' | 'expires_at' | 'error_code' | 'result_digest'>,
  now: number = Date.now(),
): ExecuteClassification {
  if (row.status === 'executing') return { kind: 'in_progress' }
  if (isTerminalStatus(row.status)) {
    return {
      kind: 'replay',
      status: row.status,
      errorCode: row.error_code,
      resultDigest: row.result_digest,
    }
  }
  if (row.status === 'pending') return { kind: 'not_approved' }
  // approved
  if (row.expires_at.getTime() <= now) return { kind: 'expired' }
  return { kind: 'ok' }
}

// ─── propose ─────────────────────────────────────────────────────────────

export interface ProposeWriteInput {
  userId: number
  connectionId: string
  connectionRevision: number
  provider: string
  action: string
  params: Record<string, unknown>
  summary: string
  contractPins?: {
    connectorVersionId: number
    specHashHex: string
    execContractHashHex: string
    authContractVersion: number
  }
  /** Plugin-only: stale executing before dispatch_armed_at is a proven pre-dispatch failure. */
  dispatchFenceRequired?: boolean
  /** Default is an interactive confirmation. Account preapproval starts directly at approved. */
  approval?:
    | { source: 'user_confirmation' }
    | { source: 'account_preapproval'; policyVersion: number }
}

export interface ProposedWrite {
  id: string
  summary: string
  expiresAt: Date
}

export async function proposeWrite(
  input: ProposeWriteInput,
  pool: Pool = getPool(),
): Promise<ProposedWrite> {
  const approval = input.approval ?? { source: 'user_confirmation' as const }
  const approvalPolicyVersion =
    approval.source === 'account_preapproval' ? approval.policyVersion : null
  if (
    approval.source === 'account_preapproval' &&
    (!Number.isInteger(approvalPolicyVersion) || Number(approvalPolicyVersion) <= 0)
  )
    throw new ConnectorError('BAD_REQUEST', 'account preapproval policy version is invalid')
  const id = randomUUID()
  const paramsAadSeed = randomUUID()
  const canonical = canonicalStringify(input.params)
  const hash = canonicalHash(input.params)
  const idempotencyKey = randomBytes(16).toString('hex') // 32 chars ∈ [16,64]

  const key = loadKmsKey()
  const plaintext = Buffer.from(canonical, 'utf8')
  let enc: ReturnType<typeof encrypt>
  try {
    enc = encrypt(
      plaintext,
      key,
      ledgerParamsAad(id, input.userId, input.connectionId, paramsAadSeed),
    )
  } finally {
    zeroBuffer(plaintext)
    zeroBuffer(key)
  }

  // 限额:非终态总量 ≤ 10。P1#6:count+insert 必须原子 —— 用 per-user 事务级 advisory
  // lock(pg_advisory_xact_lock,随 COMMIT/ROLLBACK 自动释放)串行化,消除 TOCTOU
  // (并发 propose 曾可同时通过 count 检查各插一行 → 超限)。
  const expiresAt = await tx<Date>(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `cwl-nonterm:${input.userId}`,
    ])
    const cnt = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connector_write_ledger
        WHERE user_id = $1 AND status IN ('pending','approved','executing')`,
      [input.userId],
    )
    if (Number(cnt.rows[0]?.n ?? '0') >= NON_TERMINAL_LIMIT) {
      throw new ConnectorError('QUOTA_EXCEEDED', 'too many outstanding write confirmations')
    }
    const r = await client.query<{ expires_at: Date }>(
      `INSERT INTO connector_write_ledger
       (id, user_id, connection_id, connection_revision, provider, action,
          params_enc, params_nonce, params_aad_seed, params_hash, canonicalization_version,
          summary, idempotency_key, status, expires_at,
          connector_version_id, spec_hash, exec_contract_hash, auth_contract_version,
          dispatch_fence_required, approval_source, approval_policy_version, approved_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11, $12, $13,
               CASE WHEN $19 = 'account_preapproval' THEN 'approved' ELSE 'pending' END,
               now() + interval '10 minutes', $14, $15, $16, $17, $18, $19, $20,
               CASE WHEN $19 = 'account_preapproval' THEN now() ELSE NULL END)
       RETURNING expires_at`,
      [
        id,
        input.userId,
        input.connectionId,
        input.connectionRevision,
        input.provider,
        input.action,
        enc.ciphertext,
        enc.nonce,
        paramsAadSeed,
        hash,
        CANONICALIZATION_VERSION,
        input.summary.slice(0, 2000),
        idempotencyKey,
        input.contractPins?.connectorVersionId ?? null,
        input.contractPins ? Buffer.from(input.contractPins.specHashHex, 'hex') : null,
        input.contractPins ? Buffer.from(input.contractPins.execContractHashHex, 'hex') : null,
        input.contractPins?.authContractVersion ?? null,
        input.dispatchFenceRequired === true,
        approval.source,
        approvalPolicyVersion,
      ],
    )
    return r.rows[0]!.expires_at
  }, pool)
  return { id, summary: input.summary.slice(0, 2000), expiresAt }
}

/**
 * 写路径 finalize 状态判定(P1#4)。已被 transport 标注「可能已送达」(maybeDelivered:
 * post-dispatch socket 断裂 / 已建连后超时 / 5xx / SMTP DATA 后异常)→ `unknown`
 * (绝不盲重试,防重复写);其余(确定性校验错误 / 明确 4xx 拒绝 / pre-dispatch 连接失败 /
 * 门限拒绝)→ `failed`。
 */
export function writeFinalizeStatus(err: unknown): 'unknown' | 'failed' {
  return (err as { maybeDelivered?: boolean } | null)?.maybeDelivered === true
    ? 'unknown'
    : 'failed'
}

// ─── 读取 / 解密 ─────────────────────────────────────────────────────────

export async function getLedgerRow(
  id: string,
  userId: number,
  pool: Pool = getPool(),
): Promise<LedgerRow | null> {
  const r = await pool.query<LedgerRow>(
    `SELECT ${ROW_COLS} FROM connector_write_ledger
      WHERE id = $1::uuid AND user_id = $2 LIMIT 1`,
    [id, userId],
  )
  return r.rows[0] ?? null
}

/**
 * 解密账本参数 + **hash 复核**(canonical v1;version 不认识 → INTERNAL,防降级)。
 * 只对非终态行有效(终态 params 已销毁)。
 */
export function decryptLedgerParams(row: LedgerRow): Record<string, unknown> {
  if (!row.params_enc || !row.params_nonce) {
    throw new ConnectorError('INTERNAL', 'ledger params already destroyed')
  }
  if (row.canonicalization_version !== CANONICALIZATION_VERSION) {
    throw new ConnectorError(
      'INTERNAL',
      `unsupported canonicalization_version ${row.canonicalization_version}`,
    )
  }
  const key = loadKmsKey()
  let pt: Buffer | null = null
  try {
    pt = decryptToBuffer(
      row.params_enc,
      row.params_nonce,
      key,
      ledgerParamsAad(row.id, row.user_id, row.connection_id, row.params_aad_seed),
    )
    const canonical = pt.toString('utf8')
    const parsed = JSON.parse(canonical) as Record<string, unknown>
    const rehash = canonicalHash(parsed)
    if (rehash.length !== row.params_hash.length || !rehash.equals(row.params_hash)) {
      throw new ConnectorError('INTERNAL', 'ledger params hash mismatch')
    }
    return parsed
  } finally {
    zeroBuffer(key)
    if (pt) zeroBuffer(pt)
  }
}

// ─── approve / deny ──────────────────────────────────────────────────────

/**
 * approve:CAS pending→approved(复核 TTL;params 完整性经 decrypt+hash 复核),
 * expires_at 重设 now()+10min。返回终状态;非法状态给出稳定错误码。
 */
export async function approveConfirmation(
  id: string,
  userId: number,
  pool: Pool = getPool(),
): Promise<{ status: LedgerStatus }> {
  const row = await getLedgerRow(id, userId, pool)
  if (!row) throw new ConnectorError('CONFIRMATION_NOT_FOUND', 'no such confirmation')
  if (row.status === 'pending' && row.expires_at.getTime() > Date.now()) {
    // 完整性复核:密文/AAD 被动过 → 解密抛 AeadError;hash 不符 → INTERNAL。
    decryptLedgerParams(row)
  }
  const r = await pool.query<{ status: LedgerStatus }>(
    `UPDATE connector_write_ledger
        SET status = 'approved', approved_at = now(),
            expires_at = now() + interval '10 minutes'
      WHERE id = $1::uuid AND user_id = $2 AND status = 'pending' AND expires_at > now()
      RETURNING status`,
    [id, userId],
  )
  if ((r.rowCount ?? 0) > 0) return { status: 'approved' }
  // CAS 失败 → 重读分类
  const cur = await getLedgerRow(id, userId, pool)
  if (!cur) throw new ConnectorError('CONFIRMATION_NOT_FOUND', 'no such confirmation')
  if (cur.status === 'approved') return { status: 'approved' } // 幂等重复点击
  if (cur.status === 'pending' || cur.status === 'expired') {
    throw new ConnectorError('CONFIRMATION_EXPIRED', 'confirmation window elapsed')
  }
  throw new ConnectorError('CONFIRMATION_ALREADY_FINALIZED', `status=${cur.status}`)
}

/** deny:pending|approved → denied(销毁 params)。幂等:已 denied → 原样返回。 */
export async function denyConfirmation(
  id: string,
  userId: number,
  pool: Pool = getPool(),
): Promise<{ status: LedgerStatus }> {
  const r = await pool.query<{ status: LedgerStatus }>(
    `UPDATE connector_write_ledger
        SET status = 'denied', finished_at = now(),
            params_enc = NULL, params_nonce = NULL
      WHERE id = $1::uuid AND user_id = $2 AND status IN ('pending','approved')
      RETURNING status`,
    [id, userId],
  )
  if ((r.rowCount ?? 0) > 0) return { status: 'denied' }
  const cur = await getLedgerRow(id, userId, pool)
  if (!cur) throw new ConnectorError('CONFIRMATION_NOT_FOUND', 'no such confirmation')
  if (cur.status === 'denied') return { status: 'denied' }
  if (cur.status === 'executing') throw new ConnectorError('CONFIRMATION_IN_PROGRESS', 'executing')
  throw new ConnectorError('CONFIRMATION_ALREADY_FINALIZED', `status=${cur.status}`)
}

// ─── execute ─────────────────────────────────────────────────────────────

export type BeginExecuteOutcome =
  | { kind: 'ok'; params: Record<string, unknown>; row: LedgerRow }
  | { kind: 'in_progress' }
  | { kind: 'replay'; status: LedgerStatus; errorCode: string | null; resultDigest: string | null }

interface ConnCheckRow {
  revision: number
  status: string
  revoked_at: Date | null
  connector_version_id: string | null
  spec_hash: Buffer | null
  exec_contract_hash: Buffer | null
  auth_contract_version: number | null
}

interface PluginArmConnectionRow extends ConnCheckRow {
  provider: string
  plugin_write_enabled: boolean
  plugin_write_disclaimer_version: number | null
  plugin_write_preapproval_enabled: boolean
  plugin_write_preapproval_disclaimer_version: number | null
  plugin_write_preapproval_accepted_at: Date | null
}

/**
 * CAS approved→executing(单事务 FOR UPDATE):
 *   - **绑定校验(P0#2 越权面)**:账本行必须属于本 connection,且 provider/action 与
 *     期望一致(忽略模型可能重传的 action —— 权威源是账本行;不一致直接拒,不改状态)。
 *   - 复核 expires_at>now()(过期 → 就地终态 expired + 销毁 params → CONFIRMATION_EXPIRED)
 *   - 复核 connection_revision 一致且 connection active(否则就地终态 failed
 *     REVISION_MISMATCH / CONNECTION_* —— 该确认永无成功可能)
 *   - 解密参数(hash 复核)→ 记 started_at
 * 同 id 并发/重复按 classifyForExecute 返回 in_progress / replay。
 *
 * 调用方随后必须**按返回的账本行 provider/action** 解析执行 handler(见 rpc.ts),
 * 并用账本 action 的 schema 重新校验解密参数,严禁按请求体 action 执行。
 */
export async function beginExecute(
  opts: {
    id: string
    userId: number
    connectionId: string
    /** 期望的 connection provider(来自 getActiveConnection 的权威行)。 */
    expectedProvider: string
    /**
     * 期望的 action:**可选**。执行权威源是账本行 action(rpc 执行路径不传,彻底不让
     * 模型输入参与授权/执行,Codex R2 P0#2)。仅当调用方显式提供时才作防御性强制一致。
     */
    expectedAction?: string
  },
  pool: Pool = getPool(),
): Promise<BeginExecuteOutcome> {
  // 注意:tx() 对 throw 语义是 ROLLBACK —— "就地终态"(expired/failed)必须**先提交
  // 再抛错**,否则销毁/终态写入会被回滚(集成测试曾抓到此 bug)。
  // 约定:tx 回调内只对"无写入"的路径直接 throw;有写入的失败路径返回 sentinel,
  // COMMIT 后在事务外抛对应 ConnectorError。
  type TxOutcome =
    | BeginExecuteOutcome
    | { kind: 'throw_after_commit'; code: ConnectorErrorCodeForExecute }
  const out = await tx<TxOutcome>(async (client) => {
    const r = await client.query<LedgerRow>(
      `SELECT ${ROW_COLS} FROM connector_write_ledger
        WHERE id = $1::uuid AND user_id = $2
        FOR UPDATE`,
      [opts.id, opts.userId],
    )
    const row = r.rows[0]
    if (!row) throw new ConnectorError('CONFIRMATION_NOT_FOUND', 'no such confirmation')
    if (row.connection_id !== opts.connectionId) {
      throw new ConnectorError('BAD_REQUEST', 'confirmId does not belong to this connection')
    }
    // P0#2 绑定校验:账本行 provider/action 是执行权威。请求体若企图用同一 confirmId
    // 换执行另一个 action(如飞书 create_calendar_event 的确认换成 send_message),
    // 或 provider 不匹配 → 直接拒(不改状态,账本行仍可被正确 action 执行)。
    if (
      row.provider !== opts.expectedProvider ||
      (opts.expectedAction !== undefined && row.action !== opts.expectedAction)
    ) {
      throw new ConnectorError('BAD_REQUEST', 'confirmId provider/action mismatch')
    }
    const cls = classifyForExecute(row)
    if (cls.kind === 'in_progress') return { kind: 'in_progress' } as const
    if (cls.kind === 'replay') {
      return {
        kind: 'replay',
        status: cls.status,
        errorCode: cls.errorCode,
        resultDigest: cls.resultDigest,
      } as const
    }
    if (cls.kind === 'not_approved') {
      throw new ConnectorError('CONFIRMATION_NOT_APPROVED', 'confirmation not approved yet')
    }
    if (cls.kind === 'expired') {
      await client.query(
        `UPDATE connector_write_ledger
            SET status = 'expired', finished_at = now(), params_enc = NULL, params_nonce = NULL
          WHERE id = $1::uuid`,
        [opts.id],
      )
      return { kind: 'throw_after_commit', code: 'CONFIRMATION_EXPIRED' } as const
    }

    // connection 复核(同事务快照;不锁 connections 行 —— 锁序纪律:不跨表持锁)
    const c = await client.query<ConnCheckRow>(
      `SELECT revision, status, revoked_at,
              connector_version_id::text AS connector_version_id, spec_hash,
              exec_contract_hash, auth_contract_version
         FROM connections WHERE id = $1 AND user_id = $2`,
      [row.connection_id, opts.userId],
    )
    const conn = c.rows[0]
    const pinsMatch =
      conn !== undefined &&
      row.connector_version_id === conn.connector_version_id &&
      (row.spec_hash === null
        ? conn.spec_hash === null
        : conn.spec_hash !== null && row.spec_hash.equals(conn.spec_hash)) &&
      (row.exec_contract_hash === null
        ? conn.exec_contract_hash === null
        : conn.exec_contract_hash !== null &&
          row.exec_contract_hash.equals(conn.exec_contract_hash)) &&
      row.auth_contract_version === conn.auth_contract_version
    const connProblem =
      !conn || conn.revoked_at !== null
        ? ('CONNECTION_REVOKED' as const)
        : conn.status !== 'active'
          ? ('CONNECTION_ERROR' as const)
          : conn.revision !== row.connection_revision
            ? ('REVISION_MISMATCH' as const)
            : !pinsMatch
              ? ('RELINK_REQUIRED' as const)
              : null
    if (connProblem) {
      await client.query(
        `UPDATE connector_write_ledger
            SET status = 'failed', error_code = $2, finished_at = now(),
                params_enc = NULL, params_nonce = NULL
          WHERE id = $1::uuid`,
        [opts.id, connProblem],
      )
      return { kind: 'throw_after_commit', code: connProblem } as const
    }

    // 解密(含 hash 复核)必须在销毁前、置 executing 前完成
    const params = decryptLedgerParams(row)
    const upd = await client.query<LedgerRow>(
      `UPDATE connector_write_ledger
          SET status = 'executing', started_at = now()
        WHERE id = $1::uuid AND status = 'approved' AND expires_at > now()
        RETURNING ${ROW_COLS}`,
      [opts.id],
    )
    if ((upd.rowCount ?? 0) === 0) {
      // FOR UPDATE 下不该发生;防御性
      throw new ConnectorError('INTERNAL', 'execute CAS lost under row lock')
    }
    return { kind: 'ok', params, row: upd.rows[0]! } as const
  }, pool)

  if (out.kind === 'throw_after_commit') {
    throw new ConnectorError(out.code, 'confirmation not executable (terminalized)')
  }
  return out
}

/**
 * Plugin-only external write fence. The database commit order is the authority,
 * not the Redis lease TTL: write access toggles lock the same connection row.
 * Once this transaction commits, every non-proven-success outcome must be
 * treated as maybe delivered and must never be retried automatically.
 */
export async function armPluginWriteDispatch(
  opts: {
    id: string
    userId: number
    connectionId: string
    currentDisclaimerVersion: number
    currentPreapprovalDisclaimerVersion?: number
  },
  pool: Pool = getPool(),
): Promise<LedgerRow> {
  return tx<LedgerRow>(async (client) => {
    // Lock order is deliberately connection -> ledger. The write-access PATCH
    // takes only the connection lock; beginExecute has already committed before
    // this function is called, so there is no inverse lock-order overlap.
    const connectionResult = await client.query<PluginArmConnectionRow>(
      `SELECT revision, status, revoked_at, provider,
              connector_version_id::text AS connector_version_id, spec_hash,
              exec_contract_hash, auth_contract_version,
              plugin_write_enabled, plugin_write_disclaimer_version,
              plugin_write_preapproval_enabled,
              plugin_write_preapproval_disclaimer_version,
              plugin_write_preapproval_accepted_at
         FROM connections
        WHERE id = $1::bigint AND user_id = $2
        FOR UPDATE`,
      [opts.connectionId, opts.userId],
    )
    const connection = connectionResult.rows[0]
    if (!connection || connection.revoked_at !== null)
      throw new ConnectorError('CONNECTION_REVOKED', 'Plugin account is revoked')

    const ledgerResult = await client.query<LedgerRow>(
      `SELECT ${ROW_COLS} FROM connector_write_ledger
        WHERE id = $1::uuid AND user_id = $2 AND connection_id = $3::bigint
        FOR UPDATE`,
      [opts.id, opts.userId, opts.connectionId],
    )
    const row = ledgerResult.rows[0]
    if (!row) throw new ConnectorError('CONFIRMATION_NOT_FOUND', 'Plugin confirmation not found')
    if (
      row.status !== 'executing' ||
      row.dispatch_fence_required !== true ||
      row.dispatch_armed_at !== null
    )
      throw new ConnectorError('CONFIRMATION_IN_PROGRESS', 'Plugin confirmation is not armable')

    const pinsMatch =
      row.connector_version_id === connection.connector_version_id &&
      row.spec_hash !== null &&
      connection.spec_hash !== null &&
      row.spec_hash.equals(connection.spec_hash) &&
      row.exec_contract_hash !== null &&
      connection.exec_contract_hash !== null &&
      row.exec_contract_hash.equals(connection.exec_contract_hash) &&
      row.auth_contract_version !== null &&
      row.auth_contract_version === connection.auth_contract_version
    if (
      connection.status !== 'active' ||
      row.provider !== connection.provider ||
      row.connection_revision !== connection.revision ||
      !pinsMatch
    )
      throw new ConnectorError('REVISION_MISMATCH', 'Plugin account changed before dispatch')
    if (
      connection.plugin_write_enabled !== true ||
      connection.plugin_write_disclaimer_version !== opts.currentDisclaimerVersion
    )
      throw new ConnectorError('CONNECTION_ERROR', 'Plugin writes are disabled')
    if (
      row.approval_source === 'account_preapproval' &&
      (connection.plugin_write_preapproval_enabled !== true ||
        !(connection.plugin_write_preapproval_accepted_at instanceof Date) ||
        opts.currentPreapprovalDisclaimerVersion === undefined ||
        connection.plugin_write_preapproval_disclaimer_version !==
          opts.currentPreapprovalDisclaimerVersion ||
        row.approval_policy_version !== opts.currentPreapprovalDisclaimerVersion)
    )
      throw new ConnectorError('CONNECTION_ERROR', 'Plugin account preapproval is disabled')

    const armed = await client.query<LedgerRow>(
      `UPDATE connector_write_ledger
          SET dispatch_armed_at = now()
        WHERE id = $1::uuid AND user_id = $2 AND connection_id = $3::bigint
          AND status = 'executing' AND dispatch_armed_at IS NULL
        RETURNING ${ROW_COLS}`,
      [opts.id, opts.userId, opts.connectionId],
    )
    if ((armed.rowCount ?? 0) !== 1)
      throw new ConnectorError('INTERNAL', 'Plugin dispatch arm CAS failed')
    return armed.rows[0]!
  }, pool)
}

/** beginExecute 就地终态化后抛出的错误码集合。 */
type ConnectorErrorCodeForExecute =
  | 'CONFIRMATION_EXPIRED'
  | 'CONNECTION_REVOKED'
  | 'CONNECTION_ERROR'
  | 'REVISION_MISMATCH'
  | 'RELINK_REQUIRED'

/**
 * 终态 CAS:executing → succeeded|failed|unknown + finished_at + **销毁 params**。
 * rowCount=0(sweeper 已 unknown 等)→ 返回 false,调用方以账本为准。
 */
export async function finalizeExecute(
  opts: {
    id: string
    status: 'succeeded' | 'failed' | 'unknown'
    errorCode?: string | null
    resultDigest?: string | null
  },
  pool: Pool = getPool(),
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE connector_write_ledger
        SET status = $2, error_code = $3, result_digest = $4, finished_at = now(),
            params_enc = NULL, params_nonce = NULL
      WHERE id = $1::uuid AND status = 'executing'`,
    [opts.id, opts.status, opts.errorCode?.slice(0, 64) ?? null, opts.resultDigest ?? null],
  )
  return (r.rowCount ?? 0) > 0
}
