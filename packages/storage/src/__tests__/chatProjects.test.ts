/**
 * 侧栏聊天项目(chat_projects)存储契约。
 *
 * 锁定:
 *   1. CRUD 按 user_id 隔离,他人读写 → not_found(不泄漏存在性);
 *   2. 删除项目软删 + 其下会话 project_id 置 NULL,会话本身不被删;
 *   3. 每用户 100 上限;
 *   4. list 带 sessionCount(仅未删除会话)。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/chatProjects.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-chatproj-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  CHAT_PROJECT_PER_USER_LIMIT,
  createChatProject,
  deleteChatProject,
  deleteClientSession,
  getClientSession,
  getSessionsDb,
  listChatProjects,
  listClientSessions,
  patchClientSessionMeta,
  updateChatProject,
  upsertClientSession,
} = await import('../sessionsDb.js')

const USER = 'c:proj-user'
const OTHER = 'c:other-user'

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM client_sessions')
  db.exec('DELETE FROM chat_projects')
}

function baseSession(id: string, userId = USER) {
  const now = Date.now()
  return {
    id,
    userId,
    agentId: 'main',
    title: '测试会话',
    pinned: false,
    createdAt: now,
    lastAt: now,
    messages: [] as unknown[],
    updatedAt: now,
  }
}

describe('chat_projects CRUD', () => {
  beforeEach(clearTables)

  it('POST 校验:trim 名称、长度、空名拒绝', async () => {
    const empty = await createChatProject(USER, { name: '   ' })
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.error, 'invalid_name')

    const long = await createChatProject(USER, { name: 'x'.repeat(61) })
    assert.equal(long.ok, false)

    const ok = await createChatProject(USER, { name: '  我的项目  ', instructions: '  hi  ', color: 'blue' })
    assert.equal(ok.ok, true)
    if (!ok.ok) return
    assert.equal(ok.project.name, '我的项目')
    assert.equal(ok.project.instructions, 'hi')
    assert.equal(ok.project.color, 'blue')
    assert.equal(ok.project.sessionCount, 0)
    assert.ok(ok.project.id.length >= 8)
    assert.equal(ok.project.boardProjectId, null)
  })

  it('1:1 board_project_id bind, unbind, cross-user isolation', async () => {
    const a = await createChatProject(USER, { name: 'A' })
    const b = await createChatProject(USER, { name: 'B' })
    const other = await createChatProject(OTHER, { name: 'X' })
    assert.equal(a.ok && b.ok && other.ok, true)
    if (!a.ok || !b.ok || !other.ok) return
    const board = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const bindA = await updateChatProject(USER, a.project.id, { boardProjectId: board })
    assert.equal(bindA.ok, true)
    if (!bindA.ok) return
    assert.equal(bindA.project.boardProjectId, board)
    const conflict = await updateChatProject(USER, b.project.id, { boardProjectId: board })
    assert.equal(conflict.ok, false)
    if (!conflict.ok) assert.equal(conflict.error, 'board_project_bound')
    const otherBind = await updateChatProject(OTHER, other.project.id, { boardProjectId: board })
    assert.equal(otherBind.ok, true)
    const unbind = await updateChatProject(USER, a.project.id, { boardProjectId: null })
    assert.equal(unbind.ok, true)
    if (unbind.ok) assert.equal(unbind.project.boardProjectId, null)
    const invalid = await updateChatProject(USER, b.project.id, { boardProjectId: 'not-a-uuid' })
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.equal(invalid.error, 'invalid_board_project_id')
  })

  it('bound updates do not write instructions to PG; unbind restores PG authority', async () => {
    const created = await createChatProject(USER, { name: 'BoundIns', instructions: 'pg-seed' })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const board = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const bound = await updateChatProject(USER, created.project.id, { boardProjectId: board })
    assert.equal(bound.ok, true)
    const skipped = await updateChatProject(USER, created.project.id, { instructions: 'should-not-land' })
    assert.equal(skipped.ok, true)
    if (skipped.ok) assert.equal(skipped.project.instructions, 'pg-seed')
    const unbound = await updateChatProject(USER, created.project.id, { boardProjectId: null })
    assert.equal(unbound.ok, true)
    if (unbound.ok) assert.equal(unbound.project.instructions, 'pg-seed')
    const after = await updateChatProject(USER, created.project.id, { instructions: 'pg-after-unbind' })
    assert.equal(after.ok, true)
    if (after.ok) assert.equal(after.project.instructions, 'pg-after-unbind')
  })

  it('list 按 sort_order ASC, created_at ASC;sessionCount 只计未删会话', async () => {
    const a = await createChatProject(USER, { name: 'A' })
    const b = await createChatProject(USER, { name: 'B' })
    assert.equal(a.ok && b.ok, true)
    if (!a.ok || !b.ok) return
    await updateChatProject(USER, a.project.id, { sortOrder: 2 })
    await updateChatProject(USER, b.project.id, { sortOrder: 1 })
    await upsertClientSession(baseSession('sess-in-b'))
    await upsertClientSession(baseSession('sess-in-b-del'))
    await patchClientSessionMeta('sess-in-b', USER, { projectId: b.project.id })
    await patchClientSessionMeta('sess-in-b-del', USER, { projectId: b.project.id })
    await deleteClientSession('sess-in-b-del', USER)

    const list = await listChatProjects(USER)
    assert.deepEqual(list.map((p) => p.name), ['B', 'A'])
    assert.equal(list[0]?.sessionCount, 1)
    assert.equal(list[1]?.sessionCount, 0)
    assert.equal((await listChatProjects(OTHER)).length, 0)
  })

  it('他人 PATCH/DELETE 项目 → not_found,不误写', async () => {
    const created = await createChatProject(USER, { name: '私有' })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const patched = await updateChatProject(OTHER, created.project.id, { name: '劫持' })
    assert.equal(patched.ok, false)
    if (!patched.ok) assert.equal(patched.error, 'not_found')
    const deleted = await deleteChatProject(OTHER, created.project.id)
    assert.equal(deleted.ok, false)
    const still = await listChatProjects(USER)
    assert.equal(still[0]?.name, '私有')
  })

  it('删除项目:软删 + 会话变未分组且不被删', async () => {
    const created = await createChatProject(USER, { name: '将删' })
    assert.equal(created.ok, true)
    if (!created.ok) return
    await upsertClientSession(baseSession('sess-keep'))
    const linked = await patchClientSessionMeta('sess-keep', USER, { projectId: created.project.id })
    assert.equal(linked.ok, true)
    assert.equal((await listClientSessions(USER)).sessions.find((s) => s.id === 'sess-keep')?.projectId, created.project.id)

    const del = await deleteChatProject(USER, created.project.id)
    assert.equal(del.ok, true)
    assert.equal((await listChatProjects(USER)).length, 0)
    const session = await getClientSession('sess-keep', USER)
    assert.ok(session, '会话必须还在')
    assert.equal((await listClientSessions(USER)).sessions.find((s) => s.id === 'sess-keep')?.projectId, null)
  })

  it('会话 PATCH projectId:null 移出;不存在/他人项目 → project_not_found', async () => {
    const mine = await createChatProject(USER, { name: '我的' })
    const theirs = await createChatProject(OTHER, { name: '别人' })
    assert.equal(mine.ok && theirs.ok, true)
    if (!mine.ok || !theirs.ok) return
    await upsertClientSession(baseSession('sess-move'))

    const bad = await patchClientSessionMeta('sess-move', USER, { projectId: 'nope-nope-nope' })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.error, 'project_not_found')

    const steal = await patchClientSessionMeta('sess-move', USER, { projectId: theirs.project.id })
    assert.equal(steal.ok, false)
    if (!steal.ok) assert.equal(steal.error, 'project_not_found')

    const ok = await patchClientSessionMeta('sess-move', USER, { projectId: mine.project.id, pinned: true })
    assert.equal(ok.ok, true)
    const meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'sess-move')
    assert.equal(meta?.projectId, mine.project.id)
    assert.equal(meta?.pinned, true)

    const ungroup = await patchClientSessionMeta('sess-move', USER, { projectId: null })
    assert.equal(ungroup.ok, true)
    assert.equal((await listClientSessions(USER)).sessions.find((s) => s.id === 'sess-move')?.projectId, null)
  })

  it('他人会话 PATCH 失败;每用户上限 100', async () => {
    await upsertClientSession(baseSession('sess-u'))
    const created = await createChatProject(USER, { name: 'x' })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const otherSess = await patchClientSessionMeta('sess-u', OTHER, { projectId: created.project.id })
    assert.equal(otherSess.ok, false)
    if (!otherSess.ok) assert.equal(otherSess.error, 'not_found')

    for (let i = 1; i < CHAT_PROJECT_PER_USER_LIMIT; i++) {
      const r = await createChatProject(USER, { name: `p${i}` })
      assert.equal(r.ok, true, `create #${i + 1}`)
    }
    const overflow = await createChatProject(USER, { name: 'overflow' })
    assert.equal(overflow.ok, false)
    if (!overflow.ok) assert.equal(overflow.error, 'limit_exceeded')
    assert.equal((await createChatProject(OTHER, { name: '别人不受影响' })).ok, true)
  })
})
