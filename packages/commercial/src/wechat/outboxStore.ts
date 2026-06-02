/**
 * v3 commercial WeChat broker — wechat_outbox 数据访问层。
 *
 * 详见 docs/v3/wechat-broker-design.md §4.6 + migrations/0066_*.sql 表头注释。
 *
 * **状态机**(对齐 0066 注释,严格遵守):
 *   queued  → sending  → sent     (happy path)
 *   queued  → sending  → failed   (>=maxAttempts;终态)
 *   queued  → sending  → queued   (<maxAttempts;release 重试,attempts 单调递增不清零)
 *   sending(stale locked_at)→ queued (releaseStaleSending 兜底 worker crash)
 *   sent     保留 24h tombstone(purgeSentTombstones 清)
 *   failed   保留 7d(purgeFailedAged 清,防无限堆积)
 *
 * **跨重启幂等核心**:`outbound_id` UNIQUE + 行存在判定:
 *   - 'sent' tombstone 内 → 返 already_sent(借 24h 保留拦二次下发)
 *   - 'queued'/'sending' → 返 pending(broker 在处理中)
 *   - 'failed' + attempts < maxAttempts → reset 'queued',**attempts 保留**(防止 container
 *     反复重发触发 broker 反复 retry 死循环)
 *   - 'failed' + attempts >= maxAttempts → 返 already_failed(broker 已放弃,container 不应再发)
 *
 * **关键不变量**:
 *   - attempts 单调递增,任何 reset 路径不清零(包括 enqueue stale revive 路径)
 *   - 'sent' 行必有 sent_at(SQL CHECK wox_sent_consistency_chk 强制)
 *   - dropAgedPending 强转 attempts=maxAttempts,使后续 enqueue 永走 already_failed 分支(防复活)
 */

import type { Pool, PoolClient } from "pg"
import { tx } from "../db/queries.js"
import type { IlinkPart, OutboxRow, OutboxStatus } from "./types.js"

/** 默认 maxAttempts;P3 可改为 binding-level 配置。 */
export const DEFAULT_MAX_ATTEMPTS = 10

/** sending 状态 lock 超时(stale 判定);worker pick 5 min 未完成视为崩,release。 */
export const STALE_SENDING_MS = 5 * 60 * 1000

/** sent tombstone 保留期 — daemon 周期清。 */
export const SENT_TOMBSTONE_MS = 24 * 60 * 60 * 1000

/** failed 终态保留期 — 防无限堆积。 */
export const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** queued/sending row 老化判定(24h 未送达即放弃)。 */
export const AGE_CUTOFF_MS = 24 * 60 * 60 * 1000

interface RawOutboxRow {
  id: number | string // pg numeric → string 偶发,Number() 兜底
  outbound_id: string
  binding_user_id: string
  sender_id: string
  session_id: string
  payload: IlinkPart[] // pg JSONB → object
  status: OutboxStatus
  attempts: number
  last_error: string | null
  locked_at: number | string | null
  sent_at: number | string | null
  next_attempt_at?: number | string | null
  created_at: number | string
  updated_at: number | string
}

