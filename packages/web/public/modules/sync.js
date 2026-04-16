// OpenClaude — Cross-device session sync
// Syncs frontend sessions (IndexedDB) with server-side storage (SQLite).
// Server is source of truth for session list; local IDB is cache + offline fallback.

import { apiFetch, apiGet, apiJson, authHeaders } from './api.js'
import { dbGetAll, dbPut, dbDelete } from './db.js'
import { _rebuildSearchIndex, clearDeleteTombstone, isDeletePending } from './sessions.js'
import { state } from './state.js'

// Dep-injected callback: fired when a push hits a 409 conflict and we pull
// the server version in place of the local one. The UI layer should
// re-render both the messages (if the affected session is current) and
// the sidebar (title/lastAt may have changed on the server).
let _onConflictResolved = null
export function setSyncDeps({ onConflictResolved }) {
  _onConflictResolved = onConflictResolved
}

/**
 * Pull session list from server, merge with local IndexedDB.
 * Server wins on conflict (newer updatedAt / lastAt).
 */
export async function syncSessionsFromServer() {
  // Retry any pending deletes from previous failures
  for (const id of _pendingDeletes) {
    try {
      await apiJson('DELETE', `/api/sessions/${id}`)
      _pendingDeletes.delete(id)
    } catch {}
  }

  let serverList
  try {
    const resp = await apiGet('/api/sessions/list')
    serverList = resp.sessions || []
  } catch {
    // Offline or auth error — fall back to local only
    return
  }

  // Load local sessions
  let localSessions
  try {
    localSessions = await dbGetAll()
  } catch {
    localSessions = []
  }
  const localMap = new Map()
  for (const s of localSessions) localMap.set(s.id, s)

  const serverIds = new Set(serverList.map((s) => s.id))

  // Find sessions on server but not locally, or newer on server
  const toFetch = []
  for (const meta of serverList) {
    const local = localMap.get(meta.id)
    if (!local) {
      toFetch.push(meta.id)
    } else if (local._syncedAt && meta.updatedAt > local._syncedAt) {
      // Server has a newer version than our last sync point (server clock only)
      if (meta.id === state.currentSessionId && state.sendingInFlight) continue
      toFetch.push(meta.id)
    }
  }

  // Fetch missing/newer sessions from server (batch, max 10 concurrent)
  const fetched = []
  for (let i = 0; i < toFetch.length; i += 10) {
    const batch = toFetch.slice(i, i + 10)
    const results = await Promise.allSettled(
      batch.map((id) => apiGet(`/api/sessions/${id}`))
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.id) fetched.push(r.value)
    }
  }

  // Merge fetched sessions into local state + IDB (skip dirty local sessions)
  let currentSessionUpdated = false
  for (const remote of fetched) {
    if (isDeletePending(remote.id)) continue // locally deleted, pending server confirmation
    const existingLocal = state.sessions.get(remote.id)
    if (existingLocal?._dirty) continue // local has unsynced edits, don't overwrite
    const sess = {
      id: remote.id,
      title: remote.title,
      createdAt: remote.createdAt,
      lastAt: remote.lastAt,
      messages: remote.messages || [],
      agentId: remote.agentId || 'main',
      pinned: remote.pinned || false,
      _syncedAt: remote.updatedAt,
    }
    // Preserve local turn-state across the server-merge — the server
    // deliberately strips _sendingInFlight / _turnStartedAt / _lastFrameAt
    // on push (see pushSessionToServer strip list below), so a naive replace
    // would wipe out the in-flight marker for a non-current session the
    // user has mid-turn. Keeping these locally-owned fields lets the hello
    // handshake keep reporting inFlight=true and lets sanitizeLoadedTurnState
    // continue to govern staleness.
    if (existingLocal?._sendingInFlight) sess._sendingInFlight = true
    if (existingLocal?._turnStartedAt) sess._turnStartedAt = existingLocal._turnStartedAt
    if (existingLocal?._lastFrameAt) sess._lastFrameAt = existingLocal._lastFrameAt
    _rebuildSearchIndex(sess)
    clearDeleteTombstone(sess.id) // Allow saving if session was previously deleted locally
    state.sessions.set(sess.id, sess)
    if (sess.id === state.currentSessionId) currentSessionUpdated = true
    try { await dbPut({ ...sess, _syncedAt: remote.updatedAt }) } catch {}
  }

  // Remove locally-synced sessions that were deleted on server
  // Check LIVE state (not stale localMap snapshot) for dirty flag
  let removedCurrent = false
  for (const [id, local] of localMap) {
    if (!serverIds.has(id) && local._syncedAt) {
      const live = state.sessions.get(id)
      if (live?._dirty || live?._sendingInFlight) {
        pushSessionToServer(live).catch(() => {})
        continue
      }
      if (id === state.currentSessionId) removedCurrent = true
      state.sessions.delete(id)
      try { await dbDelete(id) } catch {}
    }
  }
  // If the active session was deleted remotely, switch to another
  if (removedCurrent) {
    const remaining = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
    state.currentSessionId = remaining[0]?.id || null
  }

  // Push local-only sessions to server (created offline, never synced).
  for (const [id, local] of localMap) {
    if (!serverIds.has(id) && local.messages?.length > 0 && !local._syncedAt) {
      pushSessionToServer(local).catch(() => {})
    }
  }

  // Clean up tombstones for sessions confirmed deleted on server
  // (serverIds doesn't contain them → delete was successful → tombstone no longer needed)
  for (const id of [...localMap.keys()]) {
    if (!serverIds.has(id) && isDeletePending(id)) clearDeleteTombstone(id)
  }

  return { needsRenderMessages: currentSessionUpdated || removedCurrent }
}

