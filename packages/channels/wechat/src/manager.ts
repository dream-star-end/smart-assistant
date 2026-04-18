// WechatManager — orchestrates one WechatWorker per active binding.
//
// At gateway startup the manager:
//   1. Queries wechat_bindings for status='active' rows
//   2. Spawns one WechatWorker per row (each runs its own long-poll loop)
//   3. Routes inbound events → gateway.dispatch after whitelist check
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
import {
  getWechatBindingByUserId,
  listActiveWechatBindings,
  updateWechatBindingWhitelist,
} from '@openclaude/storage'
import { WechatWorker, type InboundEvent } from './worker.js'

export interface WechatChannelConfig {
  // Interval (ms) between DB reconciliation passes. Picks up newly added
  // bindings and applies whitelist updates without restarting the gateway.
  reconcileIntervalMs?: number
}

const DEFAULT_RECONCILE_MS = 30_000

export function wechatChannelFactory(cfg: WechatChannelConfig = {}): ChannelAdapter {
  let ctx: ChannelContext | null = null
  const workers = new Map<string, WechatWorker>() // key = userId (OC user)
  let reconcileTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false

  // Rate-limit the soft-bounce reply to unknown senders.
  // Key: `${bindingUserId}:${senderId}`. Value: last-replied ts (ms).
  // Prevents reply storms when a bot is spammed by a stranger.
  // Bounded by BOUNCE_MAX_ENTRIES + TTL eviction so a spammer cycling senders
  // cannot grow this map without bound (leak risk).
  const bounceCache = new Map<string, number>()
  const BOUNCE_COOLDOWN_MS = 30 * 60_000
  const BOUNCE_MAX_ENTRIES = 1000

  function bounceCacheSweep(): void {
    const now = Date.now()
    for (const [k, v] of bounceCache) {
      if (now - v > BOUNCE_COOLDOWN_MS) bounceCache.delete(k)
    }
    // Hard cap: if still over-sized after TTL sweep, drop oldest entries.
    // Map iteration order is insertion order, so the first N are the oldest.
    if (bounceCache.size > BOUNCE_MAX_ENTRIES) {
      const overflow = bounceCache.size - BOUNCE_MAX_ENTRIES
      let i = 0
      for (const k of bounceCache.keys()) {
        if (i++ >= overflow) break
        bounceCache.delete(k)
      }
    }
  }

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

    // Whitelist gate: only login_user_id + explicitly bound senders can talk.
    // Others get a guidance reply once (the /bind handshake) — Stage 4 wires this.
    const allowed = new Set<string>([
      ...(binding.whitelist || []),
      ...(binding.loginUserId ? [binding.loginUserId] : []),
    ])
    const isAllowed = allowed.has(senderId)

    if (!isAllowed) {
      // Soft-bounce: tell the stranger their user_id so the OC owner can
      // add them via the Settings panel, or via `/bind <user_id>` from a
      // whitelisted account. Rate-limited to avoid reply storms.
      ctx.log.info(
        `[wechat:${binding.userId}] drop unauthorized sender=${senderId} text="${text.slice(0, 60)}"`,
      )
      const bounceKey = `${binding.userId}:${senderId}`
      const last = bounceCache.get(bounceKey) || 0
      if (Date.now() - last > BOUNCE_COOLDOWN_MS) {
        bounceCache.set(bounceKey, Date.now())
        bounceCacheSweep()
        const w = workers.get(binding.userId)
        if (w) {
          const hint =
            `你未被授权访问此 OpenClaude bot。\n` +
            `请让管理员把你的 user_id 加到白名单:\n${senderId}\n\n` +
            `(管理员可在 OC 的"微信绑定"里添加,或在本 bot 里发送 "/bind ${senderId}")`
          // sendText requires we have a context_token; at this point the
          // worker just recorded one, so this will work.
          w.sendText(senderId, hint).catch(() => {})
        }
      }
      return
    }

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
        `whitelist: ${(binding.whitelist || []).length} 位\n` +
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

    // ── /bind <wx_user_id> — whitelisted user adds another sender ──
    const bindMatch = /^\s*\/bind\s+([A-Za-z0-9_@.\-]+)\s*$/.exec(text)
    if (bindMatch) {
      const target = bindMatch[1]
      const current = new Set<string>(binding.whitelist || [])
      if (binding.loginUserId) current.add(binding.loginUserId)
      if (current.has(target)) {
        const w = workers.get(binding.userId)
        if (w) w.sendText(senderId, `${target} 已在白名单`).catch(() => {})
        return
      }
      current.add(target)
      const nextList = Array.from(current)
      try {
        await updateWechatBindingWhitelist(binding.userId, nextList)
        // Refresh in-memory snapshot so the next message from <target> is accepted
        const refreshed = await getWechatBindingByUserId(binding.userId)
        if (refreshed) workers.get(binding.userId)?.updateBinding(refreshed)
        const w = workers.get(binding.userId)
        if (w) w.sendText(senderId, `已添加 ${target} 到白名单`).catch(() => {})
      } catch (err: any) {
        ctx.log.error(`[wechat:${binding.userId}] /bind failed: ${err?.message || err}`)
        const w = workers.get(binding.userId)
        if (w) w.sendText(senderId, `/bind 失败: ${err?.message || err}`).catch(() => {})
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
        // Refresh in-memory snapshot (whitelist/token updates)
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

// ─── bind-management hook (used by the Web Settings panel) ────────────
// Mutating whitelist via DB then calling reconcile() (on a timer) is fine,
// but we export a helper so callers can push updates without waiting.
export async function updateWechatBindingWhitelistAndRefresh(
  userId: string,
  whitelist: string[],
): Promise<void> {
  await updateWechatBindingWhitelist(userId, whitelist)
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
