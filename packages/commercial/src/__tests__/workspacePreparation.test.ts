import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleWorkspacePrepare } from '../http/agent.js'
import { signAccess } from '../auth/jwt.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorkspacePreparation } from '../agent-sandbox/workspacePreparation.js'
const tick = () => new Promise(r => setImmediate(r))
test('workspace preparation is authorized, bounded, throttled, and never queues inference', async () => {
  const wakes: bigint[] = []
  let release = () => {}
  const waiting = new Promise<void>(r => { release = r })
  const warm = makeWorkspacePreparation({ authorize: async uid => { if (uid === 9n) throw Error('forbidden') },
    ensureReady: async uid => { wakes.push(uid); await waiting }, warn: () => {} })
  await assert.rejects(warm(9n), /forbidden/)
  assert.deepEqual(wakes, [])
  assert.equal(await warm(1n), true)
  assert.equal(await warm(1n), false)
  assert.equal(await warm(2n), true)
  assert.equal(await warm(3n), false)
  await tick()
  assert.deepEqual(wakes, [1n, 2n])
  release(); await tick()
  assert.equal(await warm(1n), false)
})
test('background wake rejection is swallowed and ordinary connection can still proceed', async () => {
  const warnings: unknown[] = []
  const warm = makeWorkspacePreparation({ authorize: async () => {}, ensureReady: async () => { throw Error('PRIVATE') },
    warn: fields => warnings.push(fields) })
  assert.equal(await warm(1n), true)
  await tick()
  assert.deepEqual(warnings, [{ uid: '1', outcome: 'failed' }])
})

test('even a failing warning sink cannot reject background preparation', async () => {
  const warm = makeWorkspacePreparation({ authorize: async () => {},
    ensureReady: async () => { throw Error('offline') }, warn: () => { throw Error('sink') } })
  assert.equal(await warm(1n), true)
  await tick()
})

test('workspace HTTP hint authenticates JWT before waking and cannot select another user', async () => {
  const jwtSecret = 'isolated-workspace-hint-fixture-'.repeat(2)
  const wakes: bigint[] = []
  const deps = { jwtSecret, prepareWorkspaceContainer: async (uid: bigint) => { wakes.push(uid); return true } } as unknown as Parameters<typeof handleWorkspacePrepare>[3]
  let response = ''
  const res = { statusCode: 0, setHeader: () => {}, end: (body: string) => { response = body } } as unknown as ServerResponse
  const context = {} as Parameters<typeof handleWorkspacePrepare>[2]
  await assert.rejects(handleWorkspacePrepare({ headers: {} } as IncomingMessage, res, context, deps),
    (err: unknown) => (err as { status?: number }).status === 401)
  assert.deepEqual(wakes, [])
  const { token } = await signAccess({ sub: '42', role: 'user' }, jwtSecret)
  const req = Object.assign(Readable.from([]), { headers: { authorization: 'Bearer '.concat(token) }, url: '/api/agent/prepare?userId=999' }) as IncomingMessage
  await handleWorkspacePrepare(req, res, context, deps)
  assert.deepEqual(wakes, [42n])
  assert.equal(res.statusCode, 202)
  assert.deepEqual(JSON.parse(response), { accepted: true })
})
test('HTTP preparation propagates admission denial without an accepted response', async () => {
  const jwtSecret = 'isolated-workspace-denial-fixture-'.repeat(2)
  const { token } = await signAccess({ sub: '42', role: 'user' }, jwtSecret)
  const deps = { jwtSecret, prepareWorkspaceContainer: async () => { throw Error('MAINTENANCE') } } as unknown as Parameters<typeof handleWorkspacePrepare>[3]
  let ended = false
  const res = { setHeader: () => {}, end: () => { ended = true } } as unknown as ServerResponse
  await assert.rejects(handleWorkspacePrepare(Object.assign(Readable.from([]), { headers: { authorization: 'Bearer '.concat(token) } }) as IncomingMessage,
    res, {} as Parameters<typeof handleWorkspacePrepare>[2], deps), /MAINTENANCE/)
  assert.equal(ended, false)
})

test('draft HTTP body is bounded, JWT-owned and drops client workspace/route authority', async () => {
  const jwtSecret = 'isolated-workspace-draft-fixture-'.repeat(2)
  const { token } = await signAccess({ sub: '42', role: 'user' }, jwtSecret)
  const seen: unknown[] = []
  const deps = { jwtSecret, prepareWorkspaceContainer: async (uid: bigint, draft: unknown) => { seen.push([uid, draft]); return true } } as unknown as Parameters<typeof handleWorkspacePrepare>[3]
  const hint = { viewId: 'view_12345', revision: 1, sessionId: 'draft_12345', agentId: 'main', modelId: 'gpt-6.1-sol', effortLevel: null }
  const req = (body: unknown) => Object.assign(Readable.from([JSON.stringify(body)]),
    { headers: { authorization: 'Bearer '.concat(token) } }) as IncomingMessage
  const res = { setHeader: () => {}, end: () => {} } as unknown as ServerResponse
  const ctx = {} as Parameters<typeof handleWorkspacePrepare>[2]
  await handleWorkspacePrepare(req({ ...hint, userId: '999', workspaceMode: 'legacy', route: 'paid' }), res, ctx, deps)
  assert.deepEqual(seen, [[42n, hint]])
  await assert.rejects(handleWorkspacePrepare(req({ ...hint, revision: -1 }), res, ctx, deps),
    (error: unknown) => (error as { status: number }).status === 400)
  assert.equal(seen.length, 1)
})