function rowToOutbox(r: RawOutboxRow): OutboxRow {
  return {
    id: Number(r.id),
    outboundId: r.outbound_id,
    bindingUserId: r.binding_user_id,
    senderId: r.sender_id,
    sessionId: r.session_id,
    payload: r.payload,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    lockedAt: r.locked_at === null ? null : Number(r.locked_at),
    sentAt: r.sent_at === null ? null : Number(r.sent_at),
    nextAttemptAt: r.next_attempt_at == null ? null : Number(r.next_attempt_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export interface EnqueueParams {
  outboundId: string
  bindingUserId: string
  senderId: string
  sessionId: string
  payload: IlinkPart[]
  now: number
}

export type EnqueueOutcome = "queued" | "already_sent" | "pending" | "already_failed"

export interface EnqueueResult {
  outcome: EnqueueOutcome
  /** 新插入 / 命中现有行 / reset 现有行 — 都给 id 方便 worker 直接 pick。 */
  outboxId: number
  /** 写入后行最终 attempts 值(reset/已存在场景反映现状)。 */
  attempts: number
}

/**
 * 入站幂等的核心函数。详见模块头注释中的状态机表。
 *
 * 走 tx + `FOR UPDATE` 行锁保证 SELECT-then-UPDATE 串行;**单次 enqueue 最多一条 SQL UPDATE**
 * (要么 INSERT,要么 reset 路径 UPDATE),不存在 N+1。
 */
export async function enqueue(
  pool: Pool,
  params: EnqueueParams,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<EnqueueResult> {
  return tx(async (client) => enqueueInTx(client, params, maxAttempts), pool)
}

async function enqueueInTx(
  client: PoolClient,
  params: EnqueueParams,
  maxAttempts: number,
): Promise<EnqueueResult> {
  // Codex slice 3 r1 WARN: 并发首次入队幂等。
  // 老路径"先 SELECT FOR UPDATE 然后 INSERT" 在行不存在时 SELECT 锁不到任何东西,两个同
  // outboundId 并发首次入队都会走 INSERT,其一撞 UNIQUE 抛 23505。
  // 改用 `INSERT ... ON CONFLICT (outbound_id) DO NOTHING RETURNING id`:成功 → 新行 id;
  // 冲突 → rowCount=0,后续 SELECT FOR UPDATE 等另一个 tx commit 后读到权威现有行,走状态机分支。
  const ins = await client.query<{ id: number | string }>(
    `INSERT INTO wechat_outbox
       (outbound_id, binding_user_id, sender_id, session_id, payload,
        status, attempts, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', 0, $6, $6)
     ON CONFLICT (outbound_id) DO NOTHING
     RETURNING id`,
    [
      params.outboundId,
      params.bindingUserId,
      params.senderId,
      params.sessionId,
      JSON.stringify(params.payload),
      params.now,
    ],
  )
  if ((ins.rowCount ?? 0) > 0) {
    return { outcome: "queued", outboxId: Number(ins.rows[0]!.id), attempts: 0 }
  }

  // 行已存在(可能是历史行,也可能是同瞬间另一个 tx 刚 commit 的并发入队)。
  // FOR UPDATE 在此能等到对方 commit 后读到最终状态。
  const existing = await client.query<{
    id: number | string
    status: OutboxStatus
    attempts: number
  }>(
    "SELECT id, status, attempts FROM wechat_outbox WHERE outbound_id = $1 FOR UPDATE",
    [params.outboundId],
  )
  if (existing.rowCount === 0) {
    // 极罕见:行被 purge daemon 在两次查询间删除。重抛让上层 retry。
    throw new Error(
      `wechat_outbox.enqueue: row vanished between INSERT ON CONFLICT and SELECT (outbound_id=${params.outboundId})`,
    )
  }

  const row = existing.rows[0]!
  const id = Number(row.id)
  switch (row.status) {
    case "sent":
      return { outcome: "already_sent", outboxId: id, attempts: row.attempts }
    case "queued":
    case "sending":
      return { outcome: "pending", outboxId: id, attempts: row.attempts }
    case "failed": {
      if (row.attempts >= maxAttempts) {
        return { outcome: "already_failed", outboxId: id, attempts: row.attempts }
      }
      // Reset 'failed' → 'queued' 保留 attempts(防止 container 重发触发 broker 反复 retry)
      await client.query(
        `UPDATE wechat_outbox
           SET status     = 'queued',
               locked_at  = NULL,
               next_attempt_at = NULL,
               last_error = NULL,
               updated_at = $1
         WHERE id = $2`,
        [params.now, id],
      )
      return { outcome: "queued", outboxId: id, attempts: row.attempts }
    }
  }
}

/**
 * 取出一条 queued 行并标记 sending,原子;**用 CTE + FOR UPDATE SKIP LOCKED** 模式,
 * 多 worker(P3)安全。返回 null 表示无 queued 行可拿。
 *
 * Worker 调用:
 *   const row = await pickOne(pool, now)
 *   if (!row) return  // empty queue
 *   try sendText(...)
 *     succ → markSent(id)
 *     fail → markFailed(id, err, maxAttempts)
 */
export async function pickOne(pool: Pool, now: number): Promise<OutboxRow | null> {
  const res = await pool.query<RawOutboxRow>(
    `WITH picked AS (
       SELECT w.id FROM wechat_outbox w
       WHERE w.status = 'queued'
         AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= $1)
         AND NOT EXISTS (
           SELECT 1 FROM wechat_outbox older
           WHERE older.status IN ('queued', 'sending')
             AND older.binding_user_id IS NOT DISTINCT FROM w.binding_user_id
             AND older.sender_id       IS NOT DISTINCT FROM w.sender_id
             AND older.session_id      IS NOT DISTINCT FROM w.session_id
             AND (
               older.created_at < w.created_at
               OR (older.created_at = w.created_at AND older.id < w.id)
             )
         )
       ORDER BY w.created_at ASC, w.id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE wechat_outbox SET
       status     = 'sending',
       locked_at  = $1,
       next_attempt_at = NULL,
       updated_at = $1
     FROM picked
     WHERE wechat_outbox.id = picked.id
     RETURNING wechat_outbox.id, outbound_id, binding_user_id, sender_id, session_id,
               payload, status, attempts, last_error, locked_at, sent_at,
               next_attempt_at, created_at, updated_at`,
    [now],
  )
  if (res.rowCount === 0) return null
  return rowToOutbox(res.rows[0]!)
}

/**
 * 把 sending 行翻成 sent + 打 sent_at tombstone。
 * 只匹配 status='sending' 防止状态错乱(罕见但严防)。
 */
export async function markSent(pool: Pool, id: number, now: number): Promise<boolean> {
  const res = await pool.query(
    `UPDATE wechat_outbox SET
       status     = 'sent',
       sent_at    = $1,
       last_error = NULL,
       locked_at  = NULL,
       next_attempt_at = NULL,
       updated_at = $1
     WHERE id = $2 AND status = 'sending'`,
    [now, id],
  )
  return (res.rowCount ?? 0) > 0
}

export interface MarkFailedResult {
  /** true = 已转 'failed' 终态;false = release 回 'queued' 等下次 pick。 */
  permanent: boolean
  attempts: number
}

/**
 * sending → failed (或 release 回 queued) 的统一入口。
 *
 * 原子 SQL,attempts+1 后用 CASE 决定:>=maxAttempts → 'failed' 终态;<maxAttempts → 'queued'
 * release 重试。**attempts 永不清零**(贯穿整个表生命周期)。
 *
 * 只匹配 status='sending' — 调用方误对 queued/sent/failed 行调本函数返回 null,broker.ts 必须
 * 兜底处理(我没在此 throw,因为正常流程不会触发,加 throw 只是 noise)。
 */
export async function markFailed(
  pool: Pool,
  id: number,
  errMessage: string,
  now: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  nextAttemptAt: number | null = null,
): Promise<MarkFailedResult | null> {
  const truncErr = errMessage.length > 1000 ? errMessage.slice(0, 1000) : errMessage
  const res = await pool.query<{ attempts: number; status: OutboxStatus }>(
    `UPDATE wechat_outbox SET
       attempts   = attempts + 1,
       status     = CASE WHEN attempts + 1 >= $1 THEN 'failed' ELSE 'queued' END,
       last_error = $2,
       locked_at  = NULL,
       next_attempt_at = CASE WHEN attempts + 1 >= $1 THEN NULL ELSE $5 END,
       updated_at = $3
     WHERE id = $4 AND status = 'sending'
     RETURNING attempts, status`,
    [maxAttempts, truncErr, now, id, nextAttemptAt],
  )
  if (res.rowCount === 0) return null
  const r = res.rows[0]!
  return { permanent: r.status === "failed", attempts: r.attempts }
}

/**
 * 把卡在 sending > STALE_SENDING_MS 的行 release 回 queued,attempts 不变。
 * P1 单 worker 几乎不触发(进程崩才会有 stale);P3 多 worker 必备。
 */
export async function releaseStaleSending(
  pool: Pool,
  now: number,
  staleMs: number = STALE_SENDING_MS,
): Promise<number> {
  const cutoff = now - staleMs
  const res = await pool.query(
    `UPDATE wechat_outbox SET
       status     = 'queued',
       locked_at  = NULL,
       next_attempt_at = NULL,
       updated_at = $1
     WHERE status = 'sending' AND locked_at IS NOT NULL AND locked_at < $2`,
    [now, cutoff],
  )
  return res.rowCount ?? 0
}

/**
 * 把 queued/sending 中 created_at 老于 AGE_CUTOFF_MS 的行强转 failed,attempts=maxAttempts。
 *
 * **关键设计**:attempts 直接拉到 cap,使后续 enqueue 命中同 outbound_id 时永走 already_failed
 * 分支不会复活(详见模块头状态机注释)。
 */
export async function dropAgedPending(
  pool: Pool,
  now: number,
  ageMs: number = AGE_CUTOFF_MS,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<number> {
  const cutoff = now - ageMs
  const res = await pool.query(
    `UPDATE wechat_outbox SET
       status     = 'failed',
       attempts   = $1,
       last_error = 'dropped: age cutoff exceeded',
       locked_at  = NULL,
       next_attempt_at = NULL,
       updated_at = $2
     WHERE status IN ('queued', 'sending') AND created_at < $3`,
    [maxAttempts, now, cutoff],
  )
  return res.rowCount ?? 0
}

/** DELETE 已发送 tombstone(daemon 周期清,默认 24h)。 */
export async function purgeSentTombstones(
  pool: Pool,
  now: number,
  ttlMs: number = SENT_TOMBSTONE_MS,
): Promise<number> {
  const cutoff = now - ttlMs
  const res = await pool.query(
    "DELETE FROM wechat_outbox WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at < $1",
    [cutoff],
  )
  return res.rowCount ?? 0
}

/** DELETE 已 failed 终态行(daemon 周期清,默认 7d),防止 failed 行无限堆积。 */
export async function purgeFailedAged(
  pool: Pool,
  now: number,
  ttlMs: number = FAILED_RETENTION_MS,
): Promise<number> {
  const cutoff = now - ttlMs
  const res = await pool.query(
    "DELETE FROM wechat_outbox WHERE status = 'failed' AND updated_at < $1",
    [cutoff],
  )
  return res.rowCount ?? 0
}
