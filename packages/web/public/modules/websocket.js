// OpenClaude — WebSocket connection, messaging, background tasks
import { abortInflightRefresh, clearProactiveRefresh, silentRefresh } from './api.js'
// V3 file-proxy R4 SHOULD#1:WS 1008 + silentRefresh 失败的 teardown 也要清 oc_session,
// 否则 UI 已 showLogin 但 HttpOnly cookie 还能让 /api/file GET 到,语义分裂。
import { clearSessionCookie } from './auth.js?v=65d9c27'
import { dbPut } from './db.js'
import { $, htmlSafeEscape } from './dom.js'
import { maybeNotify, setTitleBusy } from './notifications.js'
import { _clearStoredAccessToken, getSession, state } from './state.js'
import { maybeSyncNow } from './sync.js'
import { toast } from './ui.js'
// 商用 v3 专用:outbound.cost_charged 扣费帧到达后用这个刷左上角余额气泡。
// 个人版 (master) 不会收到该帧,refreshBalance 里自己判断 _commercialMode 直接 noop。
import { refreshBalance } from './billing.js?v=65d9c27'

// ── Late-binding for circular deps (sessions.js, messages.js) ──
let _deps = {}
export function setWsDeps(deps) {
  _deps = deps
}

// ── Module-private state ──
let _reconnectAttempts = 0
// Tracks whether the browser believes it has network. When false, we
// short-circuit reconnect scheduling (both in connect() and ws.onclose) so a
// lid-closed laptop or unplugged ethernet doesn't double the backoff delay
// on every failed attempt. When it flips back to true the browser fires
// `online`, which calls notifyNetworkOnline() to reset attempts and
// reconnect immediately.
//
// IMPORTANT: initialized optimistically to `true`, NOT from `navigator.onLine`.
// Chrome (especially with enterprise policies, VPN/proxy extensions, or
// virtual NICs) can report `navigator.onLine === false` at page load even
// though the machine can clearly reach the server — we observed this on a
// user's Chrome where all other browsers on the same machine connected fine.
// If we trusted that initial false, `connect()` would short-circuit before
// attempting a WebSocket, `ws.onopen` would never fire to correct the flag,
// and the UI would be permanently stuck at '离线'. Trust `navigator.onLine`
// only via the `offline`/`online` *events* (which fire on actual transitions
// and are more reliable than the initial property read). The worst case of
// this optimism — machine has zero network at page load — gracefully
// degrades into the normal reconnect-backoff path (capped at 30s + jitter)
// instead of the static '离线' UI, which is an acceptable trade.
let _isBrowserOnline = true
// Latch for `offline` events that arrive while the WebSocket is still OPEN.
// Stored as the timestamp (ms) of the most recent deferred offline signal;
// 0 means no latch. `navigator.onLine` misfires on mobile/VPN/background,
// so notifyNetworkOffline refuses to flip the UI to '离线' when WS is live.
// If a real disconnect is happening, ws.onclose fires within a short window
// after the `offline` event; only closes within OFFLINE_LATCH_GRACE_MS of
// the latched offline commit it into `_isBrowserOnline = false`. Later,
// unrelated closes (server restart, proxy flap, backgrounded socket invalidated
// after a tab resumes) MUST NOT be retroactively treated as "the offline was
// real" — they clear the latch without promoting it. Cleared by ws.onopen
// and notifyNetworkOnline (both confirm connectivity).
let _pendingBrowserOfflineAt = 0
// Window during which a ws.onclose can confirm a deferred `offline` event.
// Chosen well above the 30s client keepalive interval + TCP teardown jitter,
// but short enough that a long-lived socket closed hours later for unrelated
// reasons doesn't inherit an ancient offline signal.
const OFFLINE_LATCH_GRACE_MS = 60_000
// Debounce for visibility-triggered immediate reconnects — mobile focus flips
// can fire visibilitychange rapidly and we don't want to spam connect().
let _lastVisibilityReconnectAt = 0
const VISIBILITY_RECONNECT_COOLDOWN_MS = 2000
// 2026-04-22 切后台>15min 再切回触发 1008 踢登录修复:WS 握手用 state.token,
// 切回时 token 已过期 → server close(1008) → 以前直接 showLogin,丢弃了本可用的
// 30 天 refresh cookie。现在 onclose 1008 走一次 silentRefresh,拿到新 access
// 就立刻 reconnect。为防 "refresh 成功后新连接又被 server policy 1008(如 per-user
// 3-conn 上限)"陷入死循环,同一 WS 实例最多只允许一次 refresh 重连;实例间
// 靠 _lastWsAuthRefreshAt 窗口限制,避免重建后的新实例立刻又触发。
let _lastWsAuthRefreshAt = 0
const WS_AUTH_REFRESH_MIN_GAP_MS = 30_000
// Codex R1 发现的 race:silent refresh 跑的异步期间,旧 WS readyState 已是 CLOSED(3),
// connect()/notifyTabVisible()/notifyNetworkOnline() 的 `state.ws.readyState < 2` guard
// 不会拦它们 → visibility/online 或残留 reconnectTimer 会拿**旧 expired state.token**
// 插队新建一个 WS,server 又 close(1008),但插队 WS 的 `_authRefreshTried=false`,
// 且 module-level `_lastWsAuthRefreshAt` 仍在 30s 窗口内 → canRetry 为 false,
// 直接 _tearDownWsAuth,refresh 明明成功却被踢登录。
//
// 补丁:加 module-level 闸门,silent refresh 进行中所有 connect 入口都等它结束。
let _wsAuthRefreshInFlight = false
const _bgTasks = new Map() // id -> { desc, status, startTime, duration, error }

// 2026-04-21 安全审计 Medium#F2:`ws.send()` 在 readyState === OPEN 时永不报错,
// 浏览器在内核内把 frame 压进 `bufferedAmount` 队列,半死连接 / 服务端暂停 /
// 极慢上行时队列可以无限涨 —— 历史上线过 50MB/客户端的 RSS 占用。
//
// 这个 helper 在真发前先看 bufferedAmount:
//   - < SAFE_WS_BUFFER_BYTES     → 正常发,返回 true
//   - ≥ SAFE_WS_BUFFER_BYTES     → 拒发,主动 ws.close(4000, ...) 触发现有
//                                   onclose 重连 + offline 队列补发逻辑;返回 false
//
// 2MB 是对 chat / permission / ping 都宽松的上限:一次用户 prompt 典型 <16KB,
// 2MB 等价 128 条已排队等发的 prompt。真撞到这个阈值只能是连接实际已死或上行
// 完全阻塞;此时不主动 close 会让 socket 半死永久挂起(drain/ping 都只会静默
// 失败,无法自愈),主动 close(4000) 走 onclose→reconnect 是唯一的自愈路径。
// Codex review IMPORTANT#1 指出了这个边界。
const SAFE_WS_BUFFER_BYTES = 2 * 1024 * 1024
const WS_CLOSE_CODE_STALLED = 4000  // app-level,不与 IANA 1xxx/3xxx 冲突
// 2026-04-22 Codex R2 BLOCKING:safeWsSend 必须是所有 WS 发送的唯一入口。
// 历史上只有 drain 和 ping 用了它,主发送 / regen / stop / permission 仍裸 ws.send(),
// 半死连接达到 2MB 阈值时这些路径继续挤 buffer,直到 ping 才触发 close —— 在那之前
// 用户消息已 markStatus='sent' 但实际在 buffer 里滞留,close 后 offlineQueue 里没有
// 这条消息 → 丢失。修复:
//   - export safeWsSend,main.js / messages.js / commands.js 所有发送都走它
//   - 返回 false 时,调用方按自己语义决定 requeue(用户消息)/ drop(stop 类控制帧)
//   - safeWsSend 本身负责 close+reconnect 触发,不需要调用方关心
export function safeWsSend(ws, data) {
  if (!ws || ws.readyState !== 1) return false
  // bufferedAmount 在某些环境下可能 undefined(polyfill / mock);fallback 当 0
  const buffered = typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0
  if (buffered >= SAFE_WS_BUFFER_BYTES) {
    try { console.warn('[ws] send skipped: bufferedAmount', buffered, 'exceeds', SAFE_WS_BUFFER_BYTES, '- closing for reconnect') } catch {}
    // readyState 立即跳到 CLOSING,阻止同一 tick 里其他 send 继续压 buffer。
    // onclose handler 会触发重连并把离线队列里的消息重放。
    try { ws.close(WS_CLOSE_CODE_STALLED, 'bufferedAmount exceeded') } catch {}
    return false
  }
  try {
    ws.send(data)
    return true
  } catch {
    // 2026-04-22 Codex R2 IMPORTANT#2:ws.send() 抛异常不一定伴随 readyState 切换
    // (比如某些浏览器 / polyfill 在 CLOSED 边缘态会先抛 InvalidStateError 但 readyState
    // 还是 OPEN)。不 close 就进不了 onclose→reconnect→drain 链,调用方 requeue 的消息
    // 永远停在 offlineQueue,UI 显示 queued 但没有任何自愈动作。
    try { ws.close(WS_CLOSE_CODE_STALLED, 'send failed') } catch {}
    return false
  }
}

// ── Per-session thinking safety timer ──
// Clears stuck _sendingInFlight if no outbound frame arrives within 10 minutes.
// Must be longer than backend's idle timeout (5min default, 15min for tool calls)
// so it only fires as a last resort when backend fails to send isFinal.
// Reset on every handleOutbound frame; cleared on isFinal.
const THINKING_SAFETY_MS = 10 * 60_000
const _thinkingTimers = new Map() // sessId -> timeoutId

function _resetThinkingSafety(sessId) {
  if (_thinkingTimers.has(sessId)) clearTimeout(_thinkingTimers.get(sessId))
  const tid = setTimeout(() => {
    _thinkingTimers.delete(sessId)
    const s = state.sessions.get(sessId)
    if (s && s._sendingInFlight) {
      console.warn('[ws] Thinking safety timeout for session', sessId)
      // Send stop to backend so the turn is actually interrupted,
      // preventing late frames from being misattributed to a future turn.
      // safeWsSend:若 buffer 堵死直接 close+reconnect,stop 丢了也 OK —— close 时
      // server 端会走 channel cleanup,turn 自然终止(比 stop 帧更彻底)。
      safeWsSend(state.ws, JSON.stringify({
        type: 'inbound.control.stop',
        channel: 'webchat',
        peer: { id: sessId, kind: 'dm' },
        agentId: s.agentId || state.defaultAgentId,
      }))
      s._sendingInFlight = false
      clearTurnTiming(s)
      // Abandon the reply tracker — the turn is being torn down by timeout,
      // so any belated isFinal must NOT retroactively flag this message as
      // an empty turn (or attach to whatever message comes next).
      resetReplyTracker(s)
      if (s.id === state.currentSessionId) {
        state.sendingInFlight = false
        updateSendEnabled()
        hideTypingIndicator()
        setTitleBusy(false)
      }
    }
  }, THINKING_SAFETY_MS)
  _thinkingTimers.set(sessId, tid)
}

export function resetThinkingSafety(sessId) { _resetThinkingSafety(sessId) }

function _clearThinkingSafety(sessId) {
  if (_thinkingTimers.has(sessId)) {
    clearTimeout(_thinkingTimers.get(sessId))
    _thinkingTimers.delete(sessId)
  }
}

// Notification sound (local copy — avoids exporting private from notifications.js)
const _notifSound = (() => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    return () => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.15, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.3)
    }
  } catch {
    return () => {}
  }
})()

// ═══════════════ TYPING INDICATOR ═══════════════
const STALE_WARN_MS = 60_000   // Show warning after 60s without any frame
const STALE_DANGER_MS = 180_000 // Show "likely stuck" after 3 min

// Per-session frame tracking (stored on sess object: sess._lastFrameAt, sess._turnStartedAt)
export function markFrameReceived(sess) {
  if (sess) sess._lastFrameAt = Date.now()
}

// Clear turn-timing fields on a session when the turn actually ends (isFinal / stop / stuck).
// Kept separate from hideTypingIndicator so session switches (which merely hide DOM) do not
// reset timing for a session whose turn is still alive.
export function clearTurnTiming(sess) {
  if (!sess) return
  sess._turnStartedAt = null
  sess._lastFrameAt = null
}

export function showTypingIndicator() {
  const inner = _deps.ensureInner()
  if (inner.querySelector('.typing-indicator')) return
  const el = document.createElement('div')
  el.className = 'typing-indicator'
  el.id = '__typing'
  const sess = getSession()
  const agentInfo = state.agentsList.find((a) => a.id === (sess?.agentId || state.defaultAgentId))
  const av = htmlSafeEscape(agentInfo?.avatarEmoji || 'O')
  const name = agentInfo?.displayName || sess?.agentId || 'AI'
  el.innerHTML = `<div class="avatar">${av}</div><div class="typing-dots"><span></span><span></span><span></span></div><span class="typing-label">${htmlSafeEscape(name)} 思考中</span>`
  // Bind to the session that owned the current view when the indicator was created,
  // so the timer keeps reading the correct session even if the user switches tabs.
  const boundSessId = sess?.id || null
  // Use session-level timestamps; only initialize if not already set (preserves timing on session switch)
  if (sess && !sess._turnStartedAt) sess._turnStartedAt = Date.now()
  if (sess && !sess._lastFrameAt) sess._lastFrameAt = Date.now()
  // Show elapsed time after 5s, with staleness warning
  el._timer = setInterval(() => {
    const _sess = boundSessId ? state.sessions.get(boundSessId) : getSession()
    const startedAt = _sess?._turnStartedAt || Date.now()
    const lastFrame = _sess?._lastFrameAt || Date.now()
    const secs = Math.round((Date.now() - startedAt) / 1000)
    const label = el.querySelector('.typing-label')
    if (!label) return
    const silenceMs = Date.now() - lastFrame
    if (silenceMs >= STALE_DANGER_MS) {
      label.textContent = `${name} 可能已卡住 (${secs}s · 已 ${Math.round(silenceMs / 1000)}s 无响应)`
      el.classList.add('stale-danger')
      el.classList.remove('stale-warn')
    } else if (silenceMs >= STALE_WARN_MS) {
      label.textContent = `${name} 思考中 (${secs}s · ${Math.round(silenceMs / 1000)}s 无新数据)`
      el.classList.add('stale-warn')
      el.classList.remove('stale-danger')
    } else if (secs >= 5) {
      label.textContent = `${name} 思考中 (${secs}s)`
      el.classList.remove('stale-warn', 'stale-danger')
    }
  }, 1000)
  inner.appendChild(el)
  _deps.scrollBottom(true)
}
// DOM-only: removes the typing indicator element + its interval. Does NOT touch session
// timing (use clearTurnTiming for that). Safe to call from session-switch / hide paths.
export function hideTypingIndicator() {
  const el = document.getElementById('__typing')
  if (el?._timer) clearInterval(el._timer)
  el?.remove()
}

