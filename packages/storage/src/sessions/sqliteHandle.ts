import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { registerFtsCjkFunctions } from '../ftsCjkMigrate.js'
import { paths } from '../paths.js'
import { ensureClientSessionsSchema } from './schemaClientSessions.js'
import { ensureCoreObservabilityTables, migrateObservabilityTables } from './schemaCore.js'

let _db: Database.Database | null = null
let _dbInitPromise: Promise<Database.Database> | null = null
let _walTimer: ReturnType<typeof setInterval> | null = null

function safeCloseDb(db: Database.Database, checkpoint: boolean): boolean {
  try {
    if (checkpoint) db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    return true
  } catch {
    return false
  }
}

function onExit(): void {
  if (_db) {
    if (_walTimer !== null) {
      clearInterval(_walTimer)
      _walTimer = null
    }
    safeCloseDb(_db, true)
    _db = null
  }
}

function installWalMaintenance(db: Database.Database): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    console.warn(
      '[sessionsDb] startup wal_checkpoint(TRUNCATE) failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
  if (_walTimer !== null) {
    clearInterval(_walTimer)
    _walTimer = null
  }
  _walTimer = setInterval(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (err) {
      console.warn(
        '[sessionsDb] periodic wal_checkpoint(TRUNCATE) failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }, 30 * 60_000)
  _walTimer.unref()
  process.off('exit', onExit)
  process.on('exit', onExit)
}

async function openSessionsDb(): Promise<Database.Database> {
  await mkdir(dirname(paths.sessionsDb), { recursive: true })
  const db = new Database(paths.sessionsDb)
  try {
    db.pragma('busy_timeout = 10000')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    registerFtsCjkFunctions(db)
    ensureCoreObservabilityTables(db)
    migrateObservabilityTables(db)
    ensureClientSessionsSchema(db)
    installWalMaintenance(db)
    _db = db
    return db
  } catch (err) {
    safeCloseDb(db, false)
    throw err
  }
}

export async function getSessionsDb(): Promise<Database.Database> {
  if (_db) return _db
  if (_dbInitPromise) return _dbInitPromise
  const initPromise = openSessionsDb()
  _dbInitPromise = initPromise
  try {
    return await initPromise
  } finally {
    if (_dbInitPromise === initPromise) _dbInitPromise = null
  }
}

export async function _sqliteProbeSessionsDb(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const db = await getSessionsDb()
    db.prepare('SELECT 1').get()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) }
  }
}

export async function closeSessionsDb(): Promise<void> {
  if (_dbInitPromise) {
    await _dbInitPromise.catch(() => null)
  }
  if (_walTimer !== null) {
    clearInterval(_walTimer)
    _walTimer = null
  }
  process.off('exit', onExit)
  if (_db) {
    safeCloseDb(_db, true)
    _db = null
  }
}
