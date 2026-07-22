// turnDispatchStore —— turn_dispatches 的全 CAS 读写单点(RFC-v5-durable-turn-dispatch §2)。
//
// turn_dispatches 是「逻辑 turn + 租约」的单一权威。本模块只暴露**乐观并发安全**的原子操作:
//   - 受理冲突表(admitDispatch,在 user 行 append 的同一 tx 内跑,单事务原子);
//   - 租约 epoch fence(heartbeat / takeover / rejecting 迁移,防双 master 撕裂);
//   - 终态/人工收敛迁移(与 DDL CHECK 对齐,绝不制造非法终态);
//   - reconciler 扫描面(open 三态 / accepted stuck / terminal 未通知)。
//
// 一切写都是 CAS(WHERE 带 status/epoch/lease 谓词 + rowCount 判定),蓝绿重叠 / 双 master /
// 与真实 finalize 并发时二次执行 no-op。owner_id = 持有 bridge 的连接 id;lease_epoch 每次
// takeover ++,消费侧(heartbeat)严格比对 epoch —— 老 owner 的心跳打在旧 epoch 上必 no-op。

import type { Pool, PoolClient } from 'pg'

/** Pool 或事务内 client 都可作查询面(admit 走 client 与 append 同 tx;reconciler 走 pool)。 */
export type Queryable = Pick<Pool | PoolClient, 'query'>

export type DispatchStatus = 'admitted' | 'accepted' | 'rejecting' | 'terminal' | 'manual_reconcile'
export type DispatchOutcome =
  | 'completed'
  | 'interrupted'
  | 'crashed'
  | 'executed_error'
  | 'not_accepted'

/** 默认租约 TTL:bridge attach 期间按此续心跳(reconciler 另加 5min age 门才动过期租约)。 */
export const DISPATCH_LEASE_TTL_MS = 90_000
/** 心跳间隔:约 TTL 的 1/3,连丢两拍才判过期。 */
export const DISPATCH_LEASE_HEARTBEAT_MS = 30_000
/** reconciler 接管 admitted∧租约过期行的最小 age(自 admitted_at):max(120s,5min)=5min。 */
export const DISPATCH_REJECT_MIN_AGE_MS = 300_000
/** open 行超龄告警门(RFC §2:open>7d 告警,永不 GC)。 */
export const DISPATCH_OPEN_ALERT_AGE_MS = 7 * 24 * 3_600_000

export interface TurnDispatchRow {
  dispatchId: string
  userId: bigint
  sessionId: string
  clientMessageId: string
  agentId: string
  model: string | null
  requestHash: string
  billingRequestId: string
  attemptNo: number
  status: DispatchStatus
  outcome: DispatchOutcome | null
  failureCode: string | null
  conflictReason: string | null
  resolution: string | null
  resolvedAt: Date | null
  clientNotified: boolean
  ownerId: string | null
  leaseEpoch: number
  leaseUntil: Date | null
  anchorSeq: bigint | null
  admittedAt: Date
  acceptedAt: Date | null
  terminalAt: Date | null
  lastAttemptAt: Date | null
}

const DISPATCH_COLUMNS = `
  dispatch_id, user_id, session_id, client_message_id, agent_id, model,
  request_hash, billing_request_id, attempt_no, status, outcome, failure_code,
  conflict_reason, resolution, resolved_at, client_notified, owner_id,
  lease_epoch, lease_until, anchor_seq, admitted_at, accepted_at, terminal_at,
  last_attempt_at`

/** join 场景用(scanOpenSessionGone):client_sessions 与 turn_dispatches 同名列须限定表别名 d。 */
const DISPATCH_COLUMNS_QUALIFIED = DISPATCH_COLUMNS.split(',')
  .map((c) => `d.${c.trim()}`)
  .join(', ')

interface RawDispatchRow {
  dispatch_id: string
  user_id: string
  session_id: string
  client_message_id: string
  agent_id: string
  model: string | null
  request_hash: string
  billing_request_id: string
  attempt_no: number
  status: DispatchStatus
  outcome: DispatchOutcome | null
  failure_code: string | null
  conflict_reason: string | null
  resolution: string | null
  resolved_at: Date | null
  client_notified: boolean
  owner_id: string | null
  lease_epoch: string
  lease_until: Date | null
  anchor_seq: string | null
  admitted_at: Date
  accepted_at: Date | null
  terminal_at: Date | null
  last_attempt_at: Date | null
}