// ═══════════════ MESSAGES ═══════════════
export function addMessage(sess, role, text, extra) {
  extra = extra || {}
  const msg = Object.assign({ id: _deps.msgId(), role, text: text || '', ts: Date.now() }, extra)
  sess.messages.push(msg)
  sess.lastAt = Date.now()
  if (role === 'user') {
    const userCount = sess.messages.filter((m) => m.role === 'user').length
    if (userCount === 1) {
      sess.title = (text || '').slice(0, 50) + ((text || '').length > 50 ? '…' : '')
      if (sess.id === state.currentSessionId) $('session-title').textContent = sess.title
    }
  }
  if (sess.id === state.currentSessionId) {
    _deps.renderMessage(msg)
    _deps.scrollBottom(role === 'user')
  }
  return msg
}
export function updateMessage(sess, msg, newText, streaming) {
  msg.text = newText
  if (sess.id === state.currentSessionId) {
    _deps.updateMessageEl(msg, streaming)
    _deps.scrollBottom()
  }
}

// Append/merge a subagent-produced block into its owning Agent card's
// childBlocks list. Mutates groupMsg.childBlocks in place. Caller is
// responsible for calling _deps.updateMessageEl(groupMsg) afterward.
//
// Merge rules:
//   - text/thinking: coalesce with trailing child of the same kind
//     (streaming deltas arrive in small chunks and would otherwise
//     spawn hundreds of empty one-line children).
//   - tool_use: keyed by blockId — partial→final updates the same child.
//   - tool_result: merged onto the matching tool_use child (flips
//     _completed=true, fills output/error). Falls back to a synthetic
//     completed child when no matching tool_use exists (shouldn't
//     happen in practice but guards against dropped frames).
//
// Nested Agent tools: when a subagent itself invokes the Agent tool,
// register that new tool_use id in sess._agentGroups pointing at the
// SAME top-level groupMsg.id. Grand-child subagent blocks whose
// parentToolUseId points at the nested Agent tool_use thus still route
// here, flattening the display to a max of two visual levels per the
// product spec ("再深就都算子 agent").
function _appendSubagentBlock(sess, groupMsg, block, blockText) {
  if (!Array.isArray(groupMsg.childBlocks)) groupMsg.childBlocks = []
  const children = groupMsg.childBlocks

  if (block.kind === 'text') {
    if (!blockText) return
    const last = children[children.length - 1]
    if (last && last.kind === 'text') {
      last.text = (last.text || '') + blockText
    } else {
      children.push({ kind: 'text', text: blockText })
    }
  } else if (block.kind === 'thinking') {
    if (!blockText) return
    const last = children[children.length - 1]
    if (last && last.kind === 'thinking') {
      last.text = (last.text || '') + blockText
    } else {
      children.push({ kind: 'thinking', text: blockText })
    }
  } else if (block.kind === 'tool_use') {
    const existing = block.blockId
      ? children.find((c) => c.kind === 'tool_use' && c.blockId === block.blockId)
      : null
    if (existing) {
      existing.inputPreview = block.inputPreview || existing.inputPreview
      if (block.inputJson !== undefined && block.inputJson !== null) {
        existing.inputJson = block.inputJson
      }
      existing._partial = !!block.partial
      if (block.toolName) existing.toolName = block.toolName
    } else {
      children.push({
        kind: 'tool_use',
        blockId: block.blockId,
        toolName: block.toolName || 'unknown',
        inputPreview: block.inputPreview || '',
        inputJson: block.inputJson != null ? block.inputJson : null,
        _partial: !!block.partial,
        _completed: false,
        output: null,
        error: false,
      })
      if (block.blockId && /^Agent$/i.test(block.toolName || '')) {
        if (!sess._agentGroups) sess._agentGroups = new Map()
        // Point nested Agent tool_use id at the same top-level group, so
        // grand-child subagent output flattens into this card.
        sess._agentGroups.set(block.blockId, groupMsg.id)
      }
    }
  } else if (block.kind === 'tool_result') {
    const toolUseId =
      block.toolUseBlockId ||
      (block.blockId ? String(block.blockId).replace(/:result$/, '') : null)
    const target = toolUseId
      ? children.find((c) => c.kind === 'tool_use' && c.blockId === toolUseId)
      : null
    if (target) {
      target._completed = true
      target.output = block.preview || ''
      target.error = !!block.isError
      target._partial = false
    } else {
      // Orphan result (rare): keep it visible as a standalone completed card.
      children.push({
        kind: 'tool_use',
        blockId: block.blockId,
        toolName: block.toolName || 'unknown',
        inputPreview: '',
        inputJson: null,
        _partial: false,
        _completed: true,
        output: block.preview || '',
        error: !!block.isError,
      })
    }
  }
}

export function setMeta(sess, msg, metaText) {
  msg.metaText = metaText
  if (sess.id === state.currentSessionId) _deps.updateMessageEl(msg)
}

// ── Message status rendering ──
const _STATUS_SVG = {
  sending:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-dasharray="20" stroke-dashoffset="10"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>',
  queued:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  sent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 6 7 17 2 12"/><polyline points="22 6 11 17 8 14"/></svg>',
  replied:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 6 7 17 2 12"/><polyline points="22 6 11 17 8 14"/></svg>',
}
const _STATUS_LABEL = {
  sending: '发送中',
  queued: '排队中',
  sent: '已发送',
  read: '已读',
  replied: '已回复',
}

