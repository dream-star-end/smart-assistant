#!/usr/bin/env npx tsx
// Before/after CJK FTS probe on a sessions.db *copy*.
// Never opens the live file for write. Usage:
//   npx tsx packages/storage/src/verifyFtsCjkCorpus.ts /tmp/sessions-fts-cjk.db

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { literalFtsQuery } from './ftsQuery.js'
import { migrateFtsCjk, registerFtsCjkFunctions, sessionsFtsHasContentFts } from './ftsCjkMigrate.js'
import { assertSafeMigratePath } from './migrateFtsCjk.js'

function oldLiteralFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.map((token) => `"${token}"`).join(' ')
}

const QUERIES = [
  { label: '中文长查询', q: '之前那个参照 dashi-taskboard 开发任务面板的会话' },
  { label: '中文短语', q: '任务面板' },
  { label: '中英混合', q: 'GLM-5.3 模型繁忙' },
  { label: '中英混合-短', q: '模型繁忙' },
  { label: '商业失败样例-ATR', q: 'ATR 8.33 543 区间汇总 三个报告' },
  { label: '商业失败样例-CWRS', q: 'CWRS 加拿大 硬红春小麦 吸水率 farinograph' },
  { label: '英文专名', q: 'delegate_task' },
  { label: '英文专名-SCNet', q: 'SCNet' },
  { label: '文件名', q: 'ATR5_Ratio_Interval_Analysis.xlsx' },
  { label: '版本号', q: 'SixSigmaPEAK3.0.03' },
  { label: 'commit sha', q: 'a1b2c3d4e5f67890' },
  { label: 'MEMORY.md', q: 'MEMORY.md' },
]

const SYNTHETIC: Array<{ id: string; content: string }> = [
  { id: 'synthetic-b2-atr', content: 'ATR 8.33 543 区间汇总 三个报告 见附件 ATR5_Ratio_Interval_Analysis.xlsx' },
  { id: 'synthetic-b2-cwrs', content: 'CWRS 加拿大 硬红春小麦 吸水率 farinograph SixSigmaPEAK3.0.03 a1b2c3d4e5f67890' },
]

interface Hit {
  session_id: string
  snippet: string
  score: number
}

function search(db: Database.Database, match: string, limit = 5): Hit[] {
  if (!match) return []
  try {
    return db.prepare(`
      SELECT
        f.session_id,
        snippet(sessions_fts, 3, '<mark>', '</mark>', '…', 16) AS snippet,
        bm25(sessions_fts) AS score
      FROM sessions_fts f
      WHERE sessions_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(match, limit) as Hit[]
  } catch {
    return []
  }
}

function top3(hits: Hit[]): string {
  if (hits.length === 0) return '(none)'
  return hits.slice(0, 3).map((h, i) => {
    const id = h.session_id.length > 36 ? `${h.session_id.slice(0, 36)}…` : h.session_id
    const snip = h.snippet.replace(/\s+/g, ' ').slice(0, 80)
    return `${i + 1}.${id} score=${h.score.toFixed(3)} ${snip}`
  }).join(' | ')
}

function main(): void {
  const dbPath = process.argv[2]
  if (!dbPath || !existsSync(dbPath)) {
    console.error('usage: npx tsx packages/storage/src/verifyFtsCjkCorpus.ts /tmp/sessions-fts-cjk.db')
    process.exit(2)
  }
  assertSafeMigratePath(dbPath)

  const db = new Database(dbPath)
  db.pragma('busy_timeout = 10000')
  registerFtsCjkFunctions(db)

  const beforeCount = (db.prepare('SELECT COUNT(*) AS n FROM sessions_fts').get() as { n: number }).n
  const insert = db.prepare(
    'INSERT INTO sessions_fts(session_id, turn_idx, role, content) VALUES (?, ?, ?, ?)',
  )
  for (const row of SYNTHETIC) {
    insert.run(row.id, 1, 'user', row.content)
  }
  const seeded = (db.prepare('SELECT COUNT(*) AS n FROM sessions_fts').get() as { n: number }).n

  const before: Array<{ label: string; q: string; encoded: string; n: number; top: string }> = []
  for (const item of QUERIES) {
    const encoded = oldLiteralFtsQuery(item.q)
    const hits = search(db, encoded)
    before.push({ label: item.label, q: item.q, encoded, n: hits.length, top: top3(hits) })
  }

  const t0 = Date.now()
  const migrated = migrateFtsCjk(db)
  const migrateMs = Date.now() - t0
  const afterCount = (db.prepare('SELECT COUNT(*) AS n FROM sessions_fts').get() as { n: number }).n
  const bytes = (db.prepare('SELECT SUM(length(content)) AS b FROM sessions_fts').get() as { b: number }).b

  const after: typeof before = []
  for (const item of QUERIES) {
    const encoded = literalFtsQuery(item.q)
    const hits = search(db, encoded)
    after.push({ label: item.label, q: item.q, encoded, n: hits.length, top: top3(hits) })
  }

  const report = {
    db: resolve(dbPath),
    beforeCount,
    seeded,
    afterCount,
    contentBytes: bytes,
    hasContentFts: sessionsFtsHasContentFts(db),
    migrateMs,
    migrated,
    rows: QUERIES.map((item, i) => ({
      label: item.label,
      q: item.q,
      beforeEncoded: before[i]!.encoded,
      afterEncoded: after[i]!.encoded,
      beforeHits: before[i]!.n,
      afterHits: after[i]!.n,
      beforeTop3: before[i]!.top,
      afterTop3: after[i]!.top,
    })),
  }
  db.close()
  console.log(JSON.stringify(report, null, 2))
}

main()
