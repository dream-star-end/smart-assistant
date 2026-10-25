import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import {
  composeMultiplier,
  multiplierToScaled,
  estimateModelHistoryTokens,
  estimateModelHistoryUtf8Bytes,
  DEFAULT_CODEX_ENGINE_MODEL,
  cursorModelSupportsContextTier,
  supportsFastServiceTier,
  type ModelSwitchCostRequest,
  type ModelSwitchCostQuote,
  type ModelSwitchUnitPrice,
} from '@openclaude/protocol'
import type { ModelPricing, PricingCache } from './pricing.js'
import { getAgentCostMultiplier } from './agentMultiplier.js'
import { readTotalSpendableBalance } from './preCheck.js'
import { applyFastServiceTierPricing } from '../http/proxy/fastServiceTier.js'
import { cursorSettleMultiplier } from './cursorExternalSettle.js'
import { readSwitchContext, ModelSwitchCostError } from './modelSwitchCostContext.js'
import {
  readSwitchCostPolicy,
  outputPrediction,
  expensiveSwitch,
  switchCostRange,
  type SwitchCostPolicy,
} from './modelSwitchCostPolicy.js'
export { ModelSwitchCostError }
export interface SwitchCostTarget {
  pricing: ModelPricing
  engine: string
  contextWindow: number
  sourcePricing?: (model: string) => ModelPricing | null
  sourceEngine?: (model: string) => string | null
  canonicalize?: (model: string) => string
}
export interface ModelSwitchCostDeps {
  pool: Pool
  pricing: PricingCache
  secret: string | Uint8Array
  resolveTarget: (
    uid: string,
    model: string,
    contextTier?: '300k' | '1m',
  ) => Promise<SwitchCostTarget>
  sourceEngine?: (model: string) => string | null
  balance?: (uid: string) => Promise<bigint>
  policy?: SwitchCostPolicy
  now?: () => number
  readContext?: typeof readSwitchContext
}
interface Grant {
  purpose: 'quote' | 'consent'
  mode: 'estimate' | 'risk'
  uid: string
  sessionId: string
  requestId: string
  agentId: string
  target: string
  source: string | null
  context: string
  revision: number
  price: string
  upperCredits: string | null
  inputBudget: number
  mediaCount: number
  balanceCredits: string
  expiresAt: number
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const priceBasis = (p: ModelPricing) => [
  p.model_id,
  p.input_per_mtok.toString(),
  p.output_per_mtok.toString(),
  p.cache_read_per_mtok.toString(),
  p.cache_write_per_mtok.toString(),
  p.multiplier,
]
export function effectiveSwitchCostModel(
  p: Pick<ModelSwitchCostRequest, 'targetModel' | 'agentId' | 'teamMode'>,
): string {
  return p.agentId === 'main' && p.teamMode ? DEFAULT_CODEX_ENGINE_MODEL : p.targetModel
}
/** Effective token prices use the same raw credit unit as chat/ledger (not CNY /100). */
export function switchUnitPrice(p: ModelPricing): ModelSwitchUnitPrice {
  const rate = (v: bigint) => {
    const scaled = v * multiplierToScaled(p.multiplier)
    const whole = scaled / 1000n
    const fraction = (scaled % 1000n).toString().padStart(3, '0').replace(/0+$/, '')
    return whole.toString() + (fraction ? `.${fraction}` : '')
  }
  return {
    input: rate(p.input_per_mtok),
    output: rate(p.output_per_mtok),
    cacheRead: rate(p.cache_read_per_mtok),
    cacheWrite: rate(p.cache_write_per_mtok),
  }
}
/** Only waive unknown-count confirmation when all input/cache possibilities and output are no dearer. */
export function switchPriceDominated(
  to: ModelPricing,
  from: ModelPricing,
  toEngine?: string | null,
  fromEngine?: string | null,
): boolean {
  const native = (engine: string | null | undefined) => engine === 'codex' || engine === 'grok'
  const inputs = (p: ModelPricing, engine: string | null | undefined) =>
    native(engine)
      ? [p.input_per_mtok, p.cache_read_per_mtok]
      : [p.input_per_mtok, p.cache_read_per_mtok, p.cache_write_per_mtok]
  const tm = multiplierToScaled(to.multiplier)
  const fm = multiplierToScaled(from.multiplier)
  // Native Codex/Grok have no cache-write category. Every supported zero rate
  // is still a real possible free path and must not be discarded as missing.
  const target = inputs(to, toEngine).map((n) => n * tm)
  const original = inputs(from, fromEngine).map((n) => n * fm)
  return (
    target.reduce((a, b) => (a > b ? a : b)) <= original.reduce((a, b) => (a < b ? a : b)) &&
    to.output_per_mtok * tm <= from.output_per_mtok * fm
  )
}
/** Scoped explicit consent; no price change, reservation, settlement or model routing. */
export class ModelSwitchCostService {
  private readonly policy: SwitchCostPolicy
  private readonly key: Buffer
  private readonly now: () => number
  constructor(private readonly deps: ModelSwitchCostDeps) {
    this.policy = deps.policy ?? readSwitchCostPolicy()
    this.key = createHmac('sha256', deps.secret).update('openclaude:model-switch-cost:v2').digest()
    this.now = deps.now ?? Date.now
  }
  private sign(grant: Grant): string {
    const body = Buffer.from(JSON.stringify(grant)).toString('base64url')
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`
  }
  private verify(raw: string | undefined, purpose: Grant['purpose']): Grant | null {
    if (!raw || raw.length > 4096) return null
    const parts = raw.split('.')
    if (parts.length !== 2) return null
    const expected = createHmac('sha256', this.key).update(parts[0]).digest()
    const supplied = Buffer.from(parts[1], 'base64url')
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null
    try {
      const g = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Grant
      return g.purpose === purpose &&
        (g.mode === 'risk' || g.mode === 'estimate') &&
        Number.isSafeInteger(g.expiresAt) &&
        g.expiresAt > this.now()
        ? g
        : null
    } catch {
      return null
    }
  }
  private async price(
    raw: ModelPricing,
    agent: string,
    engine: string,
    tier?: string,
  ): Promise<ModelPricing> {
    let p = { ...raw }
    // Match existing settlement branches; CCB/Cursor do not charge agent overrides.
    if (engine === 'codex' || engine === 'grok')
      p = {
        ...p,
        multiplier: composeMultiplier(
          raw.multiplier,
          await getAgentCostMultiplier(this.deps.pool, agent),
        ),
      }
    if (engine === 'ccb')
      p = applyFastServiceTierPricing(
        { model: p.model_id, service_tier: tier === 'fast' ? 'priority' : undefined },
        p,
      ).pricing
    const surcharge = engine === 'cursor' ? cursorSettleMultiplier(p.model_id) : null
    if (surcharge) p = { ...p, multiplier: composeMultiplier(p.multiplier, surcharge) }
    return p
  }
  private matches(g: Grant | null, n: Grant): g is Grant {
    return (
      g !== null &&
      g.mode === n.mode &&
      g.uid === n.uid &&
      g.sessionId === n.sessionId &&
      g.requestId === n.requestId &&
      g.agentId === n.agentId &&
      g.target === n.target &&
      g.source === n.source &&
      g.context === n.context &&
      g.revision === n.revision &&
      g.price === n.price &&
      g.mediaCount === n.mediaCount &&
      g.inputBudget >= n.inputBudget &&
      (n.mode === 'risk'
        ? g.upperCredits === null
        : g.upperCredits !== null &&
          n.upperCredits !== null &&
          BigInt(g.upperCredits) >= BigInt(n.upperCredits))
    )
  }
  private async calculate(
    uid: string,
    input: ModelSwitchCostRequest,
  ): Promise<{ quote: ModelSwitchCostQuote; grant?: Grant }> {
    const requested = effectiveSwitchCostModel(input)
    input = {
      ...input,
      contextTier: cursorModelSupportsContextTier(requested) ? input.contextTier : undefined,
      serviceTier: supportsFastServiceTier(requested) ? input.serviceTier : undefined,
    }
    const target = await this.deps.resolveTarget(uid, requested, input.contextTier)
    const canonical = target.pricing.model_id
    const ctx = await (this.deps.readContext ?? readSwitchContext)(
      this.deps.pool,
      uid,
      input.sessionId,
      input.requestId,
      { targetModel: canonical, targetAgent: input.agentId },
    )
    const base: ModelSwitchCostQuote = {
      mode: 'exempt',
      requestId: input.requestId,
      targetModel: canonical,
      targetName: canonical,
      sourceModel: ctx.sourceModel,
      sourceName: null,
      contextTokens: null,
      contextSource: ctx.source,
      outputTokens: null,
      sampleCount: ctx.outputs.length,
      targetCost: null,
      currentCost: null,
      targetUnitPrice: null,
      balanceCredits: null,
      requiresConfirmation: false,
      canConfirm: true,
      expiresAt: this.now() + this.policy.ttlMs,
    }
    if (
      ctx.source === 'empty' ||
      (ctx.source === 'unchanged' && ctx.sourceAgent === input.agentId) ||
      (ctx.sourceModel !== null &&
        ctx.sourceAgent === input.agentId &&
        (target.canonicalize?.(ctx.sourceModel) ??
          this.deps.pricing.get(ctx.sourceModel)?.model_id ??
          ctx.sourceModel) === canonical)
    )
      return { quote: base }
    const rawSource = ctx.sourceModel
      ? target.sourcePricing
        ? target.sourcePricing(ctx.sourceModel)
        : this.deps.pricing.get(ctx.sourceModel)
      : null
    const fromEngine = rawSource
      ? (target.sourceEngine?.(rawSource.model_id) ?? this.deps.sourceEngine?.(rawSource.model_id))
      : null
    const [to, from, balance] = await Promise.all([
      this.price(target.pricing, input.agentId, target.engine, input.serviceTier),
      rawSource && fromEngine
        ? this.price(rawSource, ctx.sourceAgent, fromEngine)
        : Promise.resolve(null),
      (this.deps.balance ?? readTotalSpendableBalance)(uid),
    ])
    const risk =
      ctx.tokens === null || ctx.source !== 'last-call' || !from || (input.mediaCount ?? 0) > 0
    let quote: ModelSwitchCostQuote = {
      ...base,
      mode: risk ? 'risk' : 'estimate',
      targetModel: to.model_id,
      targetName: to.display_name,
      sourceName: from?.display_name ?? null,
      balanceCredits: balance.toString(),
      targetUnitPrice: switchUnitPrice(to),
      contextTokens: risk ? null : ctx.tokens,
      contextSource: risk ? 'unknown' : ctx.source,
      requiresConfirmation: true,
      canConfirm: balance > 0n,
    }
    if (risk && from && switchPriceDominated(to, from, target.engine, fromEngine))
      return { quote: { ...quote, mode: 'exempt', requiresConfirmation: false } }
    if (!risk && ctx.tokens !== null && from) {
      const output = outputPrediction(ctx.outputs, this.policy)
      const additionalTokens =
        Math.max(512, estimateModelHistoryTokens(input.text ?? '')) + ctx.lastOutputTokens
      const common = {
        contextTokens: ctx.tokens,
        additionalTokens,
        additionalHighTokens:
          Math.max(512, estimateModelHistoryUtf8Bytes(input.text ?? '')) + ctx.lastOutputTokens,
        output,
        calls: ctx.calls,
      }
      const coldMode = (engine: string | null | undefined): 'input' | 'max' =>
        engine === 'codex' || engine === 'grok' ? 'input' : 'max'
      const targetCost = switchCostRange({
        ...common,
        price: to,
        warmRatio: 0,
        coldMode: coldMode(target.engine),
      })
      const currentCost = switchCostRange({
        ...common,
        price: from,
        warmRatio: ctx.warmRatio,
        coldMode: coldMode(
          target.sourceEngine?.(from.model_id) ?? this.deps.sourceEngine?.(from.model_id),
        ),
      })
      const needs = expensiveSwitch(
        BigInt(targetCost.expectedCredits),
        BigInt(currentCost.expectedCredits),
        this.policy,
      )
      quote = {
        ...quote,
        targetCost,
        currentCost,
        outputTokens: output[0],
        requiresConfirmation: needs,
        canConfirm: balance >= BigInt(targetCost.expectedCredits),
      }
      if (!needs) return { quote }
    }
    const grant: Grant = {
      purpose: 'quote',
      mode: quote.mode === 'risk' ? 'risk' : 'estimate',
      uid,
      sessionId: input.sessionId,
      requestId: input.requestId,
      agentId: input.agentId,
      target: to.model_id,
      source: ctx.sourceModel,
      context: ctx.fingerprint,
      revision: ctx.revision,
      price: hash([
        priceBasis(to),
        from ? priceBasis(from) : null,
        input.teamMode === true,
        input.contextTier ?? null,
        input.serviceTier ?? null,
      ]),
      upperCredits: quote.targetCost?.highCredits ?? null,
      inputBudget: Math.max(512, estimateModelHistoryUtf8Bytes(input.text ?? '')),
      mediaCount: input.mediaCount ?? 0,
      balanceCredits: balance.toString(),
      expiresAt: quote.expiresAt,
    }
    return { quote: { ...quote, quoteToken: this.sign(grant) }, grant }
  }
  async validateTarget(uid: string, input: ModelSwitchCostRequest): Promise<void> {
    await this.deps.resolveTarget(uid, effectiveSwitchCostModel(input), input.contextTier)
  }
  async quote(
    uid: string,
    input: ModelSwitchCostRequest,
    consent?: string,
  ): Promise<ModelSwitchCostQuote> {
    const { quote, grant } = await this.calculate(uid, input)
    return grant && quote.canConfirm && this.matches(this.verify(consent, 'consent'), grant)
      ? { ...quote, requiresConfirmation: false, consent }
      : quote
  }
  async confirm(
    uid: string,
    input: ModelSwitchCostRequest,
    quoteToken: string,
  ): Promise<ModelSwitchCostQuote> {
    const { quote, grant } = await this.calculate(uid, input)
    if (!grant) return quote
    if (!quote.canConfirm)
      throw new ModelSwitchCostError(
        'MODEL_SWITCH_INSUFFICIENT_BALANCE',
        '可用余额不足以覆盖首轮预估，请充值或取消切换',
      )
    const displayed = this.verify(quoteToken, 'quote')
    if (!this.matches(displayed, grant))
      throw new ModelSwitchCostError(
        'MODEL_SWITCH_QUOTE_CHANGED',
        '上下文或费用信息已变化，请重新确认',
      )
    return {
      ...quote,
      requiresConfirmation: false,
      consent: this.sign({ ...grant, purpose: 'consent' }),
    }
  }
  async assertAuthorized(
    uid: string,
    input: ModelSwitchCostRequest,
    consent?: string,
  ): Promise<void> {
    const q = await this.quote(uid, input, consent)
    if (q.targetCost !== null && !q.canConfirm)
      throw new ModelSwitchCostError(
        'MODEL_SWITCH_INSUFFICIENT_BALANCE',
        '可用余额不足以覆盖切换后的首轮预估，请充值或取消切换',
      )
    if (q.requiresConfirmation)
      throw new ModelSwitchCostError(
        q.canConfirm ? 'MODEL_SWITCH_CONFIRMATION_REQUIRED' : 'MODEL_SWITCH_INSUFFICIENT_BALANCE',
        q.canConfirm
          ? '切换后的首轮费用需要确认，请重新选择模型或点击重试'
          : '可用余额不足以覆盖切换后的首轮预估，请充值或取消切换',
      )
  }
}
