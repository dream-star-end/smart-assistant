import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'

// Telegram 渠道适配器(grammY)
//
// 使用方式(在 gateway plugins 列表里注册):
//   import { telegramChannelFactory } from '@openclaude/channel-telegram'
//   channels.push(telegramChannelFactory({ botToken: '...' }))
//
// MVP stub:仅占位,实际需要 `bun add grammy`

export interface TelegramConfig {
  botToken: string
  // 群组中是否必须 @bot 才响应
  mentionRequired?: boolean
  // 是否在 Telegram 消息里显示 thinking 块(默认不显示,只有调试需要)
  showThinking?: boolean
}

export function telegramChannelFactory(cfg: TelegramConfig): ChannelAdapter {
  let bot: any = null
  let ctx: ChannelContext | null = null
  return {
    id: 'telegram',
    name: 'telegram',
    type: 'channel' as const,
    async init(c) {
      ctx = c
      try {
        let Bot: any
        try {
          const mod = await import('grammy' as any)
          Bot = mod.Bot
        } catch {
          c.log.error('grammy 未安装。请运行: npm install grammy')
          c.log.error('Telegram 频道已禁用。')
          return
        }
        bot = new Bot(cfg.botToken)
        bot.on('message', async (botCtx: any) => {
          const text = botCtx.message?.text
          if (!text) return
          const isGroup = botCtx.chat?.type === 'group' || botCtx.chat?.type === 'supergroup'
          if (isGroup && cfg.mentionRequired !== false) {
            const me = await bot.api.getMe()
            if (!text.includes(`@${me.username}`)) return
          }
          ctx?.dispatch({
            type: 'inbound.message',
            idempotencyKey: `tg:${botCtx.message.message_id}`,
            channel: 'telegram',
            peer: {
              id: String(botCtx.chat.id),
              kind: isGroup ? 'group' : 'dm',
              displayName: botCtx.chat.title ?? botCtx.from?.username ?? '',
            },
            content: { text },
            ts: Date.now(),
          })
        })
        bot.start()
        c.log.info('telegram bot started')
      } catch (err) {
        c.log.error('telegram init failed (grammy not installed?)', err)
      }
    },
    async send(out: OutboundMessage) {
      if (!bot) {
        ctx?.log.error('telegram send: bot not initialized')
        return
      }
      // Aggregate text first; thinking is hidden by default (debug feature)
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
      // Compose final message: tools (if any) → text (assistant)
      // Skip thinking unless explicitly enabled. Skip empty intermediate sends.
      const segments: string[] = []
      if (showThinking && thinkingParts.length > 0) {
        segments.push(`💭 ${thinkingParts.join(' ')}`)
      }
      if (toolLines.length > 0) segments.push(toolLines.join('\n'))
      if (textParts.length > 0) {
        segments.push(textParts.join(''))
      } else if (out.isFinal && thinkingParts.length > 0) {
        // 兜底:模型只输出了 thinking 没输出 text(MiniMax 偶尔会这样),把 thinking 作为答复给用户
        segments.push(thinkingParts.join(' '))
      }
      const text = segments.filter(Boolean).join('\n\n').trim()
      // Don't bother sending intermediate blocks (we shouldn't get here anyway —
      // the gateway aggregates for adapters now). And don't send empty finals.
      if (!text) return
      const chunks = splitText(text, 4000)
      for (const c of chunks) {
        try {
          // Send as plain text — no markdown parsing → no escape headaches with
          // Chinese punctuation, code, names containing _, *, [, etc.
          await bot.api.sendMessage(out.peer.id, c)
        } catch (err: any) {
          ctx?.log.error('telegram sendMessage failed', {
            err: err?.message ?? String(err),
            chatId: out.peer.id,
            preview: c.slice(0, 80),
          })
        }
      }
    },
    async shutdown() {
      try {
        await bot?.stop()
      } catch {}
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
