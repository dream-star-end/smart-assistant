// OpenClaude — Cross-device session sync
// Syncs frontend sessions (IndexedDB) with server-side storage (SQLite).
// Server is source of truth for session list; local IDB is cache + offline fallback.

import { apiFetch, apiGet, apiJson, authHeaders } from './api.js?v=9a2a2442'
import { dbGetAll, dbPut, dbDelete } from './db.js?v=9a2a2442'
import { _rebuildSearchIndex, clearDeleteTombstone, isDeletePending } from './sessions.js?v=9a2a2442'
import { state } from './state.js?v=9a2a2442'
import { trace } from './trace.js?v=9a2a2442'

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
let _onSessionAutoCompacted = null
// Dep-injected: fired the FIRST time a session's PUT comes back 413 (server
// rejected the row as oversized — see MAX_SESSION_BYTES on the storage
// side). UI should toast the user with actionable guidance ("delete
// attachments / start a new session") since further auto-PUT attempts on
// this session are now disabled. Re-fired only when sess._oversized
// transitions false→true, so a session that ping-pongs across reloads
// won't keep flooding the toast queue.
let _onSessionOversized = null
export function setSyncDeps({ onConflictResolved, onRequestRetryPush, onSyncStatusChange, onSessionOversized, onSessionAutoCompacted }) {
  _onConflictResolved = onConflictResolved
  _onRequestRetryPush = onRequestRetryPush
  _onSyncStatusChange = onSyncStatusChange
  _onSessionOversized = onSessionOversized
  _onSessionAutoCompacted = onSessionAutoCompacted
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

// Server-authored fields that may be patched on the server independently
// of message text (usage backfill via pending_usage_patches, _seq re-allocation
// when a server-authored row was substituted by Phase 0.1 takeover, etc.).
// When local-supersedes wins on text, we still overlay these from server.
const _SERVER_AUTH_KEYS = ['_seq', '_source', 'usage', '_truncated', '_errorCode', '_errorDetail']

/**
 * Overlay server-authoritative metadata onto a local message that won
 * the supersede check on text. Returns the original `localMsg` reference
 * unchanged when no field differs (so WeakMap-keyed DOM reconcile can
 * detect "no content change" and skip an `updateMessageEl()` re-render),
 * or a fresh `{ ...localMsg, ...changedFields }` when at least one field
 * differs (so reconcile detects ref change and re-renders).
 *
 * Why returning the same ref when unchanged matters: messages.js's
 * incremental render reconcile uses object identity (WeakMap) as its
 * "is this DOM node still up-to-date" signal. Always allocating a new
 * object would defeat the optimization, churning DOM for unchanged rows.
 *
 * Why `status` is gated on `_source==='server'`: same rationale as the
 * legacy 409 in-place overlay at sync.js:~819 — `user` and client-mirrored
 * assistant statuses (sending/sent/read) are client-owned UI flags; only
 * server-authored rows carry authoritative terminal status (completed,
 * interrupted) that should overlay.
 */
export function _overlayServerAuthoritative(localMsg, serverMsg) {
  if (!localMsg || !serverMsg) return localMsg
  let changed = false
  let overlay = null
  for (const k of _SERVER_AUTH_KEYS) {
    if (serverMsg[k] !== undefined && serverMsg[k] !== localMsg[k]) {
      if (!overlay) overlay = {}
      overlay[k] = serverMsg[k]
      changed = true
    }
  }
  if (serverMsg._source === 'server' &&
      serverMsg.status !== undefined &&
      serverMsg.status !== localMsg.status) {
    if (!overlay) overlay = {}
    overlay.status = serverMsg.status
    changed = true
  }
  return changed ? { ...localMsg, ...overlay } : localMsg
}

/**
 * Merge a server-authored timeline into local messages. Used at every
 * client-side sync convergence point: full sync, partial-tail sync,
 * 409 local-dominates, 409 server-wins.
 *
 * **v7 (2026-05-12) — single-id-authority architecture**
 *
 * The dual-id problem (client `m-${ts36}-${rand}` + server `srv-${peerId}-tN`
 * for the same logical assistant message) used to force this merger to
 * do anchor-keyed turn-group phantom dedupe, _seq-based "did server once
 * know this row" discrimination, and a streaming-tail-grace heuristic.
 * Each of these papered over a different symptom of the underlying
 * "same row has two different ids on the two tapes" disease, and the
 * v5 / v6 mobile flash-and-loss bug kept re-emerging in new forms.
 *
 * v7 fixes it at the source:
 *   - Gateway mints `srv-${peerId}-t${turnIndex}` once per turn and stamps
 *     it on every outbound text/thinking block via `messageId` (see
 *     packages/protocol/src/frames.ts, packages/gateway/src/ccbMessageParser.ts).
 *   - Client websocket.js adopts that id as the streaming row id from the
 *     first frame (modules/websocket.js:2002 text / :2043 thinking).
 *   - Master Phase 0.1 takeover writes the final canonical row under the
 *     SAME id (packages/storage/src/sessionsDb.ts:903 `appendServerAuthoredPure`
 *     overlay branch).
 *
 * With ids aligned on both tapes, the merger collapses to id-based union
 * with server-authored overlay:
 *
 *   1. For each local row with a same-id server counterpart: overlay
 *      server-authoritative fields onto local (see _overlayServerAuthoritative
 *      — preserves WeakMap-keyed DOM reconcile fast path when nothing
 *      differs, returns fresh ref when at least one auth field changes).
 *   2. For each local row with no server counterpart: keep as-is.
 *      This covers in-flight streaming rows (server takeover not yet
 *      written), client-only empty-turn notices, and queued user msgs.
 *   3. Append server-only rows (ids the client hasn't seen yet — cross-
 *      tab user messages, cross-device additions).
 *   4. ts-sort for display order. Per v7.2 (line ~321) same-id rows keep
 *      local ts as the visual SORT key, so the rendered order after sync
 *      matches what the user saw during live streaming. No within-turn
 *      canonical-kind reordering — see "v7.4 dropped _enforceTurnGroupOrder"
 *      note above line ~334 for the reasoning.
 *   5. Legacy IDB migration backstop (see `_dropLegacyClientStreamRows`):
 *      drop pre-v7 `m-*` assistant/thinking rows that have a matching
 *      `srv-*` server row in the same turn. Strict predicate, scheduled
 *      for removal post v1.0.140 + 14 days.
 *
 * **Trade-off explicitly accepted (was 5-step anchor algorithm's job)**:
 *   - Cross-tab DELETE: tab A deletes a row → server timeline shorter →
 *     tab B's GET → tab B's id-union keeps the local row as a ghost
 *     until the user refreshes. The previous _seq-based discriminator
 *     was the only thing handling this; bringing it back would resurrect
 *     the symptom-patching mode this rewrite exits. Cross-tab delete is
 *     rare and reversible; flash-and-loss on streaming is high-frequency
 *     and breaks user trust. Explicit trade.
 *
 * @param serverMsgs server-side authoritative timeline (from REST GET)
 * @param localMsgs current local messages (may contain streaming tail)
 * @returns new merged array (never the same ref as either input)
 */
export function _mergeServerAuthoredIntoLocal(serverMsgs, localMsgs) {
  const serverArr = Array.isArray(serverMsgs) ? serverMsgs : []
  const localArr = Array.isArray(localMsgs) ? localMsgs : []
  // Fast path: nothing on server. Return a fresh slice so the caller can
  // mutate without aliasing local. Skipping ts-sort also avoids reordering
  // a local-only array against insertion order when caller hasn't yet
  // stamped ts on every row.
  if (serverArr.length === 0) return localArr.slice()

  const serverById = new Map()
  for (const sm of serverArr) {
    if (sm && typeof sm.id === 'string') serverById.set(sm.id, sm)
  }

  const merged = []
  const consumedFromServer = new Set()
  for (const lm of localArr) {
    if (!lm) continue
    if (typeof lm.id !== 'string') {
      // Defensive: id-less local rows. All persisted rows have string ids;
      // this branch only catches transient mid-frame state.
      merged.push(lm)
      continue
    }
    const sm = serverById.get(lm.id)
    if (sm) {
      consumedFromServer.add(lm.id)
      // Direction: _localMessageSupersedes decides who wins on TEXT.
      //   - Layer 1 equality OR Layer 2 streaming-prefix extension → local
      //     wins, overlay server-authored fields (_seq/_source/usage/...)
      //     onto it. Preserves WeakMap-keyed DOM reconcile fast path.
      //   - Otherwise (server has genuinely different text — e.g. Phase 0.1
      //     takeover wrote canonical text replacing client's partial, or a
      //     stale post-reload client) → server wins outright.
      // This isn't the anchor/turn-group machinery v5/v6 layered on top;
      // it's the same per-row text adjudication v6 used as its step 2,
      // unchanged. v7 only removes the WHOLE-TIMELINE phantom-dedupe
      // (anchor map / _seq cross-tab discriminator), not this same-id
      // direction choice — which is independent of id authority.
      if (_localMessageSupersedes(lm, sm)) {
        merged.push(_overlayServerAuthoritative(lm, sm))
      } else {
        // v7.2 (2026-05-13) — INVARIANT: for any row whose id appears on
        // both client (streamed) and server (persisted), the client's
        // `ts` is the authoritative visual SORT key — it captures the
        // actual arrival order the user saw render. Server's content
        // (text/output/inputJson/_seq/usage/status) stays authoritative;
        // only the visual POSITION belongs to whoever saw the row first.
        //
        // Why this matters (the v1.0.135 tool-row regression):
        //   Server ts comes from `body.createdAt = Date.now()` at
        //   `persistServerAuthoredTurn` invocation — POST-stream. For
        //   tool rows, `_localMessageSupersedes` returns false here
        //   (tool role not in Layer 2 whitelist; Layer 1 stableStringify
        //   fails on `_seq`/`_source`/`status` divergence) → server
        //   wins. Without this ts preservation, tool ts ≈ baseTs - 1 >
        //   client's assistant ts T3, sorting the tool card BELOW the
        //   assistant text the user already saw render above it.
        merged.push({ ...sm, ts: lm.ts ?? sm.ts })
      }
    } else {
      // Local-only row: streaming tail (server takeover not yet written),
      // empty-turn notice (`m-*` no server counterpart by design), or a
      // user msg the client hasn't PUT'd yet. All must survive.
      merged.push(lm)
    }
  }
  for (const sm of serverArr) {
    if (!sm || typeof sm.id !== 'string') continue
    if (!consumedFromServer.has(sm.id)) merged.push(sm)
  }
  // v7.4 (2026-05-13) — DROPPED `_enforceTurnGroupOrder`. v7.3 used to
  // force within-turn srv-* rows into thinking(0) < tool(1) < assistant(2)
  // by canonical-id kind. That reorder was the direct cause of the iOS
  // Safari "scroll → flicker" symptom: live stream rendered rows in their
  // natural CCB/codex emit order, but on visibilitychange/focus/pageshow
  // triggered sync → merge → reorder, the same turn's rows jumped into a
  // different visual layout and the user saw a one-frame flicker.
  //
  // Why ts-sort is sufficient on its own: v7.2 (line ~321) preserves
  // local `ts` on same-id rows during the server-wins branch, so a turn
  // that arrived as thinking(T1) → tool(T2) → assistant(T3) keeps that
  // ts order across sync — ts-sort below produces exactly the live-stream
  // visual order. v7.3's kind-based reorder fought this and was wrong
  // for any agent that emits text BEFORE tool_use (DeepSeek preamble
  // pattern, codex agentic flows, sonnet thinking-then-text).
  //
  // Known trade-off (Fix B scope, separate PR): a turn with text₁ → tool →
  // text₂ currently merges text₁+text₂ into ONE assistant row (gateway
  // stamps both with the same `srv-${peer}-tN` messageId). After this
  // drop, the merged-assistant row keeps text₁'s ts (lower than tool's),
  // so it visually renders ABOVE the tool card — same as during live
  // stream. The proper fix is per-content-block row ids; that's tracked
  // separately as "Fix B".
  merged.sort((a, b) => ((a?.ts ?? 0) - (b?.ts ?? 0)))

  return _dropLegacyClientStreamRows(merged)
}

/**
 * Legacy IDB migration backstop. **Technical debt** — slated for removal
 * once v1.0.135+ (the v7 cutover + v7.1 tool-row alignment) has been
 * live 14 days (`_LEGACY_DROP_REMOVAL_TRIGGER` below).
 *
 * Problem this solves:
 *  - v6 (≤ v1.0.132): m-${ts36}-${rand} assistant/thinking client rows
 *    coexisted with srv-* server-authored rows for the same logical
 *    message. After v7 cutover id-union would keep BOTH.
 *  - v7.0 (v1.0.134): tool_use rows missed the canonical-id treatment —
 *    client created `m-*` tool rows during streaming while master
 *    persisted `srv-${peerId}-tN-tool-${blockId}` server-authored tool
 *    rows. id-union kept both, server tool ts > client tool ts after
 *    sort → server tool cards visually rendered AFTER assistant text
 *    (the "post-completion flash" boss observed).
 *
 * Strict predicate (narrow on purpose — must NOT accidentally drop any
 * row outside the documented upgrade cases):
 *
 *   Drop merged row R iff ALL of:
 *     (a) R.role ∈ {assistant, thinking, tool}
 *     (b) typeof R.id === 'string' && R.id.startsWith('m-')
 *     (c) R._source !== 'server'  — R is a client placeholder, not a
 *         canonical server row
 *     (d) The same turn group (bounded by the next user/system row
 *         walking forward) contains a counterpart R2:
 *           - assistant: R2.role === 'assistant' && R2.id startsWith 'srv-'
 *           - thinking:  R2.role === 'thinking'  && R2.id startsWith 'srv-'
 *           - tool:      R2.role === 'tool' && R2._source === 'server' && R2.blockId === R.blockId
 *         Pre-Fix-B variant additionally checked `R2.id endsWith '-thinking'`
 *         on the thinking branch; after Fix B server thinking ids end with
 *         `-thinking-s${N}` and `R2.role === 'thinking'` is sufficient.
 *     Otherwise: keep.
 *
 * Anything that fails any of (a)-(d) is kept — including:
 *   - Empty-turn notice rows (no srv-* counterpart → kept)
 *   - In-flight streaming rows whose id is already `srv-*` (fail (b))
 *   - User rows (fail (a))
 *   - Server-authored rows themselves (fail (c))
 *   - Tool rows whose blockId doesn't match any server tool (fail (d))
 *
 * **Known false-negative (accepted strict-predicate trade-off)**: if a
 * legacy server-authored tool row's `ts` lands AFTER the next user
 * message (rare — master writes tool ts = `baseTs - N + i` ~= turn-end,
 * which is normally before the next user msg), the user-boundary group
 * partition will place it in the NEXT turn group from its counterpart
 * `m-*` client tool, and (d) will not match. Result: a single duplicate
 * tool card lingers for that turn. Strict false-negative > strict
 * false-positive (we never want to drop unrelated rows).
 *
 * Walk is single-pass: collect turn boundaries from the merged array
 * order (ts-sorted by caller). Per turn, build sets of "has srv-asst" /
 * "has srv-thinking" / "set of server-tool blockIds", then second pass
 * drops legacy `m-*` rows whose group has the matching counterpart.
 */
// _LEGACY_DROP_REMOVAL_TRIGGER: "remove after v1.0.135 has been live 14 days"
function _dropLegacyClientStreamRows(merged) {
  // Phase 1: walk merged once, assigning each row a numeric turn-group
  // index. Each user/system row starts a new group (its own index).
  // Rows before the first user/system get group 0.
  const groupOf = new Array(merged.length)
  let group = 0
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]
    if (m && (m.role === 'user' || m.role === 'system')) group += 1
    groupOf[i] = group
  }

  // Phase 2: per group, record whether srv-* assistant / thinking
  // counterparts exist, and gather the set of server-authored tool
  // blockIds. Tool predicate keys on `_source === 'server'` + matching
  // `blockId` rather than id-prefix because (a) tool ids may come from
  // master as `srv-${sessionId}-t${turnIndex}-tool-${blockId}` AND
  // (b) the canonical authority signal for tools is `_source === 'server'`
  // — same as storage's `mergePreservingServerAuthored:875-887`.
  const hasSrvAsst = new Map()           // group → true
  const hasSrvThinking = new Map()       // group → true
  const groupServerToolBids = new Map()  // group → Set<blockId>
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]
    if (!m) continue
    if (typeof m.id === 'string' && m.id.startsWith('srv-')) {
      // Fix B (2026-05-25): role-based discriminator instead of id-suffix.
      // After Fix B, server thinking ids end with `-thinking-s${N}` (per-
      // segment row), not bare `-thinking`. The `m.role === 'thinking'`
      // check already guarantees we're on the right row class; the
      // historical suffix guard was defensive and now wrong. Same logic
      // applies to assistant — Fix B ids end with `-s${N}`, never
      // `-thinking`, so the assistant branch's negative suffix check
      // becomes structurally always-true and is removed.
      if (m.role === 'assistant') {
        hasSrvAsst.set(groupOf[i], true)
      } else if (m.role === 'thinking') {
        hasSrvThinking.set(groupOf[i], true)
      }
    }
    if (m.role === 'tool' && m._source === 'server' &&
        typeof m.blockId === 'string' && m.blockId.length > 0) {
      const g = groupOf[i]
      let set = groupServerToolBids.get(g)
      if (!set) { set = new Set(); groupServerToolBids.set(g, set) }
      set.add(m.blockId)
    }
  }

  // Phase 3: drop the strict legacy rows.
  const out = []
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]
    if (!m) { out.push(m); continue }
    const role = m.role
    if ((role === 'assistant' || role === 'thinking' || role === 'tool') &&
        typeof m.id === 'string' &&
        m.id.startsWith('m-') &&
        m._source !== 'server') {
      const g = groupOf[i]
      if (role === 'assistant' && hasSrvAsst.get(g)) continue
      if (role === 'thinking' && hasSrvThinking.get(g)) continue
      if (role === 'tool' &&
          typeof m.blockId === 'string' &&
          m.blockId.length > 0 &&
          groupServerToolBids.get(g)?.has(m.blockId)) continue
    }
    out.push(m)
  }
  return out
}