export function updateMsgStatus(msg) {
  if (msg.role !== 'user' || !msg.status) return
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`)
  if (!el) return
  let statusEl = el.querySelector('.msg-status')
  if (!statusEl) {
    statusEl = document.createElement('div')
    statusEl.className = 'msg-status'
    el.appendChild(statusEl)
  }
  statusEl.className = `msg-status ${msg.status || ''}`
  statusEl.innerHTML = `${_STATUS_SVG[msg.status] || ''}<span>${_STATUS_LABEL[msg.status] || ''}</span>`
}

// ── Offline queue draining (race-safe, no ws.onmessage monkey-patching) ──
// Generation counter: incremented on each new drain cycle. Stale retry callbacks
// check this to avoid re-entering after disconnect/reconnect started a new drain.
let _drainGeneration = 0

// Exported: called by /clear and deleteSession after clearing _offlineDrainingCurrent
// to advance the drain to the next item if there are pending items remaining.
export function nudgeDrain() {
  if (state._drainTimeout) { clearTimeout(state._drainTimeout); state._drainTimeout = null }
  if (state._offlineDrainingCurrent) return  // Still has an active item, don't interfere
  if (state._offlineQueuePending?.length > 0) {
    setTimeout(_drainNextOfflineItem, 500)
  } else {
    state._offlineQueueDraining = false
  }
}

function _drainNextOfflineItem() {
  const gen = _drainGeneration
  const queue = state._offlineQueuePending
  if (!queue || queue.length === 0) {
    state._offlineQueueDraining = false
    state._offlineDrainingCurrent = null
    return
  }
  const item = queue[0]  // Peek first, don't shift yet
  // If the target session has a resumed turn still in flight, wait for it to finish
  const targetSess = state.sessions.get(item.sessId)
  if (targetSess?._sendingInFlight) {
    if (!item._retryCount) item._retryCount = 0
    item._retryCount++
    if (item._retryCount > 60) {
      // Timeout after 60s — move this item to the back and try the next one.
      // Don't force-clear _sendingInFlight as the resumed turn may still be legitimately running.
      queue.shift()
      queue.push(item)
      item._retryCount = 0
      console.warn('[ws] Drain: session', item.sessId, 'still busy after 60s, deferring')
      // If ALL items are for busy sessions, stop draining to avoid infinite loop
      const allBusy = queue.every(q => {
        const s = state.sessions.get(q.sessId)
        return s?._sendingInFlight
      })
      if (allBusy) {
        // Wait 5s then retry — check generation to prevent stale callback
        setTimeout(() => { if (_drainGeneration === gen) _drainNextOfflineItem() }, 5000)
        return
      }
      _drainNextOfflineItem()
      return
    }
    // Wait 1s then retry — check generation to prevent stale callback
    setTimeout(() => { if (_drainGeneration === gen) _drainNextOfflineItem() }, 1000)
    return
  }
  queue.shift()
  state._offlineDrainingCurrent = item
  const ws = state.ws
  if (!ws || ws.readyState !== 1) {
    // Connection lost while draining — push current + remaining back to offline queue
    state.offlineQueue.unshift(item, ...queue)
    state._offlineQueuePending = []
    state._offlineQueueDraining = false
    state._offlineDrainingCurrent = null
    return
  }
  // Medium#F2:safeWsSend 会检查 bufferedAmount,半死连接时拒发并返 false。
  // 拒发时和 throw 一样,把当前 item + 剩余放回 offlineQueue,等重连后再发。
  const sent = safeWsSend(ws, JSON.stringify(item.payload))
  if (!sent) {
    state.offlineQueue.unshift(item, ...queue)
    state._offlineQueuePending = []
    state._offlineQueueDraining = false
    state._offlineDrainingCurrent = null
    return
  }
  const sess = state.sessions.get(item.sessId)
  if (sess) {
    const msg = sess.messages.find((m) => m.id === item.msgId)
    if (msg) {
      msg.status = 'sent'
      updateMsgStatus(msg)
    }
    sess._sendingInFlight = true
    _resetThinkingSafety(sess.id)
    if (sess.id === state.currentSessionId) {
      state.sendingInFlight = true
      updateSendEnabled()
      showTypingIndicator()
      setTitleBusy(true)
    }
  }
  // Safety timeout: if no isFinal arrives in 120s, advance the drain to prevent wedge
  state._drainTimeout = setTimeout(() => {
    if (state._offlineDrainingCurrent === item) {
      console.warn('[ws] Drain isFinal timeout for session', item.sessId)
      // Clear stale sending state for this session
      const stuckSess = state.sessions.get(item.sessId)
      if (stuckSess) {
        stuckSess._sendingInFlight = false
        clearTurnTiming(stuckSess)
        // Drain timeout is abandoning this turn; drop the reply tracker so a
        // belated isFinal can't flag the user message as empty or attach to
        // the next turn that the user kicks off.
        resetReplyTracker(stuckSess)
        if (stuckSess.id === state.currentSessionId) {
          state.sendingInFlight = false
          updateSendEnabled()
          hideTypingIndicator()
          setTitleBusy(false)
        }
      }
      state._offlineDrainingCurrent = null
      if (state._offlineQueuePending?.length > 0) {
        _drainNextOfflineItem()
      } else {
        state._offlineQueueDraining = false
      }
    }
  }, 120000)
  // If no more items, we're done after this response (handleOutbound will clear the flag)
  if (queue.length === 0) state._offlineQueueDraining = false
}

// ═══════════════ WEBSOCKET ═══════════════
export function setStatus(label, klass) {
  state.wsStatus = klass
  const el = $('status')
  if (!el) return
  el.className = `status-pill ${klass}`
  $('status-text').textContent = label
  updateSendEnabled()
}
export function updateSendEnabled() {
  const btn = $('send')
  const svg = btn.querySelector('svg')
  // Allow sending even when disconnected — messages will be queued offline
  // (matching Enter-key behavior which already queues)
  if (state.wsStatus !== 'connected' && !state.sendingInFlight) {
    btn.disabled = false
    btn.classList.remove('stopping')
    if (svg)
      svg.innerHTML = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'
    return
  }
  if (state.sendingInFlight) {
    btn.disabled = false
    btn.classList.add('stopping')
    if (svg) svg.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1"/>'
  } else {
    btn.disabled = false
    btn.classList.remove('stopping')
    if (svg)
      svg.innerHTML = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'
  }
}
// Clears per-turn reply tracker state so the next incoming frame re-binds fresh.
// Must be called from any path that abandons an in-flight turn locally (/clear,
// stop button, agent switch) as well as at isFinal — otherwise the tracker
// dangles and the empty-turn detector plus status-updates mis-attribute to a
// stale or removed user message.
//
// Also stamps `_trackerResetAt` so the stale-final guard in handleOutbound can
// catch late finals that arrive AFTER the reset but BEFORE the next user
// message binds a new target. Without this we'd have a blind window where
// `sess._replyingToMsgId === null` makes the primary guard no-op, and the
// late final would run full isFinal teardown against whatever turn happens
// to bind next. This timestamp is in client time (Date.now) and compared
// against server-stamped `frame.ts` — best effort under normal clock skew;
// see handleOutbound for the caveat.
export function resetReplyTracker(sess) {
  if (!sess) return
  sess._replyingToMsgId = null
  sess._currentTurnBlockCount = 0
  sess._trackerResetAt = Date.now()
}

// Shared local teardown for "user stopped this turn" — keep parity between the stop button
// (stopCurrentTurn) and the /stop slash command so both paths immediately clear UI state
// instead of waiting for the backend's isFinal / safety timers. Callers are responsible for
// sending the WS `inbound.control.stop` frame; this helper only handles local state.
export function localStopTeardown(sess) {
  if (!sess) return
  sess._sendingInFlight = false
  clearTurnTiming(sess)
  if (sess._regenSafetyTimer) {
    clearTimeout(sess._regenSafetyTimer)
    sess._regenSafetyTimer = null
  }
  // Drop reply tracker — any isFinal arriving for the stopped turn should not
  // retroactively flag it as an "empty turn" since the user intentionally cut it.
  resetReplyTracker(sess)
  if (sess.id === state.currentSessionId) {
    state.sendingInFlight = false
    updateSendEnabled()
    hideTypingIndicator()
    setTitleBusy(false)
  }
}

export function stopCurrentTurn() {
  if (!state.sendingInFlight) return
  if (!state.ws || state.ws.readyState !== 1) return
  const sess = getSession()
  if (!sess) return
  safeWsSend(state.ws, JSON.stringify({
    type: 'inbound.control.stop',
    channel: 'webchat',
    peer: { id: sess.id, kind: 'dm' },
    agentId: sess.agentId || state.defaultAgentId,
  }))
  // Immediately tear down local UI state so typing indicator / stop button / title spinner
  // clear without waiting for the backend's isFinal (which can take seconds to minutes,
  // or never arrive if the backend is truly stuck).
  localStopTeardown(sess)
  toast('已发送停止指令')
}
// Network transition: browser reports we've gone offline. Cancel any pending
// backoff timer and show an offline status. We do NOT schedule a new timer —
// the browser will fire `online` when connectivity is back and
// notifyNetworkOnline() will reconnect immediately.
export function notifyNetworkOffline() {
  if (!_isBrowserOnline) return
  // If WS is currently OPEN, treat the `offline` signal as provisional —
  // `navigator.onLine` misfires on mobile/VPN/background and a live WS is
  // stronger evidence. Latch the signal instead of acting on it now:
  //   - Don't flip UI to '离线' (avoids the stuck-'离线'-while-chatting bug).
  //   - Don't set _isBrowserOnline = false (avoids cancelling a legitimate
  //     reconnect in-flight).
  //   - Don't close WS.
  // If the disconnect was real, ws.onclose will fire shortly and will
  // commit the latch into _isBrowserOnline, correctly pausing backoff.
  // If it was a spurious offline, ws.onopen (still OPEN, no close) or a
  // later `online` event will clear the latch harmlessly.
  if (state.ws && state.ws.readyState === 1) {
    _pendingBrowserOfflineAt = Date.now()
    return
  }
  _isBrowserOnline = false
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
  if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
  setStatus('离线', 'disconnected')
}

// Network transition: browser reports we're back online. Reset the attempts
// counter so a fresh network window gets a fresh backoff budget, then
// reconnect immediately if we're not already connected.
export function notifyNetworkOnline() {
  // A fresh `online` event invalidates any latched offline signal: even if
  // we short-circuited the UI flip earlier (WS was OPEN), the browser is
  // now re-affirming network availability, so a later WS close should NOT
  // be treated as a real-offline case.
  _pendingBrowserOfflineAt = 0
  // NOTE: Previously this function had `if (_isBrowserOnline) return` as a
  // duplicate-event guard. That guard became a bug once we switched to the
  // optimistic `_isBrowserOnline = true` initialization: when the machine
  // boots with no network, `connect()` attempts anyway, fails, and enters
  // backoff without anything ever flipping `_isBrowserOnline` to false
  // (the browser may not fire `offline` for "already offline at load").
  // The `online` event that later signals real recovery would then be
  // swallowed, leaving the user stuck waiting out the current backoff
  // timer (up to 30s) instead of reconnecting immediately. Dedupe is now
  // handled by the `state.ws.readyState < 2` guard below, which is
  // idempotent for truly duplicate events.
  _isBrowserOnline = true
  if (!state.token) return
  // 等待 WS silent-refresh 完成 —— 在它收尾时自己会 call connect()。此处跳过
  // 避免 race:否则会用旧 expired state.token 插队新 WS(见 _wsAuthRefreshInFlight
  // 声明处的注释)。
  if (_wsAuthRefreshInFlight) return
  _reconnectAttempts = 0
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
  if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
  // If already connected or connecting, leave it alone.
  if (state.ws && state.ws.readyState < 2) return
  connect()
}

// Visibility transition: tab just became visible. Mobile/desktop can pause
// the JS event loop when a tab is hidden, which lets a pending reconnect
// timer stretch well beyond its nominal delay. Hitting the backend now
// avoids the user waiting out residual backoff on return. We preserve
// `_reconnectAttempts` so subsequent failures continue the current backoff
// ladder rather than hammering the server.
export function notifyTabVisible() {
  if (!state.token) return
  if (!_isBrowserOnline) return
  // 同 notifyNetworkOnline:silent refresh 进行中别插队。
  if (_wsAuthRefreshInFlight) return
  if (state.ws && state.ws.readyState < 2) return
  const now = Date.now()
  if (now - _lastVisibilityReconnectAt < VISIBILITY_RECONNECT_COOLDOWN_MS) return
  _lastVisibilityReconnectAt = now
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
  if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
  connect()
}

// 1008 分支的兜底:silentRefresh 不可用(cookie 被浏览器清了 / 后端拒绝 / 超过
// 重试窗口)时走原 hard-logout 路径 —— 清掉本地 token、toast 提示、showLogin。
// 不 call /api/auth/logout:我们根本没拿到有效 refresh cookie,server 那边无 row
// 可 revoke;反过来让 _forceLogout 的用户主动 logout 保留唯一 server-side 吊销入口。
function _tearDownWsAuth() {
  // 2026-04-22 Codex R3:先 abort 再清 state。同 _forceLogout 的双层防护模型。
  abortInflightRefresh()
  // 清主动续期 timer —— WS hard-teardown 后不再需要。
  clearProactiveRefresh()
  // R4 SHOULD#1:WS 1008 / silentRefresh 失败的 hard-logout 路径也要清 oc_session,
  // 否则 UI 已 showLogin 但 HttpOnly cookie 还能让 /api/file 请求通过,语义分裂。
  // 用 void 不 await —— teardown 要立即完成,cookie 清理失败不阻塞主流程(最坏
  // 情况是 cookie 自然过期 ≤30d)。
  void clearSessionCookie()
  localStorage.removeItem('openclaude_token')
  localStorage.removeItem('openclaude_refresh_token')
  // 2026-04-24 "记住我":access token 可能落在 localStorage 或 sessionStorage,两处都清。
  _clearStoredAccessToken()
  state.token = ''
  state.refreshToken = ''
  state.tokenExp = 0
  // bump authEpoch —— WS 1008 + silentRefresh 失败这条路径也是身份变更点
  // (从"可能有效"变为"确认无效"),任何正在跑的 _doRefreshOnce 或其他路径
  // 在它们 commit 前都应放弃。主 _forceLogout 在 main.js,这里独立 bump 避免
  // 交叉依赖。
  state.authEpoch = (state.authEpoch || 0) + 1
  toast('Token 无效或已过期，请重新登录', 'error')
  _deps.showLogin()
}

export function connect() {
  if (!state.token) return  // No token (logged out) — don't connect
  // Silent refresh 进行中:不允许用当前(可能已过期的)state.token 起新 WS。
  // IIFE 完成后会自己 call connect(),那次才是合法的。
  if (_wsAuthRefreshInFlight) return
  if (state.ws && state.ws.readyState < 2) return
  // If the browser reports offline, don't attempt — the `online` handler
  // (notifyNetworkOnline) will call connect() when network comes back.
  if (!_isBrowserOnline) {
    setStatus('离线', 'disconnected')
    return
  }
  setStatus('连接中…', 'connecting')
  // Use Sec-WebSocket-Protocol for auth instead of query string (avoids token in URL/logs)
  // **v3 commercial 路径**:浏览器 → /ws/user-chat-bridge → commercial gateway 桥接 →
  // 用户独立 docker 容器内的 personal-version /ws → 容器内 fork ccb。
  // bridge 是 byte-exact 透传,前端不感知协议差异。
  const url = `${(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host}/ws/user-chat-bridge`
  const ws = new WebSocket(url, ['bearer', state.token])
  state.ws = ws
  ws.onopen = () => {
    _reconnectAttempts = 0
    // A successful WebSocket handshake is proof the network is reachable,
    // so clear any stale `_isBrowserOnline = false` left by a spurious
    // `offline` event (mobile network hand-offs, VPN/proxy flaps, and some
    // Chromium backgrounding paths can fire `offline` without a matching
    // `online`, leaving the UI stuck on '离线' even though the WS is alive).
    // Also drop any latched offline signal — onopen proves the prior
    // offline event was spurious (network is clearly up).
    _isBrowserOnline = true
    _pendingBrowserOfflineAt = 0
    if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
    setStatus('已连接', 'connected')
    // Restore UI state for the current session if it was mid-turn before disconnect
    const _currentSess = getSession()
    if (_currentSess?._sendingInFlight) {
      state.sendingInFlight = true
      updateSendEnabled()
      showTypingIndicator()
      setTitleBusy(true)
    }
    // Safety timeout: if sessions that were in-flight BEFORE this reconnect still
    // have _sendingInFlight after 30s, auto-clear them. The snapshot Set is stored
    // in state so that isFinal handlers can remove resolved sessions — preventing
    // the timer from accidentally clearing a NEW turn started after reconnect.
    if (state._reconnectInFlightTimer) clearTimeout(state._reconnectInFlightTimer)
    state._reconnectInFlightSet = new Set()
    for (const [id, s] of state.sessions) {
      if (s._sendingInFlight) state._reconnectInFlightSet.add(id)
    }
    if (state._reconnectInFlightSet.size > 0) {
      state._reconnectInFlightTimer = setTimeout(() => {
        state._reconnectInFlightTimer = null
        const snapped = state._reconnectInFlightSet
        state._reconnectInFlightSet = null
        if (!snapped) return
        for (const sessId of snapped) {
          const s = state.sessions.get(sessId)
          if (s && s._sendingInFlight) {
            console.warn('[ws] Clearing stuck _sendingInFlight for session', s.id)
            s._sendingInFlight = false
            clearTurnTiming(s)
            // Reconnect safety cleared the turn locally — drop the reply
            // tracker so any isFinal the gateway eventually delivers cannot
            // retroactively flag the abandoned turn as empty or mis-attach
            // to a later user message.
            resetReplyTracker(s)
            if (s.id === state.currentSessionId) {
              state.sendingInFlight = false
              updateSendEnabled()
              hideTypingIndicator()
              setTitleBusy(false)
            }
          }
        }
      }, 30000)
    } else {
      state._reconnectInFlightSet = null
    }
    // Send hello with all active session peer IDs so gateway can auto-resume.
    // Include inFlight flag so gateway only pushes turn-interrupted for stuck sessions.
    // Phase 0.4: include lastFrameSeq per peer so gateway can replay buffered
    // outbound frames the client missed during the disconnect window. 0 means
    // "I've never received a frameSeq'd frame" (fresh tab or legacy client).
    try {
      const peers = []
      for (const [id, s] of state.sessions) {
        peers.push({
          peerId: id,
          agentId: s.agentId || state.defaultAgentId,
          inFlight: !!s._sendingInFlight,
          lastFrameSeq: s._lastFrameSeq || 0,
        })
      }
      // onopen 瞬间 bufferedAmount 必为 0,safeWsSend 只是保持统一入口
      safeWsSend(ws, JSON.stringify({ type: 'inbound.hello', channel: 'webchat', peers }))
    } catch {}
    // Flush offline queue — delay drain start to let hello/resume isFinals arrive first.
    // This prevents a resumed turn's isFinal from being mistaken for a drain response.
    if (state._offlineDrainTimer) clearTimeout(state._offlineDrainTimer)
    if (state.offlineQueue.length > 0) {
      const totalCount = state.offlineQueue.length
      state._offlineDrainTimer = setTimeout(() => {
        state._offlineDrainTimer = null
        if (!state.ws || state.ws.readyState !== 1) return  // Disconnected before timer fired
        if (state.offlineQueue.length === 0) return
        state._offlineQueuePending = [...state.offlineQueue]
        state.offlineQueue = []
        state._offlineQueueDraining = true
        _drainGeneration++  // Invalidate any stale retry callbacks from previous drain cycle
        _drainNextOfflineItem()
        toast(`${totalCount} 条离线消息开始发送`)
      }, 3000)
    }
  }
  // Client-side keepalive: prevent mobile browser from killing WS during long tasks
  const _wsKeepAlive = setInterval(() => {
    // Medium#F2:ping 走 safeWsSend —— 半死连接下 bufferedAmount 会失控增长
    safeWsSend(ws, '{"type":"ping"}')
  }, 30000)

  ws.onclose = (e) => {
    clearInterval(_wsKeepAlive)
    // Guard: ignore close events from stale sockets (a newer connect() may have replaced state.ws)
    if (state.ws !== ws) return
    // 2026-04-23 改造:close code + reason 进结构化 log,事后排障能对齐 gateway
    // 侧 ws_close 日志。之前只有"已断线"三个字 UI 态,用户截图运维无从下手。
    try {
      console.warn('[ws] close', {
        code: e?.code,
        reason: typeof e?.reason === 'string' ? e.reason.slice(0, 200) : '',
        wasClean: !!e?.wasClean,
        reconnectAttempts: _reconnectAttempts,
      })
    } catch {}
    if (state._offlineDrainTimer) { clearTimeout(state._offlineDrainTimer); state._offlineDrainTimer = null }
    if (state._drainTimeout) { clearTimeout(state._drainTimeout); state._drainTimeout = null }
    if (state._reconnectInFlightTimer) { clearTimeout(state._reconnectInFlightTimer); state._reconnectInFlightTimer = null; state._reconnectInFlightSet = null }
    setStatus('已断线', 'disconnected')
    // Only clear global UI sending state — keep per-session _sendingInFlight
    // so that after reconnect + hello/resume, sessions can restore their loading state
    state.sendingInFlight = false
    // Re-queue all pending drain items + the in-flight one.
    // The gateway auto-resume + idempotencyKey dedup ensures no duplicate turns.
    {
      const requeue = []
      if (state._offlineDrainingCurrent) requeue.push(state._offlineDrainingCurrent)
      if (state._offlineQueuePending?.length > 0) requeue.push(...state._offlineQueuePending)
      if (requeue.length > 0) state.offlineQueue.unshift(...requeue)
      state._offlineDrainingCurrent = null
      state._offlineQueuePending = []
    }
    state._offlineQueueDraining = false
    updateSendEnabled()
    hideTypingIndicator()
    if (e.code === 1008) {
      // 最常见成因:WS 握手用的 state.token(= access JWT)已过期 —— 切后台>15min
      // 回来首次 reconnect 会中招。refresh cookie(30 天)通常还在,先 silentRefresh
      // 拿新 access 再 reconnect,别把 30 天会话当 15 分钟会话打死。
      //
      // 限流:同一 WS 实例最多尝试 1 次(_authRefreshTried),外加全局 30s 窗口
      // (_lastWsAuthRefreshAt)防止"refresh 成功 → 新连接又 1008(比如 per-user
      // 3-conn 上限 / preCheck 拒绝)→ 再 refresh"的尖峰循环。兜不住的(无
      // cookie / refresh 失败 / 重连后 server 再 1008)最终回落到原 showLogin 路径。
      const now = Date.now()
      const canRetry = state.token
        && !ws._authRefreshTried
        && (now - _lastWsAuthRefreshAt) > WS_AUTH_REFRESH_MIN_GAP_MS
      if (canRetry) {
        ws._authRefreshTried = true
        _lastWsAuthRefreshAt = now
        _wsAuthRefreshInFlight = true
        // 2026-04-22 Codex R2:capture authEpoch 在启动 refresh 之前。async
        // 期间用户若 _forceLogout / 登别的账号 / 其他路径已 _tearDownWsAuth
        // (三处都 bump epoch),这次 IIFE 的结果再操作 WS 就是 "帮上一个身份
        // 续连" —— 既可能把 logout 撤掉,也可能给新账号建错误的 WS。epoch
        // 一变就全盘放弃:不 connect(),也不 tearDown(teardown 已由 bump
        // 者或其他路径负责)。
        const epochAtStart = state.authEpoch || 0
        setStatus('会话续期中…', 'connecting')
        ;(async () => {
          let ok = false
          try {
            ok = await silentRefresh().catch(() => false)
          } finally {
            _wsAuthRefreshInFlight = false
          }
          // Epoch 变了 → 当前身份已不是启动 refresh 时的那个,直接撤退。
          // teardown 的路径(_forceLogout / 并发 _tearDownWsAuth)已经或
          // 即将清完 state,我们再动手只会干扰。
          if ((state.authEpoch || 0) !== epochAtStart) return
          // 期间可能被 _forceLogout 等清了 state.token → 视为失败,交给 showLogin。
          // 或在 async 期间用户登了别的账号(state.ws 换成了一个 CONNECTING/OPEN
          // 的新 socket)→ 这种情况由 connect() 自己的 readyState 守卫拦截,
          // 我们无脑 call connect() 也不会产生重复 WS。
          if (ok && state.token) {
            connect()
          } else {
            _tearDownWsAuth()
          }
        })()
        return
      }
      _tearDownWsAuth()
      return
    }
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
    // Don't auto-reconnect if logged out (no token)
    if (!state.token) return
    // A `offline` event that arrived while WS was still OPEN is only
    // "confirmed real" if this close happens within a short grace window
    // after it, OR the browser still reports navigator.onLine === false
    // right now. The latter rescues the "system/tab was suspended for
    // minutes, so Date.now() elapsed ≫ grace, but the machine is still
    // disconnected" case — without it we'd drop a real-offline latch and
    // burn exponential backoff against no network. Stale latches where
    // the browser is back online (unrelated later closes: server restart,
    // proxy flap, backgrounded socket invalidated on resume) are still
    // discarded. A promoted latch flips `_isBrowserOnline = false`, which
    // the reconnect-gate below honors to pause backoff until `online`.
    if (_pendingBrowserOfflineAt > 0) {
      const elapsed = Date.now() - _pendingBrowserOfflineAt
      const browserStillOffline = typeof navigator !== 'undefined' && navigator.onLine === false
      _pendingBrowserOfflineAt = 0
      if (browserStillOffline || elapsed <= OFFLINE_LATCH_GRACE_MS) {
        _isBrowserOnline = false
      }
    }
    // Don't auto-reconnect while browser reports offline — wait for `online`
    // event (notifyNetworkOnline) to trigger reconnect. Otherwise we'd burn
    // reconnect attempts (each doubling the backoff) against no network.
    if (!_isBrowserOnline) {
      setStatus('离线', 'disconnected')
      return
    }
    const delay = Math.min(2000 * Math.pow(2, _reconnectAttempts), 30000) + Math.random() * 1000
    _reconnectAttempts++
    if (delay >= 4000) {
      let remaining = Math.ceil(delay / 1000)
      setStatus(`${remaining} 秒后重连…`, 'disconnected')
      state.reconnectCountdown = setInterval(() => {
        remaining--
        if (remaining > 0) {
          setStatus(`${remaining} 秒后重连…`, 'disconnected')
        } else {
          clearInterval(state.reconnectCountdown)
          state.reconnectCountdown = null
        }
      }, 1000)
    }
    state.reconnectTimer = setTimeout(connect, delay)
  }
  // 2026-04-23 改造:onerror 不再完全吞。WS Error event 本身不带 reason(浏览器
   // 规范没暴露,onclose 才带),但至少打一条带 readyState 的 warn,让 F12 能
   // 看到"socket 层出过错"这个信号 —— 之前这行是空函数,完全不可见。
  ws.onerror = (ev) => {
    try {
      console.warn('[ws] error', {
        readyState: ws?.readyState,
        // 多数浏览器 event.type 就是 'error',其他字段隐私敏感规范不暴露
        type: ev?.type,
        url: ws?.url,
      })
    } catch {}
  }
  ws.onmessage = (ev) => {
    // Guard: ignore messages from stale sockets
    if (state.ws !== ws) return
    // 拆 parse vs dispatch 两段 try/catch —— 避免把 frame payload 当诊断信息 log 出去。
    // outbound.message.message 里可能夹用户输入、模型输出、余额、payload 片段,
    // F12 截图或诊断 dump 泄漏这些是安全事故(codex R2 #3)。
    // 解析阶段失败:只有这时帧才是"看不见"的,log 长度/前缀长度即可,不落原文。
    // 派发阶段失败:已拿到结构化对象,只 log 安全字段(type + 键名)+ err。
    let f
    try {
      f = JSON.parse(ev.data)
    } catch (e) {
      try {
        const rawLen = typeof ev?.data === 'string'
          ? ev.data.length
          : (ev?.data?.byteLength ?? -1)
        console.warn('[ws] bad frame (parse)', {
          err: e?.message || String(e),
          rawLen,
        })
      } catch {}
      return
    }
    try {
      if (f.type === 'outbound.message') handleOutbound(f)
      else if (f.type === 'outbound.permission_request') handlePermissionRequest(f)
      else if (f.type === 'outbound.permission_settled') handlePermissionSettled(f)
      else if (f.type === 'outbound.resume_failed') handleResumeFailed(f)
      else if (f.type === 'outbound.cost_charged') handleCostCharged(f)
      else if (f.type === 'outbound.ack' && f.deduplicated) {
        // Server already processed this message; clear drain state so queue continues
        if (state._offlineDrainingCurrent) {
          state._offlineDrainingCurrent = null
          nudgeDrain()
        }
      }
    } catch (e) {
      try {
        console.warn('[ws] dispatch failed', {
          err: e?.message || String(e),
          type: typeof f?.type === 'string' ? f.type : null,
          keys: f && typeof f === 'object' ? Object.keys(f).slice(0, 16) : [],
        })
      } catch {}
    }
  }
}
export function formatMeta(m) {
  if (!m) return ''
  const parts = []
  // 商用版 claudeai.chat:后端扣费完成后会推一帧 outbound.cost_charged 给前端,
  // 前端会把 costCredits(bigint string,单位=分=积分)塞进 msg._rawMeta 再 re-format。
  // 这里优先显示真实扣费积分,容器的 m.cost($ 估算)作 fallback。
  // 约定:m.costCredits 存在且 ≥ 0 → 走积分;缺失 → 走旧的 $ 估算。
  if (m.costCredits !== undefined && m.costCredits !== null) {
    parts.push(formatCreditsInline(m.costCredits))
  } else if (typeof m.cost === 'number') {
    parts.push(`$${m.cost.toFixed(4)}`)
  }
  if (typeof m.totalCost === 'number' && m.totalCost !== m.cost && m.costCredits === undefined)
    parts.push(`total $${m.totalCost.toFixed(4)}`)
  if (typeof m.inputTokens === 'number') parts.push(`in ${m.inputTokens}`)
  if (typeof m.outputTokens === 'number') parts.push(`out ${m.outputTokens}`)
  if (m.cacheReadTokens > 0) parts.push(`cache-r ${m.cacheReadTokens}`)
  if (m.cacheCreationTokens > 0) parts.push(`cache-w ${m.cacheCreationTokens}`)
  if (typeof m.turn === 'number') parts.push(`T${m.turn}`)
  return parts.join(' · ')
}

// credits(= 分 = ¥0.01)→ 中文可读字串。
// 与 billing.js 里的 formatCredits/formatYuan 规则对齐:≥1元 显示"X.XX 元",<1元 显示"XX 积分"。
// 1 元以下用"积分"字样更直观(不必 ¥0.03 这种小数),超 1 元切"¥"更省空间。
function formatCreditsInline(raw) {
  let n
  try {
    // BigInt 字符串首选路径 —— 后端发的 outbound.cost_charged.costCredits 就是这个。
    if (typeof raw === 'string' && /^-?\d+$/.test(raw)) n = BigInt(raw)
    else if (typeof raw === 'number' && Number.isFinite(raw)) n = BigInt(Math.trunc(raw))
    else if (typeof raw === 'bigint') n = raw
    else return ''
  } catch { return '' }
  if (n < 0n) n = -n
  if (n >= 100n) {
    // ≥1元 口径:X.XX 元(保留两位小数)
    const yuan = n / 100n
    const cents = n % 100n
    const fraction = cents < 10n ? `0${cents}` : `${cents}`
    return `¥${yuan}.${fraction}`
  }
  return `${n} 积分`
}
export function buildToolUseLabel(block) {
  const name = block.toolName || 'unknown'
  const preview = (block.inputPreview || '').trim()
  const ellipsis = block.partial && preview ? ' …' : ''
  const body = preview ? `  ${preview}${ellipsis}` : block.partial ? '  …' : ''
  return name + body
}
export function handleOutbound(frame) {
  const peerId = frame.peer?.id
  let sess = peerId ? state.sessions.get(peerId) : null
  if (!sess) {
    if (frame.cronJob) {
      // Cron/task push for unknown peer: show in current session with cron badge
      // (creating a new session would be disruptive; the cronPush flag marks it visually)
      sess = getSession()
      if (!sess) return
    } else if (!peerId) {
      // Broadcast (no peer): show in current session
      sess = getSession()
      if (!sess) return
    } else {
      // Unknown peerId: silently ignore
      console.warn('[ws] Ignoring frame for unknown peer:', peerId)
      return
    }
  }
  // ── Phase 0.3/0.4: frameSeq dedupe ──
  // Gateway stamps a per-session monotonic `frameSeq` on every outbound frame.
  // After a WS reconnect the gateway replays buffered frames >= our cursor +1;
  // if multiple tabs resume concurrently or a quick flap duplicates deliveries
  // we reject anything we've already processed. Update the cursor only on
  // strictly-forward frames so out-of-order deliveries never regress it.
  if (typeof frame.frameSeq === 'number' && frame.frameSeq > 0) {
    const last = sess._lastFrameSeq || 0
    if (frame.frameSeq <= last) {
      return // already processed — drop silently
    }
    sess._lastFrameSeq = frame.frameSeq
  }
  if (!sess._blockIdToMsgId) {
    // Rebuild blockId→msgId and agentGroups mappings from restored messages (after page refresh)
    sess._blockIdToMsgId = new Map()
    if (!sess._agentGroups) sess._agentGroups = new Map()
    for (const m of sess.messages) {
      if (m.blockId) sess._blockIdToMsgId.set(m.blockId, m.id)
      if (m.role === 'agent-group' && m.blockId) {
        sess._agentGroups.set(m.blockId, m.id)
        // Nested Agent tool_use ids (recorded in childBlocks) must also
        // be re-registered after a refresh — otherwise a subagent that
        // spawned a grand-child before the user refreshed would have
        // the grand-child's live output fall back to the main stream.
        if (Array.isArray(m.childBlocks)) {
          for (const ch of m.childBlocks) {
            if (
              ch &&
              ch.kind === 'tool_use' &&
              ch.blockId &&
              /^Agent$/i.test(ch.toolName || '')
            ) {
              sess._agentGroups.set(ch.blockId, m.id)
            }
          }
        }
      }
    }
  }
  // Early stale-final guard (best effort): drop late isFinal frames from a
  // turn the user already abandoned locally (stop / agent switch / timeout).
  // Two cases — both require `frame.ts` (server-stamped) to be present:
  //   1. Tracker is still bound to a user msg. If `frame.ts` predates that
  //      user msg, this final belongs to an older turn.
  //   2. Tracker was reset by stop/switch/timeout but the fresh turn hasn't
  //      bound yet. If `frame.ts` predates `_trackerResetAt` (the moment the
  //      local abandon happened), this final must be from the turn we just
  //      cut — drop it rather than let it bind to the upcoming turn.
  // Caveat: these comparisons cross clock domains (server ts vs client
  // Date.now). Under normal clock skew (<5s), both halves work. If the user's
  // device clock runs significantly ahead of the server, a fresh final could
  // be misclassified as stale and dropped — a known residual risk tracked
  // for a future protocol upgrade (server-stamped turnId/ack).
  if (frame.isFinal && typeof frame.ts === 'number') {
    if (sess._replyingToMsgId) {
      const boundMsg = sess.messages.find((m) => m.id === sess._replyingToMsgId)
      if (boundMsg && typeof boundMsg.ts === 'number' && frame.ts < boundMsg.ts) {
        console.warn('[ws] dropping stale isFinal (predates bound user msg)', {
          sessionId: sess.id,
          targetMsgId: boundMsg.id,
          frameTs: frame.ts,
          targetTs: boundMsg.ts,
        })
        return
      }
    } else if (
      typeof sess._trackerResetAt === 'number' &&
      frame.ts < sess._trackerResetAt
    ) {
      console.warn('[ws] dropping stale isFinal (predates tracker reset)', {
        sessionId: sess.id,
        frameTs: frame.ts,
        trackerResetAt: sess._trackerResetAt,
      })
      return
    }
  }
  // Reset thinking safety timer on every incoming frame (proves backend is alive)
  if (sess._sendingInFlight && !frame.isFinal) _resetThinkingSafety(sess.id)
  if (frame.isFinal) _clearThinkingSafety(sess.id)
  // Ignore late frames from before an agent switch — prevents cross-agent contamination
  if (sess._agentSwitchedAt && frame.ts && frame.ts < sess._agentSwitchedAt) return
  // Also ignore non-final frames if they arrive within 2s of an agent switch and we're not sending
  if (sess._agentSwitchedAt && !sess._sendingInFlight && !frame.isFinal && Date.now() - sess._agentSwitchedAt < 2000) return
  // Track last frame time for staleness detection (AFTER agent-switch filtering)
  if (frame.blocks?.length > 0 || frame.isFinal) markFrameReceived(sess)
  // Any streaming output proves this turn is alive — remove from reconnect safety set
  if (state._reconnectInFlightSet && (frame.blocks?.length > 0 || frame.isFinal)) {
    state._reconnectInFlightSet.delete(sess.id)
  }
  // NOTE: typing indicator stays visible throughout the whole turn (only hidden on isFinal
  // below). This lets staleness detection kick in during mid-stream stalls — e.g. when the
  // model emits an initial thinking/tool_use/text block and then goes silent for minutes,
  // the indicator shows a "N秒无新数据" warning instead of the UI appearing to be working.
  // Update user message status: find the most recent user msg in THIS session
  // that is still pending (sent/read but not replied). Only update one msg per turn.
  // Also track a per-turn content-block counter so we can detect "empty turn"
  // (isFinal arrives without any preceding text/thinking/tool block) — that state
  // otherwise leaves the user message marked "已回复" with nothing to show.
  if (!sess._replyingToMsgId) {
    // Only match sent/read messages — skip 'queued' (not yet sent, shouldn't be marked read/replied)
    const pending = [...sess.messages].reverse().find(
      (m) => m.role === 'user' && m.status && m.status !== 'replied' && m.status !== 'queued'
    )
    if (pending) {
      sess._replyingToMsgId = pending.id
      sess._currentTurnBlockCount = 0
    }
  }
  const _targetMsg = sess._replyingToMsgId
    ? sess.messages.find((m) => m.id === sess._replyingToMsgId)
    : null
  // If tracker points at a stale/removed message (e.g. after /clear mid-turn),
  // recover by dropping the tracker so the next frame re-binds fresh.
  if (sess._replyingToMsgId && !_targetMsg) {
    resetReplyTracker(sess)
  }
  // Count content blocks for this turn (before isFinal processing). Count blocks
  // from BOTH streaming and final frames — the gateway has several final-with-content
  // paths (rate-limit rejection, upload rejection, run-error, webhook delivery, etc.)
  // where isFinal:true arrives carrying the only text block of the turn. Ignoring
  // final-frame blocks here would cause those legitimate responses to be flagged as
  // empty and trigger a spurious "本轮响应为空" warning BEFORE the real block is
  // rendered (addMessage/block-apply happens later in this function).
  if (
    _targetMsg &&
    Array.isArray(frame.blocks) &&
    frame.blocks.length > 0
  ) {
    sess._currentTurnBlockCount = (sess._currentTurnBlockCount || 0) + frame.blocks.length
  }
  if (_targetMsg) {
    if (
      frame.blocks?.length > 0 &&
      _targetMsg.status !== 'read' &&
      _targetMsg.status !== 'replied'
    ) {
      _targetMsg.status = 'read'
      updateMsgStatus(_targetMsg)
    }
    if (frame.isFinal) {
      // Stale-final frames were already dropped at the top of handleOutbound
      // via an early return, so by the time we get here the frame is known
      // to be current. Run the empty-turn detector and close the tracker.
      // Detect empty-turn by directly inspecting the message array: did any
      // content-bearing message get added AFTER the target user message?
      // This is more robust than relying on transient streaming pointers.
      // Roles considered content: assistant, thinking, tool, agent-group,
      // and permission (permission prompts are visible cards that count as
      // real turn output).
      let producedContent = false
      const targetIdx = sess.messages.findIndex((m) => m.id === _targetMsg.id)
      if (targetIdx >= 0) {
        for (let i = targetIdx + 1; i < sess.messages.length; i++) {
          const r = sess.messages[i].role
          if (
            r === 'assistant' ||
            r === 'thinking' ||
            r === 'tool' ||
            r === 'agent-group' ||
            r === 'permission'
          ) {
            producedContent = true
            break
          }
        }
      }
      if (
        !producedContent &&
        !sess._currentTurnBlockCount &&
        !sess._streamingAssistant &&
        !sess._streamingThinking
      ) {
        // Empty turn (isFinal with zero content blocks) has two very
        // different root causes:
        //
        //   (1) Model preference — Opus 4.7 (and other newer Claudes)
        //       routinely end_turn without any text block after a tool
        //       call completes, or when the user's follow-up is a meta
        //       question it judges needs no answer. The session is healthy.
        //
        //   (2) Real backend fault — rate-limit swallowed upstream, gateway
        //       returning isFinal on a dead subprocess, etc.
        //
        // Classifying these two reliably from frontend state is risky (see
        // history: a prior "prior turn had content → silent" heuristic
        // would mask case 2 any time it followed a successful case 1).
        // Instead we always show a single non-alarmist notice and let the
        // *wording* differentiate: if the previous turn produced content,
        // we say "模型本轮未输出新内容"; otherwise "未收到回复". Either
        // way it's an info-level notice, not a red error, so users don't
        // distrust the UI — but real faults remain visible.
        //
        // Walk backwards from target user msg until we hit another user
        // msg (= previous turn boundary) or the start of the array. If the
        // previous turn contains any content-bearing block, treat as the
        // "likely model preference" variant. Role set here mirrors the
        // producedContent check above (including 'permission') so the two
        // classifiers agree on what counts as "content".
        let priorTurnHadContent = false
        for (let i = targetIdx - 1; i >= 0; i--) {
          const r = sess.messages[i].role
          if (r === 'user') break
          if (
            r === 'assistant' ||
            r === 'thinking' ||
            r === 'tool' ||
            r === 'agent-group' ||
            r === 'permission'
          ) {
            priorTurnHadContent = true
            break
          }
        }
        // Avoid double-insertion on rare re-entrant cases: skip if the last
        // message is already an empty-turn notice for this target.
        const last = sess.messages[sess.messages.length - 1]
        const alreadyWarned = last && last._emptyTurn
        if (!alreadyWarned) {
          // Prefer `frame.meta.stopReason` (extracted from CCB's result row
          // by ccbMessageParser._handleResult) over the old prior-turn
          // heuristic. When present, use Anthropic's own termination code
          // to pick a precise notice. When absent (older CCB, telemetry
          // drop, etc.), fall back to the priorTurnHadContent wording.
          // See docs/ccb-telemetry-refactor-plan.md §5.6.
          const stopReason = frame.meta?.stopReason
          console.warn('[ws] empty-turn: isFinal with zero blocks', {
            sessionId: sess.id,
            targetMsgId: _targetMsg.id,
            priorTurnHadContent,
            stopReason: stopReason ?? null,
          })
          let noticeText
          switch (stopReason) {
            case 'end_turn':
              noticeText = '模型本轮主动结束(通常表示它判断不需要再回复或上下文已表达完整)。可继续追问。'
              break
            case 'pause_turn':
              noticeText = '模型暂停了本轮(通常因长任务超时),可直接重新发送让它继续。'
              break
            case 'max_tokens':
              noticeText = '本轮输出达到 token 上限,内容可能不完整。可让它"继续"。'
              break
            case 'refusal':
              noticeText = '模型拒绝回复本轮内容。'
              break
            case 'tool_use':
              // stop_reason=tool_use but 0 blocks → tool_use stream was cut
              noticeText = '工具调用流意外中断,请重试。'
              break
            case 'stop_sequence':
              noticeText = '模型命中停止序列结束本轮。'
              break
            default:
              if (stopReason) {
                noticeText = `模型本轮无内容输出 (stop_reason=${stopReason})。可重试或继续追问。`
              } else if (priorTurnHadContent) {
                noticeText = '模型本轮未输出新内容,可继续追问或重新提问。'
              } else {
                noticeText = '未收到回复 — 服务端标记已完成,但没有生成任何内容。请重试。'
              }
          }
          addMessage(sess, 'assistant', noticeText, {
            _emptyTurn: true,
            _emptyTurnSoft: priorTurnHadContent || !!stopReason,
            _emptyTurnStopReason: stopReason ?? null,
          })
        }
      }
      _targetMsg.status = 'replied'
      updateMsgStatus(_targetMsg)
      resetReplyTracker(sess)
    }
  }
  // Detect non-heartbeat cron/task push — mark as system notification
  const isCronPush = frame.cronJob && !frame.cronJob.heartbeat

  // Skip drain advancement for cron/heartbeat pushes (not real turn completions)
  const _isCronOrHeartbeat = !!frame.cronJob

  for (const block of frame.blocks || []) {
    // Defensive: coerce block.text to string to prevent [object Object] rendering
    const blockText =
      typeof block.text === 'string'
        ? block.text
        : block.text != null
          ? JSON.stringify(block.text)
          : ''

    // ── Subagent block routing ──
    // Blocks carrying parentToolUseId were produced inside a subagent
    // spawned by the main agent's Agent tool. Instead of polluting the
    // main message stream, we push them into the owning Agent card's
    // childBlocks list so the UI can show the subagent's progress inside
    // the card (and auto-collapse when the agent finishes).
    //
    // Fallback: if the Agent group isn't registered yet (e.g. out-of-order
    // arrival, or the user cleared history), the block falls through to the
    // main stream below — better to see it than to silently drop it.
    if (block.parentToolUseId && sess._agentGroups?.has(block.parentToolUseId)) {
      const groupMsgId = sess._agentGroups.get(block.parentToolUseId)
      const groupMsg = sess.messages.find((m) => m.id === groupMsgId)
      if (groupMsg) {
        _appendSubagentBlock(sess, groupMsg, block, blockText)
        if (sess.id === state.currentSessionId) _deps.updateMessageEl(groupMsg)
        continue
      }
    }

    if (block.kind === 'text') {
      sess._streamingThinking = null
      if (!sess._streamingAssistant) {
        sess._streamingAssistant = addMessage(
          sess,
          'assistant',
          '',
          isCronPush ? { cronPush: true, cronLabel: frame.cronJob?.label } : {},
        )
      }
      sess._streamingAssistant.text += blockText
      // Track "latest content arrived" as completion time. Kept in sync on
      // every delta so abnormal teardowns (stopCurrentTurn, thinking safety
      // timeout, offline drain timeout, reconnect safety, agent switch)
      // leave behind a meaningful completion wall-clock without each
      // teardown site needing its own assignment. The explicit writes in
      // tool_use/tool_result/isFinal below are still kept — they pin the
      // value at exactly the segment boundary (slightly more accurate when
      // a delta and the segment-end arrive in the same frame batch).
      sess._streamingAssistant.completedAt = Date.now()
      _checkTaskNotifications(block.text)
      // Throttled render: use coarser interval (~120ms) for streaming markdown
      // to avoid re-parsing on every delta. Short texts use rAF for responsiveness.
      const _textLen = (sess._streamingAssistant.text || '').length
      const _throttleMs = _textLen < 500 ? 0 : _textLen < 3000 ? 80 : 120
      if (!sess._streamRafPending) {
        sess._streamRafPending = true
        const _doRender = () => {
          sess._streamRafPending = false
          if (sess._streamingAssistant) {
            updateMessage(sess, sess._streamingAssistant, sess._streamingAssistant.text, true)
            _deps.scrollBottom()
          }
        }
        if (_throttleMs === 0) {
          requestAnimationFrame(_doRender)
        } else {
          setTimeout(_doRender, _throttleMs)
        }
      }
    } else if (block.kind === 'thinking') {
      if (!sess._streamingThinking) sess._streamingThinking = addMessage(sess, 'thinking', '')
      sess._streamingThinking.text += blockText
      sess._streamingThinking.completedAt = Date.now()  // see assistant branch rationale
      if (!sess._thinkRafPending) {
        sess._thinkRafPending = true
        requestAnimationFrame(() => {
          sess._thinkRafPending = false
          if (sess._streamingThinking) {
            updateMessage(sess, sess._streamingThinking, sess._streamingThinking.text, true)
            _deps.scrollBottom()
          }
        })
      }
    } else if (block.kind === 'tool_use') {
      // The assistant text (and thinking) segment just ended — next turn
      // content will go into a new message. Stamp completion time BEFORE
      // the final flush so updateMessageEl re-renders the msg-time label
      // from "first token arrived" to "segment finished".
      if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now()
      if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now()
      // Flush pending text render before clearing (rAF might not have fired yet)
      if (sess._streamingAssistant?.text) {
        updateMessage(sess, sess._streamingAssistant, sess._streamingAssistant.text, false)
      }
      if (sess._streamingThinking?.text) {
        updateMessage(sess, sess._streamingThinking, sess._streamingThinking.text, false)
      }
      sess._streamingAssistant = null
      sess._streamingThinking = null
      const isAgent = /^Agent$/i.test(block.toolName || '')

      if (isAgent) {
        // Sub-agent: create a collapsible group card + register as bg task
        if (!sess._agentGroups) sess._agentGroups = new Map()
        if (block.blockId && !sess._agentGroups.has(block.blockId)) {
          const desc = (block.inputPreview || '').replace(/[{}"]/g, '').slice(0, 80) || '子任务'
          const groupMsg = addMessage(sess, 'agent-group', desc, {
            blockId: block.blockId,
            toolName: 'Agent',
            startTime: Date.now(),
            childBlocks: [],
          })
          sess._agentGroups.set(block.blockId, groupMsg.id)
          if (block.blockId) sess._blockIdToMsgId.set(block.blockId, groupMsg.id)
          addBgTask(block.blockId, desc)
        }
      } else if (block.blockId && sess._blockIdToMsgId.has(block.blockId)) {
        // Update existing tool card (streaming partial → final)
        const mid = sess._blockIdToMsgId.get(block.blockId)
        const existing = sess.messages.find((m) => m.id === mid)
        if (existing) {
          existing.inputPreview = block.inputPreview || existing.inputPreview
          if (block.inputJson) existing.inputJson = block.inputJson
          existing._partial = !!block.partial
          if (sess.id === state.currentSessionId) {
            if (block.partial) {
              // Partial streaming: lightweight summary-only update (avoid full DOM rebuild)
              const el = document.querySelector(`[data-msg-id="${existing.id}"]`)
              const sumEl = el?.querySelector('.tool-card-summary')
              if (sumEl) sumEl.textContent = buildToolUseLabel(block).slice(block.toolName?.length || 0)
            } else {
              // Final: full re-render with complete inputJson
              _deps.updateMessageEl(existing)
            }
          }
        }
      } else {
        // Create new tool card with structured data
        const m = addMessage(sess, 'tool', block.toolName || 'unknown', {
          toolName: block.toolName,
          blockId: block.blockId,
          inputPreview: block.inputPreview || '',
          inputJson: block.inputJson || null,
          _partial: !!block.partial,
          _completed: false,
          output: null,
          error: false,
        })
        if (block.blockId) sess._blockIdToMsgId.set(block.blockId, m.id)
      }
    } else if (block.kind === 'tool_result') {
      // Same completion-stamp rationale as the tool_use branch above.
      if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now()
      if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now()
      // Flush pending text render before clearing
      if (sess._streamingAssistant?.text) {
        updateMessage(sess, sess._streamingAssistant, sess._streamingAssistant.text, false)
      }
      sess._streamingAssistant = null
      sess._streamingThinking = null

      // Check if this result belongs to a sub-agent group
      const isAgentResult = /^Agent$/i.test(block.toolName || '')
      if (isAgentResult && block.blockId && sess._agentGroups?.has(block.blockId)) {
        const groupMsgId = sess._agentGroups.get(block.blockId)
        const groupMsg = sess.messages.find((m) => m.id === groupMsgId)
        if (groupMsg) {
          groupMsg._completed = true
          groupMsg._duration = Date.now() - (groupMsg.startTime || Date.now())
          groupMsg._resultPreview = (block.preview || '').slice(0, 200)
          groupMsg._isError = !!block.isError
          if (sess.id === state.currentSessionId) _deps.updateMessageEl(groupMsg)
          completeBgTask(block.blockId, block.isError ? 'failed' : 'done', {
            preview: (block.preview || '').slice(0, 100),
          })
        }
        continue
      }

      // Try to merge result into existing tool_use card
      const toolUseId = block.toolUseBlockId || (block.blockId ? block.blockId.replace(/:result$/, '') : null)
      if (toolUseId && sess._blockIdToMsgId.has(toolUseId)) {
        const mid = sess._blockIdToMsgId.get(toolUseId)
        const existing = sess.messages.find((m) => m.id === mid)
        if (existing) {
          existing._completed = true
          existing.output = block.preview || ''
          existing.error = !!block.isError
          existing._partial = false
          if (sess.id === state.currentSessionId) _deps.updateMessageEl(existing)
          continue
        }
      }

      // Fallback: create standalone result card
      if (!block.preview) continue
      const m = addMessage(sess, 'tool', block.toolName || 'unknown', {
        toolName: block.toolName,
        blockId: block.blockId,
        _completed: true,
        output: block.preview || '',
        error: !!block.isError,
        inputJson: null,
        inputPreview: '',
        _partial: false,
      })
      if (block.blockId) sess._blockIdToMsgId.set(block.blockId, m.id)
    }
  }
  sess.lastAt = Date.now()
  if (frame.isFinal) {
    const metaText = formatMeta(frame.meta)
    if (metaText && sess._streamingAssistant) {
      // 把原始 meta 存到消息上,这样后续 outbound.cost_charged 帧到达时可以把
      // 容器口径的 $0.xxxx 改写成真实扣费积分再 re-format。没有这一手,cost_charged
      // 只能拿到它自己的 costCredits 但丢掉 in/out/cache 字段。
      sess._streamingAssistant._rawMeta = { ...frame.meta }
      setMeta(sess, sess._streamingAssistant, metaText)
    }
    // Accumulate token usage for session-level tracking
    if (frame.meta) {
      if (!sess._tokenUsage) sess._tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      if (typeof frame.meta.inputTokens === 'number') sess._tokenUsage.input += frame.meta.inputTokens
      if (typeof frame.meta.outputTokens === 'number') sess._tokenUsage.output += frame.meta.outputTokens
      if (typeof frame.meta.cacheReadTokens === 'number') sess._tokenUsage.cacheRead += frame.meta.cacheReadTokens
      if (typeof frame.meta.cacheCreationTokens === 'number') sess._tokenUsage.cacheWrite += frame.meta.cacheCreationTokens
      if (typeof frame.meta.cost === 'number') sess._tokenUsage.cost += frame.meta.cost
    }
    // Stamp completion time on the final streaming segment BEFORE the final
    // rich render, so the msg-time label in the DOM can swap from "first
    // token" to the actual turn-ended wall-clock.
    if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now()
    if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now()
    // Mark assistant message as truncated when CCB report stop_reason indicates
    // the model didn't get to finish (max_tokens, pause_turn). messages.js
    // shows a "继续" button on truncated messages so user can resume without
    // having to manually craft a "继续上文" prompt — alice 的 4-08 长回答被
    // max_tokens 截断后只能手抄 paragraph 提问的痛点。
    // 注:仅当本轮真的产生了文本(_streamingAssistant.text 非空)才标;空 turn
    // 走下方 producedContent 分支的 noticeText 路径,那里已有相应文案。
    const _stopReason = frame.meta?.stopReason
    const _truncatedReason =
      _stopReason === 'max_tokens' || _stopReason === 'pause_turn' ? _stopReason : null
    if (_truncatedReason && sess._streamingAssistant?.text) {
      sess._streamingAssistant._truncated = _truncatedReason
    }
    // Final rich render: re-render all streaming messages with full Markdown/Mermaid/Chart
    if (sess._streamingAssistant && sess.id === state.currentSessionId) {
      _deps.updateMessageEl(sess._streamingAssistant, false)
      _deps.processRichBlocks()
    }
    if (sess._streamingThinking && sess.id === state.currentSessionId) {
      _deps.updateMessageEl(sess._streamingThinking, false)
    }
    const lastAssistant = [...sess.messages].reverse().find((m) => m.role === 'assistant')
    const preview = lastAssistant?.text?.replace(/[`*_#>]/g, '').trim() || ''
    if (preview) maybeNotify(`OpenClaude · ${sess.title}`, preview)
    // Finalize any new-format tool cards still in "running" state (e.g. after page refresh).
    // Skip legacy messages (no boolean _completed) to avoid upgrading them.
    for (const m of sess.messages) {
      if (m.role === 'tool' && typeof m._completed === 'boolean' && !m._completed && !m.error) {
        m._completed = true
        if (sess.id === state.currentSessionId) _deps.updateMessageEl(m)
      }
    }
    sess._streamingAssistant = null
    sess._streamingThinking = null
    sess._sendingInFlight = false
    // Turn has ended — clear timing so the next turn starts fresh (regardless of whether
    // this session is currently viewed; otherwise a later switch would reuse stale timing).
    clearTurnTiming(sess)
    // Clear pending permission modals for THIS session only (turn completed)
    clearPendingPermissions(sess.id)
    // Clear regen safety timer if present
    if (sess._regenSafetyTimer) { clearTimeout(sess._regenSafetyTimer); sess._regenSafetyTimer = null }
    // Remove this session from the reconnect snapshot so the safety timer won't
    // clear a new turn started after this isFinal on the same session.
    if (state._reconnectInFlightSet) {
      state._reconnectInFlightSet.delete(sess.id)
      // If all snapped sessions resolved, cancel the timer entirely
      if (state._reconnectInFlightSet.size === 0 && state._reconnectInFlightTimer) {
        clearTimeout(state._reconnectInFlightTimer)
        state._reconnectInFlightTimer = null
        state._reconnectInFlightSet = null
      }
    }
    // Only update global UI state if this is the currently viewed session
    if (sess.id === state.currentSessionId) {
      state.sendingInFlight = false
      updateSendEnabled()
      hideTypingIndicator()
      setTitleBusy(false)
    }
    // If draining offline queue, advance when the drained session's turn completes.
    // Skip cron/heartbeat pushes — they're not real turn completions.
    // The 3s delay after reconnect + _sendingInFlight guard in _drainNextOfflineItem
    // ensures resumed turns complete before drain starts, so this isFinal is ours.
    const _drainCurrent = state._offlineDrainingCurrent
    if (_drainCurrent && _drainCurrent.sessId === sess.id && !_isCronOrHeartbeat) {
      if (state._drainTimeout) { clearTimeout(state._drainTimeout); state._drainTimeout = null }
      state._offlineDrainingCurrent = null
      if (state._offlineQueuePending?.length > 0) {
        setTimeout(_drainNextOfflineItem, 500)
      } else {
        state._offlineQueueDraining = false
      }
    }
    // Complete any bg tasks linked to this session's last user message
    const lastUser = [...sess.messages].reverse().find((m) => m.role === 'user')
    if (lastUser?.text?.startsWith('🔄 [后台]')) {
      // Find bg task by matching the idempotencyKey pattern
      for (const [id, t] of _bgTasks) {
        if (t.status === 'running' && lastUser.text.includes(t.desc.slice(0, 30))) {
          completeBgTask(id, 'done', { preview: preview?.slice(0, 100) })
          break
        }
      }
    }
  }
  if (sess.id === state.currentSessionId) _deps.updateSessionSub(sess)
  // Save immediately on isFinal to prevent data loss on refresh; debounce during streaming
  _deps.scheduleSave(sess, !!frame.isFinal)
  // Only rebuild sidebar on final message (not every streaming delta)
  if (frame.isFinal) _deps.renderSidebar()
}

