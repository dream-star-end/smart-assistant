import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import Database from 'better-sqlite3'

export interface ContentReviewRecord {
  id: number
  createdAt: number
  userId: string
  sessionKey: string
  textHash: string
  excerpt: string
  choice: string
  confidence: number | null
  thresholdMet: boolean
  alerted: boolean
  bannedAt: number | null
}

export interface NewContentReview {
  userId: string
  sessionKey: string
  textHash: string
  excerpt: string
  choice: string
  confidence: number | null
  thresholdMet: boolean
}

export interface ContentReviewStore {
  insert(row: NewContentReview): ContentReviewRecord
  markAlerted(id: number): void
  list(limit: number): ContentReviewRecord[]
  get(reviewId: number): ContentReviewRecord | null
  markNotified(reviewId: number): void
  ban(reviewId: number, actor: string): ContentReviewRecord | null
  isBanned(userId: string, sessionKey: string): boolean
  close(): void
}

let singleton: ContentReviewStore | null = null
let singletonPath: string | null = null
let testOverride = false

const SESSIONS_STORE_MODE_RE = /^(?:pg|postgres(?:ql)?|sqlite3?|memory)$/i
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

function isSessionsStoreFilePath(sessions: string): boolean {
  if (SESSIONS_STORE_MODE_RE.test(sessions) || URI_SCHEME_RE.test(sessions)) return false
  if (sessions.toLowerCase().startsWith('postgres')) return false
  // Require a path separator so bare mode tokens (e.g. `pg`) or bare filenames
  // never resolve `dirname(...)` to `.` (which would write into an immutable release dir).
  return /[\\/]/.test(sessions)
}

export function contentReviewDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OC_CONTENT_REVIEW_DB?.trim()
  if (explicit) return explicit
  const sessions = env.OC_SESSIONS_STORE?.trim()
  if (sessions && isSessionsStoreFilePath(sessions)) {
    return `${dirname(sessions)}/content-reviews.db`
  }
  const home = env.OPENCLAUDE_HOME?.trim() || '/root/.openclaude-v5-selfhost'
  return `${home}/content-reviews.db`
}

export function openContentReviewStore(dbPath: string): ContentReviewStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      choice TEXT NOT NULL,
      confidence REAL,
      threshold_met INTEGER NOT NULL,
      alerted INTEGER NOT NULL DEFAULT 0,
      banned_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_bans (
      user_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      banned_at INTEGER NOT NULL,
      review_id INTEGER,
      actor TEXT NOT NULL,
      PRIMARY KEY (user_id, session_key)
    );
  `)
  const insert = db.prepare(`
    INSERT INTO content_reviews (
      created_at, user_id, session_key, text_hash, excerpt, choice, confidence, threshold_met
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const byId = db.prepare(`SELECT * FROM content_reviews WHERE id = ?`)
  const mark = db.prepare(`UPDATE content_reviews SET alerted = 1 WHERE id = ?`)
  const listStmt = db.prepare(`SELECT * FROM content_reviews ORDER BY id DESC LIMIT ?`)
  const banReview = db.prepare(`UPDATE content_reviews SET banned_at = ? WHERE id = ?`)
  const banSession = db.prepare(`
    INSERT INTO session_bans (user_id, session_key, banned_at, review_id, actor)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, session_key) DO UPDATE SET banned_at = excluded.banned_at, review_id = excluded.review_id, actor = excluded.actor
  `)
  const banned = db.prepare(`SELECT 1 FROM session_bans WHERE user_id = ? AND session_key = ?`)

  return {
    insert(row) {
      const createdAt = Date.now()
      const info = insert.run(
        createdAt,
        row.userId,
        row.sessionKey,
        row.textHash,
        row.excerpt,
        row.choice,
        row.confidence,
        row.thresholdMet ? 1 : 0,
      )
      return mapRow(byId.get(Number(info.lastInsertRowid)))
    },
    markAlerted(id) {
      mark.run(id)
    },
    list(limit) {
      const n = Math.max(1, Math.min(200, limit))
      return (listStmt.all(n) as SqlRow[]).map(mapRow)
    },
    get(reviewId) {
      const row = byId.get(reviewId)
      return row ? mapRow(row) : null
    },
    markNotified(reviewId) {
      banReview.run(Date.now(), reviewId)
    },
    ban(reviewId, actor) {
      const current = byId.get(reviewId) as SqlRow | undefined
      if (!current) return null
      if (!current.session_key) return null
      const now = Date.now()
      const tx = db.transaction(() => {
        banReview.run(now, reviewId)
        banSession.run(current.user_id, current.session_key, now, reviewId, actor.slice(0, 120))
      })
      tx()
      return mapRow(byId.get(reviewId))
    },
    isBanned(userId, sessionKey) {
      if (!userId || !sessionKey) return false
      return Boolean(banned.get(userId, sessionKey))
    },
    close() {
      db.close()
    },
  }
}

