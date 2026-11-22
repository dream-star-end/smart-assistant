/**
 * Telegram Channel Adapter — zero external npm dependencies (native `fetch` + `node:crypto`).
 *
 * Modes (B9 backwards-compatibility):
 *   - Default when only `botToken` (+ `mentionRequired`) is provided (legacy CLI config):
 *     starts long-polling (`getUpdates`) immediately so inbound messages arrive at `ctx.dispatch`.
 *   - Webhook mode (`mode: 'webhook'` or `webhookUrl` provided):
 *     requires non-empty `webhookSecret` (fail-closed on init & on every HTTP request).
 */

import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'
import {
  buildTelegramApprovalCard,
  type BuildTelegramApprovalCardParams,
} from './approvalCallback.js'
import { TelegramBotApi, type TelegramMessage } from './botApi.js'
import {
  handleTelegramWebhookPayload,
  processTelegramUpdate,
  type TelegramApprovalDecisionEvent,
  type TelegramApprovalDecisionResult,
  type TelegramWebhookHttpResult,
} from './webhook.js'

export * from './botApi.js'
export * from './approvalCallback.js'
export * from './webhook.js'

export interface TelegramConfig {
  botToken: string
  /** Optional custom Bot API base URL (for testing or local Bot API server). */
  apiBaseUrl?: string
  /**
   * Delivery mode: defaults to `'webhook'` when `webhookUrl` is set, otherwise `'polling'`
   * (preserving full compatibility with legacy CLI configs passing only `{ botToken, mentionRequired }`).
   */
  mode?: 'webhook' | 'polling'
  /** Mandatory secret token for webhook mode (`X-Telegram-Bot-Api-Secret-Token`). */
  webhookSecret?: string
  /** HMAC signing secret for Inline Keyboard approval callbacks. Defaults to `webhookSecret`. */
  callbackSecret?: string
  /** Optional webhook URL to register automatically on init when mode='webhook'. */
  webhookUrl?: string
  /** Allowlisted chat IDs permitted to interact / approve. */
  allowedChatIds?: ReadonlyArray<string | number>
  /** Group chats require `@bot` mention unless false. */
  mentionRequired?: boolean
  /** Include thinking blocks in outbound text (default false). */
  showThinking?: boolean
  /** Drop pending updates on startup (default false). */
  dropPendingUpdates?: boolean
  /** Poll interval ms after each getUpdates batch (default 100ms). */
  pollIntervalMs?: number
  /** Long-poll timeout seconds passed to Telegram `getUpdates` (default 15s). */
  pollTimeoutSec?: number
  /** Maps Telegram operator -> platform ownerUid for approval authorization. */
  resolveOperatorUid?: (info: {
    fromUserId: string
    chatId: string
    chatType: string
  }) => Promise<string | null>
  /** Resolves `(ownerUid, shortCode)` -> active `decisionId` for HMAC digest cross-check. */
  resolveExpectedDecisionId?: (ownerUid: string, code: string) => Promise<string | null>
  /** Callback invoked when a verified Inline Keyboard approval button is pressed. */
  onApprovalCallback?: (
    event: TelegramApprovalDecisionEvent,
  ) => Promise<TelegramApprovalDecisionResult>
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch
}

export interface TelegramChannelAdapter extends ChannelAdapter {
  readonly api: TelegramBotApi
  readonly mode: 'webhook' | 'polling'
  handleWebhook(input: {
    headers: Record<string, string | string[] | undefined>
    body: unknown
  }): Promise<TelegramWebhookHttpResult>
  sendApprovalCard(
    params: Omit<BuildTelegramApprovalCardParams, 'secret'> & { secret?: string },
  ): Promise<TelegramMessage>
}