function mapRow(r: RawDispatchRow): TurnDispatchRow {
  return {
    dispatchId: r.dispatch_id,
    userId: BigInt(r.user_id),
    sessionId: r.session_id,
    clientMessageId: r.client_message_id,
    agentId: r.agent_id,
    model: r.model,
    requestHash: r.request_hash,
    billingRequestId: r.billing_request_id,
    attemptNo: r.attempt_no,
    status: r.status,
    outcome: r.outcome,
    failureCode: r.failure_code,
    conflictReason: r.conflict_reason,
    resolution: r.resolution,
    resolvedAt: r.resolved_at,
    clientNotified: r.client_notified,
    ownerId: r.owner_id,
    leaseEpoch: Number(r.lease_epoch),
    leaseUntil: r.lease_until,
    anchorSeq: r.anchor_seq === null ? null : BigInt(r.anchor_seq),
    admittedAt: r.admitted_at,
    acceptedAt: r.accepted_at,
    terminalAt: r.terminal_at,
    lastAttemptAt: r.last_attempt_at,
  }
}

// ─── 受理冲突表(RFC §2.1)──────────────────────────────────────────────────

export interface AdmitDispatchInput {
  /** 新行才用的 dispatch_id(fresh uuid)。 */
  dispatchId: string
  userId: bigint
  sessionId: string
  clientMessageId: string
  agentId: string
  model: string | null
  /** sha256(text + sorted media refs)。 */
  requestHash: string
  /** 新行才铸的稳定 billing request id(接管复用旧值,永不重铸)。 */
  billingRequestId: string
  /** 本 bridge 连接 id(lease owner)。 */
  ownerId: string
  /** 受理事务内该 user 行的 _seq(projection 排序键)。 */
  anchorSeq: bigint | null
  leaseTtlMs?: number
  now?: number
}

/**
 * 受理结果 kind(RFC §2.1)。bridge 按 kind 决定帧响应,只有 'admitted' 才继续开 IIFE。
 * 'admitted' 覆盖两种:全新受理 与 lease 过期后同 attempt 接管(billingRequestId 复用旧值)。
 */
export type AdmitDispatchResult =
  | { kind: 'admitted'; dispatch: TurnDispatchRow; takeover: boolean }
  | { kind: 'already_owned'; dispatch: TurnDispatchRow }
  | { kind: 'in_flight'; dispatch: TurnDispatchRow }
  | { kind: 'deduplicated'; dispatch: TurnDispatchRow }
  | { kind: 'previously_failed'; dispatch: TurnDispatchRow }
  | { kind: 'manual_hold'; dispatch: TurnDispatchRow }
  | { kind: 'immutable_conflict'; dispatch: TurnDispatchRow }

/**
 * 受理事务的 dispatch UPSERT + 冲突表裁定。**必须**在已 append user 行的同一 tx 内调用
 * (传入该 tx 的 client),保证「受理即拥有」单事务原子(I1)。
 *
 * 冲突表(逻辑键 = user_id+session_id+client_message_id):
 *   无行            → INSERT admitted + lease(epoch=1)+ billing_request_id 铸 → admitted(takeover=false)
 *   request_hash 变 → immutable_conflict(不动状态;前端篡改重发)
 *   admitted∧lease 活 → already_owned(bridge 回 busy)
 *   admitted∧lease 过期 → CAS epoch++ 接管(复用 billing_request_id/attempt_no)→ admitted(takeover=true)
 *   accepted / rejecting → in_flight
 *   terminal∧completed  → deduplicated
 *   terminal∧其它 outcome → previously_failed(前端重试铸新 clientMessageId)
 *   manual_reconcile    → manual_hold
 */
