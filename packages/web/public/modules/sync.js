// OpenClaude — Cross-device session sync
// Syncs frontend sessions (IndexedDB) with server-side storage (SQLite).
// Server is source of truth for session list; local IDB is cache + offline fallback.

import { apiFetch, apiGet, apiJson, authHeaders } from './api.js'
import { dbDelete, dbGetAll, dbPut } from './db.js'
import { projectSessionTape } from './sessionTape.js?v=2'
import { _rebuildSearchIndex, clearDeleteTombstone, isDeletePending } from './sessions.js?v=15'
import { state } from './state.js'

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
const AUTO_HYDRATE_RECENT_LIMIT = 1

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

function _hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key)
}

function _sameIfServerHas(localObj, serverObj, key) {
  if (!_hasOwn(serverObj, key) || serverObj[key] == null) return true
  if (!_hasOwn(localObj, key) || localObj[key] == null) return false
  return String(localObj[key]) === String(serverObj[key])
}

function _stringPrefixSupersedes(localObj, serverObj, key) {
  const sText = typeof serverObj?.[key] === 'string' ? serverObj[key] : ''
  if (!sText) return true
  const lText = typeof localObj?.[key] === 'string' ? localObj[key] : ''
  return !!lText && lText.startsWith(sText)
}

function _jsonSupersedesIfServerHas(localObj, serverObj, key) {
  if (!_hasOwn(serverObj, key) || serverObj[key] == null) return true
  if (!_hasOwn(localObj, key) || localObj[key] == null) return false
  const ls = _stableStringify(localObj[key])
  const ss = _stableStringify(serverObj[key])
  return ls !== null && ss !== null && ls === ss
}

function _booleanProgressSupersedes(localVal, serverVal, doneValue) {
  if (typeof serverVal !== 'boolean') return true
  if (typeof localVal !== 'boolean') return false
  if (localVal === serverVal) return true
  return localVal === doneValue && serverVal !== doneValue
}

function _errorFieldSupersedes(localObj, serverObj, key) {
  const serverCompleted = serverObj?._completed === true
  const serverErr = !!serverObj?.[key]
  const localErr = !!localObj?.[key]
  if (serverErr && !localErr) return false
  if (serverCompleted && serverErr !== localErr) return false
  return true
}

function _bashTailSupersedes(localMsg, serverMsg) {
  const sTail = serverMsg?.bashTail
  if (!sTail || typeof sTail !== 'object') return true
  // A completed tool result dominates a running tail preview: _renderBash
  // prefers msg.output once present, so retaining local output does not
  // erase a visible server-only final state.
  if (
    localMsg?._completed === true &&
    typeof localMsg.output === 'string' &&
    localMsg.output.length > 0
  ) {
    return true
  }
  const lTail = localMsg?.bashTail
  if (!lTail || typeof lTail !== 'object') return false
  const sBytes = typeof sTail.totalBytes === 'number' ? sTail.totalBytes : 0
  const lBytes = typeof lTail.totalBytes === 'number' ? lTail.totalBytes : 0
  if (lBytes < sBytes) return false
  const sText = typeof sTail.tail === 'string' ? sTail.tail : ''
  const lText = typeof lTail.tail === 'string' ? lTail.tail : ''
  if (sText && !lText) return false
  if (sText && lText !== sText && !lText.startsWith(sText) && !lText.includes(sText)) return false
  if (lBytes === sBytes && !!lTail.truncatedHead !== !!sTail.truncatedHead) return false
  return true
}

function _toolLikeSupersedes(localMsg, serverMsg) {
  if (!_sameIfServerHas(localMsg, serverMsg, 'text')) return false
  if (!_sameIfServerHas(localMsg, serverMsg, 'toolName')) return false
  if (!_sameIfServerHas(localMsg, serverMsg, 'blockId')) return false
  if (!_booleanProgressSupersedes(localMsg?._completed, serverMsg?._completed, true)) return false
  if (!_booleanProgressSupersedes(localMsg?._partial, serverMsg?._partial, false)) return false
  if (!_errorFieldSupersedes(localMsg, serverMsg, 'error')) return false
  if (!_stringPrefixSupersedes(localMsg, serverMsg, 'inputPreview')) return false
  if (!_jsonSupersedesIfServerHas(localMsg, serverMsg, 'inputJson')) return false
  if (!_stringPrefixSupersedes(localMsg, serverMsg, 'output')) return false
  if (!_jsonSupersedesIfServerHas(localMsg, serverMsg, 'outputJson')) return false
  if (!_bashTailSupersedes(localMsg, serverMsg)) return false
  return true
}

function _childBlockSupersedes(localChild, serverChild) {
  if (!localChild || !serverChild) return false
  const kind = serverChild.kind
  if (!kind || localChild.kind !== kind) return false
  if (kind === 'text' || kind === 'thinking') {
    return _stringPrefixSupersedes(localChild, serverChild, 'text')
  }
  if (kind === 'tool_use') return _toolLikeSupersedes(localChild, serverChild)
  // Unknown child block kinds may carry structural state we cannot compare
  // safely. Fall back to server-wins unless Layer 1 stable equality matched.
  return false
}

