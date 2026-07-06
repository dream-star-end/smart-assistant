/**
 * probeSessionsDb 坏库路径 —— healthz 深度探活的核心承诺:
 * sessions.db 打不开(损坏/schema 事故)时返回 { ok:false, error },**从不 throw**,
 * 且反复调用行为一致(getSessionsDb 失败不缓存,每次重试)。
 *
 * 独立文件:模块级 _db 缓存按进程隔离,不能与好库场景同进程。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/probeSessionsDbCorrupt.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-probe-corrupt-'))
process.env.OPENCLAUDE_HOME = testHome

// 预写垃圾字节:open 时 "file is not a database"(与 2026-07-06 schema 事故同类:
// getSessionsDb 在 open/DDL 阶段抛)。
await writeFile(join(testHome, 'sessions.db'), 'not a sqlite database at all')

const { probeSessionsDb } = await import('../sessionsDb.js')

describe('probeSessionsDb 坏库', () => {
  it('open 失败返回 ok:false 带 error,不抛,可重复探测', async () => {
    const p1 = await probeSessionsDb()
    assert.equal(p1.ok, false, '坏库应返回 ok:false')
    assert.ok(!p1.ok && p1.error.length > 0, '应携带错误说明')

    const p2 = await probeSessionsDb()
    assert.equal(p2.ok, false, '失败不被缓存成假 ok,重复探测仍如实返回 bad')
  })
})
