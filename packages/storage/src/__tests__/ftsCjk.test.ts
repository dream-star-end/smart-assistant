import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import Database from 'better-sqlite3'

import {
  cjkFtsColumn,
  expandFtsQueryToken,
  literalFtsQuery,
  tokenizeCjkForFts,
} from '../ftsQuery.js'
import {
  FTS_CJK_STAGE_TABLE,
  migrateArchivalFtsCjk,
  migrateFtsCjk,
  migrateSessionsFtsCjk,
  registerFtsCjkFunctions,
  sessionsFtsHasContentFts,
} from '../ftsCjkMigrate.js'
import { assertSafeMigratePath } from '../migrateFtsCjk.js'

const testHome = await mkdtemp(join(tmpdir(), 'oc-fts-cjk-'))
process.env.OPENCLAUDE_HOME = testHome

const { archivalAdd, archivalSearch } = await import('../archivalStore.js')
const { closeSessionsDb, indexTurn, searchSessions, upsertSessionMeta } = await import('../sessionsDb.js')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

describe('CJK query encoding (core-aligned, Latin unchanged)', () => {
  test('splits CJK runs and keeps Latin / filename / version tokens', () => {
    assert.equal(literalFtsQuery('中文测试'), '"中文" "测试"')
    assert.equal(literalFtsQuery('no-such-session'), '"no" "such" "session"')
    assert.equal(literalFtsQuery('ATR5_Ratio_Interval_Analysis.xlsx'), '"ATR5_Ratio_Interval_Analysis" "xlsx"')
    assert.equal(literalFtsQuery('SixSigmaPEAK3.0.03'), '"SixSigmaPEAK3" "0" "03"')
    assert.equal(literalFtsQuery('farinograph'), '"farinograph"')
    assert.equal(literalFtsQuery('a1b2c3d4e5f67890'), '"a1b2c3d4e5f67890"')
    assert.equal(literalFtsQuery('GLM-5.3 模型繁忙'), '"GLM" "5" "3" "模型" "繁忙"')
    assert.equal(
      literalFtsQuery('之前那个参照 dashi-taskboard 开发任务面板的会话'),
      '"dashi" AND "taskboard" AND ("之前" OR "那个" OR "参照" OR "开发" OR "任务" OR "面板" OR "会话")',
    )
    assert.equal(literalFtsQuery('foo OR bar'), '("foo") OR ("bar")')
  })

  test('keeps an over-split CJK compound so it can hit a stored bigram', () => {
    // Segmenter yields 汇+总 (1-char); query must still emit 汇总.
    assert.deepEqual(expandFtsQueryToken('汇总', '汇总'), ['汇总'])
    assert.equal(literalFtsQuery('区间汇总'), '"区间"')
    assert.match(cjkFtsColumn('区间汇总'), /汇总/)
    assert.match(tokenizeCjkForFts('CWRS 硬红春小麦 farinograph'), /farinograph/)
    assert.match(tokenizeCjkForFts('CWRS 硬红春小麦 farinograph'), /小麦/)
    assert.equal(cjkFtsColumn('ATR farinograph'), '')
  })
})

function createLegacySessionsDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE VIRTUAL TABLE sessions_fts USING fts5(
      session_id UNINDEXED,
      turn_idx UNINDEXED,
      role UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `)
  const insert = db.prepare(
    'INSERT INTO sessions_fts(session_id, turn_idx, role, content) VALUES (?, ?, ?, ?)',
  )
  insert.run('s1', 1, 'user', '之前那个参照 dashi-taskboard 开发任务面板的会话')
  insert.run('s2', 1, 'user', 'GLM-5.3 模型繁忙 请换一个模型')
  insert.run('s3', 1, 'user', 'CWRS 加拿大 硬红春小麦 吸水率 farinograph')
  insert.run('s4', 1, 'user', 'please open ATR5_Ratio_Interval_Analysis.xlsx')
  insert.run('s5', 1, 'user', 'SixSigmaPEAK3.0.03 commit a1b2c3d4e5f67890')
  insert.run('s6', 1, 'user', 'ATR 8.33 543 区间汇总 三个报告')
  return db
}

describe('sessions_fts CJK migration', () => {
  test('rebuild is idempotent, preserves content, and makes Chinese MATCH work', () => {
    const db = createLegacySessionsDb()
    registerFtsCjkFunctions(db)
    const first = migrateSessionsFtsCjk(db)
    assert.equal(first.action, 'rebuilt')
    assert.equal(first.rows, 6)
    assert.equal(sessionsFtsHasContentFts(db), true)

    const second = migrateSessionsFtsCjk(db)
    assert.equal(second.action, 'skipped')
    assert.equal(second.rows, 6)

    const originals = db.prepare(
      'SELECT session_id, content FROM sessions_fts ORDER BY session_id',
    ).all() as Array<{ session_id: string; content: string }>
    assert.equal(originals.find((r) => r.session_id === 's1')?.content, '之前那个参照 dashi-taskboard 开发任务面板的会话')
    assert.equal(originals.find((r) => r.session_id === 's4')?.content, 'please open ATR5_Ratio_Interval_Analysis.xlsx')

    const search = db.prepare('SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ? ORDER BY session_id')
    const ids = (q: string) => (search.all(literalFtsQuery(q)) as Array<{ session_id: string }>).map((r) => r.session_id)
    assert.deepEqual(ids('之前那个参照 dashi-taskboard 开发任务面板的会话'), ['s1'])
    assert.deepEqual(ids('任务面板'), ['s1'])
    assert.deepEqual(ids('GLM-5.3 模型繁忙'), ['s2'])
    assert.ok(ids('硬红春小麦').includes('s3'))
    assert.ok(ids('farinograph').includes('s3'))
    assert.deepEqual(ids('ATR5_Ratio_Interval_Analysis.xlsx'), ['s4'])
    assert.deepEqual(ids('SixSigmaPEAK3.0.03'), ['s5'])
    assert.deepEqual(ids('a1b2c3d4e5f67890'), ['s5'])
    assert.ok(ids('区间汇总').includes('s6'))
    db.close()
  })

  test('recovers from a leftover stage table if sessions_fts is missing', () => {
    const db = new Database(':memory:')
    registerFtsCjkFunctions(db)
    db.exec(`
      CREATE TABLE ${FTS_CJK_STAGE_TABLE} (
        session_id TEXT, turn_idx INTEGER, role TEXT, content TEXT
      )
    `)
    db.prepare(`INSERT INTO ${FTS_CJK_STAGE_TABLE} VALUES ('sx', 1, 'user', '开发任务面板')`).run()
    const result = migrateSessionsFtsCjk(db)
    assert.equal(result.action, 'recovered')
    assert.equal(result.rows, 1)
    const hit = db.prepare('SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ?')
      .all(literalFtsQuery('任务面板')) as Array<{ session_id: string }>
    assert.deepEqual(hit.map((r) => r.session_id), ['sx'])
    assert.equal(
      (db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE name = ?`).get(FTS_CJK_STAGE_TABLE) as { ok: number } | undefined),
      undefined,
    )
    db.close()
  })

  test('a thrown rebuild transaction leaves the original 4-column table intact', () => {
    const db = createLegacySessionsDb()
    registerFtsCjkFunctions(db)
    assert.throws(() => {
      db.transaction(() => {
        db.exec(`DROP TABLE IF EXISTS ${FTS_CJK_STAGE_TABLE}`)
        db.exec(`
          CREATE TABLE ${FTS_CJK_STAGE_TABLE} AS
          SELECT session_id, turn_idx, role, content FROM sessions_fts
        `)
        db.exec('DROP TABLE sessions_fts')
        throw new Error('injected rebuild failure')
      })()
    }, /injected rebuild failure/)
    assert.equal(sessionsFtsHasContentFts(db), false)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM sessions_fts').get() as { n: number }).n,
      6,
    )
    const retry = migrateSessionsFtsCjk(db)
    assert.equal(retry.action, 'rebuilt')
    assert.equal(retry.rows, 6)
    db.close()
  })
})