function _childBlocksPrefixSupersedes(localMsg, serverMsg) {
  const serverChildren = Array.isArray(serverMsg?.childBlocks) ? serverMsg.childBlocks : []
  if (serverChildren.length === 0) return true
  const localChildren = Array.isArray(localMsg?.childBlocks) ? localMsg.childBlocks : []
  if (localChildren.length < serverChildren.length) return false
  for (let i = 0; i < serverChildren.length; i++) {
    if (!_childBlockSupersedes(localChildren[i], serverChildren[i])) return false
  }
  return true
}

function _assistantChildBlocksSupersedes(localMsg, serverMsg) {
  if (!_stringPrefixSupersedes(localMsg, serverMsg, 'text')) return false
  return _childBlocksPrefixSupersedes(localMsg, serverMsg)
}

function _agentGroupSupersedes(localMsg, serverMsg) {
  if (!_sameIfServerHas(localMsg, serverMsg, 'blockId')) return false
  if (!_sameIfServerHas(localMsg, serverMsg, 'toolName')) return false
  if (!_stringPrefixSupersedes(localMsg, serverMsg, 'text')) return false
  if (!_booleanProgressSupersedes(localMsg?._completed, serverMsg?._completed, true)) return false
  if (!_errorFieldSupersedes(localMsg, serverMsg, '_isError')) return false
  if (!_stringPrefixSupersedes(localMsg, serverMsg, '_resultPreview')) return false
  return _childBlocksPrefixSupersedes(localMsg, serverMsg)
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
 *     For assistant/thinking/user/plan only, apply a text-level check:
 *       - assistant/thinking: server.text is a prefix of local.text
 *         (streaming delta — unambiguous "local = server + more")
 *       - user: exact text equality (status drift tolerated, see below)
 *       - plan: local non-empty text is the durable plan document; it can
 *         dominate a server snapshot that only has structured steps.
 *       - tool / agent-group: monotonic structural updates only (partial
 *         cards becoming completed, childBlocks growing as an ordered
 *         prefix). Unknown or divergent structure still falls back to
 *         server-wins.
 *     Assistant rows with childBlocks use the same ordered-prefix
 *     structural rule as agent-group rows; unknown child kinds still fall
 *     back to server-wins unless Layer 1 stable equality matched.
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

  if (role === 'tool') return _toolLikeSupersedes(localMsg, serverMsg)
  if (role === 'agent-group') return _agentGroupSupersedes(localMsg, serverMsg)
  if (
    role === 'assistant' &&
    (Array.isArray(localMsg.childBlocks) || Array.isArray(serverMsg.childBlocks))
  ) {
    return _assistantChildBlocksSupersedes(localMsg, serverMsg)
  }

  // Layer 2: text-level judgement, roles whitelist only.
  if (role !== 'assistant' && role !== 'thinking' && role !== 'user' && role !== 'plan')
    return false
  // Non-assistant childBlocks are structural; if Layer 1 did not prove
  // equality and no role-specific structural rule exists, fall back to
  // server-wins rather than guessing from text alone.
  if (Array.isArray(localMsg.childBlocks) || Array.isArray(serverMsg.childBlocks)) return false
  const lText = typeof localMsg.text === 'string' ? localMsg.text : ''
  const sText = typeof serverMsg.text === 'string' ? serverMsg.text : ''
  if (role === 'user') return lText === sText
  if (role === 'plan') {
    // Codex plan mode may stream the human-readable plan document as
    // `text`, while a racing server snapshot only has `steps`/`explanation`.
    // Treat local non-empty text as a safe extension, then merge any missing
    // structured fields from the server before retrying the PUT.
    if (!lText.trim()) return false
    if (sText.length === 0) return true
    if (lText.length < sText.length) return false
    return lText.startsWith(sText)
  }
  // assistant / thinking — streaming prefix extension
  if (sText.length === 0) return true
  if (lText.length < sText.length) return false
  return lText.startsWith(sText)
}

