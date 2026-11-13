/** Host-only data initialization. Not registered as an operation or exposed to a container. */
import { constants, closeSync, lstatSync, openSync } from 'node:fs'
import { dirname, parse, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { PROJECT_MEMORY_LEDGER_DDL, PROJECT_SKILL_LEDGER_DDL, PROJECT_FORMAL_DB_APPLICATION_ID,
  PROJECT_FORMAL_DB_VERSION, type AuthorityPaths } from '@openclaude/storage'

/** The future trusted per-user worker supplies a pre-created private root, never model arguments. */
export function initializeProjectFormalLedger(authority: AuthorityPaths): void {
  if (authority.root !== resolve(authority.root) || authority.projectLedgerDb !== resolve(authority.root, 'formal-project.sqlite')) throw new Error('Invalid host formal root')
  let directory = authority.root
  for (;;) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Host formal root must have no symlink ancestors')
    if (directory === parse(directory).root) break
    directory = dirname(directory)
  }
  const root = lstatSync(authority.root)
  if ((root.mode & 0o077) !== 0 || root.uid !== process.getuid?.()) throw new Error('Host formal root must be private and owned by the writer')
  const fd = openSync(authority.projectLedgerDb, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  closeSync(fd)
  const db = new Database(authority.projectLedgerDb)
  try {
    db.pragma('journal_mode = DELETE')
    db.transaction(() => {
      db.exec(PROJECT_MEMORY_LEDGER_DDL + PROJECT_SKILL_LEDGER_DDL)
      db.pragma(`application_id = ${PROJECT_FORMAL_DB_APPLICATION_ID}`)
      db.pragma(`user_version = ${PROJECT_FORMAL_DB_VERSION}`)
    })()
  } finally { db.close() } // A failed/incomplete inode remains for operator inspection; never silently replace it.
}