export function telegramChannelFactory(cfg: TelegramConfig): TelegramChannelAdapter {
  const api = new TelegramBotApi({
    botToken: cfg.botToken,
    apiBaseUrl: cfg.apiBaseUrl,
    fetchImpl: cfg.fetchImpl,
  })
  const effectiveMode: 'webhook' | 'polling' =
    cfg.mode ?? (cfg.webhookUrl ? 'webhook' : 'polling')
  const seenCallbackIds = new Map<string, number>()
  const inFlightCallbackIds = new Set<string>()

  let ctx: ChannelContext | null = null
  let botUsername: string | undefined
  let pollingActive = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let nextOffset = 0

  function schedulePoll(delayMs = 200): void {
    if (!pollingActive) return
    pollTimer = setTimeout(async () => {
      if (!pollingActive) return
      try {
        const updates = await api.getUpdates({
          offset: nextOffset,
          timeout: cfg.pollTimeoutSec ?? 15,
          allowed_updates: ['message', 'callback_query'],
        })
        for (const u of updates) {
          // Advance offset ONLY AFTER update processing completes cleanly (transient errors retry).
          await processTelegramUpdate(u, {
            api,
            callbackSecret: cfg.callbackSecret ?? cfg.webhookSecret,
            allowedChatIds: cfg.allowedChatIds,
            mentionRequired: cfg.mentionRequired,
            botUsername,
            resolveOperatorUid: cfg.resolveOperatorUid,
            resolveExpectedDecisionId: cfg.resolveExpectedDecisionId,
            seenCallbackIds,
            inFlightCallbackIds,
            dispatchInbound: (frame) => ctx?.dispatch(frame),
            onApprovalCallback: cfg.onApprovalCallback,
          })
          nextOffset = Math.max(nextOffset, u.update_id + 1)
        }
        schedulePoll(cfg.pollIntervalMs ?? 100)
      } catch (err) {
        ctx?.log.error('telegram polling error', err instanceof Error ? err.message : String(err))
        schedulePoll(Math.max(cfg.pollIntervalMs ?? 100, 3000))
      }
    }, delayMs)
    pollTimer.unref?.()
  }

  return {
    id: 'telegram',
    name: 'telegram',
    type: 'channel' as const,
    api,
    mode: effectiveMode,

    async init(c) {
      ctx = c
      if (effectiveMode === 'webhook' && !cfg.webhookSecret?.trim()) {
        throw new Error('telegram webhook mode requires a non-empty webhookSecret')
      }

      try {
        const me = await api.getMe()
        botUsername = me.username
      } catch (err) {
        c.log.error('telegram getMe failed', err instanceof Error ? err.message : String(err))
      }

      if (effectiveMode === 'polling') {
        try {
          await api.deleteWebhook({ drop_pending_updates: !!cfg.dropPendingUpdates })
        } catch {
          // best effort
        }
        pollingActive = true
        schedulePoll(0)
        c.log.info('telegram bot polling started (native fetch)')
        return
      }

      if (cfg.webhookUrl) {
        await api.setWebhook({
          url: cfg.webhookUrl,
          secret_token: cfg.webhookSecret,
          drop_pending_updates: !!cfg.dropPendingUpdates,
          allowed_updates: ['message', 'callback_query'],
        })
      }
      c.log.info('telegram bot webhook adapter initialized (native fetch)')
    },

    async handleWebhook(input) {
      return handleTelegramWebhookPayload(input, {
        api,
        webhookSecret: cfg.webhookSecret,
        callbackSecret: cfg.callbackSecret ?? cfg.webhookSecret,
        allowedChatIds: cfg.allowedChatIds,
        mentionRequired: cfg.mentionRequired,
        botUsername,
        resolveOperatorUid: cfg.resolveOperatorUid,
        resolveExpectedDecisionId: cfg.resolveExpectedDecisionId,
        seenCallbackIds,
        inFlightCallbackIds,
        dispatchInbound: (frame) => ctx?.dispatch(frame),
        onApprovalCallback: cfg.onApprovalCallback,
      })
    },

    async sendApprovalCard(params) {
      const secret = params.secret ?? cfg.callbackSecret ?? cfg.webhookSecret
      if (!secret) {
        throw new Error('sendApprovalCard requires callbackSecret or webhookSecret')
      }
      const card = buildTelegramApprovalCard({ ...params, secret })
      return api.sendMessage({
        chat_id: params.chatId,
        text: card.text,
        reply_markup: card.reply_markup,
      })
    },

    async send(out: OutboundMessage) {
      const showThinking = !!cfg.showThinking
      const textParts: string[] = []
      const toolLines: string[] = []
      const thinkingParts: string[] = []
      for (const b of out.blocks) {
        if (b.kind === 'text' && b.text) textParts.push(b.text)
        else if (b.kind === 'thinking' && b.text) thinkingParts.push(b.text)
        else if (b.kind === 'tool_use' && !b.partial) {
          const preview = b.inputPreview ? ` ${truncate(b.inputPreview, 200)}` : ''
          toolLines.push(`🔧 ${b.toolName}${preview}`)
        } else if (b.kind === 'tool_result' && b.preview) {
          const prefix = b.isError ? '⚠️' : '↳'
          toolLines.push(`${prefix} ${truncate(b.preview, 200)}`)
        }
      }
      const segments: string[] = []
      if (showThinking && thinkingParts.length > 0) {
        segments.push(`💭 ${thinkingParts.join(' ')}`)
      }
      if (toolLines.length > 0) segments.push(toolLines.join('\n'))
      if (textParts.length > 0) {
        segments.push(textParts.join(''))
      } else if (out.isFinal && thinkingParts.length > 0) {
        segments.push(thinkingParts.join(' '))
      }
      const text = segments.filter(Boolean).join('\n\n').trim()
      if (!text) return
      const chunks = splitText(text, 4000)
      for (const chunk of chunks) {
        try {
          await api.sendMessage({ chat_id: out.peer.id, text: chunk })
        } catch (err) {
          ctx?.log.error('telegram sendMessage failed', {
            err: err instanceof Error ? err.message : String(err),
            chatId: out.peer.id,
            preview: chunk.slice(0, 80),
          })
        }
      }
    },

    async shutdown() {
      pollingActive = false
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
    },
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

function splitText(text: string, max: number): string[] {
  const out: string[] = []
  let buf = text
  while (buf.length > max) {
    out.push(buf.slice(0, max))
    buf = buf.slice(max)
  }
  if (buf) out.push(buf)
  return out
}