export async function admitDispatch(
  client: Queryable,
  input: AdmitDispatchInput,
): Promise<AdmitDispatchResult> {
  const now = input.now ?? Date.now()
  const leaseTtlMs = input.leaseTtlMs ?? DISPATCH_LEASE_TTL_MS
  const leaseUntil = new Date(now + leaseTtlMs)
  const nowDate = new Date(now)

  const existing = await client.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches
      WHERE user_id = $1 AND session_id = $2 AND client_message_id = $3
      FOR UPDATE`,
    [input.userId.toString(), input.sessionId, input.clientMessageId],
  )

  if (existing.rows.length === 0) {
    const inserted = await client.query<RawDispatchRow>(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, model,
          request_hash, billing_request_id, attempt_no, status,
          owner_id, lease_epoch, lease_until, anchor_seq, admitted_at, last_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'admitted',$9,1,$10,$11,$12,$12)
       RETURNING ${DISPATCH_COLUMNS}`,
      [
        input.dispatchId,
        input.userId.toString(),
        input.sessionId,
        input.clientMessageId,
        input.agentId,
        input.model,
        input.requestHash,
        input.billingRequestId,
        input.ownerId,
        leaseUntil,
        input.anchorSeq === null ? null : input.anchorSeq.toString(),
        nowDate,
      ],
    )
    return { kind: 'admitted', dispatch: mapRow(inserted.rows[0]!), takeover: false }
  }

  const row = mapRow(existing.rows[0]!)

  if (row.requestHash !== input.requestHash) {
    return { kind: 'immutable_conflict', dispatch: row }
  }

  switch (row.status) {
    case 'admitted': {
      const leaseActive = row.leaseUntil !== null && row.leaseUntil.getTime() > now
      if (leaseActive) return { kind: 'already_owned', dispatch: row }
      // lease 过期 → 接管:epoch++,换 owner,续 lease;复用 billing_request_id/attempt_no。
      const taken = await client.query<RawDispatchRow>(
        `UPDATE turn_dispatches
            SET owner_id = $2, lease_epoch = lease_epoch + 1, lease_until = $3,
                last_attempt_at = $4
          WHERE dispatch_id = $1 AND lease_epoch = $5 AND status = 'admitted'
          RETURNING ${DISPATCH_COLUMNS}`,
        [row.dispatchId, input.ownerId, leaseUntil, nowDate, String(row.leaseEpoch)],
      )
      if (taken.rows.length === 0) {
        // 并发接管输了(别的 bridge 先 epoch++)→ 当作已被占用,回 busy。
        const reread = await getDispatch(client, row.dispatchId)
        return { kind: 'already_owned', dispatch: reread ?? row }
      }
      return { kind: 'admitted', dispatch: mapRow(taken.rows[0]!), takeover: true }
    }
    case 'accepted':
    case 'rejecting':
      return { kind: 'in_flight', dispatch: row }
    case 'terminal':
      return row.outcome === 'completed'
        ? { kind: 'deduplicated', dispatch: row }
        : { kind: 'previously_failed', dispatch: row }
    case 'manual_reconcile':
      return { kind: 'manual_hold', dispatch: row }
    default: {
      // 穷尽 —— 新状态未处理时 fail-visible(不静默当作 in_flight)。
      const _exhaustive: never = row.status
      throw new Error(`[turnDispatchStore] admit: unhandled status ${String(_exhaustive)}`)
    }
  }
}

// ─── 租约 epoch fence ───────────────────────────────────────────────────────

export interface HeartbeatLeaseInput {
  dispatchId: string
  ownerId: string
  leaseEpoch: number
  leaseTtlMs?: number
  now?: number
}

/**
 * 续租(bridge attach 长窗口每拍调)。CAS 匹配 dispatch+owner+epoch+status='admitted'。
 * 返回 false = 本 bridge 已非 owner(被接管 / 已离态)→ 调用方停止心跳,勿再当权威。
 */
export async function heartbeatLease(q: Queryable, input: HeartbeatLeaseInput): Promise<boolean> {
  const now = input.now ?? Date.now()
  const leaseUntil = new Date(now + (input.leaseTtlMs ?? DISPATCH_LEASE_TTL_MS))
  const res = await q.query(
    `UPDATE turn_dispatches
        SET lease_until = $3, last_attempt_at = $4
      WHERE dispatch_id = $1 AND owner_id = $2 AND lease_epoch = $5 AND status = 'admitted'`,
    [input.dispatchId, input.ownerId, leaseUntil, new Date(now), String(input.leaseEpoch)],
  )
  return (res.rowCount ?? 0) === 1
}

// ─── 状态迁移(全 CAS)───────────────────────────────────────────────────────

/**
 * admitted → rejecting(reconciler 接管过期租约后向容器求证 tombstone 前)。CAS 匹配 epoch,
 * 顺手 epoch++ 抢占(此后老 owner 心跳 no-op)。仅当 status='admitted' 才动。
 */
export async function casAdmittedToRejecting(
  q: Queryable,
  input: { dispatchId: string; expectedEpoch: number; ownerId: string; now?: number },
): Promise<TurnDispatchRow | null> {
  const now = input.now ?? Date.now()
  const res = await q.query<RawDispatchRow>(
    `UPDATE turn_dispatches
        SET status = 'rejecting', owner_id = $2, lease_epoch = lease_epoch + 1,
            lease_until = NULL, last_attempt_at = $3
      WHERE dispatch_id = $1 AND status = 'admitted' AND lease_epoch = $4
      RETURNING ${DISPATCH_COLUMNS}`,
    [input.dispatchId, input.ownerId, new Date(now), String(input.expectedEpoch)],
  )
  return res.rows.length === 0 ? null : mapRow(res.rows[0]!)
}

