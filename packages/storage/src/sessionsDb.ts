// SessionsDb — SQLite FTS5 full-text index of every turn across every session.
// Used by the session_search MCP tool to do long-term conversation recall.
//
// Two tables:
//   sessions_meta (id PRIMARY KEY, agent_id, channel, peer_id, started_at, last_at, title)
//   sessions_fts  (FTS5 virtual): session_id, turn_idx, role, content
//     — tokenize unicode61 remove_diacritics 2 (Chinese + English tolerant)
//
// On every result event from subprocessRunner we insert the (user_text,
// assistant_text) for the turn into sessions_fts. Queries use MATCH and
// group hits by session_id to return top-N unique sessions.

import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { paths } from './paths.js'

let _db: Database.Database | null = null
let _walTimer: ReturnType<typeof setInterval> | null = null

function _onExit(): void {
  if (_db) {
    if (_walTimer !== null) { clearInterval(_walTimer); _walTimer = null }
    try { _db.pragma('wal_checkpoint(TRUNCATE)'); _db.close() } catch {}
    _db = null
  }
}

export async function getSessionsDb(): Promise<Database.Database> {
  if (_db) return _db
  await mkdir(dirname(paths.sessionsDb), { recursive: true })
  const db = new Database(paths.sessionsDb)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions_meta (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      title TEXT,
      started_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_last_at ON sessions_meta(last_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions_meta(agent_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED,
      turn_idx UNINDEXED,
      role UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    );
  `)

  // ── Schema migrations (run BEFORE index creation) ──
  // 1. Migrate event_log: rename session_id → session_key if old schema
  try {
    const cols = db.pragma('table_info(event_log)') as Array<{ name: string }>
    if (cols.some(c => c.name === 'session_id') && !cols.some(c => c.name === 'session_key')) {
      db.exec('ALTER TABLE event_log RENAME COLUMN session_id TO session_key')
    }
  } catch { /* table just created, no migration needed */ }

  // 2. Migrate usage_log: deduplicate then add unique constraint
  try {
    const idxs = db.pragma('index_list(usage_log)') as Array<{ name: string; unique: number }>
    const hasDedup = idxs.some(i => i.name === 'idx_usage_log_dedup')
    if (!hasDedup) {
      // Delete duplicates keeping the latest row per (session_id, turn_index)
      db.exec(`
        DELETE FROM usage_log WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM usage_log GROUP BY session_id, turn_index
        )
      `)
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_dedup ON usage_log(session_id, turn_index)')
    }
  } catch { /* table just created, no migration needed */ }

  // 3. Migrate event_log: add peer_id and channel columns for audit trail (P0.5)
  try {
    const cols = db.pragma('table_info(event_log)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'peer_id')) {
      db.exec("ALTER TABLE event_log ADD COLUMN peer_id TEXT DEFAULT ''")
    }
    if (!cols.some(c => c.name === 'channel')) {
      db.exec("ALTER TABLE event_log ADD COLUMN channel TEXT DEFAULT ''")
    }
  } catch { /* table just created with columns already, or migration ran */ }

  // ── Create indexes (after migrations) ──
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_log_type_ts ON event_log(type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_log_agent_ts ON event_log(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_key);
    CREATE INDEX IF NOT EXISTS idx_event_log_peer ON event_log(peer_id);
    CREATE INDEX IF NOT EXISTS idx_usage_log_agent_ts ON usage_log(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_log_session ON usage_log(session_id);
  `)

  // Periodic WAL checkpoint to prevent unbounded WAL growth
  _walTimer = setInterval(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {}
  }, 30 * 60_000) // every 30 min
  // Don't prevent process exit — mcp-memory processes are short-lived
  _walTimer.unref()
  // Run one immediately
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {}

  // Ensure WAL is checkpointed and DB is closed on process exit.
  // Use process.on (not once) so that closeSessionsDb() + reopen still works,
  // but the guard `if (_db)` makes repeated calls idempotent.
  process.on('exit', _onExit)

  // Clean up orphaned FTS records (sessions_fts rows with no matching sessions_meta)
  try {
    db.exec('DELETE FROM sessions_fts WHERE NOT EXISTS (SELECT 1 FROM sessions_meta WHERE sessions_meta.id = sessions_fts.session_id)')
  } catch { /* non-fatal: stale FTS rows are harmless */ }

  // ── Client sessions (cross-device sync, multi-user) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL DEFAULT '新会话',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_client_sessions_last ON client_sessions(last_at);
    CREATE INDEX IF NOT EXISTS idx_client_sessions_user ON client_sessions(user_id);
  `)
  // Migration: add user_id column if missing (existing DBs)
  try {
    const cols = db.pragma('table_info(client_sessions)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'user_id')) {
      db.exec("ALTER TABLE client_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'")
      db.exec('CREATE INDEX IF NOT EXISTS idx_client_sessions_user ON client_sessions(user_id)')
    }
  } catch { /* table just created */ }
  // Migration: add deleted_at column (replaces __deleted__ title tombstone)
  try {
    const cols = db.pragma('table_info(client_sessions)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'deleted_at')) {
      db.exec("ALTER TABLE client_sessions ADD COLUMN deleted_at INTEGER DEFAULT NULL")
      // Migrate existing __deleted__ tombstones to the new column
      db.exec("UPDATE client_sessions SET deleted_at = updated_at WHERE title = '__deleted__'")
    }
  } catch { /* table just created with column already */ }
  // Migration: store message counts separately so list endpoints don't parse
  // every session's messages JSON on each request.
  try {
    const cols = db.pragma('table_info(client_sessions)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'message_count')) {
      db.exec("ALTER TABLE client_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0")
      db.exec("UPDATE client_sessions SET message_count = COALESCE(json_array_length(messages), 0)")
    }
  } catch { /* table just created with column already */ }
  // Migration: per-session monotonic `next_seq` counter for the incremental
  // GET protocol. Each message in the messages JSON gets a server-assigned
  // `_seq` field; client passes `?since=<seq>` and server returns only tail.
  // See normalizeAndAssignSeqs / getClientSessionPartial. Default 1 for fresh
  // rows; legacy rows are backfilled lazily on the next write path.
  try {
    const cols = db.pragma('table_info(client_sessions)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'next_seq')) {
      db.exec("ALTER TABLE client_sessions ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1")
    }
  } catch { /* table just created with column already */ }

  // ── WeChat iLink per-user bindings (multi-tenant) ──
  //   Each OpenClaude user can bind exactly one WeChat bot account via
  //   ilinkai.weixin.qq.com. The row stores the bot_token + long-poll cursor
  //   + whitelist of wx sender IDs that are allowed to talk to the bot.
  //
  //   PRIMARY KEY = (user_id)           — one binding per OC user (MVP)
  //   UNIQUE(account_id)                — server-side bot can only be bound once
  //
  //   status values: "active" | "disabled" | "expired"
  db.exec(`
    CREATE TABLE IF NOT EXISTS wechat_bindings (
      user_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      login_user_id TEXT NOT NULL DEFAULT '',
      bot_token TEXT NOT NULL,
      get_updates_buf TEXT NOT NULL DEFAULT '',
      context_tokens TEXT NOT NULL DEFAULT '{}',
      whitelist TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_event_at INTEGER DEFAULT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_bindings_account ON wechat_bindings(account_id);
    CREATE INDEX IF NOT EXISTS idx_wechat_bindings_status ON wechat_bindings(status);
  `)

  _db = db
  return db
}

export interface SessionMeta {
  id: string
  agentId: string
  channel: string
  peerId: string
  title: string
  startedAt: number
  lastAt: number
  turnCount: number
  totalCostUSD: number
}

export async function upsertSessionMeta(meta: SessionMeta): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(`
    INSERT INTO sessions_meta (id, agent_id, channel, peer_id, title, started_at, last_at, turn_count, total_cost_usd)
    VALUES (@id, @agentId, @channel, @peerId, @title, @startedAt, @lastAt, @turnCount, @totalCostUSD)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      last_at = excluded.last_at,
      turn_count = excluded.turn_count,
      total_cost_usd = excluded.total_cost_usd
  `).run(meta)
}

export async function indexTurn(
  sessionId: string,
  turnIdx: number,
  userText: string,
  assistantText: string,
): Promise<void> {
  const db = await getSessionsDb()
  const stmt = db.prepare(
    'INSERT INTO sessions_fts (session_id, turn_idx, role, content) VALUES (?, ?, ?, ?)',
  )
  if (userText) stmt.run(sessionId, turnIdx, 'user', userText)
  if (assistantText) stmt.run(sessionId, turnIdx, 'assistant', assistantText)
}

export interface SearchHit {
  sessionId: string
  agentId: string
  channel: string
  peerId: string
  title: string
  lastAt: number
  snippet: string
  score: number
}

// Returns top-N unique sessions with a snippet of the best-matching turn.
export async function searchSessions(
  query: string,
  limit = 5,
  agentId?: string,
): Promise<SearchHit[]> {
  const db = await getSessionsDb()
  const cleanQuery = query.replace(/["()*]/g, ' ').trim()
  if (!cleanQuery) return []
  // If agentId provided, filter at SQL level for correctness
  const agentFilter = agentId ? 'AND m.agent_id = ?' : ''
  const params = agentId ? [cleanQuery, agentId, limit * 4] : [cleanQuery, limit * 4]
  const rows = db
    .prepare(
      `
    SELECT
      f.session_id,
      f.turn_idx,
      snippet(sessions_fts, 3, '<mark>', '</mark>', '…', 16) AS snippet,
      bm25(sessions_fts) AS score,
      m.agent_id,
      m.channel,
      m.peer_id,
      m.title,
      m.last_at
    FROM sessions_fts f
    LEFT JOIN sessions_meta m ON m.id = f.session_id
    WHERE sessions_fts MATCH ?
    ${agentFilter}
    ORDER BY score
    LIMIT ?
  `,
    )
    .all(...params) as Array<{
    session_id: string
    turn_idx: number
    snippet: string
    score: number
    agent_id: string | null
    channel: string | null
    peer_id: string | null
    title: string | null
    last_at: number | null
  }>

  // Dedupe to top-N unique sessions
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const r of rows) {
    if (seen.has(r.session_id)) continue
    seen.add(r.session_id)
    out.push({
      sessionId: r.session_id,
      agentId: r.agent_id ?? 'unknown',
      channel: r.channel ?? 'unknown',
      peerId: r.peer_id ?? 'unknown',
      title: r.title ?? '(untitled)',
      lastAt: r.last_at ?? 0,
      snippet: r.snippet,
      score: r.score,
    })
    if (out.length >= limit) break
  }
  return out
}

// Load up to the 100 most recent turns of a session ordered by turn_idx ascending
// (for second-pass summarization). The cap prevents loading entire large sessions into memory.
// Note: indexTurn() inserts up to 2 FTS rows per turn (user + assistant), so LIMIT 200 rows
// yields ~100 full turns in the common case.
export async function loadSessionTurns(
  sessionId: string,
): Promise<Array<{ role: string; content: string; turnIdx: number }>> {
  const db = await getSessionsDb()
  const rows = db
    .prepare(`
      SELECT turn_idx, role, content FROM sessions_fts
      WHERE session_id = ?
      ORDER BY turn_idx DESC, rowid DESC
      LIMIT 200
    `)
    .all(sessionId) as Array<{ turn_idx: number; role: string; content: string }>
  // Reverse so caller receives turns in chronological order
  return rows.reverse().map((r) => ({ turnIdx: r.turn_idx, role: r.role, content: r.content }))
}

// ── Event log ──────────────────────────────────

export interface EventLogEntry {
  id: string
  type: string
  timestamp: number
  agentId: string
  sessionKey?: string
  schemaVersion: number
  payload: string // JSON-stringified full event
  peerId?: string
  channel?: string
}

export async function insertEvent(entry: EventLogEntry): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(`
    INSERT OR IGNORE INTO event_log (id, type, timestamp, agent_id, session_key, schema_version, payload, peer_id, channel)
    VALUES (@id, @type, @timestamp, @agentId, @sessionKey, @schemaVersion, @payload, @peerId, @channel)
  `).run({ ...entry, peerId: entry.peerId ?? '', channel: entry.channel ?? '' })
}

export async function queryEvents(opts: {
  type?: string
  agentId?: string
  sessionKey?: string
  since?: number
  limit?: number
}): Promise<EventLogEntry[]> {
  const db = await getSessionsDb()
  const conditions: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.type) { conditions.push('type = @type'); params.type = opts.type }
  if (opts.agentId) { conditions.push('agent_id = @agentId'); params.agentId = opts.agentId }
  if (opts.sessionKey) { conditions.push('session_key = @sessionKey'); params.sessionKey = opts.sessionKey }
  if (opts.since != null) { conditions.push('timestamp >= @since'); params.since = opts.since }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  params.limit = opts.limit ?? 100
  const rows = db.prepare(
    `SELECT id, type, timestamp, agent_id, session_key, schema_version, payload, peer_id, channel
     FROM event_log ${where} ORDER BY timestamp DESC LIMIT @limit`
  ).all(params) as Array<{
    id: string; type: string; timestamp: number; agent_id: string;
    session_key: string | null; schema_version: number; payload: string;
    peer_id: string | null; channel: string | null
  }>
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    timestamp: r.timestamp,
    agentId: r.agent_id,
    sessionKey: r.session_key ?? undefined,
    schemaVersion: r.schema_version,
    payload: r.payload,
    peerId: r.peer_id || undefined,
    channel: r.channel || undefined,
  }))
}

// ── Usage log ──────────────────────────────────

export interface UsageLogEntry {
  id: string
  sessionId: string
  agentId: string
  turnIndex: number
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  durationMs: number
  toolCalls: number
  timestamp: number
}

export async function insertUsageLog(entry: UsageLogEntry): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(`
    INSERT OR IGNORE INTO usage_log
      (id, session_id, agent_id, turn_index, model, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, tool_calls, timestamp)
    VALUES (@id, @sessionId, @agentId, @turnIndex, @model, @inputTokens, @outputTokens,
            @cacheReadTokens, @cacheCreationTokens, @costUsd, @durationMs, @toolCalls, @timestamp)
  `).run(entry)
}

export interface UsageSummary {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTurns: number
}

export async function getUsageSummary(opts: {
  agentId?: string
  sessionId?: string
  since?: number
}): Promise<UsageSummary> {
  const db = await getSessionsDb()
  const conditions: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.agentId) { conditions.push('agent_id = @agentId'); params.agentId = opts.agentId }
  if (opts.sessionId) { conditions.push('session_id = @sessionId'); params.sessionId = opts.sessionId }
  if (opts.since != null) { conditions.push('timestamp >= @since'); params.since = opts.since }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const row = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as total_cost,
            COALESCE(SUM(input_tokens), 0) as total_in,
            COALESCE(SUM(output_tokens), 0) as total_out,
            COUNT(*) as total_turns
     FROM usage_log ${where}`
  ).get(params) as { total_cost: number; total_in: number; total_out: number; total_turns: number }
  return {
    totalCostUsd: row.total_cost,
    totalInputTokens: row.total_in,
    totalOutputTokens: row.total_out,
    totalTurns: row.total_turns,
  }
}

