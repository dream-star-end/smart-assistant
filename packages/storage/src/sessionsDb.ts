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
import { TEAM_CARD_CLIENT_DISPLAY_FIELDS, type MessageUsageDelegate } from '@openclaude/protocol/teamCards'
import Database from 'better-sqlite3'
// 引擎中立的写路径决策层(RFC D6b);与本文件构成运行时环(见 clientSessionsPlan.ts 顶注)。
import {
  planAppendServerAuthored,
  planCostPatch,
  planDelegateCostMerge,
  planSpillOverflow,
  type SpillChunkPlan,
} from './clientSessionsPlan.js'
import { paths } from './paths.js'
// wechat_bindings 是 master 六表之一,其 SQLite 实现在 wechatBindings.ts(靠近 wechat 专用
// helper),这里 import 进来组合成完整的 sqliteBackend。函数声明,循环 import 下实例化即就绪。
import {
  _sqliteDeleteWechatBinding,
  _sqliteGetWechatBindingByAccountId,
  _sqliteGetWechatBindingByUserId,
  _sqliteListActiveWechatBindings,
  _sqliteListAllWechatBindings,
  _sqliteUpdateWechatBindingCursor,
  _sqliteUpdateWechatBindingStatus,
  _sqliteUpsertWechatBinding,
} from './wechatBindings.js'

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
  // Gateway, MCP memory workers, and migration helpers can legitimately open
  // the same WAL database from separate processes.  A turn-id reservation is
  // a durability prerequisite, so an instantaneous SQLITE_BUSY must wait for
  // the current writer rather than reject a paid turn before it starts.  Keep
  // this aligned with sessionsMigrate.ts.
  db.pragma('busy_timeout = 10000')
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

    -- Success-only cadence authority for V5 Auto-Dream. sessions_meta is
    -- intentionally not reused: it is written before terminal errors are
    -- evaluated and therefore contains failed sessions too.
    CREATE TABLE IF NOT EXISTS auto_dream_success_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_dream_success_agent_seq
      ON auto_dream_success_events(agent_id, seq);

    -- Crash-safe allocator for user-visible turn ids.  FTS rows are written
    -- after a model result and therefore cannot reserve the id of an
    -- interrupted turn (or a completed turn whose async index write has not
    -- landed yet).  Reserving before execution prevents a gateway restart
    -- from reusing srv-<session>-<agent>-tN and conflicting with an immutable
    -- lossless turn tape already ACKed or waiting in the durable outbox.
    CREATE TABLE IF NOT EXISTS session_turn_counters (
      session_id TEXT PRIMARY KEY,
      last_reserved_turn INTEGER NOT NULL CHECK (last_reserved_turn >= 0)
    );

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

  // ── 长会话热尾巴 + 归档(spill/archive)──
  //
  // 单行 messages JSON 有 4MB 硬上限(MAX_SESSION_BYTES,防 2026-05-08 大行卡死
  // 事件循环)。行到顶后所有追加被静默丢弃 = "扣费但看不到回答"(2026-07-10 uid4)。
  // 解法:行体积超软阈值(SESSION_SOFT_TRIM_BYTES)时把最老的消息从行里"搬"进归档
  // chunk 表,行只留最近的热尾巴,写路径永不再拒。归档消息 _seq 冻结不变(增量协议
  // 依赖单调 _seq),用户回看走 readArchivedMessages 分页从 chunk 表拉。
  //
  //   client_session_archive_chunks — 归档 chunk(分页权威;messages 为冻结 JSON 数组)。
  //     first_seq/last_seq = chunk 内 _seq 的 min/max(chunk 之间 _seq 池 disjoint,故
  //     first_seq 唯一,可做 PK 的一半)。message_count = chunk 内消息条数。
  //   client_session_archived_ids — 已归档消息 id 集。三用途:
  //     ① PUT 防复活(客户端全量 PUT 带回已归档 id → 过滤掉,行不回涨);
  //     ② append 幂等(server-authored 重放已归档 id → already_exists);
  //     ③ cost-patch 定位(目标 msg 已归档 → noop,不再徒劳 re-pending)。
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_session_archive_chunks (
      session_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      first_seq  INTEGER NOT NULL,
      last_seq   INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      messages   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, first_seq)
    );
    CREATE TABLE IF NOT EXISTS client_session_archived_ids (
      session_id TEXT NOT NULL,
      msg_id     TEXT NOT NULL,
      PRIMARY KEY (session_id, msg_id)
    );
  `)
  // 归档水位列(存量库靠 ALTER 补;CREATE TABLE IF NOT EXISTS 对存量 client_sessions
  // no-op,不会补新列)。archived_through_seq = max(已归档 _seq),归档页游标锚点;
  // archived_count = 已归档消息累计条数(message_count = tail 数 + archived_count)。
  try {
    const cols = db.pragma('table_info(client_sessions)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'archived_through_seq')) {
      db.exec('ALTER TABLE client_sessions ADD COLUMN archived_through_seq INTEGER NOT NULL DEFAULT 0')
    }
    if (!cols.some(c => c.name === 'archived_count')) {
      db.exec('ALTER TABLE client_sessions ADD COLUMN archived_count INTEGER NOT NULL DEFAULT 0')
    }
  } catch { /* table just created with columns already */ }
  // 铁律(2026-07 sessionsdb-migration 事故):引用"后加列/新表"的 index 一律放在所有
  // ALTER TABLE 之后单独建。本 index 只引用新表 client_session_archive_chunks 的列
  // (last_seq),对存量库该表由上面 CREATE TABLE IF NOT EXISTS 现建(必带全列),
  // 天然安全;仍统一置于 ALTER 之后,守住"index 永远在 ALTER 后"的位置纪律。
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_csa_chunks_last ON client_session_archive_chunks(session_id, last_seq)',
  )

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
      -- delegate 成本归因:父**客户端**会话 id(web-*)。仅委派子会话 park 时非空
      -- (proxy 从 attribution.parentSessionId 传入,= gateway 注入的 oc_parent_session_id
      -- 解析出的父 webchat 会话)。普通 chat / codex 自费恒 NULL —— 语义诚实,与
      -- session_id(引擎会话)不复用,drain 用它按父客户端会话精确归并到队长助手行。
      parent_session_id TEXT,
      -- P2 债D — 委派子 agent id(= attribution.delegateAgentId,proxy 从 park 时透传)。
      -- 仅委派行非空;普通 chat / codex 自费恒 NULL。drain 时按它分组求和,产出队长助手行
      -- usage.delegates[] 的 per-agent 明细(纯展示投影,不参与扣费)。
      delegate_agent_id TEXT,
      turn_key TEXT,
      parent_turn_key TEXT,
      cost_credits TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000),
      PRIMARY KEY (request_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pup_created ON pending_usage_patches(created_at);
    -- by-user drain(ccb-spawn 路径 appendServerAuthoredMessageDrainByUser 的 WHERE user_id)
    -- 走索引,避免 pending 积压时全表扫。
    CREATE INDEX IF NOT EXISTS idx_pup_user ON pending_usage_patches(user_id);
  `)
  // Migration: add parent_session_id column to pending_usage_patches (existing DBs).
  // ADD COLUMN with default NULL is metadata-only + fast.
  //
  // 不变式:CREATE TABLE IF NOT EXISTS 对存量库是 no-op,**不会**补新列。任何引用
  // "后加列"的 index 必须放在对应 ALTER migration 之后单独建,不得写进上面的初始
  // DDL 块 —— 否则存量库 open 时整个 exec 抛 "no such column",getSessionsDb 每次
  // 调用都失败,所有 sessions.db 路径(list/save/server-authored 落库)全体 500
  // (2026-07-06 线上事故根因,丢 2 小时对话落库)。
  try {
    const cols = db.pragma('table_info(pending_usage_patches)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'parent_session_id')) {
      db.exec('ALTER TABLE pending_usage_patches ADD COLUMN parent_session_id TEXT')
    }
    // P2 债D — delegate_agent_id 后加列。同 parent_session_id 教训:存量库靠 ALTER 补,
    // CREATE TABLE IF NOT EXISTS 对存量库 no-op 不会补。default NULL,metadata-only。
    if (!cols.some(c => c.name === 'delegate_agent_id')) {
      db.exec('ALTER TABLE pending_usage_patches ADD COLUMN delegate_agent_id TEXT')
    }
    if (!cols.some(c => c.name === 'turn_key')) {
      db.exec('ALTER TABLE pending_usage_patches ADD COLUMN turn_key TEXT')
    }
    if (!cols.some(c => c.name === 'parent_turn_key')) {
      db.exec('ALTER TABLE pending_usage_patches ADD COLUMN parent_turn_key TEXT')
    }
  } catch { /* table just created with column already */ }
  // delegate drain(drainDelegateCostForClientSession 的 WHERE user_id AND parent_session_id)
  // 走部分索引(只覆盖委派行,普通/自费行 parent_session_id 为 NULL 不入索引)。
  // 放在 migration 之后:新库/存量库两条路径在此汇合,统一建索引。
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pup_parent
       ON pending_usage_patches(user_id, parent_session_id)
       WHERE parent_session_id IS NOT NULL`,
  )
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pup_user_turn_key
      ON pending_usage_patches(user_id, turn_key) WHERE turn_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pup_user_parent_turn_key
      ON pending_usage_patches(user_id, parent_turn_key) WHERE parent_turn_key IS NOT NULL;
  `)

  // 旧重量级团队模式(team_runs / team_delegations)已整套删除:schema 不再声明,
  // 存量本地 DB 里已建的表留着无害(不写 DROP TABLE,不迁移)。
  _db = db
  return db
}

/**
 * 健康探活:sessions.db 可开且可查。供 /healthz 深度探活 —— 2026-07-06 事故教训:
 * getSessionsDb open 抛(存量库 schema 事故)时 list/save/server-authored 落库全体
 * 500,而进程级 healthz 依然绿、监控两小时无告警。健康的定义收口在 storage 自己,
 * healthz/监控只消费结果。
 *
 * 成功路径开销 ≈ 缓存连接上一条 SELECT 1(getSessionsDb 成功后缓存 _db),高频
 * 探测无压力;失败路径每次重试 open,与业务 API 的失败行为一致(持续暴露 bad,
 * 修复后自动转好)。从不 throw。
 */
async function _sqliteProbeSessionsDb(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const db = await getSessionsDb()
    db.prepare('SELECT 1').get()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) }
  }
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

export interface AutoDreamSuccessfulSession {
  seq: number
  id: string
  agentId: string
  channel: string
  completedAt: number
}

/** Persisted only from the signed, proven-success gateway terminal hook. */
export async function recordAutoDreamSuccessfulSession(input: {
  agentId: string
  sessionId: string
  channel: string
  completedAt: number
}): Promise<number> {
  const db = await getSessionsDb()
  const result = db.prepare(`
    INSERT INTO auto_dream_success_events (agent_id, session_id, channel, completed_at)
    VALUES (@agentId, @sessionId, @channel, @completedAt)
  `).run(input)
  return Number(result.lastInsertRowid)
}

/**
 * Capture a monotonic upper sequence, then return the first occurrence of
 * each distinct successful session inside that closed sequence interval.
 * Inserts racing after the capture have a larger seq and remain for next run.
 */