/** rejecting → accepted(容器求证回执「已有 queued/running 行」→ 转 accepted 分支)。 */
/**
 * admitted → accepted(bridge 消费容器 turn_dispatch_receipt 时走)。epoch 匹配:
 * 回执属于本 owner 的受理;接管后旧 owner 的迟到回执 rowCount=0 幂等无害。
 */
export async function casAdmittedToAccepted(
  q: Queryable,
  input: { dispatchId: string; expectedEpoch: number; now?: number },
): Promise<TurnDispatchRow | null> {
  const now = input.now ?? Date.now()
  const res = await q.query<RawDispatchRow>(
    `UPDATE turn_dispatches
        SET status = 'accepted', accepted_at = COALESCE(accepted_at, $3), last_attempt_at = $3
      WHERE dispatch_id = $1 AND status = 'admitted' AND lease_epoch = $2
      RETURNING ${DISPATCH_COLUMNS}`,
    [input.dispatchId, input.expectedEpoch, new Date(now)],
  )
  return res.rows.length === 0 ? null : mapRow(res.rows[0]!)
}

export async function casRejectingToAccepted(
  q: Queryable,
  input: { dispatchId: string; now?: number },
): Promise<TurnDispatchRow | null> {
  const now = input.now ?? Date.now()
  const res = await q.query<RawDispatchRow>(
    `UPDATE turn_dispatches
        SET status = 'accepted', accepted_at = COALESCE(accepted_at, $2), last_attempt_at = $2
      WHERE dispatch_id = $1 AND status = 'rejecting'
      RETURNING ${DISPATCH_COLUMNS}`,
    [input.dispatchId, new Date(now)],
  )
  return res.rows.length === 0 ? null : mapRow(res.rows[0]!)
}

export interface CasToTerminalInput {
  dispatchId: string
  outcome: DispatchOutcome
  failureCode?: string | null
  /** 送达用户面即 true(pre-forward 失败出口 / fail-visible 通知后)。 */
  clientNotified?: boolean
  /** 允许迁移的来源状态(默认 open 三态);已 terminal/manual 不再改写(幂等)。 */
  fromStatuses?: DispatchStatus[]
  /** 期望的 lease_epoch(接管路径需匹配;不传则不校验 epoch)。 */
  expectedEpoch?: number
  now?: number
}

/**
 * → terminal(CAS)。DDL CHECK 要求 terminal 必带 outcome —— 由入参保证。幂等:已在目标外
 * 状态时 rowCount=0 返 null,调用方据此判「别人先终态了」。
 */
export async function casToTerminal(
  q: Queryable,
  input: CasToTerminalInput,
): Promise<TurnDispatchRow | null> {
  const now = input.now ?? Date.now()
  const from = input.fromStatuses ?? ['admitted', 'accepted', 'rejecting']
  const params: unknown[] = [
    input.dispatchId,
    input.outcome,
    input.failureCode ?? null,
    input.clientNotified ?? false,
    new Date(now),
    from,
  ]
  let epochClause = ''
  if (input.expectedEpoch !== undefined) {
    params.push(String(input.expectedEpoch))
    epochClause = ` AND lease_epoch = $${params.length}`
  }
  const res = await q.query<RawDispatchRow>(
    `UPDATE turn_dispatches
        SET status = 'terminal', outcome = $2, failure_code = $3,
            client_notified = client_notified OR $4,
            terminal_at = COALESCE(terminal_at, $5), last_attempt_at = $5,
            lease_until = NULL
      WHERE dispatch_id = $1 AND status = ANY($6::text[])${epochClause}
      RETURNING ${DISPATCH_COLUMNS}`,
    params,
  )
  return res.rows.length === 0 ? null : mapRow(res.rows[0]!)
}

/**
 * → manual_reconcile(CAS)。DDL CHECK 要求 conflict_reason 非空。财务歧义 / late tape /
 * 接管快照不一致三源。默认可从任意非终解态迁移(含 terminal —— late tape 撤销场景)。
 */
