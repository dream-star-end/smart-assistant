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
  // Migration: origin_channel — marks rows authored by a non-webchat channel
  // (currently only 'wechat' via the broker). NULL = legacy/webchat (default).
  // The wechat broker's reconcile path scopes its orphan-detection sweep to
  // `origin_channel = 'wechat'` so it never touches rows owned by other
  // channels. See packages/commercial/src/wechat/broker.ts + design.md §3.
  //
  // ALTER TABLE ADD COLUMN with default NULL is metadata-only and fast on
  // SQLite (brief schema/write lock; no row rewrite).
  try {
    const cols = db.pragma('table_info(client_sessions)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'origin_channel')) {
      db.exec("ALTER TABLE client_sessions ADD COLUMN origin_channel TEXT DEFAULT NULL")
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

  // ── Usage aggregation: server-authored requestId index + pending cost patches ──
  //
  // Two tables coordinate the timing-invariant single-writer aggregation of
  // assistant `usage` info into `client_sessions.messages`. See plan
  // §4.1 改动 3 for the design rationale.
  //
  //   server_authored_request_map: index from requestId → (sessionId, msgId)
  //     populated by appendServerAuthoredMessageForRequest. Lets a late
  //     appendCostCredits call locate the message it must patch.
  //
  //   pending_usage_patches: where appendCostCredits parks a costCredits
  //     value when the corresponding server-authored message hasn't been
  //     written yet. Drained inside appendServerAuthoredMessageForRequest's
  //     transaction.
  //
  // Both tables use composite PK (request_id, user_id) so a malformed or
  // forged requestId cannot collide across users (Codex R4 defense-in-depth).
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_authored_request_map (
      request_id  TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      msg_id      TEXT NOT NULL,
      written_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000),
      PRIMARY KEY (request_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sarm_session ON server_authored_request_map(session_id, msg_id);
    CREATE INDEX IF NOT EXISTS idx_sarm_written ON server_authored_request_map(written_at);

    CREATE TABLE IF NOT EXISTS pending_usage_patches (
      request_id   TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      session_id   TEXT,
      cost_credits TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000),
      PRIMARY KEY (request_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pup_created ON pending_usage_patches(created_at);
    -- by-user drain(ccb-spawn 路径 appendServerAuthoredMessageDrainByUser 的 WHERE user_id)
    -- 走索引,避免 pending 积压时全表扫。
    CREATE INDEX IF NOT EXISTS idx_pup_user ON pending_usage_patches(user_id);
  `)

  // 旧重量级团队模式(team_runs / team_delegations)已整套删除:schema 不再声明,
  // 存量本地 DB 里已建的表留着无害(不写 DROP TABLE,不迁移)。
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

// Returns the maximum turn_idx already persisted in the FTS index across
// any of `sessionIds`, or 0 if none. Used by the gateway's SessionManager
// to resume the per-session turn counter after a process restart so that
// re-indexed turns don't collide with already-persisted (session_id,
// turn_idx) rows.
//
// Accepts an array because legacy rows may have been written under a
// different id (e.g. ccbSessionId) before FTS sessId was tightened to
// sessionKey. Caller passes [sessionKey, legacyId?] so the resumed
// counter is the global max across both ids.
export async function getMaxTurnIdx(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0
  const db = await getSessionsDb()
  const placeholders = sessionIds.map(() => '?').join(',')
  const row = db
    .prepare(
      `SELECT MAX(turn_idx) AS m FROM sessions_fts WHERE session_id IN (${placeholders})`,
    )
    .get(...sessionIds) as { m: number | null } | undefined
  return row?.m == null ? 0 : Math.floor(row.m)
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
 * Hard cap on the serialized `messages` JSON blob inside a single
 * `client_sessions` row, in bytes. Writes that would push the blob past this
 * limit are rejected with the `'oversized'` outcome BEFORE the SQLite
 * transaction commits. The cap is the primary defence against the
 * 2026-05-08 incident: a single 8MB+ row caused every PUT/append to spin
 * the Node main thread on `JSON.parse` → `db.transaction()` → `JSON.stringify`,
 * blocking the event loop until the watchdog killed the process.
 *
 * Sized at 4MB so a typical heavy session (long thread + a few small
 * inline images) fits comfortably while no single session can ever again
 * starve the event loop. Wire-level body limit (gateway PUT) is set to
 * 2MB so the per-PUT overhead can never exceed half this budget; existing
 * append-only writers (server-authored thinking/assistant/tool rows)
 * contribute under 64KB per turn.
 */
export const MAX_SESSION_BYTES = 4 * 1024 * 1024

/**
 * Outcome of `upsertClientSession`. Replaces the older boolean return so
 * the gateway can map oversized writes to HTTP 413 without colliding with
 * the legitimate stale-write 409 path. `'applied'` is the only success
 * state; the two failure modes (`'rejected_stale'`, `'oversized'`) carry
 * distinct retry semantics and MUST stay distinguishable upstream.
 */
export type UpsertClientSessionResult = 'applied' | 'rejected_stale' | 'oversized'

// ── Client PUT field strip ──
//
// `upsertClientSession` is the only place the wire-format message blob enters
// the SQLite messages JSON, and the wire is *partially* trusted. Our defense
// model is:
//   1. CLIENT_PUT_ALLOWED_FIELDS (allow-list) — pass-through unchanged.
//   2. CLIENT_PUT_ALLOWED_STATUSES — `status` may only carry these values.
//      In particular `'replied'` is REJECTED here because it is now derived at
//      render time from "any subsequent server-authored assistant exists in
//      this turn". Letting client-supplied `'replied'` survive a PUT would let
//      the persisted blob disagree with the derivation.
//   3. SERVER_AUTHORITATIVE_FIELDS (deny-list) — fields whose only legal
//      author is the storage layer itself (via `appendServerAuthoredMessage*`
//      helpers). Hitting one of these from a client PUT is either a bug or an
//      attack; we drop the value AND increment a counter so prod can catch
//      drift.
//   4. Anything else (metaText, _rawMeta, _partial, output, …) → silent drop.
//      These are ephemeral or derived and have no legitimate role in the
//      persisted blob.
//
// `appendServerAuthoredMessage*` paths bypass this strip entirely — they are
// the single trusted writers of the deny-listed fields.

const CLIENT_PUT_ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  // identity / content
  'id', 'role', 'text', 'ts', 'createdAt', 'completedAt',
  // Codex app-server plan cards (client-authored live plan rows).
  // These must survive PUT/refresh; otherwise the card body disappears once
  // server-side strip normalizes the session row.
  'explanation', 'steps',
  // child blocks (subagent groupings, thinking inside assistants, etc.)
  'childBlocks', 'agentName', 'agentId',
  // tool messages
  'toolName', 'toolIcon', 'toolInput', 'toolUseId', 'parentToolUseId',
  // Phase 1 tool durability — `blockId` is the per-turn stable identifier
  // (== Anthropic tool_use_id) the client streams set on each tool message.
  // Allowed-listing it here lets `mergePreservingServerAuthored` dedupe
  // client tool rows against server-authored tool rows by blockId within
  // the same turn group. Without this, the field is silently dropped on
  // every PUT and the merge loses its dedupe key, leaving doubled bare-
  // label tool cards next to the rich server-authored ones after refresh.
  'blockId',
  // empty-turn / cron metadata
  '_emptyTurn', '_emptyTurnSoft', '_emptyTurnStopReason', 'cronJob',
  // client-persistent private fields (server treats opaquely)。
  // _teamRun 有意保留:它只是客户端消息上的 opaque 展示元数据(legacy packages/web
  // 仍写入),与已删除的服务端 team_run 子系统无关,server 不解释。
  '_media', '_modelText', '_teamRun',
])

const CLIENT_PUT_ALLOWED_STATUSES: ReadonlySet<string> = new Set<string>([
  'sending', 'queued', 'sent', 'read',
])

const SERVER_AUTHORITATIVE_FIELDS: ReadonlySet<string> = new Set<string>([
  '_source', '_seq', 'usage',
  '_truncated', '_errorCode', '_errorDetail',
])

/**
 * Module-level counter of fields rejected from client PUT bodies. Keyed by
 * field name. Read by `getClientPutBlockedFieldCounts()` for tests / metrics
 * scrape; reset by `_resetClientPutBlockedFieldCountsForTest()`.
 *
 * Plain object, not a class — counters are append-only, no concurrent
 * writers in single-process gateway.
 */
const _clientPutBlockedFieldCounts: Record<string, number> = Object.create(null)

/** Returns a snapshot copy of the blocked-field counter. */
export function getClientPutBlockedFieldCounts(): Record<string, number> {
  return { ..._clientPutBlockedFieldCounts }
}

/** Tests only — clear the counter between cases. */
export function _resetClientPutBlockedFieldCountsForTest(): void {
  for (const k of Object.keys(_clientPutBlockedFieldCounts)) {
    delete _clientPutBlockedFieldCounts[k]
  }
}

/**
 * Strip a single message coming in via CLIENT PUT to the allow-list.
 * Returns null if the input is structurally invalid (non-object).
 *
 * Pure: doesn't mutate input.
 */
export function _stripClientPutMessage(msg: unknown): MessageLike | null {
  if (!msg || typeof msg !== 'object') return null
  const src = msg as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    if (CLIENT_PUT_ALLOWED_FIELDS.has(k)) {
      out[k] = src[k]
    } else if (k === 'status') {
      const v = src[k]
      if (typeof v === 'string' && CLIENT_PUT_ALLOWED_STATUSES.has(v)) {
        out.status = v
      }
      // 'replied' or any other value → drop (derived at render time).
    } else if (SERVER_AUTHORITATIVE_FIELDS.has(k)) {
      _clientPutBlockedFieldCounts[k] = (_clientPutBlockedFieldCounts[k] ?? 0) + 1
      // value dropped
    }
    // unknown / ephemeral fields (metaText, _rawMeta, _partial, output, …) → silent drop.
  }
  return out as MessageLike
}

/**
 * Strip an entire `messages` array from a client PUT to the allow-list.
 * Returns a new array with malformed entries removed.
 */
export function _stripClientPutMessages(messages: readonly unknown[]): MessageLike[] {
  const out: MessageLike[] = []
  for (const m of messages) {
    const cleaned = _stripClientPutMessage(m)
    if (cleaned !== null) out.push(cleaned)
  }
  return out
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
 *   5. If there are zero server-authored entries AND no duplicate client
 *      plan rows, `clientMsgs` is returned verbatim (no copy, same reference)
 *      — callers rely on this as a fast path.
 *   6. **Phantom-tool dedupe** (Phase 1 tool durability fix): client and
 *      server use independent tool message IDs (client uses `m-*`; server
 *      writes `srv-${sessionId}-t${turnIndex}-tool-${blockId}`) but share
 *      the same `blockId` (== Anthropic tool_use_id). After turn-end the
 *      sink persists rich server-authored tool rows; the client's bare
 *      tool rows (post-PUT-strip: only id/role/text/toolName/blockId/ts
 *      survive) are still in the array. We drop the client tool row when
 *      there is a server-authored tool row with the same blockId in the
 *      same turn group. Never drops a server-authored entry. Without this
 *      rule the user sees doubled tool cards on refresh — one rich, one
 *      bare. Tools inside `childBlocks` (subagent tools, Phase 2) are
 *      untouched because they are nested, not top-level merged[] entries.
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
  const planDedupedClientMsgs = dedupeClientPlanRowsWithinTurns(clientMsgs)
  if (serverAuthored.size === 0) return planDedupedClientMsgs

  const clientIds = new Set<string>()
  for (const m of planDedupedClientMsgs) {
    if (m && typeof m.id === 'string') clientIds.add(m.id)
  }

  const merged: T[] = planDedupedClientMsgs.map((m) => {
    if (m && typeof m.id === 'string' && serverAuthored.has(m.id)) {
      return serverAuthored.get(m.id) as T
    }
    return m
  })
  for (const [, msg] of serverAuthored) {
    if (typeof msg.id === 'string' && !clientIds.has(msg.id)) merged.push(msg)
  }
  merged.sort((a, b) => ((a?.ts ?? 0) - (b?.ts ?? 0)))

  // Phantom dedupe (rule 3): partition merged[] into turns on user/system
  // messages (turn boundaries — the model never produces those client-side
  // on its own). Within each partition, dedupe two roles independently:
  //   - assistant: if a server-authored assistant exists in the group, drop
  //     all non-server-authored assistants in that group.
  //   - thinking: same rule, but for role==='thinking' messages.
  //
  // Why two independent role flags (vs one combined): server writes a
  // thinking row with role==='thinking' and an assistant row with
  // role==='assistant'. They share a turn group. A client streaming buffer
  // may produce a phantom thinking-only message but NOT a phantom assistant
  // (or vice versa). Treating them independently lets us drop just the
  // role that has a server counterpart, preserving the other role's client
  // version when there's no server counterpart yet (mid-streaming snapshot).
  //
  // This is broader than a simple adjacency check because tool-use turns
  // end up with MULTIPLE client-side assistant segments separated by
  // tool_use / tool_result messages (see websocket.js where a tool_use
  // block clears `_streamingAssistant` so the next text creates a new
  // bubble). Server writes one aggregated assistant per turn, so pair-wise
  // adjacency would leave earlier client segments orphaned.
  //
  // Never drops a server-authored message; never drops a client message
  // that is not an assistant or thinking (tool, tool_result, user, etc.
  // always preserved). Also tolerates both ts-sort orders of the server
  // row relative to client segments (server clock earlier or later).
  //
  // Subagent thinking lives inside `childBlocks.kind: 'thinking'` of an
  // assistant message — it is NOT a top-level role==='thinking' message,
  // so this dedupe does not touch it.
  const deduped: T[] = []
  const isAssistant = (m: T) => (m as { role?: string }).role === 'assistant'
  const isThinking = (m: T) => (m as { role?: string }).role === 'thinking'
  const isTool = (m: T) => (m as { role?: string }).role === 'tool'
  const isTurnBoundary = (m: T) => {
    const role = (m as { role?: string }).role
    return role === 'user' || role === 'system'
  }
  // First pass: compute per-index turn group id, and whether that group has
  // any server-authored assistant / thinking message + the set of server-
  // authored tool blockIds in that group (rule 6, Phase 1 tool durability).
  const turnGroup: number[] = new Array(merged.length)
  const groupHasServerAsst: boolean[] = []
  const groupHasServerThinking: boolean[] = []
  const groupServerToolBlockIds: Array<Set<string>> = []
  let groupId = 0
  let curGroupServerAsst = false
  let curGroupServerThinking = false
  let curGroupServerToolBlockIds = new Set<string>()
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]
    if (cur && isTurnBoundary(cur)) {
      // Close previous group, open a new one.
      groupHasServerAsst.push(curGroupServerAsst)
      groupHasServerThinking.push(curGroupServerThinking)
      groupServerToolBlockIds.push(curGroupServerToolBlockIds)
      groupId++
      curGroupServerAsst = false
      curGroupServerThinking = false
      curGroupServerToolBlockIds = new Set<string>()
    }
    turnGroup[i] = groupId
    if (cur && cur._source === 'server') {
      if (isAssistant(cur)) curGroupServerAsst = true
      else if (isThinking(cur)) curGroupServerThinking = true
      else if (isTool(cur)) {
        const bid = (cur as { blockId?: unknown }).blockId
        if (typeof bid === 'string' && bid.length > 0) {
          curGroupServerToolBlockIds.add(bid)
        }
      }
    }
  }
  groupHasServerAsst.push(curGroupServerAsst)
  groupHasServerThinking.push(curGroupServerThinking)
  groupServerToolBlockIds.push(curGroupServerToolBlockIds)

  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]
    if (!cur) { deduped.push(cur); continue }
    // Keep server-authored messages and non-(assistant|thinking|tool) messages.
    if (
      cur._source === 'server' ||
      (!isAssistant(cur) && !isThinking(cur) && !isTool(cur))
    ) {
      deduped.push(cur)
      continue
    }
    const g = turnGroup[i]
    if (isAssistant(cur) && groupHasServerAsst[g]) continue
    if (isThinking(cur) && groupHasServerThinking[g]) continue
    if (isTool(cur)) {
      // Drop client tool only when a server tool with matching blockId
      // exists in the same group. Tools without blockId (legacy, or post-
      // PUT-strip from a pre-allow-list deploy) are kept — better to show
      // a doubled card on rare legacy data than to drop user-visible
      // detail wholesale.
      const bid = (cur as { blockId?: unknown }).blockId
      if (
        typeof bid === 'string' &&
        bid.length > 0 &&
        groupServerToolBlockIds[g].has(bid)
      ) continue
    }
    deduped.push(cur)
  }
  return dedupeClientPlanRowsWithinTurns(deduped) as T[]
}

function isPlanTurnBoundary(m: MessageLike): boolean {
  const role = (m as { role?: unknown }).role
  return role === 'user' || role === 'system'
}

function isClientPlanWithBlockId(m: MessageLike): boolean {
  const blockId = planBlockId(m)
  return (
    m._source !== 'server' &&
    (m as { role?: unknown }).role === 'plan' &&
    blockId !== null
  )
}

function planBlockId(m: MessageLike): string | null {
  const blockId = (m as { blockId?: unknown }).blockId
  return typeof blockId === 'string' && blockId.length > 0 ? blockId : null
}

function planRank(m: MessageLike): [number, number, number, number] {
  const partial = (m as { _partial?: unknown })._partial
  const partialRank = partial === false ? 2 : partial === true ? 0 : 1
  const steps = Array.isArray((m as { steps?: unknown }).steps)
    ? (m as { steps: unknown[] }).steps
    : []
  const completed = steps.filter((s) =>
    s && typeof s === 'object' && (s as { status?: unknown }).status === 'completed'
  ).length
  const completedAt = (m as { completedAt?: unknown }).completedAt
  const time = Math.max(
    typeof completedAt === 'number' && Number.isFinite(completedAt) ? completedAt : 0,
    typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : 0,
  )
  return [partialRank, completed, steps.length, time]
}

function comparePlan(a: MessageLike, b: MessageLike): number {
  const ar = planRank(a)
  const br = planRank(b)
  for (let i = 0; i < ar.length; i++) {
    if (ar[i] !== br[i]) return ar[i] - br[i]
  }
  return 0
}

function dedupeClientPlanRowsWithinTurns<T extends MessageLike>(msgs: readonly T[]): T[] | readonly T[] {
  let hasDuplicate = false
  const seen = new Set<string>()
  for (const m of msgs) {
    if (isPlanTurnBoundary(m)) seen.clear()
    if (!isClientPlanWithBlockId(m)) continue
    const blockId = planBlockId(m)!
    if (seen.has(blockId)) {
      hasDuplicate = true
      break
    }
    seen.add(blockId)
  }
  if (!hasDuplicate) return msgs

  const out: T[] = []
  let group: T[] = []
  const flush = () => {
    if (group.length === 0) return
    const keepByBlockId = new Map<string, T>()
    for (const m of group) {
      if (!isClientPlanWithBlockId(m)) continue
      const blockId = planBlockId(m)!
      const prev = keepByBlockId.get(blockId)
      if (!prev || comparePlan(m, prev) > 0) keepByBlockId.set(blockId, m)
    }
    for (const m of group) {
      if (!isClientPlanWithBlockId(m)) {
        out.push(m)
        continue
      }
      const blockId = planBlockId(m)!
      if (keepByBlockId.get(blockId) === m) out.push(m)
    }
    group = []
  }

  for (const m of msgs) {
    if (isPlanTurnBoundary(m)) {
      flush()
      out.push(m)
      continue
    }
    group.push(m)
  }
  flush()
  return out
}

/**
 * Idempotent append / takeover overlay of a server-authored message into
 * an existing messages array.
 *
 *   - Same id, existing row has `_source: 'server'` → no-op (idempotent
 *     replay of a takeover that already landed).
 *   - Same id, existing row is a CLIENT placeholder (no `_source: 'server'`)
 *     → REPLACE at position. Required by v7 architecture: client streaming
 *     row now uses canonical `srv-${peerId}-t${turnIndex}` id and may PUT
 *     its placeholder into `client_sessions.messages` BEFORE Phase 0.1
 *     turn-end takeover runs. Pre-v7 this could not happen — only the
 *     server ever wrote `srv-*` ids — so a same-id collision implied a
 *     duplicate server write. Post-v7 the same-id case can also mean
 *     "server-authored canonical version is overtaking the client's
 *     streaming placeholder", and we must overlay rather than skip.
 *   - No same id → append.
 *
 * On takeover, server-authored ts wins; falls back to existing placeholder
 * ts; final fallback `now`. `_seq` reassignment downstream is handled by
 * `normalizeAndAssignSeqs` — the takeover bumps `_source: 'server'`, which
 * is NOT in `_SEQ_CONTENT_IGNORE_FIELDS`, so the row gets a fresh `_seq`
 * and client incremental GET observes the takeover.
 *
 * `applied: true` covers BOTH new-append and takeover-overlay. Callers that
 * care to distinguish can inspect the returned messages array; this keeps
 * the type stable and avoids forcing every caller to branch on a new
 * outcome variant.
 *
 * Pure: doesn't mutate `existing`.
 */
export function appendServerAuthoredPure<T extends MessageLike>(
  existing: readonly T[],
  message: T & { id: string },
  now: number = Date.now(),
): { applied: true; messages: T[] } | { applied: false; reason: 'already_exists' } {
  const idx = existing.findIndex((m) => m && m.id === message.id)
  if (idx >= 0) {
    const cur = existing[idx] as (T & { _source?: string }) | undefined
    // True idempotent: a server-authored row with this id already exists.
    // Re-applying would either be a no-op (same content → no _seq churn) or
    // would clobber a later authoritative write; either way, refuse.
    if (cur && cur._source === 'server') {
      return { applied: false, reason: 'already_exists' }
    }
    // Takeover overlay: client placeholder gives way to server-authored.
    const stamped = {
      ...message,
      _source: 'server',
      ts: message.ts ?? cur?.ts ?? now,
    } as T
    const next = existing.slice()
    next[idx] = stamped
    next.sort((a, b) => ((a?.ts ?? 0) - (b?.ts ?? 0)))
    return { applied: true, messages: next }
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
        out[i] = { ...m, _seq: old._seq }
      }
    } else {
      out[i] = { ...m, _seq: nextSeq }
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
export async function upsertClientSession(session: ClientSession, baseSyncedAt = 0): Promise<UpsertClientSessionResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): UpsertClientSessionResult => {
    const existing = db.prepare(
      'SELECT messages, updated_at, next_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).get(session.id, session.userId) as { messages: string; updated_at: number; next_seq: number | null } | undefined

    // Reject stale writes (same optimistic concurrency check as the pre-transaction version)
    if (existing && existing.updated_at > baseSyncedAt) return 'rejected_stale'

    let oldMsgs: MessageLike[] = []
    if (existing) {
      try {
        const parsed = JSON.parse(existing.messages)
        if (Array.isArray(parsed)) oldMsgs = parsed as MessageLike[]
      } catch { /* malformed existing messages JSON — treat as empty */ }
    }
    // Strip the incoming client PUT to the allow-list BEFORE merge. This is
    // the single chokepoint for `_source/_seq/usage/_truncated/_errorCode/
    // _errorDetail/status='replied'/_rawMeta/...` rejection. See
    // _stripClientPutMessage above for the full deny/ephemeral matrix.
    const clientMsgs = _stripClientPutMessages(session.messages as unknown[])
    const merged = mergePreservingServerAuthored(oldMsgs, clientMsgs) as MessageLike[]
    const currentNextSeq = existing && typeof existing.next_seq === 'number' && existing.next_seq > 0
      ? existing.next_seq
      : 1
    const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(oldMsgs, merged, currentNextSeq)

    // Size guard — see MAX_SESSION_BYTES. Reject BEFORE the INSERT so an
    // oversized incoming PUT can never grow the row, and so subsequent reads
    // never have to JSON.parse a blob big enough to stall the event loop.
    // The check uses Buffer.byteLength so multi-byte UTF-8 characters
    // (Chinese text, emoji) count against the same budget the disk row will
    // occupy. JSON.stringify is unavoidable here — it's the only way to
    // know the post-merge blob size — but since we already had to compute
    // it for the INSERT below, this adds no new serialization overhead.
    const finalJson = JSON.stringify(finalMessages)
    if (Buffer.byteLength(finalJson, 'utf8') > MAX_SESSION_BYTES) {
      return 'oversized'
    }

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
      messages: finalJson,
      messageCount: finalMessages.length,
      updatedAt: session.updatedAt,
      baseSyncedAt,
      nextSeq,
    })
    // result.changes === 0 happens when the ON CONFLICT WHERE filter rejected
    // the UPDATE because client_sessions.updated_at > @baseSyncedAt — i.e. a
    // racing concurrent write committed between our SELECT (above) and this
    // INSERT. Surface as the same stale outcome so the gateway returns 409.
    return result.changes > 0 ? 'applied' : 'rejected_stale'
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
export type ServerAuthoredAppendResult =
  | { applied: true }
  | { applied: false; reason: 'session_not_found' | 'session_deleted' | 'already_exists' | 'malformed' | 'oversized' }

/**
 * Synchronous core: append a server-authored message to a client session.
 * MUST be called inside a `db.transaction(() => …)` wrapper that the caller
 * controls. Used directly by `appendServerAuthoredMessage` (single-turn
 * write) and by `appendServerAuthoredMessageForRequest` (which atomically
 * combines this write with `pending_usage_patches` drain + request-map
 * insert in one transaction).
 *
 * Why a sync core instead of nested `db.transaction()` calls: better-sqlite3
 * doesn't support passing a transaction handle into other functions; nesting
 * `db.transaction(...)` calls just opens a savepoint, which is fine for
 * correctness but harder to reason about. The cleanest factoring is one
 * top-level transaction in each public API and a private sync core they
 * share.
 *
 * Result triage (single SELECT, three terminal states):
 *   - row absent           → 'session_not_found' (frontend's debounced PUT
 *                            may still be in flight; durable wrapper queues
 *                            this to the outbox so a later replay can land
 *                            it after the row materialises)
 *   - row.deleted_at != null → 'session_deleted' (terminal; user/admin soft-
 *                              deleted the session, retrying will never make
 *                              it writeable again)
 *   - row present, not deleted → proceed with messages/_seq write
 */
function _appendServerAuthoredCore(
  db: Database.Database,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
): ServerAuthoredAppendResult {
  // Single SELECT without `deleted_at IS NULL` filter so we can disambiguate
  // "row never existed" from "row exists but soft-deleted" — the two states
  // map to different HTTP statuses (404 vs 410) and different sink retry
  // semantics (retry-under-TTL vs fatal-drop). Conflating them caused
  // 24h-TTL retry storms on soft-deleted sessions.
  const row = db.prepare(
    'SELECT messages, next_seq, deleted_at FROM client_sessions WHERE id = ? AND user_id = ?'
  ).get(sessId, userId) as { messages: string; next_seq: number | null; deleted_at: number | null } | undefined
  if (!row) return { applied: false, reason: 'session_not_found' }
  if (row.deleted_at !== null) return { applied: false, reason: 'session_deleted' }

  let msgs: MessageLike[]
  try {
    const parsed = JSON.parse(row.messages)
    if (!Array.isArray(parsed)) return { applied: false, reason: 'malformed' }
    msgs = parsed as MessageLike[]
  } catch {
    return { applied: false, reason: 'malformed' }
  }

  const result = appendServerAuthoredPure(msgs, message)
  if (!result.applied) return { applied: false, reason: result.reason }

  // Phantom-dedupe symmetric with the client-PUT path (upsertClientSession
  // line 1093). Without this, server-authored tool/assistant/thinking rows
  // arriving at turn-end coexist with their client-authored streaming
  // counterparts (matching blockId / turn group, but different ids — server
  // uses `srv-${sessId}-t${turnIndex}-tool-${blockId}` while client uses
  // `m-${ts}-${rand}`). The cleanup would only happen on the NEXT client
  // PUT — meaning an F5 in the gap between server-authored append and
  // next PUT shows duplicate tool cards (one stripped legacy + one rich).
  //
  // Calling `mergePreservingServerAuthored(arr, arr)` reuses the same
  // dedupe logic as the PUT path. After `appendServerAuthoredPure` stamped
  // `_source: 'server'`, the server-authored set in the merge is non-empty,
  // so dedupe runs (early-return on size===0 is unreachable here).
  // Same-array passing is safe: every id is in clientIds, so the loop at
  // line 779 adds no duplicates; the merged array equals result.messages
  // pre-phantom-dedupe, then the phantom-dedupe pass at lines 814-890
  // drops orphan client rows.
  const dedupedMessages = mergePreservingServerAuthored(
    result.messages,
    result.messages,
  ) as MessageLike[]

  // Run the resulting messages through normalizeAndAssignSeqs so the new
  // server-authored entry receives a fresh `_seq` AND any legacy rows on
  // this row get backfilled in the same transaction. Without this, a
  // legacy session (next_seq=1, messages without _seq) would silently get
  // _seq=1 assigned only to the new message — colliding with the eventual
  // _seq=1 a later upsert would assign during legacy backfill.
  // Note: phantom-dedupe may drop rows that had `_seq` assigned previously;
  // the dropped seqs simply disappear. _seq invariants only require
  // uniqueness and monotonic allocation among RETAINED messages.
  const currentNextSeq = typeof row.next_seq === 'number' && row.next_seq > 0 ? row.next_seq : 1
  const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(msgs, dedupedMessages, currentNextSeq)

  // Size guard — see MAX_SESSION_BYTES. Without this, a session that has
  // already grown past the budget (e.g. via legacy oversized rows that
  // pre-date this guard) would let the sink keep appending forever. We
  // reject before the UPDATE so the row never gets larger; the caller's
  // durable wrapper / replay treats `'oversized'` as terminal so the
  // outbox doesn't loop forever on the same row.
  const finalJson = JSON.stringify(finalMessages)
  if (Buffer.byteLength(finalJson, 'utf8') > MAX_SESSION_BYTES) {
    return { applied: false, reason: 'oversized' }
  }

  const now = Date.now()
  // Belt-and-braces: the SELECT above already gated on `deleted_at !== null`
  // inside the same BEGIN IMMEDIATE transaction, so a concurrent soft-delete
  // can't race in. Keeping `deleted_at IS NULL` on the UPDATE is a storage
  // invariant guard against future call-path changes (e.g. a refactor that
  // moves the SELECT/UPDATE into separate transactions). If it fails the
  // SELECT/UPDATE invariant, `changes` will be 0 and we surface session_deleted
  // instead of silently writing into a tombstone.
  const update = db.prepare(
    'UPDATE client_sessions SET messages = ?, message_count = ?, last_at = ?, updated_at = ?, next_seq = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).run(finalJson, finalMessages.length, now, now, nextSeq, sessId, userId)
  if (update.changes !== 1) {
    // Race: row was deleted between SELECT and UPDATE within the same txn.
    // Should be unreachable under BEGIN IMMEDIATE, but if SQLite's transaction
    // mode ever changes, we'd rather surface the terminal state than silently
    // resurrect a tombstone.
    return { applied: false, reason: 'session_deleted' }
  }
  return { applied: true }
}

export async function appendServerAuthoredMessage(
  sessId: string,
  userId: string,
  message: {
    id: string
    /** 'thinking' added to support v3 server-authored thinking persistence
     *  (mobile-stream durability for Sonnet 4.6 adaptive thinking). Same
     *  storage path as 'assistant'; phantom-dedupe applies independently
     *  to each role inside `mergePreservingServerAuthored`. */
    role: 'assistant' | 'user' | 'system' | 'thinking' | 'tool'
    text?: string
    ts?: number
    [k: string]: unknown
  },
): Promise<{ applied: boolean; reason?: 'session_not_found' | 'session_deleted' | 'already_exists' | 'malformed' | 'oversized' }> {
  const db = await getSessionsDb()
  const txn = db.transaction((): ServerAuthoredAppendResult => {
    return _appendServerAuthoredCore(db, sessId, userId, message as MessageLike & { id: string })
  })
  const r = txn()
  return r.applied ? { applied: true } : { applied: false, reason: r.reason }
}

// ── Usage aggregation: requestId-keyed APIs (Codex R3+R4 design) ──
//
// `appendServerAuthoredMessageForRequest` is the single-writer entry point
// for assistant messages that carry (or will carry) a `usage` field. It
// atomically:
//   1. Drains a pending costCredits patch keyed by (requestId, userId), if
//      any. The drained costCredits is merged into msg.usage before write.
//   2. Calls `_appendServerAuthoredCore` to perform the actual messages
//      blob update + `_seq` allocation.
//   3. Inserts a row into `server_authored_request_map` so a late-arriving
//      `appendCostCredits(requestId, userId, …)` can locate this exact
//      message and patch its usage in-place.
//   4. Deletes the drained pending row to keep the table small.
//
// `appendCostCredits` is the single-writer for cost-only patches. It:
//   1. Looks up `server_authored_request_map` by (requestId, userId).
//   2a. If hit: in-place patch `messages[i].usage.costCredits` (idempotent —
//       same value returns 'noop' so commit retries don't bump _seq).
//   2b. If miss: park the costCredits in `pending_usage_patches` keyed by
//       (requestId, userId), to be drained by a future
//       `appendServerAuthoredMessageForRequest`.
//
// The composite primary key (request_id, user_id) is the cross-user
// defense: a forged or re-routed requestId from user X cannot pollute user
// Y's pending state nor block Y's eventual map insert. Codex R4 audit fixed
// the original single-PK design which had this leak.
//
// All failures throw — callers (anthropicProxy / userChatBridge) are
// expected to log + metric and continue (broadcast still fires; pending
// alarm catches stragglers).

export type AppendForRequestResult =
  | { applied: true }
  | { applied: false; reason: 'session_not_found' | 'session_deleted' | 'already_exists' | 'malformed' | 'oversized' }

/**
 * Append a server-authored message that may need a costCredits patch
 * applied. Coordinates with `appendCostCredits` via two SQLite tables.
 *
 * Idempotency: same (requestId, userId, sessId, msgId) replayed → message
 * write returns `already_exists`; map insert is `ON CONFLICT DO NOTHING`;
 * pending drain is a no-op. Caller-visible result is identical for first
 * and subsequent calls (with `applied: false, reason: 'already_exists'`).
 */
export async function appendServerAuthoredMessageForRequest(
  requestId: string,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<AppendForRequestResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): AppendForRequestResult => {
    // 1. Drain pending costCredits if commit arrived first.
    const pending = db.prepare(
      'SELECT cost_credits FROM pending_usage_patches WHERE request_id = ? AND user_id = ?'
    ).get(requestId, userId) as { cost_credits: string } | undefined

    let msgToWrite: MessageLike & { id: string } = message
    if (pending) {
      const existingUsage = (message.usage && typeof message.usage === 'object')
        ? message.usage as Record<string, unknown>
        : {}
      msgToWrite = {
        ...message,
        usage: { ...existingUsage, costCredits: pending.cost_credits },
      }
    }

    // 2. Append message via shared core.
    const r = _appendServerAuthoredCore(db, sessId, userId, msgToWrite)
    if (!r.applied) {
      // session_deleted / oversized are both terminal: no future retry will
      // ever drain this pending row, so it would sit until the 24h aging
      // sweep and add observable noise (pending-pending_age dashboards,
      // alerting). Clear it here. session_not_found is intentionally NOT
      // cleared — the frontend's debounced PUT may still land, after which
      // a retry of this request will succeed and need the pending value.
      if (pending && (r.reason === 'session_deleted' || r.reason === 'oversized')) {
        db.prepare(
          'DELETE FROM pending_usage_patches WHERE request_id = ? AND user_id = ?'
        ).run(requestId, userId)
      }
      return r
    }

    // 3. Record (requestId, userId) → (sessionId, msgId). Composite PK
    //    means a late commit from another user with the same requestId
    //    inserts a separate row instead of being silently dropped.
    db.prepare(
      `INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (request_id, user_id) DO NOTHING`
    ).run(requestId, userId, sessId, message.id)

    // 4. Pending row drained — clear it.
    if (pending) {
      db.prepare(
        'DELETE FROM pending_usage_patches WHERE request_id = ? AND user_id = ?'
      ).run(requestId, userId)
    }

    return { applied: true }
  })
  return txn()
}

/**
 * ccb-spawn 路径(无 per-turn requestId)的 server-authored 助手消息持久化 + **按 user 排空**
 * pending costCredits。
 *
 * 背景:anthropicProxy 给 claude/glm 异步算费 → `appendCostCredits` 因 ccb 不回流 requestId
 * 而恒 park 到 `pending_usage_patches`(keyed by (request_id, user_id)),而 ccb 助手持久化走
 * 不带 requestId 的 plain 路径 → `server_authored_request_map` 恒空 → pending 永不 drain →
 * `messages[i].usage.costCredits` 永远写不进去(跨设备 reload 看不到 per-response 积分)。
 *
 * 本函数在助手消息落库时,把该 user 当前 park 的 cost **全量合并**进本条消息的
 * usage.costCredits(写库前合入,随消息一次 `_seq` 分配,getSession 增量/全量都可见)。
 * 仅删本次读到的 request_id 行(非 blanket DELETE),避免并发新 park 的 cost 被误删。
 *
 * 局限:按 user 排空——同一 user 并发多 turn 可能跨轮归并(canary 单会话顺序使用无此问题;
 * 真正 per-turn 精确需 ccb 端回流 requestId 走 {@link appendServerAuthoredMessageForRequest},
 * 属已知技术债)。requestId 路径(codex/anthropicProxy-with-requestId)不走本函数、行为不变。
 */
export async function appendServerAuthoredMessageDrainByUser<T extends MessageLike & { id: string }>(
  sessId: string,
  userId: string,
  message: T,
  // agent session id(ccb getSessionId,proxy 存进 pending.session_id)。给定 → 仅排空该
  // session 的 pending(per-turn 精确:串行 turn 下一个 session 的累积 pending 即本轮成本,
  // 消除同 user 跨会话归并)。缺省 → 退回按 user 排空(兜底:老 proxy / 缺 session)。
  agentSessionId?: string | null,
): Promise<AppendForRequestResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): AppendForRequestResult => {
    const pendings = (agentSessionId
      ? db.prepare(
          'SELECT request_id, cost_credits FROM pending_usage_patches WHERE user_id = ? AND session_id = ?'
        ).all(userId, agentSessionId)
      : db.prepare(
          'SELECT request_id, cost_credits FROM pending_usage_patches WHERE user_id = ?'
        ).all(userId)) as { request_id: string; cost_credits: string }[]
    let sum = 0n
    for (const p of pendings) {
      try { const v = BigInt(p.cost_credits); if (v > 0n) sum += v } catch { /* skip malformed */ }
    }

    let msgToWrite: MessageLike & { id: string } = message
    if (sum > 0n) {
      const existingUsage = (message.usage && typeof message.usage === 'object')
        ? message.usage as Record<string, unknown>
        : {}
      let base = 0n
      try { base = BigInt((existingUsage.costCredits as string) ?? '0') } catch { base = 0n }
      msgToWrite = { ...message, usage: { ...existingUsage, costCredits: (base + sum).toString() } }
    }

    const r = _appendServerAuthoredCore(db, sessId, userId, msgToWrite)
    if (!r.applied) return r

    // 只删本次读到的行——并发新 park(本次 SELECT 之后到达)不在列表里,留给下一轮 drain。
    if (pendings.length) {
      const del = db.prepare('DELETE FROM pending_usage_patches WHERE user_id = ? AND request_id = ?')
      for (const p of pendings) del.run(userId, p.request_id)
    }
    return { applied: true }
  })
  return txn()
}