// ── Phase 0.4: gateway-initiated resume failure ──
// Gateway emits `outbound.resume_failed` when our hello.lastFrameSeq points at
// a window it can no longer replay — ring buffer pruned (buffer_miss), server
// restarted and lost memory (no_buffer), or our cursor somehow outran the
// server (sequence_mismatch — shouldn't happen for trusted clients). In all
// three cases the correct recovery is a forced REST sync: the server-authored
// persistence layer (Phase 0.1/0.2) is authoritative, so a full pull
// reconciles whatever we missed. `force: true` bypasses the 15s throttle in
// maybeSyncNow since we explicitly know our live-stream state is stale.
//
// We also:
//   1. Reset the session-level frameSeq cursor — after the sync we accept
//      any future frameSeq as forward-progress. Without this, a server restart
//      (where currentLast drops back to a low number) would make every
//      subsequent frame look "stale" to the dedupe check in handleOutbound.
//   2. Clear the stale `_sendingInFlight` marker on the affected session.
//      syncSessionsFromServer skips refetching the current session while
//      `state.sendingInFlight` is true (it avoids stomping a live stream).
//      But resume_failed *proves* the live stream is broken, so keeping the
//      marker would cause the sync to skip exactly the session we most need
//      to reconcile. Clear it and rely on the just-triggered sync to pull
//      authoritative server-persisted state.
function handleResumeFailed(frame) {
  const peerId = frame.peer?.id
  const affectedSessId = peerId
  // Server's currentLast at the moment it emitted resume_failed. frameTo=0
  // indicates a genuine server restart (currentLast wiped); frameTo>0 means
  // the server still has forward progress we need to honor on reconnect.
  const frameTo = typeof frame.to === 'number' ? frame.to : 0
  if (peerId) {
    const sess = state.sessions.get(peerId)
    if (sess) {
      // Advance the frameSeq cursor to the server's currentLast BEFORE the
      // sync runs. Why here and not in the onResult callback:
      //   - syncSessionsFromServer carries existingLocal._lastFrameSeq into
      //     the merged session object (sync.js:~278) and dbPut persists it
      //     (sync.js:~283). Setting it in onResult leaves IDB with the stale
      //     cursor — on reload, the hello hand-shake would fire lastFrameSeq=0
      //     (or the stale pre-advance value) and the gateway's P1-3 guard
      //     would resume_failed us again, looping.
      //   - frameTo=0 (server restart) maps to 0 here, which is correct:
      //     we genuinely haven't seen anything from this server instance and
      //     the dedupe in handleOutbound should accept all future frames.
      //   - frameTo>0 sets the dedupe threshold to the server's last assigned
      //     frame, so any late frames ≤ frameTo that triggered this
      //     resume_failed are dropped (we'll get authoritative state from
      //     REST) and future frames (seq > frameTo) are accepted normally.
      sess._lastFrameSeq = frameTo
      // Phase 0.4 P1-1: instead of force-clearing _sendingInFlight (which
      // would lie about a still-running long REPL turn in buffer_miss
      // cases), flag the live stream as known-broken. syncSessionsFromServer
      // reads this flag and refetches the session from the server-authored
      // tape even when state.sendingInFlight is true. The flag clears
      // naturally on the next successful sync.
      sess._liveStreamBroken = true
      // Persist the cursor advance synchronously to IDB before maybeSyncNow
      // runs. `syncSessionsFromServer` only fetches+dbPuts sessions where
      // `meta.updatedAt > local._syncedAt` — on a pure server restart
      // (frame.to=0, no new messages yet) or a sequence_mismatch against an
      // idle backend, the sync can complete without touching this session,
      // so the in-memory `_lastFrameSeq = frameTo` advance would never
      // reach disk. A reload would then resurrect the stale cursor and we'd
      // resume_failed → REST-sync loop on the next reconnect. Fire-and-
      // forget is OK: if IDB is unavailable or throws we've already done
      // the memory-state update, and the sync path will re-persist whatever
      // state it ends up merging.
      dbPut({ ...sess }).catch(() => {})
    }
  }
  // `freshAfterInFlight: true` guards against a race where a sync was already
  // running when we set `_liveStreamBroken` — that sync may have decided to
  // skip the affected session BEFORE we flagged it. Without the tail sync,
  // the flag would stay set until the next throttled foreground event, and
  // the user would see stale content. The tail sync re-observes the flag on
  // its second pass and pulls the authoritative REST state.
  maybeSyncNow({
    force: true,
    freshAfterInFlight: true,
    onResult: (result) => {
      if (!result) return
      // Successful sync — live stream has been reconciled from REST. Clear
      // the override so subsequent maybeSyncNow calls respect the normal
      // in-flight skip again. _lastFrameSeq was already advanced synchronously
      // above and persisted by the sync's dbPut, so nothing to do here for it.
      if (affectedSessId) {
        const live = state.sessions.get(affectedSessId)
        if (live) {
          live._liveStreamBroken = false
        }
      }
      try { _deps.renderSidebar() } catch {}
      // Re-render the transcript only if the affected session is what's
      // currently on screen — a background-session resume_failed shouldn't
      // steal focus from whatever the user is looking at.
      if (
        result.needsRenderMessages ||
        (affectedSessId && affectedSessId === state.currentSessionId)
      ) {
        try { _deps.renderMessages() } catch {}
      }
    },
  })
}

