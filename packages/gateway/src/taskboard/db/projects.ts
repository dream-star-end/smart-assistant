// Project DAO — 项目的 CRUD。
//
// key 创建后冻结(identifier 前缀依赖它)。next_ticket_seq 是内部计数器,
// 不映射到 Project 实体。归档只写 archived_at,不做物理删除(单据还在)。

import { parseProjectWorkspace, type ProjectWorkspace } from '@openclaude/storage'
import type { Project } from '../domain.js'
import {
  type TaskboardDb,
  TaskboardNotFound,
  newId,
  normalizeProjectKey,
  nowMs,
  parseJsonArray,
  stringifyJsonArray,
} from './schema.js'

interface ProjectRow {
  id: string
  key: string
  name: string
  description: string | null
  workspace: string | null
  workspace_json: string | null
  context_version: number | null
  labels: string
  archived_at: number | null
  created_at: number
  updated_at: number
}

function mapWorkspaceSpec(raw: string | null): Project['workspaceSpec'] {
  if (!raw) return null
  try {
    return parseProjectWorkspace(JSON.parse(raw))
  } catch {
    return parseProjectWorkspace(raw)
  }
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    workspace: row.workspace,
    workspaceSpec: mapWorkspaceSpec(row.workspace_json),
    contextVersion: Number(row.context_version) || 0,
    labels: parseJsonArray(row.labels),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const PROJECT_COLS = `
  id, key, name, description, workspace, workspace_json, context_version, labels, archived_at, created_at, updated_at
`

export interface CreateProjectInput {
  key: string
  name: string
  description?: string | null
  workspace?: string | null
  workspaceSpec?: ProjectWorkspace | null
  labels?: string[]
}

export interface UpdateProjectInput {
  name?: string
  description?: string | null
  workspace?: string | null
  workspaceSpec?: ProjectWorkspace | null
  labels?: string[]
  archivedAt?: number | null
}

export function createProject(db: TaskboardDb, input: CreateProjectInput): Project {
  const now = nowMs()
  const id = newId()
  const key = normalizeProjectKey(input.key)
  db.prepare(
    `INSERT INTO tb_project (
       id, key, name, description, workspace, workspace_json, context_version, labels,
       archived_at, created_at, updated_at, next_ticket_seq
     ) VALUES (
       @id, @key, @name, @description, @workspace, @workspaceJson, 0, @labels,
       NULL, @now, @now, 0
     )`,
  ).run({
    id,
    key,
    name: input.name,
    description: input.description ?? null,
    workspace: input.workspace ?? null,
    workspaceJson: input.workspaceSpec ? JSON.stringify(input.workspaceSpec) : null,
    labels: stringifyJsonArray(input.labels ?? []),
    now,
  })
  return getProject(db, id) as Project
}

export function getProject(db: TaskboardDb, id: string): Project | null {
  const row = db.prepare(`SELECT ${PROJECT_COLS} FROM tb_project WHERE id = ?`).get(id) as
    | ProjectRow
    | undefined
  return row ? mapProject(row) : null
}

export function getProjectByKey(db: TaskboardDb, key: string): Project | null {
  const row = db
    .prepare(`SELECT ${PROJECT_COLS} FROM tb_project WHERE key = ?`)
    .get(key.trim().toUpperCase()) as ProjectRow | undefined
  return row ? mapProject(row) : null
}

export function listProjects(db: TaskboardDb, opts: { includeArchived?: boolean } = {}): Project[] {
  const sql = opts.includeArchived
    ? `SELECT ${PROJECT_COLS} FROM tb_project ORDER BY created_at ASC`
    : `SELECT ${PROJECT_COLS} FROM tb_project WHERE archived_at IS NULL ORDER BY created_at ASC`
  const rows = db.prepare(sql).all() as ProjectRow[]
  return rows.map(mapProject)
}

export function updateProject(db: TaskboardDb, id: string, input: UpdateProjectInput): Project {
  const existing = getProject(db, id)
  if (!existing) throw new TaskboardNotFound('project', id)
  const now = nowMs()
  db.prepare(
    `UPDATE tb_project SET
       name = @name,
       description = @description,
       workspace = @workspace,
       workspace_json = @workspaceJson,
       labels = @labels,
       archived_at = @archivedAt,
       updated_at = @now
     WHERE id = @id`,
  ).run({
    id,
    name: input.name ?? existing.name,
    description: input.description === undefined ? existing.description : input.description,
    workspace: input.workspace === undefined ? existing.workspace : input.workspace,
    workspaceJson:
      input.workspaceSpec === undefined
        ? (existing.workspaceSpec ? JSON.stringify(existing.workspaceSpec) : null)
        : input.workspaceSpec
          ? JSON.stringify(input.workspaceSpec)
          : null,
    labels: stringifyJsonArray(input.labels ?? existing.labels),
    archivedAt: input.archivedAt === undefined ? existing.archivedAt : input.archivedAt,
    now,
  })
  return getProject(db, id) as Project
}

export function archiveProject(db: TaskboardDb, id: string): Project {
  return updateProject(db, id, { archivedAt: nowMs() })
}
