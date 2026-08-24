#!/usr/bin/env tsx
/**
 * OCV5 project-layer migration coordinator CLI.
 * Default is dry-run. --apply is refused unless OPENCLAUDE_PROJECT_LAYER_APPLY=1
 * (this phase never sets that; live write is out of scope).
 *
 *   npx tsx packages/commercial/scripts/migrate-ocv5-project-layer.ts \
 *     --inventory /path/inventory.json \
 *     --target 852859fa-cf1d-481c-96fd-23f2966b8b5f \
 *     --dry-run \
 *     --out /path/dry-run.json
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import {
  OCV5_DEFAULT_BOARD_ID,
  planProjectLayerMigration,
  type LiveBoardProject,
  type LiveSessionSnapshot,
  type ProjectLayerInventory,
  type ProjectLayerLivePorts,
} from '../../storage/src/projectLayerMigrate.ts'

function arg(argv: string[], name: string, fallback = ''): string {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const pref = `${name}=`
  const hit = argv.find((a) => a.startsWith(pref))
  return hit ? hit.slice(pref.length) : fallback
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name)
}

const argv = process.argv
if (has(argv, '--apply')) {
  if (process.env.OPENCLAUDE_PROJECT_LAYER_APPLY !== '1') {
    console.error('refuse --apply: this phase is dry-run only (OPENCLAUDE_PROJECT_LAYER_APPLY!=1)')
    process.exit(2)
  }
}

const inventoryPath = arg(argv, '--inventory')
const target = arg(argv, '--target', OCV5_DEFAULT_BOARD_ID)
const outPath = arg(argv, '--out', '')
const dbPath = arg(argv, '--taskboard-db', process.env.OPENCLAUDE_HOME ? `${process.env.OPENCLAUDE_HOME}/taskboard.db` : '')

if (!inventoryPath) {
  console.error('--inventory <json> is required')
  process.exit(2)
}

const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as ProjectLayerInventory

function boardFromSqlite(path: string, id: string): LiveBoardProject | null {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(
      'SELECT id, key, archived_at, context_version FROM tb_project WHERE id = ?',
    ).get(id) as { id: string; key: string; archived_at: number | null; context_version: number } | undefined
    if (!row) return null
    return {
      id: row.id,
      key: row.key,
      archivedAt: row.archived_at,
      contextVersion: row.context_version ?? 0,
    }
  } finally {
    db.close()
  }
}

const ports: ProjectLayerLivePorts = {
  async getBoardProject(id) {
    if (!dbPath) return id === target ? { id, key: 'OCV5', archivedAt: null, contextVersion: 0 } : null
    try {
      return boardFromSqlite(dbPath, id)
    } catch {
      return null
    }
  },
  async listChatProjects() {
    return []
  },
  async getSession(id) {
    const s = inventory.sessionMapping.sessions.find((row) => row.id === id)
    if (!s) return null
    const snap: LiveSessionSnapshot = {
      id: s.id,
      projectId: s.project_id ?? null,
      updatedAt: typeof s.updated_at === 'number' ? s.updated_at : 0,
      deletedAt: s.deleted_at ? 1 : null,
      archivedAt: s.archived_at ? 1 : null,
    }
    return snap
  },
  async getProjectContextVersion(id) {
    if (!dbPath) return 0
    try {
      return boardFromSqlite(dbPath, id)?.contextVersion ?? 0
    } catch {
      return 0
    }
  },
  async sha256File(absPath) {
    const buf = await readFile(absPath)
    return createHash('sha256').update(buf).digest('hex')
  },
}

const plan = await planProjectLayerMigration({
  inventory,
  targetBoardProjectId: target,
  ports,
  agentUid: 1000,
  agentGid: 1000,
})

const text = JSON.stringify(plan, null, 2)
if (outPath) await writeFile(outPath, text)
console.log(text)
console.error(
  `dry-run operationId=${plan.operationId} applySessions=${plan.defaultApplySessionIds.length} manualReview=${plan.manualReview.length} ops=${plan.operations.length}`,
)