// ═══════════════ COST CHARGED (commercial v3 only) ═══════════════
// 商用版专用帧:anthropicProxy 在 finalize.commit 成功扣费后广播给前端。
// 规则:
//   1) 后端 frame.sessionId 非空 → 只在该 session 里找目标。若前端没这个 session
//      (已被 gc / 用户刚删),candidates 为空,走下面的 refreshBalance 兜底,
//      **绝不回退扫其他 session**,避免把后台扣费错贴到前台消息。
//   2) sessionId 为空(容器侧漏传 metadata.session_id)→ 回退到"当前会话优先
//      + 其他按 lastAt 降序"的全局扫描。
//   3) 目标 = 从消息尾部往前,**第一条已设 _rawMeta 且 costCredits 仍未填** 的
//      assistant 消息。前端不记 per-message requestId,只能用这个 marker 兜底,
//      误差上限 = 1 turn。
function handleCostCharged(frame) {
  const sid = typeof frame.sessionId === 'string' && frame.sessionId.length > 0
    ? frame.sessionId
    : null

  // 选候选会话:sessionId 命中时只它一个;否则走全局扫描。
  const candidates = []
  if (sid) {
    const s = state.sessions.get(sid)
    if (s) candidates.push(s)
    // sessionId 给了但前端没这个 session(极罕见:后端推得比 session.created 还早,
    // 或者 session 已被前端 gc) → candidates 为空,往下直接落到 refreshBalance 兜底。
  } else {
    if (state.currentSessionId) {
      const cur = state.sessions.get(state.currentSessionId)
      if (cur) candidates.push(cur)
    }
    const others = []
    for (const s of state.sessions.values()) {
      if (state.currentSessionId && s.id === state.currentSessionId) continue
      others.push(s)
    }
    others.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
    candidates.push(...others)
  }

  let target = null
  let targetSess = null
  for (const sess of candidates) {
    const msgs = sess.messages || []
    // 从尾往前找最近一条已设 _rawMeta 且还没打上 costCredits 的 assistant
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'assistant') continue
      if (!m._rawMeta) continue
      if (m._rawMeta.costCredits !== undefined) continue
      target = m
      targetSess = sess
      break
    }
    if (target) break
  }

  if (!target) {
    // 没候选:可能是 cost_charged 先于 turn-end 到达(极罕见,LLM 链路响应比扣费
    // 路径快得多),也可能是纯 tool-only turn 没出文本消息。静默丢弃,用户仍能
    // 通过 refreshBalance 看到余额变化。
    if (typeof frame.balanceAfter === 'string' || typeof frame.balanceAfter === 'number') {
      try { refreshBalance() } catch {}
    }
    return
  }

  target._rawMeta.costCredits = frame.costCredits
  const metaText = formatMeta(target._rawMeta)
  setMeta(targetSess, target, metaText)

  // 同步刷新左上角余额气泡 —— 服务端已写 DB,刷 /api/me 拿到的就是 balanceAfter。
  // 传了 balanceAfter 的就直接乐观更新,避开一次 round-trip。
  try { refreshBalance() } catch {}
}