// ── Client sessions (cross-device sync) ──────────

export interface ClientSession {
  id: string
  userId: string
  agentId: string
  title: string
  pinned: boolean
  createdAt: number
  lastAt: number
  messages: unknown[]
  updatedAt: number
}

export interface ClientSessionMeta {
  id: string
  agentId: string
  title: string
  pinned: boolean
  createdAt: number
  lastAt: number
  messageCount: number
  updatedAt: number
}

// ── Pure merge helpers (exported for unit testing) ──

/** Minimal shape this module relies on. Real messages carry more fields. */
export type MessageLike = {
  id?: string
  ts?: number
  _source?: string
  [k: string]: unknown
}

/**
 * Merge a client PUT (`clientMsgs`) on top of what the server already has
 * (`serverSideMsgs`), preserving any server-authored messages the client
 * didn't include. Server-authored == `_source === 'server'`. The resulting
 * array is sorted by `ts` ascending.
 *
 * Rules:
 *   1. For each server-authored message, the server version wins: if
 *      clientMsgs has a message with the same id, replace it with the
 *      server version; if clientMsgs lacks that id, re-append the server
 *      version.
 *   2. Every non-server-authored entry stays exactly as the client sent it,
 *      EXCEPT for the "phantom-assistant dedupe" in rule 3.
 *   3. **Phantom-assistant dedupe** (Phase 0.4 P0-3 fix): client and server
 *      use independent assistant message IDs (client uses `m-*` from
 *      msgId(); server writes `srv-${peerId}-t${turnIndex}`). When a turn
 *      completes, BOTH can end up in `merged`: the client's partially-
 *      streamed copy AND the server-authored authoritative copy. We drop
 *      the client one when it is adjacent in the ts-sorted array to a
 *      server-authored assistant message (no user message between them =
 *      same turn). Never drops a server-authored entry. Without this rule
 *      the user sees every assistant response twice after any mobile-
 *      background recovery.
 *   4. Result is sorted by ts ascending; ties preserve insertion order
 *      (Array.prototype.sort is stable in ES2019+).
 *   5. If there are zero server-authored entries, `clientMsgs` is returned
 *      verbatim (no copy, same reference) — callers rely on this as a fast
 *      path.
 */
