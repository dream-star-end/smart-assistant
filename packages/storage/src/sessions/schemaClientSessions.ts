import type Database from 'better-sqlite3'
import { logMigrationFailure } from './schemaCore.js'

function getTableColumns(db: Database.Database, table: string): Set<string> {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  return new Set(cols.map((c) => c.name))
}

function runOptionalMigration(step: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    logMigrationFailure(step, err)
  }
}

function ensureClientSessionsBase(db: Database.Database): void {
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
      history_revision INTEGER NOT NULL DEFAULT 0,
      timeline_generation INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_client_sessions_last ON client_sessions(last_at);
    CREATE INDEX IF NOT EXISTS idx_client_sessions_user ON client_sessions(user_id);
  `)
}

function migrateClientSessionsCoreColumns(db: Database.Database): void {
  const cols = getTableColumns(db, 'client_sessions')
  if (!cols.has('user_id')) {
    runOptionalMigration('client_sessions add user_id', () => {
      db.exec("ALTER TABLE client_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'")
      db.exec('CREATE INDEX IF NOT EXISTS idx_client_sessions_user ON client_sessions(user_id)')
    })
  }
  if (!cols.has('deleted_at')) {
    runOptionalMigration('client_sessions add deleted_at', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN deleted_at INTEGER DEFAULT NULL')
      db.exec("UPDATE client_sessions SET deleted_at = updated_at WHERE title = '__deleted__'")
    })
  }
  if (!cols.has('timeline_generation')) {
    runOptionalMigration('client_sessions add timeline_generation', () => {
      db.exec(
        'ALTER TABLE client_sessions ADD COLUMN timeline_generation INTEGER NOT NULL DEFAULT 1',
      )
    })
  }
  if (!cols.has('history_revision')) {
    runOptionalMigration('client_sessions add history_revision', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0')
    })
  }
  if (!cols.has('message_count')) {
    runOptionalMigration('client_sessions add message_count', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0')
      db.exec('UPDATE client_sessions SET message_count = COALESCE(json_array_length(messages), 0)')
    })
  }
}

function migrateClientSessionsExtraColumns(db: Database.Database): void {
  const cols = getTableColumns(db, 'client_sessions')
  if (!cols.has('next_seq')) {
    runOptionalMigration('client_sessions add next_seq', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1')
    })
  }
  if (!cols.has('origin_channel')) {
    runOptionalMigration('client_sessions add origin_channel', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN origin_channel TEXT DEFAULT NULL')
    })
  }
  if (!cols.has('model_id')) {
    runOptionalMigration('client_sessions add model_id', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN model_id TEXT DEFAULT NULL')
    })
  }
  if (!cols.has('project_id')) {
    runOptionalMigration('client_sessions add project_id', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN project_id TEXT DEFAULT NULL')
    })
  }
  if (!cols.has('archived_at')) {
    runOptionalMigration('client_sessions add archived_at', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN archived_at INTEGER DEFAULT NULL')
    })
  }
  if (!cols.has('last_read_at')) {
    runOptionalMigration('client_sessions add last_read_at', () => {
      db.exec('ALTER TABLE client_sessions ADD COLUMN last_read_at INTEGER DEFAULT NULL')
      db.exec('UPDATE client_sessions SET last_read_at = last_at WHERE last_read_at IS NULL')
    })
  }
}

function ensureChatProjectsAndAssets(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      instructions TEXT,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_projects_user_deleted
      ON chat_projects(user_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_client_sessions_user_project
      ON client_sessions(user_id, project_id);
  `)
  runOptionalMigration('chat_projects extra columns', () => {
    const projCols = getTableColumns(db, 'chat_projects')
    if (!projCols.has('board_project_id')) {
      db.exec('ALTER TABLE chat_projects ADD COLUMN board_project_id TEXT DEFAULT NULL')
    }
    if (!projCols.has('is_research_default')) {
      db.exec('ALTER TABLE chat_projects ADD COLUMN is_research_default INTEGER NOT NULL DEFAULT 0')
    }
    if (!projCols.has('archived_at')) {
      db.exec('ALTER TABLE chat_projects ADD COLUMN archived_at INTEGER DEFAULT NULL')
    }
    if (!projCols.has('pinned_at')) {
      db.exec('ALTER TABLE chat_projects ADD COLUMN pinned_at INTEGER DEFAULT NULL')
    }
    if (!projCols.has('template')) {
      db.exec('ALTER TABLE chat_projects ADD COLUMN template TEXT DEFAULT NULL')
    }
    if (!projCols.has('deleted_manifest')) {
      db.exec('ALTER TABLE chat_projects ADD COLUMN deleted_manifest TEXT DEFAULT NULL')
    }
  })
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_projects_user_board
      ON chat_projects(user_id, board_project_id)
      WHERE deleted_at IS NULL AND board_project_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_projects_user_research_default
      ON chat_projects(user_id)
      WHERE is_research_default = 1 AND deleted_at IS NULL;
  `)
  // 软删只删索引行,绝不删磁盘文件:文件是 sha256 内容寻址的,可能被别的消息/资产共用。
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_assets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('upload', 'output')),
      session_id TEXT,
      name TEXT NOT NULL,
      url TEXT,
      container_path TEXT,
      mime TEXT,
      size_bytes INTEGER,
      digest TEXT,
      excerpt TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      CHECK (
        (url IS NOT NULL AND length(url) > 0)
        OR (container_path IS NOT NULL AND length(container_path) > 0)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_project_assets_user_project_created
      ON project_assets(user_id, project_id, deleted_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_assets_user_project_pinned
      ON project_assets(user_id, project_id, pinned)
      WHERE deleted_at IS NULL AND pinned = 1;
    CREATE INDEX IF NOT EXISTS idx_project_assets_user_digest
      ON project_assets(user_id, digest);
    CREATE INDEX IF NOT EXISTS idx_client_sessions_user_list
      ON client_sessions(user_id, last_at DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_client_sessions_user_list_active
      ON client_sessions(user_id, last_at DESC)
      WHERE deleted_at IS NULL AND archived_at IS NULL;
  `)
}

