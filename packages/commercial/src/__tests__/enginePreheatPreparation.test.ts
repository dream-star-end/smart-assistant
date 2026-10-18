import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnginePreheatPreparation } from '../dispatch/enginePreheatPreparation.js'
const args = { userId: 'c:3', sessionId: 'fixture-session', agentId: 'main', modelId: 'alias' }
function fixture(groups: Array<{ id: bigint; kind: string }>, active = new Set([1n])) {
  const reads: string[] = []
  const prepare = makeEnginePreheatPreparation({
    resolveAllowedModel: async (uid, model) => {
      reads.push('authorize'); assert.equal(uid, 3n); assert.equal(model, 'alias')
      return { engine: 'codex', canonicalModel: 'gpt-6.1-sol' }
    },
    listGroups: async model => { reads.push('groups'); assert.equal(model, 'gpt-6.1-sol'); return groups },
    hasOfficial: async id => { reads.push(id.toString()); return active.has(id) },
  })
  return { prepare, reads }
}
test('only the next usable official group produces a fixed credential-free marker', async () => {
  const f = fixture([{ id: 2n, kind: 'official_oauth' }, { id: 1n, kind: 'official_oauth' }])
  assert.deepEqual(await f.prepare(3n, args), { modelId: 'gpt-6.1-sol', codexRouteHint: { kind: 'official_oauth' } })
  assert.deepEqual(f.reads, ['authorize', 'groups', '2', '1'])
})
test('preferred API relay is never bypassed or allocated for speculation', async () => {
  const f = fixture([{ id: 2n, kind: 'api_relay' }, { id: 1n, kind: 'official_oauth' }])
  assert.equal(await f.prepare(3n, args), null)
  assert.deepEqual(f.reads, ['authorize', 'groups'])
})
test('empty official then API relay also skips without falling through to another official', async () => {
  const f = fixture([{ id: 2n, kind: 'official_oauth' }, { id: 3n, kind: 'api_relay' }, { id: 1n, kind: 'official_oauth' }])
  assert.equal(await f.prepare(3n, args), null)
  assert.deepEqual(f.reads, ['authorize', 'groups', '2'])
})
test('missing model, denied authorization, and unknown route never speculate', async () => {
  const f = fixture([{ id: 1n, kind: 'unknown' }])
  assert.equal(await f.prepare(3n, { ...args, modelId: undefined }), null)
  assert.deepEqual(f.reads, [])
  assert.equal(await f.prepare(3n, args), null)
  const denied = makeEnginePreheatPreparation({ resolveAllowedModel: async () => null,
    listGroups: async () => { throw Error('must not read groups') }, hasOfficial: async () => true })
  assert.equal(await denied(3n, args), null)
})
test('non-Codex authorization keeps its existing preparation without Codex group reads', async () => {
  const prepare = makeEnginePreheatPreparation({ resolveAllowedModel: async () => ({ engine: 'ccb', canonicalModel: 'fixture-ccb' }),
    listGroups: async () => { throw Error('must not read groups') }, hasOfficial: async () => true })
  assert.deepEqual(await prepare(3n, args), { modelId: 'fixture-ccb' })
})
test('fresh catalogue or account availability errors only skip the optimization', async () => {
  const prepare = makeEnginePreheatPreparation({ resolveAllowedModel: async () => { throw Error('unavailable') },
    listGroups: async () => [], hasOfficial: async () => true })
  assert.equal(await prepare(3n, args), null)
})
