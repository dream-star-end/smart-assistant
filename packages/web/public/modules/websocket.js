// OpenClaude — WebSocket connection, messaging, background tasks
import { $, htmlSafeEscape } from './dom.js'
import { maybeNotify, setTitleBusy } from './notifications.js'
import { getSession, state } from './state.js'
import { toast } from './ui.js'

// ── Late-binding for circular deps (sessions.js, messages.js) ──
let _deps = {}
export function setWsDeps(deps) {
  _deps = deps
}

// ── Module-private state ──
let _reconnectAttempts = 0
// Tracks `navigator.onLine`. When false, we short-circuit reconnect scheduling
// (both in connect() and ws.onclose) so a lid-closed laptop or unplugged
// ethernet doesn't double the backoff delay on every failed attempt. When it
// flips back to true the browser fires `online`, which calls
// notifyNetworkOnline() to reset attempts and reconnect immediately.
let _isBrowserOnline = typeof navigator === 'undefined' || navigator.onLine !== false
// Debounce for visibility-triggered immediate reconnects — mobile focus flips
// can fire visibilitychange rapidly and we don't want to spam connect().
let _lastVisibilityReconnectAt = 0
const VISIBILITY_RECONNECT_COOLDOWN_MS = 2000
const _bgTasks = new Map() // id -> { desc, status, startTime, duration, error }

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
      try {
        if (state.ws && state.ws.readyState === 1) {
          state.ws.send(JSON.stringify({
            type: 'inbound.control.stop',
            channel: 'webchat',
            peer: { id: sessId, kind: 'dm' },
            agentId: s.agentId || state.defaultAgentId,
          }))
        }
      } catch {}
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
  try {
    ws.send(JSON.stringify(item.payload))
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
  } catch {
    // Send failed — re-queue current + remaining
    state.offlineQueue.unshift(item, ...queue)
    state._offlineQueuePending = []
    state._offlineQueueDraining = false
    state._offlineDrainingCurrent = null
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
  state.ws.send(
    JSON.stringify({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: { id: sess.id, kind: 'dm' },
      agentId: sess.agentId || state.defaultAgentId,
    }),
  )
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
  _isBrowserOnline = false
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
  if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
  setStatus('离线', 'disconnected')
}

// Network transition: browser reports we're back online. Reset the attempts
// counter so a fresh network window gets a fresh backoff budget, then
// reconnect immediately if we're not already connected.
export function notifyNetworkOnline() {
  if (_isBrowserOnline) return // guard against duplicate events
  _isBrowserOnline = true
  if (!state.token) return
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
  if (state.ws && state.ws.readyState < 2) return
  const now = Date.now()
  if (now - _lastVisibilityReconnectAt < VISIBILITY_RECONNECT_COOLDOWN_MS) return
  _lastVisibilityReconnectAt = now
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
  if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
  connect()
}

