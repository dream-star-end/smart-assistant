import { dbDelete, dbPut } from './db.js'
// OpenClaude — Session management, sidebar, context menu
import { $, htmlSafeEscape } from './dom.js'
import { getSession, state } from './state.js'
import { toast } from './ui.js'
import { GROUP_ORDER, sessionGroup, shortTime, uuid } from './util.js'

// Late-bound references set by main.js
let _renderMessages
let _updateSendEnabled
let _updateSessionSub
let _scrollBottom
export function setSessionDeps(deps) {
  _renderMessages = deps.renderMessages
  _updateSendEnabled = deps.updateSendEnabled
  _updateSessionSub = deps.updateSessionSub
  _scrollBottom = deps.scrollBottom
}

// Late-bound references for functions that live in app.js (typing indicator, agent dropdown)
let _showTypingIndicator
let _hideTypingIndicator
let _renderAgentDropdown
export function setSessionUIDeps(deps) {
  _showTypingIndicator = deps.showTypingIndicator
  _hideTypingIndicator = deps.hideTypingIndicator
  _renderAgentDropdown = deps.renderAgentDropdown
}

// ═══════════════ SESSIONS ═══════════════
export function createSession(agentId) {
  const id = uuid()
  const s = {
    id,
    title: '新会话',
    createdAt: Date.now(),
    lastAt: Date.now(),
    messages: [],
    agentId: agentId || state.defaultAgentId,
  }
  state.sessions.set(id, s)
  state.currentSessionId = id
  scheduleSave(s)
  return s
}

export function switchSession(id) {
  if (!state.sessions.has(id)) return
  // Save sending state on old session, restore from new
  const oldSess = getSession()
  if (oldSess) oldSess._sendingInFlight = state.sendingInFlight
  state.currentSessionId = id
  const newSess = getSession()
  state.sendingInFlight = newSess?._sendingInFlight || false
  _updateSendEnabled()
  if (state.sendingInFlight) _showTypingIndicator()
  else _hideTypingIndicator()
  renderSidebar()
  _renderMessages()
  _renderAgentDropdown()
  $('sidebar').classList.remove('open')
  $('sidebar-backdrop').classList.remove('open')
}

export async function deleteSession(id) {
  state.sessions.delete(id)
  try {
    await dbDelete(id)
  } catch {}
  if (state.currentSessionId === id) {
    const arr = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
    if (arr.length > 0) state.currentSessionId = arr[0].id
    else createSession()
    _renderMessages()
  }
  renderSidebar()
}

const _saveTimers = new Map()
// Search index: build a single lowercase string per session covering message text.
// Fills from newest messages first so recent topics are always searchable,
// then appends older messages until the 50K char budget is exhausted.
const _SEARCH_INDEX_CAP = 50000
export function _rebuildSearchIndex(sess) {
  if (!sess) return
  const title = (sess.title || '').toLowerCase()
  let len = title.length
  const msgs = sess.messages || []
  const parts = []
  // Pass 1: newest -> oldest (guarantees recent content is indexed)
  for (let i = msgs.length - 1; i >= 0 && len < _SEARCH_INDEX_CAP; i--) {
    const m = msgs[i]
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const t = (m.text || '').toLowerCase()
    const remaining = _SEARCH_INDEX_CAP - len
    parts.push(remaining >= t.length ? t : t.slice(0, remaining))
    len += Math.min(t.length, remaining)
  }
  // Reverse so the concatenated string is still chronological (nice-to-have, not critical)
  parts.reverse()
  sess._searchText = `${title} ${parts.join(' ')}`
}

export function scheduleSave(s) {
  const sess = s || getSession()
  if (!sess) return
  _rebuildSearchIndex(sess)
  const prev = _saveTimers.get(sess.id)
  if (prev) clearTimeout(prev)
  const t = setTimeout(async () => {
    _saveTimers.delete(sess.id)
    const { _streamingAssistant, _streamingThinking, _blockIdToMsgId, ...persist } = sess
    try {
      await dbPut(persist)
    } catch (e) {
      console.warn('dbPut', e)
    }
  }, 400)
  _saveTimers.set(sess.id, t)
}

// ═══════════════ SIDEBAR ═══════════════
export function renderSidebar() {
  const body = $('sessions-body')
  body.innerHTML = ''
  const searchQuery = ($('sidebar-search')?.value || '').trim().toLowerCase()
  const allSessions = [...state.sessions.values()].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return b.lastAt - a.lastAt
  })
  // Filter by search query -- uses pre-built _searchText index (title + last 10 msgs)
  const sessions = searchQuery
    ? allSessions.filter((s) => (s._searchText || s.title.toLowerCase()).includes(searchQuery))
    : allSessions

  // Pinned group
  const pinned = sessions.filter((s) => s.pinned)
  const unpinned = sessions.filter((s) => !s.pinned)

  if (pinned.length > 0) {
    const label = document.createElement('div')
    label.className = 'sessions-group-label'
    label.textContent = '⭐ 置顶'
    body.appendChild(label)
    for (const s of pinned) body.appendChild(_buildSessionItem(s))
  }

  // Time groups for unpinned
  const groups = new Map()
  for (const s of unpinned) {
    const g = sessionGroup(s.lastAt)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(s)
  }
  for (const groupName of GROUP_ORDER) {
    const items = groups.get(groupName)
    if (!items || items.length === 0) continue
    const label = document.createElement('div')
    label.className = 'sessions-group-label'
    label.textContent = groupName
    body.appendChild(label)
    for (const s of items) body.appendChild(_buildSessionItem(s))
  }
}

