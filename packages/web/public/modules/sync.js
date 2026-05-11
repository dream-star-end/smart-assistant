// OpenClaude — Cross-device session sync
// Syncs frontend sessions (IndexedDB) with server-side storage (SQLite).
// Server is source of truth for session list; local IDB is cache + offline fallback.

import { apiFetch, apiGet, apiJson, authHeaders } from './api.js?v=f58dbc45'
import { dbGetAll, dbPut, dbDelete } from './db.js?v=f58dbc45'
import { _rebuildSearchIndex, clearDeleteTombstone, isDeletePending } from './sessions.js?v=f58dbc45'
import { state } from './state.js?v=f58dbc45'

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
// Dep-injected: fired the FIRST time a session's PUT comes back 413 (server
// rejected the row as oversized — see MAX_SESSION_BYTES on the storage
// side). UI should toast the user with actionable guidance ("delete
// attachments / start a new session") since further auto-PUT attempts on
// this session are now disabled. Re-fired only when sess._oversized
// transitions false→true, so a session that ping-pongs across reloads
// won't keep flooding the toast queue.
let _onSessionOversized = null
export function setSyncDeps({ onConflictResolved, onRequestRetryPush, onSyncStatusChange, onSessionOversized }) {
  _onConflictResolved = onConflictResolved
  _onRequestRetryPush = onRequestRetryPush
  _onSyncStatusChange = onSyncStatusChange
  _onSessionOversized = onSessionOversized
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
 * Decide the `?since=<seq>` cursor for an incremental GET on a session.
 * Returns 0 (= no `since`, request full payload) when:
 *   - no local session exists yet
 *   - `_liveStreamBroken` is set (resume_failed reconcile must see whole tape)
 *   - `_dirty` is set (defensive — these never reach the fetch path normally)
 *   - local messages array is empty (nothing to extend)
 *   - any local message lacks `_seq` (legacy row pre-backfill; server can't
 *     answer incrementally — fall back to full payload)
 */
export function _computeSinceSeqForFetch(localSess) {
  if (!localSess) return 0
  if (localSess._liveStreamBroken || localSess._dirty) return 0
  const messages = Array.isArray(localSess.messages) ? localSess.messages : []
  if (messages.length === 0) return 0
  let max = 0
  for (const m of messages) {
    const s = m && typeof m._seq === 'number' && Number.isFinite(m._seq) ? m._seq : null
    if (s === null) return 0  // legacy message without _seq → cannot use incremental
    if (s > max) max = s
  }
  return max
}

/**
 * Merge a partial (tail-only) server response into the local messages array.
 * Returns null if sanity check fails (caller should fall back to full GET).
 *
 * Sanity: after appending the tail (with same-id replacement when server
 * re-assigned `_seq`), the resulting array length and max `_seq` must match
 * `remote.totalMessageCount` and `remote.maxSeq`. Mismatch indicates client
 * has a hole the partial protocol can't fill (cross-device delete via legacy
 * code path, server bug, etc.) — caller retries with full GET.
 */
export function _mergePartialTail(localMessages, tail, expectedCount, expectedMaxSeq) {
  const merged = Array.isArray(localMessages) ? localMessages.slice() : []
  const idIdx = new Map()
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]
    if (m && typeof m.id === 'string') idIdx.set(m.id, i)
  }
  const tailArr = Array.isArray(tail) ? tail : []
  for (const m of tailArr) {
    if (!m || typeof m.id !== 'string') continue
    if (idIdx.has(m.id)) {
      // Same-id replacement — server re-allocated `_seq` because the
      // server-visible content of this message changed (e.g., a server-
      // authored takeover that mergePreservingServerAuthored substituted in
      // a previous PUT). Replace in place to keep ordering stable.
      merged[idIdx.get(m.id)] = m
    } else {
      merged.push(m)
      idIdx.set(m.id, merged.length - 1)
    }
  }
  let mergedMaxSeq = 0
  for (const m of merged) {
    const s = m && typeof m._seq === 'number' ? m._seq : 0
    if (s > mergedMaxSeq) mergedMaxSeq = s
  }
  if (merged.length !== expectedCount) return null
  if (mergedMaxSeq !== expectedMaxSeq) return null
  return merged
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

  // Fetch missing/newer sessions from server (batch, max 10 concurrent).
  //
  // Incremental GET (Plan v3): when local has messages with server-assigned
  // `_seq`, pass `?since=<maxLocalSeq>` so server returns only the tail
  // (`isPartial: true`). Rebuilds with merge dedupe + count/maxSeq sanity.
  // Skip incremental for:
  //   - `_liveStreamBroken` sessions (force-fetch reconcile must see all msgs)
  //   - `_dirty` sessions (they never reach here per the merge loop guard,
  //     but be defensive in case future toFetch logic changes)
  //   - sessions with no local messages (nothing to incrementally extend)
  //   - sessions whose local messages lack `_seq` (legacy row; server can't
  //     incrementally answer until next write triggers backfill)
  const fetched = []
  for (let i = 0; i < toFetch.length; i += 10) {
    const batch = toFetch.slice(i, i + 10)
    const results = await Promise.allSettled(
      batch.map((id) => {
        const local = state.sessions.get(id)
        const sinceSeq = _computeSinceSeqForFetch(local)
        const url = sinceSeq > 0
          ? `/api/sessions/${id}?since=${sinceSeq}`
          : `/api/sessions/${id}`
        return apiGet(url)
      })
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.id) fetched.push(r.value)
    }
  }

  // Merge fetched sessions into local state + IDB (skip dirty local sessions)
  let currentSessionUpdated = false
  let fetchedCount = 0
  for (let remote of fetched) {
    if (isDeletePending(remote.id)) continue // locally deleted, pending server confirmation
    let existingLocal = state.sessions.get(remote.id)

    // Incremental partial response (Plan v3): server returned only messages
    // whose `_seq > sinceSeq`. We must merge tail into local and verify the
    // full timeline by `totalMessageCount + maxSeq` sanity. On mismatch, fall
    // back to a full GET (no `since`) and process that response instead.
    //
    // Strict ordering: this branch runs AFTER the dirty / liveStreamBroken
    // pre-conditions are honoured by `_computeSinceSeqForFetch` (which never
    // emits a `since` for those states). Defensive: if a partial response
    // somehow arrives for a dirty session (server bug, replay race), skip it
    // — the caller's later integrity-sync pass will reconcile.
    if (remote.isPartial === true) {
      if (!existingLocal) {
        // Server returned partial but we have no local. Should not happen —
        // _computeSinceSeqForFetch returns 0 in this case. Fall back to full.
        try {
          const full = await apiGet(`/api/sessions/${remote.id}`)
          if (full?.id) remote = full
          else continue
        } catch { continue }
      } else if (existingLocal._dirty && !existingLocal._liveStreamBroken) {
        // Defensive (this combination shouldn't fetch with `since` per
        // _computeSinceSeqForFetch). Drop the partial and let the next sync
        // tick reconcile via the dirty-skip branch below.
        continue
      } else {
        const merged = _mergePartialTail(
          existingLocal.messages,
          remote.messages,
          typeof remote.totalMessageCount === 'number' ? remote.totalMessageCount : -1,
          typeof remote.maxSeq === 'number' ? remote.maxSeq : -1,
        )
        if (merged === null) {
          // Sanity failed — local has a hole/extra the partial can't reconcile.
          // Re-fetch full and re-process; one extra round-trip in the rare
          // mismatch case is acceptable.
          try {
            const full = await apiGet(`/api/sessions/${remote.id}`)
            if (full?.id) remote = full
            else continue
          } catch { continue }
        } else {
          // Partial sanity passed: write the merged session and skip the
          // full-merge logic below.
          const sess = {
            id: remote.id,
            title: remote.title,
            createdAt: remote.createdAt,
            lastAt: remote.lastAt,
            messages: merged,
            agentId: remote.agentId || 'main',
            pinned: remote.pinned || false,
            _syncedAt: remote.updatedAt,
          }
          if (existingLocal._sendingInFlight) sess._sendingInFlight = true
          if (existingLocal._turnStartedAt) sess._turnStartedAt = existingLocal._turnStartedAt
          if (existingLocal._lastFrameAt) sess._lastFrameAt = existingLocal._lastFrameAt
          if (typeof existingLocal._lastFrameSeq === 'number') sess._lastFrameSeq = existingLocal._lastFrameSeq
          _rebuildSearchIndex(sess)
          clearDeleteTombstone(sess.id)
          state.sessions.set(sess.id, sess)
          fetchedCount++
          if (sess.id === state.currentSessionId) currentSessionUpdated = true
          try { await dbPut({ ...sess, _syncedAt: remote.updatedAt }) } catch {}
          continue
        }
      }
      // Fell through from a sanity-fail or null-existingLocal retry: refresh
      // existingLocal so the full-payload merge below sees the latest state.
      existingLocal = state.sessions.get(remote.id)
    }
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
 * 2026-05-06 §4.5 改动 11 — messages 内 ephemeral / server-authoritative 字段
 * strip。pushSessionToServer 已经 strip 了 session 级 ephemeral 字段,但消息
 * 内的 _rawMeta / _partial / _completed / output / error / bashTail / inputJson /
 * inputPreview / metaText 一直没清,会跟着 PUT body 上服务器,污染权威源。
 *
 * 双层防御:server 端 storage.upsertClientSession 也 strip(allowlist 模式,
 * 见 packages/storage/src/sessionsDb.ts clientPutStrip 路径);本函数是客户端
 * 第一层防御,降低无谓上行流量同时让本地代码意图明确。
 *
 * 同时禁掉若干 server-authoritative 字段从 client 写出去:
 *   - _seq:server-allocated monotonic;client 上行的话会被 server 端 strip 但
 *     提前删可避免 round-trip 浪费。
 *   - _source:'server':client 不应自称 server-authored。
 *   - usage:server-authored row 的字段;client 没权威能力写。但 client 在
 *     msg.usage 里展示 cost_charged broadcast 推来的 costCredits,这部分
 *     不持久化(由 server 通过 appendCostCredits 落 SQL),故 strip 安全。
 *   - status === 'replied':派生字段,不持久化。
 *   - _truncated / _errorCode / _errorDetail:server-authored 写入(见 4.3 schema)。
 *
 * 输入数组不可变;返回新数组(浅拷贝消息对象,删 ephemeral keys)。
 */
const _MSG_EPHEMERAL_KEYS = [
  '_rawMeta',
  '_partial',
  '_completed',
  'output',
  'error',
  'bashTail',
  'inputJson',
  'inputPreview',
  'metaText',
]
const _MSG_SERVER_AUTHORITATIVE_KEYS = [
  '_seq',
  '_source',
  'usage',
  '_truncated',
  '_errorCode',
  '_errorDetail',
]
export function _stripMessageEphemeral(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m
    const cleaned = { ...m }
    for (const k of _MSG_EPHEMERAL_KEYS) delete cleaned[k]
    for (const k of _MSG_SERVER_AUTHORITATIVE_KEYS) delete cleaned[k]
    // 'replied' 派生不持久化;其他 status 沿用
    if (cleaned.status === 'replied') delete cleaned.status
    return cleaned
  })
}