/**
 * Push a single session to server (best-effort). Marks _syncedAt on success.
 */
export function pushSessionToServer(sess) {
  if (!sess?.id || !state.token) return Promise.resolve()
  const { _streamingAssistant, _streamingThinking, _blockIdToMsgId, _sendingInFlight, _replyingToMsgId, _agentGroups, _streamRafPending, _thinkRafPending, _searchText, _syncedAt, _dirty, ...clean } = sess
  // Include baseSyncedAt for optimistic concurrency — server rejects if row is newer
  clean._baseSyncedAt = _syncedAt || 0
  const preFlightLastAt = sess.lastAt // snapshot BEFORE PUT for 409 conflict detection
  return apiFetch(`/api/sessions/${sess.id}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(clean),
  }).then(async (res) => {
    if (res.ok) {
      const resp = await res.json()
      if (resp?.applied && resp.updatedAt) {
        sess._syncedAt = resp.updatedAt
        sess._dirty = false
      }
    } else if (res.status === 409) {
      // Conflict: server has a newer version — pull it unless user made more local edits
      try {
        const server = await apiGet(`/api/sessions/${sess.id}`)
        if (server?.id) {
          // Re-check: if user edited while the PUT was in flight, keep local
          // preFlightLastAt was captured before PUT — any lastAt change means new edits
          const live = state.sessions.get(sess.id)
          if (live?._dirty && live.lastAt > preFlightLastAt) return // new edits since PUT started
          Object.assign(sess, {
            title: server.title, messages: server.messages || [],
            lastAt: server.lastAt, pinned: server.pinned, agentId: server.agentId,
            _syncedAt: server.updatedAt, _dirty: false,
          })
          // Invalidate runtime maps so they get rebuilt from new messages on next handleOutbound
          sess._blockIdToMsgId = null
          sess._agentGroups = null
          _rebuildSearchIndex(sess)
          try { await dbPut({ ...sess, _syncedAt: server.updatedAt }) } catch {}
          // Notify the UI layer so the user actually sees the new messages /
          // title instead of a stale view. Without this callback the session
          // object is updated but the DOM stays on the old snapshot until a
          // full sync fires (which could be minutes away).
          try { _onConflictResolved?.(sess.id) } catch {}
        }
      } catch {}
    }
  }).catch(() => {})
}

/**
 * Delete a session from server (fire-and-forget).
 */
export function deleteSessionFromServer(id) {
  if (!id || !state.token) return Promise.resolve()
  return apiJson('DELETE', `/api/sessions/${id}`).catch(() => {
    // Queue for retry on next sync
    _pendingDeletes.add(id)
    // Also retry once after 2s
    setTimeout(() => {
      apiJson('DELETE', `/api/sessions/${id}`).then(() => _pendingDeletes.delete(id)).catch(() => {})
    }, 2000)
  })
}

// Pending deletes that failed — retried on next syncSessionsFromServer()
const _pendingDeletes = new Set()
