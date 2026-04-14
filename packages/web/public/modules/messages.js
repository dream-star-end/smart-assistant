// OpenClaude — Message rendering and display
import { $, _mod, fallbackCopy, htmlSafeEscape } from './dom.js'
import {
  clearChartInstances,
  embedMediaUrls,
  processRichBlocks,
  renderMarkdown,
  renderStreamingMarkdown,
} from './markdown.js'
import { getSession, state } from './state.js'
import { toast } from './ui.js'
import { shortTime } from './util.js'

// Late-bound references set by main.js to break circular deps
let _updateSendEnabled
let _showTypingIndicator
let _hideTypingIndicator
let _setTitleBusy
let _scheduleSave
export function setMessageDeps(deps) {
  _updateSendEnabled = deps.updateSendEnabled
  _showTypingIndicator = deps.showTypingIndicator
  _hideTypingIndicator = deps.hideTypingIndicator
  _setTitleBusy = deps.setTitleBusy
  _scheduleSave = deps.scheduleSave
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

// ═══════════════ RENDERING ═══════════════
export function ensureInner() {
  let inner = document.querySelector('.messages-inner')
  if (!inner) {
    inner = document.createElement('div')
    inner.className = 'messages-inner'
    $('messages').appendChild(inner)
  }
  return inner
}

export function isAtBottom() {
  const m = $('messages')
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120
}

// Track whether user has manually scrolled up during streaming -- if so, don't auto-scroll
let _userScrolledUp = false
let _scrollDebounce = null

export function initMessagesListeners() {
  const _handleUserScroll = () => {
    if (state.sendingInFlight) {
      _userScrolledUp = !isAtBottom()
      clearTimeout(_scrollDebounce)
      _scrollDebounce = setTimeout(() => {
        _userScrolledUp = false
      }, 3000)
    }
  }
  const msgEl = $('messages')
  if (!msgEl) return
  // Listen to wheel (desktop), touchmove (mobile), and generic scroll (scrollbar drag, keyboard)
  msgEl.addEventListener('wheel', _handleUserScroll)
  msgEl.addEventListener('touchmove', _handleUserScroll)
  msgEl.addEventListener('scroll', _handleUserScroll, { passive: true })
}

export function scrollBottom(force) {
  const m = $('messages')
  // During streaming: always scroll unless user explicitly scrolled up
  if (force || (state.sendingInFlight && !_userScrolledUp) || isAtBottom()) {
    // Use instant scroll during streaming to avoid fighting with CSS smooth-scroll
    if (state.sendingInFlight) {
      m.scrollTo({ top: m.scrollHeight, behavior: 'instant' })
    } else {
      m.scrollTop = m.scrollHeight
    }
  }
}

export function _buildMessageEl(msg) {
  const el = document.createElement('div')
  el.className = `msg ${msg.role}`
  if (msg.error) el.classList.add('error')
  el.dataset.msgId = msg.id
  if (msg.role === 'assistant') {
    if (msg.cronPush) {
      el.classList.add('cron-push')
    }
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    // Use agent persona emoji if available, fallback to 'O'
    const agentInfo = state.agentsList.find(
      (a) => a.id === (getSession()?.agentId || state.defaultAgentId),
    )
    avatar.textContent = agentInfo?.avatarEmoji || 'O'
    el.appendChild(avatar)
    // Cron push badge -- visually marks system-generated messages
    if (msg.cronPush) {
      const badge = document.createElement('div')
      badge.className = 'cron-push-badge'
      badge.textContent = `📋 ${msg.cronLabel || '定时任务'}`
      el.appendChild(badge)
    }
    const body = document.createElement('div')
    body.className = 'msg-body'
    body.innerHTML = renderMarkdown(msg.text || '')
    el.appendChild(body)
    // ── Message action bar ──
    const actions = document.createElement('div')
    actions.className = 'msg-actions'
    actions.innerHTML =
      '<button data-action="copy" title="复制"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
      '<button data-action="regen" title="重新生成"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>' +
      '<button data-action="tts" title="朗读"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button>' +
      '<button data-action="del" title="删除"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>'
    actions.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const action = btn.dataset.action
      const sess = getSession()
      if (!sess) return
      const _svgCopy =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
      const _svgCheck =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      const _svgVol =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'
      const _svgStop =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
      if (action === 'copy') {
        const _doCopied = () => {
          btn.classList.add('copied')
          btn.innerHTML = _svgCheck
          setTimeout(() => {
            btn.classList.remove('copied')
            btn.innerHTML = _svgCopy
          }, 1500)
        }
        if (navigator.clipboard?.writeText) {
          navigator.clipboard
            .writeText(msg.text || '')
            .then(_doCopied)
            .catch(() => {
              fallbackCopy(msg.text || '')
              _doCopied()
            })
        } else {
          fallbackCopy(msg.text || '')
          _doCopied()
        }
      } else if (action === 'regen') {
        // Stop any in-flight turn before regenerating to avoid concurrent requests
        if (state.sendingInFlight) {
          // Import stopCurrentTurn via late-bound deps isn't available here,
          // so send the stop command directly
          if (state.ws && state.ws.readyState === 1) {
            state.ws.send(JSON.stringify({
              type: 'inbound.control.stop',
              channel: 'webchat',
              peer: { id: sess.id, kind: 'dm' },
              agentId: sess.agentId || state.defaultAgentId,
            }))
          }
          sess._sendingInFlight = false
          state.sendingInFlight = false
          _hideTypingIndicator()
          _updateSendEnabled()
          _setTitleBusy(false)
        }
        // Find the last user message before this assistant message
        const idx = sess.messages.indexOf(msg)
        if (idx < 0) return
        let lastUserMsg = null
        for (let i = idx - 1; i >= 0; i--) {
          if (sess.messages[i].role === 'user') {
            lastUserMsg = sess.messages[i]
            break
          }
        }
        if (!lastUserMsg) {
          toast('没有找到可重发的用户消息', 'error')
          return
        }
        // Remove messages from this one onwards
        sess.messages.splice(idx)
        renderMessages()
        // Re-send via proper path: build payload with original media if present
        const wsPayload = {
          type: 'inbound.message',
          idempotencyKey: `regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel: 'webchat',
          peer: { id: sess.id, kind: 'dm' },
          agentId: sess.agentId || state.defaultAgentId,
          content: {
            text: lastUserMsg._modelText || lastUserMsg.text || '',
            media: lastUserMsg._media || undefined,
          },
          ts: Date.now(),
        }
        // Check if there are pending offline items for this session to prevent reordering
        const _hasQueued = (state.offlineQueue?.some(i => i.sessId === sess.id)) ||
          (state._offlineQueuePending?.some(i => i.sessId === sess.id)) ||
          (state._offlineDrainingCurrent?.sessId === sess.id)
        if (state.ws && state.ws.readyState === 1 && !_hasQueued) {
          state.ws.send(JSON.stringify(wsPayload))
          sess._sendingInFlight = true
          state.sendingInFlight = true
          _updateSendEnabled()
          _showTypingIndicator()
          _setTitleBusy(true)
        } else {
          // Offline or has pending queue items: queue to maintain order
          state.offlineQueue.push({
            sessId: sess.id,
            payload: wsPayload,
            msgId: lastUserMsg.id,
          })
          if (!state.ws || state.ws.readyState !== 1) {
            toast('离线排队中，重连后自动重新生成')
          }
        }
        _scheduleSave(sess)
      } else if (action === 'tts-stop') {
        // Stop ongoing TTS playback
        if (window.speechSynthesis) window.speechSynthesis.cancel()
        btn.innerHTML = _svgVol
        btn.title = '朗读'
        btn.dataset.action = 'tts'
      } else if (action === 'tts') {
        // Use Web Speech API for quick read-aloud
        const text = (msg.text || '').replace(/[#*`>_~\[\]()]/g, '').slice(0, 2000)
        if (!text) return
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel()
          const utter = new SpeechSynthesisUtterance(text)
          utter.lang = 'zh-CN'
          utter.rate = 1.1
          window.speechSynthesis.speak(utter)
          btn.innerHTML = _svgStop
          btn.title = '停止朗读'
          btn.dataset.action = 'tts-stop'  // Change action to prevent re-entry from delegated handler
          utter.onend = () => {
            btn.innerHTML = _svgVol
            btn.title = '朗读'
            btn.dataset.action = 'tts'
          }
        } else {
          toast('浏览器不支持语音合成', 'error')
        }
      } else if (action === 'del') {
        const idx = sess.messages.indexOf(msg)
        if (idx < 0) return
        // Soft delete with undo toast
        sess.messages.splice(idx, 1)
        el.style.display = 'none'
        const undoToast = document.createElement('div')
        undoToast.className = 'toast show'
        undoToast.innerHTML =
          '消息已删除 <button class="undo-btn" style="margin-left:12px;color:var(--accent);background:none;border:none;cursor:pointer;font-weight:600;text-decoration:underline">撤销</button>'
        document.body.appendChild(undoToast)
        let undone = false
        undoToast.querySelector('.undo-btn').onclick = () => {
          undone = true
          sess.messages.splice(idx, 0, msg)
          el.style.display = ''
          undoToast.remove()
          _scheduleSave(sess)
        }
        setTimeout(() => {
          if (!undone) {
            el.remove()
            _scheduleSave(sess)
          }
          undoToast.remove()
        }, 4000)
      }
    })
    el.appendChild(actions)
    if (msg.metaText) {
      const meta = document.createElement('div')
      meta.className = 'msg-meta'
      renderMetaInto(meta, msg.metaText)
      el.appendChild(meta)
    }
  } else if (msg.role === 'agent-group') {
    el.className = 'agent-group'
    const svgBot =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>'
    const svgChevron =
      '<svg class="agent-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
    const statusText = msg._completed
      ? msg._isError
        ? '<span class="agent-group-status" style="color:var(--danger)">失败</span>'
        : `<span class="agent-group-status" style="color:var(--success)">完成 (${(msg._duration / 1000).toFixed(1)}s)</span>`
      : '<span class="agent-group-status">运行中...</span>'
    const header = document.createElement('div')
    header.className = 'agent-group-header'
    header.innerHTML = `${svgBot}<span>子任务: ${htmlSafeEscape(msg.text || '')}</span>${statusText}${svgChevron}`
    header.onclick = () => el.classList.toggle('collapsed')
    el.appendChild(header)
    const body = document.createElement('div')
    body.className = 'agent-group-body'
    if (msg._resultPreview) {
      const preview = document.createElement('div')
      preview.className = 'msg tool'
      preview.style.cssText = 'padding:6px 10px;border:none;background:transparent;font-size:12px'
      preview.innerHTML = `<span class="tool-icon">${msg._isError ? '⚠️' : '✓'}</span><div class="tool-body">${htmlSafeEscape(msg._resultPreview)}</div>`
      body.appendChild(preview)
    }
    el.appendChild(body)
  } else if (msg.role === 'thinking') {
    const header = document.createElement('div')
    header.className = 'thinking-header'
    header.innerHTML = '<span class="thinking-label">💭 思考中…</span>'
    header.onclick = () => el.classList.toggle('collapsed')
    el.appendChild(header)
    const body = document.createElement('div')
    body.className = 'msg-body thinking-body'
    body.textContent = msg.text || ''
    el.appendChild(body)
  } else if (msg.role === 'tool') {
    const icon = document.createElement('span')
    icon.className = 'tool-icon'
    icon.textContent = msg.toolIcon || '🔧'
    const body = document.createElement('div')
    body.className = 'tool-body'
    body.textContent = msg.text || ''
    el.appendChild(icon)
    el.appendChild(body)
  } else {
    // User messages: render with media URL embedding but XSS-safe
    const body = document.createElement('div')
    body.className = 'msg-body'
    const safeHtml = htmlSafeEscape(msg.text || '').replace(/\n/g, '<br>')
    body.innerHTML = embedMediaUrls(safeHtml)
    el.appendChild(body)
    // Status indicator for user messages
    if (msg.status) {
      const statusEl = document.createElement('div')
      statusEl.className = `msg-status ${msg.status}`
      statusEl.innerHTML = `${_STATUS_SVG[msg.status] || ''}<span>${_STATUS_LABEL[msg.status] || ''}</span>`
      el.appendChild(statusEl)
    }
  }
  return el
}

