import { dbDelete, dbPut } from './db.js?v=99aa929b'
// OpenClaude — Session management, sidebar, context menu
import { $, htmlSafeEscape } from './dom.js?v=99aa929b'
import { exportSessionDocx } from './export-docx.js?v=99aa929b'
import { exportSessionTex } from './export-tex.js?v=99aa929b'
import { setTitleBusy } from './notifications.js?v=99aa929b'
import { getSession, state } from './state.js?v=99aa929b'
import { pushSessionToServer, deleteSessionFromServer } from './sync.js?v=99aa929b'
import { toast } from './ui.js?v=99aa929b'
import { GROUP_ORDER, sessionGroup, shortTime, uuid } from './util.js?v=99aa929b'
import { nudgeDrain } from './websocket.js?v=99aa929b'

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
  // Restore UI from new session's persisted turn-state. Do NOT write global
  // `state.sendingInFlight` back onto `oldSess._sendingInFlight` — the session
  // flag is the source of truth (mutated by send/isFinal/safety-timer in
  // websocket.js), while the global is only a UI mirror of the current
  // session. A transient global=false (e.g. during ws reconnect, see
  // websocket.js:505) would otherwise clobber an A-session turn that is
  // still legitimately in-flight, suppressing the hello handshake's
  // inFlight=true signal and the server's synthetic isFinal.
  state.currentSessionId = id
  const newSess = getSession()
  state.sendingInFlight = newSess?._sendingInFlight || false
  _updateSendEnabled()
  // Hide first to clear old timer, then renderMessages wipes DOM, then show if needed
  _hideTypingIndicator()
  setTitleBusy(false)
  renderSidebar()
  _renderMessages()
  _renderAgentDropdown()
  // After DOM rebuild, show typing indicator + title busy for the new session if in-flight
  if (state.sendingInFlight) {
    _showTypingIndicator()
    setTitleBusy(true)
  }
  $('sidebar').classList.remove('open')
  $('sidebar-backdrop').classList.remove('open')
}

