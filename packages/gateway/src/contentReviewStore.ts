import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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

export function contentReviewDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OC_CONTENT_REVIEW_DB?.trim()
  if (explicit) return explicit
  const sessions = env.OC_SESSIONS_STORE?.trim()
  if (sessions && !sessions.startsWith('postgres')) {
    return `${dirname(sessions)}/content-reviews.db`
  }
  const home = env.OPENCLAUDE_HOME?.trim() || '/root/.openclaude-v5-selfhost'
  return `${home}/content-reviews.db`
}

export function openContentReviewStore(dbPath: string): ContentReviewStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
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

export function getContentReviewStore(env: NodeJS.ProcessEnv = process.env): ContentReviewStore {
  if (testOverride && singleton) return singleton
  const path = contentReviewDbPath(env)
  if (!singleton || singletonPath !== path) {
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