export function mergePreservingServerAuthored<T extends MessageLike>(
  serverSideMsgs: readonly T[],
  clientMsgs: readonly T[],
): T[] | readonly T[] {
  const serverAuthored = new Map<string, T>()
  for (const m of serverSideMsgs) {
    if (m && m._source === 'server' && typeof m.id === 'string') {
      serverAuthored.set(m.id, m)
    }
  }
  if (serverAuthored.size === 0) return clientMsgs

  const clientIds = new Set<string>()
  for (const m of clientMsgs) {
    if (m && typeof m.id === 'string') clientIds.add(m.id)
  }

  const merged: T[] = clientMsgs.map((m) => {
    if (m && typeof m.id === 'string' && serverAuthored.has(m.id)) {
      return serverAuthored.get(m.id) as T
    }
    return m
  })
  for (const [, msg] of serverAuthored) {
    if (typeof msg.id === 'string' && !clientIds.has(msg.id)) merged.push(msg)
  }
  merged.sort((a, b) => ((a?.ts ?? 0) - (b?.ts ?? 0)))

  // Phantom-assistant dedupe (rule 3): partition merged[] into turns on
  // user/system messages (which act as turn boundaries — the model never
  // produces those client-side on its own). Within each partition, if any
  // server-authored assistant exists, drop ALL non-server-authored
  // assistants in that partition (they are phantoms of the same turn).
  //
  // This is broader than a simple adjacency check because tool-use turns
  // end up with MULTIPLE client-side assistant segments separated by
  // tool_use / tool_result messages (see websocket.js where a tool_use
  // block clears `_streamingAssistant` so the next text creates a new
  // bubble). Server writes one aggregated assistant per turn, so pair-wise
  // adjacency would leave earlier client segments orphaned.
  //
  // Never drops a server-authored message; never drops a client message
  // that is not an assistant (tool, tool_result, user, thinking, etc. are
  // always preserved). Also tolerates both ts-sort orders of the server
  // row relative to client segments (server clock earlier or later).
  const deduped: T[] = []
  const isAssistant = (m: T) => (m as { role?: string }).role === 'assistant'
  const isTurnBoundary = (m: T) => {
    const role = (m as { role?: string }).role
    return role === 'user' || role === 'system'
  }
  // First pass: compute per-index turn group id, and whether that group has
  // any server-authored assistant. We need this because the decision to
  // drop a phantom depends on the ENTIRE partition, not just its neighbours.
  const turnGroup: number[] = new Array(merged.length)
  const groupHasServerAsst: boolean[] = []
  let groupId = 0
  let currentGroupHasServer = false
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]
    if (cur && isTurnBoundary(cur)) {
      // Close previous group, open a new one. The boundary itself belongs
      // to the starting group of what follows (a user message opens a new
      // turn; we tag it with the new groupId so any dedupe scan after it
      // lands in the right bucket).
      groupHasServerAsst.push(currentGroupHasServer)
      groupId++
      currentGroupHasServer = false
    }
    turnGroup[i] = groupId
    if (cur && isAssistant(cur) && cur._source === 'server') {
      currentGroupHasServer = true
    }
  }
  groupHasServerAsst.push(currentGroupHasServer)

  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]
    if (!cur) { deduped.push(cur); continue }
    // Keep server-authored messages, non-assistant messages, and assistants
    // in a partition that has no server-authored counterpart.
    if (!isAssistant(cur) || cur._source === 'server') {
      deduped.push(cur)
      continue
    }
    const g = turnGroup[i]
    if (groupHasServerAsst[g]) {
      // This client-assistant lives in a turn that the server re-authored.
      // Drop as phantom.
      continue
    }
    deduped.push(cur)
  }
  return deduped
}