export type AppendCostCreditsResult =
  | { applied: 'patched' }
  | { applied: 'pending' }
  | { applied: 'noop' }

/**
 * Apply a costCredits value to the assistant message keyed by (requestId,
 * userId). Behaviour:
 *   - If the request_map already has the message: patch
 *     `messages[i].usage.costCredits` in-place AND bump `_seq` so client
 *     incremental GET observes the change. **Idempotent**: if the existing
 *     value equals the new value, returns `'noop'` and does NOT bump
 *     `_seq`. This protects retries from inflating the per-session seq
 *     space and triggering spurious tail reloads.
 *   - If the message hasn't been written yet (sink POST in flight, or
 *     race): UPSERT a row in `pending_usage_patches`. The next call to
 *     `appendServerAuthoredMessageForRequest(requestId, ...)` will drain
 *     it.
 *   - All keyed by composite (requestId, userId) — see Codex R4.
 *
 * Returns `'noop'` on idempotent retry so callers can observe the
 * different paths in metrics if useful.
 */
export async function appendCostCredits(
  requestId: string,
  userId: string,
  costCredits: string,
  // agent session id(ccb getSessionId,proxy 从 LLM metadata.session_id 提取)。park 时一并
  // 记入 pending.session_id,供 ccb 助手落库时按 session 精确 drain(消除 by-user 跨会话归并)。
  // 缺省 → 存 NULL,退回 by-user 兜底(老 proxy / 拿不到 session 的路径)。
  sessionId?: string | null,
): Promise<AppendCostCreditsResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): AppendCostCreditsResult => {
    const mapRow = db.prepare(
      'SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = ? AND user_id = ?'
    ).get(requestId, userId) as { session_id: string; msg_id: string } | undefined

    if (mapRow) {
      const sess = db.prepare(
        'SELECT messages, next_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
      ).get(mapRow.session_id, userId) as { messages: string; next_seq: number | null } | undefined
      if (sess) {
        let msgs: MessageLike[]
        try {
          const parsed = JSON.parse(sess.messages)
          if (!Array.isArray(parsed)) {
            // Malformed sessions blob — fall through to pending so the
            // value isn't lost; admin can fix the blob and the next sink
            // POST will drain.
            msgs = []
          } else {
            msgs = parsed as MessageLike[]
          }
        } catch {
          msgs = []
        }
        const idx = msgs.findIndex(
          (m) => m && m.id === mapRow.msg_id && m._source === 'server',
        )
        if (idx >= 0) {
          const existing = msgs[idx] as MessageLike & { usage?: Record<string, unknown> }
          const prevCost = existing.usage?.costCredits
          if (typeof prevCost === 'string' && prevCost === costCredits) {
            // Idempotent retry — no-op, do NOT bump _seq.
            return { applied: 'noop' }
          }
          const currentNextSeq = typeof sess.next_seq === 'number' && sess.next_seq > 0
            ? sess.next_seq
            : 1
          const patched: MessageLike = {
            ...existing,
            _seq: currentNextSeq,
            usage: { ...(existing.usage ?? {}), costCredits },
          }
          const next: MessageLike[] = [...msgs]
          next[idx] = patched
          // Size guard — same MAX_SESSION_BYTES rule as upsert / append paths.
          // costCredits patch is small (16 chars typical) so this almost
          // never fires in practice, but a row that's already past the cap
          // would still grow by the `_seq` bump and a new key in `usage`.
          // Refusing the in-place UPDATE means the cost value is "lost" for
          // this row, but the alternative — letting an already-oversized row
          // grow further — is worse: it perpetuates the same JSON.parse
          // stall this fix targets. We do NOT fall through to pending in
          // this branch because the map row already pinpointed this
          // session+message; pending is a "haven't found target yet"
          // mechanism, not a "target full" one. Drop with a noop result
          // and rely on observability (no metric here yet — the caller
          // logs the unexpected outcome).
          const nextJson = JSON.stringify(next)
          if (Buffer.byteLength(nextJson, 'utf8') > MAX_SESSION_BYTES) {
            return { applied: 'noop' }
          }
          const nowMs = Date.now()
          db.prepare(
            'UPDATE client_sessions SET messages = ?, last_at = ?, updated_at = ?, next_seq = next_seq + 1 WHERE id = ? AND user_id = ?'
          ).run(
            nextJson,
            nowMs,
            nowMs,
            mapRow.session_id,
            userId,
          )
          return { applied: 'patched' }
        }
        // map says the message exists but we can't find it — likely
        // deleted/edited out-of-band. Fall through to pending so a
        // potential resurrected row can still pick up the cost.
      }
    }

    db.prepare(
      `INSERT INTO pending_usage_patches (request_id, user_id, session_id, cost_credits)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (request_id, user_id) DO UPDATE SET
         cost_credits = excluded.cost_credits,
         session_id = excluded.session_id,
         created_at = (CAST(strftime('%s','now') AS INTEGER)*1000)`
    ).run(requestId, userId, sessionId ?? null, costCredits)
    return { applied: 'pending' }
  })
  return txn()
}

