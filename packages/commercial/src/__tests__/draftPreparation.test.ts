import test from 'node:test'
import assert from 'node:assert/strict'
import { makeDraftPreparation, makePreparationReady, parseDraftPreparation, type DraftPreparationHint } from '../agent-sandbox/draftPreparation.js'
import { makeWorkspacePreparation } from '../agent-sandbox/workspacePreparation.js'
const tick = () => new Promise(r => setImmediate(r))
const hint = (revision = 1): DraftPreparationHint => ({
  viewId: 'view_12345', sessionId: 'draft_12345', agentId: 'main', modelId: 'gpt-6.1-sol', effortLevel: 'high', revision,
})
function gate() { let release = () => {}; const wait = new Promise<void>(r => { release = r }); return { wait, release } }
test('login wake cannot swallow draft; cold readiness fences latest model/effort before engine hint', async () => {
  const ready = gate()
  const ensureCalls: bigint[] = []
  const engines: DraftPreparationHint[] = []
  const shared = makePreparationReady(async uid => { ensureCalls.push(uid); await ready.wait })
  const login = makeWorkspacePreparation({ authorize: async () => {}, ensureReady: shared, warn: () => {} })
  const draft = makeDraftPreparation({ enabled: () => true, authorize: async () => {}, ensureReady: shared,
    prepareEngine: async (_uid, h, isCurrent) => { assert.equal(isCurrent(), true); engines.push(h) }, observe: () => {} })
  assert.equal(await login(42n), true)
  assert.equal(await draft(42n, hint()), true)
  assert.equal(await draft(42n, { ...hint(2), modelId: 'gpt-6-luna', effortLevel: null }), true)
  await tick()
  assert.deepEqual(ensureCalls, [42n])
  assert.deepEqual(engines, [])
  ready.release(); await tick()
  assert.deepEqual(engines, [{ ...hint(2), modelId: 'gpt-6-luna', effortLevel: null }])
  assert.equal(await draft(42n, hint()), false)
})
test('cancel, stale revisions and expiry prevent dispatch after cold wake', async () => {
  for (const mode of ['cancel', 'expired'] as const) {
    const ready = gate()
    let time = 0
    let calls = 0
    const draft = makeDraftPreparation({ enabled: () => true, authorize: async () => {}, now: () => time,
      ensureReady: () => ready.wait, prepareEngine: async () => { calls++ }, observe: () => {} })
    await draft(1n, hint())
    if (mode === 'cancel') { await draft(1n, { ...hint(2), cancel: true }); assert.equal(await draft(1n, hint()), false) }
    else time = 60_000
    ready.release(); await tick()
    assert.equal(calls, 0)
  }
})
test('intent cancellation during authority lookup invalidates final transport guard', async () => {
  const lookup = gate()
  let dispatched = 0
  const draft = makeDraftPreparation({ enabled: () => true, authorize: async () => {}, ensureReady: async () => {},
    prepareEngine: async (_uid, _hint, isCurrent) => { await lookup.wait; if (isCurrent()) dispatched++ }, observe: () => {} })
  await draft(1n, hint()); await tick()
  await draft(1n, { ...hint(2), cancel: true })
  lookup.release(); await tick()
  assert.equal(dispatched, 0)
})
test('disabled, authorization denial and full shared budget never dispatch engine work', async () => {
  let engines = 0
  let authorizations = 0
  const deps = { authorize: async () => { authorizations++; throw Error('MAINTENANCE') },
    ensureReady: async () => {}, prepareEngine: async () => { engines++ }, observe: () => {} }
  assert.equal(await makeDraftPreparation({ ...deps, enabled: () => false })(1n, hint()), false)
  assert.equal(authorizations, 0)
  await assert.rejects(makeDraftPreparation({ ...deps, enabled: () => true })(1n, hint()), /MAINTENANCE/)
  assert.equal(engines, 0)
  const ready = gate()
  const shared = makePreparationReady(() => ready.wait)
  const a = shared(1n)
  const b = shared(2n)
  assert.equal(shared(1n), a)
  await assert.rejects(shared(3n), /capacity/)
  ready.release(); await Promise.all([a, b])
})
test('public parser retains only intent, never user/route/workspace authority', () => {
  assert.deepEqual(parseDraftPreparation({ ...hint(), userId: '999', workspaceMode: 'legacy', route: 'paid' }), hint())
  for (const bad of [{ revision: 0 }, { revision: Number.NaN }, { sessionId: '../bad' }, { effortLevel: 'a'.repeat(17) },
    { agentId: '__system__', viewId: '' }, { cancel: 'true' }, { modelId: '' }]) {
    assert.throws(() => parseDraftPreparation({ ...hint(), ...bad }), /invalid/)
  }
})
