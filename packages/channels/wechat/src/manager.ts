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
import type { WechatImageAttachment } from './iLinkImage.js'
import { WechatWorker, type InboundEvent } from './worker.js'

/**
 * Optional hook event delivered to `onInboundOverride`(P1.7 slice 7c)。
 *
 * Mirrors the dispatcher's `InboundEvent` shape *just enough* for the broker
 * `onInbound(evt)` call site. We re-export the minimal carrier rather than
 * importing commercial's type — channels/wechat must stay commercial-free.
 */
export interface WechatInboundOverrideEvent {
  bindingUserId: string
  /** iLink bot account id; used by commercial broker audit/dedupe namespace. */
  accountId?: string
  senderId: string
  text: string
  /** Stable iLink message id before `idempotencyKey` decoration. */
  messageId?: string
  /** Compact comma-separated inbound item kinds, e.g. `text,voice`. */
  itemTypes?: string
  /** iLink image attachments extracted from rawPayload; URLs/keys are never logged. */
  imageAttachments?: WechatImageAttachment[]
  /** Full raw iLink message payload for broker audit. */
  rawPayload?: unknown
  /** Stable per-message dedup key: `wechat:${bindingUserId}:${senderId}:${messageId}` */
  idempotencyKey: string
  /** ms since epoch; sourced from gateway clock at receive time (not Tencent's `CreateTime`) */
  receivedAt: number
  /** Literal "wechat" — broker.onInbound 用它做 channel guard;不写 `string` 以免
   *  让消费者(gateway CommercialHook.wechatBroker)和 broker InboundEvent 类型对不上。 */
  channel?: 'wechat'
  agentId?: string
}

