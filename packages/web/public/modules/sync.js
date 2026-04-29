// OpenClaude — Cross-device session sync
// Syncs frontend sessions (IndexedDB) with server-side storage (SQLite).
// Server is source of truth for session list; local IDB is cache + offline fallback.

import { apiFetch, apiGet, apiJson, authHeaders } from './api.js?v=24725e3'
import { dbGetAll, dbPut, dbDelete } from './db.js?v=24725e3'
import { _rebuildSearchIndex, clearDeleteTombstone, isDeletePending } from './sessions.js?v=24725e3'
import { state } from './state.js?v=24725e3'

// Dep-injected callback: fired when a push hits a 409 conflict and we
// resolve it (either by taking server state, or by detecting local-dominates
// and keeping local). The UI layer should re-render messages (if the
// session is current) and the sidebar (title/lastAt may have changed).
let _onConflictResolved = null
// Dep-injected: after local-dominates resolution, enqueue one retry PUT
// carrying the refreshed _baseSyncedAt. Must NOT go through scheduleSave()
// because that would bump lastAt (polluting sidebar order) and reset the
// dbPut retry budget — retry is not a user edit.
let _onRequestRetryPush = null
let _onSyncStatusChange = null
export function setSyncDeps({ onConflictResolved, onRequestRetryPush, onSyncStatusChange }) {
  _onConflictResolved = onConflictResolved
  _onRequestRetryPush = onRequestRetryPush
  _onSyncStatusChange = onSyncStatusChange
}

function _emitSyncStatus(status) {
  try {
    _onSyncStatusChange?.({ ...status, ts: Date.now() })
  } catch {}
}

// Per-session cap for 409 local-dominates auto-retries. Prevents infinite
// serial spin if server persistently returns 409 without real contention
// (schema mismatch, auth drift, server bug). Cleared on any successful PUT,
// on server-wins adopt, and on any scheduleSaveFromUserEdit — user action
// is ground truth.
//
// Why 10 (not 3): on long streaming sessions (>500KB messages), a single
// turn can legitimately trigger several 409s in the brief window after
// `_sendingInFlight` flips false and the queued save batch drains against
// cross-device updated_at drift. Each legitimate local-dominates resolution
// advances _syncedAt, so a handful of retries is normal — capping at 3
// bounced real saves into "leaving dirty" and the warning spammed console.
const CONFLICT_RETRY_MAX = 10

/**
 * Stable JSON serialization with sorted keys — used to compare two
 * message snapshots by value independent of key insertion order.
 * Must never throw: returns null on cycles or unserializable values
 * (neither is expected for plain message objects, but we don't want
 * a malformed row to crash the 409 handler).
 */
function _stableStringify(v) {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const keys = Object.keys(val).sort()
        const sorted = {}
        for (const k of keys) sorted[k] = val[k]
        return sorted
      }
      return val
    })
  } catch {
    return null
  }
}

/**
 * Conservative "local is at least as current as server" judge for a
 * same-id message pair. Used to detect whether pushing local with a
 * refreshed _baseSyncedAt would lose any server-only data.
 *
 * Two-layer logic:
 *
 *   Layer 1 (CHEAP EQUALITY, applies to all roles):
 *     If both sides serialize to the same value (key-order-independent),
 *     local is trivially non-inferior to server — pass. This is what
 *     unlocks the common "conversation has old tool/agent-group messages
 *     in the shared prefix, only the tail assistant is streaming" case.
 *     Without this, a single historical tool row would force server-wins
 *     and drop the streaming extension (the primary bug).
 *
 *   Layer 2 (STREAMING EXTENSION, roles whitelist):
 *     For assistant/thinking/user only, apply a text-level check:
 *       - assistant/thinking: server.text is a prefix of local.text
 *         (streaming delta — unambiguous "local = server + more")
 *       - user: exact text equality (status drift tolerated, see below)
 *     Rows with childBlocks are excluded from Layer 2: their in-place
 *     mutations (_partial/_completed/output) can't be judged by text
 *     alone, and if Layer 1 already failed they aren't equal anyway,
 *     so server-wins is the safe fallback.
 *
 * ACCEPTED DIVERGENCE (documented, not guarded by Layer 2):
 *   - user.status ('sending'→'sent'→'read'): client-managed UI flag.
 *     When local-dominates fires we're about to re-push local anyway,
 *     so server's status will be reset to ours on the follow-up PUT.
 *   - assistant.metaText / completedAt: client-derived; may differ
 *     between devices streaming the same turn.
 */
