/**
 * M9 — 账号配额可见性。
 *
 * Anthropic 在 chat 响应头返:
 *   anthropic-ratelimit-unified-5h-utilization   "0.92"  (fraction)
 *   anthropic-ratelimit-unified-5h-reset         "1714425600"  (unix epoch sec)
 *   anthropic-ratelimit-unified-7d-utilization
 *   anthropic-ratelimit-unified-7d-reset
 *
 * 本模块把这 4 个 header 解析后落到 claude_accounts 对应行,admin UI 显示。
 *
 * **节流双层**:
 *   1. 进程内 per-account Map (`lastAttempt`) — 30s 内 return,直接不打 SQL
 *   2. SQL `WHERE quota_updated_at IS NULL OR NOW() - quota_updated_at > 30s` —
 *      多进程/竞态兜底
 *
 * **全局 outstanding cap (32)**:防 PG 抖动时 fire-and-forget 堆积 promise
 * 占用连接拖累结算路径(deps.pgPool 共享)。超 cap 直接 skip,不 await。
 *
 * **故意不做**:
 *   - 不主动调 /api/oauth/usage(被动头覆盖活跃账号)
 *   - 不细分 opus/sonnet(boss 没要)
 *   - 不写历史时序(本次只做"当前快照"可见性)
 */

import type { Pool } from 'pg'

/** 30 秒节流窗口 — 双层防护(JS Map + SQL WHERE)。 */
export const QUOTA_THROTTLE_MS = 30 * 1000

/** 全局并发 fire-and-forget 写入上限。超出 → skip。 */
export const QUOTA_OUTSTANDING_CAP = 32

/** Headers-like 抽象 — fetch Response.headers 与测试 mock 都能用。 */
export interface HeaderGetter {
  get(name: string): string | null
}

/**
 * 解析 utilization header 值为百分比 (0-100)。
 * - null / 空字符串 / NaN → null
 * - 一律按 Anthropic 文档约定的 fraction 0-1 解析,× 100 后 clamp 到 [0, 100]
 *
 * 历史:曾尝试 ">1 视作 percent" 的双解模式作为防御,但会导致 fraction=1.2
 * (上游表示"已达 120% 超限")被错读为 1.2%,把红色告警直接吞掉。Codex 反馈后
 * 改为单一 fraction 解读 — Anthropic 真换 percent 格式我们再改,不在解析层做歧义防御。
 *
 * 边界 "1" → 100%(语义"达到限额")。
 */
export function parseUtil(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n * 100))
}

/**
 * 解析 reset epoch header 为 Date。
 * 兼容秒(< 1e12)与毫秒(>= 1e12)。
 */
export function parseResetEpoch(v: string | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n >= 1e12 ? n : n * 1000)
}

// ─── 节流状态 ─────────────────────────────────────────────────────

/**
 * Per-account 上次尝试 UPDATE 的时间(JS 内存)。
 * 第一层节流:30s 内同账号直接不打 SQL。
 *
 * Map 不主动清理 — 账号数有限(<1000),长跑进程内存可控;
 * 真要彻底清,可在 LRU evict / process restart 时清,目前不必要。
 */
const lastAttempt = new Map<string, number>()

/** 全局 outstanding 计数(fire-and-forget 写入未 settle 的)。 */
let outstanding = 0

/** 测试 hook — 重置内部状态(throttle map / 计数)。 */
export function _resetQuotaState(): void {
  lastAttempt.clear()
  outstanding = 0
}

/** 测试 hook — 暴露当前 outstanding(诊断)。 */
export function _quotaOutstanding(): number {
  return outstanding
}

// ─── 主入口 ───────────────────────────────────────────────────────

/**
 * 从 headers 解析配额并尝试 UPDATE 账号。
 *
 * **fire-and-forget 语义**:返 Promise<void>,失败 → resolve(swallow);
 * 调用方 `.catch(() => {})` 兜一下也无所谓。永远不抛。
 *
 * @param pool       PG 池(与结算路径共用,所以本函数刻意 best-effort)
 * @param accountId  bigint,内部 toString 走 ::bigint cast
 * @param headers    fetch Response.headers / 任何 .get(name) 接口
 * @param now        测试可注入(默认 Date.now())
 */
export async function maybeUpdateAccountQuota(
  pool: Pool,
  accountId: bigint | string,
  headers: HeaderGetter,
  now: () => number = Date.now,
): Promise<void> {
  // 解析 4 个 header — 全 null 直接 return,不算失败。
  const util5h = parseUtil(headers.get('anthropic-ratelimit-unified-5h-utilization'))
  const reset5h = parseResetEpoch(headers.get('anthropic-ratelimit-unified-5h-reset'))
  const util7d = parseUtil(headers.get('anthropic-ratelimit-unified-7d-utilization'))
  const reset7d = parseResetEpoch(headers.get('anthropic-ratelimit-unified-7d-reset'))
  if (util5h === null && reset5h === null && util7d === null && reset7d === null) {
    return
  }

  const key = String(accountId)

  // 第一层:进程内 30s throttle
  const t = now()
  const last = lastAttempt.get(key)
  if (last !== undefined && t - last < QUOTA_THROTTLE_MS) {
    return
  }

  // 全局 cap 检查放在 lastAttempt.set 之前(Codex review 反馈):
  // 否则 cap skip 时本进程会把该账号 throttle 30s 但其实没真打 SQL,
  // PG 抖动期间会把短暂 backpressure 放大成"账号级静默 30s"。
  if (outstanding >= QUOTA_OUTSTANDING_CAP) {
    return
  }
  lastAttempt.set(key, t)
  outstanding++
  try {
    // 第二层:SQL WHERE 节流(多进程/竞态兜底)
    // 用 INTERVAL '30 seconds' 与 JS 节流同步;多进程下保证不会 1 秒内打 N 次。
    //
    // **partial-header 假设**(Codex review 反馈):COALESCE 让 5h-only 或 7d-only
    // 响应只更新对应字段,但 quota_updated_at 一并刷新到 NOW。这意味着如果上游
    // 偶发只返一组 header,UI 会把"未刷新的另一组"误当 fresh。
    // 当前 prod Anthropic 行为是两组 header 永远同时返,该假设成立;
    // 若未来出现 partial 模式,改为拆 quota_5h_updated_at / quota_7d_updated_at。
    await pool.query(
      `UPDATE claude_accounts
          SET quota_5h_pct       = COALESCE($2::numeric, quota_5h_pct),
              quota_5h_resets_at = COALESCE($3::timestamptz, quota_5h_resets_at),
              quota_7d_pct       = COALESCE($4::numeric, quota_7d_pct),
              quota_7d_resets_at = COALESCE($5::timestamptz, quota_7d_resets_at),
              quota_updated_at   = NOW()
        WHERE id = $1::bigint
          AND (quota_updated_at IS NULL
               OR NOW() - quota_updated_at > INTERVAL '30 seconds')`,
      [key, util5h, reset5h, util7d, reset7d],
    )
  } catch {
    // 故意吞 — 配额可见性是 nice-to-have,不能影响 chat 主路径。
    // 调用方已 .catch(() => {}),这里再保险一次。
  } finally {
    outstanding--
  }
}
