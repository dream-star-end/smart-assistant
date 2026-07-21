/**
 * connectorSweeper — 连接器域独立定时器(设计终稿 §3 护栏;**不挂**被钉死的 idleSweep)。
 *
 * 启动门控在 index.ts:v5 控制面 leader(OC_CONTROL_PLANE_LEADER)才跑,
 * 与其它 leader 门控调度器同挂;本模块只管**活跃态转换**三职责,全部 DB CAS +
 * SKIP LOCKED 幂等:
 *
 *   1. stale executing → Plugin 的 DB dispatch fence 尚未 armed 则 failed；其余
 *      unknown(超 action 总时限 + 缓冲；"可能已发出"的写不允许二次执行)+ 销毁 params
 *   2. pending|approved 过期 → expired + 销毁 params
 *   3. connector_oauth_pending 过期行 **DELETE 整行**(未消费行密文随行销毁)
 *
 * P1#11:connector_write_ledger 的 90 天**终态** retention 已迁至统一 retention 注册表
 * (admin/auditRetention.ts,带终态谓词),**不再由本 sweeper 删**——避免两处双清理权威。
 * 本 sweeper 只做活跃→终态的状态转换(销毁 params),终态行的最终删除归 auditRetention。
 *
 * 每 tick 各职责独立 try/catch,单条失败不拖垮其余。
 */

import type { Pool } from 'pg'
import { getPool } from '../db/index.js'

export const CONNECTOR_SWEEP_INTERVAL_MS = 60_000
/** action 总时限 60s(outboundPolicy.TOTAL_TIMEOUT_MS)+ 缓冲 → 5min 视为 stale。 */
export const LEGACY_STALE_EXECUTING_AFTER = '5 minutes'
/**
 * Plugin write 的 started_at 早于媒体 staging。当前签名合同最长路径是 18 个远端媒体
 * 各 60s 串行拉取 + 600s browser action = 28min，再留 2min 给固定开销。
 * 未来提高签名合同的媒体数量或 action timeout 时必须同步提高本阈值。
 */
export const PLUGIN_STALE_EXECUTING_AFTER = '30 minutes'

export interface ConnectorSweeperHandle {
  stop(): void
  /** 测试用:立即跑一轮,返回各职责影响行数。 */
  runNow(): Promise<ConnectorSweepResult>
}

export interface ConnectorSweepResult {
  staleExecuting: number
  expired: number
  oauthDeleted: number
}

export interface ConnectorSweeperOptions {
  intervalMs?: number
  pool?: Pool
  onError?: (duty: string, err: unknown) => void
  /** 测试用:首 tick 立即跑。 */
  runOnStart?: boolean
}

async function sweepOnce(
  pool: Pool,
  onError: (duty: string, err: unknown) => void,
): Promise<ConnectorSweepResult> {
  const result: ConnectorSweepResult = {
    staleExecuting: 0,
    expired: 0,
    oauthDeleted: 0,
  }

  // ① stale executing:Plugin pre-arm 是确定未发出 → failed；legacy/armed → unknown。
  // dispatch_fence_required 默认 FALSE，既有连接器保持原保守语义。
  try {
    const r = await pool.query(
      `UPDATE connector_write_ledger
          SET status = CASE
                WHEN dispatch_fence_required AND dispatch_armed_at IS NULL THEN 'failed'
                ELSE 'unknown'
              END,
              error_code = CASE
                WHEN dispatch_fence_required AND dispatch_armed_at IS NULL
                  THEN 'PRE_DISPATCH_STALE'
                ELSE 'STALE_EXECUTING'
              END,
              finished_at = now(),
              params_enc = NULL, params_nonce = NULL
        WHERE id IN (
          SELECT id FROM connector_write_ledger
           WHERE status = 'executing'
             AND (
               (dispatch_fence_required
                 AND started_at < now() - interval '${PLUGIN_STALE_EXECUTING_AFTER}')
               OR
               (NOT dispatch_fence_required
                 AND started_at < now() - interval '${LEGACY_STALE_EXECUTING_AFTER}')
             )
           FOR UPDATE SKIP LOCKED
        )`,
    )
    result.staleExecuting = r.rowCount ?? 0
  } catch (err) {
    onError('stale_executing', err)
  }

  // ② pending|approved 过期 → expired + 销毁 params
  try {
    const r = await pool.query(
      `UPDATE connector_write_ledger
          SET status = 'expired', finished_at = now(),
              params_enc = NULL, params_nonce = NULL
        WHERE id IN (
          SELECT id FROM connector_write_ledger
           WHERE status IN ('pending','approved') AND expires_at < now()
           FOR UPDATE SKIP LOCKED
        )`,
    )
    result.expired = r.rowCount ?? 0
  } catch (err) {
    onError('expire_pending', err)
  }

  // ③ OAuth 过期行整行 DELETE(未消费行的 draft 密文随行销毁;已消费行本就无密文)
  try {
    const r = await pool.query(
      `DELETE FROM connector_oauth_pending
        WHERE state_hash IN (
          SELECT state_hash FROM connector_oauth_pending
           WHERE expires_at < now()
           FOR UPDATE SKIP LOCKED
        )`,
    )
    result.oauthDeleted = r.rowCount ?? 0
  } catch (err) {
    onError('oauth_expired', err)
  }

  // ④ ledger 90 天终态 retention 已迁至 admin/auditRetention.ts(P1#11);本 sweeper 不再删。

  return result
}

export function startConnectorSweeper(opts: ConnectorSweeperOptions = {}): ConnectorSweeperHandle {
  const intervalMs = Math.max(1_000, opts.intervalMs ?? CONNECTOR_SWEEP_INTERVAL_MS)
  const onError =
    opts.onError ??
    ((duty, err) => {
      // eslint-disable-next-line no-console
      console.warn(`[connectorSweeper] duty ${duty} failed:`, err)
    })
  let stopped = false

  const run = async (): Promise<ConnectorSweepResult> => {
    const pool = opts.pool ?? getPool()
    return sweepOnce(pool, onError)
  }

  const timer = setInterval(() => {
    if (stopped) return
    void run().catch((err) => onError('tick', err))
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  if (opts.runOnStart) void run().catch((err) => onError('tick', err))

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow: run,
  }
}
