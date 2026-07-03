import * as assert from 'node:assert/strict'
/**
 * Tests for v3→v5 per-user client_sessions 行级迁移(migrateUserClientSessionsFromV3)。
 *
 * 验证:①只迁目标用户、其它租户零污染 ②幂等可重跑 ③updated_at 后写胜(v5 更新的行
 * 不被 v3 旧行覆盖)④next_seq 取 MAX 只增不退(增量游标单调)。
 *
 * 用显式 v5DbPath(临时库)避免碰到进程 HOME 的真实 sessions.db(ESM import 提升会让
 * 顶层 env 赋值晚于 paths 解析,故绝不依赖 OPENCLAUDE_HOME)。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsMigrate.test.ts
 */
import { mkdtempSync } from 'node:fs'
import { describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrateUserClientSessionsFromV3 } from '../sessionsMigrate.js'

const CLIENT_SESSIONS_DDL = `
  CREATE TABLE client_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    agent_id TEXT NOT NULL DEFAULT 'main',
    title TEXT NOT NULL DEFAULT '新会话',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    message_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER DEFAULT NULL,
    next_seq INTEGER NOT NULL DEFAULT 1,
    origin_channel TEXT DEFAULT NULL
  );
  CREATE TABLE wechat_bindings (
    user_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, login_user_id TEXT NOT NULL DEFAULT '',
    bot_token TEXT NOT NULL, get_updates_buf TEXT NOT NULL DEFAULT '', context_tokens TEXT NOT NULL DEFAULT '{}',
    whitelist TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_event_at INTEGER DEFAULT NULL
  );
`

function freshDb(prefix: string): { path: string; db: Database.Database } {
  const path = join(mkdtempSync(join(tmpdir(), prefix)), 'sessions.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(CLIENT_SESSIONS_DDL)
  return { path, db }
}

function insertCs(
  db: Database.Database,
  row: { id: string; user_id: string; messages?: string; updated_at?: number; next_seq?: number },
): void {
  db.prepare(
    `INSERT INTO client_sessions (id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,updated_at,deleted_at,next_seq,origin_channel)
     VALUES (@id,@user_id,'main','t',0,1000,@ua,@messages,0,@ua,NULL,@seq,NULL)`,
  ).run({
    id: row.id,
    user_id: row.user_id,
    messages: row.messages ?? '[]',
    ua: row.updated_at ?? 2000,
    seq: row.next_seq ?? 1,
  })
}

describe('migrateUserClientSessionsFromV3', () => {
  it('只迁目标用户,其它租户零污染;幂等可重跑', async () => {
    const v3 = freshDb('oc-v3-sm-')
    insertCs(v3.db, { id: 's-42a', user_id: '42', messages: '[{"id":"m1"}]' })
    insertCs(v3.db, { id: 's-42b', user_id: '42' })
    insertCs(v3.db, { id: 's-99a', user_id: '99' })
    v3.db.close()
    const v5 = freshDb('oc-v5-sm-')

    const r1 = await migrateUserClientSessionsFromV3(v3.path, '42', v5.path)
    assert.equal(r1.clientSessions, 2, '应迁 42 的 2 行')
    assert.equal(r1.skipped, undefined)

    const ids = (v5.db.prepare('SELECT id FROM client_sessions ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    )
    assert.deepEqual(ids, ['s-42a', 's-42b'], '只应有 42 的会话,99 不得被迁入')

    await migrateUserClientSessionsFromV3(v3.path, '42', v5.path)
    const cnt = (v5.db.prepare('SELECT COUNT(*) AS n FROM client_sessions').get() as { n: number }).n
    assert.equal(cnt, 2, '重跑不产生重复行')
    v5.db.close()
  })

  it('updated_at 后写胜 + next_seq 取 MAX', async () => {
    const v3 = freshDb('oc-v3-sm-')
    // v3 的行更旧(updated_at=3000)、next_seq 更低(5)。
    insertCs(v3.db, { id: 's-guard', user_id: '42', messages: '[{"id":"v3old"}]', updated_at: 3000, next_seq: 5 })
    v3.db.close()

    const v5 = freshDb('oc-v5-sm-')
    // v5 已有同 id 更新的行(updated_at=9000, next_seq=50)——模拟 canary/预热后 v5 更新。
    insertCs(v5.db, { id: 's-guard', user_id: '42', messages: '[{"id":"v5new"}]', updated_at: 9000, next_seq: 50 })

    await migrateUserClientSessionsFromV3(v3.path, '42', v5.path)

    const row = v5.db
      .prepare('SELECT messages,updated_at,next_seq FROM client_sessions WHERE id=?')
      .get('s-guard') as { messages: string; updated_at: number; next_seq: number }
    assert.match(row.messages, /v5new/, 'v5 更新的行不得被 v3 旧行覆盖')
    assert.equal(row.updated_at, 9000)
    assert.equal(row.next_seq, 50, 'next_seq 取 MAX(50>5),游标只增不退')
    v5.db.close()
  })

  it('v3 更新的行覆盖 v5 旧行(正向后写胜)', async () => {
    const v3 = freshDb('oc-v3-sm-')
    insertCs(v3.db, { id: 's-fwd', user_id: '7', messages: '[{"id":"v3new"}]', updated_at: 8000, next_seq: 9 })
    v3.db.close()
    const v5 = freshDb('oc-v5-sm-')
    insertCs(v5.db, { id: 's-fwd', user_id: '7', messages: '[{"id":"v5old"}]', updated_at: 4000, next_seq: 3 })

    await migrateUserClientSessionsFromV3(v3.path, '7', v5.path)
    const row = v5.db.prepare('SELECT messages,next_seq FROM client_sessions WHERE id=?').get('s-fwd') as {
      messages: string
      next_seq: number
    }
    assert.match(row.messages, /v3new/, 'v3 更新的行应覆盖 v5 旧行')
    assert.equal(row.next_seq, 9)
    v5.db.close()
  })

  it('v3 库缺失时优雅跳过', async () => {
    const v5 = freshDb('oc-v5-sm-')
    const r = await migrateUserClientSessionsFromV3('/nonexistent/sessions.db', '42', v5.path)
    assert.equal(r.clientSessions, 0)
    assert.match(r.skipped ?? '', /不存在/)
    v5.db.close()
  })

  it('拒绝非法 user_id', async () => {
    const v5 = freshDb('oc-v5-sm-')
    await assert.rejects(() => migrateUserClientSessionsFromV3(v5.path, 'abc', join(v5.path, '..', 'x.db')), /bad user_id/)
    v5.db.close()
  })
})
