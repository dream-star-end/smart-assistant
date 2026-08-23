// Taskboard SQLite schema — 表结构与可辨识错误类型。
//
// 设计意图:
//   独立库 `taskboard.db`(与 sessions.db 同目录),表名一律 `tb_` 前缀,避免撞
//   sessions.db 里已有的 sessions_meta / usage_log / client_sessions 等。
//   字段一一对齐冻结的 domain.ts 实体;时间戳全部 epoch 毫秒整数。
//   labels / toolsets 这类数组落 JSON TEXT,由 DAO 序列化,禁止把 JSON 字符串
//   泄漏给上层。
//
// 迁移:
//   没有独立 migrations/ 目录(容器 SQLite 的既有范本是 sessionsDb.ts 的
//   CREATE IF NOT EXISTS + PRAGMA table_info)。这里用 PRAGMA user_version
//   做版本号,v1 建全表;后续加列走 `if (user_version < N) ALTER TABLE …`,
//   重复调用 migrate 只读版本、不重复建表。
//
// identifier 分配:
//   tb_project.next_ticket_seq 是 per-project 单调计数器。选计数器而不是
//   MAX(seq)+1,是因为删单后 MAX 会回退重号,且解析 identifier 易碎。计数器
//   在 BEGIN IMMEDIATE 事务里 +1,UNIQUE(identifier) 兜底。
//
// 坑:
//   - next_ticket_seq 是内部列,不出现在 Project 接口里,不要 SELECT * 直接
//     当实体返回。
//   - 必须 PRAGMA foreign_keys=ON,否则 relation 的 REFERENCES 是空约束。
//   - 乐观锁只活在 tb_ticket.version;其它表没有 version。

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type TaskboardDb = Database.Database

/** 当前 schema 版本。加列时递增,并在 migrate() 里补一段 < N 的 ALTER。 */
export const TASKBOARD_SCHEMA_VERSION = 4

/** 项目 key:大写字母开头,2–12 位 [A-Z0-9]。创建后冻结。 */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,11}$/

export const TASKBOARD_DDL_V1 = `
CREATE TABLE IF NOT EXISTS tb_project (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  workspace TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_ticket_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tb_pipeline (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES tb_project(id),
  name TEXT NOT NULL,
  ticket_type TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 同一项目同一单据类型只能有一条默认流水线。DAO 已在事务里降级旧默认线,这条索引
-- 是兜底:直写 SQL 或将来新增写路径绕过 DAO 时,数据库自己拦住。ticket_type 可为
-- NULL(通用兜底线),而 SQLite 的 UNIQUE 认为多个 NULL 互不相等,所以必须 COALESCE
-- 成空串再参与唯一性,否则通用线可以存在多条默认。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tb_pipeline_single_default
  ON tb_pipeline(project_id, COALESCE(ticket_type, '')) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS tb_pipeline_stage (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES tb_pipeline(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT,
  prompt_template TEXT,
  toolsets TEXT,
  effort TEXT,
  patrol_cron TEXT,
  patrol_enabled INTEGER NOT NULL DEFAULT 0,
  patrol_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  quiet_hours_start INTEGER,
  quiet_hours_end INTEGER,
  max_runs_per_day INTEGER NOT NULL,
  timeout_sec INTEGER NOT NULL,
  max_retries INTEGER NOT NULL DEFAULT 0,
  circuit_breaker_threshold INTEGER NOT NULL,
  on_success TEXT NOT NULL,
  on_failure TEXT NOT NULL,
  entry_condition TEXT,
  exit_checklist TEXT,
  require_human_ack INTEGER NOT NULL DEFAULT 0,
  auto_close INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pipeline_id, ordinal)
);

CREATE TABLE IF NOT EXISTS tb_ticket (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES tb_project(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  stage_id TEXT,
  pipeline_id TEXT,
  priority TEXT NOT NULL,
  severity TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  assignee TEXT,
  reporter TEXT NOT NULL,
  source TEXT NOT NULL,
  origin_session_key TEXT,
  due_date INTEGER,
  start_date INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  blocked_reason TEXT,
  stage_loop_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tb_ticket_status_stage ON tb_ticket(status, stage_id);
CREATE INDEX IF NOT EXISTS idx_tb_ticket_project ON tb_ticket(project_id);

CREATE TABLE IF NOT EXISTS tb_ticket_run (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tb_ticket(id),
  stage_id TEXT NOT NULL,
  agent_id TEXT,
  trigger TEXT NOT NULL,
  session_key TEXT,
  status TEXT NOT NULL,
  skip_reason TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  summary TEXT,
  output_md TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tb_ticket_run_ticket_created
  ON tb_ticket_run(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tb_ticket_run_stage_status
  ON tb_ticket_run(stage_id, status);

CREATE TABLE IF NOT EXISTS tb_ticket_relation (
  id TEXT PRIMARY KEY,
  from_ticket_id TEXT NOT NULL REFERENCES tb_ticket(id),
  to_ticket_id TEXT NOT NULL REFERENCES tb_ticket(id),
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (from_ticket_id, to_ticket_id, kind)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tb_rel_single_parent
  ON tb_ticket_relation(from_ticket_id) WHERE kind = 'parent';

CREATE TABLE IF NOT EXISTS tb_ticket_comment (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tb_ticket(id),
  author_kind TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tb_ticket_activity (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tb_ticket(id),
  actor TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  field TEXT,
  from_value TEXT,
  to_value TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tb_ticket_activity_ticket_created
  ON tb_ticket_activity(ticket_id, created_at);

-- 全局护栏运行时配置。单行表(id 恒为 'global')。T3 曾旁路建在 http.ts,
-- 现并进 V1:目前没有任何已部署的库,不必写 ALTER。
CREATE TABLE IF NOT EXISTS tb_settings (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  max_concurrent_runs INTEGER NOT NULL,
  max_runs_per_day INTEGER NOT NULL,
  max_cost_per_day_usd REAL,
  quiet_hours_start INTEGER NOT NULL,
  quiet_hours_end INTEGER NOT NULL,
  circuit_breaker_threshold INTEGER NOT NULL,
  max_stage_loops INTEGER NOT NULL,
  max_runs_per_tick INTEGER NOT NULL,
  patrol_paused INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`