/**
 * Push a single session to server (best-effort). Marks _syncedAt on success.
 */
export function pushSessionToServer(sess) {
  if (!sess?.id || !state.token) return Promise.resolve()
  // Oversized sessions (received a 413 from a previous PUT) are PUT-disabled
  // for the rest of the page lifetime. Any subsequent PUT would just cost
  // request bytes + DB JSON.parse cycles and 413 again. The flag is
  // intentionally NOT persisted to IDB: a page reload or admin-side
  // session strip should give us a fresh chance, and we re-detect oversized
  // on the next PUT attempt without needing to manually unstick the flag.
  if (sess._oversized) return Promise.resolve()
  const { _streamingAssistant, _streamingThinking, _blockIdToMsgId, _sendingInFlight, _replyingToMsgId, _agentGroups, _streamRafPending, _thinkRafPending, _searchText, _syncedAt, _dirty, _pendingCostCredits, _lastFinaledAssistantId, _lastFinaledAt, _oversized, ...clean } = sess
  // Include baseSyncedAt for optimistic concurrency — server rejects if row is newer
  clean._baseSyncedAt = _syncedAt || 0
  // 2026-05-06 §4.5 改动 11 — messages 内 strip(双层防御第一层)。
  if (Array.isArray(clean.messages)) {
    clean.messages = _stripMessageEphemeral(clean.messages)
  }
  const preFlightLastAt = sess.lastAt // snapshot BEFORE PUT for 409 conflict detection
  // 2026-05-08 incident response: real preflight body-size check.
  // The per-file attachment cap (1.25MB, attachments.js) is upload-time UX
  // only; this is the authoritative gate that mirrors the gateway's 2MB
  // PUT body cap. Catches all the cases the per-file cap can't see:
  //   • aggregated message text on long sessions
  //   • multiple under-cap attachments stacking past the body budget
  //   • legacy oversized sessions loaded from IDB
  // Trigger _oversized via the same path as a 413 response so UI/state is
  // consistent regardless of whether the rejection happened client-side
  // (here) or after the request hit the wire. Slightly tighter than the
  // server's 2MB to leave room for HTTP headers + chunked-encoding overhead.
  const PREFLIGHT_MAX_BYTES = 1.9 * 1024 * 1024
  const body = JSON.stringify(clean)
  const bodyBytes = new TextEncoder().encode(body).length
  if (bodyBytes > PREFLIGHT_MAX_BYTES) {
    const live = state.sessions.get(sess.id) || sess
    const wasOversized = live._oversized
    live._oversized = true
    live._dirty = false
    live._conflictRetryCount = 0
    if (!wasOversized) {
      try { _onSessionOversized?.(live.id) } catch {}
    }
    return Promise.resolve()
  }
  return apiFetch(`/api/sessions/${sess.id}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body,
  }).then(async (res) => {
    if (res.ok) {
      const resp = await res.json()
      if (resp?.applied && resp.updatedAt) {
        sess._syncedAt = resp.updatedAt
        sess._dirty = false
        sess._conflictRetryCount = 0  // successful PUT clears 409 retry cap
      }
    } else if (res.status === 413) {
      // Oversized — server rejected because either the request body is
      // larger than the gateway PUT cap (2MB) or the post-merge messages
      // blob would exceed MAX_SESSION_BYTES (4MB). Either way auto-retry
      // would re-trigger the same rejection forever (the 2026-05-08
      // event-loop-stall incident). Mark the session and surface to the
      // user; they can manually start a new session or wait for admin
      // strip. The live in-memory object is the authoritative target
      // (sess may be a detached dbGetAll snapshot).
      //
      // _oversized is intentionally session-runtime ONLY — it is stripped
      // out of the IDB persist set in sessions.js _doSave and cleared on
      // any scheduleSaveFromUserEdit. That gives the user a clean recovery
      // path: page reload OR deleting attachments both re-arm the next
      // PUT attempt. Without those two unsticks, a single 413 would
      // permanently brick the session for that browser.
      const live = state.sessions.get(sess.id) || sess
      const wasOversized = live._oversized
      live._oversized = true
      live._dirty = false  // suppress auto-retry; user must take action
      live._conflictRetryCount = 0
      // No dbPut here: the runtime-only flag would only be persisted
      // accidentally if we wrote to IDB now. The next legitimate _doSave
      // (after user edit clears the flag) will persist any other state
      // changes; until then there's nothing IDB-worthy to record.
      if (!wasOversized) {
        try { _onSessionOversized?.(live.id) } catch {}
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
          //
          // 2026-05-06 §4.5 改动 13 (Codex review round 1+2) — server-authoritative
          // 字段 overlay。"local dominates" 历史语义只覆盖文本扩展(streaming
          // 前缀延伸),没考虑 server 端可能在 client 没更新 text 的情况下独立
          // patch 了 usage / _seq / _truncated 等权威字段(见 commercial
          // pending_usage_patches 异步合入路径)。本 PR 把 usage 权威化后,如果
          // 不在这里把 server 同 id 消息的权威字段 overlay 到 local,会出现:
          //   1) live.messages 内存版无 usage → UI token 行空
          //   2) dbPut({...target}) 把无 usage 的版本写进 IDB
          //   3) 强刷从 IDB 加载 → 短暂闪烁(空 token 行直到下一次 GET)
          //
          // overlay 字段集分两类:
          //   _OVERLAY_KEYS_BASE — 任何同 id 消息都 overlay(usage/_seq/_source/
          //     _truncated/_errorCode/_errorDetail 是 server-authored row 才会
          //     有的字段,client 同 id 消息持有它们 == server 权威值,overlay 安全)
          //   status — 仅当 server 端是 server-authored(_source='server')时 overlay。
          //     user 消息 status 由 client 维持(sending/sent/read,storage 端 strip),
          //     不能被 overlay 覆盖。assistant message status 在新方案里只有
          //     server-authored row 才会带(server 写 'completed'/'interrupted' 终态),
          //     这正是 _deriveUserMsgStatus 派生 'replied' 的依据。如果不 overlay status,
          //     强刷场景从 IDB 加载会 token 行回来但"已回复"角标仍空。流式结束**不**
          //     由 assistant.status 控制,而是 sess._streamingAssistant / _sendingInFlight /
          //     isFinal 帧 — 所以 overlay 终态 status 不会让 client 误以为流结束。
          //
          // **不**覆盖 text/role/ts:这些字段在 _localDominates 判定时 local 已胜出
          // (否则不会进 local-dominates 分支),overlay 会破坏 streaming 扩展。
          const _OVERLAY_KEYS_BASE = ['_seq', '_source', 'usage', '_truncated', '_errorCode', '_errorDetail']
          if (Array.isArray(server.messages) && Array.isArray(target.messages)) {
            const liveById = new Map()
            for (const m of target.messages) if (m?.id) liveById.set(m.id, m)
            for (const sm of server.messages) {
              if (!sm?.id) continue
              const lm = liveById.get(sm.id)
              if (!lm) continue
              for (const k of _OVERLAY_KEYS_BASE) {
                if (sm[k] !== undefined) lm[k] = sm[k]
              }
              // status 单独处理:仅 server-authored 消息才 overlay,避免把 server
              // 端缺省的 user.status 覆盖 client 的 sending/sent/read,也避免把
              // client-mirrored assistant(非 server-authored)误标终态。
              if (sm._source === 'server' && sm.status !== undefined) {
                lm.status = sm.status
              }
            }
          }

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
