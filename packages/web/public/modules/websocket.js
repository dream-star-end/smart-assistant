// OpenClaude — WebSocket connection, messaging, background tasks
import { $, htmlSafeEscape } from './dom.js'
import { state, getSession } from './state.js'
import { toast } from './ui.js'
import { setTitleBusy, maybeNotify } from './notifications.js'
import { enqueuePermission } from './permissions.js'

// ── Late-binding for circular deps (sessions.js, messages.js) ──
let _deps = {}
export function setWsDeps(deps) { _deps = deps }

// ── Module-private state ──
const _bgTasks = new Map() // id -> { desc, status, startTime, duration, error }

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
export function showTypingIndicator() {
  const inner = _deps.ensureInner()
  if (inner.querySelector('.typing-indicator')) return
  const el = document.createElement('div')
  el.className = 'typing-indicator'
  el.id = '__typing'
  const sess = getSession()
  const agentInfo = state.agentsList.find((a) => a.id === (sess?.agentId || state.defaultAgentId))
  const av = agentInfo?.avatarEmoji || 'O'
  const name = agentInfo?.displayName || sess?.agentId || 'AI'
  el.innerHTML = `<div class="avatar">${av}</div><div class="typing-dots"><span></span><span></span><span></span></div><span class="typing-label">${htmlSafeEscape(name)} 思考中</span>`
  el._startTime = Date.now()
  // Show elapsed time after 5s
  el._timer = setInterval(() => {
    const secs = Math.round((Date.now() - el._startTime) / 1000)
    const label = el.querySelector('.typing-label')
    if (label && secs >= 5) label.textContent = `${name} 思考中 (${secs}s)`
  }, 1000)
  inner.appendChild(el)
  _deps.scrollBottom(true)
}
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
  if (state.wsStatus !== 'connected') {
    btn.disabled = true
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
  toast('已发送停止指令')
}
export function connect() {
  if (state.ws && state.ws.readyState < 2) return
  setStatus('connecting…', 'connecting')
  // Use Sec-WebSocket-Protocol for auth instead of query string (avoids token in URL/logs)
  const url = `${(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host}/ws`
  const ws = new WebSocket(url, ['bearer', state.token])
  state.ws = ws
  ws.onopen = () => {
    setStatus('connected', 'connected')
    // Flush offline queue — send one at a time to avoid interleaving responses
    if (state.offlineQueue.length > 0) {
      const queue = [...state.offlineQueue]
      state.offlineQueue = []
      // Send only the first queued message now; rest will be sent after each response completes
      const sendNext = () => {
        if (queue.length === 0) return
        const item = queue.shift()
        try {
          ws.send(JSON.stringify(item.payload))
          const sess = state.sessions.get(item.sessId)
          if (sess) {
            const msg = sess.messages.find((m) => m.id === item.msgId)
            if (msg) {
              msg.status = 'sent'
              updateMsgStatus(msg)
            }
          }
        } catch {}
        // Queue the next message to send after current response finishes (isFinal)
        if (queue.length > 0) {
          const _origHandler = ws.onmessage
          const _waitFinal = (ev) => {
            try {
              const f = JSON.parse(ev.data)
              if (f.type === 'outbound.message' && f.isFinal) {
                ws.onmessage = _origHandler
                setTimeout(sendNext, 500)
              }
            } catch {}
            if (_origHandler) _origHandler(ev)
          }
          ws.onmessage = _waitFinal
        }
      }
      sendNext()
      if (queue.length >= 0) {
        toast(`${queue.length} 条离线消息已发送`)
        // Mark the first queued item's session as sending
        const firstItem = queue[0] || item
        const qSess = firstItem ? state.sessions.get(firstItem.sessId) : null
        if (qSess) qSess._sendingInFlight = true
        // Only update global UI if queued session is currently visible
        if (qSess && qSess.id === state.currentSessionId) {
          state.sendingInFlight = true
          updateSendEnabled()
          showTypingIndicator()
          setTitleBusy(true)
        }
      }
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
    setStatus('disconnected', 'disconnected')
    // Clear all sessions' sending state on disconnect
    for (const [, s] of state.sessions) s._sendingInFlight = false
    state.sendingInFlight = false
    updateSendEnabled()
    hideTypingIndicator()
    if (e.code === 1008) {
      localStorage.removeItem('openclaude_token')
      state.token = ''
      _deps.showLogin()
      return
    }
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    state.reconnectTimer = setTimeout(connect, 2000)
  }
  ws.onerror = () => {}
  ws.onmessage = (ev) => {
    try {
      const f = JSON.parse(ev.data)
      if (f.type === 'outbound.message') handleOutbound(f)
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
  // Permission requests are a special channel — they don't belong to any
  // chat session, they pop a modal for the user to answer.
  if (frame.permissionRequest) {
    enqueuePermission(frame)
    return
  }
  const peerId = frame.peer?.id
  let sess = state.sessions.get(peerId)
  // If session not found (e.g. proactive push from cron/reminder), show in current active session
  if (!sess) {
    sess = getSession()
    if (!sess) return
  }
  if (!sess._blockIdToMsgId) sess._blockIdToMsgId = new Map()
  // Any output -> hide typing indicator ONLY if this is the currently viewed session
  if (((frame.blocks?.length || 0) > 0 || frame.isFinal) && sess.id === state.currentSessionId)
    hideTypingIndicator()
  // Update last user message status: first block = "read", isFinal = "replied"
  const _lastUserMsg = [...sess.messages]
    .reverse()
    .find((m) => m.role === 'user' && m.status && m.status !== 'replied')
  if (_lastUserMsg) {
    if (
      frame.blocks?.length > 0 &&
      _lastUserMsg.status !== 'read' &&
      _lastUserMsg.status !== 'replied'
    ) {
      _lastUserMsg.status = 'read'
      updateMsgStatus(_lastUserMsg)
    }
    if (frame.isFinal) {
      _lastUserMsg.status = 'replied'
      updateMsgStatus(_lastUserMsg)
    }
  }
  // Detect non-heartbeat cron/task push — mark as system notification
  const isCronPush = frame.cronJob && !frame.cronJob.heartbeat

  for (const block of frame.blocks || []) {
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
      sess._streamingAssistant.text += block.text
      _checkTaskNotifications(block.text)
      // Throttled render: batch streaming updates via rAF instead of per-delta
      if (!sess._streamRafPending) {
        sess._streamRafPending = true
        requestAnimationFrame(() => {
          sess._streamRafPending = false
          if (sess._streamingAssistant) {
            updateMessage(sess, sess._streamingAssistant, sess._streamingAssistant.text, true)
            _deps.scrollBottom()
          }
        })
      }
    } else if (block.kind === 'thinking') {
      if (!sess._streamingThinking) sess._streamingThinking = addMessage(sess, 'thinking', '')
      sess._streamingThinking.text += block.text
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
      sess._streamingAssistant = null
      sess._streamingThinking = null
      const isAgent = /^Agent$/i.test(block.toolName || '')
      const label = buildToolUseLabel(block)

      if (isAgent) {
        // Sub-agent: create a collapsible group card
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
        }
      } else if (block.blockId && sess._blockIdToMsgId.has(block.blockId)) {
        const mid = sess._blockIdToMsgId.get(block.blockId)
        const existing = sess.messages.find((m) => m.id === mid)
        if (existing) {
          existing.text = label
          if (sess.id === state.currentSessionId) _deps.updateMessageEl(existing)
        }
      } else {
        const m = addMessage(sess, 'tool', label, {
          toolIcon: '🔧',
          toolName: block.toolName,
          blockId: block.blockId,
        })
        if (block.blockId) sess._blockIdToMsgId.set(block.blockId, m.id)
      }
    } else if (block.kind === 'tool_result') {
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
        }
        continue
      }

      if (!block.preview) continue
      const label = (block.toolName ? `${block.toolName}: ` : '') + block.preview
      if (block.blockId && sess._blockIdToMsgId.has(block.blockId)) {
        const mid = sess._blockIdToMsgId.get(block.blockId)
        const existing = sess.messages.find((m) => m.id === mid)
        if (existing) {
          existing.text = label
          existing.error = !!block.isError
          if (sess.id === state.currentSessionId) _deps.updateMessageEl(existing)
          continue
        }
      }
      const m = addMessage(sess, 'tool', label, {
        toolIcon: block.isError ? '⚠️' : '↳',
        toolName: block.toolName,
        blockId: block.blockId,
        error: !!block.isError,
      })
      if (block.blockId) sess._blockIdToMsgId.set(block.blockId, m.id)
    }
  }
  sess.lastAt = Date.now()
  if (frame.isFinal) {
    const metaText = formatMeta(frame.meta)
    if (metaText && sess._streamingAssistant) setMeta(sess, sess._streamingAssistant, metaText)
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
    sess._streamingAssistant = null
    sess._streamingThinking = null
    sess._sendingInFlight = false
    // Only update global UI state if this is the currently viewed session
    if (sess.id === state.currentSessionId) {
      state.sendingInFlight = false
      updateSendEnabled()
      hideTypingIndicator()
      setTitleBusy(false)
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
  _deps.scheduleSave(sess)
  // Only rebuild sidebar on final message (not every streaming delta)
  if (frame.isFinal) _deps.renderSidebar()
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
function _renderTasksPanel() {
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