/**
 * Rebuild `_blockIdToMsgId` and `_agentGroups` runtime maps from the
 * current sess.messages array. Used after a sync replaces sess.messages
 * (full fetch / partial / 409 adoption): naive `null`-then-lazy-init at
 * the next WS frame had a race where an inbound tool_result for a
 * `partial=true` tool_use card would fail to find its parent map entry
 * if the new server messages didn't include the partial row.
 *
 * Mirrors the lazy-init at websocket.js:~1693 (including the
 * subagent grand-child handling) so both code paths build the same map
 * shape.
 */
export function _rebuildBlockMaps(sess) {
  const blockIdToMsg = new Map()
  const agentGroups = new Map()
  for (const m of sess?.messages || []) {
    if (!m) continue
    if (m.blockId) blockIdToMsg.set(m.blockId, m.id)
    if (m.role === 'agent-group' && m.blockId) {
      agentGroups.set(m.blockId, m.id)
      if (Array.isArray(m.childBlocks)) {
        for (const ch of m.childBlocks) {
          if (
            ch &&
            ch.kind === 'tool_use' &&
            ch.blockId &&
            /^Agent$/i.test(ch.toolName || '')
          ) {
            agentGroups.set(ch.blockId, m.id)
          }
        }
      }
    }
  }
  sess._blockIdToMsgId = blockIdToMsg
  sess._agentGroups = agentGroups
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
 * Three-step protocol (the order matters — see Codex review thread for
 * blocking-comment trail):
 *
 *   1. Build the **server-visible** merged array: walk local rows in
 *      order, replacing/appending from `tail` by id. On same-id rows
 *      that pass `_localMessageSupersedes`, retain local but overlay
 *      server-authoritative metadata via `_overlayServerAuthoritative`
 *      so `_seq` lines up with what the server sees. Local-only rows
 *      that the partial-tail protocol cannot describe (no `_seq` —
 *      i.e. client streaming tails) are EXCLUDED from this step.
 *
 *   2. Sanity check the server-visible merged array against the server's
 *      reported `totalMessageCount` / `maxSeq`. Any mismatch means the
 *      partial protocol cannot reconcile (cross-device delete, server
 *      bug, hole in local timeline) — return null so caller falls back
 *      to full GET. Doing this BEFORE appending client-only tail is
 *      critical: counting client-only rows in the sanity check would
 *      always fail when local has a fresh streaming tail.
 *
 *   3. Run `_mergeServerAuthoredIntoLocal(serverVisible, local)` to produce
 *      the final array. This re-applies the symmetric union+turn-group-
 *      dedupe semantics, preserving in-flight client streaming tails while
 *      dropping phantoms once server takeover landed. Mirrors the algorithm
 *      used at the full-sync and 409-resolution paths — single source of
 *      truth for "server timeline + local streaming tail" convergence.
 *
 * Why we can keep local with overlay (step 1) instead of forcing server
 * replacement: server-visible rows that local-supersedes either equal
 * server (Layer 1) or extend it (Layer 2 streaming prefix). Both cases
 * leave the timeline correct; overlay restores `_seq/usage/...` so the
 * sanity arithmetic still works.
 */
export function _mergePartialTail(localMessages, tail, expectedCount, expectedMaxSeq) {
  const local = Array.isArray(localMessages) ? localMessages : []
  const tailArr = Array.isArray(tail) ? tail : []
  const tailById = new Map()
  for (const m of tailArr) {
    if (m && typeof m.id === 'string') tailById.set(m.id, m)
  }
  // Step 1: build server-visible merged array, excluding client-only tail.
  const serverVisible = []
  const placedIds = new Set()
  for (const l of local) {
    if (!l || typeof l.id !== 'string') continue
    const t = tailById.get(l.id)
    if (t) {
      // Same-id present in partial response. Decide local-vs-server per
      // supersede; overlay server-auth fields on the winning local.
      if (_localMessageSupersedes(l, t)) {
        serverVisible.push(_overlayServerAuthoritative(l, t))
      } else {
        serverVisible.push(t)
      }
      placedIds.add(l.id)
    } else {
      // Local-only row from the prefix that the partial response doesn't
      // describe (server already had it; partial only carries the tail).
      // Keep as-is — it's part of the server-visible timeline already.
      // BUT: defensively exclude rows that look like client streaming
      // tail (no `_seq`) — those will be re-appended in step 3 and we
      // don't want them double-counted.
      if (typeof l._seq === 'number') {
        serverVisible.push(l)
      }
    }
  }
  // Append tail rows that local didn't have at all.
  for (const t of tailArr) {
    if (!t || typeof t.id !== 'string') continue
    if (placedIds.has(t.id)) continue
    serverVisible.push(t)
  }
  // Step 2: sanity check against server's reported totals.
  if (serverVisible.length !== expectedCount) return null
  let serverVisibleMaxSeq = 0
  for (const m of serverVisible) {
    const s = m && typeof m._seq === 'number' ? m._seq : 0
    if (s > serverVisibleMaxSeq) serverVisibleMaxSeq = s
  }
  if (serverVisibleMaxSeq !== expectedMaxSeq) return null
  // Step 3: apply the canonical server-authored merger over the
  // serverVisible view + the full local array. This brings back any client-
  // only streaming tail (local rows without _seq that weren't included in
  // serverVisible) and runs the turn-group dedupe that drops client phantoms
  // when server takeover already exists. Symmetric with full-sync and
  // 409-resolution code paths.
  return _mergeServerAuthoredIntoLocal(serverVisible, local)
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
          // _mergePartialTail may have preserved local refs (streaming
          // tail rows, supersede-winning tool-overlay rows). Rebuild the
          // block-id maps from the merged messages so subsequent WS
          // frames route correctly; rebind streaming pointers in case
          // their target rows changed identity through overlay.
          _rebuildBlockMaps(sess)
          _rebindStreamingPointers(sess)
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
          // v7.2 — same invariant as `_mergeServerAuthoredIntoLocal`'s
          // server-wins branch: server content is authoritative, but
          // local ts wins as the visual sort key for any row the client
          // saw stream in. Without this, this resume_failed recovery
          // path would resurrect the post-stream server ts and put
          // tool/thinking cards below the assistant text.
          out.push({ ...server, ts: local.ts ?? server.ts })
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
      // v7.4 (2026-05-13): preserve local insertion order; append
      // server-only rows after the local walk; no within-turn canonical
      // reorder. This recovery branch already walks local ordering when
      // building `out` (line ~975), then appends cross-device server-
      // only rows below. Removing the v7.3 reorder here matches the main
      // `_mergeServerAuthoredIntoLocal` change above — the same flicker
      // we kill on the main path would otherwise re-emerge on the
      // resume_failed recovery path.
      mergedMessages = out
    } else if (existingLocal?._dirty && !existingLocal?._liveStreamBroken) {
      continue
    }
    // When the _liveStreamBroken+_dirty branch above already produced a
    // `mergedMessages`, use that (it preserves pending-user-msg ordering).
    // Otherwise route the server payload through `_mergeServerAuthoredIntoLocal`,
    // which mirrors the server-side `mergePreservingServerAuthored`: client
    // streaming tail is kept as a local-only row until server's Phase 0.1
    // takeover lands, at which point the turn-group dedupe drops the phantom.
    // Pre-2026-05-12 this was a bare `remote.messages || []` and lost the
    // trailing assistant text when visibilitychange/focus/pageshow fired in
    // the brief window between a turn ending and the server-side tape
    // catching up.
    const sess = {
      id: remote.id,
      title: remote.title,
      createdAt: remote.createdAt,
      lastAt: remote.lastAt,
      messages: mergedMessages || _mergeServerAuthoredIntoLocal(
        remote.messages || [],
        existingLocal?.messages || [],
      ),
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
    // The merger above may keep local refs (streaming-tail rows, supersede-
    // winning tool/agent rows). Rebuild block-id maps from the resulting
    // messages so subsequent WS frames find their parent cards; rebind
    // streaming pointers in case server overlay returned new object refs
    // for the same id.
    if (existingLocal) {
      _rebuildBlockMaps(sess)
      _rebindStreamingPointers(sess)
    }
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
 * inputPreview / partialJson / metaText 一直没清,会跟着 PUT body 上服务器,
 * 污染权威源。
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
// `partialJson` is the gateway-streamed `input_json_delta` accumulator,
// useful only while a tool_use block is still open; never persisted.
// Note: comments INSIDE the array literal would be misparsed by
// pureFunctions.test.ts's contract self-check regex — keep them out.
const _MSG_EPHEMERAL_KEYS = [
  '_rawMeta',
  '_partial',
  '_completed',
  'output',
  'error',
  'bashTail',
  'inputJson',
  'inputPreview',
  'partialJson',
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

const PREFLIGHT_MAX_BYTES = 1.9 * 1024 * 1024
const AUTO_COMPACT_TARGET_BYTES = 1.45 * 1024 * 1024
const DATA_URI_RE = /^data:[^,;]+(?:;[^,;]+)*;base64,/
const DATA_URI_MIN_STRIP_CHARS = 4 * 1024

export function _jsonBytes(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return new TextEncoder().encode(s).length
}

function _deepCloneJson(v) {
  return JSON.parse(JSON.stringify(v))
}

export function _deepStripInlineBase64ForSync(value, counters = { inlineBase64Stripped: 0 }) {
  if (typeof value === 'string') {
    if (value.length >= DATA_URI_MIN_STRIP_CHARS && DATA_URI_RE.test(value)) {
      counters.inlineBase64Stripped++
      return `[stripped:base64,bytes=${value.length}]`
    }
    return value
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = _deepStripInlineBase64ForSync(value[i], counters)
    }
    return value
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      value[k] = _deepStripInlineBase64ForSync(value[k], counters)
    }
  }
  return value
}

export function _stripMediaArrayForSync(msg, now = Date.now()) {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg._media)) return 0
  let stripped = 0
  for (let i = 0; i < msg._media.length; i++) {
    const entry = msg._media[i]
    if (!entry || typeof entry !== 'object') continue
    const hasHeavy =
      (typeof entry.base64 === 'string' && entry.base64.length > 0) ||
      (typeof entry.dataUrl === 'string' && entry.dataUrl.length > 0)
    if (!hasHeavy) continue
    const size =
      typeof entry.size === 'number'
        ? entry.size
        : typeof entry.base64 === 'string'
          ? entry.base64.length
          : typeof entry.dataUrl === 'string'
            ? entry.dataUrl.length
            : 0
    msg._media[i] = {
      kind: entry.kind || 'file',
      mimeType: entry.mimeType || null,
      filename: entry.filename || null,
      size,
      base64Stripped: true,
      strippedAt: now,
    }
    stripped++
  }
  return stripped
}