export async function deleteSession(id) {
  // If deleting the active session while it's in-flight, clear sending state to prevent wedged UI
  if (id === state.currentSessionId && state.sendingInFlight) {
    state.sendingInFlight = false
    _hideTypingIndicator()
    _updateSendEnabled()
    setTitleBusy(false)
  }
  // Capture in-flight save promise BEFORE canceling, so we can await it
  const inFlightSave = _saveInFlight.get(id)
  // Cancel all pending and in-flight saves to prevent resurrecting deleted session
  cancelSavesForSession(id)
  // Purge offline queue items for this session to prevent sending after delete
  if (state.offlineQueue?.length > 0) {
    state.offlineQueue = state.offlineQueue.filter(item => item.sessId !== id)
  }
  if (state._offlineQueuePending?.length > 0) {
    state._offlineQueuePending = state._offlineQueuePending.filter(item => item.sessId !== id)
  }
  if (state._offlineDrainingCurrent?.sessId === id) {
    state._offlineDrainingCurrent = null
    nudgeDrain()  // Advance drain to next item since we killed the current one
  }
  state.sessions.delete(id)
  // Wait for any in-flight save to finish before deleting from IDB,
  // so our dbDelete() is the final write and won't be overwritten by a late dbPut()
  if (inFlightSave) await inFlightSave.catch(() => {})
  try {
    await dbDelete(id)
  } catch {}
  deleteSessionFromServer(id)
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

// Two-phase save tracking:
// - _saveInFlight: resolves when the LOCAL dbPut finishes. deleteSession()
//   awaits this to guarantee its dbDelete() isn't clobbered by a late dbPut().
//   Must NOT include the network PUT, otherwise deleting a session while a
//   PUT is slow/hung would stall the delete flow for up to apiFetch's 30s timeout.
// - _chainTail: full _doSave promise (dbPut + server PUT). _enqueueSave chains
//   on this so the next _doSave starts only after the previous PUT's response
//   has updated sess._syncedAt, preventing the 409 storm during streaming.
const _saveInFlight = new Map() // sessId -> Promise<void> (resolves when dbPut settles)
const _chainTail = new Map()    // sessId -> Promise<void> (resolves when _doSave fully completes)
// Sessions that have been deleted — prevents in-flight saves from resurrecting them
const _deletedIds = new Set()

export function scheduleSave(s, immediate) {
  const sess = s || getSession()
  if (!sess) return
  sess.lastAt = Date.now()
  sess._dirty = true // mark as having unsaved local changes
  _rebuildSearchIndex(sess)
  const prev = _saveTimers.get(sess.id)
  if (prev) clearTimeout(prev)
  if (immediate) {
    _saveTimers.delete(sess.id)
    _enqueueSave(sess)
    return
  }
  const t = setTimeout(() => {
    _saveTimers.delete(sess.id)
    _enqueueSave(sess)
  }, 400)
  _saveTimers.set(sess.id, t)
}

/**
 * User-driven save wrapper: explicitly replenishes the dbPut retry budget
 * before scheduling the save. Use this from user-edit code paths (typing a
 * message, renaming, pin/unpin, deleting a message, switching agent, etc.)
 * so a session that previously exhausted SAVE_MAX_RETRIES can recover on
 * the next user action.
 *
 * Internal / automatic save callers (streaming frames, system greetings,
 * cross-device sync) must keep calling `scheduleSave` directly — those
 * paths fire at arbitrarily high rates and MUST NOT reset the retry budget,
 * otherwise a persistently failing session would loop forever.
 */
export function scheduleSaveFromUserEdit(s, immediate) {
  const sess = s || getSession()
  if (!sess) return
  _clearSaveRetry(sess.id)
  sess._conflictRetryCount = 0  // reset 409 local-dominates auto-retry cap
  scheduleSave(sess, immediate)
}

/**
 * Internal retry helper used by sync.js 409 handler when local-dominates
 * resolution preserves local messages. Unlike scheduleSave(), this:
 *   - Does NOT bump lastAt (retry is not a user edit — preserves sidebar
 *     "recent" ordering)
 *   - Does NOT reset the dbPut retry budget
 *   - Does NOT mark _dirty (caller has already done so)
 * It simply chains one fresh _doSave onto the existing _chainTail so the
 * next PUT carries the refreshed _baseSyncedAt pulled during the 409.
 */
export function enqueueSaveForRetry(sessId) {
  if (!sessId) return
  const sess = state.sessions.get(sessId)
  if (!sess || _deletedIds.has(sessId)) return
  _enqueueSave(sess)
}

function _enqueueSave(sess) {
  if (_deletedIds.has(sess.id)) return
  // Chain onto any in-flight save for this session to serialize both the
  // local dbPut AND the server PUT. Serializing the PUT is what prevents the
  // 409 storm: the next _doSave starts only after the prior PUT's response
  // has updated sess._syncedAt, so its own _baseSyncedAt is fresh.
  // Swallow rejections on the previous link so one failed save never
  // poisons the chain — otherwise every subsequent scheduleSave() for this
  // session would silently short-circuit.
  const prev = _chainTail.get(sess.id) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => _doSave(sess))
  _chainTail.set(sess.id, next)
  next.finally(() => {
    // Only clear if we're still the latest in the chain
    if (_chainTail.get(sess.id) === next) _chainTail.delete(sess.id)
  })
}

// Per-session dbPut retry state. A save that throws on the first attempt is
// rescheduled with exponential backoff up to SAVE_MAX_RETRIES total attempts;
// after that we surface a single toast and stop retrying that session. The
// budget is reset only on two legitimate re-entry paths:
//   - `scheduleSaveFromUserEdit()` — a fresh user action explicitly clears
//     retry state before scheduling the save.
//   - `_doSave()` success — a subsequent attempt finally persisted.
// Internal save paths (streaming frames, retry timers, flushPendingSaves,
// system-greeting additions) never reset the counter, so a persistently
// failing session can't loop infinitely.
const _saveRetryTimers = new Map()        // sessId -> timer handle
const _saveRetryCount = new Map()          // sessId -> attempt count
const _saveFatalReported = new Set()        // sessIds already toasted for quota
const SAVE_MAX_RETRIES = 3
const SAVE_RETRY_BASE_MS = 800

