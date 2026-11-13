/** Explicit-root readonly formal project ledger. Creation/migration belongs to the host writer. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { AuthorityPaths, ProjectFileLocations } from './authorityPaths.js'
import { ProjectMemoryLedger, type ProjectMemoryOfficialRow, type ProjectMemoryCandidateRow, type SqlDb } from './projectMemoryLedger.js'
import { ProjectSkillLedger, type ProjectSkillRow } from './projectSkillLedger.js'

export const PROJECT_FORMAL_DB_VERSION = 1
export const PROJECT_FORMAL_DB_APPLICATION_ID = 0x4f435046
export interface ProjectFormalSnapshot { skills: ProjectSkillRow[]; official: ProjectMemoryOfficialRow[] }
export interface ProjectFormalLedgerView {
  snapshot(projectId: string): ProjectFormalSnapshot
  listCandidates(projectId: string): ProjectMemoryCandidateRow[]
  close(): void
}
export interface ProjectFormalReadSource {
  readonly paths: ProjectFileLocations
  readonly ledger: ProjectFormalLedgerView
}
const columns: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tb_project_memory_event: ['id','project_id','slug','action','content_sha256','actor','source_agent','source_session','source_ticket','supersedes','expires','idempotency_key','created_at'],
  tb_project_memory_candidate: ['id','project_id','slug','file','content_sha256','status','version','source_agent','source_session','source_ticket','supersedes','expires','created_at','updated_at'],
  tb_project_memory_official: ['project_id','slug','content_sha256','file','version','event_id','expires','deprecated','supersedes','source_agent','source_session','source_ticket','updated_at'],
  tb_project_skill: ['project_id','name','version','files_json','tree_sha256','active','actor','updated_at'],
})
function noSymlinks(file: string): void {
  if (!isAbsolute(file) || file !== resolve(file)) throw new Error('An explicit canonical formal ledger path is required')
  let current = file
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('Formal ledger symlinks are forbidden')
    if (current === parse(current).root) break
    current = dirname(current)
  }
}
/** Host-provided paths only. Process checks supplement, and do not replace, the later RO mount. */
export function openProjectFormalReadonly(authority: Pick<AuthorityPaths, 'projectLedgerDb'>): ProjectFormalLedgerView {
  const file = authority?.projectLedgerDb
  if (typeof file !== 'string') throw new Error('Explicit formal ledger path is required')
  noSymlinks(file)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let identity: ReturnType<typeof fstatSync>
  try {
    identity = fstatSync(fd)
    if (!identity.isFile() || identity.nlink !== 1) throw new Error('Formal ledger must be an independent regular inode')
    const header = Buffer.alloc(100)
    if (readSync(fd, header, 0, header.length, 0) !== 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0'
      || header[18] !== 1 || header[19] !== 1) throw new Error('A complete rollback-journal formal ledger is required')
    // Reject WAL before SQLite opens it: even a readonly SQLite open may create shared-memory files.
  } finally { closeSync(fd) }
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    noSymlinks(file)
    const after = lstatSync(file)
    if (after.dev !== identity.dev || after.ino !== identity.ino || after.nlink !== 1) throw new Error('Formal ledger identity changed')
    db.pragma('query_only = ON')
    if (db.pragma('application_id', { simple: true }) !== PROJECT_FORMAL_DB_APPLICATION_ID
      || db.pragma('user_version', { simple: true }) !== PROJECT_FORMAL_DB_VERSION) throw new Error('Unsupported formal ledger schema')
    for (const [table, expected] of Object.entries(columns)) {
      const object = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(table) as { type: string; sql: string } | undefined
      const found = db.pragma(`table_info(${table})`) as Array<{ name: string }>
      if (object?.type !== 'table' || !/^CREATE TABLE/i.test(object.sql) || JSON.stringify(found.map(row => row.name)) !== JSON.stringify(expected)) throw new Error('Incomplete formal ledger schema')
    }
    const memory = new ProjectMemoryLedger(db as unknown as SqlDb)
    const skills = new ProjectSkillLedger(db as unknown as SqlDb)
    const snapshot = db.transaction((projectId: string) => ({ skills: skills.listActive(projectId), official: memory.listOfficial(projectId) }))
    let closed = false
    return Object.freeze({ snapshot: (projectId: string) => snapshot(projectId), listCandidates: (projectId: string) => memory.listCandidates(projectId),
      close() { if (!closed) { closed = true; db.close() } } })
  } catch (error) { db.close(); throw error }
}