/**
 * Idempotent append of a server-authored message to an existing messages
 * array. Returns `{ applied: false, reason: 'already_exists' }` if a
 * message with the same id already exists, else returns a new sorted
 * array with the stamped message included.
 *
 * Pure: doesn't mutate `existing`. `message._source` is always stamped
 * to `'server'` in the returned copy, and `ts` defaults to `now` if
 * missing so subsequent sort is well-defined.
 */
export function appendServerAuthoredPure<T extends MessageLike>(
  existing: readonly T[],
  message: T & { id: string },
  now: number = Date.now(),
): { applied: true; messages: T[] } | { applied: false; reason: 'already_exists' } {
  if (existing.some((m) => m && m.id === message.id)) {
    return { applied: false, reason: 'already_exists' }
  }
  const stamped = { ...message, _source: 'server', ts: message.ts ?? now } as T
  const next = [...existing, stamped]
  next.sort((a, b) => ((a?.ts ?? 0) - (b?.ts ?? 0)))
  return { applied: true, messages: next }
}

// ── _seq monotonic cursor for incremental GET (Plan v3) ──

/**
 * Fields excluded from message-content equality when judging whether to
 * inherit an existing `_seq` or assign a fresh one.
 *
 * - `_seq` itself MUST be excluded (otherwise compare-on-_seq is circular).
 * - `status` is a client-only UI flag (`sending`/`queued`/`sent`/`read`) the
 *   server never authors; flipping it does not represent a server-visible
 *   message-content change, so we keep the inherited `_seq` to avoid
 *   spurious tail growth on every PUT.
 *
 * NOT excluded (intentionally — these ARE message content):
 * - `_source` ('server' authoring takeover should produce a fresh `_seq` so
 *   client incremental GET observes the takeover)
 * - text / role / childBlocks / agentName / streaming flags (when persisted
 *   they reflect what the server holds; if any change, client should resync)
 */
const _SEQ_CONTENT_IGNORE_FIELDS = new Set(['_seq', 'status'])

function _stableStringifyForSeq(v: unknown): string | null {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const keys = Object.keys(val).sort().filter((k) => !_SEQ_CONTENT_IGNORE_FIELDS.has(k))
        const sorted: Record<string, unknown> = {}
        for (const k of keys) sorted[k] = (val as Record<string, unknown>)[k]
        return sorted
      }
      return val
    })
  } catch {
    return null
  }
}

/**
 * Returns true when the two messages should share a `_seq` — i.e., they
 * represent the same server-visible content version. See
 * {@link _SEQ_CONTENT_IGNORE_FIELDS} for excluded fields.
 *
 * Conservative: if either side fails to stringify (cycle, non-JSON-safe
 * values), treat as inequal so caller assigns a fresh `_seq`. Better to
 * over-deliver than to silently lose a server change.
 */