function legacyCwdContentReviewDbPath(env: NodeJS.ProcessEnv, targetPath: string): string | null {
  if (env.OC_CONTENT_REVIEW_DB?.trim()) return null
  const sessions = env.OC_SESSIONS_STORE?.trim()
  if (!sessions || sessions.startsWith('postgres') || isSessionsStoreFilePath(sessions)) {
    return null
  }
  const legacyPath = resolve('content-reviews.db')
  return resolve(targetPath) === legacyPath ? null : legacyPath
}

interface LegacyBanRow {
  user_id: string
  session_key: string
  banned_at: number
  review_id: number | null
  actor: string
}

function readDbSnapshotReadonly(dbPath: string): {
  reviews: SqlRow[]
  bans: LegacyBanRow[]
  maxSeq: number
} {
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    db = new Database(`file:${encodeURI(dbPath)}?immutable=1`, {
      readonly: true,
      fileMustExist: true,
    })
  }
  try {
    const hasTable = (name: string): boolean =>
      Boolean(
        db
          .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(name),
      )
    const reviews = hasTable('content_reviews')
      ? (db.prepare(`SELECT * FROM content_reviews ORDER BY id ASC`).all() as SqlRow[])
      : []
    const bans = hasTable('session_bans')
      ? (db.prepare(`SELECT * FROM session_bans`).all() as LegacyBanRow[])
      : []
    let maxSeq = reviews.reduce((acc, row) => Math.max(acc, row.id), 0)
    if (hasTable('sqlite_sequence')) {
      const seqRow = db
        .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'content_reviews'`)
        .get() as { seq?: number } | undefined
      if (typeof seqRow?.seq === 'number' && seqRow.seq > maxSeq) {
        maxSeq = seqRow.seq
      }
    }
    return { reviews, bans, maxSeq }
  } finally {
    db.close()
  }
}

function verifyTargetCoversLegacy(targetPath: string, legacyPath: string, legacy: ReturnType<typeof readDbSnapshotReadonly>): void {
  const target = readDbSnapshotReadonly(targetPath)
  const targetById = new Map<number, SqlRow>()
  for (const row of target.reviews) targetById.set(row.id, row)
  for (const row of legacy.reviews) {
    const matched = targetById.get(row.id)
    if (
      !matched ||
      matched.user_id !== row.user_id ||
      matched.session_key !== row.session_key ||
      matched.text_hash !== row.text_hash ||
      matched.created_at !== row.created_at
    ) {
      throw new Error(
        `content_review_split_brain: both target (${targetPath}) and legacy (${legacyPath}) contain diverging content_reviews records (id=${row.id}); reconcile or set OC_CONTENT_REVIEW_DB explicitly`,
      )
    }
  }
  const targetBans = new Set(target.bans.map((b) => `${b.user_id}\0${b.session_key}`))
  for (const ban of legacy.bans) {
    if (!targetBans.has(`${ban.user_id}\0${ban.session_key}`)) {
      throw new Error(
        `content_review_split_brain: legacy (${legacyPath}) contains session_bans missing from target (${targetPath}); reconcile or set OC_CONTENT_REVIEW_DB explicitly`,
      )
    }
  }
  if (target.maxSeq < legacy.maxSeq) {
    throw new Error(
      `content_review_split_brain: target (${targetPath}) sequence (${target.maxSeq}) trails legacy (${legacyPath}) sequence (${legacy.maxSeq}); reconcile or set OC_CONTENT_REVIEW_DB explicitly`,
    )
  }
}

function migrateOrVerifyLegacyContentReviewDb(env: NodeJS.ProcessEnv, targetPath: string): void {
  const legacyPath = legacyCwdContentReviewDbPath(env, targetPath)
  if (!legacyPath || !existsSync(legacyPath)) return
  const legacy = readDbSnapshotReadonly(legacyPath)
  if (legacy.reviews.length === 0 && legacy.bans.length === 0 && legacy.maxSeq === 0) return

  if (existsSync(targetPath)) {
    verifyTargetCoversLegacy(targetPath, legacyPath, legacy)
    return
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  const tmpPath = `${targetPath}.migrate-${process.pid}-${Date.now()}.tmp`
  let migrated = false
  try {
    const tmpDb = new Database(tmpPath)
    try {
      tmpDb.pragma('journal_mode = DELETE')
      tmpDb.exec(`
        CREATE TABLE IF NOT EXISTS content_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          choice TEXT NOT NULL,
          confidence REAL,
          threshold_met INTEGER NOT NULL,
          alerted INTEGER NOT NULL DEFAULT 0,
          banned_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS session_bans (
          user_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          banned_at INTEGER NOT NULL,
          review_id INTEGER,
          actor TEXT NOT NULL,
          PRIMARY KEY (user_id, session_key)
        );
      `)
      const insReview = tmpDb.prepare(`
        INSERT INTO content_reviews (
          id, created_at, user_id, session_key, text_hash, excerpt, choice, confidence, threshold_met, alerted, banned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insBan = tmpDb.prepare(`
        INSERT OR REPLACE INTO session_bans (user_id, session_key, banned_at, review_id, actor)
        VALUES (?, ?, ?, ?, ?)
      `)
      const tx = tmpDb.transaction(() => {
        for (const row of legacy.reviews) {
          insReview.run(
            row.id,
            row.created_at,
            row.user_id,
            row.session_key,
            row.text_hash,
            row.excerpt,
            row.choice,
            row.confidence,
            row.threshold_met,
            row.alerted,
            row.banned_at,
          )
        }
        for (const ban of legacy.bans) {
          insBan.run(ban.user_id, ban.session_key, ban.banned_at, ban.review_id, ban.actor)
        }
        if (legacy.maxSeq > 0) {
          const updated = tmpDb
            .prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'content_reviews'`)
            .run(legacy.maxSeq)
          if (updated.changes === 0) {
            tmpDb
              .prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('content_reviews', ?)`)
              .run(legacy.maxSeq)
          }
        }
      })
      tx()
    } finally {
      tmpDb.close()
    }
    if (existsSync(targetPath)) {
      rmSync(tmpPath, { force: true })
      verifyTargetCoversLegacy(targetPath, legacyPath, legacy)
      return
    }
    renameSync(tmpPath, targetPath)
    migrated = true
  } finally {
    if (!migrated) rmSync(tmpPath, { force: true })
  }
}

