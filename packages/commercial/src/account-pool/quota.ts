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
 * 内部共享 core writer — Anthropic header 路径与 codex notification 路径都走这里,
 * 保证两个入口共享 lastAttempt + outstanding 模块状态(防止双写同一账号)。
 *
 * 调用前已经把 raw 输入解析成 number(0..100)/Date/null,本函数只负责:
 *  1) 全 null 早返
 *  2) 进程内 30s throttle(per accountId)
 *  3) 全局 outstanding cap 检查
 *  4) SQL UPDATE(自带 WHERE 兜底节流)
 *  5) outstanding 计数 finally 恢复
 *
 * 永不抛(catch swallow),调用方 .catch(() => {}) 兜底也无副作用。
 */
async function _writeQuotaCore(
  pool: Pool,
  key: string,
  util5h: number | null,
  reset5h: Date | null,
  util7d: number | null,
  reset7d: Date | null,
  now: () => number,
): Promise<void> {
  if (util5h === null && reset5h === null && util7d === null && reset7d === null) {
    return
  }

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
    //
    // codex 路径(Issue A v1.0.108)上单窗口 plan 会 partial 写,COALESCE 让另一组
    // 沿用旧值,但 quota_updated_at 仍刷新 — 同 Anthropic partial 假设,目前可接受。
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
  // legacy/无关联账号防御:bigint 0n / 字符串 "0" 是 anthropicProxy 在没 per-account
  // 关联时塞的占位值,SQL 无 id=0 的行,跳过避免无意义 throttle 占位。
  const key = String(accountId)
  if (key === '0') return

  const util5h = parseUtil(headers.get('anthropic-ratelimit-unified-5h-utilization'))
  const reset5h = parseResetEpoch(headers.get('anthropic-ratelimit-unified-5h-reset'))
  const util7d = parseUtil(headers.get('anthropic-ratelimit-unified-7d-utilization'))
  const reset7d = parseResetEpoch(headers.get('anthropic-ratelimit-unified-7d-reset'))
  await _writeQuotaCore(pool, key, util5h, reset5h, util7d, reset7d, now)
}

/**
 * Issue A v1.0.108 — codex `account/rateLimits/updated` 通知 → claude_accounts 配额。
 *
 * 入参 snap 已经在 gateway/codexAppServerRunner._parseCodexRateLimits 解析为
 * Anthropic-shape(util 0..100 number, reset ISO8601 string),本函数只校验类型 +
 * 转换为 _writeQuotaCore 期望的 (number|null, Date|null) 后委派。
 *
 * 与 maybeUpdateAccountQuota 共享模块级 lastAttempt + outstanding,
 * 同账号双路径都打不会两边 30s 各刷一次。
 *
 * fire-and-forget 语义、永不抛 — 与 header 路径一致。
 */
export async function maybeUpdateAccountQuotaCodex(
  pool: Pool,
  accountId: bigint | string,
  snap: {
    util5h?: number
    reset5h?: string
    util7d?: number
    reset7d?: string
  },
  now: () => number = Date.now,
): Promise<void> {
  // legacy/无关联账号防御(Codex review NEEDS-FIX 3):0n 在 ledger 路径表示
  // "无 per-account 关联",写 quota 没意义且会污染 lastAttempt Map。
  const key = String(accountId)
  if (key === '0') return

  const validUtil = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
  const validReset = (v: unknown): Date | null => {
    if (typeof v !== 'string' || v.length === 0) return null
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t) : null
  }

  const util5h = validUtil(snap.util5h)
  const reset5h = validReset(snap.reset5h)
  const util7d = validUtil(snap.util7d)
  const reset7d = validReset(snap.reset7d)
  await _writeQuotaCore(pool, key, util5h, reset5h, util7d, reset7d, now)
}