export function _messageContentEqualForSeq(a: MessageLike, b: MessageLike): boolean {
  const sa = _stableStringifyForSeq(a)
  const sb = _stableStringifyForSeq(b)
  if (sa === null || sb === null) return false
  return sa === sb
}

/**
 * Result of normalizing a session's messages array to satisfy the `_seq`
 * invariant after a write.
 *
 * Invariant (post-normalize):
 *   - Every `messages[i]._seq` is a positive integer.
 *   - All `_seq` values within a session row are unique.
 *   - `nextSeq > max(messages[i]._seq)` (next allocation strictly greater).
 *   - `_seq` reflects server-visible content version: id+content unchanged →
 *     inherited from `oldMsgs`; id new or content changed → freshly allocated.
 *
 * Pure: doesn't mutate inputs; returns a new messages array whose elements
 * may share references with `finalMsgs` only when no `_seq` change was needed
 * (kept references reduce GC pressure; not relied on for correctness).
 */
export function normalizeAndAssignSeqs<T extends MessageLike>(
  oldMsgs: readonly T[],
  finalMsgs: readonly T[],
  currentNextSeq: number,
): { messages: T[]; nextSeq: number; maxSeq: number } {
  // Step 1: legacy backfill on oldMsgs side.
  // If ANY old message lacks `_seq`, reassign the entire oldMsgs row in
  // current array order starting from 1; this makes the row "post-migration"
  // for the rest of this normalization. We deliberately ignore
  // `currentNextSeq` here because legacy rows have `next_seq = 1` (default
  // from the migration), which is meaningless until backfill happens.
  let oldNormalized: Array<T & { _seq: number }>
  let nextSeq: number
  const anyOldMissingSeq = oldMsgs.some(
    (m) => !m || typeof (m as MessageLike)._seq !== 'number' || !Number.isFinite((m as MessageLike)._seq as number),
  )
  if (anyOldMissingSeq) {
    oldNormalized = oldMsgs.map((m, idx) => ({ ...(m as object), _seq: idx + 1 } as T & { _seq: number }))
    nextSeq = oldMsgs.length + 1
  } else {
    oldNormalized = oldMsgs as Array<T & { _seq: number }>
    // Defensive: even when oldMsgs all have _seq, the persisted next_seq column
    // may have drifted (e.g., a botched manual SQL edit). Force monotonic.
    let maxOldSeq = 0
    for (const m of oldNormalized) if (m._seq > maxOldSeq) maxOldSeq = m._seq
    nextSeq = Math.max(currentNextSeq, maxOldSeq + 1)
  }
  // Build oldById map AFTER normalization so inherited values are post-backfill.
  const oldById = new Map<string, T & { _seq: number }>()
  for (const m of oldNormalized) {
    if (m && typeof m.id === 'string') oldById.set(m.id, m)
  }

  // Step 2: walk finalMsgs and decide each `_seq`.
  // - id in oldById && content equal (ignoring _seq + client-only fields)
  //   → inherit oldById[id]._seq
  // - id in oldById && content changed (incl. _source flip)
  //   → allocate fresh _seq
  // - id new
  //   → allocate fresh _seq
  // - id missing on finalMsg → still allocate fresh _seq so the invariant
  //   holds (caller is supposed to ensure ids, but we don't crash here)
  const out: T[] = new Array(finalMsgs.length)
  for (let i = 0; i < finalMsgs.length; i++) {
    const m = finalMsgs[i] as T & { _seq?: number }
    const mId = typeof m?.id === 'string' ? m.id : null
    const old = mId ? oldById.get(mId) : undefined
    if (old && _messageContentEqualForSeq(m, old)) {
      // Inherit. Replace `_seq` field even if finalMsg already had one;
      // oldMsgs is the authoritative source (Codex review #4).
      if (m._seq === old._seq) {
        out[i] = m
      } else {
        out[i] = { ...(m as object), _seq: old._seq } as T
      }
    } else {
      out[i] = { ...(m as object), _seq: nextSeq } as T
      nextSeq++
    }
  }

  // Step 3: compute maxSeq from the actual messages (Codex review #5: do NOT
  // trust nextSeq - 1). Also doubles as a defensive sanity for the assignment
  // logic above.
  let maxSeq = 0
  for (const m of out) {
    const s = (m as MessageLike)._seq
    if (typeof s === 'number' && s > maxSeq) maxSeq = s
  }
  return { messages: out, nextSeq, maxSeq }
}

/**
 * Returns true if the row was actually inserted/updated, false if rejected.
 * @param baseSyncedAt - client's last known server updated_at (optimistic concurrency).
 *   On conflict, the write is only applied if the existing row's updated_at <= baseSyncedAt
 *   (i.e., the client has seen the latest version). For new inserts this is ignored.
 *
 * **Server-authored message preservation**: messages in the existing row that
 * carry `_source: 'server'` (written by {@link appendServerAuthoredMessage})
 * MUST survive a client PUT that doesn't include them. This is the mobile
 * stream durability contract — when a mobile client goes to background and
 * misses the tail of an assistant message, its subsequent PUT would otherwise
 * overwrite the server's complete copy with the truncated local copy. We
 * delegate merging to {@link mergePreservingServerAuthored} so the policy is
 * testable in isolation.
 */
