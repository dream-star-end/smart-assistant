/**
 * 会话级模型选择(client_sessions.model_id)存储层契约(2026-07-18 per-session 模型持久化批)。
 *
 * 锁定语义:
 *   1. 建行 PUT 携带 modelId → list/get/getPartial 全读路径回带;
 *   2. 既有会话的全量 PUT **未携带** modelId → COALESCE 保留既有值(绝不清空);
 *      携带 → 以 PUT 为准;
 *   3. setClientSessionModel = metadata-only 单列 UPDATE:落值 + updated_at 逻辑版本
 *      单调推进(RETURNING 真实写入值),缺行/软删行 → ok:false;
 *   4. 从未选择的会话:读路径**不落 modelId 键**(缺席=未表态,前端回落 default_model)。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsClientModel.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

// Capture paths at module-load time — must set OPENCLAUDE_HOME first.
const testHome = await mkdtemp(join(tmpdir(), 'oc-sessmodel-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  deleteClientSession,
  getClientSession,
  getClientSessionPartial,
  getSessionsDb,
  listClientSessions,
  setClientSessionModel,
  upsertClientSession,
} = await import('../sessionsDb.js')

const USER = 'c:model-user'

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM client_sessions')
  db.exec('DELETE FROM client_session_archive_chunks')
  db.exec('DELETE FROM client_session_archived_ids')
}

function baseSession(id: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id,
    userId: USER,
    agentId: 'main',
    title: '测试会话',
    pinned: false,
    createdAt: now,
    lastAt: now,
    messages: [] as unknown[],
    updatedAt: now,
    ...overrides,
  }
}

describe('client_sessions.model_id(会话级模型选择)', () => {
  beforeEach(clearTables)

  it('建行 PUT 携带 modelId → get/list/getPartial 全读路径回带', async () => {
    const r = await upsertClientSession(baseSession('sess-model-1', { modelId: 'kimi-k3' }), 0)
    assert.equal(r, 'applied')

    const got = await getClientSession('sess-model-1', USER)
    assert.equal(got?.modelId, 'kimi-k3')

    const list = await listClientSessions(USER)
    assert.equal(list.find((s) => s.id === 'sess-model-1')?.modelId, 'kimi-k3')

    const partial = await getClientSessionPartial('sess-model-1', USER, 0)
    assert.equal(partial?.modelId, 'kimi-k3')
  })

  it('从未选择的会话:读路径不落 modelId 键(缺席=未表态)', async () => {
    await upsertClientSession(baseSession('sess-model-none'), 0)
    const got = await getClientSession('sess-model-none', USER)
    assert.ok(got)
    assert.equal('modelId' in got, false)
    const meta = (await listClientSessions(USER)).find((s) => s.id === 'sess-model-none')
    assert.ok(meta)
    assert.equal('modelId' in meta, false)
  })

  it('全量 PUT 未携带 modelId → COALESCE 保留既有值;携带则覆盖', async () => {
    await upsertClientSession(baseSession('sess-model-2', { modelId: 'gpt-5.5' }), 0)
    const v1 = await getClientSession('sess-model-2', USER)
    assert.equal(v1?.modelId, 'gpt-5.5')

    // 未携带(客户端全量同步不表态)→ 保留
    const r2 = await upsertClientSession(baseSession('sess-model-2'), v1!.updatedAt)
    assert.equal(r2, 'applied')
    const v2 = await getClientSession('sess-model-2', USER)
    assert.equal(v2?.modelId, 'gpt-5.5')

    // 携带 → 覆盖
    const r3 = await upsertClientSession(
      baseSession('sess-model-2', { modelId: 'glm-5.2' }),
      v2!.updatedAt,
    )
    assert.equal(r3, 'applied')
    const v3 = await getClientSession('sess-model-2', USER)
    assert.equal(v3?.modelId, 'glm-5.2')
  })

  it('setClientSessionModel:落值 + updated_at 单调推进(RETURNING 真实写入值)', async () => {
    await upsertClientSession(baseSession('sess-model-3'), 0)
    const before = await getClientSession('sess-model-3', USER)
    assert.ok(before)

    const r = await setClientSessionModel('sess-model-3', USER, 'claude-fable-5')
    assert.equal(r.ok, true)
    assert.ok(r.updatedAt > before!.updatedAt, 'updated_at 必须严格推进(逻辑版本)')

    const after = await getClientSession('sess-model-3', USER)
    assert.equal(after?.modelId, 'claude-fable-5')
    assert.equal(after?.updatedAt, r.updatedAt, 'RETURNING 的 token 必须等于真实写入值')
  })

  it('setClientSessionModel:缺行 / 他人行 / 软删行 → ok:false 不误写', async () => {
    const missing = await setClientSessionModel('sess-model-nope', USER, 'kimi-k3')
    assert.equal(missing.ok, false)

    await upsertClientSession(baseSession('sess-model-4'), 0)
    const other = await setClientSessionModel('sess-model-4', 'c:someone-else', 'kimi-k3')
    assert.equal(other.ok, false)
    const intact = await getClientSession('sess-model-4', USER)
    assert.equal('modelId' in intact!, false, '他人 PATCH 不得写入本行')

    await deleteClientSession('sess-model-4', USER)
    const deleted = await setClientSessionModel('sess-model-4', USER, 'kimi-k3')
    assert.equal(deleted.ok, false)
  })
})
