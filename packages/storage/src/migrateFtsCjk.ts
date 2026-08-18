#!/usr/bin/env npx tsx
// Rebuild CJK FTS tokens on a sessions.db copy.
//
//   npx tsx packages/storage/src/migrateFtsCjk.ts /tmp/sessions-fts-cjk.db
//
// Refuses the live ~/.openclaude/sessions.db unless --i-know-this-is-live
// is passed. OpenClaude V5 memory B2: do not run this against the live file
// during the verification pass — copy first.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { migrateFtsCjk, registerFtsCjkFunctions, sessionsFtsHasContentFts } from './ftsCjkMigrate.js'

export function liveSessionsDbPath(): string {
  const home = process.env.OPENCLAUDE_HOME ?? `${homedir()}/.openclaude`
  return resolve(home, 'sessions.db')
}

export function assertSafeMigratePath(dbPath: string, forceLive = false): void {
  const resolved = resolve(dbPath)
  if (resolved === liveSessionsDbPath() && !forceLive) {
    throw new Error(
      `refusing to migrate live sessions.db (${resolved}); copy it to /tmp first, or pass --i-know-this-is-live`,
    )
  }
}

export function migrateFtsCjkFile(
  dbPath: string,
  opts: { forceLive?: boolean } = {},
): ReturnType<typeof migrateFtsCjk> {
  assertSafeMigratePath(dbPath, opts.forceLive === true)
  if (!existsSync(dbPath)) throw new Error(`db not found: ${dbPath}`)
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 10000')
    db.pragma('journal_mode = WAL')
    registerFtsCjkFunctions(db)
    const result = migrateFtsCjk(db)
    return result
  } finally {
    db.close()
  }
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href
  } catch {
    return false
  }
}

if (isMain()) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--i-know-this-is-live')
  const forceLive = process.argv.includes('--i-know-this-is-live')
  const dbPath = args[0]
  if (!dbPath) {
    console.error('usage: npx tsx packages/storage/src/migrateFtsCjk.ts <sessions.db> [--i-know-this-is-live]')
    process.exit(2)
  }
  try {
    const result = migrateFtsCjkFile(dbPath, { forceLive })
    const db = new Database(dbPath, { readonly: true })
    const hasCol = sessionsFtsHasContentFts(db)
    db.close()
    console.log(JSON.stringify({ db: resolve(dbPath), content_fts: hasCol, ...result }, null, 2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
