/**
 * Gateway 补价的集中 fail-closed 判定。
 *
 * 原则:只有能证明「我算出来的口径 == 结算实际扣的口径」时才允许写 cost。
 * 任何一处证明不了 → 保持 0,由调用方标 costImprecise。
 *
 * 引擎策略是显式枚举。未知引擎默认不补(新增引擎必须在表里登记,
 * 禁止 `if (engine !== 'ccb')` 这种取反默认补)。
 */

import type { TurnWaiveReason } from '@openclaude/protocol'

export type CostBackfillEngineId = 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode'

export type TerminalBillingStatus = 'success' | 'error' | 'unavailable'

export interface EngineBackfillStrategy {
  /** 该引擎是否允许 gateway 用 catalog 价补 usage.cost。 */
  allowBackfill: boolean
  /** 结算是否走 model × agent 复合倍率。 */
  composeAgentMultiplier: boolean
  /**
   * 结算是否只在 engineStatus==='success' 时扣费。
   * true → error/unavailable 必须保持 0(对齐 cursorExternalSettle / zcodeCatalogSettle)。
   * false → 错误终态仍可能扣(对齐 codexFinalizer:正 token 仍 debit)。
   */
  chargeOnlyOnSuccess: boolean
}

/**
 * 显式引擎策略表。未知 key 不在这张表里 → resolveBackfillPolicy 走 engine_unknown。
 *
 * grok 与审查员「不复合」的直觉不同:Grok 走 engine-reported + outbound.codex_billing,
 * inbound 与 durable journal 都 `composeMultiplier(model, agent)`(userChatBridge:5716-5733,
 * durableCodexBilling:300-303)。表必须跟结算走,否则 override=1.500 会静默低记。
 */
export const ENGINE_BACKFILL_STRATEGIES: {
  readonly [K in CostBackfillEngineId]: EngineBackfillStrategy
} = {
  ccb: { allowBackfill: false, composeAgentMultiplier: false, chargeOnlyOnSuccess: false },
  codex: { allowBackfill: true, composeAgentMultiplier: true, chargeOnlyOnSuccess: false },
  grok: { allowBackfill: true, composeAgentMultiplier: true, chargeOnlyOnSuccess: false },
  cursor: { allowBackfill: true, composeAgentMultiplier: false, chargeOnlyOnSuccess: true },
  zcode: { allowBackfill: true, composeAgentMultiplier: false, chargeOnlyOnSuccess: true },
}

export type BackfillPolicyDecision =
  | {
      ok: true
      engine: CostBackfillEngineId
      composeAgentMultiplier: boolean
      reason: 'aligned'
    }
  | {
      ok: false
      reason: string
      markImprecise: boolean
    }

export interface BackfillPolicyInput {
  engine?: string
  usage: {
    cost?: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  sessionCostUsd: number
  prevCostUsd: number
  waiveReason?: TurnWaiveReason
  /** TurnSummary.isError。与 terminalBillingStatus 一起证明「结算会不会扣 0」。 */
  isError?: boolean
  /**
   * 终态计费侧信道 status。
   * cursor/zcode = EngineExternalBillingEvent.status(即 settle 的 engineStatus);
   * codex/grok = EngineBillingEvent.status。
   */
  terminalBillingStatus?: TerminalBillingStatus
}

function usageTokenTotal(usage: BackfillPolicyInput['usage']): number {
  return (
    (usage.inputTokens || 0) +
    (usage.outputTokens || 0) +
    (usage.cacheReadTokens || 0) +
    (usage.cacheCreationTokens || 0)
  )
}

function isKnownEngine(engine: string): engine is CostBackfillEngineId {
  return Object.prototype.hasOwnProperty.call(ENGINE_BACKFILL_STRATEGIES, engine)
}

/**
 * 集中判定:本轮能不能补价、该不该复合 agent 倍率。
 * 每条拒绝分支都带可判别 reason,便于排查。
 */
export function resolveBackfillPolicy(input: BackfillPolicyInput): BackfillPolicyDecision {
  if ((input.usage.cost ?? 0) > 0) {
    return { ok: false, reason: 'already_has_cost', markImprecise: false }
  }
  if (input.sessionCostUsd !== input.prevCostUsd) {
    return { ok: false, reason: 'session_cost_moved', markImprecise: false }
  }
  if (input.waiveReason) {
    return { ok: false, reason: 'waive_reason', markImprecise: false }
  }
  if (usageTokenTotal(input.usage) <= 0) {
    return { ok: false, reason: 'zero_tokens', markImprecise: false }
  }
  if (input.usage.outputTokens === 0) {
    return { ok: false, reason: 'zero_output_waiver', markImprecise: false }
  }

  const engine = input.engine?.trim()
  if (!engine) {
    return { ok: false, reason: 'engine_missing', markImprecise: true }
  }
  if (!isKnownEngine(engine)) {
    return { ok: false, reason: `engine_unknown:${engine}`, markImprecise: true }
  }

  const strategy = ENGINE_BACKFILL_STRATEGIES[engine]
  if (!strategy.allowBackfill) {
    return { ok: false, reason: `engine_no_backfill:${engine}`, markImprecise: true }
  }

  if (strategy.chargeOnlyOnSuccess) {
    const settleZero = settleChargesZeroOnError(input)
    if (settleZero) return settleZero
  }

  return {
    ok: true,
    engine,
    composeAgentMultiplier: strategy.composeAgentMultiplier,
    reason: 'aligned',
  }
}

/**
 * 覆盖 cursorExternalSettle.planCursorExternalSettle / zcodeCatalogSettle 判 0 的
 * engineStatus !== 'success' 条件。
 *
 * 信号优先级:
 *   1. terminalBillingStatus 存在 → 它就是 settle 收到的 engineStatus,以它为准
 *   2. 否则 result.isError===true → adapter 错误终态,cursor/zcode 的 status 不会是 success
 *   3. 两者都缺 → 证明不了 success,fail-closed
 */
function settleChargesZeroOnError(input: BackfillPolicyInput): BackfillPolicyDecision | null {
  if (input.terminalBillingStatus !== undefined) {
    if (input.terminalBillingStatus !== 'success') {
      return { ok: false, reason: 'terminal_billing_not_success', markImprecise: true }
    }
    return null
  }
  if (input.isError === true) {
    return { ok: false, reason: 'turn_is_error', markImprecise: true }
  }
  if (input.isError !== false) {
    return { ok: false, reason: 'success_unproven', markImprecise: true }
  }
  return null
}
