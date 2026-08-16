// TicketRun DAO — 执行记录 + lease 防重入。
//
// lease 活在 run 行上(lease_owner / lease_expires_at),不另造锁表。
// acquireLease 在 BEGIN IMMEDIATE 里:
//   1. 先回收该 ticket 上已过期但仍标 running/queued 的 lease(崩溃回收);
//   2. 若仍有未过期 lease → TaskboardLeaseHeld;
//   3. 否则插入 status=running 的 run 并写入 lease。
//
// TTL 默认 GUARDRAIL_DEFAULTS.leaseTtlMs = 50 分钟,必须长于 delegate 的
// 45 分钟硬超时(CORRECTIONS §2.2):否则 run 还在跑,下一轮 tick 就会把
// 同一张卡再认领一遍,双跑。
//
// 本 DAO **不改** ticket.status —— 那是 stateMachine 的职责。这里只保证
// 「同一 ticket 同一时刻最多一个未过期 lease」。
//
// 坑:
//   - 过期判断用调用方传入的 now,测试才能把时钟拨到未来;生产传 Date.now()。
//   - 不能对「未过期」建部分唯一索引(表达式含 now()),只能靠事务内检查。
//   - releaseLease 只清 lease 字段,不改 status;收尾由 updateRun 写终态。

import type { RunSkipReason, RunStatus, RunTrigger, TicketRun } from '../domain.js'
import { GUARDRAIL_DEFAULTS } from '../domain.js'
import { type TaskboardDb, TaskboardLeaseHeld, TaskboardNotFound, newId, nowMs } from './schema.js'

interface RunRow {
  id: string
  ticket_id: string
  stage_id: string
  agent_id: string | null
  trigger: RunTrigger
  session_key: string | null
  status: RunStatus
  skip_reason: RunSkipReason | null
  lease_owner: string | null
  lease_expires_at: number | null
  started_at: number | null
  finished_at: number | null
  duration_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  summary: string | null
  output_md: string | null
  error: string | null
  created_at: number
}

const RUN_COLS = `
  id, ticket_id, stage_id, agent_id, trigger, session_key, status, skip_reason,
  lease_owner, lease_expires_at, started_at, finished_at, duration_ms,
  tokens_in, tokens_out, cost_usd, summary, output_md, error, created_at
`

function mapRun(row: RunRow): TicketRun {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    stageId: row.stage_id,
    agentId: row.agent_id,
    trigger: row.trigger,
    sessionKey: row.session_key,
    status: row.status,
    skipReason: row.skip_reason,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    summary: row.summary,
    outputMd: row.output_md,
    error: row.error,
    createdAt: row.created_at,
  }
}

export interface CreateRunInput {
  ticketId: string
  stageId: string
  agentId?: string | null
  trigger: RunTrigger
  status?: RunStatus
  skipReason?: RunSkipReason | null
  sessionKey?: string | null
  leaseOwner?: string | null
  leaseExpiresAt?: number | null
  startedAt?: number | null
}

export interface UpdateRunPatch {
  status?: RunStatus
  skipReason?: RunSkipReason | null
  sessionKey?: string | null
  leaseOwner?: string | null
  leaseExpiresAt?: number | null
  startedAt?: number | null
  finishedAt?: number | null
  durationMs?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
  summary?: string | null
  outputMd?: string | null
  error?: string | null
}

export interface RunListQuery {
  ticketId?: string
  stageId?: string
  status?: RunStatus | RunStatus[]
  limit?: number
  offset?: number
}

export interface AcquireLeaseOptions {
  agentId?: string | null
  trigger?: RunTrigger
  now?: number
}

const ACTIVE_LEASE_STATUSES = "('queued', 'running')"