export async function scanAutoDreamSuccessfulSessions(opts: {
  agentId: string
  channels: readonly string[]
  afterSeq?: number
  limit?: number
}): Promise<{ sessions: AutoDreamSuccessfulSession[]; throughSeq: number }> {
  const channels = [...new Set(opts.channels.filter(Boolean))]
  if (channels.length === 0) return { sessions: [], throughSeq: Math.max(0, opts.afterSeq ?? 0) }
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 32)))
  const afterSeq = Math.max(0, Math.floor(opts.afterSeq ?? 0))
  const db = await getSessionsDb()
  const placeholders = channels.map(() => '?').join(',')
  const upperRow = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS seq
       FROM auto_dream_success_events
      WHERE agent_id = ?
        AND channel IN (${placeholders})`,
  ).get(opts.agentId, ...channels) as { seq: number }
  const throughSeq = Math.max(afterSeq, Number(upperRow.seq) || 0)
  if (throughSeq <= afterSeq) return { sessions: [], throughSeq }
  const rows = db.prepare(
    `WITH first_events AS (
       SELECT session_id, MIN(seq) AS seq
         FROM auto_dream_success_events
        WHERE agent_id = ?
          AND channel IN (${placeholders})
          AND seq > ?
          AND seq <= ?
        GROUP BY session_id
     )
     SELECT e.seq, e.session_id, e.agent_id, e.channel, e.completed_at
       FROM first_events f
       JOIN auto_dream_success_events e ON e.seq = f.seq
      ORDER BY e.seq ASC
      LIMIT ?`,
  ).all(
    opts.agentId,
    ...channels,
    afterSeq,
    throughSeq,
    limit,
  ) as Array<{
    seq: number
    session_id: string
    agent_id: string
    channel: string
    completed_at: number
  }>
  return {
    sessions: rows.map((row) => ({
      seq: row.seq,
      id: row.session_id,
      agentId: row.agent_id,
      channel: row.channel,
      completedAt: row.completed_at,
    })),
    throughSeq,
  }
}

/** Best-effort compaction after the durable state watermark has advanced. */
export async function pruneAutoDreamSuccessEvents(
  agentId: string,
  throughSeq: number,
): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(
    `DELETE FROM auto_dream_success_events WHERE agent_id = ? AND seq <= ?`,
  ).run(agentId, Math.max(0, Math.floor(throughSeq)))
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

/**
 * Atomically reserve the next never-reused turn index for one logical runner
 * session.  The allocation is committed to the container's persistent SQLite
 * volume before the model is allowed to run.
 *
 * `minimumLastTurn` covers in-memory completions whose asynchronous FTS write
 * is still pending. `legacySessionIds` seeds the allocator from historical FTS
 * identities used before sessionKey became the canonical index key.
 * Gaps are intentional: once reserved, an index is never returned to the pool,
 * even when a turn fails before producing output.
 */
export async function reserveTurnIndex(
  sessionId: string,
  opts: { minimumLastTurn?: number; legacySessionIds?: string[] } = {},
): Promise<number> {
  const db = await getSessionsDb()
  const ids = [...new Set([
    sessionId,
    ...(opts.legacySessionIds ?? []).filter((id) => id.length > 0),
  ])]
  const reserve = db.transaction((): number => {
    const placeholders = ids.map(() => '?').join(',')
    const counter = db
      .prepare(
        `SELECT MAX(last_reserved_turn) AS m
           FROM session_turn_counters
          WHERE session_id IN (${placeholders})`,
      )
      .get(...ids) as { m: number | null } | undefined
    const fts = db
      .prepare(
        `SELECT MAX(CAST(turn_idx AS INTEGER)) AS m
           FROM sessions_fts
          WHERE session_id IN (${placeholders})`,
      )
      .get(...ids) as { m: number | null } | undefined
    const meta = db
      .prepare(
        `SELECT MAX(turn_count) AS m
           FROM sessions_meta
          WHERE id IN (${placeholders})`,
      )
      .get(...ids) as { m: number | null } | undefined
    const minimum = Number.isSafeInteger(opts.minimumLastTurn) && (opts.minimumLastTurn ?? 0) > 0
      ? opts.minimumLastTurn!
      : 0
    const last = Math.max(
      minimum,
      counter?.m == null ? 0 : Math.floor(counter.m),
      fts?.m == null ? 0 : Math.floor(fts.m),
      meta?.m == null ? 0 : Math.floor(meta.m),
    )
    const next = last + 1
    db.prepare(
      `INSERT INTO session_turn_counters(session_id,last_reserved_turn)
       VALUES (?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_reserved_turn=MAX(session_turn_counters.last_reserved_turn,excluded.last_reserved_turn)`,
    ).run(sessionId, next)
    return next
  })
  // Acquire the WAL write reservation before the seed reads.  A deferred
  // read-then-write transaction can lose the upgrade race to another process
  // and SQLite correctly returns BUSY_SNAPSHOT without invoking busy_timeout.
  // IMMEDIATE serializes allocators at the start, so the retry wait applies
  // and two gateways can never derive the same `next` value.
  return reserve.immediate()
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
  // 归档水位(热尾巴 + 归档)。读侧透传给客户端:archivedCount 用于"还有 N 条"计数与
  // "从云端加载更早历史"按钮是否出现;archivedThroughSeq 是客户端 mergeFullServerWins
  // 判定"本地 _seq ≤ 水位的行是已归档 server 行,无条件保留"的边界。旧行/无归档 → 0。
  archivedCount?: number
  archivedThroughSeq?: number
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

export interface ClientSessionLifecycleRef {
  sessionId: string
  userId: string
}

export type ClientSessionLifecycleState = 'active' | 'deleted' | 'missing'

export interface ClientSessionLifecycle extends ClientSessionLifecycleRef {
  state: ClientSessionLifecycleState
}

// ── Pure merge helpers (exported for unit testing) ──

/** Minimal shape this module relies on. Real messages carry more fields. */
export type MessageLike = {
  id?: string
  ts?: number
  _source?: string
  [k: string]: unknown
}

/** Read projection for client-session history. Exact is the durable/admin
 * surface; chat is the bounded browser presentation surface. */
export type ClientSessionReadOptions = {
  projection?: 'exact' | 'chat'
}

export type HistoryProjection =
  | { kind: 'checkpoint' }
  | {
      kind: 'bash-tail'
      toolUseId: string
      parentToolUseId?: string
      tail: string
      totalBytes: number
      truncatedHead: boolean
    }

const CHAT_BASH_TAIL_MAX_BYTES = 256 * 1024

function utf8Tail(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return { value, truncated: false }
  let start = bytes.length - maxBytes
  // A UTF-8 continuation byte cannot begin a decoded suffix. Move to the
  // next code-point boundary; at most three additional bytes are skipped.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return { value: bytes.subarray(start).toString('utf8'), truncated: true }
}

function projectionAnchorKey(message: MessageLike): string {
  if (typeof message._turnTapeId === 'string') return `tape:${message._turnTapeId}`
  if (typeof message._seq === 'number' && Number.isFinite(message._seq)) return `seq:${message._seq}`
  return `id:${String(message.id ?? '')}`
}

function projectionCheckpoint(message: MessageLike): MessageLike {
  const tapeId = typeof message._turnTapeId === 'string' ? message._turnTapeId : undefined
  const seq = typeof message._seq === 'number' && Number.isFinite(message._seq) ? message._seq : undefined
  const suffix = tapeId ?? (seq !== undefined ? `seq-${seq}` : String(message.id ?? 'legacy'))
  return {
    id: `projection-checkpoint:${suffix}`,
    role: 'runtime-event',
    text: '',
    ts: typeof message.ts === 'number' ? message.ts : 0,
    _source: 'server',
    ...(seq !== undefined ? { _seq: seq } : {}),
    ...(tapeId !== undefined ? { _turnTapeId: tapeId } : {}),
    ...(typeof message._turnTapeSha256 === 'string'
      ? { _turnTapeSha256: message._turnTapeSha256 }
      : {}),
    _turnTapeExpanded: true,
    _historyProjection: { kind: 'checkpoint' } satisfies HistoryProjection,
  }
}

/**
 * Remove exact hidden runtime frames from the browser history projection.
 * Bash tail snapshots are coalesced to one sanitized, bounded patch per tool;
 * runtime-only anchors keep one tiny checkpoint so incremental cursors advance.
 * The input is never mutated and exact callers never invoke this helper.
 */
export function projectClientSessionMessagesForChat(messages: readonly MessageLike[]): MessageLike[] {
  const visible: MessageLike[] = []
  const anchors = new Map<string, MessageLike>()
  const represented = new Set<string>()
  const tailWinner = new Map<string, { message: MessageLike; projection: Extract<HistoryProjection, { kind: 'bash-tail' }>; order: number }>()

  for (let order = 0; order < messages.length; order++) {
    const message = messages[order]!
    const key = projectionAnchorKey(message)
    anchors.set(key, message)
    if (message.role !== 'runtime-event') {
      visible.push(message)
      represented.add(key)
      continue
    }
    const raw = message._runtimeEvent
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const event = raw as Record<string, unknown>
    if (event.type !== 'system' || event.subtype !== 'bash_output_tail') continue
    const toolUseId = event.tool_use_id
    if (typeof toolUseId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(toolUseId)) continue
    const rawParentToolUseId = event.parent_tool_use_id
    if (
      rawParentToolUseId !== undefined &&
      rawParentToolUseId !== null &&
      rawParentToolUseId !== '' &&
      (typeof rawParentToolUseId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(rawParentToolUseId))
    ) continue
    const parentToolUseId = typeof rawParentToolUseId === 'string' && rawParentToolUseId.length > 0
      ? rawParentToolUseId
      : undefined
    const totalBytes = typeof event.total_bytes === 'number' && Number.isFinite(event.total_bytes)
      ? Math.max(0, event.total_bytes)
      : 0
    const tail = utf8Tail(typeof event.tail === 'string' ? event.tail : '', CHAT_BASH_TAIL_MAX_BYTES)
    const projection: Extract<HistoryProjection, { kind: 'bash-tail' }> = {
      kind: 'bash-tail',
      toolUseId,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      tail: tail.value,
      totalBytes,
      truncatedHead: event.truncated_head === true || tail.truncated,
    }
    const target = `${parentToolUseId ?? ''}\0${toolUseId}`
    const previous = tailWinner.get(target)
    // Input order is the final deterministic tie-breaker. PG orders by the
    // complete persisted chronology tuple before calling this helper.
    if (!previous || totalBytes > previous.projection.totalBytes ||
        (totalBytes === previous.projection.totalBytes && order > previous.order)) {
      tailWinner.set(target, { message, projection, order })
    }
  }

  for (const { message, projection } of tailWinner.values()) {
    const key = projectionAnchorKey(message)
    represented.add(key)
    visible.push({
      id: `projection-tail:${String(message.id ?? `${projection.parentToolUseId ?? ''}:${projection.toolUseId}`)}`,
      role: 'runtime-event',
      text: '',
      ts: typeof message.ts === 'number' ? message.ts : 0,
      _source: 'server',
      ...(typeof message._seq === 'number' && Number.isFinite(message._seq) ? { _seq: message._seq } : {}),
      ...(typeof message._turnTapeId === 'string' ? { _turnTapeId: message._turnTapeId } : {}),
      ...(typeof message._turnTapeSha256 === 'string'
        ? { _turnTapeSha256: message._turnTapeSha256 }
        : {}),
      _turnTapeExpanded: true,
      _historyProjection: projection,
    })
  }

  for (const [key, anchor] of anchors) {
    if (!represented.has(key)) visible.push(projectionCheckpoint(anchor))
  }
  return visible.sort((a, b) => {
    const seqA = typeof a._seq === 'number' ? a._seq : Number.MAX_SAFE_INTEGER
    const seqB = typeof b._seq === 'number' ? b._seq : Number.MAX_SAFE_INTEGER
    if (seqA !== seqB) return seqA - seqB
    const tsA = typeof a.ts === 'number' ? a.ts : 0
    const tsB = typeof b.ts === 'number' ? b.ts : 0
    return tsA - tsB
  })
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

// ── 长会话热尾巴 + 归档:spill 常量 ──
//
// 写路径每次 normalize 后测量序列化字节:> SOFT_TRIM 触发 spill,从数组头(最老)向后
// 搬进归档,直到剩余尾巴 ≤ TAIL_TARGET;但尾巴至少保留 TAIL_MIN_MSGS 条。
//
// 阈值关系(硬约束,勿乱调):SOFT_TRIM(2.5M) > TAIL_TARGET(2M) 且两者都 < MAX(4M)。
// - TAIL_TARGET 留出 MAX 与它之间 2M 的余量:一次 spill 后尾巴 ≤ 2M,后续 append 有足够
//   空间累积到下次 SOFT_TRIM 才再 spill,避免每 turn 都 spill(spill 有 chunk 写开销)。
// - TAIL_MIN_MSGS = 64 > 兜底上下文注入窗口(bridge 48 条 / 容器 40 条):保证模型无法
//   原生续接、走兜底注入重建上下文时,热尾巴始终 ≥ 该窗口 → spill 对模型侧零影响。
export const SESSION_SOFT_TRIM_BYTES = Math.floor(2.5 * 1024 * 1024) // 2.5MB
export const SESSION_TAIL_TARGET_BYTES = 2 * 1024 * 1024 // 2MB
export const SESSION_TAIL_MIN_MSGS = 64
// 单个归档 chunk 的上限:≤200 条且 ≤768KB。两者取先到者切分(单条 >768KB 的巨型消息
// 仍单独成 chunk,不无限循环)。chunk 小 → readArchivedMessages 分页展开的 parse 成本有界。
export const ARCHIVE_CHUNK_MAX_MSGS = 200
export const ARCHIVE_CHUNK_MAX_BYTES = 768 * 1024 // 768KB

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

// Team/delegate cards are client-owned UI structures (agent-group /
// delegate-progress) that must survive refresh. Keep these scoped to those
// roles so ordinary assistant/tool ephemeral fields still get stripped.
//
// 清单权威在 @openclaude/protocol/teamCards 的 TEAM_CARD_CLIENT_DISPLAY_FIELDS
// (与 web-react persist.ts 的 mergeLocalTeamDisplayFields 共享同一常量),这里
// 只做 Set 化。别在这里就地加字段 —— 加进共享常量,两侧才不会再漂移
// (f2272c08 教训:前端加 _agentGroupOrigin/_teamFallback 服务端没跟上)。
const CLIENT_PUT_TEAM_MESSAGE_FIELDS: ReadonlySet<string> = new Set<string>(
  TEAM_CARD_CLIENT_DISPLAY_FIELDS,
)

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
  const role = typeof src.role === 'string' ? src.role : ''
  const teamOwned = role === 'agent-group' || role === 'delegate-progress'
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    if (CLIENT_PUT_ALLOWED_FIELDS.has(k)) {
      out[k] = src[k]
    } else if (teamOwned && CLIENT_PUT_TEAM_MESSAGE_FIELDS.has(k)) {
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
export function _stripClientPutMessages(
  messages: readonly unknown[],
  serverSideMsgs: readonly MessageLike[] = [],
): MessageLike[] {
  // GET expands each immutable tape record into a normal message so existing
  // clients can render it. A client can immediately PUT that projection back.
  // Identify projections while their server-only tape markers are still
  // present; `_stripClientPutMessage` intentionally removes those markers.
  // The complete anchor in the already-stored hot tail is the authority for
  // which tape ids are safe to discard here.
  const completeTapeIds = new Set<string>()
  for (const message of serverSideMsgs) {
    if (
      message?._source === 'server' &&
      (message as { _turnTapeComplete?: unknown })._turnTapeComplete === true &&
      typeof (message as { _turnTapeId?: unknown })._turnTapeId === 'string'
    ) {
      completeTapeIds.add((message as { _turnTapeId: string })._turnTapeId)
    }
  }
  const out: MessageLike[] = []
  for (const m of messages) {
    if (m && typeof m === 'object') {
      const projected = m as {
        _turnTapeExpanded?: unknown
        _turnTapeId?: unknown
      }
      if (
        projected._turnTapeExpanded === true &&
        typeof projected._turnTapeId === 'string' &&
        completeTapeIds.has(projected._turnTapeId)
      ) {
        continue
      }
    }
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
 *   7. **Agent-group local-wins dedupe** (P2 债A, team-card server-authored):
 *      client and server both hold `role: 'agent-group'` rows for the same
 *      delegation, keyed by runId (client `m-*` row carries `_delegateRunId`;
 *      server `srv-*` row is written by `appendServerAuthoredMessage` with the
 *      same `_delegateRunId`). Unlike rules 3/6 (server-wins for assistant/
 *      thinking/tool), agent-group is **local-wins**: when a same-runId client
 *      row exists in the turn group we DROP the server row and keep the client
 *      one, because the client row owns the rich `childBlocks` subagent tree
 *      (text/thinking/tool) that the server row (summary skeleton only) lacks.
 *      The server row renders ONLY when the client row is absent (cross-device
 *      / cleared cache / client PUT never landed), filling the durability gap.
 *      This is the storage-side of the 2c73030d regression guard: a server row
 *      must never overwrite/swallow a local agent-group's childBlocks. (The
 *      id-level takeover in `appendServerAuthoredPure` is already structurally
 *      safe here — `srv-*` and `m-*` ids never collide, so no takeover fires.)
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
  const isAgentGroup = (m: T) => (m as { role?: string }).role === 'agent-group'
  /** agent-group 去重合并键(P2 债A):优先读既有 `_delegateRunId`(前端 agent-group
   *  行实际承载的 run 键),兼容顶层 `runId`。null = 无键(不参与 runId 折叠)。 */
  const agentGroupRunId = (m: T): string | null => {
    const r = m as { _delegateRunId?: unknown; runId?: unknown }
    if (typeof r._delegateRunId === 'string' && r._delegateRunId.length > 0) return r._delegateRunId
    if (typeof r.runId === 'string' && r.runId.length > 0) return r.runId
    return null
  }
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
  const groupHasCompleteTurnTape: boolean[] = []
  // Legacy server agent-group rows are summary skeletons, so an equivalent
  // rich local row wins. Lossless turn-tape rows invert that choice: their
  // out-of-line record owns the complete child transcript and must survive a
  // later client PUT. Track both sets per turn group.
  const groupClientAgentGroupRunIds: Array<Set<string>> = []
  const groupTapeServerAgentGroupRunIds: Array<Set<string>> = []
  const groupTapeStructuredRoles: Array<Set<string>> = []
  let groupId = 0
  let curGroupServerAsst = false
  let curGroupServerThinking = false
  let curGroupServerToolBlockIds = new Set<string>()
  let curGroupHasCompleteTurnTape = false
  let curGroupClientAgentGroupRunIds = new Set<string>()
  let curGroupTapeServerAgentGroupRunIds = new Set<string>()
  let curGroupTapeStructuredRoles = new Set<string>()
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]
    if (cur && isTurnBoundary(cur)) {
      // Close previous group, open a new one.
      groupHasServerAsst.push(curGroupServerAsst)
      groupHasServerThinking.push(curGroupServerThinking)
      groupServerToolBlockIds.push(curGroupServerToolBlockIds)
      groupHasCompleteTurnTape.push(curGroupHasCompleteTurnTape)
      groupClientAgentGroupRunIds.push(curGroupClientAgentGroupRunIds)
      groupTapeServerAgentGroupRunIds.push(curGroupTapeServerAgentGroupRunIds)
      groupTapeStructuredRoles.push(curGroupTapeStructuredRoles)
      groupId++
      curGroupServerAsst = false
      curGroupServerThinking = false
      curGroupServerToolBlockIds = new Set<string>()
      curGroupHasCompleteTurnTape = false
      curGroupClientAgentGroupRunIds = new Set<string>()
      curGroupTapeServerAgentGroupRunIds = new Set<string>()
      curGroupTapeStructuredRoles = new Set<string>()
    }
    turnGroup[i] = groupId
    if (cur && cur._source === 'server') {
      if ((cur as { _turnTapeComplete?: unknown })._turnTapeComplete === true) {
        curGroupHasCompleteTurnTape = true
        const roles = (cur as { _turnTapeStructuredRoles?: unknown })._turnTapeStructuredRoles
        if (Array.isArray(roles)) {
          for (const role of roles) {
            if (role === 'plan' || role === 'goal') curGroupTapeStructuredRoles.add(role)
          }
        }
      }
      if (isAssistant(cur)) curGroupServerAsst = true
      else if (isThinking(cur)) curGroupServerThinking = true
      else if (isTool(cur)) {
        const bid = (cur as { blockId?: unknown }).blockId
        if (typeof bid === 'string' && bid.length > 0) {
          curGroupServerToolBlockIds.add(bid)
        }
      } else if (isAgentGroup(cur) && typeof (cur as { _turnTapeId?: unknown })._turnTapeId === 'string') {
        const rid = agentGroupRunId(cur)
        if (rid !== null) curGroupTapeServerAgentGroupRunIds.add(rid)
      }
    } else if (cur && isAgentGroup(cur)) {
      // Non-server (client m-*) agent-group row — record its runId so the
      // matching server srv-* row is dropped in the second pass.
      const rid = agentGroupRunId(cur)
      if (rid !== null) curGroupClientAgentGroupRunIds.add(rid)
    }
  }
  groupHasServerAsst.push(curGroupServerAsst)
  groupHasServerThinking.push(curGroupServerThinking)
  groupServerToolBlockIds.push(curGroupServerToolBlockIds)
  groupHasCompleteTurnTape.push(curGroupHasCompleteTurnTape)
  groupClientAgentGroupRunIds.push(curGroupClientAgentGroupRunIds)
  groupTapeServerAgentGroupRunIds.push(curGroupTapeServerAgentGroupRunIds)
  groupTapeStructuredRoles.push(curGroupTapeStructuredRoles)

  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]
    if (!cur) { deduped.push(cur); continue }
    const g = turnGroup[i]
    // Hydrated tape records are a read projection returned to the browser.
    // Never copy that projection back into the hot JSON tail on a later PUT;
    // the complete anchor already rehydrates the same immutable records.
    if (
      (cur as { _turnTapeExpanded?: unknown })._turnTapeExpanded === true &&
      groupHasCompleteTurnTape[g]
    ) {
      continue
    }
    // A complete turn-tape anchor is an atomic authority marker for every
    // generated top-level row in this turn. Drop browser-streamed copies of
    // all roles that the tape expands, regardless of their locally-generated
    // ids/blockIds/runIds. This lets one constant-size hot anchor represent an
    // arbitrarily large number of immutable records without a PUT erasing or
    // duplicating them.
    if (
      cur._source !== 'server' &&
      groupHasCompleteTurnTape[g] &&
      (isAssistant(cur) || isThinking(cur) || isTool(cur) || isAgentGroup(cur))
    ) {
      continue
    }
    if (
      cur._source !== 'server' &&
      groupHasCompleteTurnTape[g] &&
      typeof cur.role === 'string' &&
      groupTapeStructuredRoles[g].has(cur.role)
    ) {
      continue
    }
    // A lossless tape-backed agent-group is authoritative and hydrates to the
    // complete child transcript. Drop its matching client placeholder rather
    // than letting a later PUT erase the durable reference.
    if (cur._source !== 'server' && isAgentGroup(cur)) {
      const rid = agentGroupRunId(cur)
      if (rid !== null && groupTapeServerAgentGroupRunIds[g].has(rid)) continue
    }
    // Legacy server agent-group rows remain local-wins because they contain
    // only a summary skeleton; this preserves the pre-tape contract.
    if (cur._source === 'server' && isAgentGroup(cur)) {
      const rid = agentGroupRunId(cur)
      const tapeBacked = typeof (cur as { _turnTapeId?: unknown })._turnTapeId === 'string'
      if (!tapeBacked && rid !== null && groupClientAgentGroupRunIds[g].has(rid)) {
        continue // local rich row supersedes → drop server row
      }
      deduped.push(cur)
      continue
    }
    // Keep server-authored messages and non-(assistant|thinking|tool) messages.
    // (Client agent-group rows fall here — always preserved, never deduped by
    //  the server; the server row is what gives way, handled above.)
    if (
      cur._source === 'server' ||
      (!isAssistant(cur) && !isThinking(cur) && !isTool(cur))
    ) {
      deduped.push(cur)
      continue
    }
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
 *
 * Legacy 收紧(见 Step 1):整数组「按位从 1 重编」只在真 legacy(所有旧行都缺
 * 合法 _seq 且 currentNextSeq <= 1)发生;其余情形已有合法 _seq 的行绝不重编,缺号
 * 行只向后补新号,避免并发窗口把热行 _seq 重排(seq 序脱离 ts 序/数组序)。
 *
 * `onWarn`(可选,默认无副作用,不改既有 3 参调用方):当旧行间发现重复合法 _seq 时,
 * **不静默重排**——保留第一条、其余换新号,并通过该回调上报一条诊断信息。本文件无既有
 * logger,故以可选回调作为最小侵入的 warn 通道,保持函数纯性。
 */
export function normalizeAndAssignSeqs<T extends MessageLike>(
  oldMsgs: readonly T[],
  finalMsgs: readonly T[],
  currentNextSeq: number,
  onWarn?: (message: string) => void,
): { messages: T[]; nextSeq: number; maxSeq: number } {
  // 合法 _seq:正安全整数(正、整、在 Number 安全范围内)。
  // 比旧判据(`typeof === 'number' && isFinite`)更严:0 / 负数 / 小数 / 超安全范围
  // 都视为「缺失」,由补号路径重新分配,以真正兑现「每行 _seq 正整数」不变量。
  const isValidSeq = (s: unknown): s is number =>
    typeof s === 'number' && Number.isSafeInteger(s) && s > 0

  // Step 1: 归一化 oldMsgs 侧的 _seq,并确定本行的 nextSeq 起点。
  //
  // 分支收紧(tail-flood 事故根治):旧实现「任一旧行缺合法 _seq → 整数组按位从 1
  // 重编」,在并发窗口会把已分配的热行 _seq 全部重排,造成 seq 序 ≠ ts 序 ≠ 数组序。
  // _seq 语义是「server-visible content version」游标(内容变化才换号),不是时间序,
  // 因此**已持有合法 _seq 的行绝不重编**。整数组按位重编只保留给「真 legacy」:
  //   全部旧行都缺合法 _seq  且  currentNextSeq <= 1(游标从未推进 = 迁移默认值)。
  // 其余情形(部分行有 seq / 游标已推进 / 存在重复 seq)一律走「保留 + 补号」路径:
  //   已有合法且未重复的 seq 原样保留;缺号 / 重复号的行从 max(currentNextSeq,
  //   maxValidSeq+1) 起顺序补新号(严格大于任何既有合法 seq,不覆盖、不回绕)。
  let oldNormalized: Array<T & { _seq: number }>
  let nextSeq: number

  let maxValidSeq = 0
  let anyValidSeq = false
  for (const mm of oldMsgs) {
    const s = mm ? (mm as MessageLike)._seq : undefined
    if (isValidSeq(s)) {
      anyValidSeq = true
      if (s > maxValidSeq) maxValidSeq = s
    }
  }
  const allOldMissingSeq = !anyValidSeq
  const isTrueLegacy = allOldMissingSeq && currentNextSeq <= 1

  if (isTrueLegacy) {
    // 真 legacy:整行从未有过合法 _seq 且游标停在迁移默认值 → 按当前数组序从 1 重编。
    // 这里刻意忽略 currentNextSeq(=1,尚无意义)。
    oldNormalized = oldMsgs.map((m, idx) => ({ ...(m as object), _seq: idx + 1 } as T & { _seq: number }))
    nextSeq = oldMsgs.length + 1
  } else {
    // 保留 + 补号:补号游标从 max(currentNextSeq, maxValidSeq+1) 起,保证严格单调、
    // 不与任何既有合法 seq 相撞(合法 seq 均 <= maxValidSeq < alloc)。此路径同时兼容
    // 旧「else」分支的 next_seq 漂移防御(全员有 seq 但持久化 next_seq 落后时强制单调)。
    let alloc = Math.max(currentNextSeq, maxValidSeq + 1)
    const seenSeqs = new Set<number>()
    oldNormalized = oldMsgs.map((m) => {
      const s = m ? (m as MessageLike)._seq : undefined
      if (isValidSeq(s) && !seenSeqs.has(s)) {
        // 已有合法且首次出现的 seq:绝不重编,原样继承(可复用引用,减少 GC)。
        seenSeqs.add(s)
        return m as T & { _seq: number }
      }
      // 缺号,或与前面某行 seq 重复 → 分配新号(严格大于所有既有合法 seq)。
      if (isValidSeq(s)) {
        // 重复:不静默重排——保留第一条、其余换新号,并通过 onWarn 上报(默认无副作用,
        // 保持纯性;既有 3 参调用方不受影响)。
        onWarn?.(
          `normalizeAndAssignSeqs: duplicate _seq ${s} in oldMsgs; keeping first occurrence, reassigning duplicate row to ${alloc}`,
        )
      }
      const assigned = alloc++
      seenSeqs.add(assigned)
      return { ...(m as object), _seq: assigned } as T & { _seq: number }
    })
    nextSeq = alloc
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

// ── 长会话热尾巴 + 归档:spill 核心(唯一写侧收口)──

/** {@link _spillOverflowCore} 的返回。 */
export interface SpillOverflowResult {
  /** 保留在 client_sessions.messages 行里的热尾巴(最近的消息;未触发 spill 时 === 入参 msgs)。 */
  tail: MessageLike[]
  /** 本次**新**归档的消息条数(幂等:重放同批已归档 chunk 时为 0,不重复计)。 */
  archivedDelta: number
  /** 归档水位 = max(既有水位, 本次归档消息 _seq 的最大值)。单调不降。 */
  archivedThroughSeq: number
}

/**
 * **spill 执行收口** —— 把行里最老的消息搬进归档 chunk 表,行只留热尾巴。四条写路径
 * (upsert / server-authored append / cost-patch / delegate-drain)与迁移脚本
 * **全部复用本函数**,是 SQLite backend 归档的唯一写侧收口。
 *
 * 决策(搬哪些 / 切几个 chunk / 水位)已抽到引擎中立的 {@link planSpillOverflow}(RFC D6b,
 * 防双 backend 漂移);本函数只做 SQLite 执行:调 plan → 按变更集 INSERT OR IGNORE。
 *
 * 必须在调用方的事务内(BEGIN IMMEDIATE)同步调用:本函数直接 INSERT 归档表,依赖调用方
 * 事务的原子性(与主行 UPDATE 同提交 / 同回滚)。
 *
 * 前置契约:入参 msgs 必须已跑过 {@link normalizeAndAssignSeqs}(全员有数字 _seq);缺 _seq 时
 * plan 返回安全 no-op(不 spill 原样返回)。
 *
 * 幂等:chunk PK (session_id, first_seq=min _seq) 冲突用 INSERT OR IGNORE;archivedDelta
 * **只累计真正新插入 chunk 的条数**(cr.changes>0)—— 这依赖执行结果,不进纯 plan。
 */
export function _spillOverflowCore(
  db: Database.Database,
  sessId: string,
  userId: string,
  msgs: MessageLike[],
  opts: { currentArchivedThroughSeq: number; now?: number },
): SpillOverflowResult {
  const now = opts.now ?? Date.now()
  const plan = planSpillOverflow(msgs, opts.currentArchivedThroughSeq)
  const archivedDelta = _executeSpillPlan(db, sessId, userId, plan.chunksToInsert, plan.idsToInsert, now)
  return { tail: plan.tail, archivedDelta, archivedThroughSeq: plan.archivedThroughSeq }
}

/**
 * spill 变更集的 SQLite 执行:落 chunk + archived_ids,返回真正新归档的条数(archivedDelta)。
 * 无 chunk → 零副作用(不 prepare、不写),archivedDelta=0。与 {@link _spillOverflowCore} 和
 * {@link _appendServerAuthoredCore} 共享,单一执行路径。
 */
function _executeSpillPlan(
  db: Database.Database,
  sessId: string,
  userId: string,
  chunksToInsert: SpillChunkPlan[],
  idsToInsert: string[],
  now: number,
): number {
  if (chunksToInsert.length === 0) return 0
  const insertChunk = db.prepare(
    `INSERT OR IGNORE INTO client_session_archive_chunks
       (session_id, user_id, first_seq, last_seq, message_count, messages, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertId = db.prepare(
    'INSERT OR IGNORE INTO client_session_archived_ids (session_id, msg_id) VALUES (?, ?)',
  )
  let archivedDelta = 0
  for (const chunk of chunksToInsert) {
    // 幂等:重放同批时 chunk PK 冲突 → OR IGNORE no-op,archivedDelta 不重复计。
    const cr = insertChunk.run(
      sessId, userId, chunk.firstSeq, chunk.lastSeq, chunk.messageCount, JSON.stringify(chunk.messages), now,
    )
    if (cr.changes > 0) archivedDelta += chunk.messageCount
  }
  // id 集 INSERT OR IGNORE:重放无害(整批在 chunk 之后落,与 chunk 同表 disjoint,顺序不影响终态)。
  for (const id of idsToInsert) insertId.run(sessId, id)
  return archivedDelta
}

/**
 * **PUT 防复活** —— 从客户端 PUT 的 incoming 消息里剔除 id 已归档的消息。
 *
 * 客户端本地缓存持有完整历史(归档 + 尾巴),全量 PUT 会把已归档消息一并带回;若不剔除,
 * mergePreservingServerAuthored 会把它们重新并入行 → 行体积回涨、又触发 spill,来回震荡。
 *
 * 用 incoming ids 做参数化 IN 查询(分批,避开 SQLite 999 变量上限),**绝不全表拉** archived_ids。
 * 纯读,须在调用方事务内调用。
 */
function _filterOutArchivedIncoming(
  db: Database.Database,
  sessId: string,
  msgs: MessageLike[],
): MessageLike[] {
  const ids: string[] = []
  for (const m of msgs) if (typeof m?.id === 'string') ids.push(m.id)
  if (ids.length === 0) return msgs

  const archived = new Set<string>()
  const CHUNK = 400 // 单查询变量数 = 1(session_id) + CHUNK,远低于 SQLite 999 上限
  for (let off = 0; off < ids.length; off += CHUNK) {
    const batch = ids.slice(off, off + CHUNK)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT msg_id FROM client_session_archived_ids WHERE session_id = ? AND msg_id IN (${placeholders})`,
    ).all(sessId, ...batch) as Array<{ msg_id: string }>
    for (const r of rows) archived.add(r.msg_id)
  }
  if (archived.size === 0) return msgs
  return msgs.filter((m) => !(typeof m?.id === 'string' && archived.has(m.id)))
}

// 竞态回滚哨兵:upsertClientSession 在 DEFERRED 事务里 spill 之后才知道主行 ON CONFLICT
// WHERE 是否因并发写被拒(result.changes===0)。被拒时必须把已做的 spill 归档 INSERT 一并
// 回滚,否则会留下"归档表有 chunk 但主行没更新"的孤儿。抛此哨兵 → better-sqlite3 事务包装
// 回滚并 rethrow → 外层 catch 映射为 rejected_stale。复用同一实例(重复抛无副作用)。
const _STALE_WRITE_ROLLBACK = new Error('__stale_write_rollback__')

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
async function _sqliteUpsertClientSession(session: ClientSession, baseSyncedAt = 0): Promise<UpsertClientSessionResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): UpsertClientSessionResult => {
    const existing = db.prepare(
      'SELECT messages, updated_at, next_seq, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).get(session.id, session.userId) as {
      messages: string; updated_at: number; next_seq: number | null
      archived_through_seq: number | null; archived_count: number | null
    } | undefined

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
    const clientMsgsRaw = _stripClientPutMessages(session.messages as unknown[], oldMsgs)
    // PUT 防复活:剔除 id 已归档的 incoming 消息(客户端全量 PUT 会带回完整历史,含已搬走
    // 的归档行;不剔除则被重新并入 → 行回涨 → 又 spill,来回震荡)。见 _filterOutArchivedIncoming。
    const clientMsgs = _filterOutArchivedIncoming(db, session.id, clientMsgsRaw)
    const merged = mergePreservingServerAuthored(oldMsgs, clientMsgs) as MessageLike[]
    const currentNextSeq = existing && typeof existing.next_seq === 'number' && existing.next_seq > 0
      ? existing.next_seq
      : 1
    const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(oldMsgs, merged, currentNextSeq)

    // 热尾巴 + 归档:normalize 后、写行前把最老的消息搬进归档,行只留热尾巴。归档表 INSERT
    // 在本事务内;若下面的 ON CONFLICT WHERE 因并发写被拒(racing stale),抛哨兵一并回滚。
    const now = Date.now()
    const spill = _spillOverflowCore(db, session.id, session.userId, finalMessages, {
      currentArchivedThroughSeq: existing?.archived_through_seq ?? 0,
      now,
    })
    const newArchivedCount = (existing?.archived_count ?? 0) + spill.archivedDelta
    const tail = spill.tail

    // Size guard — see MAX_SESSION_BYTES(spill 后作用于 tail;tail ≤ TAIL_TARGET(2M) < 4M,
    // 理论不可达,保留作最后防线)。Buffer.byteLength 让多字节 UTF-8(中文/emoji)按落盘字节计。
    const finalJson = JSON.stringify(tail)
    if (Buffer.byteLength(finalJson, 'utf8') > MAX_SESSION_BYTES) {
      return 'oversized'
    }

    const result = db.prepare(`
      INSERT INTO client_sessions (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, next_seq, archived_through_seq, archived_count)
      VALUES (@id, @userId, @agentId, @title, @pinned, @createdAt, @lastAt, @messages, @messageCount, MAX(@updatedAt, @updatedAtFloor), @nextSeq, @archivedThroughSeq, @archivedCount)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        title = excluded.title,
        pinned = excluded.pinned,
        last_at = excluded.last_at,
        messages = excluded.messages,
        message_count = excluded.message_count,
        -- updated_at 逻辑版本(RFC D3b):冲突更新走 DB 计算 MAX(既有+1, now, 客户端回传值)
        -- 严格单调推进。**首建(BLOCKER-1)**:新插入的 updated_at 也取 MAX(客户端回传, 服务端时钟
        -- 下限 @updatedAtFloor)—— 不再无条件信任客户端 @updatedAt(客户端可回传 0 / 旧值,首建
        -- 后紧跟 baseSyncedAt=0 的第二个 PUT 会因 existing.updated_at 仍是 0 而击穿 stale 检测)。
        -- 服务端时钟下限保证首建版本 ≥ now,双 master 同毫秒双写/时钟偏差被 cur+1 兜底。
        updated_at = MAX(client_sessions.updated_at + 1, @updatedAtFloor, excluded.updated_at),
        next_seq = excluded.next_seq,
        archived_through_seq = excluded.archived_through_seq,
        archived_count = excluded.archived_count
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
      // message_count = 热尾巴条数 + 已归档累计条数(含本次 delta),给列表/计数用。
      messageCount: tail.length + newArchivedCount,
      updatedAt: session.updatedAt,
      // D3b 逻辑版本的墙钟下限(= PG 侧 floor(epoch_ms(clock_timestamp())) 的 SQLite 对应)。
      updatedAtFloor: now,
      baseSyncedAt,
      nextSeq,
      archivedThroughSeq: spill.archivedThroughSeq,
      archivedCount: newArchivedCount,
    })
    if (result.changes > 0) return 'applied'
    // result.changes === 0:ON CONFLICT WHERE 因 client_sessions.updated_at > @baseSyncedAt
    // 拒绝 UPDATE —— 我们的 SELECT 与本 INSERT 之间有并发写抢先提交(DEFERRED 事务的竞态)。
    // 此时上面的 spill 归档 INSERT 已发生但主行没更新,必须抛哨兵回滚整个事务,否则留下
    // "归档表有 chunk / 主行未更新" 的孤儿。外层 catch 映射为 rejected_stale(gateway 409)。
    throw _STALE_WRITE_ROLLBACK
  })
  try {
    return txn()
  } catch (err) {
    if (err === _STALE_WRITE_ROLLBACK) return 'rejected_stale'
    throw err
  }
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
    'SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ?'
  ).get(sessId, userId) as {
    messages: string; next_seq: number | null; deleted_at: number | null
    archived_through_seq: number | null; archived_count: number | null
  } | undefined
  if (!row) return { applied: false, reason: 'session_not_found' }
  if (row.deleted_at !== null) return { applied: false, reason: 'session_deleted' }

  // 幂等判定升级(热尾巴 + 归档):若这条 id 已归档(= 已持久化,只是搬出了热尾巴),
  // 视为 already_exists —— 防 sink 重放把归档内容重新 append 回尾巴造成重复行/行回涨。
  // 放在解析 msgs 前:命中即短路,省一次 JSON.parse。
  const archivedHit = db.prepare(
    'SELECT 1 FROM client_session_archived_ids WHERE session_id = ? AND msg_id = ?'
  ).get(sessId, message.id)
  if (archivedHit) return { applied: false, reason: 'already_exists' }

  let msgs: MessageLike[]
  try {
    const parsed = JSON.parse(row.messages)
    if (!Array.isArray(parsed)) return { applied: false, reason: 'malformed' }
    msgs = parsed as MessageLike[]
  } catch {
    return { applied: false, reason: 'malformed' }
  }

  // 决策(append 叠加 → 幻影去重自合并 → _seq 规范化 → spill 决策 → 超限判定)抽到引擎中立的
  // {@link planAppendServerAuthored}(RFC D6b):PG backend 复用同一决策,双 backend 不各养一份
  // 业务逻辑(幻影去重的 mergePreservingServerAuthored(arr,arr)、legacy 回填、size guard 全在 plan)。
  const currentNextSeq = typeof row.next_seq === 'number' && row.next_seq > 0 ? row.next_seq : 1
  const plan = planAppendServerAuthored(msgs, message, currentNextSeq, row.archived_through_seq ?? 0)
  if (plan.kind === 'already_exists') return { applied: false, reason: 'already_exists' }
  // 'oversized':spill 后 tail 仍超 MAX_SESSION_BYTES(理论不可达)。调用方 durable wrapper/replay
  // 视其为终态,outbox 不再空转重放。
  if (plan.kind === 'oversized') return { applied: false, reason: 'oversized' }

  // 执行(SQLite):归档 spill 变更集(archivedDelta 据实际新插入计)+ 主行 UPDATE。同一事务、同一 now。
  const now = Date.now()
  const archivedDelta = _executeSpillPlan(db, sessId, userId, plan.chunksToInsert, plan.idsToInsert, now)
  const newArchivedCount = (row.archived_count ?? 0) + archivedDelta
  const tail = plan.tail

  // Belt-and-braces: the SELECT above already gated on `deleted_at !== null`
  // inside the same BEGIN IMMEDIATE transaction, so a concurrent soft-delete
  // can't race in. Keeping `deleted_at IS NULL` on the UPDATE is a storage
  // invariant guard against future call-path changes (e.g. a refactor that
  // moves the SELECT/UPDATE into separate transactions). If it fails the
  // SELECT/UPDATE invariant, `changes` will be 0 and we surface session_deleted
  // instead of silently writing into a tombstone.
  //
  // updated_at 逻辑版本(RFC D3b):由 DB 计算 MAX(updated_at + 1, now) 严格单调推进
  // (双 master 下同毫秒双写 / 时钟偏差被 cur+1 兜底,消除 stale-write 静默覆盖)。
  const update = db.prepare(
    'UPDATE client_sessions SET messages = ?, message_count = ?, last_at = ?, updated_at = MAX(updated_at + 1, ?), next_seq = ?, archived_through_seq = ?, archived_count = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).run(plan.finalJson, tail.length + newArchivedCount, now, now, plan.nextSeq, plan.archivedThroughSeq, newArchivedCount, sessId, userId)
  if (update.changes !== 1) {
    // Race: row was deleted between SELECT and UPDATE within the same txn.
    // Should be unreachable under BEGIN IMMEDIATE, but if SQLite's transaction
    // mode ever changes, we'd rather surface the terminal state than silently
    // resurrect a tombstone.
    return { applied: false, reason: 'session_deleted' }
  }
  return { applied: true }
}