// ═══════════════ PERMISSION PROMPTS ═══════════════
const _pendingPermissions = new Map() // requestId -> { frame, el, timer }

function handlePermissionRequest(frame) {
  const sess = frame.peer?.id ? state.sessions.get(frame.peer.id) : null
  if (!sess) return

  // Add a permission card to the chat
  const msg = addMessage(sess, 'permission', frame.toolName, {
    requestId: frame.requestId,
    toolName: frame.toolName,
    inputPreview: frame.inputPreview || '',
    inputJson: frame.inputJson || null,
    _resolved: false,
  })

  // AskUserQuestion needs a dedicated answer-collection UI; the generic
  // Allow/Deny dialog can't convey the question list and options. We pass
  // selected answers back through the same `inbound.permission_response`
  // channel via `updatedInput` — gateway applies sanitizeAskUserQuestionUpdatedInput
  // before forwarding to CCB.
  if (
    frame.toolName === 'AskUserQuestion' &&
    Array.isArray(frame.inputJson?.questions) &&
    frame.inputJson.questions.length > 0
  ) {
    _showAskUserQuestionModal(frame, sess, msg)
  } else {
    // Build and show modal overlay
    _showPermissionModal(frame, sess, msg)
  }

  // Play notification sound
  _notifSound()
}