function findActiveLease(db: TaskboardDb, ticketId: string, now: number): RunRow | undefined {
  return db
    .prepare(
      `SELECT ${RUN_COLS} FROM tb_ticket_run
        WHERE ticket_id = ?
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?
          AND status IN ${ACTIVE_LEASE_STATUSES}
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(ticketId, now) as RunRow | undefined
}

function expireLeasesOnTicket(db: TaskboardDb, ticketId: string, now: number): void {
  db.prepare(
    `UPDATE tb_ticket_run SET
       status = 'timeout',
       finished_at = @now,
       duration_ms = CASE
         WHEN started_at IS NULL THEN NULL
         ELSE @now - started_at
       END,
       error = COALESCE(error, 'lease expired'),
       lease_owner = NULL,
       lease_expires_at = NULL
     WHERE ticket_id = @ticketId
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= @now
       AND status IN ${ACTIVE_LEASE_STATUSES}`,
  ).run({ ticketId, now })
}

export function insertRun(db: TaskboardDb, input: CreateRunInput): TicketRun {
  const now = nowMs()
  const id = newId()
  db.prepare(
    `INSERT INTO tb_ticket_run (
       id, ticket_id, stage_id, agent_id, trigger, session_key, status,
       skip_reason, lease_owner, lease_expires_at, started_at, finished_at,
       duration_ms, tokens_in, tokens_out, cost_usd, summary, output_md,
       error, created_at
     ) VALUES (
       @id, @ticketId, @stageId, @agentId, @trigger, @sessionKey, @status,
       @skipReason, @leaseOwner, @leaseExpiresAt, @startedAt, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, @now
     )`,
  ).run({
    id,
    ticketId: input.ticketId,
    stageId: input.stageId,
    agentId: input.agentId ?? null,
    trigger: input.trigger,
    sessionKey: input.sessionKey ?? null,
    status: input.status ?? 'queued',
    skipReason: input.skipReason ?? null,
    leaseOwner: input.leaseOwner ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    startedAt: input.startedAt ?? null,
    now,
  })
  return getRun(db, id) as TicketRun
}

export function getRun(db: TaskboardDb, id: string): TicketRun | null {
  const row = db.prepare(`SELECT ${RUN_COLS} FROM tb_ticket_run WHERE id = ?`).get(id) as
    | RunRow
    | undefined
  return row ? mapRun(row) : null
}

export function listRuns(
  db: TaskboardDb,
  query: RunListQuery = {},
): { items: TicketRun[]; total: number } {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (query.ticketId) {
    where.push('ticket_id = @ticketId')
    params.ticketId = query.ticketId
  }
  if (query.stageId) {
    where.push('stage_id = @stageId')
    params.stageId = query.stageId
  }
  if (query.status) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status]
    where.push(`status IN (${statuses.map((_, i) => `@st${i}`).join(', ')})`)
    statuses.forEach((s, i) => {
      params[`st${i}`] = s
    })
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM tb_ticket_run ${whereSql}`).get(params) as {
      n: number
    }
  ).n
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const offset = Math.max(query.offset ?? 0, 0)
  const rows = db
    .prepare(
      `SELECT ${RUN_COLS} FROM tb_ticket_run ${whereSql}
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as RunRow[]
  return { items: rows.map(mapRun), total }
}

export function updateRun(db: TaskboardDb, id: string, patch: UpdateRunPatch): TicketRun {
  const existing = getRun(db, id)
  if (!existing) throw new TaskboardNotFound('run', id)
  db.prepare(
    `UPDATE tb_ticket_run SET
       status = @status,
       skip_reason = @skipReason,
       session_key = @sessionKey,
       lease_owner = @leaseOwner,
       lease_expires_at = @leaseExpiresAt,
       started_at = @startedAt,
       finished_at = @finishedAt,
       duration_ms = @durationMs,
       tokens_in = @tokensIn,
       tokens_out = @tokensOut,
       cost_usd = @costUsd,
       summary = @summary,
       output_md = @outputMd,
       error = @error
     WHERE id = @id`,
  ).run({
    id,
    status: patch.status ?? existing.status,
    skipReason: patch.skipReason === undefined ? existing.skipReason : patch.skipReason,
    sessionKey: patch.sessionKey === undefined ? existing.sessionKey : patch.sessionKey,
    leaseOwner: patch.leaseOwner === undefined ? existing.leaseOwner : patch.leaseOwner,
    leaseExpiresAt:
      patch.leaseExpiresAt === undefined ? existing.leaseExpiresAt : patch.leaseExpiresAt,
    startedAt: patch.startedAt === undefined ? existing.startedAt : patch.startedAt,
    finishedAt: patch.finishedAt === undefined ? existing.finishedAt : patch.finishedAt,
    durationMs: patch.durationMs === undefined ? existing.durationMs : patch.durationMs,
    tokensIn: patch.tokensIn === undefined ? existing.tokensIn : patch.tokensIn,
    tokensOut: patch.tokensOut === undefined ? existing.tokensOut : patch.tokensOut,
    costUsd: patch.costUsd === undefined ? existing.costUsd : patch.costUsd,
    summary: patch.summary === undefined ? existing.summary : patch.summary,
    outputMd: patch.outputMd === undefined ? existing.outputMd : patch.outputMd,
    error: patch.error === undefined ? existing.error : patch.error,
  })
  return getRun(db, id) as TicketRun
}

/**
 * 为 ticket 抢 lease 并插入 running run。
 * ttlMs 默认 50 分钟。过期 lease 在同一事务里被标 timeout,随后可被抢占。
 */
export function acquireLease(
  db: TaskboardDb,
  ticketId: string,
  stageId: string,
  owner: string,
  ttlMs: number = GUARDRAIL_DEFAULTS.leaseTtlMs,
  opts: AcquireLeaseOptions = {},
): TicketRun {
  const now = opts.now ?? nowMs()
  const expiresAt = now + ttlMs

  const ticket = db.prepare('SELECT id FROM tb_ticket WHERE id = ?').get(ticketId) as
    | { id: string }
    | undefined
  if (!ticket) throw new TaskboardNotFound('ticket', ticketId)

  const run = db.transaction(() => {
    expireLeasesOnTicket(db, ticketId, now)
    const held = findActiveLease(db, ticketId, now)
    if (held) {
      throw new TaskboardLeaseHeld(
        ticketId,
        held.lease_owner ?? 'unknown',
        held.lease_expires_at ?? 0,
      )
    }

    let agentId = opts.agentId ?? null
    if (agentId == null) {
      const stage = db
        .prepare('SELECT agent_id FROM tb_pipeline_stage WHERE id = ?')
        .get(stageId) as { agent_id: string | null } | undefined
      agentId = stage?.agent_id ?? null
    }

    return insertRun(db, {
      ticketId,
      stageId,
      agentId,
      trigger: opts.trigger ?? 'patrol',
      status: 'running',
      leaseOwner: owner,
      leaseExpiresAt: expiresAt,
      startedAt: now,
    })
  })
  return run.immediate()
}

/** 清掉 run 上的 lease。不改 status;调用方随后 updateRun 写终态。 */
export function releaseLease(db: TaskboardDb, runId: string, owner?: string): TicketRun {
  const existing = getRun(db, runId)
  if (!existing) throw new TaskboardNotFound('run', runId)
  if (owner && existing.leaseOwner && existing.leaseOwner !== owner) {
    throw new TaskboardLeaseHeld(
      existing.ticketId,
      existing.leaseOwner,
      existing.leaseExpiresAt ?? 0,
    )
  }
  return updateRun(db, runId, { leaseOwner: null, leaseExpiresAt: null })
}

/** 把所有已过期仍占着的 lease 标成 timeout,返回被回收的 run。 */
export function reapExpiredLeases(db: TaskboardDb, now: number = nowMs()): TicketRun[] {
  const rows = db
    .prepare(
      `SELECT ${RUN_COLS} FROM tb_ticket_run
        WHERE lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
          AND status IN ${ACTIVE_LEASE_STATUSES}`,
    )
    .all(now) as RunRow[]
  if (rows.length === 0) return []

  const reap = db.transaction(() => {
    for (const row of rows) {
      expireLeasesOnTicket(db, row.ticket_id, now)
    }
  })
  reap.immediate()
  return rows.map((row) => getRun(db, row.id)).filter((run): run is TicketRun => run !== null)
}

export function getActiveLease(
  db: TaskboardDb,
  ticketId: string,
  now: number = nowMs(),
): TicketRun | null {
  const row = findActiveLease(db, ticketId, now)
  return row ? mapRun(row) : null
}
