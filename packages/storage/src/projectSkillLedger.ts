/**
 * Gateway-owned project skill overlay ledger (taskboard.db).
 *
 * Files under ~/.openclaude/projects/<id>/skills are carriers only.
 * list/view/search accept a skill iff this ledger has an active row whose
 * per-file hashes still match. Stage agents cannot write these rows.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import type { SqlDb } from './projectMemoryLedger.js'
import { paths } from './paths.js'

const BOARD_PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const PROJECT_SKILL_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS tb_project_skill (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  files_json TEXT NOT NULL,
  tree_sha256 TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  actor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
`

export interface SkillTreeFile {
  relativePath: string
  sha256: string
}

export interface ProjectSkillRow {
  projectId: string
  name: string
  version: number
  files: SkillTreeFile[]
  treeSha256: string
  active: boolean
  actor: string
  updatedAt: number
}

function assertBoardId(id: string): string {
  const trimmed = id.trim().toLowerCase()
  if (!BOARD_PROJECT_ID_RE.test(trimmed)) throw new Error(`invalid boardProjectId: ${id}`)
  return trimmed
}

export function ensureProjectSkillLedger(db: SqlDb): void {
  db.exec(PROJECT_SKILL_LEDGER_DDL)
}

export function hashSkillTree(
  skillDir: string,
): { ok: true; files: SkillTreeFile[]; treeSha256: string } | { ok: false; error: 'symlink' | 'escape' | 'missing' } {
  if (!existsSync(skillDir)) return { ok: false, error: 'missing' }
  let rootReal: string
  try {
    const st = lstatSync(skillDir)
    if (st.isSymbolicLink()) return { ok: false, error: 'symlink' }
    rootReal = resolve(skillDir)
  } catch {
    return { ok: false, error: 'missing' }
  }
  const files: SkillTreeFile[] = []
  const walk = (dir: string): boolean => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        return false
      }
      if (st.isSymbolicLink()) return false
      if (st.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        if (!walk(abs)) return false
        continue
      }
      if (!st.isFile()) continue
      if (entry.name === '.openclaude-agent-scope.json') continue
      const rel = relative(rootReal, abs).split(sep).join('/')
      if (!rel || rel.startsWith('../') || rel.includes('/../') || rel.startsWith('/')) return false
      const buf = readFileSync(abs)
      files.push({
        relativePath: rel,
        sha256: createHash('sha256').update(buf).digest('hex'),
      })
    }
    return true
  }
  if (!walk(rootReal)) return { ok: false, error: 'symlink' }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const treeSha256 = createHash('sha256')
    .update(files.map((f) => `${f.relativePath}:${f.sha256}`).join('\n'), 'utf8')
    .digest('hex')
  return { ok: true, files, treeSha256 }
}

export function verifySkillTree(
  skillDir: string,
  expected: readonly SkillTreeFile[],
): boolean {
  const hashed = hashSkillTree(skillDir)
  if (!hashed.ok) return false
  if (hashed.files.length !== expected.length) return false
  const want = new Map(expected.map((f) => [f.relativePath, f.sha256]))
  for (const f of hashed.files) {
    if (want.get(f.relativePath) !== f.sha256) return false
  }
  return true
}

export function skillManifestSha256FromFiles(
  skills: Array<{ name: string; treeSha256: string; active?: boolean }>,
): string {
  const lines = skills
    .filter((s) => s.active !== false)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `${s.name}:${s.treeSha256}`)
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

function parseFiles(raw: string): SkillTreeFile[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (f): f is SkillTreeFile =>
          Boolean(
            f &&
              typeof f === 'object' &&
              typeof (f as SkillTreeFile).relativePath === 'string' &&
              typeof (f as SkillTreeFile).sha256 === 'string' &&
              !(f as SkillTreeFile).relativePath.includes('..'),
          ),
      )
      .map((f) => ({ relativePath: f.relativePath, sha256: f.sha256 }))
  } catch {
    return []
  }
}

function mapRow(row: Record<string, unknown>): ProjectSkillRow {
  return {
    projectId: String(row.project_id),
    name: String(row.name),
    version: Number(row.version),
    files: parseFiles(String(row.files_json ?? '[]')),
    treeSha256: String(row.tree_sha256),
    active: Number(row.active) === 1,
    actor: String(row.actor ?? ''),
    updatedAt: Number(row.updated_at),
  }
}

export class ProjectSkillLedger {
  constructor(private readonly db: SqlDb) {}

  listActive(projectId: string): ProjectSkillRow[] {
    const id = assertBoardId(projectId)
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM tb_project_skill WHERE project_id = ? AND active = 1 ORDER BY name`,
        )
        .all(id) as Record<string, unknown>[]
      return rows.map(mapRow)
    } catch {
      return []
    }
  }

  get(projectId: string, name: string): ProjectSkillRow | null {
    const id = assertBoardId(projectId)
    const row = this.db
      .prepare(`SELECT * FROM tb_project_skill WHERE project_id = ? AND name = ?`)
      .get(id, name) as Record<string, unknown> | undefined
    return row ? mapRow(row) : null
  }

  replaceActive(
    projectId: string,
    skills: Array<{ name: string; files: SkillTreeFile[]; treeSha256: string }>,
    actor: string,
  ): void {
    const id = assertBoardId(projectId)
    const now = Date.now()
    const keep = new Set(skills.map((s) => s.name))
    const apply = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT name FROM tb_project_skill WHERE project_id = ?`)
        .all(id) as Array<{ name: string }>
      for (const row of existing) {
        if (!keep.has(row.name)) {
          this.db
            .prepare(
              `UPDATE tb_project_skill SET active = 0, updated_at = ? WHERE project_id = ? AND name = ?`,
            )
            .run(now, id, row.name)
        }
      }
      for (const skill of skills) {
        const prev = this.get(id, skill.name)
        const version = prev ? prev.version + 1 : 1
        this.db
          .prepare(
            `INSERT INTO tb_project_skill (project_id, name, version, files_json, tree_sha256, active, actor, updated_at)
             VALUES (?,?,?,?,?,1,?,?)
             ON CONFLICT(project_id, name) DO UPDATE SET
               version = excluded.version,
               files_json = excluded.files_json,
               tree_sha256 = excluded.tree_sha256,
               active = 1,
               actor = excluded.actor,
               updated_at = excluded.updated_at`,
          )
          .run(
            id,
            skill.name,
            version,
            JSON.stringify(skill.files),
            skill.treeSha256,
            actor,
            now,
          )
      }
    })
    apply()
  }
}

export function loadProjectSkillFileMap(
  projectId: string,
  db?: SqlDb | null,
): Map<string, ReadonlyMap<string, string>> {
  const out = new Map<string, ReadonlyMap<string, string>>()
  const handle = db ?? tryOpenTaskboardReadonly()
  if (!handle) return out
  try {
    const rows = new ProjectSkillLedger(handle).listActive(projectId)
    for (const row of rows) {
      out.set(row.name, new Map(row.files.map((f) => [f.relativePath, f.sha256])))
    }
  } catch {
    /* missing table in old dbs */
  }
  return out
}

function tryOpenTaskboardReadonly(): SqlDb | null {
  try {
    if (!existsSync(paths.taskboardDb)) return null
    return new Database(paths.taskboardDb, { readonly: true, fileMustExist: true }) as unknown as SqlDb
  } catch {
    return null
  }
}

export function openProjectSkillLedgerDb(): SqlDb {
  mkdirSync(dirname(paths.taskboardDb), { recursive: true })
  const db = new Database(paths.taskboardDb) as unknown as SqlDb
  ensureProjectSkillLedger(db)
  return db
}
