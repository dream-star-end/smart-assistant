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
 *   5. If there are zero server-authored entries AND no client entry carries
 *      a forged `_source: 'server'`, `clientMsgs` is returned verbatim (no
 *      copy, same reference) — callers rely on this as a fast path. If a
 *      forgery is detected, a scrubbed copy is returned instead so later
 *      callers (notably {@link appendServerAuthoredPure}) cannot be tricked
 *      into treating a client row as authoritative.
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
  if (serverAuthored.size === 0) {
    // Fast path preserved — but we must still scrub any client-spoofed
    // `_source: 'server'` before returning, otherwise a malicious/bugged PUT
    // can plant a fake authoritative row that later callers (including
    // dropPhantomClientAssistants in appendServerAuthoredPure) will trust.
    return scrubClientSourceSpoof(clientMsgs, serverAuthored)
  }

  const clientIds = new Set<string>()
  for (const m of clientMsgs) {
    if (m && typeof m.id === 'string') clientIds.add(m.id)
  }

  // Replace client-provided entries with authoritative server copies when ids
  // match; strip `_source: 'server'` from all OTHER client entries so a client
  // PUT cannot forge an authoritative record for an id the server has never
  // authored. Only ids present in `serverAuthored` retain the flag.
  const merged: T[] = clientMsgs.map((m) => {
    if (!m) return m
    if (typeof m.id === 'string' && serverAuthored.has(m.id)) {
      return serverAuthored.get(m.id) as T
    }
    if ((m as MessageLike)._source === 'server') {
      const { _source, ...rest } = m as MessageLike & { _source?: unknown }
      void _source  // discard
      return rest as T
    }
    return m
  })
  for (const [, msg] of serverAuthored) {
    if (typeof msg.id === 'string' && !clientIds.has(msg.id)) merged.push(msg)
  }
  merged.sort((a, b) => ((a?.ts ?? 0) - (b?.ts ?? 0)))

  return dropPhantomClientAssistants(merged)
}

/**
 * Strips `_source: 'server'` from client-provided messages whose ids are not
 * in the authoritative `trusted` map. Preserves input reference when nothing
 * needs scrubbing (the common case — client never sets this field). See the
 * merge-fast-path and appendServerAuthoredPure callers for why this matters:
 * without it, a malformed PUT can make later phantom-dedupe passes treat
 * spoofed client rows as server-authored and drop legitimate assistant rows.
 */
function scrubClientSourceSpoof<T extends MessageLike>(
  clientMsgs: readonly T[],
  trusted: ReadonlyMap<string, T>,
): T[] | readonly T[] {
  let needsScrub = false
  for (const m of clientMsgs) {
    if (!m) continue
    if ((m as MessageLike)._source !== 'server') continue
    if (typeof m.id === 'string' && trusted.has(m.id)) continue
    needsScrub = true
    break
  }
  if (!needsScrub) return clientMsgs
  return clientMsgs.map((m) => {
    if (!m) return m
    if ((m as MessageLike)._source !== 'server') return m
    if (typeof m.id === 'string' && trusted.has(m.id)) return m
    const { _source, ...rest } = m as MessageLike & { _source?: unknown }
    void _source
    return rest as T
  })
}

/**
 * Phantom-assistant dedupe (Phase 0.4 P0-3). Partitions `messages` into turns
 * on user/system boundaries and, within each turn, drops every client-authored
 * assistant entry when that turn also contains at least one server-authored
 * assistant. The server-authored message is the authoritative copy of the
 * turn's full response; the client-side bubble(s) stamped during streaming
 * are just UI scaffolding and would otherwise render as duplicates.
 *
 * Called from two write paths so phantom cleanup is uniform regardless of
 * whether the server-authored entry arrived via client PUT merge
 * ({@link mergePreservingServerAuthored}) or direct gateway append
 * ({@link appendServerAuthoredPure}):
 *
 *   - Client PUT merge: the client's streamed `m-*` assistant message is
 *     carried in the PUT payload while the server already has the `srv-*`
 *     turn record; dedupe drops the former before we persist.
 *   - Direct gateway append: gateway's turn.completed handler writes the
 *     `srv-*` record into a messages array that may still contain a
 *     client `m-*` phantom from an earlier PUT (happens when the client
 *     does not PUT again after the turn finishes — mobile backgrounded,
 *     tab closed, session switched). Without dedupe here the phantom lives
 *     in the DB forever and every page load sees the assistant twice.
 *
 * Why partition-level (not pair-wise) — tool-use turns: the frontend splits
 * assistant output at each tool_use boundary (websocket.js clears
 * `_streamingAssistant` on tool_use / tool_result blocks), producing multiple
 * `m-*` assistant segments around `tool` / `tool_result` rows. The server
 * writes ONE aggregated `srv-*` assistant per turn. Adjacency-only dedupe
 * would leave earlier client segments orphaned; partition-wise dedupe drops
 * them all together.
 *
 * Invariants:
 *   - Never drops a server-authored message.
 *   - Never drops a non-assistant message (tool / tool_result / user /
 *     thinking / etc. are always preserved).
 *   - Tolerates both ts-sort orders within a turn (server ts before or after
 *     client segments — wallclock drift across devices).
 *   - Tolerates cross-boundary clock skew: if a server-authored assistant
 *     sorts BEFORE its triggering user/system message (client clock was
 *     ahead), the row's `srv-<peer>-t<N>` id is parsed to re-home it to
 *     sort-order group N (1-indexed turn, matching sessionManager.ts's
 *     `session.turns + 1`). Messages with ids that do not match the
 *     `-t<N>` convention (cron/proactive/webhook origin) stay put — they
 *     carry no turn-index signal and are not paired with any phantom.
 *   - Stable for partitions without a server-authored assistant: those
 *     client assistants survive unchanged.
 *   - Fast path: returns the input reference verbatim when no server-authored
 *     assistant exists anywhere (callers rely on this for the "pure client
 *     history" shape; see the msgOutbox replay and first-PUT path).
 */