function _isQuotaError(e) {
  if (!e) return false
  const name = e.name || ''
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

function _scheduleSaveRetry(sess) {
  const id = sess.id
  if (_saveRetryTimers.has(id)) return  // already pending
  const attempt = (_saveRetryCount.get(id) || 0) + 1
  _saveRetryCount.set(id, attempt)
  if (attempt > SAVE_MAX_RETRIES) {
    if (!_saveFatalReported.has(id)) {
      _saveFatalReported.add(id)
      toast('会话持久化失败，请尝试刷新或清理浏览器存储')
    }
    return
  }
  const delay = SAVE_RETRY_BASE_MS * 2 ** (attempt - 1)
  const t = setTimeout(() => {
    _saveRetryTimers.delete(id)
    // Session may have been deleted or GC'd while waiting
    const live = state.sessions.get(id)
    if (!live || _deletedIds.has(id)) return
    _enqueueSave(live)
  }, delay)
  _saveRetryTimers.set(id, t)
}

function _clearSaveRetry(id) {
  const t = _saveRetryTimers.get(id)
  if (t) clearTimeout(t)
  _saveRetryTimers.delete(id)
  _saveRetryCount.delete(id)
  _saveFatalReported.delete(id)
}

async function _doSave(sess) {
  // Guard: don't write back if session was deleted between scheduling and execution
  if (!state.sessions.has(sess.id) || _deletedIds.has(sess.id)) return
  // Strip ephemeral runtime-only fields. Turn-state (_sendingInFlight,
  // _turnStartedAt, _lastFrameAt) is intentionally PRESERVED so a page
  // refresh can restore the in-flight UI and correctly signal inFlight=true
  // in the next hello frame. Staleness is handled at load time.
  const { _streamingAssistant, _streamingThinking, _blockIdToMsgId, _replyingToMsgId, _agentGroups, _streamRafPending, _thinkRafPending, _searchText, _regenSafetyTimer, _pendingCostCredits, _lastFinaledAssistantId, _lastFinaledAt, ...persist } = sess
  // Expose a dbPut-only checkpoint promise to deleteSession(). Registered
  // BEFORE awaiting dbPut so a concurrent deleteSession() synchronously sees
  // an in-flight local write and can await it before calling dbDelete().
  let resolveDbDone
  const dbDone = new Promise((r) => { resolveDbDone = r })
  _saveInFlight.set(sess.id, dbDone)
  let putError = null
  try {
    await dbPut(persist)
  } catch (e) {
    putError = e
    console.warn('dbPut', e)
  }
  resolveDbDone()
  if (_saveInFlight.get(sess.id) === dbDone) _saveInFlight.delete(sess.id)
  // Re-check after async dbPut: session may have been deleted while we were writing
  if (_deletedIds.has(sess.id)) {
    _clearSaveRetry(sess.id)
    return
  }
  if (putError) {
    if (_isQuotaError(putError)) {
      // Quota is a user-actionable condition — don't retry, surface once.
      if (!_saveFatalReported.has(sess.id)) {
        _saveFatalReported.add(sess.id)
        toast('浏览器存储已满，请清理旧会话后重试')
      }
      return
    }
    _scheduleSaveRetry(sess)
    return
  }
  // Success — clear retry bookkeeping for this session
  _clearSaveRetry(sess.id)
  // Sync to server for cross-device access (best-effort).
  //
  // MUST await: _enqueueSave chains on _chainTail so the next _doSave starts
  // only after this PUT completes. Without the await, PUTs run in parallel
  // against a stale `sess._syncedAt`, triggering a 409 storm during streaming.
  // deleteSession() no longer awaits this promise — it awaits _saveInFlight
  // (the dbPut-only checkpoint above) — so a slow PUT can't stall delete.
  // pushSessionToServer swallows its own errors, so awaiting can't reject.
  await pushSessionToServer(sess)
}

/**
 * Sync the global UI (typing indicator, title-busy marker, input enabled)
 * to the current session's persisted `_sendingInFlight`. Call whenever
 * `state.currentSessionId` may point at a session whose in-flight flag
 * was populated from IDB / server sync but the UI hasn't caught up.
 *
 * This mirrors the restore path in `switchSession()` (lines 60-69) and is
 * the single source of UI restoration used by main.js on initial boot and
 * after `syncSessionsFromServer()` resolves.
 */
export function restoreCurrentSessionInFlightUI() {
  const sess = getSession()
  const inFlight = !!sess?._sendingInFlight
  state.sendingInFlight = inFlight
  _updateSendEnabled?.()
  if (inFlight) {
    _showTypingIndicator?.()
    setTitleBusy(true)
  } else {
    _hideTypingIndicator?.()
    setTitleBusy(false)
  }
}

/**
 * Sanitize turn-state loaded from IndexedDB.
 *
 * A persisted `_sendingInFlight=true` is only trustworthy if the turn was
 * recently active. Otherwise it's a stale flag from a turn that was killed
 * by a browser crash / force-quit before the final frame arrived, and
 * restoring it would wedge the UI in a permanent typing state with no
 * corresponding server-side subprocess.
 *
 * Rule: if `_turnStartedAt` is older than STALE_TURN_THRESHOLD_MS (default
 * 10 min), clear the in-flight flag and related timing. Otherwise leave it
 * — the reconnect handshake + 30s safety timer will settle ownership.
 */
const STALE_TURN_THRESHOLD_MS = 10 * 60_000
export function sanitizeLoadedTurnState(sess) {
  if (!sess || !sess._sendingInFlight) return
  const startedAt = sess._turnStartedAt || 0
  const lastFrameAt = sess._lastFrameAt || 0
  const newest = Math.max(startedAt, lastFrameAt)
  if (!newest || Date.now() - newest > STALE_TURN_THRESHOLD_MS) {
    sess._sendingInFlight = false
    sess._turnStartedAt = null
    sess._lastFrameAt = null
  }
}

/**
 * Cancel all pending and in-flight saves for a deleted session.
 * Must be called from deleteSession() before dbDelete().
 */
export function cancelSavesForSession(id) {
  _deletedIds.add(id)
  _saveInFlight.delete(id)
  _chainTail.delete(id)
  const timer = _saveTimers.get(id)
  if (timer) { clearTimeout(timer); _saveTimers.delete(id) }
  // Also drop any outstanding retry bookkeeping for this session
  _clearSaveRetry(id)
}

/**
 * Check if a session has a pending delete tombstone.
 */
export function isDeletePending(id) {
  return _deletedIds.has(id)
}

/**
 * Clear delete tombstone for a session (e.g. when sync re-fetches it from server).
 */
export function clearDeleteTombstone(id) {
  _deletedIds.delete(id)
}

/**
 * Flush all pending debounced saves immediately.
 * Called on beforeunload/visibilitychange to prevent data loss on refresh.
 */
export function flushPendingSaves() {
  const flushed = new Set()
  // 1. Fire all pending debounced saves
  for (const [sessId, timer] of _saveTimers) {
    clearTimeout(timer)
    const sess = state.sessions.get(sessId)
    if (sess) { _enqueueSave(sess); flushed.add(sessId) }
  }
  _saveTimers.clear()
  // 2. Also save any dirty session not already covered above
  for (const [id, sess] of state.sessions) {
    if (sess._dirty && !flushed.has(id)) {
      _enqueueSave(sess)
    }
  }
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

  if (searchQuery && sessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'sessions-empty'
    empty.textContent = '没有匹配的会话'
    empty.style.cssText = 'padding:24px 16px;text-align:center;color:var(--fg-muted);font-size:13px'
    body.appendChild(empty)
    return
  }

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
  item.title = s.id
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
          scheduleSaveFromUserEdit(s)
          renderSidebar()
        },
      },
      { label: '导出 Markdown', run: () => exportSessionMd(s) },
      { label: '导出 Word (.docx)', run: () => exportSessionDocx(s) },
      { label: '导出 LaTeX (.tex)', run: () => exportSessionTex(s) },
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
            scheduleSaveFromUserEdit(s)
            renderSidebar()
          },
        },
        { label: '导出 Markdown', run: () => exportSessionMd(s) },
        { label: '导出 Word (.docx)', run: () => exportSessionDocx(s) },
        { label: '导出 LaTeX (.tex)', run: () => exportSessionTex(s) },
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
      scheduleSaveFromUserEdit(sess)
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