export async function upsertClientSession(session: ClientSession, baseSyncedAt = 0): Promise<boolean> {
  const db = await getSessionsDb()
  const txn = db.transaction(() => {
    const existing = db.prepare(
      'SELECT messages, updated_at, next_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).get(session.id, session.userId) as { messages: string; updated_at: number; next_seq: number | null } | undefined

    // Reject stale writes (same optimistic concurrency check as the pre-transaction version)
    if (existing && existing.updated_at > baseSyncedAt) return false

    let oldMsgs: MessageLike[] = []
    if (existing) {
      try {
        const parsed = JSON.parse(existing.messages)
        if (Array.isArray(parsed)) oldMsgs = parsed as MessageLike[]
      } catch { /* malformed existing messages JSON — treat as empty */ }
    }
    const clientMsgs = session.messages as MessageLike[]
    const merged = mergePreservingServerAuthored(oldMsgs, clientMsgs) as MessageLike[]
    const currentNextSeq = existing && typeof existing.next_seq === 'number' && existing.next_seq > 0
      ? existing.next_seq
      : 1
    const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(oldMsgs, merged, currentNextSeq)

    const result = db.prepare(`
      INSERT INTO client_sessions (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, next_seq)
      VALUES (@id, @userId, @agentId, @title, @pinned, @createdAt, @lastAt, @messages, @messageCount, @updatedAt, @nextSeq)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        title = excluded.title,
        pinned = excluded.pinned,
        last_at = excluded.last_at,
        messages = excluded.messages,
        message_count = excluded.message_count,
        updated_at = excluded.updated_at,
        next_seq = excluded.next_seq
      WHERE client_sessions.updated_at <= @baseSyncedAt
        AND client_sessions.user_id = @userId
    `).run({
      id: session.id,
      userId: session.userId,
      agentId: session.agentId,
      title: session.title,
      pinned: session.pinned ? 1 : 0,
      createdAt: session.createdAt,
      lastAt: session.lastAt,
      messages: JSON.stringify(finalMessages),
      messageCount: finalMessages.length,
      updatedAt: session.updatedAt,
      baseSyncedAt,
      nextSeq,
    })
    return result.changes > 0
  })
  return txn()
}

/**
 * Append a server-authored message to a client session's messages array,
 * idempotently. Called by the gateway's turn.completed handler to persist the
 * authoritative assistant message so the client can always recover it via
 * REST force-sync, even if the WebSocket delivery was lost during mobile
 * backgrounding, tab freeze, or network interruption.
 *
 * Key properties:
 *   - Idempotent by message id: repeated calls with the same id are no-ops.
 *   - Stamps `_source: 'server'` so subsequent client PUTs via
 *     {@link upsertClientSession} won't drop or overwrite the message.
 *   - Sorts messages by ts ascending to keep ordering stable across out-of-
 *     order persistence (e.g., multiple turns completing in quick succession).
 *   - Runs in a BEGIN IMMEDIATE transaction so read-modify-write is atomic
 *     against concurrent client PUTs.
 *
 * Returns `applied: false` when the session row doesn't exist yet (caller
 * should ensure the client has created it first) or when a message with the
 * same id already exists.
 */
export async function appendServerAuthoredMessage(
  sessId: string,
  userId: string,
  message: { id: string; role: 'assistant' | 'user' | 'system'; text?: string; ts?: number; [k: string]: unknown },
): Promise<{ applied: boolean; reason?: 'session_not_found' | 'already_exists' | 'malformed' }> {
  const db = await getSessionsDb()
  const txn = db.transaction(() => {
    const row = db.prepare(
      'SELECT messages, next_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).get(sessId, userId) as { messages: string; next_seq: number | null } | undefined
    if (!row) return { applied: false, reason: 'session_not_found' as const }

    let msgs: MessageLike[]
    try {
      const parsed = JSON.parse(row.messages)
      if (!Array.isArray(parsed)) return { applied: false, reason: 'malformed' as const }
      msgs = parsed as MessageLike[]
    } catch {
      return { applied: false, reason: 'malformed' as const }
    }

    const result = appendServerAuthoredPure(msgs, message as MessageLike & { id: string })
    if (!result.applied) return { applied: false, reason: result.reason }

    // Run the resulting messages through normalizeAndAssignSeqs so the new
    // server-authored entry receives a fresh `_seq` AND any legacy rows on
    // this row get backfilled in the same transaction. Without this, a
    // legacy session (next_seq=1, messages without _seq) would silently get
    // _seq=1 assigned only to the new message — colliding with the eventual
    // _seq=1 a later upsert would assign during legacy backfill.
    const currentNextSeq = typeof row.next_seq === 'number' && row.next_seq > 0 ? row.next_seq : 1
    const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(msgs, result.messages, currentNextSeq)

    const now = Date.now()
    db.prepare(
      'UPDATE client_sessions SET messages = ?, message_count = ?, last_at = ?, updated_at = ?, next_seq = ? WHERE id = ? AND user_id = ?'
    ).run(JSON.stringify(finalMessages), finalMessages.length, now, now, nextSeq, sessId, userId)
    return { applied: true }
  })
  return txn()
}

// ── Phase 0.2: durable outbox for server-authored messages ──
//
// If the SQLite write fails (disk full, database locked, transient I/O error,
// or gateway crash mid-transaction), we don't want to silently drop the
// assistant message — that's the exact failure mode we're trying to prevent.
// Instead, the message is appended as a single JSON line to
// `paths.msgOutbox` and replayed on the next gateway startup.
//
// Schema: each line is a `QueuedMessage` JSON object. The file is line-
// addressable so readers can process entries independently; an atomic
// replace-and-truncate is used after successful replay.

export interface QueuedMessage {
  sessId: string
  userId: string
  message: {
    id: string
    role: 'assistant' | 'user' | 'system'
    text?: string
    ts?: number
    status?: 'completed' | 'interrupted' | 'crashed'
    [k: string]: unknown
  }
  /** When the write was queued (wall-clock ms). */
  queuedAt: number
  /** Optional reason the direct write failed — aids debugging on replay. */
  reason?: string
}

/**
 * Serialize one queued message to its JSONL form. Exported for tests.
 * Never throws: non-JSON-safe values are stringified via try/catch at the
 * call site.
 */
export function queuedMessageToLine(entry: QueuedMessage): string {
  return JSON.stringify(entry) + '\n'
}

/**
 * Parse a JSONL line into a `QueuedMessage`. Returns null if the line is
 * blank or malformed — replay is best-effort, so we skip rather than crash.
 * Exported for tests.
 */
export function parseQueuedMessageLine(line: string): QueuedMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as QueuedMessage
    if (
      !parsed ||
      typeof parsed.sessId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      !parsed.message ||
      typeof parsed.message.id !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/** Append a queued message to the outbox file (create-if-missing). */
export async function queueMessageToOutbox(entry: QueuedMessage): Promise<void> {
  await mkdir(dirname(paths.msgOutbox), { recursive: true })
  await appendFile(paths.msgOutbox, queuedMessageToLine(entry), { encoding: 'utf8' })
}

/**
 * Durable variant of {@link appendServerAuthoredMessage}. On any thrown
 * error from the DB write (disk full, BUSY, corrupt, etc.), the entry is
 * appended to the msg-outbox JSONL file for replay on next startup.
 *
 * Return shape:
 *   { applied: true }                                      — row updated
 *   { applied: false, reason: 'session_not_found' }        — caller bug
 *   { applied: false, reason: 'already_exists' }           — idempotent skip
 *   { applied: false, reason: 'malformed' }                — bad row data
 *   { applied: false, reason: 'queued_to_outbox', error } — DB failure,
 *     message safely persisted to outbox and will be retried on startup.
 */
export async function appendServerAuthoredMessageDurable(
  sessId: string,
  userId: string,
  message: { id: string; role: 'assistant' | 'user' | 'system'; text?: string; ts?: number; [k: string]: unknown },
): Promise<
  | { applied: true }
  | { applied: false; reason: 'already_exists' | 'malformed' }
  | { applied: false; reason: 'queued_to_outbox'; error: string }
> {
  try {
    const r = await appendServerAuthoredMessage(sessId, userId, message)
    if (r.applied) return { applied: true }
    // Phase 0.4 P1-3 fix: when the client_sessions row doesn't exist yet
    // (first-turn race — client's debounced PUT hasn't landed before the
    // REPL finished), don't silently drop the authoritative assistant text.
    // Queue it to the durable outbox so the next replayMsgOutbox() run
    // (startup, or the periodic replay hook) can persist it once the client
    // has pushed the session row. Without this, a fast new-chat turn can
    // lose its reply entirely if the user backgrounds the tab between
    // submit and PUT.
    if (r.reason === 'session_not_found') {
      await queueMessageToOutbox({
        sessId,
        userId,
        message,
        queuedAt: Date.now(),
        reason: 'session_not_found',
      })
      return { applied: false, reason: 'queued_to_outbox', error: 'session_not_found' }
    }
    // Upstream's signature types `reason` as optional, but every applied:false
    // branch above sets one of {'session_not_found','already_exists','malformed'}.
    // We've handled 'session_not_found'; the rest fall through here. Default
    // to 'malformed' if reason is somehow missing (unreachable in practice).
    return { applied: false, reason: r.reason ?? 'malformed' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      await queueMessageToOutbox({
        sessId,
        userId,
        message,
        queuedAt: Date.now(),
        reason: msg,
      })
    } catch (queueErr) {
      // Both DB and outbox failed — the caller's try/catch will log. Surface
      // the original DB error rather than the outbox one (more actionable).
      throw err
    }
    return { applied: false, reason: 'queued_to_outbox', error: msg }
  }
}

/**
 * Replay any messages queued in the outbox. Called on gateway startup before
 * opening the WS endpoint, so durable writes catch up before live traffic.
 *
 * Strategy:
 *   1. Read the entire outbox file into memory (bounded by disk size; we
 *      cap individual lines but total file size is trusted because only the
 *      gateway itself ever writes to it).
 *   2. For each parseable entry, attempt `appendServerAuthoredMessage`.
 *   3. Entries that succeed or are permanent no-ops (`session_not_found` —
 *      session was deleted while queued; `already_exists` — duplicate from
 *      a prior partial replay) are dropped.
 *   4. Entries whose DB write still throws are kept in the file for a
 *      future retry.
 *   5. After processing, atomically rewrite the file with survivors (or
 *      delete it if empty).
 *
 * Returns a summary so the caller can emit telemetry.
 */
export async function replayMsgOutbox(): Promise<{
  processed: number
  applied: number
  dropped: number
  requeued: number
  malformed: number
}> {
  let raw: string
  try {
    raw = await readFile(paths.msgOutbox, { encoding: 'utf8' })
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return { processed: 0, applied: 0, dropped: 0, requeued: 0, malformed: 0 }
    }
    throw err
  }
  const lines = raw.split('\n')
  let applied = 0
  let dropped = 0
  let malformed = 0
  const survivors: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    const entry = parseQueuedMessageLine(line)
    if (!entry) {
      malformed++
      continue
    }
    try {
      const r = await appendServerAuthoredMessage(entry.sessId, entry.userId, entry.message)
      if (r.applied) {
        applied++
      } else if (r.reason === 'already_exists' || r.reason === 'session_not_found' || r.reason === 'malformed') {
        dropped++
      } else {
        survivors.push(queuedMessageToLine(entry).trimEnd())
      }
    } catch {
      survivors.push(queuedMessageToLine(entry).trimEnd())
    }
  }

  const requeued = survivors.length
  const processed = applied + dropped + requeued + malformed

  // Atomic rewrite: write to .tmp, rename over. If survivors is empty, just
  // overwrite with empty contents (keeping the file avoids repeated mkdir).
  const tmp = `${paths.msgOutbox}.tmp-${process.pid}-${Date.now()}`
  const content = survivors.length > 0 ? survivors.join('\n') + '\n' : ''
  await mkdir(dirname(paths.msgOutbox), { recursive: true })
  await writeFile(tmp, content, { encoding: 'utf8' })
  await rename(tmp, paths.msgOutbox)

  return { processed, applied, dropped, requeued, malformed }
}

export async function listClientSessions(userId: string): Promise<ClientSessionMeta[]> {
  const db = await getSessionsDb()
  const rows = db.prepare(`
    SELECT id, agent_id, title, pinned, created_at, last_at, updated_at,
           message_count as msg_count
    FROM client_sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY last_at DESC
  `).all(userId) as Array<{
    id: string; agent_id: string; title: string; pinned: number;
    created_at: number; last_at: number; updated_at: number; msg_count: number
  }>
  return rows.map(r => ({
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    lastAt: r.last_at,
    messageCount: r.msg_count,
    updatedAt: r.updated_at,
  }))
}

export async function getClientSession(id: string, userId?: string): Promise<ClientSession | null> {
  const db = await getSessionsDb()
  const sql = userId
    ? "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    : "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at FROM client_sessions WHERE id = ? AND deleted_at IS NULL"
  const row = (userId ? db.prepare(sql).get(id, userId) : db.prepare(sql).get(id)) as {
    id: string; user_id: string; agent_id: string; title: string; pinned: number;
    created_at: number; last_at: number; messages: string; updated_at: number
  } | undefined
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    lastAt: row.last_at,
    messages: JSON.parse(row.messages),
    updatedAt: row.updated_at,
  }
}

