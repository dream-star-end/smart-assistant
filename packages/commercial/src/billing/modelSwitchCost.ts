import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { composeMultiplier, estimateModelHistoryTokens, DEFAULT_CODEX_ENGINE_MODEL,
  type ModelSwitchCostRequest, type ModelSwitchCostQuote } from '@openclaude/protocol';
import type { ModelPricing, PricingCache } from './pricing.js';
import { getAgentCostMultiplier } from './agentMultiplier.js';
import { readTotalSpendableBalance } from './preCheck.js';
import { applyFastServiceTierPricing } from '../http/proxy/fastServiceTier.js';
import { cursorSettleMultiplier } from './cursorExternalSettle.js';
import { readSwitchContext, ModelSwitchCostError } from './modelSwitchCostContext.js';
import { readSwitchCostPolicy, outputPrediction, expensiveSwitch, switchCostRange, type SwitchCostPolicy } from './modelSwitchCostPolicy.js';
export { ModelSwitchCostError };

export interface SwitchCostTarget { pricing: ModelPricing; engine: string; contextWindow: number }
export interface ModelSwitchCostDeps {
  pool: Pool;
  pricing: PricingCache;
  secret: string | Uint8Array;
  resolveTarget: (uid: string, model: string, contextTier?: '300k' | '1m') => Promise<SwitchCostTarget>;
  balance?: (uid: string) => Promise<bigint>;
  policy?: SwitchCostPolicy;
  now?: () => number;
  readContext?: typeof readSwitchContext;
}
interface Grant {
  purpose: 'quote' | 'consent'; uid: string; sessionId: string; requestId: string;
  agentId: string; target: string; source: string; context: string; revision: number;
  price: string; upperFen: string; mediaCount: number; expiresAt: number;
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const zero = () => ({ lowFen: '0', expectedFen: '0', highFen: '0' });
const noEstimate = () => new ModelSwitchCostError('MODEL_SWITCH_ESTIMATE_UNAVAILABLE', '暂时无法可靠预估该会话费用，请重试或新建会话');
export function effectiveSwitchCostModel(input: Pick<ModelSwitchCostRequest,'targetModel'|'agentId'|'teamMode'>): string {
  return input.agentId === 'main' && input.teamMode ? DEFAULT_CODEX_ENGINE_MODEL : input.targetModel;
}

/** Confirmation is a scoped one-request consent, not a balance reservation. */
export class ModelSwitchCostService {
  private readonly policy: SwitchCostPolicy;
  private readonly key: Buffer;
  private readonly now: () => number;
  constructor(private readonly deps: ModelSwitchCostDeps) {
    this.policy = deps.policy ?? readSwitchCostPolicy();
    this.key = createHmac('sha256', deps.secret).update('openclaude:model-switch-cost:v1').digest();
    this.now = deps.now ?? Date.now;
  }
  private sign(grant: Grant): string {
    const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update(body).digest('base64url');
  }
  private verify(raw: string | undefined, purpose: Grant['purpose']): Grant | null {
    if (!raw || raw.length > 4096) return null;
    const parts = raw.split('.'); if (parts.length !== 2) return null;
    const expected = createHmac('sha256',this.key).update(parts[0]).digest();
    const supplied = Buffer.from(parts[1],'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected,supplied)) return null;
    try {
      const value = JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')) as Grant;
      return value.purpose === purpose && Number.isSafeInteger(value.expiresAt) && value.expiresAt > this.now() ? value : null;
    } catch { return null; }
  }
  private async effectivePrice(price: ModelPricing, agent: string, serviceTier?: string): Promise<ModelPricing> {
    let p = { ...price, multiplier: composeMultiplier(price.multiplier, await getAgentCostMultiplier(this.deps.pool,agent)) };
    p = applyFastServiceTierPricing({ model:p.model_id, service_tier:serviceTier === 'fast' ? 'priority' : undefined },p).pricing;
    const cursorMul = cursorSettleMultiplier(p.model_id);
    if (cursorMul) p = { ...p, multiplier:composeMultiplier(p.multiplier,cursorMul) };
    return p;
  }
  private matches(grant: Grant | null, current: Grant): grant is Grant {
    return grant !== null && grant.uid === current.uid && grant.sessionId === current.sessionId &&
      grant.requestId === current.requestId && grant.agentId === current.agentId && grant.target === current.target &&
      grant.source === current.source && grant.context === current.context && grant.revision === current.revision &&
      grant.price === current.price && grant.mediaCount === current.mediaCount &&
      BigInt(grant.upperFen) >= BigInt(current.upperFen);
  }
  private async calculate(uid: string, input: ModelSwitchCostRequest): Promise<{quote:ModelSwitchCostQuote; grant?:Grant}> {
    const model = effectiveSwitchCostModel(input);
    const target = await this.deps.resolveTarget(uid,model,input.contextTier);
    const context = await (this.deps.readContext ?? readSwitchContext)(this.deps.pool,uid,input.sessionId,input.requestId,
      { engine:target.engine, contextWindow:target.contextWindow, text:input.text ?? '', targetModel:target.pricing.model_id });
    const basic: ModelSwitchCostQuote = { requestId:input.requestId, targetModel:target.pricing.model_id,
      targetName:target.pricing.display_name, sourceModel:context.sourceModel, sourceName:null,
      contextTokens:context.tokens, contextSource:context.source, outputTokens:0, sampleCount:context.outputs.length,
      targetCost:zero(), currentCost:zero(), balanceFen:'0', requiresConfirmation:false, canConfirm:true,
      expiresAt:this.now()+this.policy.ttlMs };
    if (context.source === 'empty' || context.sourceModel === target.pricing.model_id) return {quote:basic};
    if (!context.sourceModel) throw noEstimate();
    const original = this.deps.pricing.get(context.sourceModel);
    if (!original) throw noEstimate();
    const [to,from,balance] = await Promise.all([
      this.effectivePrice(target.pricing,input.agentId,input.serviceTier),
      this.effectivePrice(original,context.sourceAgent,input.serviceTier),
      (this.deps.balance ?? readTotalSpendableBalance)(uid),
    ]);
    const output = outputPrediction(context.outputs,this.policy);
    const additionalTokens = Math.max(512,estimateModelHistoryTokens(input.text ?? '')) + context.lastOutputTokens;
    const common = {contextTokens:context.tokens,additionalTokens,output,calls:context.calls};
    const targetCost = switchCostRange({...common,price:to,warmRatio:0});
    const currentCost = switchCostRange({...common,price:from,warmRatio:context.warmRatio});
    const requiresConfirmation = expensiveSwitch(BigInt(targetCost.expectedFen),BigInt(currentCost.expectedFen),this.policy);
    const quote = {...basic,sourceName:original.display_name,outputTokens:output[0],targetCost,currentCost,balanceFen:balance.toString(),
      requiresConfirmation,canConfirm:!requiresConfirmation || balance >= BigInt(targetCost.highFen)};
    if (!requiresConfirmation) return {quote};
    const price = fingerprint([to.model_id,to.input_per_mtok.toString(),to.output_per_mtok.toString(),to.cache_read_per_mtok.toString(),
      to.cache_write_per_mtok.toString(),to.multiplier,from.model_id,from.input_per_mtok.toString(),from.output_per_mtok.toString(),
      from.cache_read_per_mtok.toString(),from.cache_write_per_mtok.toString(),from.multiplier,input.contextTier ?? null,input.serviceTier ?? null]);
    const grant:Grant = {purpose:'quote',uid,sessionId:input.sessionId,requestId:input.requestId,agentId:input.agentId,
      target:to.model_id,source:context.sourceModel,context:context.fingerprint,revision:context.revision,price,
      upperFen:targetCost.highFen,mediaCount:input.mediaCount ?? 0,expiresAt:quote.expiresAt};
    return {quote:{...quote,quoteToken:this.sign(grant)},grant};
  }
  async quote(uid: string,input:ModelSwitchCostRequest,existingConsent?:string):Promise<ModelSwitchCostQuote> {
    const {quote,grant} = await this.calculate(uid,input);
    if (grant && quote.canConfirm && this.matches(this.verify(existingConsent,'consent'),grant)) {
      return {...quote,requiresConfirmation:false,consent:existingConsent};
    }
    return quote;
  }
  async confirm(uid:string,input:ModelSwitchCostRequest,quoteToken:string):Promise<ModelSwitchCostQuote> {
    const {quote,grant} = await this.calculate(uid,input);
    if (!grant) return quote;
    if (!quote.canConfirm) throw new ModelSwitchCostError('MODEL_SWITCH_INSUFFICIENT_BALANCE','可用余额不足以覆盖首轮预估，请充值或取消切换');
    if (!this.matches(this.verify(quoteToken,'quote'),grant)) {
      throw new ModelSwitchCostError('MODEL_SWITCH_QUOTE_CHANGED','费用预估或上下文已有变化，请重新确认');
    }
    return {...quote,requiresConfirmation:false,consent:this.sign({...grant,purpose:'consent'})};
  }
  async assertAuthorized(uid:string,input:ModelSwitchCostRequest,consent?:string):Promise<void> {
    const quote = await this.quote(uid,input,consent);
    if (quote.requiresConfirmation) {
      throw new ModelSwitchCostError(quote.canConfirm ? 'MODEL_SWITCH_CONFIRMATION_REQUIRED' : 'MODEL_SWITCH_INSUFFICIENT_BALANCE',
        quote.canConfirm ? '切换模型的首轮费用需要确认，请在会话中重新选择模型或重试' : '可用余额不足以覆盖切换后的首轮预估，请充值或取消切换');
    }
  }
}