export function _localMessageSupersedes(localMsg, serverMsg) {
  if (!localMsg || !serverMsg) return false
  if (localMsg === serverMsg) return true
  const role = localMsg.role
  // role must match on both sides (guards against malformed / cross-role data)
  if (role !== serverMsg.role) return false

  // Layer 1: stable deep equality — if both sides marshal to the same
  // string, local is (at minimum) a non-regression of server.
  const ls = _stableStringify(localMsg)
  const ss = _stableStringify(serverMsg)
  if (ls !== null && ss !== null && ls === ss) return true

  // Layer 2: text-level judgement, roles whitelist only.
  if (role !== 'assistant' && role !== 'thinking' && role !== 'user') return false
  // Any childBlocks on either side → structural, refuse text-level judgement.
  if (Array.isArray(localMsg.childBlocks) || Array.isArray(serverMsg.childBlocks)) return false
  const lText = typeof localMsg.text === 'string' ? localMsg.text : ''
  const sText = typeof serverMsg.text === 'string' ? serverMsg.text : ''
  if (role === 'user') return lText === sText
  // assistant / thinking — streaming prefix extension
  if (sText.length === 0) return true
  if (lText.length < sText.length) return false
  return lText.startsWith(sText)
}

/**
 * Whether local is a clean superset of server:
 *   - local.length >= server.length, AND
 *   - for every index i in [0, server.length), local[i] and server[i]
 *     share the same id AND local supersedes server per
 *     _localMessageSupersedes (above).
 *
 * If true, pushing local with a refreshed _baseSyncedAt is guaranteed
 * not to lose any server-only data (because there is none). If false,
 * caller falls back to server-wins to avoid synthesizing bogus state.
 */
export function _localDominates(serverMessages, localMessages) {
  const server = Array.isArray(serverMessages) ? serverMessages : []
  const local = Array.isArray(localMessages) ? localMessages : []
  if (local.length < server.length) return false
  for (let i = 0; i < server.length; i++) {
    const s = server[i]
    const l = local[i]
    if (!s?.id || s.id !== l?.id) return false
    if (!_localMessageSupersedes(l, s)) return false
  }
  return true
}

/**
 * After sess.messages is replaced (server-wins 409 resolution), streaming
 * pointers may reference orphan message objects that no longer appear in
 * the array. Rebind each by id, or clear so the next WS frame recreates
 * via the existing `if (!sess._streamingAssistant) addMessage()` guard.
 * Without this, subsequent deltas mutate a detached object and
 * updateMessageEl silently no-ops, leaving the UI stuck.
 */
function _rebindStreamingPointers(sess) {
  const byId = new Map()
  for (const m of sess.messages || []) if (m?.id) byId.set(m.id, m)
  if (sess._streamingAssistant) {
    sess._streamingAssistant = byId.get(sess._streamingAssistant.id) || null
  }
  if (sess._streamingThinking) {
    sess._streamingThinking = byId.get(sess._streamingThinking.id) || null
  }
  if (sess._replyingToMsgId && !byId.has(sess._replyingToMsgId)) {
    sess._replyingToMsgId = null
    sess._currentTurnBlockCount = 0  // hygiene: old turn's counter is stale
  }
}

/**
 * Pull session list from server, merge with local IndexedDB.
 * Server wins on conflict (newer updatedAt / lastAt).
 */
