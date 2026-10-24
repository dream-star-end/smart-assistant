import {
  DEFAULT_CODEX_ENGINE_MODEL,
  cursorModelSupportsContextTier,
  supportsFastServiceTier,
} from '@openclaude/protocol/browser'
import type { ModelSwitchCostQuote } from '@openclaude/protocol/browser'
import type { ConfirmChoice } from '../components/ui/ConfirmDialog'
import { api, apiErrorMessage, ApiError } from './api'
import { mintMsgId } from './chat/model'
import {
  SWITCH_COST_WARNING,
  type AuthorizeSwitch,
  type SwitchAuthorization,
  type ModelSwitchCostClientDeps,
} from './modelSwitchCostTypes'
function checkedQuote(value: unknown, requestId: string): ModelSwitchCostQuote {
  const q = value as ModelSwitchCostQuote
  const integer = (v: unknown) => typeof v === 'string' && /^\d{1,40}$/.test(v)
  const range = (r: ModelSwitchCostQuote['targetCost']) =>
    !!r &&
    [r.lowCredits, r.expectedCredits, r.highCredits].every(integer) &&
    BigInt(r.lowCredits) <= BigInt(r.expectedCredits) &&
    BigInt(r.expectedCredits) <= BigInt(r.highCredits)
  const prices = (p: ModelSwitchCostQuote['targetUnitPrice']) =>
    !!p &&
    [p.input, p.output, p.cacheRead, p.cacheWrite].every(
      (v) => typeof v === 'string' && /^\d+(\.\d{1,3})?$/.test(v),
    )
  if (
    !q ||
    q.requestId !== requestId ||
    !['exempt', 'estimate', 'risk'].includes(q.mode) ||
    typeof q.targetModel !== 'string' ||
    !q.targetModel ||
    typeof q.targetName !== 'string' ||
    typeof q.requiresConfirmation !== 'boolean' ||
    typeof q.canConfirm !== 'boolean' ||
    !Number.isSafeInteger(q.expiresAt) ||
    q.expiresAt <= Date.now() ||
    (q.mode === 'estimate' &&
      (!Number.isSafeInteger(q.contextTokens) ||
        q.contextTokens! <= 0 ||
        !range(q.targetCost) ||
        !range(q.currentCost))) ||
    (q.mode === 'risk' &&
      (q.contextTokens !== null ||
        q.targetCost !== null ||
        q.currentCost !== null ||
        !prices(q.targetUnitPrice))) ||
    (q.mode !== 'exempt' &&
      (typeof q.balanceCredits !== 'string' || !/^[-]?\d{1,40}$/.test(q.balanceCredits))) ||
    (q.requiresConfirmation &&
      (q.mode === 'exempt' ||
        typeof q.quoteToken !== 'string' ||
        q.quoteToken.length === 0 ||
        q.quoteToken.length > 4096))
  )
    throw new Error('费用信息无效，请重试')
  return q
}
const number = (value: string | number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export function ModelSwitchCostSummary({ quote: q }: { quote: ModelSwitchCostQuote }) {
  return (
    <div className="space-y-2 text-sm text-muted" data-testid="model-switch-cost-summary">
      <p>{SWITCH_COST_WARNING}</p>
      {q.mode === 'risk' ? (
        <>
          <p className="font-medium text-foreground">无法预估本轮费用</p>
          <p>
            当前输入或重建上下文缺少可靠计数，切换后第一轮可能明显更贵。确认后将使用 {q.targetName}
            。
          </p>
          {q.targetUnitPrice ? (
            <p>
              目标模型价格（积分/百万 tokens）：输入 {number(q.targetUnitPrice.input)}，输出{' '}
              {number(q.targetUnitPrice.output)}，缓存读 {number(q.targetUnitPrice.cacheRead)}
              ，缓存写 {number(q.targetUnitPrice.cacheWrite)}。
            </p>
          ) : null}
        </>
      ) : q.targetCost ? (
        <>
          <p>
            目标模型：{q.targetName} · 当前上下文约 {number(q.contextTokens ?? 0)} tokens
          </p>
          <p className="font-medium text-foreground">
            切换首轮约 {number(q.targetCost.expectedCredits)} 积分（
            {number(q.targetCost.lowCredits)}–{number(q.targetCost.highCredits)}）
          </p>
          {q.currentCost ? (
            <p>
              继续使用 {q.sourceName ?? q.sourceModel} 约 {number(q.currentCost.expectedCredits)}{' '}
              积分。
            </p>
          ) : null}
          <p>
            含预计输出约 {number(q.outputTokens ?? 0)}{' '}
            tokens；工具调用、上下文变化会影响金额，以实际扣费为准。
          </p>
        </>
      ) : null}
      {q.balanceCredits !== null ? <p>当前可用余额：{number(q.balanceCredits)} 积分</p> : null}
      {!q.canConfirm ? <p className="text-danger">余额不足，请充值后重试或取消切换。</p> : null}
    </div>
  )
}

/** Loaded on explicit switch/send; reuses the App confirmation instance. */
export function createModelSwitchCostAuthorizer({
  authRef,
  confirmDialog,
  toast,
}: ModelSwitchCostClientDeps): AuthorizeSwitch {
  const cache = new Map<
    string,
    { epoch: number; authorization: SwitchAuthorization; expiresAt: number }
  >()
  const flight = new Map<string, Promise<SwitchAuthorization | null>>()
  return (original, opts = {}) => {
    const effective =
      original.agentId === 'main' && original.teamMode
        ? DEFAULT_CODEX_ENGINE_MODEL
        : original.targetModel
    original = {
      ...original,
      contextTier: cursorModelSupportsContextTier(effective) ? original.contextTier : undefined,
      serviceTier: supportsFastServiceTier(effective) ? original.serviceTier : undefined,
    }
    const auth = authRef.current
    const epoch = auth.snapshot().epoch
    const key = JSON.stringify([
      original.sessionId,
      original.targetModel,
      original.agentId,
      original.teamMode === true,
      original.contextTier ?? null,
      original.serviceTier ?? null,
    ])
    const cached = cache.get(key)
    const valid = cached?.epoch === epoch && cached.expiresAt > Date.now() ? cached : undefined
    const input = {
      ...original,
      requestId:
        opts.useCachedRequestId && valid
          ? valid.authorization.requestId
          : original.requestId || mintMsgId(),
    }
    if (opts.useCachedRequestId && valid) cache.delete(key)
    const current = () =>
      authRef.current === auth && auth.snapshot().epoch === epoch && (opts.isCurrent?.() ?? true)
    const flightKey = JSON.stringify([epoch, key, input.requestId, opts.interactive !== false])
    const existing = flight.get(flightKey)
    if (existing) return existing
    const work = (async () => {
      try {
        const consent =
          opts.consent ??
          (valid?.authorization.requestId === input.requestId
            ? valid.authorization.consent
            : undefined)
        let q = checkedQuote(await api.modelSwitchCost(auth, input, { consent }), input.requestId)
        if (!current()) return null
        let choice: ConfirmChoice = true
        if (q.requiresConfirmation || opts.notice) {
          if (opts.interactive === false || opts.canPrompt?.() === false) return null
          const notice = opts.notice
          choice = await confirmDialog({
            title: notice?.title ?? '切换模型？',
            body: (
              <div className="space-y-3">
                {q.requiresConfirmation || q.targetCost !== null ? (
                  <ModelSwitchCostSummary quote={q} />
                ) : (
                  <p className="text-sm text-muted">{SWITCH_COST_WARNING}</p>
                )}
                {notice?.body}
              </div>
            ),
            confirmText: notice?.confirmText ?? '确认切换',
            cancelText: notice?.cancelText ?? '取消',
            altText: notice?.altText,
            confirmDisabled: !q.canConfirm,
          })
          if (choice === false || !current() || opts.canPrompt?.() === false) return null
          if (q.requiresConfirmation) {
            if (!q.quoteToken) return null
            q = checkedQuote(
              await api.modelSwitchCost(auth, input, { quoteToken: q.quoteToken }),
              input.requestId,
            )
            if (!current() || q.requiresConfirmation) return null
          }
        }
        const authorization = {
          requestId: input.requestId,
          ...(q.consent ? { consent: q.consent } : {}),
          choice,
        }
        if (opts.primeNextTurn) cache.set(key, { epoch, authorization, expiresAt: q.expiresAt })
        return authorization
      } catch (error) {
        const unavailable =
          error instanceof TypeError || (error instanceof ApiError && error.status >= 500)
        if (opts.interactive === false && unavailable) throw error
        if (opts.allowOfflineQueue && unavailable && current())
          return { requestId: input.requestId, choice: true }
        if (opts.interactive !== false && current())
          toast(apiErrorMessage(error, '费用确认暂不可用，请重试'), 'error')
        return null
      }
    })()
    flight.set(flightKey, work)
    const clearFlight = () => {
      if (flight.get(flightKey) === work) flight.delete(flightKey)
    }
    void work.then(clearFlight, clearFlight)
    return work
  }
}