async function _sqliteAppendServerAuthoredMessage(
  sessId: string,
  userId: string,
  message: {
    id: string
    /** 'thinking' added to support v3 server-authored thinking persistence
     *  (mobile-stream durability for Sonnet 4.6 adaptive thinking). Same
     *  storage path as 'assistant'; phantom-dedupe applies independently
     *  to each role inside `mergePreservingServerAuthored`.
     *
     *  'agent-group' (P2 债A):server-authored 团队卡。落库路径与其它 role 相同,
     *  但 `mergePreservingServerAuthored` 对它做 **local-wins**(与 assistant/
     *  thinking/tool 的 server-wins 相反)—— 本地 `m-*` 富行(带 childBlocks 子树)
     *  存在时丢弃 server `srv-*` 行,禁止 server 行吞掉子树(2c73030d 回归)。 */
    role: 'assistant' | 'user' | 'system' | 'thinking' | 'tool' | 'agent-group'
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
 * write returns `already_exists`; the map row already matches so it is NOT
 * re-inserted; pending drain is a no-op. Caller-visible result is identical
 * for first and subsequent calls (with `applied: false, reason: 'already_exists'`).
 *
 * **Non-remappable (RFC D3/R1, parity with pgSessionsBackend)**: before
 * touching pending/append, we read the existing map row. If it already maps
 * (requestId, userId) to a *different* (sessionId, msgId), we throw
 * fail-closed — a mis-reused requestId must never re-point cost at another
 * message. This runs even on `already_exists` replays. The PG backend does
 * the same under `SELECT … FOR UPDATE`; here the single-writer transaction
 * makes a plain read sufficient.
 */
async function _sqliteAppendServerAuthoredMessageForRequest(
  requestId: string,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<AppendForRequestResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): AppendForRequestResult => {
    // 0. Non-remappable check (MUST precede any early return). Existing map
    //    with a different (session_id, msg_id) → fail-closed (error form
    //    aligned with pgSessionsBackend's `拒绝重映射`).
    const existingMap = db.prepare(
      'SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = ? AND user_id = ?'
    ).get(requestId, userId) as { session_id: string; msg_id: string } | undefined
    if (existingMap && (existingMap.session_id !== sessId || existingMap.msg_id !== message.id)) {
      throw new Error(
        `[sqliteSessions] server_authored_request_map 拒绝重映射: (requestId=${requestId},userId=${userId}) ` +
          `已映射 (${existingMap.session_id},${existingMap.msg_id}),本次欲映射 (${sessId},${message.id})`
      )
    }

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
    //    inserts a separate row instead of being silently dropped. Only
    //    insert when no map row exists yet — if one exists it was already
    //    validated consistent in step 0, so re-inserting is redundant (the
    //    ON CONFLICT stays as defense-in-depth, never expected to fire).
    if (!existingMap) {
      db.prepare(
        `INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (request_id, user_id) DO NOTHING`
      ).run(requestId, userId, sessId, message.id)
    }

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
async function _sqliteAppendServerAuthoredMessageDrainByUser<T extends MessageLike & { id: string }>(
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
async function _sqliteAppendCostCredits(
  requestId: string,
  userId: string,
  costCredits: string,
  // agent session id(ccb getSessionId,proxy 从 LLM metadata.session_id 提取)。park 时一并
  // 记入 pending.session_id,供 ccb 助手落库时按 session 精确 drain(消除 by-user 跨会话归并)。
  // 缺省 → 存 NULL,退回 by-user 兜底(老 proxy / 拿不到 session 的路径)。
  sessionId?: string | null,
  // 父**客户端**会话 id(web-*)。仅委派子会话非空(proxy 从 attribution.parentSessionId
  // 传入)。park 时记入 pending.parent_session_id,供队长助手行落库时经
  // drainDelegateCostForClientSession 按父客户端会话精确归并成本。普通 chat / codex 自费恒
  // NULL —— 与 session_id 池 disjoint,不会被队长的 requestId / by-agent-session drain 命中,
  // 也不会命中队长自己的成本,保证不重复计费。
  parentSessionId?: string | null,
  // P2 债D — 委派子 agent id(= attribution.delegateAgentId)。仅委派子会话非空,与
  // parentSessionId 同源(proxy 同一个 attribution 一起透传)。park 进 pending.delegate_agent_id,
  // drainDelegateCostForClientSession 据此按 agent 分组求和,产出队长助手行 usage.delegates[]
  // 的 per-agent 明细。纯展示投影 —— 不进任何扣费 WHERE,不影响 drain 的归并总额。
  delegateAgentId?: string | null,
  turnKey?: string | null,
  parentTurnKey?: string | null,
): Promise<AppendCostCreditsResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): AppendCostCreditsResult => {
    const mapRow = db.prepare(
      'SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = ? AND user_id = ?'
    ).get(requestId, userId) as { session_id: string; msg_id: string } | undefined

    if (mapRow) {
      // 会话行含软删行读出(去 deleted_at IS NULL 过滤,读出 deleted_at):RFC D3 late-cost —
      // map 指向已软删会话 → 返回 noop **不 park**(park 会留永不 drain 的孤儿 pending;delete
      // 已级联清 delegate pending,直接成本 patch 也走本 noop)。双 backend 语义一致(消除差异点)。
      const sess = db.prepare(
        'SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ?'
      ).get(mapRow.session_id, userId) as {
        messages: string; next_seq: number | null; deleted_at: number | null
        archived_through_seq: number | null; archived_count: number | null
      } | undefined
      if (sess) {
        if (sess.deleted_at !== null) return { applied: 'noop' } // 软删会话 late-cost → noop 不 park
        let msgs: MessageLike[]
        try {
          const parsed = JSON.parse(sess.messages)
          // Malformed sessions blob → 视为空 → planCostPatch not_found → 下面 fall through 到 pending
          // (值不丢,admin 修 blob 后下次 sink POST 再 drain)。
          msgs = Array.isArray(parsed) ? (parsed as MessageLike[]) : []
        } catch {
          msgs = []
        }
        const currentNextSeq = typeof sess.next_seq === 'number' && sess.next_seq > 0 ? sess.next_seq : 1
        // 决策抽到引擎中立的 planCostPatch(RFC D6b):双 backend 复用,不各养一份(幂等判定 /
        // patch 构造 / spill / size guard 全在 plan)。执行层只落 SQL。
        const plan = planCostPatch(msgs, mapRow.msg_id, costCredits, currentNextSeq, sess.archived_through_seq ?? 0)
        if (plan.kind === 'noop') return { applied: 'noop' }
        if (plan.kind === 'patch') {
          const nowMs = Date.now()
          const archivedDelta = _executeSpillPlan(db, mapRow.session_id, userId, plan.chunksToInsert, plan.idsToInsert, nowMs)
          const newArchivedCount = (sess.archived_count ?? 0) + archivedDelta
          db.prepare(
            'UPDATE client_sessions SET messages = ?, message_count = ?, last_at = ?, updated_at = MAX(updated_at + 1, ?), next_seq = next_seq + 1, archived_through_seq = ?, archived_count = ? WHERE id = ? AND user_id = ?'
          ).run(
            plan.finalJson,
            plan.tail.length + newArchivedCount,
            nowMs,
            nowMs,
            plan.archivedThroughSeq,
            newArchivedCount,
            mapRow.session_id,
            userId,
          )
          return { applied: 'patched' }
        }
        // plan.kind === 'not_found':目标 msg 不在热尾巴。若已归档(spill 搬出),成本无法再落回
        // 尾巴 → 直接 noop(别徒劳 re-pending 陷 "找不到→再 pending" 循环,直到 24h GC)。
        // 未归档 = 真被删/编辑 out-of-band → 维持现有语义,fall through 到 pending。
        const archivedHit = db.prepare(
          'SELECT 1 FROM client_session_archived_ids WHERE session_id = ? AND msg_id = ?'
        ).get(mapRow.session_id, mapRow.msg_id)
        if (archivedHit) return { applied: 'noop' }
        // 未归档 → fall through 到 pending(与归档前行为一致)。
      }
    }

    db.prepare(
      `INSERT INTO pending_usage_patches
         (request_id, user_id, session_id, parent_session_id, delegate_agent_id,
          turn_key, parent_turn_key, cost_credits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id, user_id) DO UPDATE SET
         cost_credits = excluded.cost_credits,
         session_id = excluded.session_id,
         parent_session_id = excluded.parent_session_id,
         delegate_agent_id = excluded.delegate_agent_id,
         turn_key = excluded.turn_key,
         parent_turn_key = excluded.parent_turn_key,
         created_at = (CAST(strftime('%s','now') AS INTEGER)*1000)`
    ).run(
      requestId,
      userId,
      sessionId ?? null,
      parentSessionId ?? null,
      delegateAgentId ?? null,
      turnKey ?? null,
      parentTurnKey ?? null,
      costCredits,
    )
    return { applied: 'pending' }
  })
  return txn()
}

export interface DrainDelegateCostResult {
  /** 本次归并进队长助手行的 delegate 成本总和(十进制字符串;无委派成本 → '0')。 */
  merged: string
  /** 本次排空的 pending 行数(= 命中的委派子请求数;0 = 无委派成本 / 目标行缺位)。 */
  drained: number
  /** P2 债D — 归并后队长助手行 usage.delegates[] 的当前快照(按 delegate_agent_id 分组
   *  求和,含历史已归并 + 本次新增;merged=0 / 目标缺位时省略)。纯展示投影。 */
  delegates?: MessageUsageDelegate[]
}

/**
 * **委派成本按父客户端会话归并(Fix A durable)。**
 *
 * 队长助手行落库后调用:把该 user 下所有 `parent_session_id = clientSessionId` 的委派
 * pending 成本**求和累加**进队长助手消息(msgId)的 `usage.costCredits`,并删除已排空的行。
 *
 * 与既有两条 drain 的关系(**disjoint 池,保证不重复计费**):
 *   - 队长自费(codex)走 {@link appendServerAuthoredMessageForRequest} 按 `request_id` 排空,
 *     其 pending 行 `parent_session_id` 恒 NULL → 本函数的 WHERE 过滤不到,不会被二次计。
 *   - 队长自费(ccb)走 {@link appendServerAuthoredMessageDrainByUser} 按 `session_id`(引擎会话)
 *     排空,其 pending 行 `parent_session_id` 亦恒 NULL → 同样过滤不到。
 *   - 委派成本 park 时只写 `parent_session_id`(引擎会话 `session_id` 是委派子进程自己的、
 *     无人以它为 key drain)→ **只有本函数**会排空它。每行至多被一条机制排空一次。
 *
 * 语义要点:
 *   - **累加不替换**:读取当前 blob(可能已含队长自费 costCredits),base + Σdelegate 后回写。
 *   - **无委派成本 → 零副作用**:Σ=0 时不写库、不 bump `_seq`(避免每个普通 turn 白 bump)。
 *   - **目标行缺位保守**:session 不存在 / 找不到 msgId(尚未 sink / 被删)→ **不删 pending**,
 *     留给下一 turn 的队长行 drain 命中(与既有 pending "还没找到目标" 语义一致)。
 *   - **只删本次读到的行**:并发新 park(SELECT 之后到达)不在列表里,留给下一轮。
 *   - **size guard**:超 MAX_SESSION_BYTES 拒绝 in-place 增长(同 appendCostCredits 口径),
 *     成本这轮丢展示但 pending 保留 → 下一轮或 admin 修 blob 后仍可归并。
 *
 * 幂等:pending 行排空即删,sink POST 重放(already_exists)时二次调用只会命中"新到的"
 * 委派 pending(若有),已排空的不会重复累加。
 */
async function _sqliteDrainDelegateCostForClientSession(
  clientSessionId: string,
  userId: string,
  msgId: string,
): Promise<DrainDelegateCostResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): DrainDelegateCostResult => {
    const pendings = db.prepare(
      'SELECT request_id, cost_credits, delegate_agent_id FROM pending_usage_patches WHERE user_id = ? AND parent_session_id = ?'
    ).all(userId, clientSessionId) as {
      request_id: string
      cost_credits: string
      delegate_agent_id: string | null
    }[]
    if (pendings.length === 0) return { merged: '0', drained: 0 }

    // 目标会话行(deleted_at IS NULL);缺位 → msgs=null 传给 plan(→ target_not_ready 保留)。
    const sess = db.prepare(
      'SELECT messages, next_seq, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).get(clientSessionId, userId) as {
      messages: string; next_seq: number | null
      archived_through_seq: number | null; archived_count: number | null
    } | undefined

    let msgs: MessageLike[] | null = null
    let currentNextSeq = 1
    let currentArchivedThroughSeq = 0
    if (sess) {
      try {
        const parsed = JSON.parse(sess.messages)
        msgs = Array.isArray(parsed) ? (parsed as MessageLike[]) : []
      } catch {
        msgs = []
      }
      currentNextSeq = typeof sess.next_seq === 'number' && sess.next_seq > 0 ? sess.next_seq : 1
      currentArchivedThroughSeq = sess.archived_through_seq ?? 0
    }

    // 决策(Σ + per-agent 分组 + delegates 累加合并 + spill + 超限判定)抽到引擎中立的
    // planDelegateCostMerge(RFC D6b):双 backend 复用,不各养一份。执行层只落 SQL。
    const plan = planDelegateCostMerge(
      msgs,
      msgId,
      pendings.map((p) => ({ costCredits: p.cost_credits, delegateAgentId: p.delegate_agent_id })),
      currentNextSeq,
      currentArchivedThroughSeq,
    )

    const del = db.prepare('DELETE FROM pending_usage_patches WHERE user_id = ? AND request_id = ?')
    if (plan.kind === 'no_positive_cost') {
      // 只有非正/畸形成本 → 清本批(无归并价值,即便会话缺位也清),不写库、不 bump _seq。
      for (const p of pendings) del.run(userId, p.request_id)
      return { merged: '0', drained: pendings.length }
    }
    if (plan.kind === 'target_not_ready') {
      // 会话缺位 / 找不到队长行 / spill 后超限 → 保守保留 pending,下一 turn 再试。
      return { merged: '0', drained: 0 }
    }

    // plan.kind === 'merge':落 spill + 主行 UPDATE(next_seq+1)+ 清本批 pending。
    const nowMs = Date.now()
    const archivedDelta = _executeSpillPlan(db, clientSessionId, userId, plan.chunksToInsert, plan.idsToInsert, nowMs)
    const newArchivedCount = (sess!.archived_count ?? 0) + archivedDelta
    db.prepare(
      'UPDATE client_sessions SET messages = ?, message_count = ?, last_at = ?, updated_at = MAX(updated_at + 1, ?), next_seq = next_seq + 1, archived_through_seq = ?, archived_count = ? WHERE id = ? AND user_id = ?'
    ).run(plan.finalJson, plan.tail.length + newArchivedCount, nowMs, nowMs, plan.archivedThroughSeq, newArchivedCount, clientSessionId, userId)

    // 只删本次读到的行——并发新 park 不在列表里,留给下一轮。
    for (const p of pendings) del.run(userId, p.request_id)
    return {
      merged: plan.merged,
      drained: pendings.length,
      ...(plan.delegates.length > 0 ? { delegates: plan.delegates } : {}),
    }
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
  /** 带 turn_key 的滞留行晚到折叠进 turn_tape_cost_components 的条数(lossless tape 是
   * PG/commercial 专属,SQLite 引擎恒 0)。 */
  pendingFolded: number
  /** 折叠时发现 (request_id,user_id) 已有坐标/金额不符的 cost component——不删、只计数,
   * 留给人工核对(不可变冲突,与 finalize 内折叠同语义)。SQLite 恒 0。 */
  pendingFoldAnomaly: number
  /** 带 key 但任何 finalized tape 都匹配不到(读路径永不可达)、超期后清除的条数。SQLite 恒 0。 */
  pendingUnreachableExpired: number
  /** 已 finalize tape 的原始分片(parts,含未脱敏 payload)超期清除条数。SQLite 恒 0。 */
  tapePartsPurged: number
}