export function getContentReviewStore(env: NodeJS.ProcessEnv = process.env): ContentReviewStore {
  if (testOverride && singleton) return singleton
  const path = contentReviewDbPath(env)
  if (!singleton || singletonPath !== path) {
    migrateOrVerifyLegacyContentReviewDb(env, path)
    singleton?.close()
    singleton = openContentReviewStore(path)
    singletonPath = path
  }
  return singleton
}

export function setContentReviewStoreForTests(store: ContentReviewStore | null): void {
  if (store === null) {
    testOverride = false
    singleton = null
    singletonPath = null
    return
  }
  testOverride = true
  singleton = store
  singletonPath = 'test'
}

interface SqlRow {
  id: number
  created_at: number
  user_id: string
  session_key: string
  text_hash: string
  excerpt: string
  choice: string
  confidence: number | null
  threshold_met: number
  alerted: number
  banned_at: number | null
}

function mapRow(row: unknown): ContentReviewRecord {
  const r = row as SqlRow
  return {
    id: r.id,
    createdAt: r.created_at,
    userId: r.user_id,
    sessionKey: r.session_key,
    textHash: r.text_hash,
    excerpt: r.excerpt,
    choice: r.choice,
    confidence: r.confidence,
    thresholdMet: r.threshold_met === 1,
    alerted: r.alerted === 1,
    bannedAt: r.banned_at,
  }
}