function _mergeServerPlanFields(serverMessages, localMessages) {
  const server = Array.isArray(serverMessages) ? serverMessages : []
  const local = Array.isArray(localMessages) ? localMessages : []
  const localPlans = new Map()
  for (const m of local) {
    if (m?.role === 'plan' && typeof m.id === 'string') localPlans.set(m.id, m)
  }
  for (const s of server) {
    if (s?.role !== 'plan' || typeof s.id !== 'string') continue
    const l = localPlans.get(s.id)
    if (!l) continue
    if (typeof l.blockId !== 'string' && typeof s.blockId === 'string') l.blockId = s.blockId
    if (typeof l.explanation !== 'string' && typeof s.explanation === 'string') {
      l.explanation = s.explanation
    }
    if (
      (!Array.isArray(l.steps) || l.steps.length === 0) &&
      Array.isArray(s.steps) &&
      s.steps.length > 0
    ) {
      l.steps = s.steps.map((step) =>
        step && typeof step === 'object' && !Array.isArray(step) ? { ...step } : step,
      )
    }
  }
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

function _activeStreamEntries(sess) {
  const entries = []
  const seen = new Set()
  const add = (kind, msg) => {
    if (!msg || typeof msg.id !== 'string' || seen.has(msg.id)) return
    seen.add(msg.id)
    entries.push({ kind, msg })
  }
  add('streamingAssistant', sess?._streamingAssistant)
  add('streamingThinking', sess?._streamingThinking)
  add('streamingPlan', sess?._streamingPlan)
  if (typeof sess?._replyingToMsgId === 'string') {
    const msg = Array.isArray(sess.messages)
      ? sess.messages.find((m) => m?.id === sess._replyingToMsgId)
      : null
    add('replyingToMsgId', msg)
  }
  return entries
}

function _activeStreamIds(sess) {
  return new Set(_activeStreamEntries(sess).map((entry) => entry.msg.id))
}

function _serverMessageCoversLocalVisible(serverMsg, localMsg) {
  if (!serverMsg) return { reason: 'missing-active-message' }
  if (!localMsg) return null
  if (serverMsg.role !== localMsg.role) return { reason: 'active-role-mismatch' }

  const localText = typeof localMsg.text === 'string' ? localMsg.text : ''
  const serverText = typeof serverMsg.text === 'string' ? serverMsg.text : ''
  if (localText && !serverText.startsWith(localText)) {
    return {
      reason: serverText.length < localText.length ? 'active-text-shorter' : 'active-text-diverged',
      localTextLength: localText.length,
      serverTextLength: serverText.length,
    }
  }

  const localChildren = Array.isArray(localMsg.childBlocks) ? localMsg.childBlocks : []
  if (localChildren.length === 0) return null
  const serverChildren = Array.isArray(serverMsg.childBlocks) ? serverMsg.childBlocks : []
  if (serverChildren.length < localChildren.length) {
    return {
      reason: 'active-childblocks-shorter',
      localChildBlocks: localChildren.length,
      serverChildBlocks: serverChildren.length,
    }
  }
  for (let i = 0; i < localChildren.length; i++) {
    const ls = _stableStringify(localChildren[i])
    const ss = _stableStringify(serverChildren[i])
    if (ls !== null && ss !== null && ls === ss) continue
    if (!_childBlockSupersedes(serverChildren[i], localChildren[i])) {
      return {
        reason: 'active-childblock-regressed',
        childIndex: i,
        childKind: localChildren[i]?.kind || serverChildren[i]?.kind || null,
      }
    }
  }
  return null
}

function _activeStreamLoss(sess, serverMessages) {
  const entries = _activeStreamEntries(sess)
  if (entries.length === 0) return null
  const byId = new Map()
  for (const msg of Array.isArray(serverMessages) ? serverMessages : []) {
    if (msg?.id && !byId.has(msg.id)) byId.set(msg.id, msg)
  }
  for (const entry of entries) {
    const loss = _serverMessageCoversLocalVisible(byId.get(entry.msg.id), entry.msg)
    if (loss) {
      return {
        ...loss,
        kind: entry.kind,
        id: entry.msg.id,
        role: entry.msg.role || null,
      }
    }
  }
  return null
}

function _localDominatesAllowingMissingActive(serverMessages, localMessages, activeIds) {
  const server = Array.isArray(serverMessages) ? serverMessages : []
  const local = Array.isArray(localMessages) ? localMessages : []
  if (!activeIds || activeIds.size === 0) return false
  let localIdx = 0
  for (const serverMsg of server) {
    if (!serverMsg?.id) return false
    while (
      localIdx < local.length &&
      activeIds.has(local[localIdx]?.id) &&
      local[localIdx]?.id !== serverMsg.id
    ) {
      localIdx++
    }
    const localMsg = local[localIdx]
    if (!localMsg?.id || localMsg.id !== serverMsg.id) return false
    if (!_localMessageSupersedes(localMsg, serverMsg)) return false
    localIdx++
  }
  return true
}

function _activeStreamLogPayload(sess, serverMessages, loss) {
  const activeEntries = _activeStreamEntries(sess)
  return {
    sessionId: sess?.id || null,
    reason: loss?.reason || null,
    activeKind: loss?.kind || null,
    activeId: loss?.id || null,
    activeRole: loss?.role || null,
    localMessageCount: Array.isArray(sess?.messages) ? sess.messages.length : 0,
    serverMessageCount: Array.isArray(serverMessages) ? serverMessages.length : 0,
    activeIds: activeEntries.map((entry) => entry.msg.id),
    activeHasChildBlocks: activeEntries.some((entry) => Array.isArray(entry.msg.childBlocks)),
    serverHasChildBlocks: Array.isArray(serverMessages)
      ? serverMessages.some((msg) => Array.isArray(msg?.childBlocks))
      : false,
  }
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
  if (sess._streamingPlan) {
    sess._streamingPlan = byId.get(sess._streamingPlan.id) || null
  }
  if (sess._replyingToMsgId && !byId.has(sess._replyingToMsgId)) {
    sess._replyingToMsgId = null
    sess._currentTurnBlockCount = 0 // hygiene: old turn's counter is stale
  }
}

function _copyLocalSessionRuntimeState(sess, existingLocal) {
  if (!sess || !existingLocal) return sess
  if (existingLocal._sendingInFlight) sess._sendingInFlight = true
  if (existingLocal._inFlightClientMessageId)
    sess._inFlightClientMessageId = existingLocal._inFlightClientMessageId
  if (existingLocal._turnStartedAt) sess._turnStartedAt = existingLocal._turnStartedAt
  if (existingLocal._lastFrameAt) sess._lastFrameAt = existingLocal._lastFrameAt
  if (typeof existingLocal._lastFrameSeq === 'number')
    sess._lastFrameSeq = existingLocal._lastFrameSeq
  if (existingLocal._liveStreamBroken) sess._liveStreamBroken = true
  if (existingLocal._tokenUsage) sess._tokenUsage = existingLocal._tokenUsage
  return sess
}

function _serverTapeLastSeq(remote) {
  const value = remote?.tape?.lastTapeSeq ?? remote?.lastTapeSeq
  if (value === null) return 0
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function _buildSessionFromRemote(remote, existingLocal, { placeholder = false } = {}) {
  const remoteMessageCount =
    typeof remote?.messageCount === 'number'
      ? remote.messageCount
      : Array.isArray(remote?.messages)
        ? remote.messages.length
        : undefined
  const existingMessages = Array.isArray(existingLocal?.messages) ? existingLocal.messages : []
  const fullMessages = Array.isArray(remote?.messages) ? remote.messages : []
  const messages = placeholder ? existingMessages : fullMessages
  const messageCount =
    typeof remoteMessageCount === 'number' ? remoteMessageCount : messages.length || 0
  const remoteTapeLastSeq = _serverTapeLastSeq(remote)
  const localTapeLastSeq = Number.isSafeInteger(existingLocal?._tapeLastSeq)
    ? existingLocal._tapeLastSeq
    : null
  const sess = {
    id: remote.id,
    title: remote.title || existingLocal?.title || '新会话',
    createdAt: remote.createdAt || existingLocal?.createdAt || Date.now(),
    lastAt: remote.lastAt || existingLocal?.lastAt || Date.now(),
    messages,
    agentId: remote.agentId || existingLocal?.agentId || 'main',
    pinned: !!remote.pinned,
    _syncedAt: remote.updatedAt,
    _messageCount: messageCount,
    _tapeTurnCount: remote.tapeTurnCount || existingLocal?._tapeTurnCount || 0,
    _tapeLastSeq: remoteTapeLastSeq ?? localTapeLastSeq ?? 0,
  }
  if (
    placeholder &&
    (messageCount > messages.length ||
      (remote.tapeTurnCount > 0 && !existingLocal?._tapeFrames) ||
      (remoteTapeLastSeq !== null && remoteTapeLastSeq !== localTapeLastSeq) ||
      (existingLocal?._syncedAt &&
        remote.updatedAt &&
        existingLocal._syncedAt !== remote.updatedAt))
  )
    sess._needsFetch = true
  _copyLocalSessionRuntimeState(sess, existingLocal)
  return sess
}

function _sessionDbSnapshot(sess, extra = {}) {
  const {
    _streamingAssistant,
    _streamingThinking,
    _streamingPlan,
    _blockIdToMsgId,
    _replyingToMsgId,
    _agentGroups,
    _wfGroups,
    _streamRafPending,
    _thinkRafPending,
    _searchText,
    _hydratePromise,
    _hydrating,
    _tapeFrames,
    _tapeBefore,
    _tapeHasMore,
    _tapeFirstTs,
    _tapeLoadingPromise,
    _legacyMessages,
    ...persist
  } = sess || {}
  return { ...persist, ...extra }
}

function _canHydrateNow(id, sess) {
  if (!id) return false
  if (!sess) return true
  // Stream known-broken (resume_failed / replay-miss): MUST allow hydrate so the
  // REST refetch can reconcile from the server-authored tape — even if a long turn
  // is still running and runtime pointers linger. syncSessionsFromServer relies on
  // this recovery path (see websocket.js handleResumeFailed).
  if (sess._liveStreamBroken) return true
  // Only skip hydrate while THIS tab is genuinely receiving a live stream, to avoid
  // the server full-snapshot clobbering the streaming tail. Gate on runtime-only
  // pointers (all stripped by _doSave / _sessionDbSnapshot, so they never survive an
  // IndexedDB reload as stale flags) — NOT on the persisted _sendingInFlight, which
  // can be a stale leftover from a turn that ended abnormally (backgrounded subtask
  // vanish, disconnect, force-quit) and would otherwise permanently wedge hydrate,
  // leaving the history truncated (especially on mobile restoring from cache).
  if (sess._streamingAssistant || sess._streamingThinking || sess._streamingPlan) return false
  if (sess._replyingToMsgId) return false
  return true
}

/**
 * Record that a hydration attempt was refused (or its result discarded)
 * while the body is still known-incomplete. Without this, a session whose
 * hydrate lost the race against an arriving live stream stayed `_needsFetch`
 * forever: nothing re-triggered hydration once the stream ended, so the
 * history gap persisted until the user manually switched away and back.
 * Cleared on a successful adopt (see hydrateSession) — see
 * `retryDeferredHydration`, called from the isFinal path in websocket.js.
 */
function _markHydrateDebt(sess) {
  if (!sess || !sess._needsFetch) return
  sess._hydrateDeferred = true
}

/**
 * Does `serverMessages` still lack content we can already see locally?
 *
 * The gateway persists the authoritative assistant message with a
 * fire-and-forget `appendServerAuthoredMessageDurable` that is NOT ordered
 * against the isFinal frame (sessionManager.ts) — so a GET issued right after
 * a turn ends can legitimately return a snapshot without that turn's reply.
 * Adopting it would replace a locally-streamed, fully-rendered answer with a
 * shorter body, i.e. make a finished reply disappear. We refuse and retry.
 *
 * Only the assistant tail is checked: client-authored bubbles being absent is
 * normal (the server drops phantom `m-*` rows for turns it re-authored, see
 * dropPhantomClientAssistants), so a stricter id-based rule would defer
 * forever.
 */
export function _serverSnapshotLosesLocalTail(serverMessages, localMessages) {
  const server = Array.isArray(serverMessages) ? serverMessages : []
  const local = Array.isArray(localMessages) ? localMessages : []
  let tailText = ''
  for (let i = local.length - 1; i >= 0; i--) {
    const m = local[i]
    if (m?.role !== 'assistant') continue
    const t = typeof m.text === 'string' ? m.text : ''
    if (t.trim()) {
      tailText = t
      break
    }
  }
  if (!tailText) return false
  for (const m of server) {
    if (m?.role !== 'assistant') continue
    const s = typeof m.text === 'string' ? m.text : ''
    // Equal, or the server re-authored a superset of what we streamed.
    if (s?.startsWith(tailText)) return false
  }
  return true
}

export async function hydrateSession(id, { force = false } = {}) {
  if (!id || !state.token) return state.sessions.get(id) || null
  const existing = state.sessions.get(id)
  if (existing?._dirty) return existing
  if (existing && !existing._needsFetch && !force) return existing
  if (existing?._hydratePromise) return existing._hydratePromise
  if (!_canHydrateNow(id, existing)) {
    _markHydrateDebt(existing)
    return existing || null
  }

  const hydration = (async () => {
    const started = state.sessions.get(id)
    if (started) {
      started._hydrating = true
      try {
        _emitSyncStatus({
          state: 'syncing',
          label: '正在加载完整历史',
          detail: started.title || '正在拉取会话内容',
        })
      } catch {}
    }
    const remote = await apiGet(`/api/sessions/${id}`)
    if (!remote?.id) return state.sessions.get(id) || null
    const tapePage = remote.tape?.lastTapeSeq
      ? await apiGet(`/api/sessions/${id}/timeline?turns=5`)
      : null
    const live = state.sessions.get(id)
    // A live stream can start while this GET is in flight (cross-device: the
    // other device's turn streams to us mid-hydration). Dropping the response
    // is correct — it would clobber the tail — but the gap must be remembered.
    if (!_canHydrateNow(id, live)) {
      _markHydrateDebt(live)
      return live || null
    }
    if (live?._dirty) return live
    let hydratedRemote = remote
    const legacyMessages = Array.isArray(remote.messages) ? remote.messages : []
    if (tapePage) {
      // The server freezes this JSON body as the pre-tape legacy prefix. Do
      // not re-cut it by browser timestamps here: device clock skew can put a
      // legitimate old message on either side of the server commit time.
      const projected = projectSessionTape(tapePage.frames)
      const representedIds = new Set(
        [...legacyMessages, ...projected].map((message) => message?.id).filter(Boolean),
      )
      const pendingUsers = (live?.messages || []).filter(
        (message) =>
          message?.role === 'user' &&
          message?._source !== 'tape' &&
          !representedIds.has(message?.id),
      )
      hydratedRemote = {
        ...remote,
        messages: [...legacyMessages, ...projected, ...pendingUsers].sort(
          (a, b) => (a?.ts || 0) - (b?.ts || 0),
        ),
      }
    }
    // Never trade a visible reply for a shorter snapshot. For taped sessions
    // compare against the tape projection, not the legacy JSON column.
    if (!tapePage && _serverSnapshotLosesLocalTail(hydratedRemote.messages, live?.messages)) {
      _markHydrateDebt(live)
      return live || null
    }
    const sess = _buildSessionFromRemote(hydratedRemote, live, { placeholder: false })
    sess._needsFetch = false
    sess._hydrateDeferred = false
    sess._hydrating = false
    // This GET is itself the authoritative REST reconciliation, so retire the
    // broken-stream override here (memory + the dbPut snapshot below). Otherwise
    // a persisted `_liveStreamBroken=true` would survive into a later reload and,
    // via the escape hatch in _canHydrateNow, bypass the live-pointer protection
    // and risk clobbering a future streaming tail. This is the sole retirement
    // point for both memory and the persisted copy.
    sess._liveStreamBroken = false
    if (tapePage) {
      sess._tapeFrames = tapePage.frames
      sess._tapeBefore = tapePage.nextBefore
      sess._tapeHasMore = !!tapePage.hasMore
      sess._tapeFirstTs = tapePage.firstTapeTs
      sess._legacyMessages = legacyMessages
    }
    _rebindStreamingPointers(sess)
    _rebuildSearchIndex(sess)
    clearDeleteTombstone(sess.id)
    state.sessions.set(sess.id, sess)
    try {
      await dbPut(_sessionDbSnapshot(sess, { _syncedAt: remote.updatedAt }))
    } catch {}
    try {
      _emitSyncStatus({
        state: 'synced',
        label: '完整历史已加载',
        detail: sess.title || '会话内容已就绪',
      })
    } catch {}
    return sess
  })()

  const trackedHydration = hydration.finally(() => {
    const live = state.sessions.get(id)
    if (live) {
      live._hydratePromise = undefined
      live._hydrating = false
    }
  })
  if (existing) {
    existing._hydratePromise = trackedHydration
    existing._hydrating = true
  }
  return trackedHydration
}

/** Load one older complete-turn page from the append-only server tape. */
export async function loadOlderTape(id) {
  const sess = state.sessions.get(id)
  if (!sess || !state.token || !sess._tapeHasMore || !sess._tapeBefore) return sess || null
  if (sess._tapeLoadingPromise) return sess._tapeLoadingPromise
  const load = (async () => {
    const before = sess._tapeBefore
    const older = await apiGet(`/api/sessions/${id}/timeline?before=${before}&turns=5`)
    const bySeq = new Map()
    for (const row of [...(sess._tapeFrames || []), ...(older.frames || [])]) {
      bySeq.set(row.tapeSeq, row)
    }
    const frames = [...bySeq.values()].sort((a, b) => a.tapeSeq - b.tapeSeq)
    const legacy = Array.isArray(sess._legacyMessages) ? sess._legacyMessages : []
    const knownIds = new Set(legacy.map((message) => message?.id).filter(Boolean))
    const projected = projectSessionTape(frames)
    const projectedIds = new Set(projected.map((message) => message?.id).filter(Boolean))
    const localOnly = (sess.messages || []).filter(
      (message) =>
        message?._source !== 'tape' && !knownIds.has(message?.id) && !projectedIds.has(message?.id),
    )
    sess.messages = [...legacy, ...projected, ...localOnly].sort(
      (a, b) => (a?.ts || 0) - (b?.ts || 0),
    )
    sess._tapeFrames = frames
    sess._tapeBefore = older.nextBefore
    sess._tapeHasMore = !!older.hasMore
    sess._tapeFirstTs = older.firstTapeTs ?? sess._tapeFirstTs
    sess._messageCount = Math.max(sess._messageCount || 0, sess.messages.length)
    _rebindStreamingPointers(sess)
    _rebuildSearchIndex(sess)
    try {
      await dbPut(_sessionDbSnapshot(sess, { _syncedAt: sess._syncedAt }))
    } catch {}
    return sess
  })()
  sess._tapeLoadingPromise = load.finally(() => {
    sess._tapeLoadingPromise = null
  })
  return sess._tapeLoadingPromise
}

// Bounded because the two reasons a retry can keep failing are both
// self-limiting-by-nature rather than transient: the server snapshot stays
// behind local (nothing to gain by asking again), or another turn started (the
// next isFinal re-arms us anyway). Delays straddle the fire-and-forget
// persistence window observed in production (sub-second to a few seconds).
const DEFERRED_HYDRATE_DELAYS_MS = [800, 2500, 6000]

/**
 * Settle a hydration debt recorded by `_markHydrateDebt`.
 *
 * Called once a turn ends and the streaming pointers are cleared, which is
 * exactly when the gate that refused the earlier attempt has lifted. Retries
 * are spaced to let the gateway's fire-and-forget server-authored write land;
 * a snapshot that still lacks our tail is refused (not adopted) and simply
 * re-marks the debt, so nothing visible is ever traded away.
 *
 * Gives up quietly after the last delay: the transcript stays rendered (see
 * renderMessages) and the gap banner keeps a manual retry one tap away.
 */
export async function retryDeferredHydration(id, { onHydrated } = {}) {
  for (const delay of DEFERRED_HYDRATE_DELAYS_MS) {
    const sess = state.sessions.get(id)
    if (!sess?._needsFetch || !sess._hydrateDeferred) return
    await new Promise((r) => setTimeout(r, delay))
    const before = state.sessions.get(id)
    if (!before?._needsFetch || !before._hydrateDeferred) return
    // A new turn began — its isFinal will re-arm the debt; don't fight it.
    if (!_canHydrateNow(id, before)) continue
    const hydrated = await hydrateSession(id).catch(() => null)
    if (hydrated && !hydrated._needsFetch) {
      try {
        onHydrated?.(hydrated)
      } catch {}
      return
    }
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

  // Merge list metadata first. Missing / stale sessions become lightweight
  // placeholders instead of triggering a full-body cold-start fan-out.
  let currentSessionUpdated = false
  let fetchedCount = 0
  let metadataCount = 0
  const forcedHydrateIds = new Set()
  const hydrateIds = new Set()
  const fallbackCurrentId = state.currentSessionId || serverList[0]?.id || null
  for (const meta of serverList) {
    const local = state.sessions.get(meta.id) || localMap.get(meta.id)
    if (!local) {
      const sess = _buildSessionFromRemote(meta, null, { placeholder: true })
      _rebuildSearchIndex(sess)
      clearDeleteTombstone(sess.id)
      state.sessions.set(sess.id, sess)
      metadataCount++
      if (meta.id === fallbackCurrentId) hydrateIds.add(meta.id)
      try {
        await dbPut(_sessionDbSnapshot(sess, { _syncedAt: meta.updatedAt }))
      } catch {}
    } else {
      // Server has a newer version than our last sync point (server clock only).
      // Normally we skip the current in-flight session to avoid stomping a
      // live stream — but if something has flagged the session's live
      // stream as authoritatively broken (Phase 0.4 resume_failed sets
      // `_liveStreamBroken = true`), we MUST refetch: the whole point of
      // the force sync is to reconcile from the server-authored tape.
      const live = state.sessions.get(meta.id)
      const remoteTapeLastSeq = _serverTapeLastSeq(meta)
      const localTapeLastSeq = Number.isSafeInteger(local?._tapeLastSeq) ? local._tapeLastSeq : null
      const tapeChanged = remoteTapeLastSeq !== null && remoteTapeLastSeq !== localTapeLastSeq
      const serverMetaNewer = !!local._syncedAt && meta.updatedAt > local._syncedAt
      const liveStreamBroken = !!live?._liveStreamBroken
      if (!serverMetaNewer && !tapeChanged && !liveStreamBroken) {
        if (local._needsFetch && meta.id === fallbackCurrentId) hydrateIds.add(meta.id)
        continue
      }
      if (local._dirty || live?._dirty) continue
      if (meta.id === state.currentSessionId && state.sendingInFlight && !liveStreamBroken) continue
      if (liveStreamBroken && meta.id === fallbackCurrentId) {
        forcedHydrateIds.add(meta.id)
      } else if (meta.id === fallbackCurrentId) {
        hydrateIds.add(meta.id)
      } else {
        const sess = _buildSessionFromRemote(meta, live || local, { placeholder: true })
        if (liveStreamBroken) sess._needsFetch = true
        _rebuildSearchIndex(sess)
        clearDeleteTombstone(sess.id)
        state.sessions.set(sess.id, sess)
        metadataCount++
        try {
          await dbPut(_sessionDbSnapshot(sess, { _syncedAt: meta.updatedAt }))
        } catch {}
      }
    }
  }

  // A replay miss is reconciled immediately only for the visible session.
  // Background sessions retain `_needsFetch/_liveStreamBroken` and hydrate on
  // explicit selection; otherwise one reconnect can fan out into dozens of
  // full transcript downloads.
  for (const id of forcedHydrateIds) {
    const full = await hydrateSession(id, { force: true })
    if (full && !full._needsFetch && !full._liveStreamBroken) {
      fetchedCount++
      if (id === state.currentSessionId || id === fallbackCurrentId) currentSessionUpdated = true
    }
  }

  // Hydrate only the active/fallback session on cold start. This keeps mobile
  // startup bounded even with hundreds of historical sessions on the server.
  let hydrated = 0
  for (const id of hydrateIds) {
    if (hydrated >= AUTO_HYDRATE_RECENT_LIMIT) break
    const before = state.sessions.get(id)
    if (!_canHydrateNow(id, before)) continue
    const full = await hydrateSession(id, { force: true })
    if (full && !full._needsFetch) {
      hydrated++
      fetchedCount++
      if (id === state.currentSessionId || id === fallbackCurrentId) currentSessionUpdated = true
    }
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
      try {
        await dbDelete(id)
      } catch {}
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

  const changedCount = fetchedCount + removedCount + metadataCount
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
  if (sess._needsFetch && sess._syncedAt) {
    console.warn('[sync] refused to push placeholder session before hydration', sess.id)
    return Promise.resolve()
  }
  const {
    _streamingAssistant,
    _streamingThinking,
    _streamingPlan,
    _blockIdToMsgId,
    _sendingInFlight,
    _replyingToMsgId,
    _agentGroups,
    _wfGroups,
    _streamRafPending,
    _thinkRafPending,
    _searchText,
    _needsFetch,
    _messageCount,
    _hydratePromise,
    _hydrating,
    _syncedAt,
    _dirty,
    ...clean
  } = sess
  // Include baseSyncedAt for optimistic concurrency — server rejects if row is newer
  clean._baseSyncedAt = _syncedAt || 0
  const preFlightLastAt = sess.lastAt // snapshot BEFORE PUT for 409 conflict detection
  return apiFetch(`/api/sessions/${sess.id}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(clean),
  })
    .then(async (res) => {
      if (res.ok) {
        const resp = await res.json()
        if (resp?.applied && resp.updatedAt) {
          sess._syncedAt = resp.updatedAt
          sess._dirty = false
          sess._conflictRetryCount = 0 // successful PUT clears 409 retry cap
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

          const keepLocalAfterConflict = async (activeLoss = null) => {
            // LOCAL DOMINATES — keep local messages, adopt server metadata.
            //
            // Messages: local is a clean superset, so we retain it (the
            // primary bug: streaming assistant prefix extension gets dropped
            // if we overwrite). The active-stream deferred branch only calls
            // this helper after proving every server row is represented
            // locally, allowing a missing local-only active row to stay visible.
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
            _mergeServerPlanFields(server.messages, target.messages)

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
            target._dirty = true // need a follow-up PUT to push our messages

            const prev = target._conflictRetryCount || 0
            target._conflictRetryCount = prev + 1

            // Rebuild search index if title shifted — _searchText cache
            // preferred by sidebar filter would otherwise still match old title.
            if (titleChanged) _rebuildSearchIndex(target)

            try {
              await dbPut({ ...target })
            } catch {}
            if (activeLoss) {
              console.warn(
                '[sync] server-wins-deferred-active-stream',
                _activeStreamLogPayload(target, server.messages, activeLoss),
              )
            }
            // Pass 'local-dominates' so the UI can skip renderMessages() — local
            // messages are preserved in this branch, only sidebar metadata may
            // have shifted. Without this tag, every 409 in a long streaming
            // session redrew the whole messages pane (innerHTML='' + 100-row
            // rebuild) and the user saw a flicker per 409.
            try {
              _onConflictResolved?.(target.id, 'local-dominates')
            } catch {}

            if (target._conflictRetryCount <= CONFLICT_RETRY_MAX && _onRequestRetryPush) {
              try {
                _onRequestRetryPush(target.id)
              } catch {}
            } else {
              console.warn(
                '[sync] 409 auto-retry cap reached for',
                target.id,
                '— leaving dirty; next user action or save-cycle will retry',
              )
            }
          }

          if (_localDominates(server.messages, live.messages)) {
            await keepLocalAfterConflict()
            return
          }

          const activeLoss = _activeStreamLoss(live, server.messages)
          if (
            activeLoss &&
            _localDominatesAllowingMissingActive(
              server.messages,
              live.messages,
              _activeStreamIds(live),
            )
          ) {
            await keepLocalAfterConflict(activeLoss)
            return
          }

          // (b) SERVER WINS — adopt server state.
          // Retain original guard: if user typed while PUT was in flight,
          // keep local (the new edits push on the next save tick). strict
          // `>` is intentional here because we already know local is NOT
          // a superset of server, so equal lastAt means no new user edit
          // and server really has data we don't.
          if (live._dirty && live.lastAt > preFlightLastAt) return

          if (activeLoss) {
            console.warn(
              '[sync] server-wins-active-stream-loss',
              _activeStreamLogPayload(target, server.messages, activeLoss),
            )
          }

          Object.assign(target, {
            title: server.title,
            messages: server.messages || [],
            lastAt: server.lastAt,
            pinned: server.pinned,
            agentId: server.agentId,
            _syncedAt: server.updatedAt,
            _dirty: false,
            _needsFetch: false,
            _messageCount: Array.isArray(server.messages) ? server.messages.length : 0,
          })
          // Invalidate runtime maps so they get rebuilt from new messages on next handleOutbound
          target._blockIdToMsgId = null
          target._agentGroups = null
          target._wfGroups = null
          target._conflictRetryCount = 0 // server-wins adoption resets the cap
          _rebindStreamingPointers(target)
          _rebuildSearchIndex(target)
          try {
            await dbPut(_sessionDbSnapshot(target, { _syncedAt: server.updatedAt }))
          } catch {}
          // Notify UI so the user sees the new messages / title instead of
          // a stale view. Without this, the session object is updated but
          // the DOM stays on the old snapshot until the next full sync.
          // 'server-wins' tag tells the UI to fully re-render messages because
          // sess.messages was just overwritten.
          try {
            _onConflictResolved?.(target.id, 'server-wins')
          } catch {}
        } catch {}
      }
    })
    .catch(() => {})
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
      apiJson('DELETE', `/api/sessions/${id}`)
        .then(() => _pendingDeletes.delete(id))
        .catch(() => {})
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
export function maybeSyncNow({
  force = false,
  minIntervalMs = 15000,
  onResult,
  freshAfterInFlight = false,
} = {}) {
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
          try {
            maybeSyncNow({ force: true })
          } catch {}
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
        try {
          entry.onResult(result)
        } catch (err) {
          try {
            console.error('[sync] onResult callback threw', err)
          } catch {}
        }
      }
      return result
    })
    .finally(() => {
      _syncInFlight = null
    })
  return _syncInFlight
}
