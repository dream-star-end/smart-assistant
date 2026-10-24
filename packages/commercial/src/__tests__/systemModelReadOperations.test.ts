import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelCatalogSnapshot, type ModelCatalogEntry, type ModelCatalogPricing } from '../billing/modelCatalog.js'
import type { UserModelAuthz } from '../auth/userModelAuthz.js'
import { modelReadOperations } from '../system-assistant/modelReadOperations.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'session_0001', agentId: 'main' }
const entries: ModelCatalogEntry[] = ['public-model','granted-model','denied-model'].map((modelId, index) => ({ entryId: index + 1, modelId, engine: 'ccb', providerId: 'synthetic-provider',
  upstreamModelId: 'synthetic-upstream', contextWindow: 10000, capabilityProfile: { supportsVision: false, reasoning: { supported: ['high'], codexModelDefault: null }, ccb: { capabilityZero: true, supportsThinking: true } }, capabilitySchemaVersion: 1, state: 'active', lockVersion: 0 }))
const prices = new Map<string, ModelCatalogPricing>(entries.map(row => [row.modelId, { modelId: row.modelId, displayName: row.modelId, inputPerMtok: 600n, outputPerMtok: 2400n,
  cacheReadPerMtok: 120n, cacheWritePerMtok: 0n, multiplier: '1.000', visibility: row.modelId === 'granted-model' ? 'admin' : 'public', sortOrder: row.entryId, defaultEffort: null }]))
const snapshot = new ModelCatalogSnapshot({ entries, aliases: new Map(), pricing: prices, securityEpoch: 37n })
function fixture() {
  const calls: unknown[][] = []
  let authz: UserModelAuthz = { uid: 765n, role: 'user', grantedModelIds: new Set(['granted-model']), deniedModelIds: new Set(['denied-model']), userPlanTier: 2, orgPlanCode: null }
  let stale = false
  const registry = new SystemOperationRegistry(modelReadOperations({ authorize: async () => {}, sources: {
    catalog: { assertFresh: async () => { calls.push(['fresh']); if (stale) throw new Error('synthetic unavailable catalog'); return snapshot } },
    loadUserModelAuthz: async (uid, epoch) => { calls.push(['authz', uid, epoch]); return authz },
    getDegradedProviders: async () => new Set(['synthetic-provider']),
  } }))
  return { registry, calls, downgrade: () => { authz = { ...authz, role: 'admin' } }, stale: () => { stale = true } }
}
test('available models use the fresh epoch and full grant/denial scope with unchanged public prices', async () => {
  const f = fixture()
  const value = await f.registry.read(actor, 'models.available.list', {}) as { models: Array<Record<string, unknown>>; locked_models: unknown[] }
  assert.deepEqual(f.calls, [['fresh'],['authz',765n,37n]])
  assert.deepEqual(value.models.map(row => row.id), ['public-model','granted-model'])
  assert(value.models.every(row => row.input_per_ktok_credits === '0.006000' && row.degraded === true))
  assert.deepEqual(value.locked_models, [])
  assert.equal(JSON.stringify(value).includes('synthetic-upstream'), false)
  assert.equal('securityEpoch' in value, false)
})
test('role drift refuses model data instead of using stale actor privileges', async () => {
  const f = fixture(); f.downgrade()
  await assert.rejects(f.registry.read(actor, 'models.available.list', {}), error => error instanceof SystemOperationRejected && error.code === 'FORBIDDEN')
})
test('stale or absent catalog does not fall back to anonymous or legacy pricing', async () => {
  const f = fixture(); f.stale()
  await assert.rejects(f.registry.read(actor, 'models.available.list', {})); assert.deepEqual(f.calls, [['fresh']])
  const absent = new SystemOperationRegistry(modelReadOperations({ authorize: async () => {} }))
  await assert.rejects(absent.read(actor, 'models.available.list', {}), error => error instanceof SystemOperationRejected && error.code === 'UNAVAILABLE')
})
test('model catalog schema cannot accept a model-supplied uid, role or URL', async () => {
  const f = fixture()
  for (const raw of [{ userId: '8000000766' }, { role: 'admin' }, { url: 'https://invalid.example/' }]) await assert.rejects(f.registry.read(actor, 'models.available.list', raw))
  assert.deepEqual(f.calls, [])
})