const PENDING_AGING_MS = 60 * 60_000           // 1h alarm
const PENDING_HARD_DELETE_MS = 24 * 60 * 60_000  // 24h GC
const MAP_HARD_DELETE_MS = 7 * 24 * 60 * 60_000  // 7d GC

async function _sqliteSweepUsageAggregationGc(
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
      `DELETE FROM pending_usage_patches
       WHERE created_at <= ? AND turn_key IS NULL AND parent_turn_key IS NULL`
    ).run(expiredThreshold)

    const delMap = db.prepare(
      'DELETE FROM server_authored_request_map WHERE written_at <= ?'
    ).run(mapThreshold)

    return {
      pendingAging: aging.n,
      pendingExpired: delPending.changes,
      mapExpired: delMap.changes,
      // lossless turn tape 四表只存在于 PG/commercial 引擎,SQLite 侧无对应清扫面。
      pendingFolded: 0,
      pendingFoldAnomaly: 0,
      pendingUnreachableExpired: 0,
      tapePartsPurged: 0,
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

async function _sqliteListClientSessions(userId: string): Promise<ClientSessionMeta[]> {
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

async function _sqliteGetClientSession(
  id: string,
  userId?: string,
  options: ClientSessionReadOptions = {},
): Promise<ClientSession | null> {
  const db = await getSessionsDb()
  const sql = userId
    ? "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    : "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND deleted_at IS NULL"
  const row = (userId ? db.prepare(sql).get(id, userId) : db.prepare(sql).get(id)) as {
    id: string; user_id: string; agent_id: string; title: string; pinned: number;
    created_at: number; last_at: number; messages: string; updated_at: number
    archived_through_seq: number | null; archived_count: number | null
  } | undefined
  if (!row) return null
  const exactMessages = JSON.parse(row.messages) as MessageLike[]
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    lastAt: row.last_at,
    messages: options.projection === 'chat'
      ? projectClientSessionMessagesForChat(exactMessages)
      : exactMessages,
    updatedAt: row.updated_at,
    // 归档水位透传(读新列,零额外 IO)。getClientSession 返回的 messages 是热尾巴;
    // 客户端据 archivedThroughSeq 判定本地已归档行的保留,据 archivedCount 显示计数。
    archivedCount: row.archived_count ?? 0,
    archivedThroughSeq: row.archived_through_seq ?? 0,
  }
}

async function _sqliteClassifyClientSessions(
  refs: readonly ClientSessionLifecycleRef[],
): Promise<ClientSessionLifecycle[]> {
  if (refs.length === 0) return []
  const db = await getSessionsDb()
  const stmt = db.prepare('SELECT deleted_at FROM client_sessions WHERE id = ? AND user_id = ?')
  return refs.map((ref) => {
    const row = stmt.get(ref.sessionId, ref.userId) as { deleted_at: number | null } | undefined
    return {
      ...ref,
      state: row === undefined ? 'missing' : row.deleted_at === null ? 'active' : 'deleted',
    }
  })
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
async function _sqliteGetClientSessionPartial(
  id: string,
  userId: string,
  sinceSeq: number,
  options: ClientSessionReadOptions = {},
): Promise<ClientSessionPartial | null> {
  const db = await getSessionsDb()
  const row = db.prepare(
    "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  ).get(id, userId) as {
    id: string; user_id: string; agent_id: string; title: string; pinned: number;
    created_at: number; last_at: number; messages: string; updated_at: number
    archived_through_seq: number | null; archived_count: number | null
  } | undefined
  if (!row) return null
  const archivedCount = row.archived_count ?? 0
  const archivedThroughSeq = row.archived_through_seq ?? 0

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

  if (options.projection === 'chat') messages = projectClientSessionMessagesForChat(messages)

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
    // 总条数 = 热尾巴条数 + 已归档条数(row.messages 现在只存热尾巴,allMsgs 即热尾巴)。
    totalMessageCount: allMsgs.length + archivedCount,
    maxSeq,
    isPartial,
    archivedCount,
    archivedThroughSeq,
  }
}

/** {@link readArchivedMessages} 的返回。 */
export interface ReadArchivedMessagesResult {
  /** 本页归档消息,**升序**(_seq 从小到大)返回。 */
  messages: MessageLike[]
  /** 是否还有更早(_seq 更小)的归档消息 —— 前端"从云端加载更早历史"是否继续可点。 */
  hasMore: boolean
  /** 本页最老一条的 _seq(= 下一页 beforeSeq 游标);空页 → null。 */
  oldestSeq: number | null
}

/**
 * **归档回看分页**(用户上滑加载更早历史;读侧,零写)。
 *
 * 语义:返回 `_seq < beforeSeq` 的**最近** `limit` 条(升序返回);hasMore = 更早还有。
 *   - beforeSeq 传 0/缺省 = 从 archived_through_seq+1 开始(即最新归档页)。
 *   - 分页游标单向后退:下一页传本页 oldestSeq,严格取更早,不重不漏。
 *   - limit 默认 100、上限 200(下限 1)。
 *
 * 实现:按 chunk 从新到旧读(idx_csa_chunks_last:last_seq DESC),展开、过滤 `_seq < beforeSeq`,
 * 攒够一页(>limit)即停 —— chunk 小(≤200 条/≤768KB),即便超长历史这段有界读也很轻。
 * 归档 _seq 随 spill 冻结、且 spill 恒搬"当前尾巴里最老的一段"(其 _seq 恒 > 上次水位)→
 * 归档区 _seq 与时间序单调,故"从新 chunk 起攒 limit 条"即全局最新 limit 条。
 *
 * 分租:先按 (id, user_id) 验会话归属(拿不到 → 空结果),chunk 查询再带 user_id 双保险。
 */
async function _sqliteReadArchivedMessages(
  sessId: string,
  userId: string,
  beforeSeq = 0,
  limit = 100,
  options: ClientSessionReadOptions = {},
): Promise<ReadArchivedMessagesResult> {
  const db = await getSessionsDb()
  const cappedLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 100)))

  // 会话归属 + 取水位(缺省 beforeSeq 的锚点)。行不存在/非本人/已删 → 空结果。
  const row = db.prepare(
    'SELECT archived_through_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
  ).get(sessId, userId) as { archived_through_seq: number | null } | undefined
  if (!row) return { messages: [], hasMore: false, oldestSeq: null }
  const watermark = typeof row.archived_through_seq === 'number' ? row.archived_through_seq : 0
  const effectiveBefore = Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : watermark + 1
  // effectiveBefore ≤ 1:没有 _seq < 1 的归档消息可返回(_seq 从 1 起)。
  if (effectiveBefore <= 1) return { messages: [], hasMore: false, oldestSeq: null }

  // 候选 chunk:first_seq(= chunk 内 _seq 最小值)< effectiveBefore 者才可能含合格消息。
  // 从新到旧读(last_seq DESC),攒到多于一页即停。
  const chunkRows = db.prepare(
    `SELECT messages FROM client_session_archive_chunks
       WHERE session_id = ? AND user_id = ? AND first_seq < ?
       ORDER BY last_seq DESC`,
  ).all(sessId, userId, effectiveBefore) as Array<{ messages: string }>

  const pool: MessageLike[] = []
  for (const cr of chunkRows) {
    let arr: MessageLike[]
    try {
      const parsed = JSON.parse(cr.messages)
      arr = Array.isArray(parsed) ? (parsed as MessageLike[]) : []
    } catch { arr = [] }
    for (const m of arr) {
      const s = typeof m?._seq === 'number' ? m._seq : -1
      if (s >= 0 && s < effectiveBefore) pool.push(m)
    }
    // 攒够一页 + 1(多出的那条用于判定 hasMore)即停:更老的 chunk _seq 更小,不影响本页。
    if (pool.length > cappedLimit) break
  }

  // 取 _seq 最大的 limit 条(= 最新的一页),升序返回。
  pool.sort((a, b) => ((a._seq as number) - (b._seq as number)))
  const hasMore = pool.length > cappedLimit
  const page = pool.slice(Math.max(0, pool.length - cappedLimit))
  const oldestSeq = page.length > 0 ? (page[0]._seq as number) : null
  return {
    messages: options.projection === 'chat' ? projectClientSessionMessagesForChat(page) : page,
    hasMore,
    oldestSeq,
  }
}