// ── Pending / map GC sweeps (Codex R3 windowing) ──
//
// `pending_usage_patches`: 1h triggers metric `pending_usage_patches_aging`
// (alert), 24h triggers hard delete + metric `pending_usage_patches_expired`.
// 24h gives plenty of room for legitimate slow recovery (gateway/master
// restart + outbox replay) without permanently leaking rows.
//
// `server_authored_request_map`: 7d hard delete. The map only exists to
// give a late `appendCostCredits` a target; after a week the assistant
// message is settled.
//
// `sweepUsageAggregationGc()` is called by cron / periodic timer; pure
// helper so tests can pass `now` and assert deterministically.

export interface UsageAggregationGcStats {
  pendingAging: number
  pendingExpired: number
  mapExpired: number
}

const PENDING_AGING_MS = 60 * 60_000           // 1h alarm
const PENDING_HARD_DELETE_MS = 24 * 60 * 60_000  // 24h GC
const MAP_HARD_DELETE_MS = 7 * 24 * 60 * 60_000  // 7d GC

export async function sweepUsageAggregationGc(
  now: number = Date.now(),
): Promise<UsageAggregationGcStats> {
  const db = await getSessionsDb()
  const txn = db.transaction((): UsageAggregationGcStats => {
    const agingThreshold = now - PENDING_AGING_MS
    const expiredThreshold = now - PENDING_HARD_DELETE_MS
    const mapThreshold = now - MAP_HARD_DELETE_MS

    // Count rows aged 1h ≤ row < 24h (haven't been hard-deleted yet).
    const aging = db.prepare(
      `SELECT COUNT(*) AS n FROM pending_usage_patches
       WHERE created_at <= ? AND created_at > ?`
    ).get(agingThreshold, expiredThreshold) as { n: number }

    // Hard-delete rows older than 24h.
    const delPending = db.prepare(
      'DELETE FROM pending_usage_patches WHERE created_at <= ?'
    ).run(expiredThreshold)

    const delMap = db.prepare(
      'DELETE FROM server_authored_request_map WHERE written_at <= ?'
    ).run(mapThreshold)

    return {
      pendingAging: aging.n,
      pendingExpired: delPending.changes,
      mapExpired: delMap.changes,
    }
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
    role: 'assistant' | 'user' | 'system' | 'thinking' | 'tool'
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
 *   { applied: false, reason: 'session_deleted' }          — terminal: row
 *     was soft-deleted; not queued because outbox replay would just hit the
 *     same terminal state on every startup
 *   { applied: false, reason: 'already_exists' }           — idempotent skip
 *   { applied: false, reason: 'malformed' }                — bad row data
 *   { applied: false, reason: 'oversized' }                — terminal: the
 *     post-write blob would exceed MAX_SESSION_BYTES. Same drop-don't-queue
 *     reasoning as session_deleted: replay will hit the same cap forever
 *     until the row is downsized by the A.3 admin script.
 *   { applied: false, reason: 'queued_to_outbox', error } — either the row
 *     doesn't exist yet (first-turn PUT race; outbox replay will succeed
 *     once the client PUT lands) OR the DB write itself threw (disk full,
 *     BUSY, corrupt — replayed on startup).
 */
export async function appendServerAuthoredMessageDurable(
  sessId: string,
  userId: string,
  message: {
    id: string
    role: 'assistant' | 'user' | 'system' | 'thinking' | 'tool'
    text?: string
    ts?: number
    [k: string]: unknown
  },
): Promise<
  | { applied: true }
  | { applied: false; reason: 'already_exists' | 'malformed' | 'session_deleted' | 'oversized' }
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
    // session_deleted is a terminal state: the row exists and the user/admin
    // has soft-deleted it. Outbox replay would just hit the same terminal
    // state on every startup, so we drop here instead of queueing. (The
    // upstream caller — durable sink / userChatBridge — logs this at info.)
    if (r.reason === 'session_deleted') {
      return { applied: false, reason: 'session_deleted' }
    }
    // oversized is also terminal: the row already exceeds MAX_SESSION_BYTES
    // and any further append would push it further past the cap. Replay
    // would re-hit the cap on every startup. Drop here; admin must run the
    // A.3 strip-attachments script to bring the row back under budget.
    if (r.reason === 'oversized') {
      return { applied: false, reason: 'oversized' }
    }
    // Upstream's signature types `reason` as optional, but every applied:false
    // branch above sets one of {'session_not_found','session_deleted',
    // 'already_exists','malformed','oversized'}. We've handled the three
    // terminal-with-special-handling reasons explicitly; the rest
    // ('already_exists' | 'malformed') fall through here. Default to
    // 'malformed' if reason is somehow missing (unreachable in practice).
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
 *      session row STILL doesn't exist (the original first-turn PUT race
 *      never resolved); `session_deleted` — row exists but was soft-deleted
 *      while queued, terminal; `already_exists` — duplicate from a prior
 *      partial replay; `oversized` — row past MAX_SESSION_BYTES, replay
 *      can't shrink it) are dropped.
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
      } else if (
        r.reason === 'already_exists' ||
        r.reason === 'session_not_found' ||
        r.reason === 'session_deleted' ||
        r.reason === 'malformed' ||
        r.reason === 'oversized'
      ) {
        // session_deleted is a terminal state same as session_not_found
        // post-replay (the row exists but is soft-deleted, so retrying
        // forever is pointless — drop and move on). 'oversized' is
        // similarly terminal: blob already past MAX_SESSION_BYTES, replay
        // can never make it smaller — drop and rely on A.3 admin strip
        // to bring the row back under budget.
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

/**
 * Metadata-only rename (PATCH /api/sessions/:id title 专用)。
 *
 * 为什么不用 upsertClientSession:那是"整会话 blob 替换 + server-authored merge"语义,
 * 元数据更新骑在它上面要么被乐观并发 409(不带 _baseSyncedAt),要么把客户端未随带的
 * messages merge 掉。title 改名是纯元数据写,单列 UPDATE 收口,不触碰 messages/next_seq。
 * updated_at 照常推进(它同时是 PUT 乐观并发 token;v5 React 客户端消息走 WS 不走全量
 * PUT,推进无副作用,还能让其它设备的 listSessions server-wins 拿到新标题)。
 */
export async function renameClientSession(id: string, userId: string, title: string): Promise<{ ok: boolean; updatedAt: number }> {
  const db = await getSessionsDb()
  const now = Date.now()
  const result = db.prepare(
    'UPDATE client_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).run(title, now, id, userId)
  return { ok: result.changes > 0, updatedAt: now }
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

/**
 * List all live broker-owned wechat sessions:
 *   - `id GLOB 'wsess-[0-9a-f]{16}'`  (Codex R5: precise 16-hex shape)
 *   - `origin_channel = 'wechat'`     (slice 7a: explicit channel tag)
 *   - `deleted_at IS NULL`            (alive)
 *
 * Returned `{id, userId, createdAt}` (createdAt = epoch ms). Consumer
 * (commercial v3 broker.reconcile) takes a single snapshot per tick and diffs
 * against PG `wechat_session_pointer.current_session_id` to find orphan rows;
 * `userId` is required to call `softDeleteMasterSession(sessionId, userId)`
 * with tenancy scoping.
 *
 * **Why precise 16-hex GLOB** (Codex R5 BLOCKER): bare `wsess-*` would also
 * match `wsess-manual`, `wsess-x`, etc. — but the broker-owned namespace is
 * exactly `^wsess-[0-9a-f]{16}$`. The literal prefix still lets SQLite walk
 * the PK index range; the 16 char-class brackets enforce shape.
 *
 * **Why also filter origin_channel='wechat'** (slice 7a + Codex 7a PASS): the
 * GLOB is namespace-correct, but `origin_channel` makes the dispatcher contract
 * real, keeps storage aligned with design.md §3, and avoids dead params.
 */
export async function allMasterWsessRows(): Promise<Array<{
  id: string
  userId: string
  createdAt: number
}>> {
  const db = await getSessionsDb()
  const rows = db.prepare(`
    SELECT id, user_id AS userId, created_at AS createdAt
    FROM client_sessions
    WHERE id GLOB 'wsess-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      AND origin_channel = 'wechat'
      AND deleted_at IS NULL
  `).all() as Array<{ id: string; userId: string; createdAt: number }>
  return rows
}

/**
 * Broker-only insert for a fresh master client_sessions row owned by a
 * non-webchat channel (currently wechat). Used by the dispatcher's Step 2
 * (after Step 1 wrote `wechat_session_pointer` in PG, before Step 3 forwards
 * into the container).
 *
 * **Plain INSERT by design; duplicate id must throw for dispatcher
 * compensation.** (Codex 7a PASS) — for this path collision is exceptional
 * (16-hex namespace, fresh per dispatch). When it does happen, the dispatcher
 * needs the SQLITE_CONSTRAINT to bubble so it can produce a `step2_failed`
 * outcome and run the compensation chain (rollback the pointer row in PG).
 * Do NOT add `INSERT OR IGNORE` / `ON CONFLICT DO UPDATE` here.
 *
 * `messages` / `message_count` / `next_seq` / `deleted_at` rely on the
 * column DEFAULTs ('[]' / 0 / 1 / NULL). `pinned` is also omitted (default 0).
 * Downstream PUT path goes through `upsertClientSession` like any other row.
 */
export async function upsertMasterClientSession(input: {
  sessionId: string
  userId: string
  agentId: string
  originChannel: 'wechat'
  title: string
  createdAt: number
  lastAt: number
}): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(`
    INSERT INTO client_sessions
      (id, user_id, agent_id, title, created_at, last_at, updated_at, origin_channel)
    VALUES
      (@sessionId, @userId, @agentId, @title, @createdAt, @lastAt, @lastAt, @originChannel)
  `).run({
    sessionId: input.sessionId,
    userId: input.userId,
    agentId: input.agentId,
    title: input.title,
    createdAt: input.createdAt,
    lastAt: input.lastAt,
    originChannel: input.originChannel,
  })
}

/**
 * Broker-only soft-delete wrapper. Tenant-scoped on `(sessionId, userId)` —
 * same semantics as `deleteClientSession(id, userId)` so wechat reconcile
 * never crosses tenants when removing an orphan row.
 */
export async function softDeleteMasterSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  return deleteClientSession(sessionId, userId)
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
