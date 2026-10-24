import {
  DEFAULT_CODEX_ENGINE_MODEL,
  cursorModelSupportsContextTier,
  supportsFastServiceTier,
} from '@openclaude/protocol/browser'
import { useCallback, useRef } from 'react'
import type {
  ModelSwitchCostRequest,
  ModelSwitchCostQuote,
  ModelSwitchCostAuthorization,
} from '@openclaude/protocol/browser'
import type { ConfirmOpts, ConfirmChoice } from '../components/ui/ConfirmDialog'
import type { AuthSession } from '../lib/types'
import type { ToastFn } from '../components/ui/Toast'
import { api, apiErrorMessage, ApiError } from '../lib/api'
import { mintMsgId } from '../lib/chat/model'

export const SWITCH_COST_WARNING = '切换后首次会话将重建全部上下文，价格较高'
export type SwitchAuthorization = ModelSwitchCostAuthorization & { choice: ConfirmChoice }
export type AuthorizeSwitch = (
  input: ModelSwitchCostRequest,
  opts?: {
    interactive?: boolean
    notice?: ConfirmOpts
    primeNextTurn?: boolean
    allowOfflineQueue?: boolean
    useCachedRequestId?: boolean
    consent?: string
    isCurrent?: () => boolean
  },
) => Promise<SwitchAuthorization | null>
const number = (value: string | number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export function ModelSwitchCostSummary({ quote: q }: { quote: ModelSwitchCostQuote }) {
  return (
    <div className="space-y-2 text-sm text-muted" data-testid="model-switch-cost-summary">
      <p>{SWITCH_COST_WARNING}</p>
      {q.mode === 'risk' ? (
        <>
          <p className="font-medium text-foreground">无法预估本轮费用</p>
          <p>
            当前引擎没有可靠的上下文计数，切换后第一轮可能明显更贵。确认后将使用 {q.targetName}。
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
/** Uses the existing App useConfirm instance; this hook never creates a dialog shell. */
export function useModelSwitchCost({
  authRef,
  confirmDialog,
  toast,
}: {
  authRef: React.RefObject<AuthSession>
  confirmDialog: (o: ConfirmOpts) => Promise<ConfirmChoice>
  toast: ToastFn
}) {
  const cache = useRef(
    new Map<string, { epoch: number; authorization: SwitchAuthorization; expiresAt: number }>(),
  )
  const flight = useRef(new Map<string, Promise<SwitchAuthorization | null>>())
  return useCallback<AuthorizeSwitch>(
    (original, opts = {}) => {
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
      const cached = cache.current.get(key)
      const valid = cached?.epoch === epoch && cached.expiresAt > Date.now() ? cached : undefined
      const input = {
        ...original,
        requestId:
          opts.useCachedRequestId && valid
            ? valid.authorization.requestId
            : original.requestId || mintMsgId(),
      }
      if (opts.useCachedRequestId && valid) cache.current.delete(key)
      const current = () =>
        authRef.current === auth && auth.snapshot().epoch === epoch && (opts.isCurrent?.() ?? true)
      const flightKey = JSON.stringify([epoch, key, input.requestId, opts.interactive !== false])
      const existing = flight.current.get(flightKey)
      if (existing) return existing
      const work = (async () => {
        try {
          const consent =
            opts.consent ??
            (valid?.authorization.requestId === input.requestId
              ? valid.authorization.consent
              : undefined)
          let q = await api.modelSwitchCost(auth, input, { consent })
          if (!current()) return null
          let choice: ConfirmChoice = true
          if (q.requiresConfirmation || opts.notice) {
            if (opts.interactive === false) return null
            const notice = opts.notice
            choice = await confirmDialog({
              title: notice?.title ?? '切换模型？',
              body: (
                <div className="space-y-3">
                  {q.requiresConfirmation ? (
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
            if (choice === false || !current()) return null
            if (q.requiresConfirmation) {
              if (!q.quoteToken) return null
              q = await api.modelSwitchCost(auth, input, { quoteToken: q.quoteToken })
              if (!current() || q.requiresConfirmation) return null
            }
          }
          const authorization = {
            requestId: input.requestId,
            ...(q.consent ? { consent: q.consent } : {}),
            choice,
          }
          if (opts.primeNextTurn)
            cache.current.set(key, { epoch, authorization, expiresAt: q.expiresAt })
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
      flight.current.set(flightKey, work)
      void work.finally(() => {
        if (flight.current.get(flightKey) === work) flight.current.delete(flightKey)
      })
      return work
    },
    [authRef, confirmDialog, toast],
  )
}