export async function casToManualReconcile(
  q: Queryable,
  input: {
    dispatchId: string
    conflictReason: string
    fromStatuses?: DispatchStatus[]
    now?: number
  },
): Promise<TurnDispatchRow | null> {
  const now = input.now ?? Date.now()
  const from = input.fromStatuses ?? ['admitted', 'accepted', 'rejecting', 'terminal']
  const res = await q.query<RawDispatchRow>(
    `UPDATE turn_dispatches
        SET status = 'manual_reconcile', conflict_reason = $2, last_attempt_at = $3,
            lease_until = NULL
      WHERE dispatch_id = $1 AND status = ANY($4::text[]) AND status <> 'manual_reconcile'
      RETURNING ${DISPATCH_COLUMNS}`,
    [input.dispatchId, input.conflictReason, new Date(now), from],
  )
  return res.rows.length === 0 ? null : mapRow(res.rows[0]!)
}

/** manual_reconcile 人工收敛(admin):落 resolution/resolved_at,此后才计入 90d GC 窗口。 */
export async function resolveManualReconcile(
  q: Queryable,
  input: { dispatchId: string; resolution: string; now?: number },
): Promise<boolean> {
  const now = input.now ?? Date.now()
  const res = await q.query(
    `UPDATE turn_dispatches
        SET resolution = $2, resolved_at = $3
      WHERE dispatch_id = $1 AND status = 'manual_reconcile' AND resolved_at IS NULL`,
    [input.dispatchId, input.resolution, new Date(now)],
  )
  return (res.rowCount ?? 0) === 1
}

/** 标记用户面已被告知终态(reconciler fail-visible 通知成功后)。 */
export async function markClientNotified(q: Queryable, dispatchId: string): Promise<boolean> {
  const res = await q.query(
    `UPDATE turn_dispatches SET client_notified = TRUE WHERE dispatch_id = $1`,
    [dispatchId],
  )
  return (res.rowCount ?? 0) === 1
}

// ─── 读 ─────────────────────────────────────────────────────────────────────

export async function getDispatch(q: Queryable, dispatchId: string): Promise<TurnDispatchRow | null> {
  const res = await q.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches WHERE dispatch_id = $1`,
    [dispatchId],
  )
  return res.rows.length === 0 ? null : mapRow(res.rows[0]!)
}

/**
 * 行锁读(SELECT ... FOR UPDATE)。**只能在事务内的 client 上调**(传 pool 会各自成
 * autocommit,锁瞬间释放,失去互斥意义)。B8:reconciler 的「财务判定→durable status→notified」
 * 单事务锁本 dispatch 行,与 tape finalize 的 convergeDispatchOnFinalize(其 casToTerminal
 * UPDATE 同样取本行写锁)共享互斥序,消除「终态 error 卡」与「late tape 完整 materialize」并发。
 */
export async function getDispatchForUpdate(
  client: PoolClient,
  dispatchId: string,
): Promise<TurnDispatchRow | null> {
  const res = await client.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches WHERE dispatch_id = $1 FOR UPDATE`,
    [dispatchId],
  )
  return res.rows.length === 0 ? null : mapRow(res.rows[0]!)
}

/**
 * 按 billing_request_id 反查(CCB egress 结算侧:__oc_model_authority.billingRequestId →
 * dispatch 身份 → usage_records.dispatch_id/attempt_no)。billing_request_id 唯一。
 */
export async function getDispatchByBillingRequestId(
  q: Queryable,
  billingRequestId: string,
): Promise<Pick<TurnDispatchRow, 'dispatchId' | 'attemptNo' | 'sessionId'> | null> {
  const res = await q.query<{ dispatch_id: string; attempt_no: number; session_id: string }>(
    `SELECT dispatch_id, attempt_no, session_id FROM turn_dispatches WHERE billing_request_id = $1`,
    [billingRequestId],
  )
  return res.rows.length === 0
    ? null
    : {
        dispatchId: res.rows[0]!.dispatch_id,
        attemptNo: res.rows[0]!.attempt_no,
        sessionId: res.rows[0]!.session_id,
      }
}