export function dropPhantomClientAssistants<T extends MessageLike>(
  messages: readonly T[],
): T[] | readonly T[] {
  const isAssistant = (m: T | undefined) =>
    !!m && (m as { role?: string }).role === 'assistant'
  const isTurnBoundary = (m: T | undefined) => {
    if (!m) return false
    const role = (m as { role?: string }).role
    return role === 'user' || role === 'system'
  }

  // Fast path: no server-authored assistant anywhere => no phantoms to drop.
  // Lets callers short-circuit without allocating; also preserves the
  // "pure client history returns same reference" contract relied on by
  // mergePreservingServerAuthored's own fast-path invariants.
  let hasAnyServerAsst = false
  for (const m of messages) {
    if (isAssistant(m) && (m as MessageLike)._source === 'server') {
      hasAnyServerAsst = true
      break
    }
  }
  if (!hasAnyServerAsst) return messages

  // First pass: compute per-index turn group id and whether that group has
  // any server-authored assistant. We need the ENTIRE partition answer
  // because a phantom earlier in the partition must drop even if the
  // server-authored entry lands later (or vice versa — clock drift).
  //
  // We also maintain a parallel `userTurnToGroup[N]` map: the group id of the
  // Nth user-bounded turn (1-indexed). Only `user` boundaries increment the
  // user-turn counter, even though both `user` and `system` open new
  // partitions. Gateway's `session.turns` counter (which produces the `-tN`
  // suffix on server-authored ids) tracks model turns, which in the current
  // codebase are always user-triggered; system rows (reserved for future
  // context-injection or prompts) do not contribute to turn numbering. This
  // separation prevents system messages from shifting `-tN` → group mapping.
  const turnGroup: number[] = new Array(messages.length)
  const groupHasServerAsst: boolean[] = []
  const userTurnToGroup: number[] = []  // userTurnToGroup[N] = sort-order group of Nth user turn
  let groupId = 0
  let currentGroupHasServer = false
  for (let i = 0; i < messages.length; i++) {
    const cur = messages[i]
    if (isTurnBoundary(cur)) {
      // Close previous group, open a new one. The boundary row itself
      // belongs to the newly-opened group (a user message opens a new
      // turn; anything the model produces after it is part of that turn).
      groupHasServerAsst.push(currentGroupHasServer)
      groupId++
      currentGroupHasServer = false
      // Only `user` boundaries advance the user-turn counter — system
      // partitions get their own group slot but don't claim a turn index.
      if ((cur as { role?: string }).role === 'user') {
        userTurnToGroup.push(groupId)  // push at index (userTurnIdx - 1) where userTurnIdx starts at 1
      }
    }
    turnGroup[i] = groupId
    if (isAssistant(cur) && (cur as MessageLike)._source === 'server') {
      currentGroupHasServer = true
    }
  }
  groupHasServerAsst.push(currentGroupHasServer)

  // Clock-skew normalization via id-aware turn mapping. Phase 0.1
  // server-authored assistants are stamped with `srv-<peer>-t<N>` where N is
  // the 1-indexed turn number (see sessionManager.ts: `session.turns + 1`).
  // When the client's clock was ahead of the server by more than the turn's
  // wallclock duration, the server row sorts before its triggering user
  // message and lands in a lower sort-order group than its semantic turn N.
  // Re-home those rows to the group containing the Nth user turn so phantom
  // pairing uses the correct partition.
  //
  // Messages WITHOUT a `-tN` suffix — cron / proactive / webhook-origin writes
  // via appendServerAuthoredMessage with arbitrary ids — carry no turn-index
  // signal, so they stay in whatever sort-order group they landed in. Those
  // writes are not paired with any phantom client assistant anyway (the
  // triggering edge is server-side), so leaving them put is correct.
  //
  // MAX_TURN_DIGITS bounds the regex numeric capture to a safe-integer range
  // without relying on Number.isSafeInteger at the edge — a session would need
  // ~10^14 turns to approach Number.MAX_SAFE_INTEGER, far beyond anything real.
  const TURN_ID_RE = /-t(\d{1,15})$/
  let migrated = false
  for (let i = 0; i < messages.length; i++) {
    const cur = messages[i]
    if (!isAssistant(cur) || (cur as MessageLike)._source !== 'server') continue
    const id = (cur as MessageLike).id
    if (typeof id !== 'string') continue
    const m = TURN_ID_RE.exec(id)
    if (!m) continue
    const turnIdx = parseInt(m[1]!, 10)
    if (!Number.isFinite(turnIdx) || turnIdx < 1) continue
    // Map 1-indexed turn N to the group of the Nth user-bounded turn. If no
    // such user turn exists yet in this messages array (e.g., the user boundary
    // was not persisted), we cannot re-home safely and leave the row put — a
    // later merge that introduces the user row can re-run this helper.
    const targetGroup = userTurnToGroup[turnIdx - 1]
    if (targetGroup === undefined) continue
    if (turnGroup[i] === targetGroup) continue  // already in correct group
    turnGroup[i] = targetGroup
    migrated = true
  }
  if (migrated) {
    // Rebuild group-has-server flags from scratch after any migration — cheaper
    // and less error-prone than surgical flips, since we may have moved rows
    // both forward (skew case) and conceivably backward across multiple turns.
    for (let g = 0; g < groupHasServerAsst.length; g++) groupHasServerAsst[g] = false
    for (let i = 0; i < messages.length; i++) {
      const cur = messages[i]
      if (isAssistant(cur) && (cur as MessageLike)._source === 'server') {
        groupHasServerAsst[turnGroup[i]] = true
      }
    }
  }

  const deduped: T[] = []
  for (let i = 0; i < messages.length; i++) {
    const cur = messages[i]
    if (!cur) { deduped.push(cur); continue }
    // Keep server-authored messages, non-assistant messages, and assistants
    // in a partition without a server-authored counterpart.
    if (!isAssistant(cur) || (cur as MessageLike)._source === 'server') {
      deduped.push(cur)
      continue
    }
    const g = turnGroup[i]
    if (groupHasServerAsst[g]) {
      // Client-assistant in a turn that the server re-authored. Drop.
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
  // Phantom cleanup: client-side streaming may have stamped a `m-*` assistant
  // bubble for the same turn we are now server-authoring. If the client never
  // re-PUTs this session (mobile backgrounded, tab closed, switched away),
  // upsertClientSession's merge-path dedupe never runs and the phantom would
  // live forever — rendering as a duplicate assistant on every load. Doing
  // dedupe here makes the write idempotent relative to prior client state.
  //
  // dropPhantomClientAssistants's fast path (no server-authored anywhere) is
  // impossible post-append: we just stamped one. The returned array is a new
  // allocation when any phantom was dropped; otherwise the function returns
  // `next` verbatim. Narrow to T[] — we know it is mutable (we built it here).
  const cleaned = dropPhantomClientAssistants(next) as T[]
  return { applied: true, messages: cleaned }
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
      'SELECT messages, updated_at FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).get(session.id, session.userId) as { messages: string; updated_at: number } | undefined

    // Reject stale writes (same optimistic concurrency check as the pre-transaction version)
    if (existing && existing.updated_at > baseSyncedAt) return false

    // Always route through mergePreservingServerAuthored so the client-forged
    // `_source: 'server'` scrub runs uniformly. For new-session inserts we
    // pass an empty `oldMsgs`, which hits the merge's empty-server fast path
    // where the only work is `scrubClientSourceSpoof(clientMsgs, emptyMap)` —
    // stripping `_source` off any unknown-id client entry so that a later
    // `appendServerAuthoredMessage` cannot trust forged flags in the persisted
    // messages array.
    let oldMsgs: MessageLike[] = []
    if (existing) {
      try {
        const parsed = JSON.parse(existing.messages) as MessageLike[]
        if (Array.isArray(parsed)) oldMsgs = parsed
      } catch { /* malformed existing messages JSON — fall through with oldMsgs=[] */ }
    }
    const clientMsgs = session.messages as MessageLike[]
    const finalMessages = mergePreservingServerAuthored(oldMsgs, clientMsgs) as unknown[]

    const result = db.prepare(`
      INSERT INTO client_sessions (id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at)
      VALUES (@id, @userId, @agentId, @title, @pinned, @createdAt, @lastAt, @messages, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        title = excluded.title,
        pinned = excluded.pinned,
        last_at = excluded.last_at,
        messages = excluded.messages,
        updated_at = excluded.updated_at
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
      updatedAt: session.updatedAt,
      baseSyncedAt,
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
      'SELECT messages FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).get(sessId, userId) as { messages: string } | undefined
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

    const now = Date.now()
    db.prepare(
      'UPDATE client_sessions SET messages = ?, last_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(JSON.stringify(result.messages), now, now, sessId, userId)
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
           json_array_length(messages) as msg_count
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

/** Soft-delete: zero out messages and mark as deleted. Prevents stale PUTs from resurrecting. */
export async function deleteClientSession(id: string, userId?: string): Promise<boolean> {
  const db = await getSessionsDb()
  const sql = userId
    ? "UPDATE client_sessions SET deleted_at = ?, messages = '[]' WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    : "UPDATE client_sessions SET deleted_at = ?, messages = '[]' WHERE id = ? AND deleted_at IS NULL"
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
           json_array_length(messages) as msg_count
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