function _messageSortKey(m, idx) {
  const ts = typeof m?.ts === 'number' && Number.isFinite(m.ts) ? m.ts : idx
  return { ts, idx }
}

function _buildCompactedMessageList(stageMsgs, keepClient, placeholder) {
  const out = []
  let insertedPlaceholder = false
  for (const m of stageMsgs) {
    if (m && m._source === 'server') {
      out.push(m)
      continue
    }
    if (keepClient.has(m)) {
      out.push(m)
      continue
    }
    if (!insertedPlaceholder) {
      out.push(placeholder)
      insertedPlaceholder = true
    }
  }
  if (!insertedPlaceholder) out.unshift(placeholder)
  return out
}

export function _autoCompactMessagesForSync(messages, opts = {}) {
  if (!Array.isArray(messages)) return null
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : PREFLIGHT_MAX_BYTES
  const targetBytes = Math.min(
    Number.isFinite(opts.targetBytes) ? opts.targetBytes : AUTO_COMPACT_TARGET_BYTES,
    maxBytes,
  )
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const sessionId = typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : 'session'

  const stage = _deepCloneJson(messages)
  const counters = { mediaStripped: 0, inlineBase64Stripped: 0 }
  for (const m of stage) {
    if (m && m._source === 'server') continue
    counters.mediaStripped += _stripMediaArrayForSync(m, now)
    _deepStripInlineBase64ForSync(m, counters)
  }

  const strippedBytes = _jsonBytes(stage)
  if (strippedBytes <= maxBytes) {
    return {
      messages: stage,
      finalBytes: strippedBytes,
      mediaStripped: counters.mediaStripped,
      inlineBase64Stripped: counters.inlineBase64Stripped,
      droppedCount: 0,
      droppedBytes: 0,
      truncated: false,
    }
  }

  const serverMessages = stage.filter((m) => m && m._source === 'server')
  if (_jsonBytes(serverMessages) > maxBytes) return null

  const indexed = stage.map((m, idx) => ({ msg: m, idx, ..._messageSortKey(m, idx) }))
  const clientCandidates = indexed
    .filter((x) => !(x.msg && x.msg._source === 'server'))
    .map((x) => ({ ...x, bytes: _jsonBytes(x.msg) + 2 }))
  const newestFirst = clientCandidates.slice().sort((a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts
    return b.idx - a.idx
  })
  const oldestFirst = newestFirst.slice().reverse()

  let used = _jsonBytes(serverMessages) + 256
  const keepClient = new Set()
  for (const c of newestFirst) {
    if (used + c.bytes <= targetBytes) {
      keepClient.add(c.msg)
      used += c.bytes
    }
  }

  const droppedInitial = clientCandidates.filter((c) => !keepClient.has(c.msg))
  const droppedBytesInitial = droppedInitial.reduce((acc, c) => acc + c.bytes, 0)
  const earliestDropped = droppedInitial.reduce(
    (best, c) => (best === null || c.idx < best.idx ? c : best),
    null,
  )
  const placeholder = {
    id: `auto-compact-${sessionId}-${now}`,
    role: 'system',
    text:
      `【自动上下文压缩】为避免会话过大导致同步失败，已折叠较早的 ${droppedInitial.length} 条客户端消息；` +
      `最近消息和服务端权威记录已保留。`,
    ts: earliestDropped ? (typeof earliestDropped.msg?.ts === 'number' ? earliestDropped.msg.ts : now) : now,
  }

  let finalMessages = _buildCompactedMessageList(stage, keepClient, placeholder)
  let finalBytes = _jsonBytes(finalMessages)
  for (const c of oldestFirst) {
    if (finalBytes <= maxBytes) break
    if (!keepClient.has(c.msg)) continue
    keepClient.delete(c.msg)
    finalMessages = _buildCompactedMessageList(stage, keepClient, placeholder)
    finalBytes = _jsonBytes(finalMessages)
  }
  if (finalBytes > maxBytes) return null

  const droppedCount = clientCandidates.filter((c) => !keepClient.has(c.msg)).length
  const droppedBytes = clientCandidates
    .filter((c) => !keepClient.has(c.msg))
    .reduce((acc, c) => acc + c.bytes, 0)
  placeholder.text =
    `【自动上下文压缩】为避免会话过大导致同步失败，已折叠较早的 ${droppedCount} 条客户端消息；` +
    `最近消息和服务端权威记录已保留。`

  return {
    messages: finalMessages,
    finalBytes,
    mediaStripped: counters.mediaStripped,
    inlineBase64Stripped: counters.inlineBase64Stripped,
    droppedCount,
    droppedBytes: droppedBytes || droppedBytesInitial,
    truncated: droppedCount > 0,
  }
}