function _showPermissionModal(frame, sess, msg) {
  // If another permission modal is already showing, deny the OLD one first
  // (only one modal can be visible at a time in the UI)
  _displaceExistingPermissionModal()

  const toolName = htmlSafeEscape(frame.toolName || 'unknown')
  const preview = htmlSafeEscape((frame.inputPreview || '').slice(0, 300))

  // Build a human-readable description of what the tool wants to do
  let desc = ''
  if (frame.inputJson) {
    const input = frame.inputJson
    if (input.file_path) desc = `File: ${htmlSafeEscape(String(input.file_path))}`
    else if (input.command) desc = `Command: ${htmlSafeEscape(String(input.command).slice(0, 200))}`
    else if (input.pattern) desc = `Pattern: ${htmlSafeEscape(String(input.pattern))}`
  }

  const overlay = document.createElement('div')
  overlay.id = 'permission-modal'
  overlay.dataset.requestId = frame.requestId
  overlay.className = 'permission-modal-overlay'
  overlay.innerHTML = `
    <div class="permission-modal">
      <div class="permission-modal-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
      </div>
      <div class="permission-modal-title">Tool Permission Request</div>
      <div class="permission-modal-tool">${toolName}</div>
      ${desc ? `<div class="permission-modal-desc">${desc}</div>` : ''}
      ${preview ? `<details class="permission-modal-details"><summary>Details</summary><pre>${preview}</pre></details>` : ''}
      <div class="permission-modal-actions">
        <button class="permission-btn permission-btn-deny" data-action="deny">Deny</button>
        <button class="permission-btn permission-btn-allow" data-action="allow">Allow</button>
      </div>
      <div class="permission-modal-timer"></div>
    </div>
  `
  document.body.appendChild(overlay)

  // Auto-deny after 120s if no response
  const timerEl = overlay.querySelector('.permission-modal-timer')
  let remaining = 120
  timerEl.textContent = `${remaining}s`
  const countdown = setInterval(() => {
    remaining--
    timerEl.textContent = `${remaining}s`
    if (remaining <= 0) {
      clearInterval(countdown)
      _resolvePermission(frame, 'deny', 'Timed out', sess, msg, overlay)
    }
  }, 1000)

  // Button handlers
  overlay.querySelector('[data-action="allow"]').addEventListener('click', () => {
    clearInterval(countdown)
    _resolvePermission(frame, 'allow', null, sess, msg, overlay)
  })
  overlay.querySelector('[data-action="deny"]').addEventListener('click', () => {
    clearInterval(countdown)
    _resolvePermission(frame, 'deny', 'User denied', sess, msg, overlay)
  })

  // Store reference for cleanup
  _pendingPermissions.set(frame.requestId, { frame, el: overlay, timer: countdown })
}

function _resolvePermission(frame, behavior, message, sess, msg, overlay, extras) {
  // Send response via WebSocket. `extras` is only passed by AskUserQuestion
  // (carries `updatedInput` + cached `answers` for local card replay) and is
  // otherwise ignored for the generic Allow/Deny flow.
  if (state.ws && state.ws.readyState === 1) {
    const payload = {
      type: 'inbound.permission_response',
      channel: frame.channel || 'webchat',
      peer: frame.peer,
      agentId: sess.agentId || state.defaultAgentId,
      requestId: frame.requestId,
      behavior,
      message: message || undefined,
    }
    if (extras && extras.updatedInput && behavior === 'allow') {
      payload.updatedInput = extras.updatedInput
    }
    // safeWsSend:buffer 堵死时 close+reconnect —— server 端会 resume_failed 并
    // 重发 permission_request,用户再看到一次 prompt,比"发了没到"静默挂死好。
    safeWsSend(state.ws, JSON.stringify(payload))
  }

  // Update message in chat
  if (msg) {
    msg._resolved = true
    msg._behavior = behavior
    if (extras && extras.answers && behavior === 'allow') {
      msg._answers = extras.answers
    }
    if (sess.id === state.currentSessionId) _deps.updateMessageEl(msg)
  }

  // Remove modal
  if (overlay) overlay.remove()
  _pendingPermissions.delete(frame.requestId)
}

// ═══════════════ AskUserQuestion MODAL ═══════════════
// Rendered instead of the generic Allow/Deny modal when CCB asks the user
// a multiple-choice question. Mirrors the native CCB UX (`QuestionView` /
// `SubmitQuestionsView`) with three question shapes:
//
//   1. preview question  — non-multiSelect + any option has `preview`:
//      option click shows `option.preview` in a side pane. No "Other" option.
//   2. multi-select     — `multiSelect === true`: checkbox-style toggles,
//      answer = selected labels joined by ", ". No "Other" option.
//   3. plain single     — otherwise: radio-style, with a trailing "Other"
//      choice that expands a free-text input.
//
// Submit builds `{ answers, annotations }` and sends it as `updatedInput`
// merged onto the original input. Gateway's sanitizeAskUserQuestionUpdatedInput
// drops any keys not in the original question set and rejects preview values
// that don't match an option's preview. Answers are comma-joined for
// multi-select, matching CCB's `label.join(", ")` contract.
function _showAskUserQuestionModal(frame, sess, msg) {
  // Displace any existing modal (permission or AskUserQuestion) so only one
  // is visible at a time — reuses the same displacement logic the generic
  // modal does, with a deny for the pre-existing prompt.
  _displaceExistingPermissionModal()

  // Filter out malformed questions (missing question text) so state_q keys
  // stay well-defined. The route dispatch already asserts the array is
  // non-empty, but CCB per-question shape isn't enforced upstream.
  const questions = frame.inputJson.questions.filter(
    (q) => q && typeof q.question === 'string' && q.question.length > 0,
  )
  if (questions.length === 0) {
    // No usable questions — fall back to the generic permission modal so
    // the user still has an allow/deny choice rather than a silent stall.
    _showPermissionModal(frame, sess, msg)
    return
  }
  // Per-question UI state, keyed by question text (CCB's canonical key).
  // { selectedLabels: Set<string>, otherText: string }
  const state_q = new Map()
  for (const q of questions) {
    state_q.set(q.question, { selectedLabels: new Set(), otherText: '' })
  }
  // Which question is focused (drives the preview pane for preview questions).
  let activeIdx = 0

  const overlay = document.createElement('div')
  overlay.id = 'permission-modal'
  overlay.dataset.requestId = frame.requestId
  overlay.className = 'permission-modal-overlay'

  const modal = document.createElement('div')
  modal.className = 'permission-modal aq-modal'
  overlay.appendChild(modal)

  const header = document.createElement('div')
  header.className = 'aq-header'
  header.innerHTML =
    `<div class="aq-header-icon">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zM10 8a2 2 0 114 0c0 1-1 1.5-1.5 2s-.5 1-.5 1.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>` +
    `</div>` +
    `<div class="aq-header-title">用户问答</div>` +
    `<div class="aq-header-sub">${questions.length > 1 ? `共 ${questions.length} 题` : '请回答以下问题'}</div>`
  modal.appendChild(header)

  const body = document.createElement('div')
  body.className = 'aq-body'
  modal.appendChild(body)

  // Build one section per question. Defensive: treat a missing / non-array
  // `options` as an empty list rather than letting `.some/.filter/.find`
  // throw. CCB's schema guarantees an array, but a corrupted tool payload
  // (or a gateway that ever relaxes its forwarder) shouldn't brick the UI.
  questions.forEach((q, idx) => {
    const optionsArray = Array.isArray(q.options) ? q.options : []
    const hasPreview = !q.multiSelect && optionsArray.some((o) => o && typeof o.preview === 'string' && o.preview.length > 0)
    const section = document.createElement('section')
    section.className = 'aq-question'
    if (hasPreview) section.classList.add('aq-has-preview')
    if (q.multiSelect) section.classList.add('aq-multi')
    section.dataset.qIdx = String(idx)
    section.addEventListener('focusin', () => {
      activeIdx = idx
    })

    const chip = document.createElement('div')
    chip.className = 'aq-chip'
    chip.textContent = q.header || ''
    section.appendChild(chip)

    const title = document.createElement('div')
    title.className = 'aq-qtext'
    title.textContent = q.question
    section.appendChild(title)

    const grid = document.createElement('div')
    grid.className = 'aq-options'
    section.appendChild(grid)

    // Optional preview pane (only for preview questions)
    let previewPane = null
    if (hasPreview) {
      previewPane = document.createElement('pre')
      previewPane.className = 'aq-preview-pane'
      previewPane.textContent = ''
      section.appendChild(previewPane)
    }

    const qState = state_q.get(q.question)
    // Filter out any option whose label collides with our internal "Other"
    // sentinel. CCB's tool prompt forbids the model from generating "Other"
    // itself, but we still defend against a model that violates the prompt
    // so the sentinel stays unambiguous on submit. Uses `optionsArray` so
    // a non-array `options` yields [] instead of throwing.
    const safeOptions = optionsArray.filter((o) => o && o.label !== '__other__')
    const renderOptionButtons = () => {
      grid.innerHTML = ''
      safeOptions.forEach((opt) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'aq-option'
        const isSelected = qState.selectedLabels.has(opt.label)
        if (isSelected) btn.classList.add('selected')
        if (q.multiSelect) btn.classList.add('multi')
        btn.innerHTML =
          `<span class="aq-option-marker"></span>` +
          `<span class="aq-option-body">` +
          `<span class="aq-option-label">${htmlSafeEscape(opt.label || '')}</span>` +
          (opt.description ? `<span class="aq-option-desc">${htmlSafeEscape(opt.description)}</span>` : '') +
          `</span>`
        btn.addEventListener('click', () => {
          activeIdx = idx
          if (q.multiSelect) {
            if (qState.selectedLabels.has(opt.label)) qState.selectedLabels.delete(opt.label)
            else qState.selectedLabels.add(opt.label)
          } else {
            qState.selectedLabels.clear()
            qState.selectedLabels.add(opt.label)
            qState.otherText = ''
            if (otherInput) otherInput.value = ''
          }
          if (previewPane) {
            previewPane.textContent = typeof opt.preview === 'string' ? opt.preview : ''
          }
          renderOptionButtons()
          updateOtherVisibility()
        })
        grid.appendChild(btn)
      })
    }
    renderOptionButtons()

    // Trailing "Other" for plain single-choice (non-preview, non-multiSelect).
    // Matches CCB native behavior: preview questions and multi-select don't get Other.
    let otherBtn = null
    let otherInput = null
    const updateOtherVisibility = () => {
      if (!otherBtn) return
      const isOtherSelected = qState.selectedLabels.has('__other__')
      otherBtn.classList.toggle('selected', isOtherSelected)
      if (otherInput) otherInput.classList.toggle('aq-hidden', !isOtherSelected)
    }
    if (!hasPreview && !q.multiSelect) {
      otherBtn = document.createElement('button')
      otherBtn.type = 'button'
      otherBtn.className = 'aq-option aq-option-other'
      otherBtn.innerHTML =
        `<span class="aq-option-marker"></span>` +
        `<span class="aq-option-body">` +
        `<span class="aq-option-label">其他</span>` +
        `<span class="aq-option-desc">自行输入答案</span>` +
        `</span>`
      otherBtn.addEventListener('click', () => {
        activeIdx = idx
        qState.selectedLabels.clear()
        qState.selectedLabels.add('__other__')
        renderOptionButtons()
        updateOtherVisibility()
        if (otherInput) otherInput.focus()
      })
      grid.appendChild(otherBtn)

      otherInput = document.createElement('input')
      otherInput.type = 'text'
      otherInput.className = 'aq-other-input aq-hidden'
      otherInput.placeholder = '输入你的答案…'
      otherInput.maxLength = 2000
      otherInput.addEventListener('input', () => {
        qState.otherText = otherInput.value
      })
      section.appendChild(otherInput)
    }

    body.appendChild(section)
  })

  const footer = document.createElement('div')
  footer.className = 'aq-footer'
  footer.innerHTML =
    `<div class="aq-footer-timer" aria-hidden="true"></div>` +
    `<div class="aq-footer-actions">` +
    `<button type="button" class="permission-btn permission-btn-deny aq-btn-skip">跳过</button>` +
    `<button type="button" class="permission-btn permission-btn-allow aq-btn-submit">提交</button>` +
    `</div>`
  modal.appendChild(footer)

  document.body.appendChild(overlay)

  // Auto-deny after 180s if no response (slightly longer than the generic
  // modal's 120s because a multi-question interview takes longer to read).
  const timerEl = footer.querySelector('.aq-footer-timer')
  let remaining = 180
  timerEl.textContent = `${remaining}s`
  const countdown = setInterval(() => {
    remaining--
    timerEl.textContent = `${remaining}s`
    if (remaining <= 0) {
      clearInterval(countdown)
      _resolvePermission(frame, 'deny', 'Timed out', sess, msg, overlay)
    }
  }, 1000)

  footer.querySelector('.aq-btn-skip').addEventListener('click', () => {
    clearInterval(countdown)
    _resolvePermission(frame, 'deny', 'User skipped', sess, msg, overlay)
  })

  footer.querySelector('.aq-btn-submit').addEventListener('click', () => {
    const result = _aqCollectAnswers(questions, state_q)
    if (!result.ok) {
      // Flash the first unanswered question section
      const missingSection = body.querySelector(`[data-q-idx="${result.missingIdx}"]`)
      if (missingSection) {
        missingSection.classList.add('aq-flash')
        setTimeout(() => missingSection.classList.remove('aq-flash'), 600)
        missingSection.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      return
    }
    clearInterval(countdown)
    const updatedInput = {
      ...frame.inputJson,
      answers: result.answers,
      ...(Object.keys(result.annotations).length > 0 ? { annotations: result.annotations } : {}),
    }
    _resolvePermission(frame, 'allow', null, sess, msg, overlay, {
      updatedInput,
      answers: result.answers,
    })
  })

  _pendingPermissions.set(frame.requestId, { frame, el: overlay, timer: countdown })
}

