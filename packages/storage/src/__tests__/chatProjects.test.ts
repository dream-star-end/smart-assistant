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
  createProjectAsset,
  deleteChatProject,
  deleteClientSession,
  listDeletedChatProjects,
  listProjectAssets,
  restoreChatProject,
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

  it('1:1 board_project_id bind is permanent; cross-user isolation', async () => {
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
    // Memory, skills, cron and billing hang off the board id: no unbind, no rebind.
    const unbind = await updateChatProject(USER, a.project.id, { boardProjectId: null })
    assert.equal(unbind.ok, false)
    if (!unbind.ok) assert.equal(unbind.error, 'board_project_bound')
    const rebind = await updateChatProject(USER, a.project.id, { boardProjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })
    assert.equal(rebind.ok, false)
    const same = await updateChatProject(USER, a.project.id, { boardProjectId: board })
    assert.equal(same.ok, true)
    const invalid = await updateChatProject(USER, b.project.id, { boardProjectId: 'not-a-uuid' })
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.equal(invalid.error, 'invalid_board_project_id')
  })

  it('bound updates do not write instructions to PG (PROJECT.md is the authority)', async () => {
    const created = await createChatProject(USER, { name: 'BoundIns', instructions: 'pg-seed' })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const board = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const bound = await updateChatProject(USER, created.project.id, { boardProjectId: board })
    assert.equal(bound.ok, true)
    const skipped = await updateChatProject(USER, created.project.id, { instructions: 'should-not-land' })
    assert.equal(skipped.ok, true)
    if (skipped.ok) assert.equal(skipped.project.instructions, 'pg-seed')
  })

  it('project layer on: a new project reserves its board id; research default never does', async () => {
    const reserved = await createChatProject(USER, { name: 'Reserved', reserveBoard: true, template: 'research' })
    assert.equal(reserved.ok, true)
    if (!reserved.ok) return
    assert.match(reserved.project.boardProjectId ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(reserved.project.template, 'research')
    const plain = await createChatProject(USER, { name: 'Plain' })
    assert.equal(plain.ok && plain.project.boardProjectId, null)
    const research = await createChatProject(USER, { name: 'Lib', isResearchDefault: true, reserveBoard: true })
    assert.equal(research.ok && research.project.boardProjectId, null)
    const bad = await createChatProject(USER, { name: 'Bad', template: 'novel' })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.error, 'invalid_template')
  })

  it('archive and pin are reversible flags; a repeat keeps the first timestamp', async () => {
    const created = await createChatProject(USER, { name: 'Flags' })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const archived = await updateChatProject(USER, created.project.id, { archived: true, pinned: true })
    assert.equal(archived.ok, true)
    if (!archived.ok) return
    assert.ok(archived.project.archivedAt && archived.project.pinnedAt)
    const again = await updateChatProject(USER, created.project.id, { archived: true })
    assert.equal(again.ok && again.project.archivedAt, archived.project.archivedAt)
    const restored = await updateChatProject(USER, created.project.id, { archived: false, pinned: false })
    assert.equal(restored.ok && restored.project.archivedAt, null)
    assert.equal(restored.ok && restored.project.pinnedAt, null)
    const bad = await updateChatProject(USER, created.project.id, { archived: 'yes' })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.error, 'invalid_flag')
    const listed = (await listChatProjects(USER)).find((p) => p.id === created.project.id)
    assert.equal(listed?.archivedAt, null)
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

  it('delete keeps a manifest; restore relinks what is still ungrouped and returns the paused cron jobs', async () => {
    const created = await createChatProject(USER, { name: 'Restorable' })
    const other = await createChatProject(USER, { name: 'Elsewhere' })
    assert.equal(created.ok && other.ok, true)
    if (!created.ok || !other.ok) return
    const pid = created.project.id
    await upsertClientSession(baseSession('sess-r1'))
    await upsertClientSession(baseSession('sess-r2'))
    await patchClientSessionMeta('sess-r1', USER, { projectId: pid })
    await patchClientSessionMeta('sess-r2', USER, { projectId: pid })
    const asset = await createProjectAsset(USER, {
      projectId: pid, source: 'upload', name: 'a.md', url: `/api/media/${'a'.repeat(64)}.md`,
    })
    assert.equal(asset.ok, true)
    const del = await deleteChatProject(USER, pid, { pausedCronJobIds: ['job-1'] })
    assert.equal(del.ok, true)
    assert.equal((await listProjectAssets(USER, { projectId: null })).some((a) => a.name === 'a.md'), true)
    const deleted = await listDeletedChatProjects(USER)
    assert.equal(deleted.find((d) => d.id === pid)?.sessionCount, 2)
    // The user files one chat elsewhere meanwhile; restore must not pull it back.
    await patchClientSessionMeta('sess-r2', USER, { projectId: other.project.id })
    const restored = await restoreChatProject(USER, pid)
    assert.equal(restored.ok, true)
    if (!restored.ok) return
    assert.deepEqual(restored.pausedCronJobIds, ['job-1'])
    assert.equal(restored.relinkedSessions, 1)
    assert.equal(restored.relinkedAssets, 1)
    const { sessions } = await listClientSessions(USER)
    assert.equal(sessions.find((x) => x.id === 'sess-r1')?.projectId, pid)
    assert.equal(sessions.find((x) => x.id === 'sess-r2')?.projectId, other.project.id)
    assert.equal((await listDeletedChatProjects(USER)).some((d) => d.id === pid), false)
    const again = await restoreChatProject(USER, pid)
    assert.equal(again.ok, false)
  })

  it('restore after the window is refused; another user cannot restore', async () => {
    const created = await createChatProject(USER, { name: 'Old' })
    assert.equal(created.ok, true)
    if (!created.ok) return
    await deleteChatProject(USER, created.project.id)
    const foreign = await restoreChatProject(OTHER, created.project.id)
    assert.equal(foreign.ok, false)
    const db = await getSessionsDb()
    db.prepare('UPDATE chat_projects SET deleted_at = ? WHERE id = ?').run(Date.now() - 31 * 86400000, created.project.id)
    const late = await restoreChatProject(USER, created.project.id)
    assert.equal(late.ok, false)
    if (!late.ok) assert.equal(late.error, 'expired')
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

  it('is_research_default 自愈列 + unique:第二次创建回读已有默认课题', async () => {
    const db = await getSessionsDb()
    const cols = db.pragma('table_info(chat_projects)') as Array<{ name: string }>
    assert.ok(cols.some((c) => c.name === 'is_research_default'))
    const a = await createChatProject(USER, { name: '默认课题', isResearchDefault: true })
    assert.equal(a.ok, true)
    if (!a.ok) return
    const b = await createChatProject(USER, { name: '另一个默认', isResearchDefault: true })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.project.id, a.project.id)
    const n = db.prepare(
      'SELECT COUNT(*) AS n FROM chat_projects WHERE user_id = ? AND is_research_default = 1 AND deleted_at IS NULL',
    ).get(USER) as { n: number }
    assert.equal(n.n, 1)
  })
})
