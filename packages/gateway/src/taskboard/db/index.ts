// Taskboard SQLite handle — 打开库、跑迁移、导出单例。
//
// 照抄 packages/storage/src/sessionsDb.ts 的开库范本:
//   better-sqlite3 + busy_timeout=10000 + journal_mode=WAL + 30min
//   wal_checkpoint(TRUNCATE) + process.exit 关库。
// 路径与 sessions.db 同目录:`${OPENCLAUDE_HOME ?? ~/.openclaude}/taskboard.db`。
// 当前 paths.ts 还没有 taskboardDb 字段(不在本任务清单),这里按同一 HOME
// 规则本地拼接;后续应在 paths.ts 加一行做成单一权威。
//
// 测试必须传入显式路径(临时目录),禁止打到真实 ~/.openclaude。
// 单例 getTaskboardDb() 只给生产 / gateway 启动用。
//
// 坑:
//   - 每个 open 都跑 migrate,依赖 user_version 幂等,不要在外面再 exec 一遍 DDL。
//   - 测试库不要挂 process.exit / setInterval,否则 test runner 退不出去。
//   - ESM 下 paths 在 import 时就读 OPENCLAUDE_HOME,测试里后改 env 无效。

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { TASKBOARD_DDL_V1, TASKBOARD_SCHEMA_VERSION, type TaskboardDb } from './schema.js'

export * from './schema.js'
export * from './projects.js'
export * from './tickets.js'
export * from './pipelines.js'
export * from './runs.js'
export * from './relations.js'
export * from './comments.js'
export * from './activity.js'
export * from './seed.js'

let _db: TaskboardDb | null = null
let _walTimer: ReturnType<typeof setInterval> | null = null

export function resolveTaskboardDbPath(): string {
  // 与 packages/storage/src/paths.ts 的 HOME 规则对齐;paths.ts 加
  // taskboardDb 之前先本地拼,避免本包去 import storage 触发工程引用。
  const home = process.env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')
  return join(home, 'taskboard.db')
}

/**
 * 按 user_version 往前推。v1 建全表;更高版本后续加 ALTER。
 * 重复调用安全:已达当前版本则直接返回。
 */
export function migrate(db: TaskboardDb): void {
  const current = Number(db.pragma('user_version', { simple: true }) ?? 0)
  if (current >= TASKBOARD_SCHEMA_VERSION) return

  const apply = db.transaction(() => {
    if (current < 1) {
      db.exec(TASKBOARD_DDL_V1)
    }
    db.pragma(`user_version = ${TASKBOARD_SCHEMA_VERSION}`)
  })
  apply()
}

export function getSchemaVersion(db: TaskboardDb): number {
  return Number(db.pragma('user_version', { simple: true }) ?? 0)
}

export interface OpenTaskboardDbOptions {
  /** 生产单例才挂 WAL 定时器与 process.exit。测试保持 false。 */
  persistent?: boolean
}

export function openTaskboardDb(dbPath: string, opts: OpenTaskboardDbOptions = {}): TaskboardDb {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 10000')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)

  if (opts.persistent) {
    attachPersistentHooks(db)
  }
  return db
}

function attachPersistentHooks(db: TaskboardDb): void {
  if (_walTimer !== null) {
    clearInterval(_walTimer)
    _walTimer = null
  }
  _walTimer = setInterval(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* 关库窗口里 checkpoint 失败可忽略 */
    }
  }, 30 * 60_000)
  _walTimer.unref()
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* 首次 checkpoint 失败不阻断启动 */
  }
  process.on('exit', closeTaskboardDb)
}

/** 生产单例。测试请用 openTaskboardDb(临时路径)。 */
export function getTaskboardDb(): TaskboardDb {
  if (_db) return _db
  _db = openTaskboardDb(resolveTaskboardDbPath(), { persistent: true })
  return _db
}

export function closeTaskboardDb(): void {
  if (_walTimer !== null) {
    clearInterval(_walTimer)
    _walTimer = null
  }
  if (!_db) return
  try {
    _db.pragma('wal_checkpoint(TRUNCATE)')
    _db.close()
  } catch {
    /* 进程退出路径,关库失败不再抛 */
  }
  _db = null
}