export interface ClientSessionPartial extends ClientSession {
  totalMessageCount: number
  maxSeq: number
  isPartial: boolean
}

/**
 * Incremental GET for cross-device sync. Returns ONLY messages whose
 * server-assigned `_seq` is strictly greater than `sinceSeq`.
 *
 * Side-effect free: legacy rows (any message lacking `_seq`) are NOT
 * backfilled here — that requires a write transaction. Instead, this function
 * returns `isPartial: false` with the FULL messages array (fall back to
 * legacy behaviour) so client-side incremental optimisation degrades safely.
 * Once any write path (upsert / appendServerAuthored) runs on the row, the
 * row enters incremental mode and subsequent GETs honour `since`.
 *
 * `maxSeq` is computed from the actual messages array (NOT `next_seq`); per
 * Codex review #5, `next_seq - 1` may drift in the rare schema-mismatch case.
 */
export async function getClientSessionPartial(
  id: string,
  userId: string,
  sinceSeq: number,
): Promise<ClientSessionPartial | null> {
  const db = await getSessionsDb()
  const row = db.prepare(
    "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  ).get(id, userId) as {
    id: string; user_id: string; agent_id: string; title: string; pinned: number;
    created_at: number; last_at: number; messages: string; updated_at: number
  } | undefined
  if (!row) return null

  let allMsgs: MessageLike[] = []
  try {
    const parsed = JSON.parse(row.messages)
    if (Array.isArray(parsed)) allMsgs = parsed as MessageLike[]
  } catch { /* malformed — fall through with empty allMsgs */ }

  // Detect legacy: any message missing a numeric `_seq`. Returning a partial
  // tail in this state is unsafe (the client's `sinceSeq=0` would slice
  // arbitrarily). Fall back to full payload; client treats `isPartial:false`
  // as "use the messages array verbatim".
  const anyMissingSeq = allMsgs.some(
    (m) => !m || typeof m._seq !== 'number' || !Number.isFinite(m._seq as number),
  )

  let messages: MessageLike[]
  let isPartial: boolean
  let maxSeq = 0
  for (const m of allMsgs) {
    const s = typeof m?._seq === 'number' ? m._seq : 0
    if (s > maxSeq) maxSeq = s
  }
  const sinceIsValid = Number.isFinite(sinceSeq) && sinceSeq > 0
  if (!anyMissingSeq && sinceIsValid) {
    messages = allMsgs.filter((m) => typeof m?._seq === 'number' && (m._seq as number) > sinceSeq)
    isPartial = true
  } else {
    messages = allMsgs
    isPartial = false
  }

  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    lastAt: row.last_at,
    messages,
    updatedAt: row.updated_at,
    totalMessageCount: allMsgs.length,
    maxSeq,
    isPartial,
  }
}

