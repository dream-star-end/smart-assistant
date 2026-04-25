/**
 * M6 / P1-9 — Account OAuth refresh 事件历史。
 *
 * 用途:
 *   - 取代 accounts.last_error 单字段(只能存最后一次失败原因,被新成功覆盖即丢失)
 *   - 给 admin 提供"按账号查最近 N 次 refresh 结果"能力,支持排查 token 抖动模式
 *
 * 安全规约(P0):
 *   - `errMsg` 落库内容**必须是固定受控字符串字面量**,禁止传入 raw err.message
 *     或上游 response body 片段。原因:fetch err 可能含 proxy URL/凭据片段;
 *     上游 response body 可能含 access_token 残片。落到 admin UI 历史会泄露。
 *   - call site 必须用 RefreshErrorCode 枚举决定 errMsg,见 refresh.ts 各 throw 点。
 *
 * 一致性:
 *   - DB CHECK chk_event_consistency 强制 ok=true 时 err_code/err_msg 必 NULL,
 *     ok=false 时两者必非空
 *   - TS 类型用 discriminated union 同样强制(双重保险)
 *
 * Retention:
 *   - `purgeOlderThan(28)` 由 refreshEventsSweeper.ts 每 24h 调一次
 */

import type { QueryRunner } from '../db/queries.js'
import { query } from '../db/queries.js'
import type { RefreshErrorCode } from './refresh.js'

export interface RefreshEventRow {
  id: bigint
  account_id: bigint
  ts: Date
  ok: boolean
  err_code: RefreshErrorCode | null
  err_msg: string | null
}

interface RawRefreshEventRow {
  id: string
  account_id: string
  ts: Date
  ok: boolean
  err_code: string | null
  err_msg: string | null
}

export type RecordRefreshEventInput =
  | {
      accountId: bigint | string
      ok: true
    }
  | {
      accountId: bigint | string
      ok: false
      errCode: RefreshErrorCode
      errMsg: string
    }

/**
 * 写入一条 refresh 事件。
 *
 * 注意:account_id FK 已 ON DELETE CASCADE,所以这里**不写**
 * account_not_found 路径(账号已不存在,FK 父行缺失,INSERT 会被 FK 拒)。
 */
export async function recordRefreshEvent(
  input: RecordRefreshEventInput,
  runner?: QueryRunner,
): Promise<void> {
  if (input.ok) {
    await query(
      `INSERT INTO account_refresh_events (account_id, ok, err_code, err_msg)
       VALUES ($1, TRUE, NULL, NULL)`,
      [String(input.accountId)],
      runner,
    )
    return
  }
  await query(
    `INSERT INTO account_refresh_events (account_id, ok, err_code, err_msg)
     VALUES ($1, FALSE, $2, $3)`,
    [String(input.accountId), input.errCode, input.errMsg],
    runner,
  )
}

/** 默认/最大返回条数。admin UI 列表分页用。 */
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 500

/**
 * 按账号倒序读最近 N 条 refresh 事件。
 *
 * @param accountId 账号 id
 * @param limit 默认 50,上限 500(防 admin 误传 100k 拉爆)
 */
export async function listRefreshEvents(
  accountId: bigint | string,
  limit = DEFAULT_LIST_LIMIT,
  runner?: QueryRunner,
): Promise<RefreshEventRow[]> {
  const safeLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)))
  const res = await query<RawRefreshEventRow>(
    `SELECT id, account_id, ts, ok, err_code, err_msg
     FROM account_refresh_events
     WHERE account_id = $1
     ORDER BY ts DESC, id DESC
     LIMIT $2`,
    [String(accountId), safeLimit],
    runner,
  )
  return res.rows.map((r) => ({
    id: BigInt(r.id),
    account_id: BigInt(r.account_id),
    ts: r.ts,
    ok: r.ok,
    err_code: r.err_code as RefreshErrorCode | null,
    err_msg: r.err_msg,
  }))
}

/**
 * 删除超过 N 天的事件。返回删除行数。retention sweeper 用。
 */
export async function purgeOlderThan(days: number, runner?: QueryRunner): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0
  const res = await query(
    `DELETE FROM account_refresh_events
     WHERE ts < NOW() - ($1 || ' days')::interval`,
    [String(Math.floor(days))],
    runner,
  )
  return res.rowCount ?? 0
}