/**
 * v2:自定义流水线模板。内置四条(bug/feature/spike/chore)仍以 seed.ts 为唯一真源,
 * 不写入本表,避免和种子分叉。本表只存用户从已有流水线快照出来的自定义模板。
 * CREATE IF NOT EXISTS,对已有 v1 库向前兼容,不改已有表、不碰已有行。
 */
export const TASKBOARD_DDL_V2 = `
CREATE TABLE IF NOT EXISTS tb_pipeline_template (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ticket_type TEXT,
  stages_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

// ── 可辨识错误(供 HTTP 层映射 409 / 404 / 403 / 422)────────────────────────

export class TaskboardError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

/** ticket.version 不匹配。HTTP 转 409。 */
export class TaskboardVersionConflict extends TaskboardError {
  readonly ticketId: string
  readonly expectedVersion: number
  readonly actualVersion: number
  constructor(ticketId: string, expectedVersion: number, actualVersion: number) {
    super(
      'version_conflict',
      `ticket ${ticketId} version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
    )
    this.ticketId = ticketId
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
  }
}

export class TaskboardNotFound extends TaskboardError {
  readonly entity: string
  readonly entityId: string
  constructor(entity: string, entityId: string) {
    super('not_found', `${entity} ${entityId} not found`)
    this.entity = entity
    this.entityId = entityId
  }
}

/** 该 ticket 已有未过期 lease。HTTP 可转 423 或 409。 */
export class TaskboardLeaseHeld extends TaskboardError {
  readonly ticketId: string
  readonly owner: string
  readonly expiresAt: number
  constructor(ticketId: string, owner: string, expiresAt: number) {
    super('lease_held', `ticket ${ticketId} lease held by ${owner} until ${expiresAt}`)
    this.ticketId = ticketId
    this.owner = owner
    this.expiresAt = expiresAt
  }
}

export class TaskboardCrossProjectError extends TaskboardError {
  constructor(fromTicketId: string, toTicketId: string) {
    super('cross_project', `relation cannot cross projects (${fromTicketId} → ${toTicketId})`)
  }
}

export class TaskboardCycleError extends TaskboardError {
  readonly kind: string
  constructor(kind: string) {
    super('cycle', `${kind} relation would create a cycle`)
    this.kind = kind
  }
}

export class TaskboardSingleParentError extends TaskboardError {
  readonly ticketId: string
  constructor(ticketId: string) {
    super('single_parent', `ticket ${ticketId} already has a parent`)
    this.ticketId = ticketId
  }
}

export class TaskboardDuplicateRelationError extends TaskboardError {
  constructor() {
    super('duplicate_relation', 'relation already exists')
  }
}

export class TaskboardValidationError extends TaskboardError {
  constructor(message: string) {
    super('validation', message)
  }
}

export function isTaskboardError(err: unknown): err is TaskboardError {
  return err instanceof TaskboardError
}

// ── 内部工具(DAO 共用,不 export 到 HTTP)────────────────────────────────────

export function nowMs(): number {
  return Date.now()
}

export function newId(): string {
  return randomUUID()
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (raw == null || raw === '') return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

export function parseJsonArrayOrNull(raw: string | null | undefined): string[] | null {
  if (raw == null) return null
  return parseJsonArray(raw)
}

export function stringifyJsonArray(arr: readonly string[]): string {
  return JSON.stringify(arr)
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0
}

export function intToBool(value: number | boolean): boolean {
  return value === 1 || value === true
}

export function normalizeProjectKey(key: string): string {
  const normalized = key.trim().toUpperCase()
  if (!PROJECT_KEY_RE.test(normalized)) {
    throw new TaskboardValidationError(`invalid project key '${key}': must match ${PROJECT_KEY_RE}`)
  }
  return normalized
}
