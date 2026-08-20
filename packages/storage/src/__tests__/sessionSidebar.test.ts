/**
 * 侧栏会话:归档 / 批量 / 搜索 / 列表分页 / 项目指令查找。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionSidebar.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-sess-sidebar-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  batchClientSessions,
  buildSearchSnippet,
  createChatProject,
  deleteChatProject,
  getSessionProjectInstructions,
  getSessionsDb,
  listClientSessions,
  patchClientSessionMeta,
  searchClientSessions,
  toLastMessagePreview,
  upsertClientSession,
} = await import('../sessionsDb.js')

const USER = 'c:sidebar-user'
const OTHER = 'c:sidebar-other'

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM client_session_archive_chunks')
  db.exec('DELETE FROM client_session_archived_ids')
  db.exec('DELETE FROM client_sessions')
  db.exec('DELETE FROM chat_projects')
}

function sess(id: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id,
    userId: USER,
    agentId: 'main',
    title: id,
    pinned: false,
    createdAt: now,
    lastAt: now,
    messages: [] as unknown[],
    updatedAt: now,
    ...overrides,
  }
}

describe('toLastMessagePreview / buildSearchSnippet', () => {
  it('去掉代码块、图片、HTML 与换行,截 80 字', () => {
    const preview = toLastMessagePreview('hello\n```js\ncode()\n```\n![x](a.png)<b>world</b>\nmore')
    assert.ok(preview)
    assert.doesNotMatch(preview, /```|!\[|<b>|[\n]/)
    assert.ok(preview.length <= 80)
  })

  it('命中前后各 40 字,上限 160', () => {
    const hay = `${'前'.repeat(50)}关键词${'后'.repeat(50)}`
    const snippet = buildSearchSnippet(hay, '关键词')
    assert.match(snippet, /关键词/)
    assert.ok(snippet.startsWith('…'))
    assert.ok(snippet.endsWith('…'))
    assert.ok(snippet.length <= 160)
  })
})

describe('listClientSessions 归档/分页/预览', () => {
  beforeEach(clearTables)

  it('默认排除归档;includeArchived 才带上;每项 archived', async () => {
    await upsertClientSession(sess('web-open', { lastAt: 2000 }))
    await upsertClientSession(sess('web-arc', { lastAt: 3000 }))
    const archived = await patchClientSessionMeta('web-arc', USER, { archived: true })
    assert.equal(archived.ok, true)

    const def = await listClientSessions(USER)
    assert.deepEqual(def.sessions.map((s) => s.id), ['web-open'])
    assert.equal(def.sessions[0]?.archived, false)
    assert.equal('nextCursor' in def, false)

    const all = await listClientSessions(USER, { includeArchived: true })
    assert.deepEqual(all.sessions.map((s) => s.id), ['web-arc', 'web-open'])
    assert.equal(all.sessions[0]?.archived, true)
  })

  it('不传 limit 全量无 cursor;limit+before 分页', async () => {
    await upsertClientSession(sess('web-a', { lastAt: 1000, title: 'A' }))
    await upsertClientSession(sess('web-b', { lastAt: 2000, title: 'B' }))
    await upsertClientSession(sess('web-c', { lastAt: 3000, title: 'C' }))

    const full = await listClientSessions(USER)
    assert.equal(full.sessions.length, 3)
    assert.equal(full.nextCursor, undefined)

    const page1 = await listClientSessions(USER, { limit: 2 })
    assert.deepEqual(page1.sessions.map((s) => s.id), ['web-c', 'web-b'])
    assert.equal(page1.nextCursor, 2000)

    const page2 = await listClientSessions(USER, { limit: 2, before: page1.nextCursor })
    assert.deepEqual(page2.sessions.map((s) => s.id), ['web-a'])
    assert.equal(page2.nextCursor, undefined)
  })

  it('lastMessagePreview 取最后一条纯文本前 80 字;空消息不带', async () => {
    await upsertClientSession(sess('web-empty'))
    await upsertClientSession(sess('web-msg', {
      messages: [
        { id: 'm1', role: 'user', text: 'old', ts: 1 },
        { id: 'm2', role: 'assistant', text: '最后一条 **答案**\n换行', ts: 2 },
      ],
    }))
    const list = await listClientSessions(USER)
    const empty = list.sessions.find((s) => s.id === 'web-empty')
    const msg = list.sessions.find((s) => s.id === 'web-msg')
    assert.equal('lastMessagePreview' in (empty ?? {}), false)
    assert.equal(msg?.lastMessagePreview, '最后一条 **答案** 换行')
  })
})

describe('searchClientSessions', () => {
  beforeEach(clearTables)

  it('空 q 返回空数组;按 user 隔离;软删排除', async () => {
    await upsertClientSession(sess('web-hit', {
      title: '命中标题',
      lastAt: 5000,
      messages: [{ id: 'm', role: 'user', text: '正文里有关键词苹果汁', ts: 4000 }],
    }))
    await upsertClientSession({ ...sess('web-other', { title: '苹果汁别人' }), userId: OTHER })
    const db = await getSessionsDb()
    db.prepare("UPDATE client_sessions SET deleted_at = 1 WHERE id = 'web-gone'").run()
    await upsertClientSession(sess('web-gone', { title: '苹果汁已删' }))
    db.prepare("UPDATE client_sessions SET deleted_at = 9 WHERE id = 'web-gone'").run()

    assert.deepEqual((await searchClientSessions(USER, { q: '   ' })).results, [])
    const hits = await searchClientSessions(USER, { q: '苹果汁' })
    assert.equal(hits.results.length, 1)
    assert.equal(hits.results[0]?.sessionId, 'web-hit')
    assert.equal(hits.results[0]?.kind, 'message')
    assert.match(hits.results[0]?.snippet ?? '', /苹果汁/)
  })

  it('标题命中 kind=title;归档默认不搜', async () => {
    await upsertClientSession(sess('web-t', { title: '项目排期', lastAt: 9 }))
    await upsertClientSession(sess('web-arch', { title: '项目排期归档', lastAt: 10 }))
    await patchClientSessionMeta('web-arch', USER, { archived: true })
    const def = await searchClientSessions(USER, { q: '排期' })
    assert.deepEqual(def.results.map((r) => r.sessionId), ['web-t'])
    assert.equal(def.results[0]?.kind, 'title')
    const all = await searchClientSessions(USER, { q: '排期', includeArchived: true })
    assert.equal(all.results.length, 2)
  })

  it('超大 messages 行走 TEXT 兜底,不 JSON 展开,仍给出 kind=message', async () => {
    const db = await getSessionsDb()
    const now = Date.now()
    const blob = `[{"id":"m","role":"user","text":"超大行里有独特词XYUNIQUEPROBE","ts":${now}},${'{"id":"pad","role":"assistant","text":"x","ts":1},'.repeat(80_000)}"pad"]`
    assert.ok(Buffer.byteLength(blob, 'utf8') > 2 * 1024 * 1024)
    db.prepare(`
      INSERT INTO client_sessions (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at)
      VALUES ('web-huge', ?, 'main', 'huge-title', 0, ?, ?, ?, 1, ?)
    `).run(USER, now, now, blob, now)
    const hits = await searchClientSessions(USER, { q: 'XYUNIQUEPROBE' })
    assert.equal(hits.results.length, 1)
    assert.equal(hits.results[0]?.sessionId, 'web-huge')
    assert.equal(hits.results[0]?.kind, 'message')
    assert.match(hits.results[0]?.snippet ?? '', /XYUNIQUEPROBE/)
  })
})

describe('batchClientSessions + 项目指令查找', () => {
  beforeEach(clearTables)

  it('archive/unarchive/delete/move;越权跳过', async () => {
    await upsertClientSession(sess('web-1'))
    await upsertClientSession(sess('web-2'))
    await upsertClientSession({ ...sess('web-x'), userId: OTHER })
    const proj = await createChatProject(USER, { name: '箱' })
    assert.equal(proj.ok, true)
    if (!proj.ok) return

    const arch = await batchClientSessions(USER, {
      ids: ['web-1', 'web-x', 'web-missing-id'],
      action: 'archive',
    })
    assert.equal(arch.ok, true)
    if (!arch.ok) return
    assert.equal(arch.updated, 1)
    assert.equal(arch.skipped, 2)
    assert.equal((await listClientSessions(USER)).sessions.find((s) => s.id === 'web-1'), undefined)
    assert.equal((await listClientSessions(USER, { includeArchived: true })).sessions.find((s) => s.id === 'web-1')?.archived, true)

    const unarch = await batchClientSessions(USER, { ids: ['web-1'], action: 'unarchive' })
    assert.equal(unarch.ok, true)
    if (unarch.ok) assert.equal(unarch.updated, 1)

    const moved = await batchClientSessions(USER, {
      ids: ['web-1', 'web-2'],
      action: 'move',
      projectId: proj.project.id,
    })
    assert.equal(moved.ok, true)
    assert.equal((await listClientSessions(USER)).sessions.find((s) => s.id === 'web-1')?.projectId, proj.project.id)

    const stealSess = await batchClientSessions(OTHER, {
      ids: ['web-1'],
      action: 'unarchive',
    })
    assert.equal(stealSess.ok, true)
    if (stealSess.ok) {
      assert.equal(stealSess.updated, 0)
      assert.equal(stealSess.skipped, 1)
    }
    const stealProj = await batchClientSessions(OTHER, {
      ids: ['web-1'],
      action: 'move',
      projectId: proj.project.id,
    })
    assert.equal(stealProj.ok, false)
    if (!stealProj.ok) assert.equal(stealProj.error, 'project_not_found')

    const del = await batchClientSessions(USER, { ids: ['web-2'], action: 'delete' })
    assert.equal(del.ok, true)
    if (del.ok) assert.equal(del.updated, 1)
    assert.equal((await listClientSessions(USER, { includeArchived: true })).sessions.find((s) => s.id === 'web-2'), undefined)
  })

  it('getSessionProjectInstructions:有指令才返回;空/软删/无项目为 null', async () => {
    const withInst = await createChatProject(USER, { name: '有指令', instructions: '用中文回复' })
    const empty = await createChatProject(USER, { name: '空指令' })
    const doomed = await createChatProject(USER, { name: '将删', instructions: '不该出现' })
    assert.equal(withInst.ok && empty.ok && doomed.ok, true)
    if (!withInst.ok || !empty.ok || !doomed.ok) return

    await upsertClientSession(sess('web-p'))
    await upsertClientSession(sess('web-empty'))
    await upsertClientSession(sess('web-none'))
    await upsertClientSession(sess('web-del'))
    await patchClientSessionMeta('web-p', USER, { projectId: withInst.project.id })
    await patchClientSessionMeta('web-empty', USER, { projectId: empty.project.id })
    await patchClientSessionMeta('web-del', USER, { projectId: doomed.project.id })
    await deleteChatProject(USER, doomed.project.id)

    assert.equal(await getSessionProjectInstructions('web-p'), '用中文回复')
    assert.equal(await getSessionProjectInstructions('web-empty'), null)
    assert.equal(await getSessionProjectInstructions('web-none'), null)
    assert.equal(await getSessionProjectInstructions('web-del'), null)
  })
})
