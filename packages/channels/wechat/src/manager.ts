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

  // Dedup set for tool_use announcements. A streaming assistant turn may emit
  // the same tool_use block several times (partial=true then partial=false,
  // or a re-delivered OutboundMessage). Keys are
  // `${userId}:${senderId}:${blockId}`. Bounded to keep the set from growing
  // unbounded over long-lived sessions.
  const announcedTools = new Set<string>()
  const ANNOUNCED_TOOLS_CAP = 2000
  function announcedToolsGc(): void {
    if (announcedTools.size <= ANNOUNCED_TOOLS_CAP) return
    const overflow = announcedTools.size - ANNOUNCED_TOOLS_CAP
    let i = 0
    for (const k of announcedTools) {
      if (i++ >= overflow) break
      announcedTools.delete(k)
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

      // Stream-friendly flattening: walk blocks in order, pushing *live*
      // notifications so the user feels the bot working instead of waiting
      // in silence for the final answer. Strategy:
      //   - text  → accumulate into a buffer
      //   - tool_use (finalized, partial=false) → flush accumulated text
      //     first (preserving narrative order), then emit a one-line
      //     friendly tool notice. We do NOT echo the tool input JSON or
      //     the raw result; those are noise for WeChat users.
      //   - tool_result / thinking → dropped (next turn's text carries the
      //     conclusion).
      // Deduped per (binding.userId + sender + blockId) so a streaming
      // partial→final re-emit of the same tool_use doesn't announce twice.
      const flushText = async (buf: string[]): Promise<void> => {
        const clean = sanitizeForWechat(buf.join('')).trim()
        buf.length = 0
        if (!clean) return
        for (const c of splitText(clean, 1800)) await w.sendText(senderId, c)
      }
      const textBuf: string[] = []
      for (const b of out.blocks || []) {
        if (b.kind === 'text' && b.text) {
          textBuf.push(b.text)
        } else if (b.kind === 'tool_use' && !b.partial) {
          const dedupeKey = `${userId}:${senderId}:${b.blockId ?? `${b.toolName}:${textBuf.length}`}`
          if (announcedTools.has(dedupeKey)) continue
          announcedTools.add(dedupeKey)
          announcedToolsGc()
          await flushText(textBuf)
          await w.sendText(senderId, `🔧 ${friendlyToolName(b.toolName)}`)
        }
      }
      await flushText(textBuf)
    },

    async shutdown() {
      shuttingDown = true
      if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null }
      await Promise.all(Array.from(workers.values()).map((w) => w.stop().catch(() => {})))
      workers.clear()
    },
  }
}

/**
 * Map raw tool names to a short Chinese label WeChat users can read at a
 * glance. Unknown tools (custom MCPs, Agents spawned, etc.) fall back to the
 * last segment of the tool name so we don't leak implementation detail like
 * `mcp__foo-bar-baz__do_thing` into the chat.
 */
function friendlyToolName(raw: string): string {
  const n = raw.trim()
  const map: Record<string, string> = {
    Read: '读取文件',
    Write: '写入文件',
    Edit: '编辑文件',
    Bash: '执行命令',
    Glob: '查找文件',
    Grep: '搜索内容',
    WebSearch: '联网搜索',
    WebFetch: '抓取网页',
    Task: '调用子助手',
    TodoWrite: '规划任务',
    AskUserQuestion: '向你提问',
    NotebookEdit: '编辑 notebook',
  }
  if (map[n]) return map[n]
  // MCP tools: mcp__server-name__action → try to detect common categories
  if (/minimax-vision.*web_search/i.test(n)) return '联网搜索'
  if (/minimax-vision.*understand_image/i.test(n)) return '识别图片'
  if (/minimax.*text_to_image/i.test(n)) return '生成图片'
  if (/minimax.*text_to_audio/i.test(n)) return '生成语音'
  if (/minimax.*(generate_video|music)/i.test(n)) return '生成媒体'
  if (/browser_/i.test(n)) return '操作浏览器'
  if (/(memory|archival)/i.test(n)) return '访问记忆'
  if (/(session_search)/i.test(n)) return '搜索历史会话'
  if (/(skill_(view|save|list|delete))/i.test(n)) return '查看/保存技能'
  if (/create_reminder|cron/i.test(n)) return '设置定时任务'
  if (/delegate_task|send_to_agent/i.test(n)) return '协作 agent'
  if (/ToolSearch/i.test(n)) return '查询工具'
  // Fallback: strip mcp__ prefix + server name, keep last action segment
  const m = n.match(/^mcp__[^_]+__(.+)$/)
  return m ? m[1] : n
}

/**
 * Strip the markdown syntax that would otherwise render as literal characters
 * in WeChat's plain-text message view (bold stars, headings, inline code
 * backticks, etc.). We intentionally KEEP link URLs visible — WeChat makes
 * bare `https://` URLs tappable — and keep newlines/bullets intact.
 *
 * This is a best-effort cleanup, not a full markdown parser. Fenced code
 * blocks and pre-formatted content come through stripped of their ``` fences
 * but the inner text is preserved verbatim so code/commands stay copy-able.
 */
function sanitizeForWechat(s: string): string {
  if (!s) return ''
  let out = s
  // Fenced code blocks: drop the opening ```lang and the closing ```
  out = out.replace(/```[a-zA-Z0-9_+-]*\n?/g, '').replace(/```/g, '')
  // Inline code `…`
  out = out.replace(/`([^`\n]+)`/g, '$1')
  // Bold / italic: **x**, __x__, *x*, _x_
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  out = out.replace(/__([^_\n]+)__/g, '$1')
  out = out.replace(/(?<![A-Za-z0-9_])\*([^*\n]+)\*(?![A-Za-z0-9_])/g, '$1')
  out = out.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '$1')
  // Links: [text](url)  →  text (url) — keep URL so user can tap it
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1 ($2)')
  // Headings: leading # ## ### on their own line → drop the hashes
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  // Blockquote markers
  out = out.replace(/^\s*>\s?/gm, '')
  // Horizontal rules like ---
  out = out.replace(/^\s*[-*_]{3,}\s*$/gm, '')
  return out
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
