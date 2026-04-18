// WechatManager — orchestrates one WechatWorker per active binding.
//
// At gateway startup the manager:
//   1. Queries wechat_bindings for status='active' rows
//   2. Spawns one WechatWorker per row (each runs its own long-poll loop)
//   3. Routes inbound events → gateway.dispatch (no gating — any sender that
//      can reach the bound bot is trusted)
//   4. Routes OutboundMessage back to the right worker by decoding peer.id
//
// peer.id encoding: "${bindingUserId}:${wxSenderId}" so that two different
// OC users binding two different WeChat accounts can never collide on
// session keys (which would otherwise mix their conversations).
//
// Exposed via wechatChannelFactory() which returns a single ChannelAdapter
// that fronts the whole fanout.

import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'
import type { WechatBinding } from '@openclaude/storage'
import { listActiveWechatBindings } from '@openclaude/storage'
import { WechatWorker, type InboundEvent } from './worker.js'

export interface WechatChannelConfig {
  // Interval (ms) between DB reconciliation passes. Picks up newly added
  // bindings and applies token/status updates without restarting the gateway.
  reconcileIntervalMs?: number
}

const DEFAULT_RECONCILE_MS = 30_000

export function wechatChannelFactory(cfg: WechatChannelConfig = {}): ChannelAdapter {
  let ctx: ChannelContext | null = null
  const workers = new Map<string, WechatWorker>() // key = userId (OC user)
  let reconcileTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false

  async function startWorkerFor(binding: WechatBinding): Promise<void> {
    if (!ctx) return
    const w = new WechatWorker({
      binding,
      ctx,
      onInbound: (evt) => handleInbound(evt),
    })
    workers.set(binding.userId, w)
    w.start()
  }

  async function handleInbound(evt: InboundEvent): Promise<void> {
    if (!ctx) return
    const { binding, senderId, text, messageId } = evt

    // No sender gating — anyone who can reach the bound bot is trusted. The
    // OC owner wants the bot fully open; access control is the WeChat-side
    // friend relationship, not something we replicate here.

    // ── /status — report current binding state to the WeChat user ──
    if (/^\s*\/status\s*$/.test(text)) {
      const w = workers.get(binding.userId)
      const lastEvt = binding.lastEventAt
        ? new Date(binding.lastEventAt).toISOString().slice(0, 19).replace('T', ' ')
        : '(无)'
      const msg =
        `OC bot status\n` +
        `account: ${binding.accountId}\n` +
        `status: ${binding.status}\n` +
        `最近事件: ${lastEvt}\n` +
        `活跃 worker: ${workers.size}`
      if (w) w.sendText(senderId, msg).catch(() => {})
      return
    }

    // ── /new — start a fresh OpenClaude session for this sender ──
    if (/^\s*\/new\s*$/.test(text)) {
      const peerId = `${binding.userId}:${senderId}`
      try {
        if (ctx.resetSession) await ctx.resetSession('wechat', peerId, 'dm')
        const w = workers.get(binding.userId)
        if (w) w.sendText(senderId, '已开启新会话。下一条消息将由全新的 agent 处理。').catch(() => {})
      } catch (err: any) {
        const w = workers.get(binding.userId)
        if (w) w.sendText(senderId, `/new 失败: ${err?.message || err}`).catch(() => {})
      }
      return
    }

    // peer.id embeds the OC user binding so routes and session keys can not
    // collide across users who happen to share a WeChat sender id.
    const peerId = `${binding.userId}:${senderId}`
    const idempotencyKey = `wechat:${binding.userId}:${senderId}:${messageId}`

    ctx.dispatch({
      type: 'inbound.message',
      idempotencyKey,
      channel: 'wechat',
      peer: {
        id: peerId,
        kind: 'dm',
        displayName: senderId,
      },
      content: { text },
      ts: Date.now(),
    })
  }

  async function reconcile(): Promise<void> {
    if (!ctx || shuttingDown) return
    let active: WechatBinding[] = []
    try {
      active = await listActiveWechatBindings()
    } catch (err: any) {
      ctx.log.error(`[wechat] reconcile: list bindings failed: ${err?.message || err}`)
      return
    }
    const activeIds = new Set(active.map((b) => b.userId))

    // Start newly added bindings
    for (const b of active) {
      if (!workers.has(b.userId)) {
        ctx.log.info(`[wechat] starting worker for user=${b.userId} account=${b.accountId}`)
        await startWorkerFor(b)
      } else {
        // Refresh in-memory snapshot (status / context_token catch-up)
        workers.get(b.userId)!.updateBinding(b)
      }
    }

    // Stop workers whose binding is no longer active (unbound or disabled)
    for (const [uid, w] of workers.entries()) {
      if (!activeIds.has(uid)) {
        ctx.log.info(`[wechat] stopping worker for user=${uid} (binding gone)`)
        try { await w.stop() } catch {}
        workers.delete(uid)
      }
    }
  }

  return {
    id: 'wechat',
    name: 'wechat',
    type: 'channel' as const,

    async init(c) {
      ctx = c
      await reconcile()
      const interval = cfg.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS
      reconcileTimer = setInterval(() => {
        reconcile().catch((err) => c.log.error(`[wechat] reconcile err: ${err?.message || err}`))
      }, interval)
      reconcileTimer.unref?.()
      c.log.info(`[wechat] manager initialized (${workers.size} active bindings)`)
    },

    async send(out: OutboundMessage) {
      if (!ctx) return
      // peer.id = "${ocUserId}:${wxSenderId}". Split on FIRST colon only —
      // WeChat sender ids can (in principle) contain ':', so naive split(':')
      // would truncate the senderId and break outbound routing.
      const raw = String(out.peer?.id || '')
      const colon = raw.indexOf(':')
      const userId = colon > 0 ? raw.slice(0, colon) : ''
      const senderId = colon > 0 ? raw.slice(colon + 1) : ''
      if (!userId || !senderId) {
        ctx.log.error(`[wechat] send: invalid peer.id=${out.peer?.id}`)
        return
      }
      const w = workers.get(userId)
      if (!w) {
        ctx.log.error(`[wechat] send: no worker for user=${userId}`)
        return
      }

      // Flatten OutboundMessage blocks the same way telegram does: text only
      // (thinking hidden; tool_use shown as one-liner previews).
      const textParts: string[] = []
      const toolLines: string[] = []
      for (const b of out.blocks || []) {
        if (b.kind === 'text' && b.text) textParts.push(b.text)
        else if (b.kind === 'tool_use' && !b.partial) {
          const preview = b.inputPreview ? ` ${truncate(b.inputPreview, 120)}` : ''
          toolLines.push(`🔧 ${b.toolName}${preview}`)
        } else if (b.kind === 'tool_result' && b.preview) {
          const prefix = b.isError ? '⚠️' : '↳'
          toolLines.push(`${prefix} ${truncate(b.preview, 120)}`)
        }
      }
      const segments: string[] = []
      if (toolLines.length) segments.push(toolLines.join('\n'))
      if (textParts.length) segments.push(textParts.join(''))
      const text = segments.filter(Boolean).join('\n\n').trim()
      if (!text) return

      // WeChat text caps at ~600 chars per message in practice; split.
      const chunks = splitText(text, 1800)
      for (const c of chunks) {
        await w.sendText(senderId, c)
      }
    },

    async shutdown() {
      shuttingDown = true
      if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null }
      await Promise.all(Array.from(workers.values()).map((w) => w.stop().catch(() => {})))
      workers.clear()
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