describe('archival_fts CJK migration', () => {
  test('tokenizes on write and rebuilds existing rows', () => {
    const db = new Database(':memory:')
    registerFtsCjkFunctions(db)
    db.exec(`
      CREATE TABLE archival (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT ''
      );
      CREATE VIRTUAL TABLE archival_fts USING fts5(
        content, tags,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)
    db.exec(`
      CREATE TRIGGER archival_ai AFTER INSERT ON archival BEGIN
        INSERT INTO archival_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
    `)
    db.prepare('INSERT INTO archival(id, agent_id, content, tags) VALUES (?, ?, ?, ?)')
      .run('a1', 'main', 'CWRS 加拿大硬红春小麦吸水率 farinograph', '小麦')
    const first = migrateArchivalFtsCjk(db)
    assert.equal(first.action, 'rebuilt')
    assert.equal(first.rows, 1)
    assert.equal(migrateArchivalFtsCjk(db).action, 'skipped')

    const rows = db.prepare(
      `SELECT a.id FROM archival_fts JOIN archival a ON a.rowid = archival_fts.rowid
       WHERE archival_fts MATCH ?`,
    ).all(literalFtsQuery('硬红春小麦')) as Array<{ id: string }>
    assert.deepEqual(rows.map((r) => r.id), ['a1'])
    const english = db.prepare(
      `SELECT a.id FROM archival_fts JOIN archival a ON a.rowid = archival_fts.rowid
       WHERE archival_fts MATCH ?`,
    ).all(literalFtsQuery('farinograph')) as Array<{ id: string }>
    assert.deepEqual(english.map((r) => r.id), ['a1'])
    db.close()
  })
})

describe('runtime session-search / archival-search', () => {
  test('indexTurn + searchSessions hit Chinese and keep English exact', async () => {
    await upsertSessionMeta({
      id: 'sess-cjk',
      agentId: 'main',
      channel: 'webchat',
      peerId: 'u',
      title: 'cjk',
      startedAt: 1,
      lastAt: 1,
      turnCount: 1,
      totalCostUSD: 0,
    })
    await indexTurn(
      'sess-cjk',
      1,
      '之前那个参照 dashi-taskboard 开发任务面板的会话',
      'ATR5_Ratio_Interval_Analysis.xlsx SixSigmaPEAK3.0.03',
    )
    const zh = await searchSessions('任务面板', 5, 'main')
    assert.equal(zh.length, 1)
    assert.equal(zh[0]?.sessionId, 'sess-cjk')
    assert.match(zh[0]?.snippet ?? '', /dashi-taskboard|任务面板/)
    const file = await searchSessions('ATR5_Ratio_Interval_Analysis.xlsx', 5)
    assert.equal(file[0]?.sessionId, 'sess-cjk')
    const ver = await searchSessions('SixSigmaPEAK3.0.03', 5)
    assert.equal(ver[0]?.sessionId, 'sess-cjk')
  })

  test('archivalAdd indexes CJK via trigger', async () => {
    const id = await archivalAdd('main', 'GLM-5.3 模型繁忙 请稍后重试', 'glm')
    const hits = await archivalSearch('main', '模型繁忙', 5)
    assert.equal(hits[0]?.id, id)
    assert.match(hits[0]?.content ?? '', /GLM-5\.3/)
    assert.deepEqual(await archivalSearch('main', '---***', 5), [])
  })
})

describe('migrateFtsCjk wrapper', () => {
  test('runs both sides on a blank handle', () => {
    const db = new Database(':memory:')
    const result = migrateFtsCjk(db)
    assert.ok(result.sessions.action === 'marked' || result.sessions.action === 'skipped')
    assert.equal(result.archival.action, 'skipped')
    db.close()
  })

  test('CLI helper refuses the live sessions.db path', () => {
    const live = `${process.env.OPENCLAUDE_HOME}/sessions.db`
    assert.throws(() => assertSafeMigratePath(live), /refusing to migrate live/)
    assert.doesNotThrow(() => assertSafeMigratePath(live, true))
    assert.doesNotThrow(() => assertSafeMigratePath('/tmp/sessions-fts-cjk-copy.db'))
  })
})