function ensureArchiveAndWechatTables(db: Database.Database): void {
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
  runOptionalMigration('client_sessions archive watermark columns', () => {
    const cols = getTableColumns(db, 'client_sessions')
    if (!cols.has('archived_through_seq')) {
      db.exec(
        'ALTER TABLE client_sessions ADD COLUMN archived_through_seq INTEGER NOT NULL DEFAULT 0',
      )
    }
    if (!cols.has('archived_count')) {
      db.exec('ALTER TABLE client_sessions ADD COLUMN archived_count INTEGER NOT NULL DEFAULT 0')
    }
  })
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_csa_chunks_last
      ON client_session_archive_chunks(session_id, last_seq);

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
}

function ensureUsageAggregationTables(db: Database.Database): void {
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
      parent_session_id TEXT,
      delegate_agent_id TEXT,
      turn_key TEXT,
      parent_turn_key TEXT,
      cost_credits TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000),
      PRIMARY KEY (request_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pup_created ON pending_usage_patches(created_at);
    CREATE INDEX IF NOT EXISTS idx_pup_user ON pending_usage_patches(user_id);
  `)
  runOptionalMigration('pending_usage_patches extra columns', () => {
    const cols = getTableColumns(db, 'pending_usage_patches')
    if (!cols.has('parent_session_id')) {
      db.exec('ALTER TABLE pending_usage_patches ADD COLUMN parent_session_id TEXT')
    }
    if (!cols.has('delegate_agent_id')) {
      db.exec('ALTER TABLE pending_usage_patches ADD COLUMN delegate_agent_id TEXT')
    }
    if (!cols.has('turn_key')) {
      db.exec('ALTER TABLE pending_usage_patches ADD COLUMN turn_key TEXT')
    }
    if (!cols.has('parent_turn_key')) {
      db.exec('ALTER TABLE pending_usage_patches ADD COLUMN parent_turn_key TEXT')
    }
  })
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pup_parent
       ON pending_usage_patches(user_id, parent_session_id)
       WHERE parent_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pup_user_turn_key
      ON pending_usage_patches(user_id, turn_key) WHERE turn_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pup_user_parent_turn_key
      ON pending_usage_patches(user_id, parent_turn_key) WHERE parent_turn_key IS NOT NULL;
  `)
}

function ensureTurnDispatchInboxAndWatermark(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_dispatch_inbox (
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','recovery_pending','sink_staged','sink_stage_failed','terminal','rejected')),
      outcome TEXT CHECK (outcome IN ('completed','interrupted','crashed','not_accepted')),
      agent_id TEXT,
      turn_index INTEGER,
      turn_key TEXT,
      request_id TEXT,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, session_id, client_message_id),
      UNIQUE (dispatch_id, attempt_no)
    );
    CREATE INDEX IF NOT EXISTS idx_tdi_open ON turn_dispatch_inbox(state)
      WHERE state NOT IN ('terminal','rejected');
  `)
  const inboxCols = getTableColumns(db, 'turn_dispatch_inbox')
  if (!inboxCols.has('user_failure_code')) {
    db.exec('ALTER TABLE turn_dispatch_inbox ADD COLUMN user_failure_code TEXT')
  }
  runOptionalMigration('client_sessions last_read_at watermark 241', () => {
    const uvRow = db.pragma('user_version') as Array<{ user_version: number }>
    const uv = Number(uvRow[0]?.user_version ?? 0)
    if (uv < 241) {
      db.exec(`
        UPDATE client_sessions
           SET last_read_at = MAX(
                 COALESCE(last_read_at, 0),
                 COALESCE((
                   SELECT MAX(updated_at) FROM turn_dispatch_inbox
                    WHERE session_id = client_sessions.id
                      AND state IN ('terminal', 'rejected')
                 ), 0)
               )
      `)
      db.pragma('user_version = 241')
    }
  })
}

export function ensureClientSessionsSchema(db: Database.Database): void {
  ensureClientSessionsBase(db)
  migrateClientSessionsCoreColumns(db)
  migrateClientSessionsExtraColumns(db)
  ensureChatProjectsAndAssets(db)
  ensureArchiveAndWechatTables(db)
  ensureUsageAggregationTables(db)
  ensureTurnDispatchInboxAndWatermark(db)
}