function _prepareAutoCompactCandidate(sess, clean, bodyBytes) {
  const live = state.sessions.get(sess.id) || sess
  const result = _autoCompactMessagesForSync(live.messages || [], {
    maxBytes: PREFLIGHT_MAX_BYTES,
    targetBytes: AUTO_COMPACT_TARGET_BYTES,
    sessionId: live.id || sess.id,
  })
  if (!result) return null
  const wireMessages = _stripMessageEphemeral(result.messages)
  const compactClean = { ...clean, messages: wireMessages }
  const body = JSON.stringify(compactClean)
  const bytes = _jsonBytes(body)
  if (bytes >= bodyBytes || bytes > PREFLIGHT_MAX_BYTES) return null
  return {
    ...result,
    liveMessages: result.messages,
    wireMessages,
    body,
    bytes,
  }
}

async function _commitAutoCompactCandidate(sess, candidate, updatedAt, preFlightLastAt) {
  if (!candidate) return false
  const live = state.sessions.get(sess.id) || sess
  if (live.lastAt > preFlightLastAt) {
    live._syncedAt = updatedAt
    live._dirty = true
    trace('save.auto_compact.defer_commit', {
      sess: sess.id,
      reason: 'local_edit_after_preflight',
      bytes: candidate.bytes,
    })
    return false
  }
  live.messages = candidate.liveMessages
  live._syncedAt = updatedAt
  live._dirty = false
  live._oversized = false
  live._conflictRetryCount = 0
  _rebuildSearchIndex(live)
  try { await dbPut({ ...live, _syncedAt: updatedAt }) } catch {}
  trace('save.auto_compact.committed', {
    sess: sess.id,
    bytes: candidate.bytes,
    finalBytes: candidate.finalBytes,
    droppedCount: candidate.droppedCount,
    mediaStripped: candidate.mediaStripped,
    inlineBase64Stripped: candidate.inlineBase64Stripped,
  })
  return true
}