export async function syncSessionsFromServer() {
  // Delay the "syncing" banner by 400ms — fast pulls (most background
  // visibilitychange/focus/WS-reconnect triggers) finish well under that
  // and never flash the banner. Only slow/first-time syncs actually show
  // the indicator, which is when feedback is useful.
  let _syncingBannerShown = false
  const _syncingDelay = setTimeout(() => {
    _syncingBannerShown = true
    _emitSyncStatus({
      state: 'syncing',
      label: '正在同步多端会话',
      detail: '从服务器拉取最新会话，稍等片刻',
    })
  }, 400)
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
    clearTimeout(_syncingDelay)
    _emitSyncStatus({
      state: 'error',
      label: '同步失败',
      detail: '当前显示本地缓存，联网后会自动重试',
    })
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
    const live = state.sessions.get(meta.id)
    if (!local) {
      toFetch.push(meta.id)
    } else if (live?._liveStreamBroken) {
      // Phase 0.4 P1-1: force-fetch any session whose live stream is flagged
      // known-broken, REGARDLESS of server `updatedAt`. Two cases the normal
      // `updatedAt > _syncedAt` gate would miss:
      //   1. Server restart (resume_failed.to=0): the on-disk tape hasn't
      //      necessarily grown since our last sync, so `updatedAt` can be
      //      unchanged. Without a fetch the merge never runs, the merged
      //      `sess` object is never persisted, and the synchronously-
      //      advanced `_lastFrameSeq` (websocket.js handleResumeFailed)
      //      stays only in memory for THIS tab — reload resurrects the
      //      stale cursor and loops on the next reconnect.
      //   2. `_liveStreamBroken` itself must be cleaned out of IDB. It's
      //      written by the synchronous `dbPut` in handleResumeFailed as
      //      a belt for case 1; if the sync never rewrites the session,
      //      that flag persists to a future boot, where it would bypass
      //      the in-flight skip guard for unrelated syncs.
      // Force-fetch guarantees both concerns are resolved by the normal
      // merge path at sync.js:~260 (which builds `sess` WITHOUT
      // `_liveStreamBroken`, carries forward `_lastFrameSeq` via existingLocal,
      // and dbPuts the clean version).
      toFetch.push(meta.id)
    } else if (local._syncedAt && meta.updatedAt > local._syncedAt) {
      // Server has a newer version than our last sync point (server clock only).
      // Normal in-flight guard still applies here — only the resume_failed
      // flag unconditionally forces a fetch (branch above).
      if (
        meta.id === state.currentSessionId &&
        state.sendingInFlight
      ) continue
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
  let fetchedCount = 0
  for (const remote of fetched) {
    if (isDeletePending(remote.id)) continue // locally deleted, pending server confirmation
    const existingLocal = state.sessions.get(remote.id)
    // Normally we skip overwriting a locally-dirty session to avoid stomping
    // unsynced user edits. The exception is `_liveStreamBroken`: Phase 0.4
    // resume_failed flagged this session's live stream as known-bad and the
    // whole point of the force-sync is to reconcile against the server-
    // authored tape. Skipping here would silently strand the client on stale
    // state and the `onResult` clear in handleResumeFailed would then lie
    // about the recovery having succeeded.
    //
    // BUT: we can't just blindly overwrite. A just-sent user message may be
    // sitting in existingLocal.messages with status='sending'/'queued'/'sent'/
    // 'read', waiting for scheduleSave (~400ms debounce) to push it to server.
    // If the resume_failed REST sync wins the race, that message is gone from
    // state.sessions and the 409 conflict handler at line ~363 below will
    // see the REST-replaced live object without it. Preserve local-only
    // pending-send user rows before the overwrite, and keep _dirty so they
    // get pushed on the next scheduleSave cycle.
    //
    // Predicate rationale:
    //   - role === 'user': only user rows are client-authored; assistant /
    //     thinking / tool results are server-authored via Phase 0.1 and their
    //     authoritative state lives on the server. Don't resurrect local
    //     partials.
    //   - status ∈ {'sending','queued','sent','read'}: narrows to rows that
    //     explicitly haven't completed their server roundtrip. 'sent' is set
    //     after ws.send but BEFORE server ACK/persist; 'read' is set when the
    //     assistant's first block arrives (websocket.js:~1094), often BEFORE
    //     the debounced PUT of the user msg has landed. Missing status falls
    //     through to server-wins (rare legacy rows only).
    //   - !serverIds.has(id): server doesn't yet know about this row.
    //
    // Ordering: we MUST preserve local message ordering. In the resume_failed-
    // during-streaming case, local has [..., userMsg, assistantMsg] where
    // assistantMsg is server-authored (Phase 0.1) so REST already holds it.
    // Naive "append preserved to tail" would place userMsg AFTER assistantMsg
    // on the rebuilt timeline, breaking causality. Instead we rebuild
    // messages by walking local's ordering: for each local row, use server's
    // version if id matches (authoritative), else preserve if it's a pending
    // user, else drop (cross-device delete / branch). Then append any
    // server-only rows at the end (cross-device additions).
    const PENDING_SEND_STATUSES = new Set(['sending', 'queued', 'sent', 'read'])
    let mergedMessages = null
    let hasPreservedPending = false
    if (existingLocal?._liveStreamBroken && existingLocal?._dirty) {
      const serverById = new Map()
      for (const m of remote.messages || []) if (m?.id) serverById.set(m.id, m)
      const usedServerIds = new Set()
      const out = []
      for (const local of existingLocal.messages || []) {
        if (!local?.id) continue
        const server = serverById.get(local.id)
        if (server) {
          out.push(server)
          usedServerIds.add(local.id)
        } else if (local.role === 'user' && PENDING_SEND_STATUSES.has(local.status)) {
          out.push(local)
          hasPreservedPending = true
        }
        // else: drop — local-only non-pending row, assume cross-device
        // delete/branch authored on another tab. The whole point of
        // force-sync is to honor that.
      }
      // Cross-device additions: server rows not seen in local ordering.
      for (const s of remote.messages || []) {
        if (s?.id && !usedServerIds.has(s.id)) out.push(s)
      }
      mergedMessages = out
    } else if (existingLocal?._dirty && !existingLocal?._liveStreamBroken) {
      continue
    }
    const sess = {
      id: remote.id,
      title: remote.title,
      createdAt: remote.createdAt,
      lastAt: remote.lastAt,
      messages: mergedMessages || remote.messages || [],
      agentId: remote.agentId || 'main',
      pinned: remote.pinned || false,
      _syncedAt: remote.updatedAt,
    }
    if (hasPreservedPending) {
      // Preserved user msgs aren't on server yet; keep _dirty so the next
      // scheduleSave cycle re-pushes. _syncedAt = remote.updatedAt so the
      // next PUT carries the correct _baseSyncedAt (avoiding an immediate
      // 409 loop).
      sess._dirty = true
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
    // Phase 0.4: preserve the frameSeq cursor across a sync-driven session
    // replacement. If we drop it, the next hello would claim `lastFrameSeq: 0`
    // and the gateway would replay every frame still in its ring — delivering
    // the same assistant deltas a second time to handleOutbound, which
    // dedupes by frameSeq; with the cursor reset those deltas look like
    // "new" frames and would be appended again. Keep the cursor aligned to
    // whatever we had last processed so dedupe stays authoritative.
    if (typeof existingLocal?._lastFrameSeq === 'number') sess._lastFrameSeq = existingLocal._lastFrameSeq
    _rebuildSearchIndex(sess)
    clearDeleteTombstone(sess.id) // Allow saving if session was previously deleted locally
    state.sessions.set(sess.id, sess)
    fetchedCount++
    if (sess.id === state.currentSessionId) currentSessionUpdated = true
    try { await dbPut({ ...sess, _syncedAt: remote.updatedAt }) } catch {}
  }

  // Remove locally-synced sessions that were deleted on server
  // Check LIVE state (not stale localMap snapshot) for dirty flag
  let removedCurrent = false
  let removedCount = 0
  for (const [id, local] of localMap) {
    if (!serverIds.has(id) && local._syncedAt) {
      const live = state.sessions.get(id)
      if (live?._dirty || live?._sendingInFlight) {
        pushSessionToServer(live).catch(() => {})
        continue
      }
      if (id === state.currentSessionId) removedCurrent = true
      state.sessions.delete(id)
      removedCount++
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

  const changedCount = fetchedCount + removedCount
  clearTimeout(_syncingDelay)
  if (changedCount > 0) {
    // Meaningful update — tell the user what changed. Worth the 1.8s toast.
    _emitSyncStatus({
      state: 'synced',
      label: '同步完成',
      detail: `已更新 ${changedCount} 个会话`,
    })
  } else if (_syncingBannerShown) {
    // Banner is already visible (slow sync) — dismiss it quietly without
    // a "已同步 / 多端会话已是最新" toast, which is noise during active chat.
    _emitSyncStatus({ state: 'idle', label: '', detail: '' })
  }
  // else: fast no-change sync — banner never appeared, nothing to emit.
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
        sess._conflictRetryCount = 0  // successful PUT clears 409 retry cap
      }
    } else if (res.status === 409) {
      // Conflict: server has a newer version. Two resolution paths:
      //   (a) local-dominates: local messages form a clean superset of
      //       server. Keep local, refresh _syncedAt, trigger one retry
      //       PUT. The primary fix case (long streaming assistant msg
      //       with same id as server's partial snapshot).
      //   (b) server-wins fallback: something on server is genuinely not
      //       in local (cross-device add, remote delete/regen, truly
      //       diverged content). Adopt server state and rebind streaming
      //       pointers so subsequent WS frames don't mutate orphan objects.
      try {
        const server = await apiGet(`/api/sessions/${sess.id}`)
        if (!server?.id) return
        // `sess` may be a detached dbGetAll snapshot (see
        // syncSessionsFromServer → pushSessionToServer(local) at line ~276).
        // The authoritative in-memory object is state.sessions.get(id).
        // Mutating sess would leave the live session stale, causing the
        // next scheduleSave to re-push with the old _baseSyncedAt and
        // loop 409 → cap. Always target `live`.
        const live = state.sessions.get(sess.id)
        if (!live) return
        const target = live

        if (_localDominates(server.messages, live.messages)) {
          // (a) LOCAL DOMINATES — keep local messages, adopt server metadata.
          //
          // Messages: local is a clean superset, so we retain it (the
          // primary bug: streaming assistant prefix extension gets dropped
          // if we overwrite).
          //
          // Metadata (title/pinned/agentId/lastAt): we ADOPT server's
          // values. Another tab may have renamed the session, pinned it,
          // or switched its agent while we were streaming; those edits
          // went through their own scheduleSaveFromUserEdit → PUT and we
          // mustn't clobber them by blindly re-pushing stale local meta.
          //
          // If the user was simultaneously editing metadata locally,
          // scheduleSaveFromUserEdit has bumped live.lastAt since
          // preFlightLastAt — we detect that below and keep local meta.
          target._syncedAt = server.updatedAt

          // Metadata merge: server-wins UNLESS a local user edit beat the
          // preflight snapshot (which would have set live.lastAt > preFlightLastAt).
          // In that case user intent on this tab is authoritative.
          const localMetaIsNewer = live._dirty && live.lastAt > preFlightLastAt
          let titleChanged = false
          if (!localMetaIsNewer) {
            titleChanged = target.title !== server.title
            target.title = server.title
            target.pinned = server.pinned
            target.agentId = server.agentId
            target.lastAt = server.lastAt
          }
          target._dirty = true  // need a follow-up PUT to push our messages

          const prev = target._conflictRetryCount || 0
          target._conflictRetryCount = prev + 1

          // Rebuild search index if title shifted — _searchText cache
          // preferred by sidebar filter would otherwise still match old title.
          if (titleChanged) _rebuildSearchIndex(target)

          try { await dbPut({ ...target }) } catch {}
          // Pass 'local-dominates' so the UI can skip renderMessages() — local
          // messages are preserved in this branch, only sidebar metadata may
          // have shifted. Without this tag, every 409 in a long streaming
          // session redrew the whole messages pane (innerHTML='' + 100-row
          // rebuild) and the user saw a flicker per 409.
          try { _onConflictResolved?.(target.id, 'local-dominates') } catch {}

          if (target._conflictRetryCount <= CONFLICT_RETRY_MAX && _onRequestRetryPush) {
            try { _onRequestRetryPush(target.id) } catch {}
          } else {
            console.warn(
              '[sync] 409 auto-retry cap reached for', target.id,
              '— leaving dirty; next user action or save-cycle will retry',
            )
          }
          return
        }

        // (b) SERVER WINS — adopt server state.
        // Retain original guard: if user typed while PUT was in flight,
        // keep local (the new edits push on the next save tick). strict
        // `>` is intentional here because we already know local is NOT
        // a superset of server, so equal lastAt means no new user edit
        // and server really has data we don't.
        if (live._dirty && live.lastAt > preFlightLastAt) return

        Object.assign(target, {
          title: server.title,
          messages: server.messages || [],
          lastAt: server.lastAt,
          pinned: server.pinned,
          agentId: server.agentId,
          _syncedAt: server.updatedAt,
          _dirty: false,
        })
        // Invalidate runtime maps so they get rebuilt from new messages on next handleOutbound
        target._blockIdToMsgId = null
        target._agentGroups = null
        target._conflictRetryCount = 0  // server-wins adoption resets the cap
        _rebindStreamingPointers(target)
        _rebuildSearchIndex(target)
        try { await dbPut({ ...target, _syncedAt: server.updatedAt }) } catch {}
        // Notify UI so the user sees the new messages / title instead of
        // a stale view. Without this, the session object is updated but
        // the DOM stays on the old snapshot until the next full sync.
        // 'server-wins' tag tells the UI to fully re-render messages because
        // sess.messages was just overwritten.
        try { _onConflictResolved?.(target.id, 'server-wins') } catch {}
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

/**
 * Throttled wrapper for syncSessionsFromServer().
 *
 * Called from event triggers that can fire rapidly (visibilitychange fires
 * twice on each mobile foreground/background cycle, `focus` flaps with
 * dev-tools inspect, `online` can fire in bursts on flaky networks). Without
 * throttling, every trigger would re-hit `/api/sessions/list` + possibly
 * fan out to N `/api/sessions/:id` GETs.
 *
 * Behaviour:
 * - If a sync is already in flight, the returned promise is reused so
 *   concurrent triggers coalesce onto a single network round-trip.
 * - Otherwise, if the last *successful* sync was within `minIntervalMs`,
 *   skip and resolve as a no-op — unless `force: true` is passed (used by
 *   `online` recovery where we really want a fresh pull).
 * - Only a successful pull (syncSessionsFromServer returns a non-undefined
 *   result) advances `_lastSyncAt`. A failed list-fetch returns `undefined`
 *   (see `catch { return }` above); treating that as "synced" would let the
 *   throttle window swallow every real retry for the next 15s — exactly
 *   what a user hitting a transient offline blip hits on foreground resume.
 * - `onResult(result)` is invoked on non-skipped completion. It is NOT
 *   wrapped in try/catch: UI/DOM errors must propagate so the module-level
 *   `unhandledrejection` handler in main.js can surface them rather than
 *   silently leaving the page stale after a hidden render failure.
 *
 * Accepted edge cases:
 * - `force: true` does not upgrade a sync already in flight; an `online`
 *   event arriving mid-request will coalesce with the running request
 *   instead of scheduling a tail pull. Acceptable because the running
 *   request either already predates the network flap (fine, fresh result)
 *   or is about to fail (fine, the next visibilitychange/focus will retry
 *   without being throttled since _lastSyncAt stays at its old value).
 * - `_lastSyncAt` is updated BEFORE `onResult` runs, so "sync succeeded on
 *   the wire but UI render threw" still counts against the throttle window.
 *   Acceptable because such a throw reaches the global unhandledrejection
 *   handler, making it visible; the user hits reload and the next boot
 *   sync re-applies the latest server state.
 */
let _syncInFlight = null
let _lastSyncAt = 0
/**
 * Callbacks registered while a sync was already in flight. Each entry is
 * `{ onResult, fresh }`:
 *   - `fresh: false` — piggyback on the running sync's result (default).
 *   - `fresh: true`  — caller needs a **post-`_liveStreamBroken`** sync;
 *     schedule a tail sync after the running one finishes so the new
 *     `_liveStreamBroken` flag is respected during that second pass.
 *
 * Without this list a `resume_failed` arriving mid-sync would lose its
 * renderer + flag-clear callback and stall recovery until the next throttled
 * `visibilitychange`. The `fresh` flag guards against a subtler race: the
 * running sync may have already iterated past the affected session BEFORE
 * `_liveStreamBroken` was set on it, so simply attaching our callback to
 * the running promise is not enough — we need a second pass.
 */
let _pendingOnResultCallbacks = []
let _tailSyncScheduled = false
/**
 * `force: true` + in-flight sync:
 *   - `freshAfterInFlight: false` (default) → piggyback for backward compat
 *   - `freshAfterInFlight: true`            → schedule a tail sync once the
 *     running sync settles so caller observes state stamped after their call.
 */
export function maybeSyncNow({ force = false, minIntervalMs = 15000, onResult, freshAfterInFlight = false } = {}) {
  // 2026-04-21 安全审计 Medium#F1:当 tab 不可见时跳过所有非首屏 sync。
  //   - `online` 事件在手机后台重拾信号时仍会触发,会让隐藏 tab 在无人看的
  //     情况下跑完整 /sessions/list + N×GET /sessions/:id 轮询,空耗带宽 & CPU
  //   - 多 tab 场景下,后台 tab 的 IDB 写会与前台 tab 的写竞争,历史上这里跑
  //     过 dbPut 丢 message 的 race
  //   - 首屏启动场景里 force=true 通常是必须跑的(init() 不会把 force 往里塞,
  //     只有 online / websocket 恢复会),所以 hidden 时跳 force 也安全;真正
  //     需要 sync 的话下一次 visibilitychange 会再触一次(已见 main.js:288)
  // 例外:`typeof document === 'undefined'` 的测试/SSR 环境不经过这个分支。
  if (typeof document !== 'undefined' && document.hidden) {
    return Promise.resolve(null)
  }
  if (_syncInFlight) {
    if (onResult || (force && freshAfterInFlight)) {
      _pendingOnResultCallbacks.push({
        onResult: onResult ?? null,
        fresh: !!(force && freshAfterInFlight),
      })
    }
    // If any queued caller requested a fresh pass, schedule the tail sync
    // exactly once; it runs after the current sync's `.finally` clears
    // `_syncInFlight`, so it re-observes whatever session-level flags were
    // mutated during this window (notably `_liveStreamBroken`).
    if (force && freshAfterInFlight && !_tailSyncScheduled) {
      _tailSyncScheduled = true
      _syncInFlight
        .catch(() => undefined)
        .finally(() => {
          _tailSyncScheduled = false
          // Recursive call: `_syncInFlight` is null in the finally callback
          // body, so this kicks off a fresh pass. `force:true` bypasses the
          // throttle; we preserve `onResult` for the callers that asked for
          // a post-mutation render.
          try { maybeSyncNow({ force: true }) } catch {}
        })
    }
    return _syncInFlight
  }
  if (!force && Date.now() - _lastSyncAt < minIntervalMs) return Promise.resolve(null)
  if (onResult) _pendingOnResultCallbacks.push({ onResult, fresh: false })
  _syncInFlight = syncSessionsFromServer()
    // Defensive: syncSessionsFromServer catches its own network errors and
    // returns `undefined`, but we still guard against an unexpected throw
    // so the in-flight slot below always clears.
    .catch(() => undefined)
    .then((result) => {
      if (result !== undefined) _lastSyncAt = Date.now()
      const callbacks = _pendingOnResultCallbacks
      _pendingOnResultCallbacks = []
      for (const entry of callbacks) {
        if (entry.fresh) {
          // `fresh: true` was enqueued while THIS sync was already running,
          // meaning the caller mutated session-level flags (e.g.
          // `_liveStreamBroken`) AFTER our wire request was in flight. Firing
          // on `result` here would observe a pre-mutation snapshot and e.g.
          // clear `_liveStreamBroken` before the tail sync actually re-pulls
          // with the flag set. Re-queue as a regular (fresh:false) entry so
          // the tail sync scheduled by the `freshAfterInFlight` branch picks
          // it up and fires on its own — post-mutation — result.
          _pendingOnResultCallbacks.push({ onResult: entry.onResult, fresh: false })
          continue
        }
        if (!entry.onResult) continue
        // Each callback is best-effort isolated: a throw from one must not
        // prevent the next from running or leak past the sync boundary.
        try { entry.onResult(result) } catch (err) {
          try { console.error('[sync] onResult callback threw', err) } catch {}
        }
      }
      return result
    })
    .finally(() => { _syncInFlight = null })
  return _syncInFlight
}
