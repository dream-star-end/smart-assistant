/**
 * Feishu (Lark) Channel Adapter — zero external npm dependencies (native `fetch` + `node:crypto`).
 *
 * Supports:
 *   - Event webhook verification (`X-Lark-Signature` + replay window + `verificationToken`)
 *   - Optional AES-256-CBC payload decryption (`encryptKey`)
 *   - Challenge handshake (`url_verification`)
 *   - Interactive approval card construction, sending, and callback verification
 */

import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'
import {
  buildFeishuApprovalCard,
  type BuildFeishuApprovalCardParams,
} from './cards.js'
import { FeishuOpenApiClient, type FeishuReceiveIdType } from './client.js'
import {
  handleFeishuWebhookPayload,
  type FeishuApprovalCallbackEvent,
  type FeishuApprovalCallbackResult,
  type FeishuWebhookHttpResult,
} from './webhook.js'

export * from './crypto.js'
export * from './cards.js'
export * from './client.js'
export * from './webhook.js'

export interface FeishuConfig {
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey?: string
  cardSigningSecret?: string
  apiBaseUrl?: string
  allowedChatIds?: ReadonlyArray<string>
  defaultReceiveIdType?: FeishuReceiveIdType
  resolveOperatorUid?: (info: {
    operatorOpenId: string
    chatId: string
  }) => Promise<string | null>
  onApprovalCallback?: (
    event: FeishuApprovalCallbackEvent,
  ) => Promise<FeishuApprovalCallbackResult>
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface FeishuChannelAdapter extends ChannelAdapter {
  readonly client: FeishuOpenApiClient
  handleWebhook(input: {
    headers: Record<string, string | string[] | undefined>
    rawBody: string
  }): Promise<FeishuWebhookHttpResult>
  sendApprovalCard(
    params: Omit<BuildFeishuApprovalCardParams, 'signingSecret'> & {
      signingSecret?: string
      receiveIdType?: FeishuReceiveIdType
    },
  ): Promise<{ messageId?: string }>
}

export function feishuChannelFactory(cfg: FeishuConfig): FeishuChannelAdapter {
  const client = new FeishuOpenApiClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    apiBaseUrl: cfg.apiBaseUrl,
    fetchImpl: cfg.fetchImpl,
    now: cfg.now,
  })
  const seenEventIds = new Map<string, number>()
  const inFlightEventIds = new Set<string>()
  let ctx: ChannelContext | null = null

  return {
    id: 'feishu',
    name: 'feishu',
    type: 'channel' as const,
    client,

    async init(c) {
      if (!cfg.verificationToken?.trim()) {
        throw new Error('feishu channel adapter requires a non-empty verificationToken')
      }
      ctx = c
      c.log.info('feishu channel adapter initialized (native fetch)')
    },

    async handleWebhook(input) {
      return handleFeishuWebhookPayload(input, {
        verificationToken: cfg.verificationToken,
        encryptKey: cfg.encryptKey,
        cardSigningSecret: cfg.cardSigningSecret,
        allowedChatIds: cfg.allowedChatIds,
        now: cfg.now,
        resolveOperatorUid: cfg.resolveOperatorUid,
        seenEventIds,
        inFlightEventIds,
        dispatchInbound: (frame) => ctx?.dispatch(frame),
        onApprovalCallback: cfg.onApprovalCallback,
      })
    },

    async sendApprovalCard(params) {
      const signingSecret =
        params.signingSecret ?? cfg.cardSigningSecret ?? cfg.encryptKey ?? cfg.verificationToken
      const card = buildFeishuApprovalCard({
        ...params,
        signingSecret,
      })
      return client.sendInteractiveCard(
        params.chatId,
        card,
        params.receiveIdType ?? cfg.defaultReceiveIdType ?? 'chat_id',
      )
    },

    async send(out: OutboundMessage) {
      const textParts: string[] = []
      const toolLines: string[] = []
      for (const b of out.blocks) {
        if (b.kind === 'text' && b.text) textParts.push(b.text)
        else if (b.kind === 'tool_use' && !b.partial) {
          toolLines.push(`🔧 ${b.toolName}${b.inputPreview ? ` ${b.inputPreview.slice(0, 180)}` : ''}`)
        } else if (b.kind === 'tool_result' && b.preview) {
          toolLines.push(`${b.isError ? '⚠️' : '↳'} ${b.preview.slice(0, 180)}`)
        }
      }
      const segments = [toolLines.join('\n'), textParts.join('')].filter(Boolean)
      const text = segments.join('\n\n').trim()
      if (!text) return
      try {
        await client.sendTextMessage(
          out.peer.id,
          text.slice(0, 8000),
          cfg.defaultReceiveIdType ?? 'chat_id',
        )
      } catch (err) {
        ctx?.log.error('feishu sendTextMessage failed', {
          err: err instanceof Error ? err.message : String(err),
          chatId: out.peer.id,
        })
      }
    },

    async shutdown() {},
  }
}
