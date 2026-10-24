/** Synthetic actor and PG-shaped sources only; no account, DB, model or filesystem access. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatProject, ClientSessionMeta, ProjectAsset } from '@openclaude/storage'
import { stateReadOperations, type SystemSessionReadBackend } from '../system-assistant/stateReadOperations.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'session_0001', agentId: 'main' }
const project: ChatProject = { id: 'project_0001', name: 'Synthetic project', instructions: 'Synthetic private instructions', color: null, sortOrder: 0,
  createdAt: 1, updatedAt: 2, sessionCount: 3, boardProjectId: null, archivedAt: null, pinnedAt: null, template: null }
const session: ClientSessionMeta = { id: 'session_0001', agentId: 'main', title: 'Synthetic session', pinned: false, createdAt: 1, lastAt: 2, updatedAt: 3,
  messageCount: 4, modelId: 'synthetic-model', projectId: project.id, runState: 'idle', lastOutcome: null, lastErrorCode: null, archived: false, unread: false, lastMessagePreview: 'Synthetic private preview' }
const asset: ProjectAsset = { id: 'asset_0001', projectId: project.id, source: 'upload', sessionId: session.id, name: 'Synthetic asset', url: 'https://invalid.example/private',
  containerPath: '/synthetic/private-file', mime: 'text/plain', sizeBytes: 19, digest: null, excerpt: 'Synthetic private excerpt', pinned: false, createdAt: 1, updatedAt: 2 }
function fixture() {
  const calls: unknown[][] = []
  let allowed = true
  let missing = false
  const sessions: SystemSessionReadBackend = {
    getClientSessionCollabParent: async (id, uid) => { calls.push(['model', uid, id]); return missing ? null : { sessionId: id, userId: uid, agentId: 'main', modelId: 'synthetic-model' } },
    getClientSessionWorkspaceMode: async (id, uid) => { calls.push(['workspace', uid, id]); return missing ? null : 'isolated_v1' },
    listClientSessions: async (uid, args) => { calls.push(['list', uid, args]); return { sessions: [session], nextCursor: 19 } },
    searchClientSessions: async (uid, args) => { calls.push(['search', uid, args]); return { results: [{ sessionId: session.id, title: session.title, projectId: project.id, snippet: 'Synthetic search excerpt', matchedAt: 19, kind: 'message', unread: false }] } },
    listChatProjects: async uid => { calls.push(['projects', uid]); return [project] },
    listDeletedChatProjects: async uid => { calls.push(['deleted', uid]); return [{ id: project.id, name: project.name, deletedAt: 19, sessionCount: 3 }] },
    listProjectAssets: async (uid, args) => { calls.push(['assets', uid, args]); return [asset] },
  }
  const registry = new SystemOperationRegistry(stateReadOperations({ authorize: async () => { if (!allowed) throw new SystemOperationRejected('FORBIDDEN') }, sources: {
    sessions, readProject: async (uid, id) => { calls.push(['project', uid, id]); return missing ? null : project },
    readRuntimeStatus: async uid => { calls.push(['status', uid]); return missing ? null : { state: 'running', lastWsActivity: new Date('2026-10-24T00:00:00Z') } },
  } }))
  return { registry, calls, missing: () => { missing = true }, revoke: () => { allowed = false } }
}
test('fixed state read schemas reject model identity and route fields before any business call', async () => {
  const f = fixture()
  for (const [id, args] of [['sessions.model.get', { sessionId: session.id }], ['sessions.list', {}], ['sessions.search', { q: 'synthetic' }], ['projects.list', {}],
    ['projects.get', { projectId: project.id }], ['projects.deleted.list', {}], ['sessions.workspace-policy.get', { sessionId: session.id }], ['project.assets.list', { projectId: project.id }], ['agent.status.get', {}]] as const) {
    await assert.rejects(f.registry.read(actor, id, { ...args, userId: '8000000766' }))
    await assert.rejects(f.registry.read(actor, id, { ...args, url: 'https://invalid.example/' }))
  }
  await assert.rejects(f.registry.read(actor, 'sessions.list', { limit: 201 }))
  await assert.rejects(f.registry.read(actor, 'sessions.search', { q: ' ' }))
  await assert.rejects(f.registry.read(actor, 'projects.get', { projectId: '../escape' }))
  assert.deepEqual(f.calls, [])
})
test('session list uses canonical c: owner and omits automatic transcript preview', async () => {
  const f = fixture()
  const value = await f.registry.read(actor, 'sessions.list', { before: 19, includeArchived: true }) as { sessions: Record<string, unknown>[]; nextCursor: number }
  assert.deepEqual(f.calls, [['list', 'c:765', { limit: 30, before: 19, includeArchived: true }]])
  assert.equal(value.nextCursor, 19)
  assert.equal(value.sessions[0]?.persistedModelId, 'synthetic-model')
  assert.equal('lastMessagePreview' in value.sessions[0]!, false)
})
test('saved model and workspace are owner-scoped and missing rows are not reported as legacy defaults', async () => {
  const f = fixture()
  assert.deepEqual(await f.registry.read(actor, 'sessions.model.get', { sessionId: session.id }), { sessionId: session.id, agentId: 'main', persistedModelId: 'synthetic-model' })
  assert.deepEqual(await f.registry.read(actor, 'sessions.workspace-policy.get', { sessionId: session.id }), { sessionId: session.id, workspaceMode: 'isolated_v1' })
  assert(f.calls.every(call => call[1] === 'c:765'))
  f.missing()
  for (const id of ['sessions.model.get','sessions.workspace-policy.get']) await assert.rejects(f.registry.read(actor, id, { sessionId: session.id }), error => error instanceof SystemOperationRejected && error.code === 'NOT_FOUND')
})
test('search excerpt is explicit opt-in and is not forwarded as a business filter', async () => {
  const f = fixture()
  const minimal = await f.registry.read(actor, 'sessions.search', { q: 'synthetic', projectId: null }) as { results: Record<string, unknown>[] }
  assert.equal('snippet' in minimal.results[0]!, false)
  const detailed = await f.registry.read(actor, 'sessions.search', { q: 'synthetic', includeSnippet: true }) as { results: Record<string, unknown>[] }
  assert.equal(detailed.results[0]?.snippet, 'Synthetic search excerpt')
  assert(f.calls.every(call => call[1] === 'c:765' && !('includeSnippet' in (call[2] as object))))
})
test('project text is explicit and deleted-project output exposes no restoration manifest', async () => {
  const f = fixture()
  const list = await f.registry.read(actor, 'projects.list', {}) as { projects: Record<string, unknown>[] }
  assert.equal('instructions' in list.projects[0]!, false)
  assert.equal('instructions' in (await f.registry.read(actor, 'projects.get', { projectId: project.id }) as object), false)
  assert.equal((await f.registry.read(actor, 'projects.get', { projectId: project.id, includeInstructions: true }) as { instructions: string }).instructions, project.instructions)
  assert.deepEqual(await f.registry.read(actor, 'projects.deleted.list', {}), { projects: [{ id: project.id, name: project.name, deletedAt: 19, sessionCount: 3 }] })
  assert(f.calls.every(call => call[1] === 'c:765'))
  f.missing(); await assert.rejects(f.registry.read(actor, 'projects.get', { projectId: project.id }))
})
test('asset metadata omits URL, disk path and excerpt', async () => {
  const f = fixture()
  const value = await f.registry.read(actor, 'project.assets.list', { projectId: null }) as { assets: Record<string, unknown>[] }
  const row = value.assets[0]; assert(row)
  for (const key of ['url','containerPath','excerpt']) assert.equal(key in row, false)
  assert.equal(row.versionCount, 1)
  assert.deepEqual(f.calls, [['assets', 'c:765', { projectId: null, limit: 100 }]])
})
test('runtime status uses bare uid, ISO times and no Docker or raw error details', async () => {
  const f = fixture()
  assert.deepEqual(await f.registry.read(actor, 'agent.status.get', {}), { scope: 'v5/docker', observed: { state: 'running', lastActivityAt: '2026-10-24T00:00:00.000Z' }, note: '仅表示容器观察状态，不代表聊天服务已就绪。' })
  assert.deepEqual(f.calls, [['status', '765']])
  f.missing()
  const missing = await f.registry.read(actor, 'agent.status.get', {}) as { observed: unknown; note: string }
  assert.equal(missing.observed, null)
  assert(missing.note.includes('不会启动容器'))
})
test('fresh authorization and absent PG authority fail closed without a hidden SQLite or direct-PG fallback', async () => {
  const f = fixture(); f.revoke()
  await assert.rejects(f.registry.read(actor, 'projects.list', {})); assert.deepEqual(f.calls, [])
  const missing = new SystemOperationRegistry(stateReadOperations({ authorize: async () => {}, sources: { readProject: async () => { throw new Error('must not call direct PG without sessions authority') }, readRuntimeStatus: async () => null } }))
  await assert.rejects(missing.read(actor, 'projects.get', { projectId: project.id }), error => error instanceof SystemOperationRejected && error.code === 'UNAVAILABLE')
})
