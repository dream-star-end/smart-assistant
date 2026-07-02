// 技能训练/评测的积分成本:估算(运行前确认对话框)与实报(运行后按实际用量折算)。
// 费率单一权威 = GET /api/public/models 的 *_per_ktok_credits(**已含 multiplier**,
// 与 master 计费公式同源:credits = Σ tokens/1000 × per_ktok_credits,计费侧向上取整)。
// 估算只是量级参考,实际扣费以账单为准 —— UI 文案必须同时给出两者。
import type { PublicModel } from './types'

export interface ModelRates {
  modelId: string
  displayName: string
  inputPerKtok: number
  outputPerKtok: number
  cacheReadPerKtok: number
  cacheWritePerKtok: number
}

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turns?: number
}

/** PublicModel(字符串费率)→ 数值费率;字段缺失/不可解析返回 null。 */
export function ratesFromPublicModel(m: PublicModel | undefined): ModelRates | null {
  if (!m) return null
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const input = num(m.input_per_ktok_credits)
  const output = num(m.output_per_ktok_credits)
  if (input === null || output === null) return null
  return {
    modelId: m.id,
    displayName: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id,
    inputPerKtok: input,
    outputPerKtok: output,
    cacheReadPerKtok: num(m.cache_read_per_ktok_credits) ?? 0,
    cacheWritePerKtok: num(m.cache_write_per_ktok_credits) ?? 0,
  }
}

/** 实际用量 → 积分(与计费同公式;不四舍五入,展示层再格式化)。 */
export function creditsForUsage(u: RunUsage, r: ModelRates): number {
  return (
    (u.inputTokens / 1000) * r.inputPerKtok +
    (u.outputTokens / 1000) * r.outputPerKtok +
    (u.cacheReadTokens / 1000) * r.cacheReadPerKtok +
    (u.cacheCreationTokens / 1000) * r.cacheWritePerKtok
  )
}

// 估算假设(经验量级,给确认对话框一个诚实的区间;真实消耗随任务复杂度浮动):
// 被测 turn:输入 ~8k(系统提示+技能)/输出 ~1.5k;grader turn:输入 ~6k/输出 ~1k。
const EVAL_CASE_TURN = { in: 8_000, out: 1_500 }
const EVAL_GRADE_TURN = { in: 6_000, out: 1_000 }
// 训练 run:扫会话+起草,经验 8~25 turns,输入摊到 60k~400k / 输出 6k~30k。
const TRAIN_LOW = { in: 60_000, out: 6_000 }
const TRAIN_HIGH = { in: 400_000, out: 30_000 }

export interface CreditRange {
  low: number
  high: number
}

/** 评测 run 估算:cases × (arms 个被测 turn + 1 个 grader turn),±区间 [×0.6, ×1.8]。 */
export function estimateEvalRunCredits(caseCount: number, arms: number, r: ModelRates): CreditRange {
  const perCase =
    arms * ((EVAL_CASE_TURN.in / 1000) * r.inputPerKtok + (EVAL_CASE_TURN.out / 1000) * r.outputPerKtok) +
    (EVAL_GRADE_TURN.in / 1000) * r.inputPerKtok +
    (EVAL_GRADE_TURN.out / 1000) * r.outputPerKtok
  const mid = perCase * Math.max(1, caseCount)
  return { low: mid * 0.6, high: mid * 1.8 }
}

/** 训练 run 估算(不含评测门;autoEval 开启时另加一次评测估算)。 */
export function estimateTrainRunCredits(r: ModelRates): CreditRange {
  const c = (t: { in: number; out: number }) =>
    (t.in / 1000) * r.inputPerKtok + (t.out / 1000) * r.outputPerKtok
  return { low: c(TRAIN_LOW), high: c(TRAIN_HIGH) }
}

/** 积分显示:≥1 保留 1 位,<1 保留 2 位,<0.01 显示 "<0.01"。 */
export function fmtCredits(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n > 0 && n < 0.01) return '<0.01'
  return n >= 1 ? n.toFixed(1) : n.toFixed(2)
}

export function fmtCreditRange(range: CreditRange): string {
  return `${fmtCredits(range.low)} ~ ${fmtCredits(range.high)} 积分`
}