/** Soft-delete: zero out messages and mark as deleted. Prevents stale PUTs from resurrecting. */
async function _sqliteDeleteClientSession(id: string, userId?: string): Promise<boolean> {
  const db = await getSessionsDb()
  // updated_at 逻辑版本(RFC D3b):软删也严格单调推进 updated_at = MAX(既有+1, now),
  // 让并发 stale PUT(旧 baseSyncedAt)对 tombstone 的 ON CONFLICT 因版本落后被拒(409),
  // 与其它写路径口径一致。deleted_at 仍是删除权威,updated_at 只作乐观并发版本。
  const sql = userId
    ? "UPDATE client_sessions SET deleted_at = ?, updated_at = MAX(updated_at + 1, ?), messages = '[]', message_count = 0 WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    : "UPDATE client_sessions SET deleted_at = ?, updated_at = MAX(updated_at + 1, ?), messages = '[]', message_count = 0 WHERE id = ? AND deleted_at IS NULL"
  const now = Date.now()
  const txn = db.transaction((): boolean => {
    const result = userId ? db.prepare(sql).run(now, now, id, userId) : db.prepare(sql).run(now, now, id)
    if (result.changes === 0) return false
    // 归档级联清理:软删清 messages 却留归档 chunk/id 行会积累"不可达但占体积"的
    // 孤儿(用户删会话=不再要这份历史,隐私语义应与 messages 清零一致)。同事务保证
    // 不产生"主行已删、归档还在"的中间态;仅在主行真的被本次软删时才清,幂等。
    db.prepare('DELETE FROM client_session_archive_chunks WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM client_session_archived_ids WHERE session_id = ?').run(id)
    // delegate pending 级联清(RFC D3;与 PG backend 对齐,消除差异点):parent_session_id 指向
    // 该会话的委派 pending 若不清,会话删后永无队长行去 drain → 永不排空的孤儿。软删 late-cost
    // 现已直接 noop(见 appendCostCredits 软删分支),此处级联清是同一不变量的另一半。
    db.prepare('DELETE FROM pending_usage_patches WHERE parent_session_id = ?').run(id)
    return true
  })
  return txn()
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
async function _sqliteRenameClientSession(id: string, userId: string, title: string): Promise<{ ok: boolean; updatedAt: number }> {
  const db = await getSessionsDb()
  const now = Date.now()
  // updated_at 逻辑版本(RFC D3b):MAX(既有+1, now) 严格单调推进;RETURNING 回读真实写入值
  // 作为客户端新同步 token(避免返回 now 而实际写入 cur+1 时 token 落后 → 下次 PUT 被误拒)。
  const row = db.prepare(
    'UPDATE client_sessions SET title = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND user_id = ? AND deleted_at IS NULL RETURNING updated_at'
  ).get(title, now, id, userId) as { updated_at: number } | undefined
  return { ok: !!row, updatedAt: row ? row.updated_at : now }
}

/** List unclaimed sessions (user_id='default') with summary for migration UI. */
async function _sqliteListUnclaimedSessions(): Promise<Array<{
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
async function _sqliteAllMasterWsessRows(): Promise<Array<{
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
 *
 * **首建 updated_at 服务端时钟下限(BLOCKER-1)**:updated_at 取 MAX(lastAt, 服务端 now),
 * 不再无条件用客户端传入的 lastAt —— 与 upsertClientSession 首建口径一致,防首建版本落后于
 * 服务端时钟被后续 stale PUT 击穿。
 */
async function _sqliteUpsertMasterClientSession(input: {
  sessionId: string
  userId: string
  agentId: string
  originChannel: 'wechat'
  title: string
  createdAt: number
  lastAt: number
}): Promise<void> {
  const db = await getSessionsDb()
  const nowMs = Date.now()
  db.prepare(`
    INSERT INTO client_sessions
      (id, user_id, agent_id, title, created_at, last_at, updated_at, origin_channel)
    VALUES
      (@sessionId, @userId, @agentId, @title, @createdAt, @lastAt, MAX(@lastAt, @nowMs), @originChannel)
  `).run({
    sessionId: input.sessionId,
    userId: input.userId,
    agentId: input.agentId,
    title: input.title,
    createdAt: input.createdAt,
    lastAt: input.lastAt,
    nowMs,
    originChannel: input.originChannel,
  })
}

/**
 * Broker-only soft-delete wrapper. Tenant-scoped on `(sessionId, userId)` —
 * same semantics as `deleteClientSession(id, userId)` so wechat reconcile
 * never crosses tenants when removing an orphan row.
 */
async function _sqliteSoftDeleteMasterSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  // 走 SQLite backend 自身的 delete(自洽);PG backend 的 softDelete 同样委托其自身 delete。
  return _sqliteDeleteClientSession(sessionId, userId)
}

/** Claim an unclaimed session: atomically change user_id from 'default' to the target userId.
 *  Returns true if claimed, false if already claimed by someone else. */
async function _sqliteClaimSession(sessionId: string, userId: string): Promise<boolean> {
  const db = await getSessionsDb()
  // updated_at 逻辑版本(RFC D3b):MAX(既有+1, now) 严格单调推进(认领改归属也 bump 版本)。
  const result = db.prepare(`
    UPDATE client_sessions SET user_id = ?, updated_at = MAX(updated_at + 1, ?)
    WHERE id = ? AND user_id = 'default' AND deleted_at IS NULL
  `).run(userId, Date.now(), sessionId)
  return result.changes > 0
}

// ════════════════════════════════════════════════════════════════════════════
// master 会话权威 backend —— 委托层(RFC D1)
// ════════════════════════════════════════════════════════════════════════════
//
// 单一权威、零双轨、调用点零改动:master 六表(client_sessions / archive_chunks /
// archived_ids / server_authored_request_map / pending_usage_patches / wechat_bindings)的
// 每个导出函数保持签名不变,内部改为委托 `getActiveBackend().xxx(...)`。
//
// 默认 backend = 本文件内的 SQLite 实现(sqliteBackend,由上面 _sqlite* 组合)。master 形态
// (channel=v5 且非容器)在 composition root 一次性 setClientSessionsBackend(pgBackend) 注入
// PG 实现;容器内 gateway / 个人版不加载 commercial → 天然 SQLite,行为零变化。
//
// **非 master 表函数(sessions_meta / fts / event_log / usage_log / outbox:upsertSessionMeta /
// indexTurn / searchSessions / insertEvent / queryEvents / insertUsageLog / getUsageSummary /
// queueMessageToOutbox / appendServerAuthoredMessageDurable / replayMsgOutbox 等)不进 backend**,
// 永远直连本地 SQLite(master 上是审计/召回旁路,权威在容器侧,fire-and-forget)。

/**
 * SQLite backend —— master 六表全部操作的本地实现(由上方 _sqlite* / wechatBindings 的
 * _sqlite* 组合)。既是默认 backend,又是 {@link ClientSessionsBackend} 契约的**派生源**:
 * PG backend 必须结构化覆盖本对象的每个方法(漏一个 = 编译错)。
 */
const sqliteBackend = {
  // ── client_sessions 读写 + 归档 + usage 聚合 ──
  probeSessionsDb: _sqliteProbeSessionsDb,
  upsertClientSession: _sqliteUpsertClientSession,
  appendServerAuthoredMessage: _sqliteAppendServerAuthoredMessage,
  appendServerAuthoredMessageForRequest: _sqliteAppendServerAuthoredMessageForRequest,
  appendServerAuthoredMessageDrainByUser: _sqliteAppendServerAuthoredMessageDrainByUser,
  appendCostCredits: _sqliteAppendCostCredits,
  drainDelegateCostForClientSession: _sqliteDrainDelegateCostForClientSession,
  sweepUsageAggregationGc: _sqliteSweepUsageAggregationGc,
  listClientSessions: _sqliteListClientSessions,
  getClientSession: _sqliteGetClientSession,
  classifyClientSessions: _sqliteClassifyClientSessions,
  getClientSessionPartial: _sqliteGetClientSessionPartial,
  readArchivedMessages: _sqliteReadArchivedMessages,
  deleteClientSession: _sqliteDeleteClientSession,
  renameClientSession: _sqliteRenameClientSession,
  listUnclaimedSessions: _sqliteListUnclaimedSessions,
  allMasterWsessRows: _sqliteAllMasterWsessRows,
  upsertMasterClientSession: _sqliteUpsertMasterClientSession,
  softDeleteMasterSession: _sqliteSoftDeleteMasterSession,
  claimSession: _sqliteClaimSession,
  // ── wechat_bindings(master 六表之一;SQLite 实现在 wechatBindings.ts)──
  listActiveWechatBindings: _sqliteListActiveWechatBindings,
  listAllWechatBindings: _sqliteListAllWechatBindings,
  getWechatBindingByUserId: _sqliteGetWechatBindingByUserId,
  getWechatBindingByAccountId: _sqliteGetWechatBindingByAccountId,
  upsertWechatBinding: _sqliteUpsertWechatBinding,
  updateWechatBindingCursor: _sqliteUpdateWechatBindingCursor,
  updateWechatBindingStatus: _sqliteUpdateWechatBindingStatus,
  deleteWechatBinding: _sqliteDeleteWechatBinding,
}

/**
 * master 会话权威 backend 契约。**从 sqliteBackend 派生**(不手写接口):PG backend 在
 * packages/commercial 里 `const pg: ClientSessionsBackend = {...}`,TypeScript 强制它完整覆盖
 * 上面每个方法与签名 —— 漏一个方法 / 签名不符 = 编译期报错,杜绝 PG 侧漏实现。
 */
export type ClientSessionsBackend = typeof sqliteBackend

let _activeBackend: ClientSessionsBackend = sqliteBackend
let _backendInjected = false

/**
 * 一次性注入 master 会话权威 backend(composition root 唯一入口)。重复注入 throw ——
 * 防两处 registerCommercial / 双跑把权威源改成两套。正常代码回滚**不能**通过不注入退回
 * SQLite(那会在割接后重造双权威,RFC D1 fail-closed);SQLite 默认仅用于容器/个人版形态。
 */
export function setClientSessionsBackend(b: ClientSessionsBackend): void {
  if (_backendInjected) {
    throw new Error('client sessions backend already injected — 一次性注入,禁止双跑')
  }
  _activeBackend = b
  _backendInjected = true
}

/**
 * 当前活跃 backend。master 表的公有函数(本文件 + wechatBindings.ts)全部经此委托。
 * 未注入 → 默认 sqliteBackend(容器/个人版形态,行为零变化)。
 */
export function getActiveBackend(): ClientSessionsBackend {
  return _activeBackend
}

// ── 公有 API:薄委托 active backend ──────────────────────────────────────────
//
// 签名从 sqliteBackend 派生(ClientSessionsBackend['xxx'] = 对应 _sqlite* 的类型),与旧导出
// 逐字节等价,调用点(gateway/server.ts、commercial)按函数名 import,零改动。

export const probeSessionsDb: ClientSessionsBackend['probeSessionsDb'] =
  () => getActiveBackend().probeSessionsDb()

export const upsertClientSession: ClientSessionsBackend['upsertClientSession'] =
  (...args) => getActiveBackend().upsertClientSession(...args)

export const appendServerAuthoredMessage: ClientSessionsBackend['appendServerAuthoredMessage'] =
  (...args) => getActiveBackend().appendServerAuthoredMessage(...args)

export const appendServerAuthoredMessageForRequest: ClientSessionsBackend['appendServerAuthoredMessageForRequest'] =
  (...args) => getActiveBackend().appendServerAuthoredMessageForRequest(...args)

// 泛型 message 需显式泛型 wrapper 才能保住类型推断(indexed-access 的泛型调用签名无法用
// rest-arrow 完美转发)。
export async function appendServerAuthoredMessageDrainByUser<T extends MessageLike & { id: string }>(
  sessId: string,
  userId: string,
  message: T,
  agentSessionId?: string | null,
): Promise<AppendForRequestResult> {
  return getActiveBackend().appendServerAuthoredMessageDrainByUser(sessId, userId, message, agentSessionId)
}

export const appendCostCredits: ClientSessionsBackend['appendCostCredits'] =
  (...args) => getActiveBackend().appendCostCredits(...args)

export const drainDelegateCostForClientSession: ClientSessionsBackend['drainDelegateCostForClientSession'] =
  (...args) => getActiveBackend().drainDelegateCostForClientSession(...args)

export const sweepUsageAggregationGc: ClientSessionsBackend['sweepUsageAggregationGc'] =
  (...args) => getActiveBackend().sweepUsageAggregationGc(...args)

export const listClientSessions: ClientSessionsBackend['listClientSessions'] =
  (...args) => getActiveBackend().listClientSessions(...args)

export const getClientSession: ClientSessionsBackend['getClientSession'] =
  (...args) => getActiveBackend().getClientSession(...args)

export const classifyClientSessions: ClientSessionsBackend['classifyClientSessions'] =
  (...args) => getActiveBackend().classifyClientSessions(...args)

export const getClientSessionPartial: ClientSessionsBackend['getClientSessionPartial'] =
  (...args) => getActiveBackend().getClientSessionPartial(...args)

export const readArchivedMessages: ClientSessionsBackend['readArchivedMessages'] =
  (...args) => getActiveBackend().readArchivedMessages(...args)

export const deleteClientSession: ClientSessionsBackend['deleteClientSession'] =
  (...args) => getActiveBackend().deleteClientSession(...args)

export const renameClientSession: ClientSessionsBackend['renameClientSession'] =
  (...args) => getActiveBackend().renameClientSession(...args)

export const listUnclaimedSessions: ClientSessionsBackend['listUnclaimedSessions'] =
  () => getActiveBackend().listUnclaimedSessions()

export const allMasterWsessRows: ClientSessionsBackend['allMasterWsessRows'] =
  () => getActiveBackend().allMasterWsessRows()

export const upsertMasterClientSession: ClientSessionsBackend['upsertMasterClientSession'] =
  (...args) => getActiveBackend().upsertMasterClientSession(...args)

export const softDeleteMasterSession: ClientSessionsBackend['softDeleteMasterSession'] =
  (...args) => getActiveBackend().softDeleteMasterSession(...args)

export const claimSession: ClientSessionsBackend['claimSession'] =
  (...args) => getActiveBackend().claimSession(...args)

export async function closeSessionsDb(): Promise<void> {
  if (_walTimer !== null) { clearInterval(_walTimer); _walTimer = null }
  process.removeListener('exit', _onExit)
  if (_db) {
    try { _db.pragma('wal_checkpoint(TRUNCATE)'); _db.close() } catch {}
    _db = null
  }
}