export interface WechatChannelConfig {
  // Interval (ms) between DB reconciliation passes. Picks up newly added
  // bindings and applies token/status updates without restarting the gateway.
  reconcileIntervalMs?: number
  /**
   * P1.7 slice 7c — broker override hook。当 commercial WeChat broker 装配后,
   * 网关侧把 `(evt) => commercial.wechatBroker.onInbound(evt)` 透传给 manager。
   * 命中时 handleInbound **替换** `ctx.dispatch` 路径,把事件交给 broker 走自己
   * 的 client_sessions 命名空间 + dispatcher → container 链路(详见 RFC §4.1)。
   *
   * 不影响 `/status` / `/new` 等用户面板命令 —— 这些保持走 manager 本地处理,
   * 不进 broker(boss 的诊断 / reset 操作必须始终能用,即使 broker 故障)。
   *
   * 抛错语义:override **不允许抛**;若它内部失败,broker 的 tryCompensation 应
   * 在 master 侧落 compensate;manager 这层只 log 不重抛 —— 重抛会让 worker
   * 的 long-poll loop 误判事件流不可恢复而停摆,影响其他 binding 的 inbound。
   */
  onInboundOverride?: (evt: WechatInboundOverrideEvent) => Promise<unknown> | unknown
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
    await routeWechatInbound(evt, {
      ctx,
      workersCount: workers.size,
      sendText: (uid, sid, msg) => {
        const w = workers.get(uid)
        if (w) w.sendText(sid, msg).catch(() => {})
      },
      onInboundOverride: cfg.onInboundOverride,
      now: () => Date.now(),
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

  // 扩展局部类型:ChannelAdapter 公共契约 + 仅 wechat 暴露的 isWorkerRunning
  // 内省方法(网关侧 duck-type 读取)。
  type WechatAdapter = ChannelAdapter & { isWorkerRunning(userId: string): boolean }
  const adapter: WechatAdapter = {
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

    // Duck-typed introspection for the gateway's /api/wechat/binding GET.
    // DB 里 status=active 但 manager 没有 worker(比如 enabled=false 跳过了 init)
    // 时,让前端能显示"通道未启用,消息收不到"而不是假绿灯。
    // 不进 ChannelAdapter 公共契约 —— 网关侧用本地 type guard 读取。
    //
    // 2026-04-25 Codex IMPORTANT#3: 仅 workers.has() 不够 —— WechatWorker loop
    // 因 auth expire / getupdates 不可恢复 break 或 loop 内未捕获异常而退出时,
    // map entry 仍然在(只有 unbind/shutdown 才 delete),UI 会假绿灯。改成让
    // worker 自己汇报 running 状态,任一阶段停摆都会如实反映到 UI 红字提示。
    isWorkerRunning(userId: string): boolean {
      const w = workers.get(userId)
      return w !== undefined && w.isRunning()
    },
  }
  // 用扩展局部类型而非 `as ChannelAdapter` 断言 —— 断言会使整个对象文字的类型
  // 检查变钝,漏掉 ChannelAdapter 本体成员的类型错误。网关侧依然通过 duck-typing
  // (`{ isWorkerRunning?: ... }`) 读取,不污染 plugin-sdk 的公共契约。
  return adapter
}

/**
 * Pure inbound router(P1.7 slice 7c)。Extracted from `wechatChannelFactory.handleInbound`
 * so the override-vs-dispatch routing logic can be unit-tested without standing
 * up a real `WechatWorker` long-poll loop.
 *
 * **Invariants**(测试套件 wechatChannelOverride.test.ts 断言):
 *   1. `/status` 命中 → 只调用 `sendText`,**不**进 override / dispatch
 *   2. `/new` 命中 → 调用 `ctx.resetSession` + `sendText` 反馈,**不**进 override / dispatch
 *   3. `/help` / `/model` + `onInboundOverride` 已注入 → 交给 broker 产出商业版友好回复
 *   4. `/help` / `/model` + `onInboundOverride` 未注入 → manager 本地 fallback 回复
 *   5. 普通文本 + `onInboundOverride` 已注入 → **只**调 override,**不**调 `ctx.dispatch`
 *   6. 普通文本 + `onInboundOverride` 未注入 → 走原 `ctx.dispatch` 路径
 *   7. override 抛错 → catch + log,**不**重抛(避免污染 worker long-poll loop),
 *      也**不**回落到 `ctx.dispatch`(broker 失败应由 master tryCompensation 兜底,
 *      不能让消息走两套不同的 session 命名空间造成串场)
 */
export interface WechatInboundRouterDeps {
  ctx: ChannelContext
  /** 当前活跃 worker 数(用于 /status 的"活跃 worker"行) */
  workersCount: number
  /** 发文本到 WeChat;manager 内部走 `workers.get(uid)?.sendText`,测试可注入 spy */
  sendText: (userId: string, senderId: string, msg: string) => void
  onInboundOverride?: (evt: WechatInboundOverrideEvent) => Promise<unknown> | unknown
  /** clock 注入便于断言 `ts` / `receivedAt` 字段稳定 */
  now: () => number
}

export async function routeWechatInbound(
  evt: InboundEvent,
  deps: WechatInboundRouterDeps,
): Promise<void> {
  const { ctx, workersCount, sendText, onInboundOverride, now } = deps
  const { binding, senderId, text, messageId } = evt

  // No sender gating — anyone who can reach the bound bot is trusted. The
  // OC owner wants the bot fully open; access control is the WeChat-side
  // friend relationship, not something we replicate here.

  // peer.id embeds the OC user binding so routes and session keys can not
  // collide across users who happen to share a WeChat sender id.
  const peerId = `${binding.userId}:${senderId}`
  const idempotencyKey = `wechat:${binding.userId}:${senderId}:${messageId}`
  const receivedAt = now()

  const forwardToOverride = async (): Promise<void> => {
    if (!onInboundOverride) return
    try {
      await onInboundOverride({
        bindingUserId: binding.userId,
        accountId: binding.accountId,
        senderId,
        text,
        messageId,
        itemTypes: extractIlinkItemTypes(evt.raw),
        ...(evt.imageAttachments.length > 0 ? { imageAttachments: evt.imageAttachments } : {}),
        rawPayload: evt.raw,
        idempotencyKey,
        receivedAt,
        channel: 'wechat',
      })
    } catch (err: any) {
      // 不重抛:worker long-poll loop 不应因 broker 失败而停摆;compensate
      // 由 master 侧 broker.tryCompensation 兜底(参 RFC §4.5)。
      // 不回落 ctx.dispatch —— 否则同一条消息会走两套 session 命名空间,
      // 灰度阶段把 boss 自己的 personal-OC 会话和 broker 的 wsess-* 会话搅在一起。
      ctx.log.error(`[wechat] broker override err for user=${binding.userId} sender=${senderId}: ${err?.message || err}`)
    }
  }

  // ── /help — commercial broker can render richer WeChat-specific help ──
  if (/^\s*\/help\s*$/.test(text)) {
    if (onInboundOverride) {
      await forwardToOverride()
      return
    }
    sendText(
      binding.userId,
      senderId,
      [
        '微信里可以这样用 OpenClaude:',
        '• 直接发消息:继续当前会话',
        '• /new:开启新会话',
        '• /status:查看绑定和 worker 状态',
        '• /model:查看模型说明',
      ].join('\n'),
    )
    return
  }

  // ── /model — commercial broker supports listing / switching models ──
  if (/^\s*\/model(?:\s+.*)?$/.test(text)) {
    if (onInboundOverride) {
      await forwardToOverride()
      return
    }
    sendText(
      binding.userId,
      senderId,
      [
        '微信会跟随你在网页端选择的默认模型。',
        '如需切换模型,请打开 claudeai.chat,在聊天页顶部的模型选择器修改。',
        '修改后,下一条微信消息会使用新的可用模型。',
      ].join('\n'),
    )
    return
  }

  // ── /status — report current binding state to the WeChat user ──
  if (/^\s*\/status\s*$/.test(text)) {
    const lastEvt = binding.lastEventAt
      ? new Date(binding.lastEventAt).toISOString().slice(0, 19).replace('T', ' ')
      : '(无)'
    const msg =
      `OC bot status\n` +
      `account: ${binding.accountId}\n` +
      `status: ${binding.status}\n` +
      `最近事件: ${lastEvt}\n` +
      `活跃 worker: ${workersCount}`
    sendText(binding.userId, senderId, msg)
    return
  }

  // ── /new — start a fresh OpenClaude session for this sender ──
  if (/^\s*\/new\s*$/.test(text)) {
    try {
      if (ctx.resetSession) await ctx.resetSession('wechat', peerId, 'dm')
      sendText(binding.userId, senderId, '已开启新会话。下一条消息将由全新的 agent 处理。')
    } catch (err: any) {
      sendText(binding.userId, senderId, `/new 失败: ${err?.message || err}`)
    }
    return
  }

  // P1.7 slice 7c — broker override 路径(commercial 装配 + WECHAT_BROKER_ENABLED=1 时
  // 注入)。命中后整条 inbound 改走 broker → dispatcher → container 链路,**不**
  // 再调 ctx.dispatch —— 否则 master 侧 personal-OC session 会和 broker 的
  // wsess-* client_sessions 命名空间打架,boss-self-binding 灰度的会话隔离失效。
  // /status /new 在上面已经 return,这里到不了,broker 不会被这些控制命令污染。
  if (onInboundOverride) {
    await forwardToOverride()
    return
  }

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
    ts: receivedAt,
  })
}

export function extractIlinkItemTypes(raw: unknown): string {
  const items = Array.isArray((raw as any)?.item_list) ? (raw as any).item_list : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const kind = ilinkItemTypeLabel(item)
    if (!kind || seen.has(kind)) continue
    seen.add(kind)
    out.push(kind)
  }
  return (out.join(',') || 'unknown').slice(0, 256)
}

function ilinkItemTypeLabel(item: unknown): string {
  const t = Number((item as any)?.type)
  if (t === 1) return 'text'
  if (t === 2) return 'image'
  if (t === 3) return 'voice'
  if (t === 4) return 'video'
  if (Number.isFinite(t)) return `type:${t}`
  return 'unknown'
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
