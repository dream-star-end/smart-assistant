/**
 * Safe project-context migration: empty dirs + copy main `type:project`
 * memories as candidates. Never auto-binds sessions. --down never rm -rf
 * projects/; it only removes artifacts that still match the migration
 * manifest hash and were never user-modified.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { MEMORY_FILE_RE, parseMemoryFrontmatter } from './memoryFrontmatter.js'
import { BOARD_PROJECT_ID_RE } from './projectContext.js'
import { ensureProjectMemoryLedger, ProjectMemoryLedger } from './projectMemoryLedger.js'
import { planCandidateFileName, ProjectMemoryDir, sha256Hex } from './projectMemoryDir.js'

export interface MigrationCopiedCandidate {
  projectId: string
  slug: string
  file: string
  hash: string
}

export interface MigrationCreatedDir {
  projectId: string
  key: string
  dir: string
  metaHash: string
  skippedBind: boolean
}

export interface ProjectContextMigrationManifest {
  schemaVersion: 1
  createdAt: number
  mode: 'dry-run' | 'apply' | 'down'
  home: string
  created: MigrationCreatedDir[]
  copiedCandidates: MigrationCopiedCandidate[]
  suggestedSkills: string[]
  skippedE2E: string[]
  autoBindSessions: false
}

export interface MigrateProjectContextOpts {
  home: string
  dbPath: string
  mode: 'dry-run' | 'apply' | 'down'
  downManifestPath?: string
  copyFile?: typeof copyFile
}

function fileHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function migrationDir(home: string): string {
  return join(home, 'projects', '_migration')
}

export function defaultManifestPath(home: string, createdAt: number): string {
  return join(migrationDir(home), `${createdAt}.json`)
}

export async function backupRefusedFiles(
  home: string,
  backupRoot: string,
  files: string[],
  copyFn: typeof copyFile = copyFile,
): Promise<{ ok: true; manifestPath: string } | { ok: false; error: string }> {
  const homeReal = resolve(home)
  const entries: Array<{ relativePath: string; sha256: string }> = []
  try {
    await mkdir(backupRoot, { recursive: true, mode: 0o700 })
    for (const path of files) {
      const abs = resolve(path)
      const rel = relative(homeReal, abs)
      if (!rel || rel.startsWith('..') || rel.includes('..')) {
        return { ok: false, error: `path escapes home: ${path}` }
      }
      const src = await readIfExists(abs)
      if (src == null) return { ok: false, error: `missing source ${rel}` }
      const expected = sha256Hex(src)
      const dest = join(backupRoot, rel)
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      await copyFn(abs, dest)
      const copied = await readIfExists(dest)
      if (copied == null || sha256Hex(copied) !== expected) {
        return { ok: false, error: `hash mismatch after copy: ${rel}` }
      }
      entries.push({ relativePath: rel, sha256: expected })
    }
    const manifestPath = join(backupRoot, 'backup-manifest.json')
    await writeFile(
      manifestPath,
      `${JSON.stringify({ schemaVersion: 1, createdAt: Date.now(), files: entries }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    return { ok: true, manifestPath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function migrateProjectContext(
  opts: MigrateProjectContextOpts,
): Promise<ProjectContextMigrationManifest> {
  if (opts.mode === 'down') return downProjectContext(opts)

  const db = new Database(opts.dbPath, { readonly: opts.mode === 'dry-run', fileMustExist: true })
  try {
    const projects = db
      .prepare(
        `SELECT id, key, name, archived_at FROM tb_project WHERE archived_at IS NULL ORDER BY created_at`,
      )
      .all() as Array<{ id: string; key: string; name: string; archived_at: number | null }>
    const created: MigrationCreatedDir[] = []
    const copied: MigrationCopiedCandidate[] = []
    const skippedE2E: string[] = []
    const now = Date.now()
    const suggestedSkills = await suggestSkills(opts.home)

    if (opts.mode === 'apply') {
      ensureProjectMemoryLedger(db)
    }
    const ledger = opts.mode === 'apply' ? new ProjectMemoryLedger(db) : null

    for (const project of projects) {
      if (!BOARD_PROJECT_ID_RE.test(project.id)) continue
      if (project.key === 'E2E') {
        skippedE2E.push(project.id)
        continue
      }
      const dir = join(opts.home, 'projects', project.id)
      const meta = {
        schemaVersion: 1,
        boardProjectId: project.id,
        key: project.key,
        version: 0,
        updatedAt: now,
        skillOverlay: [],
        promotion: { schemaVersion: 1, manifestSha256: null },
      }
      const metaBody = `${JSON.stringify(meta, null, 2)}\n`
      created.push({
        projectId: project.id,
        key: project.key,
        dir,
        metaHash: fileHash(metaBody),
        skippedBind: true,
      })
      if (opts.mode === 'apply') {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const existingMeta = await readIfExists(join(dir, 'meta.json'))
        if (!existingMeta) await writeFile(join(dir, 'meta.json'), metaBody, { mode: 0o600 })
        const memIndex = join(dir, 'MEMORY.md')
        if (!existsSync(memIndex)) {
          await writeFile(memIndex, '<!-- oc-project-memdir-index v1 -->\n', { mode: 0o600 })
        }
      }
      const mainMem = join(opts.home, 'agents', 'main', 'memory')
      if (!existsSync(mainMem)) continue
      const files = await readdir(mainMem)
      for (const file of files) {
        if (!MEMORY_FILE_RE.test(file)) continue
        const raw = await readIfExists(join(mainMem, file))
        if (!raw) continue
        const { fm, body } = parseMemoryFrontmatter(raw)
        if ((fm.type || 'project').trim() !== 'project') continue
        const hay = `${fm.name ?? ''} ${fm.description ?? ''} ${body}`.toLowerCase()
        const needle = `${project.key} ${project.name}`.toLowerCase()
        const hit = needle
          .split(/\s+/)
          .filter((w) => w.length >= 2)
          .some((w) => hay.includes(w.toLowerCase()))
        if (!hit) continue
        const dir = new ProjectMemoryDir(project.id)
        const prepared = dir.prepareCandidateBody(file, raw)
        if (!prepared.ok) continue
        if (opts.mode === 'apply' && ledger) {
          const created = await ledger.createCandidate({
            projectId: project.id,
            slug: file,
            content: raw,
            actor: 'system:migration',
            sourceAgent: 'main',
            idempotencyKey: `migrate:${project.id}:${file}`,
          })
          if (!created.ok) continue
          copied.push({
            projectId: project.id,
            slug: file,
            file: created.candidate.file,
            hash: created.candidate.contentSha256,
          })
        } else {
          const planned = planCandidateFileName({
            slug: file,
            contentSha256: prepared.sha256,
            fileExists: (f) => dir.candidateFileExists(f),
            existingMatchesHash: (f) => {
              try {
                const onDisk = readFileSync(dir.candidateFile(f), 'utf8')
                return sha256Hex(onDisk.endsWith('\n') ? onDisk : `${onDisk}\n`) === prepared.sha256
              } catch {
                return false
              }
            },
            fallbackId: prepared.sha256,
          })
          copied.push({
            projectId: project.id,
            slug: file,
            file: planned,
            hash: prepared.sha256,
          })
        }
      }
    }

    const manifest: ProjectContextMigrationManifest = {
      schemaVersion: 1,
      createdAt: now,
      mode: opts.mode,
      home: opts.home,
      created,
      copiedCandidates: copied,
      suggestedSkills,
      skippedE2E,
      autoBindSessions: false,
    }
    if (opts.mode === 'apply') {
      mkdirSync(migrationDir(opts.home), { recursive: true, mode: 0o700 })
      await writeFile(defaultManifestPath(opts.home, now), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      })
    }
    return manifest
  } finally {
    db.close()
  }
}

async function suggestSkills(home: string): Promise<string[]> {
  const dir = join(home, 'skills')
  if (!existsSync(dir)) return []
  const names: string[] = []
  for (const name of await readdir(dir)) {
    const lower = name.toLowerCase()
    if (/(v5|selfhost|taskboard)/.test(lower)) names.push(name)
  }
  return names.sort()
}

async function downProjectContext(
  opts: MigrateProjectContextOpts,
): Promise<ProjectContextMigrationManifest> {
  const manifestPath = opts.downManifestPath
  if (!manifestPath || !existsSync(manifestPath)) {
    throw new Error('safe-down requires --manifest pointing at the apply JSON')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProjectContextMigrationManifest
  const backupRoot = join(migrationDir(opts.home), `${Date.now()}-down-check`)
  const refused: string[] = []
  for (const created of manifest.created) {
    const metaPath = join(created.dir, 'meta.json')
    const current = await readIfExists(metaPath)
    if (current && fileHash(current) !== created.metaHash) {
      refused.push(metaPath)
    }
  }
  for (const cand of manifest.copiedCandidates) {
    const path = join(opts.home, 'projects', cand.projectId, 'memory-candidates', cand.file)
    const current = await readIfExists(path)
    if (!current) continue
    const hash = sha256Hex(current)
    if (hash !== cand.hash) refused.push(path)
  }
  if (refused.length > 0) {
    const backup = await backupRefusedFiles(opts.home, backupRoot, refused, opts.copyFile)
    if (!backup.ok) {
      throw new Error(
        `safe-down backup failed: ${backup.error}. refused to delete ${refused.length} modified files without a verified backup`,
      )
    }
    throw new Error(
      `safe-down refused: ${refused.length} migrated files were modified. verification backup: ${backup.manifestPath}`,
    )
  }
  for (const cand of manifest.copiedCandidates) {
    const path = join(opts.home, 'projects', cand.projectId, 'memory-candidates', cand.file)
    const current = await readIfExists(path)
    if (current && sha256Hex(current) === cand.hash) await rm(path, { force: true })
  }
  for (const created of manifest.created) {
    const metaPath = join(created.dir, 'meta.json')
    const current = await readIfExists(metaPath)
    if (current && fileHash(current) === created.metaHash) await rm(metaPath, { force: true })
    const indexPath = join(created.dir, 'MEMORY.md')
    const index = await readIfExists(indexPath)
    if (index && index.trim() === '<!-- oc-project-memdir-index v1 -->') await rm(indexPath, { force: true })
    try {
      const leftovers = await readdir(created.dir)
      if (leftovers.length === 0) await rm(created.dir, { recursive: true, force: true })
    } catch {
      /* keep */
    }
  }
  return { ...manifest, mode: 'down' }
}