/** Soft-delete: zero out messages and mark as deleted. Prevents stale PUTs from resurrecting. */
export async function deleteClientSession(id: string, userId?: string): Promise<boolean> {
  const db = await getSessionsDb()
  const sql = userId
    ? "UPDATE client_sessions SET deleted_at = ?, messages = '[]', message_count = 0 WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    : "UPDATE client_sessions SET deleted_at = ?, messages = '[]', message_count = 0 WHERE id = ? AND deleted_at IS NULL"
  const now = Date.now()
  const result = userId ? db.prepare(sql).run(now, id, userId) : db.prepare(sql).run(now, id)
  return result.changes > 0
}

/** List unclaimed sessions (user_id='default') with summary for migration UI. */
export async function listUnclaimedSessions(): Promise<Array<{
  id: string; agentId: string; title: string; createdAt: number;
  lastAt: number; messageCount: number; summary: string
}>> {
  const db = await getSessionsDb()
  const rows = db.prepare(`
    SELECT id, agent_id, title, created_at, last_at, messages,
           message_count as msg_count
    FROM client_sessions
    WHERE user_id = 'default' AND deleted_at IS NULL
    ORDER BY last_at DESC
  `).all() as Array<{
    id: string; agent_id: string; title: string; created_at: number;
    last_at: number; messages: string; msg_count: number
  }>
  return rows.map(r => {
    // Extract first few user messages as summary
    let summary = ''
    try {
      const msgs = JSON.parse(r.messages) as Array<{ role?: string; text?: string }>
      const userMsgs = msgs.filter(m => m.role === 'user').slice(0, 3)
      summary = userMsgs.map(m => (m.text || '').slice(0, 80)).join(' / ')
      if (summary.length > 200) summary = summary.slice(0, 200) + '…'
    } catch {}
    return {
      id: r.id, agentId: r.agent_id, title: r.title,
      createdAt: r.created_at, lastAt: r.last_at,
      messageCount: r.msg_count, summary,
    }
  })
}

/** Claim an unclaimed session: atomically change user_id from 'default' to the target userId.
 *  Returns true if claimed, false if already claimed by someone else. */
export async function claimSession(sessionId: string, userId: string): Promise<boolean> {
  const db = await getSessionsDb()
  const result = db.prepare(`
    UPDATE client_sessions SET user_id = ?, updated_at = ?
    WHERE id = ? AND user_id = 'default' AND deleted_at IS NULL
  `).run(userId, Date.now(), sessionId)
  return result.changes > 0
}

export async function closeSessionsDb(): Promise<void> {
  if (_walTimer !== null) { clearInterval(_walTimer); _walTimer = null }
  process.removeListener('exit', _onExit)
  if (_db) {
    try { _db.pragma('wal_checkpoint(TRUNCATE)'); _db.close() } catch {}
    _db = null
  }
}
