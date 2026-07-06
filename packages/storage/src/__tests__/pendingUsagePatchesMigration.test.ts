/**
 * 存量库 schema migration 回归 —— 2026-07-06 线上事故复现场景。
 *
 * 锁死:对一个已存在**旧版 pending_usage_patches**(无 parent_session_id 列)的
 * sessions.db,getSessionsDb() 必须:
 *   - 不抛(事故形态:初始 DDL 块里的 CREATE INDEX 引用后加列 → open 即
 *     "no such column" → list/save/server-authored 落库全体 500);
 *   - ALTER 补上 parent_session_id 列;
 *   - 建出 idx_pup_parent 部分索引;
 *   - 旧行数据原样保留。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/pendingUsagePatchesMigration.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'

const testHome = await mkdtemp(join(tmpdir(), 'oc-pup-migration-'))
process.env.OPENCLAUDE_HOME = testHome

// 先用旧 schema 预建 sessions.db(模拟 2026-07-06 前的线上存量库),
// 再 import sessionsDb 触发 getSessionsDb 的 DDL + migration。
{
  const legacy = new Database(join(testHome, 'sessions.db'))
  legacy.exec(`
    CREATE TABLE pending_usage_patches (
      request_id   TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      session_id   TEXT,
      cost_credits TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000),
      PRIMARY KEY (request_id, user_id)
    );
    CREATE INDEX idx_pup_created ON pending_usage_patches(created_at);
    CREATE INDEX idx_pup_user ON pending_usage_patches(user_id);
    INSERT INTO pending_usage_patches (request_id, user_id, session_id, cost_credits)
      VALUES ('req-legacy-1', 'c:1', 'sess-1', '42');
  `)
  legacy.close()
}

const { getSessionsDb, probeSessionsDb } = await import('../sessionsDb.js')

describe('pending_usage_patches 存量库 migration', () => {
  it('旧 schema 库 open 不抛,列/索引补齐,旧行保留', async () => {
    // 事故形态下这里直接 throw "no such column: parent_session_id"
    const db = await getSessionsDb()

    const cols = db.pragma('table_info(pending_usage_patches)') as Array<{ name: string }>
    assert.ok(
      cols.some(c => c.name === 'parent_session_id'),
      'migration 应补上 parent_session_id 列',
    )

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_pup_parent'")
      .get() as { name: string } | undefined
    assert.equal(idx?.name, 'idx_pup_parent', '应建出 idx_pup_parent 部分索引')

    const row = db
      .prepare('SELECT cost_credits, parent_session_id FROM pending_usage_patches WHERE request_id = ?')
      .get('req-legacy-1') as { cost_credits: string; parent_session_id: string | null }
    assert.equal(row.cost_credits, '42', '旧行数据应原样保留')
    assert.equal(row.parent_session_id, null, '旧行新列应回填为 NULL')
  })

  it('probeSessionsDb 好库返回 ok:true(healthz 深度探活正常路径)', async () => {
    assert.deepEqual(await probeSessionsDb(), { ok: true })
  })
})