/**
 * Collect `{ answers, annotations }` from modal UI state for all questions.
 * Returns { ok: false, missingIdx } when any question has no selection,
 * otherwise { ok: true, answers, annotations }.
 *
 * Shape invariants (must match CCB's native submit in
 * AskUserQuestionPermissionRequest.tsx:381):
 *   - answers[question] is always a string.
 *   - multi-select join separator is ", " (comma + space).
 *   - "Other" label "__other__" is replaced by the user's free text.
 *   - annotations[question].preview is copied verbatim from the selected
 *     option's original `preview` field (gateway rejects any value not
 *     matching an option).
 */
function _aqCollectAnswers(questions, state_q) {
  const answers = {}
  const annotations = {}
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx]
    const qs = state_q.get(q.question)
    const selected = Array.from(qs.selectedLabels)
    if (selected.length === 0) return { ok: false, missingIdx: idx }

    if (q.multiSelect) {
      // Multi-select: join by ", ". No "Other" label — CCB native doesn't
      // offer it here, and we disable it in the UI.
      answers[q.question] = selected.join(', ')
    } else {
      const only = selected[0]
      if (only === '__other__') {
        const text = (qs.otherText || '').trim()
        if (!text) return { ok: false, missingIdx: idx }
        answers[q.question] = text
      } else {
        answers[q.question] = only
        // Copy the option's preview verbatim; gateway verifies it. Ignore
        // any option whose label collides with our "Other" sentinel — the
        // modal filters those out at render time, but belt-and-braces keep
        // this collector honest if the model defies the prompt contract.
        // Defensive: treat non-array options as empty to match the UI render path.
        const opts = Array.isArray(q.options) ? q.options : []
        const opt = opts.find((o) => o && o.label !== '__other__' && o.label === only)
        if (opt && typeof opt.preview === 'string' && opt.preview.length > 0) {
          annotations[q.question] = { preview: opt.preview }
        }
      }
    }
  }
  return { ok: true, answers, annotations }
}

/**
 * Displace any currently-visible permission modal (generic or AskUserQuestion)
 * by auto-denying the old request and removing its overlay. Extracted so both
 * modal openers share identical displacement semantics.
 */
function _displaceExistingPermissionModal() {
  const existing = document.getElementById('permission-modal')
  if (!existing) return
  const oldRequestId = existing.dataset.requestId
  if (oldRequestId && _pendingPermissions.has(oldRequestId)) {
    const old = _pendingPermissions.get(oldRequestId)
    if (old.timer) clearInterval(old.timer)
    if (state.ws && state.ws.readyState === 1 && old.frame) {
      const oldPeerId = old.frame.peer?.id
      const oldSess = oldPeerId ? state.sessions.get(oldPeerId) : null
      // safeWsSend:buffer 堵死时 close+reconnect;displace 的 deny 丢了影响很小
      // (本地 overlay 已移除,老 request 在 server 端会因 ws close 连同一起 cleanup)
      safeWsSend(state.ws, JSON.stringify({
        type: 'inbound.permission_response',
        channel: old.frame.channel || 'webchat',
        peer: old.frame.peer,
        agentId: oldSess?.agentId || state.defaultAgentId,
        requestId: oldRequestId,
        behavior: 'deny',
        message: 'Displaced by newer permission prompt',
      }))
      if (oldSess) {
        const oldMsg = oldSess.messages.find((m) => m.requestId === oldRequestId)
        if (oldMsg) {
          oldMsg._resolved = true
          oldMsg._behavior = 'deny'
          if (oldSess.id === state.currentSessionId) _deps.updateMessageEl(oldMsg)
        }
      }
    }
    _pendingPermissions.delete(oldRequestId)
  }
  existing.remove()
}

// Broadcast from gateway: a permission request was settled elsewhere (another tab,
// auto-deny on timeout/displacement, or session death). Clear local modal state so
// this tab isn't stuck showing a prompt for a request the server already consumed.
//
// reason:
//   'remote'           — another tab clicked Allow/Deny on the same account
//   'already_settled'  — our response arrived after another client's won the race
//   'disconnect'       — server auto-denied because all of this peer's WS clients dropped
//   'timeout'          — server-side janitor auto-denied after exceeding max wait
//   'crashed'          — server auto-denied because the CCB subprocess died
//
// We always clear local state regardless of reason. No inbound.permission_response
// is sent here — server-side is already resolved; replying would produce a stale
// response that the "unknown/already-settled request" branch would just rebroadcast.
// Unknown future reason values are forwarded to the UI verbatim (no enum check).
//
// Note: we apply the authoritative settled state EVEN when `_pendingPermissions`
// is already empty for this request (i.e. when we were the sender and
// `_resolvePermission` already deleted the entry). That lets the gateway override
// our optimistic `_behavior` value in two cases:
//   1. AskUserQuestion allow gets downgraded to deny by the sanitizer.
//   2. Dead-session path forces a deny.
// For AskUserQuestion allow, `frame.answers` carries the authoritative answers
// map so other tabs (who never saw the local submit) can fill in the card.
function handlePermissionSettled(frame) {
  const p = _pendingPermissions.get(frame.requestId)
  if (p) {
    if (p.timer) clearInterval(p.timer)
    if (p.el) p.el.remove()
    _pendingPermissions.delete(frame.requestId)
  }
  // Locate the message by peer (frame.peer is server-trusted). Even if local
  // pending was already cleared by _resolvePermission, the permission card
  // still lives in the session and may need its optimistic state corrected.
  const peerId = frame.peer?.id
  const sess = peerId ? state.sessions.get(peerId) : null
  if (!sess) return
  const msg = sess.messages.find((m) => m.requestId === frame.requestId)
  if (!msg) return
  msg._resolved = true
  msg._behavior = frame.behavior
  msg._settledReason = frame.reason || null
  // Prefer server-provided answers. Only overwrite locally cached answers
  // when the frame actually includes them — otherwise preserve what the
  // sender tab cached (other tabs' frames won't include answers for
  // non-AskUserQuestion tools).
  if (frame.answers && typeof frame.answers === 'object') {
    msg._answers = frame.answers
  }
  if (sess.id === state.currentSessionId) _deps.updateMessageEl(msg)
}

// Clean up permission modals. If sessId is provided, only clear that session's prompts.
// Sends deny for any unanswered prompts so the server can unblock CCB.
export function clearPendingPermissions(sessId) {
  for (const [id, p] of _pendingPermissions) {
    const peerId = p.frame?.peer?.id
    // If scoped to a session, skip prompts from other sessions
    if (sessId && peerId !== sessId) continue
    if (p.timer) clearInterval(p.timer)
    // Send deny for unanswered prompts so server doesn't wait forever
    const targetSess = peerId ? state.sessions.get(peerId) : null
    if (state.ws && state.ws.readyState === 1 && p.frame) {
      // safeWsSend 失败即 close+reconnect;deny 丢了也无妨,server 侧 channel
      // cleanup 会释放 pending permission。
      safeWsSend(state.ws, JSON.stringify({
        type: 'inbound.permission_response',
        channel: p.frame.channel || 'webchat',
        peer: p.frame.peer,
        agentId: targetSess?.agentId || state.defaultAgentId,
        requestId: p.frame.requestId,
        behavior: 'deny',
        message: 'Turn completed or session ended',
      }))
    }
    // Update permission card in chat to show "Denied"
    if (targetSess) {
      const msg = targetSess.messages.find(m => m.requestId === id)
      if (msg) {
        msg._resolved = true
        msg._behavior = 'deny'
        if (targetSess.id === state.currentSessionId) _deps.updateMessageEl(msg)
      }
    }
    if (p.el) p.el.remove()
    _pendingPermissions.delete(id)
  }
}

// ═══════════════ BACKGROUND TASKS ═══════════════
export function addBgTask(id, desc) {
  _bgTasks.set(id, { desc, status: 'running', startTime: Date.now() })
  _updateTasksBadge()
}
export function completeBgTask(id, status, meta) {
  const t = _bgTasks.get(id)
  if (!t) return
  t.status = status || 'done'
  t.duration = Date.now() - t.startTime
  if (meta?.error) t.error = meta.error
  if (meta?.preview) t.preview = meta.preview
  _updateTasksBadge()
  // Notify if tab not focused
  if (!state.windowFocused) {
    _notifSound()
    toast(`${status === 'done' ? '✓' : '✗'} 后台任务完成: ${t.desc}`)
  }
}
function _updateTasksBadge() {
  const running = [..._bgTasks.values()].filter((t) => t.status === 'running').length
  const btn = $('tasks-btn')
  const badge = $('tasks-badge')
  if (!btn) return
  btn.hidden = _bgTasks.size === 0
  badge.textContent = running > 0 ? running : ''
  badge.hidden = running === 0
  // Stop spin animation if nothing running
  const svg = btn.querySelector('svg')
  if (svg) svg.style.animation = running > 0 ? '' : 'none'
}
export function _renderTasksPanel() {
  let panel = $('tasks-panel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'tasks-panel'
    panel.className = 'tasks-panel'
    panel.hidden = true
    $('tasks-btn').parentElement.style.position = 'relative'
    $('tasks-btn').parentElement.insertBefore(panel, $('tasks-btn').nextSibling)
  }
  panel.innerHTML = '<div class="tasks-panel-header">后台任务</div>'
  if (_bgTasks.size === 0) {
    panel.innerHTML += '<div class="tasks-panel-empty">暂无后台任务</div>'
    return panel
  }
  const sorted = [..._bgTasks.entries()].sort((a, b) => b[1].startTime - a[1].startTime)
  for (const [id, t] of sorted) {
    const iconCls = t.status === 'running' ? 'running' : t.status === 'done' ? 'done' : 'failed'
    const iconChar = t.status === 'running' ? '⟳' : t.status === 'done' ? '✓' : '✗'
    const dur = t.duration ? ` · ${(t.duration / 1000).toFixed(1)}s` : ''
    const item = document.createElement('div')
    item.className = 'tasks-panel-item'
    item.innerHTML = `<span class="tasks-panel-icon ${iconCls}">${iconChar}</span><div class="tasks-panel-info"><div class="tasks-panel-desc">${htmlSafeEscape(t.desc)}</div><div class="tasks-panel-meta">${t.status}${dur}</div></div>`
    panel.appendChild(item)
  }
  return panel
}

// Detect <task-notification> in assistant text output
function _checkTaskNotifications(text) {
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g
  let match
  while ((match = re.exec(text)) !== null) {
    const body = match[1]
    const id = (body.match(/<task_id>(.*?)<\/task_id>/) || [])[1] || 'unknown'
    const status = (body.match(/<status>(.*?)<\/status>/) || [])[1] || 'completed'
    const preview = (body.match(/<output_file>(.*?)<\/output_file>/) || [])[1] || ''
    completeBgTask(id, status === 'completed' ? 'done' : 'failed', { preview })
  }
}

export function addSystemMessage(text) {
  const sess = getSession()
  if (!sess) return
  addMessage(sess, 'assistant', text, { system: true })
  _deps.scheduleSave(sess)
}