export async function getDispatchByLogicalKey(
  q: Queryable,
  key: { userId: bigint; sessionId: string; clientMessageId: string },
): Promise<TurnDispatchRow | null> {
  const res = await q.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches
      WHERE user_id = $1 AND session_id = $2 AND client_message_id = $3`,
    [key.userId.toString(), key.sessionId, key.clientMessageId],
  )
  return res.rows.length === 0 ? null : mapRow(res.rows[0]!)
}

/**
 * reconciler 扫描:admitted∧租约过期∧自 admitted_at 已超 minAgeMs。返回行(reconciler 逐行
 * CAS→rejecting)。ORDER 最旧优先,LIMIT 有界。
 */
export async function scanAdmittedLeaseExpired(
  q: Queryable,
  input: { minAgeMs: number; limit: number; now?: number },
): Promise<TurnDispatchRow[]> {
  const now = input.now ?? Date.now()
  const res = await q.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches
      WHERE status = 'admitted'
        AND (lease_until IS NULL OR lease_until <= $1)
        AND admitted_at <= $2
      ORDER BY admitted_at ASC
      LIMIT $3`,
    [new Date(now), new Date(now - Math.max(0, input.minAgeMs)), String(Math.max(1, input.limit))],
  )
  return res.rows.map(mapRow)
}

/** reconciler 扫描:accepted 且自 accepted_at 已超 stuckMs(卡在容器执行/sink)。 */
export async function scanAcceptedStuck(
  q: Queryable,
  input: { stuckMs: number; limit: number; now?: number },
): Promise<TurnDispatchRow[]> {
  const now = input.now ?? Date.now()
  const res = await q.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches
      WHERE status = 'accepted'
        AND COALESCE(accepted_at, admitted_at) <= $1
      ORDER BY accepted_at ASC NULLS FIRST
      LIMIT $2`,
    [new Date(now - Math.max(0, input.stuckMs)), String(Math.max(1, input.limit))],
  )
  return res.rows.map(mapRow)
}

/** reconciler 扫描:rejecting(向容器求证中,可能容器不可达需重试)。 */
export async function scanRejecting(
  q: Queryable,
  input: { limit: number },
): Promise<TurnDispatchRow[]> {
  const res = await q.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches
      WHERE status = 'rejecting'
      ORDER BY admitted_at ASC
      LIMIT $1`,
    [String(Math.max(1, input.limit))],
  )
  return res.rows.map(mapRow)
}

/** reconciler 扫描:terminal(not_accepted/executed_error)∧未通知用户面 → fail-visible。 */
export async function scanTerminalUnnotified(
  q: Queryable,
  input: { limit: number },
): Promise<TurnDispatchRow[]> {
  const res = await q.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches
      WHERE status = 'terminal' AND client_notified = FALSE
        AND outcome IN ('not_accepted', 'executed_error')
      ORDER BY terminal_at ASC NULLS FIRST
      LIMIT $1`,
    [String(Math.max(1, input.limit))],
  )
  return res.rows.map(mapRow)
}

/**
 * reconciler 扫描:open 三态 ∧ 租约已过期 ∧ 会话行已墓碑/不存在(用户面已消失)。
 * 会话归属键 = user_id 'c:<uid>'(web 受理 lane 唯一铸行方);join miss(行亡/异主)与
 * deleted_at 墓碑同判「会话亡」。租约过期 + minAge 双闸:绝不与在飞 bridge 抢行。
 */
export async function scanOpenSessionGone(
  q: Queryable,
  input: { minAgeMs: number; limit: number; now?: number },
): Promise<TurnDispatchRow[]> {
  const now = input.now ?? Date.now()
  const res = await q.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS_QUALIFIED} FROM turn_dispatches d
      LEFT JOIN client_sessions s
        ON s.id = d.session_id AND s.user_id = 'c:' || d.user_id::text
      WHERE d.status IN ('admitted', 'accepted', 'rejecting')
        AND (d.lease_until IS NULL OR d.lease_until <= $1)
        AND d.admitted_at <= $2
        AND (s.id IS NULL OR s.deleted_at IS NOT NULL)
      ORDER BY d.admitted_at ASC
      LIMIT $3`,
    [new Date(now), new Date(now - Math.max(0, input.minAgeMs)), String(Math.max(1, input.limit))],
  )
  return res.rows.map(mapRow)
}

/** reconciler 只读扫描:open 三态超龄(>7d 告警,永不 GC)。 */
export async function scanOpenAged(
  q: Queryable,
  input: { ageMs: number; limit: number; now?: number },
): Promise<TurnDispatchRow[]> {
  const now = input.now ?? Date.now()
  const res = await q.query<RawDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM turn_dispatches
      WHERE status IN ('admitted', 'accepted', 'rejecting')
        AND admitted_at <= $1
      ORDER BY admitted_at ASC
      LIMIT $2`,
    [new Date(now - Math.max(0, input.ageMs)), String(Math.max(1, input.limit))],
  )
  return res.rows.map(mapRow)
}