export function connect() {
  if (!state.token) return  // No token (logged out) — don't connect
  if (state.ws && state.ws.readyState < 2) return
  // If the browser reports offline, don't attempt — the `online` handler
  // (notifyNetworkOnline) will call connect() when network comes back.
  if (!_isBrowserOnline) {
    setStatus('离线', 'disconnected')
    return
  }
  setStatus('连接中…', 'connecting')
  // Use Sec-WebSocket-Protocol for auth instead of query string (avoids token in URL/logs)
  const url = `${(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host}/ws`
  const ws = new WebSocket(url, ['bearer', state.token])
  state.ws = ws
  ws.onopen = () => {
    _reconnectAttempts = 0
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
    try {
      const peers = []
      for (const [id, s] of state.sessions) {
        peers.push({ peerId: id, agentId: s.agentId || state.defaultAgentId, inFlight: !!s._sendingInFlight })
      }
      ws.send(JSON.stringify({ type: 'inbound.hello', channel: 'webchat', peers }))
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
    if (ws.readyState === 1)
      try {
        ws.send('{"type":"ping"}')
      } catch {}
  }, 30000)

  ws.onclose = (e) => {
    clearInterval(_wsKeepAlive)
    // Guard: ignore close events from stale sockets (a newer connect() may have replaced state.ws)
    if (state.ws !== ws) return
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
      localStorage.removeItem('openclaude_token')
      state.token = ''
      toast('Token 无效或已过期，请重新登录', 'error')
      _deps.showLogin()
      return
    }
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
    // Don't auto-reconnect if logged out (no token)
    if (!state.token) return
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
  ws.onerror = () => {}
  ws.onmessage = (ev) => {
    // Guard: ignore messages from stale sockets
    if (state.ws !== ws) return
    try {
      const f = JSON.parse(ev.data)
      if (f.type === 'outbound.message') handleOutbound(f)
      else if (f.type === 'outbound.permission_request') handlePermissionRequest(f)
      else if (f.type === 'outbound.permission_settled') handlePermissionSettled(f)
      else if (f.type === 'outbound.ack' && f.deduplicated) {
        // Server already processed this message; clear drain state so queue continues
        if (state._offlineDrainingCurrent) {
          state._offlineDrainingCurrent = null
          nudgeDrain()
        }
      }
    } catch {}
  }
}
export function formatMeta(m) {
  if (!m) return ''
  const parts = []
  if (typeof m.cost === 'number') parts.push(`$${m.cost.toFixed(4)}`)
  if (typeof m.totalCost === 'number' && m.totalCost !== m.cost)
    parts.push(`total $${m.totalCost.toFixed(4)}`)
  if (typeof m.inputTokens === 'number') parts.push(`in ${m.inputTokens}`)
  if (typeof m.outputTokens === 'number') parts.push(`out ${m.outputTokens}`)
  if (m.cacheReadTokens > 0) parts.push(`cache-r ${m.cacheReadTokens}`)
  if (m.cacheCreationTokens > 0) parts.push(`cache-w ${m.cacheCreationTokens}`)
  if (typeof m.turn === 'number') parts.push(`T${m.turn}`)
  return parts.join(' · ')
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
  if (!sess._blockIdToMsgId) {
    // Rebuild blockId→msgId and agentGroups mappings from restored messages (after page refresh)
    sess._blockIdToMsgId = new Map()
    if (!sess._agentGroups) sess._agentGroups = new Map()
    for (const m of sess.messages) {
      if (m.blockId) sess._blockIdToMsgId.set(m.blockId, m.id)
      if (m.role === 'agent-group' && m.blockId) sess._agentGroups.set(m.blockId, m.id)
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
        // Avoid double-insertion on rare re-entrant cases: skip if the last
        // message is already an empty-turn warning for this target.
        const last = sess.messages[sess.messages.length - 1]
        const alreadyWarned = last && last._emptyTurn
        if (!alreadyWarned) {
          console.warn('[ws] empty-turn: isFinal with zero blocks', {
            sessionId: sess.id,
            targetMsgId: _targetMsg.id,
          })
          addMessage(sess, 'assistant', '⚠️ 本轮响应为空 — 服务端标记已完成,但没有生成任何内容。请重试或检查服务状态。', {
            error: true,
            _emptyTurn: true,
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
    if (metaText && sess._streamingAssistant) setMeta(sess, sess._streamingAssistant, metaText)
    // Accumulate token usage for session-level tracking
    if (frame.meta) {
      if (!sess._tokenUsage) sess._tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      if (typeof frame.meta.inputTokens === 'number') sess._tokenUsage.input += frame.meta.inputTokens
      if (typeof frame.meta.outputTokens === 'number') sess._tokenUsage.output += frame.meta.outputTokens
      if (typeof frame.meta.cacheReadTokens === 'number') sess._tokenUsage.cacheRead += frame.meta.cacheReadTokens
      if (typeof frame.meta.cacheCreationTokens === 'number') sess._tokenUsage.cacheWrite += frame.meta.cacheCreationTokens
      if (typeof frame.meta.cost === 'number') sess._tokenUsage.cost += frame.meta.cost
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

  // Build and show modal overlay
  _showPermissionModal(frame, sess, msg)

  // Play notification sound
  _notifSound()
}

function _showPermissionModal(frame, sess, msg) {
  // If another permission modal is already showing, deny the OLD one first
  // (only one modal can be visible at a time in the UI)
  const existing = document.getElementById('permission-modal')
  if (existing) {
    const oldRequestId = existing.dataset.requestId
    if (oldRequestId && _pendingPermissions.has(oldRequestId)) {
      const old = _pendingPermissions.get(oldRequestId)
      if (old.timer) clearInterval(old.timer)
      // Auto-deny the displaced prompt — use the OLD frame's peer/agent
      if (state.ws && state.ws.readyState === 1 && old.frame) {
        const oldPeerId = old.frame.peer?.id
        const oldSess = oldPeerId ? state.sessions.get(oldPeerId) : null
        try {
          state.ws.send(JSON.stringify({
            type: 'inbound.permission_response',
            channel: old.frame.channel || 'webchat',
            peer: old.frame.peer,
            agentId: oldSess?.agentId || state.defaultAgentId,
            requestId: oldRequestId,
            behavior: 'deny',
            message: 'Displaced by newer permission prompt',
          }))
        } catch {}
        // Update the old permission card in its own session
        if (oldSess) {
          const oldMsg = oldSess.messages.find(m => m.requestId === oldRequestId)
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

function _resolvePermission(frame, behavior, message, sess, msg, overlay) {
  // Send response via WebSocket
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({
      type: 'inbound.permission_response',
      channel: frame.channel || 'webchat',
      peer: frame.peer,
      agentId: sess.agentId || state.defaultAgentId,
      requestId: frame.requestId,
      behavior,
      message: message || undefined,
    }))
  }

  // Update message in chat
  if (msg) {
    msg._resolved = true
    msg._behavior = behavior
    if (sess.id === state.currentSessionId) _deps.updateMessageEl(msg)
  }

  // Remove modal
  if (overlay) overlay.remove()
  _pendingPermissions.delete(frame.requestId)
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
function handlePermissionSettled(frame) {
  const p = _pendingPermissions.get(frame.requestId)
  if (!p) return // already cleared locally (e.g. we were the sender, or a prior broadcast cleared it)
  if (p.timer) clearInterval(p.timer)
  // Update the permission card in the session that owns this request (not necessarily the current view)
  const peerId = p.frame?.peer?.id
  const sess = peerId ? state.sessions.get(peerId) : null
  if (sess) {
    const msg = sess.messages.find((m) => m.requestId === frame.requestId)
    if (msg) {
      msg._resolved = true
      msg._behavior = frame.behavior
      msg._settledReason = frame.reason || null
      if (sess.id === state.currentSessionId) _deps.updateMessageEl(msg)
    }
  }
  if (p.el) p.el.remove()
  _pendingPermissions.delete(frame.requestId)
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
      try {
        state.ws.send(JSON.stringify({
          type: 'inbound.permission_response',
          channel: p.frame.channel || 'webchat',
          peer: p.frame.peer,
          agentId: targetSess?.agentId || state.defaultAgentId,
          requestId: p.frame.requestId,
          behavior: 'deny',
          message: 'Turn completed or session ended',
        }))
      } catch {}
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