export function _buildSessionItem(s) {
  const item = document.createElement('div')
  item.className = `session-item${s.id === state.currentSessionId ? ' active' : ''}${s.pinned ? ' pinned' : ''}`
  item.setAttribute('role', 'option')
  item.setAttribute('aria-selected', s.id === state.currentSessionId ? 'true' : 'false')
  item.setAttribute('tabindex', '0')
  item.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      switchSession(s.id)
    }
  }
  const title = document.createElement('div')
  title.className = 'session-item-title'
  title.textContent = (s.pinned ? '⭐ ' : '') + s.title
  // Double-click to rename
  title.ondblclick = (e) => {
    e.stopPropagation()
    startInlineRename(title, s)
  }

  const del = document.createElement('button')
  del.className = 'session-item-delete'
  del.title = '删除'
  del.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>'
  del.onclick = async (e) => {
    e.stopPropagation()
    if (!confirm(`删除会话 "${s.title}"?`)) return
    await deleteSession(s.id)
  }

  item.appendChild(title)
  item.appendChild(del)
  item.onclick = () => switchSession(s.id)

  // Right-click context menu
  item.oncontextmenu = (e) => {
    e.preventDefault()
    e.stopPropagation()
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '重命名',
        run: () => {
          switchSession(s.id)
          setTimeout(() => {
            const t = $('sessions-body').querySelector('.session-item.active .session-item-title')
            if (t) startInlineRename(t, s)
          }, 50)
        },
      },
      {
        label: s.pinned ? '取消置顶' : '置顶',
        run: () => {
          s.pinned = !s.pinned
          scheduleSave(s)
          renderSidebar()
        },
      },
      { label: '导出 Markdown', run: () => exportSessionMd(s) },
      { divider: true },
      {
        label: '删除',
        danger: true,
        run: async () => {
          if (!confirm(`删除会话 "${s.title}"?`)) return
          await deleteSession(s.id)
        },
      },
    ])
  }

  // Mobile long-press
  let _lpt = null
  item.ontouchstart = (e) => {
    _lpt = setTimeout(() => {
      const touch = e.touches[0]
      showContextMenu(touch.clientX, touch.clientY, [
        { label: '重命名', run: () => startInlineRename(title, s) },
        {
          label: s.pinned ? '取消置顶' : '置顶',
          run: () => {
            s.pinned = !s.pinned
            scheduleSave(s)
            renderSidebar()
          },
        },
        { label: '导出 Markdown', run: () => exportSessionMd(s) },
        { divider: true },
        {
          label: '删除',
          danger: true,
          run: async () => {
            if (!confirm('删除?')) return
            await deleteSession(s.id)
          },
        },
      ])
    }, 600)
  }
  item.ontouchend = () => clearTimeout(_lpt)
  item.ontouchmove = () => clearTimeout(_lpt)

  return item
}

// ── Inline rename ──
export function startInlineRename(titleEl, sess) {
  const input = document.createElement('input')
  input.className = 'session-rename-input'
  input.value = sess.title
  input.maxLength = 60
  const finish = () => {
    const v = input.value.trim()
    if (v && v !== sess.title) {
      sess.title = v
      scheduleSave(sess)
      if (sess.id === state.currentSessionId) $('session-title').textContent = v
    }
    renderSidebar()
  }
  input.onblur = finish
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      input.blur()
    } else if (e.key === 'Escape') {
      input.value = sess.title
      input.blur()
    }
  }
  titleEl.replaceWith(input)
  input.focus()
  input.select()
}

// ── Export session as markdown ──
export function exportSessionMd(sess) {
  const lines = [
    `# ${sess.title}`,
    '',
    `> Exported from OpenClaude · ${new Date().toLocaleString()}`,
    '',
  ]
  for (const m of sess.messages) {
    if (m.role === 'user') lines.push('## 👤 User', '', m.text || '', '')
    else if (m.role === 'assistant') lines.push('## 🤖 Assistant', '', m.text || '', '')
    else if (m.role === 'tool') lines.push(`> 🔧 ${m.text || ''}`, '')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown; charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(sess.title || 'session').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')}.md`
  a.click()
  URL.revokeObjectURL(a.href)
  toast('已导出')
}

// ── Context menu ──
let _ctxMenu = null
export function showContextMenu(x, y, items) {
  hideContextMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  for (const it of items) {
    if (it.divider) {
      menu.insertAdjacentHTML('beforeend', '<div class="ctx-divider"></div>')
      continue
    }
    const btn = document.createElement('button')
    btn.className = `ctx-item${it.danger ? ' danger' : ''}`
    btn.textContent = it.label
    btn.onclick = () => {
      hideContextMenu()
      it.run()
    }
    menu.appendChild(btn)
  }
  document.body.appendChild(menu)
  // Position: ensure within viewport
  const rect = menu.getBoundingClientRect()
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8
  menu.style.left = `${Math.max(4, x)}px`
  menu.style.top = `${Math.max(4, y)}px`
  _ctxMenu = menu
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 10)
}

export function hideContextMenu() {
  if (_ctxMenu) {
    _ctxMenu.remove()
    _ctxMenu = null
  }
}