/**
 * Push a single session to server (best-effort). Marks _syncedAt on success.
 */
export function pushSessionToServer(sess) {
  if (!sess?.id || !state.token) {
    trace('save.push.skip', { sess: sess?.id ?? null, reason: !sess?.id ? 'no_sess_id' : 'no_token' })
    return Promise.resolve()
  }
  // Do not create cross-device server rows for empty placeholder sessions.
  // They are produced during cold boot before `/api/sessions/list` returns,
  // and also by explicit "新建会话" before the user sends anything. Persisting
  // them server-side makes returning users land on a blank "新会话" and clutters
  // the sidebar across devices. The first real message/rename will re-save.
  if (
    (!Array.isArray(sess.messages) || sess.messages.length === 0) &&
    (!sess.title || sess.title === '新会话')
  ) {
    sess._dirty = false
    trace('save.push.skip', { sess: sess.id, reason: 'empty_session' })
    return Promise.resolve()
  }
  // Oversized sessions (received a 413 from a previous PUT) are PUT-disabled
  // for the rest of the page lifetime. Any subsequent PUT would just cost
  // request bytes + DB JSON.parse cycles and 413 again. The flag is
  // intentionally NOT persisted to IDB: a page reload or admin-side
  // session strip should give us a fresh chance, and we re-detect oversized
  // on the next PUT attempt without needing to manually unstick the flag.
  if (sess._oversized) {
    trace('save.push.skip', { sess: sess.id, reason: 'already_oversized' })
    return Promise.resolve()
  }
  const { _streamingAssistant, _streamingThinking, _blockIdToMsgId, _sendingInFlight, _replyingToMsgId, _agentGroups, _streamRafPending, _thinkRafPending, _searchText, _syncedAt, _dirty, _pendingCostCredits, _lastFinaledAssistantId, _lastFinaledAt, _oversized, _bootPlaceholder, ...clean } = sess
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
  let body = JSON.stringify(clean)
  let bodyBytes = _jsonBytes(body)
  let autoCompactCandidate = null
  if (bodyBytes > PREFLIGHT_MAX_BYTES) {
    const originalBodyBytes = bodyBytes
    autoCompactCandidate = _prepareAutoCompactCandidate(sess, clean, bodyBytes)
    if (autoCompactCandidate) {
      body = autoCompactCandidate.body
      bodyBytes = autoCompactCandidate.bytes
      trace('save.auto_compact.preflight', {
        sess: sess.id,
        fromBytes: originalBodyBytes,
        toBytes: autoCompactCandidate.bytes,
        droppedCount: autoCompactCandidate.droppedCount,
        mediaStripped: autoCompactCandidate.mediaStripped,
        inlineBase64Stripped: autoCompactCandidate.inlineBase64Stripped,
      })
    } else {
      const live = state.sessions.get(sess.id) || sess
      const wasOversized = live._oversized
      live._oversized = true
      live._dirty = false
      live._conflictRetryCount = 0
      if (!wasOversized) {
        try { _onSessionOversized?.(live.id) } catch {}
      }
      trace('save.push.skip', {
        sess: sess.id,
        reason: 'preflight_oversized',
        bytes: bodyBytes,
        maxBytes: PREFLIGHT_MAX_BYTES,
      })
      return Promise.resolve()
    }
  }
  return apiFetch(`/api/sessions/${sess.id}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body,
  }).then(async (initialRes) => {
    let res = initialRes
    // If the wire body fit but the server-side merge would exceed the
    // storage row cap, build one compacted candidate and retry once. The
    // lossy candidate is committed to live/IDB only after a successful PUT.
    if (res.status === 413 && !autoCompactCandidate) {
      const retryCandidate = _prepareAutoCompactCandidate(sess, clean, bodyBytes)
      if (retryCandidate) {
        trace('save.auto_compact.retry_413', {
          sess: sess.id,
          fromBytes: bodyBytes,
          toBytes: retryCandidate.bytes,
          droppedCount: retryCandidate.droppedCount,
        })
        autoCompactCandidate = retryCandidate
        body = retryCandidate.body
        bodyBytes = retryCandidate.bytes
        res = await apiFetch(`/api/sessions/${sess.id}`, {
          method: 'PUT',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body,
        })
      }
    }
    if (res.ok) {
      const resp = await res.json()
      if (resp?.applied && resp.updatedAt) {
        if (autoCompactCandidate) {
          const committed = await _commitAutoCompactCandidate(
            sess,
            autoCompactCandidate,
            resp.updatedAt,
            preFlightLastAt,
          )
          if (committed) {
            try { _onSessionAutoCompacted?.(sess.id, autoCompactCandidate) } catch {}
          }
        } else {
          sess._syncedAt = resp.updatedAt
          sess._dirty = false
          sess._conflictRetryCount = 0  // successful PUT clears 409 retry cap
        }
      }
      trace('save.push.ok', { sess: sess.id, status: res.status, applied: !!resp?.applied, bytes: bodyBytes })
    } else if (res.status === 413) {
      trace('save.push.fail', { sess: sess.id, status: 413, bytes: bodyBytes })
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
      trace('save.push.fail', { sess: sess.id, status: 409, bytes: bodyBytes })
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
          //
          // 2026-05-12 §3.x — overlay 改走 _mergeServerAuthoredIntoLocal。
          // 之前是 in-place mutation (`lm[k] = sm[k]`) 然后是
          // `_overlayServerOntoLocalDominant`,两者都假设 server 必然是 local 的
          // id-positional prefix。`_mergeServerAuthoredIntoLocal` 用 id-based
          // overlay + 末尾追加 + ts-sort + turn-group dedupe,语义对所有分支
          // 一致(full sync / partial / 409 local-dominates / 409 server-wins
          // 都走同一份算法),不再分裂出"prefix 模式 vs server-timeline 模式"
          // 两套实现。`_localDominates` 已保证 [0, server.length) 上 id 对齐 +
          // local 胜过 server,merger 在这段上做 `_overlayServerAuthoritative`
          // (有差异返回新对象,无差异返回原 ref);[server.length, local.length)
          // 上 local-only 行原样保留(turn-group dedupe 只对在同 group 内有 server
          // 权威对应行的 client phantom 起作用,与本场景无冲突)。
          target.messages = _mergeServerAuthoredIntoLocal(
            server.messages || [],
            target.messages || [],
          )
          _rebuildBlockMaps(target)
          _rebindStreamingPointers(target)

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
          // Pass 'local-dominates' so callbacks can distinguish the two
          // resolver branches if they care. main.js now calls renderMessages()
          // for both modes (the WeakMap-keyed reconcile makes that cheap on
          // unchanged sessions and correctly surfaces _overlayServerAuthoritative
          // fresh-ref overlays). The mode tag is still useful for telemetry
          // / retry decisions / future divergent UI behavior.
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

        // Merge via `_mergeServerAuthoredIntoLocal` rather than blind replace.
        // Even in "server wins" branch, an in-flight assistant tail can be
        // racing ahead of server tape persistence; dropping it causes the
        // mobile flash-and-loss bug. The merger keeps client-only rows as
        // local-only when server has no takeover counterpart, and runs the
        // turn-group phantom dedupe to drop client `m-…` rows once server's
        // `srv-…` takeover row exists in the same group.
        Object.assign(target, {
          title: server.title,
          messages: _mergeServerAuthoredIntoLocal(
            server.messages || [],
            target.messages || [],
          ),
          lastAt: server.lastAt,
          pinned: server.pinned,
          agentId: server.agentId,
          _syncedAt: server.updatedAt,
          _dirty: false,
        })
        // Rebuild runtime maps eagerly from the merged messages so streaming
        // state (tool blocks, agent groups) stays intact instead of being
        // nuked and lazy-rebuilt from a potentially-truncated server view.
        _rebuildBlockMaps(target)
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
      } catch (e) {
        trace('save.push.409_resolve_err', { sess: sess.id, msg: String(e?.message ?? e).slice(0, 120) })
      }
    } else {
      // Unhandled status — log so future divergence (gateway adding new
      // failure modes) surfaces in trace rather than fall through silently.
      trace('save.push.fail', { sess: sess.id, status: res.status, bytes: bodyBytes })
    }
  }).catch((e) => {
    trace('save.push.fail', { sess: sess.id, network: true, msg: String(e?.message ?? e).slice(0, 120) })
  })
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