export function renderMessage(msg, skipRichBlocks = false) {
  const main = ensureInner()
  const el = _buildMessageEl(msg)
  main.appendChild(el)
  if (!skipRichBlocks) processRichBlocks()
}

export function updateMessageEl(msg, streaming) {
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`)
  if (!el) return
  if (msg.role === 'assistant') {
    const body = el.querySelector('.msg-body')
    if (body) {
      if (streaming) {
        // Streaming: lightweight Markdown (no hljs, no rich-block side effects)
        body.innerHTML = renderStreamingMarkdown(msg.text || '')
        body.style.whiteSpace = ''
        // Append blinking caret inside the deepest last block element
        // so it appears at the actual text cursor position
        let _caretTarget = body
        while (_caretTarget.lastElementChild &&
               !_caretTarget.lastElementChild.classList?.contains('code-block') &&
               _caretTarget.lastElementChild.tagName !== 'PRE') {
          const last = _caretTarget.lastElementChild
          // Only descend into block-level elements that contain text
          const tag = last.tagName
          if (['P','LI','TD','TH','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','DIV','OL','UL'].includes(tag)) {
            _caretTarget = last
          } else {
            break
          }
        }
        const caret = document.createElement('span')
        caret.className = 'streaming-caret'
        _caretTarget.appendChild(caret)
      } else {
        body.innerHTML = renderMarkdown(msg.text || '')
        body.style.whiteSpace = ''
      }
    }
    if (msg.metaText) {
      let meta = el.querySelector('.msg-meta')
      if (!meta) {
        meta = document.createElement('div')
        meta.className = 'msg-meta'
        el.appendChild(meta)
      }
      renderMetaInto(meta, msg.metaText)
    }
  } else if (msg.role === 'agent-group') {
    // Re-render the whole card (simpler than partial updates)
    el.innerHTML = ''
    el.className = 'agent-group'
    const svgBot =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>'
    const svgChevron =
      '<svg class="agent-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
    const statusText = msg._completed
      ? msg._isError
        ? '<span class="agent-group-status" style="color:var(--danger)">失败</span>'
        : `<span class="agent-group-status" style="color:var(--success)">完成 (${(msg._duration / 1000).toFixed(1)}s)</span>`
      : '<span class="agent-group-status">运行中...</span>'
    const header = document.createElement('div')
    header.className = 'agent-group-header'
    header.innerHTML = `${svgBot}<span>子任务: ${htmlSafeEscape(msg.text || '')}</span>${statusText}${svgChevron}`
    header.onclick = () => el.classList.toggle('collapsed')
    el.appendChild(header)
    if (msg._resultPreview) {
      const body = document.createElement('div')
      body.className = 'agent-group-body'
      const preview = document.createElement('div')
      preview.className = 'msg tool'
      preview.style.cssText = 'padding:6px 10px;border:none;background:transparent;font-size:12px'
      preview.innerHTML = `<span class="tool-icon">${msg._isError ? '⚠️' : '✓'}</span><div class="tool-body">${htmlSafeEscape(msg._resultPreview)}</div>`
      body.appendChild(preview)
      el.appendChild(body)
    }
  } else if (msg.role === 'thinking') {
    const body = el.querySelector('.thinking-body') || el.querySelector('.msg-body')
    if (body) body.textContent = msg.text || ''
    // Update header: streaming → "思考中…", done → "思考过程"
    const label = el.querySelector('.thinking-label')
    if (label) label.textContent = streaming ? '💭 思考中…' : '💭 思考过程'
    // Auto-collapse when streaming ends
    if (!streaming) el.classList.add('collapsed')
  } else if (msg.role === 'tool') {
    const body = el.querySelector('.tool-body')
    if (body) body.textContent = msg.text || ''
    el.classList.toggle('error', !!msg.error)
  } else {
    const body = el.querySelector('.msg-body')
    if (body) {
      const safeHtml = htmlSafeEscape(msg.text || '').replace(/\n/g, '<br>')
      body.innerHTML = embedMediaUrls(safeHtml)
    }
  }
  processRichBlocks()
}

export function renderMetaInto(container, metaText) {
  container.innerHTML = ''
  const parts = (metaText || '').split(' · ')
  for (const p of parts) {
    if (!p) continue
    const span = document.createElement('span')
    span.className = 'msg-meta-item'
    span.textContent = p
    container.appendChild(span)
  }
}

export function renderMessages() {
  // Cleanup Chart.js instances before DOM wipe
  clearChartInstances()
  const main = $('messages')
  main.innerHTML = ''
  const s = getSession()
  if (!s) {
    $('session-title').textContent = '无会话'
    $('session-sub').textContent = ''
    return
  }
  $('session-title').textContent = s.title
  updateSessionSub(s)
  if (s.messages.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    const _ai = state.agentsList.find((a) => a.id === (s.agentId || state.defaultAgentId))
    const _name = _ai?.displayName || 'OpenClaude'
    const _av = htmlSafeEscape(_ai?.avatarEmoji || 'O')
    empty.innerHTML = `<div class="empty-brand">${_av}</div><h1>${htmlSafeEscape(_name)}</h1><p>你的个人 AI 助理，随时待命</p><div class="hint-kbd">按 <kbd>${_mod}K</kbd> 打开命令面板 · 输入 <kbd>/</kbd> 查看命令</div>`
    main.appendChild(empty)
    return
  }
  const inner = document.createElement('div')
  inner.className = 'messages-inner'
  main.appendChild(inner)
  // Performance: only render last 100 messages; show "load more" for older ones
  const MAX_INITIAL = 100
  const msgs = s.messages
  if (msgs.length > MAX_INITIAL) {
    const LOAD_BATCH = 50
    let _loadedUpTo = msgs.length - MAX_INITIAL // index: messages before this are not yet rendered
    const loadMore = document.createElement('button')
    loadMore.className = 'load-more-btn'
    loadMore.textContent = `加载更早的 ${_loadedUpTo} 条消息`
    const _doLoadMore = () => {
      const batchStart = Math.max(0, _loadedUpTo - LOAD_BATCH)
      const batchEnd = _loadedUpTo
      if (batchStart >= batchEnd) return
      const scrollBefore = main.scrollHeight
      const frag = document.createDocumentFragment()
      for (let i = batchStart; i < batchEnd; i++) {
        const el = _buildMessageEl(msgs[i])
        frag.appendChild(el)
      }
      _loadedUpTo = batchStart
      if (_loadedUpTo > 0) {
        // Still more to load -- update button text and keep it
        loadMore.textContent = `加载更早的 ${_loadedUpTo} 条消息`
        loadMore.after(frag)
      } else {
        // All loaded -- remove button
        loadMore.replaceWith(frag)
      }
      processRichBlocks()
      main.scrollTop += main.scrollHeight - scrollBefore
    }
    loadMore.onclick = _doLoadMore
    // Auto-load when scrolled to top (IntersectionObserver)
    if (window.IntersectionObserver) {
      const obs = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            obs.disconnect()
            _doLoadMore()
          }
        },
        { root: main },
      )
      obs.observe(loadMore)
    }
    inner.appendChild(loadMore)
    for (let i = msgs.length - MAX_INITIAL; i < msgs.length; i++) renderMessage(msgs[i], true)
  } else {
    for (const m of msgs) renderMessage(m, true)
  }
  // Batch process all rich blocks once instead of per-message
  processRichBlocks()
  scrollBottom(true)
}

export function updateSessionSub(s) {
  const el = $('session-sub')
  if (!s) {
    el.textContent = ''
    return
  }
  const n = s.messages.filter((m) => m.role === 'user').length
  el.textContent = (n > 0 ? `${n} 轮 · ` : '') + shortTime(s.lastAt)
}
