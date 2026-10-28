import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'
import type { FlavorIdentity } from '../flavor/assertFlavor.js'
import { availableDefaultConnectors } from '../connectors/defaults/index.js'
import { assertConnectorBindEntitlement, assertConnectorExecutionEntitlement } from '../connectors/entitlement.js'
import { listDeclarativeCatalog } from '../connectors/engine/catalog.js'
import { ConnectorError } from '../connectors/errors.js'
import { makeConnectorsRpcHandler } from '../connectors/rpc.js'
import { executeConnectionAction } from '../connectors/service.js'
import { assertRuntimePluginInstallEntitlement } from '../plugins/accounts.js'
import { SELFHOST_PLUGIN_SLUGS, configurePluginCatalog, isPluginAvailable, isMarketplaceArtifactAvailable, pluginAvailableForIdentity } from '../plugins/catalogPolicy.js'
import { isPluginDisabled } from '../plugins/enablement.js'
import { seedZhihuPlugin } from '../marketplace/seedZhihuPlugin.js'
import { seedBiliAccountPlugin } from '../marketplace/seedBiliAccountPlugin.js'
import { seedOfficialMarketConnector } from '../marketplace/seedOfficialConnectors.js'
import { PluginRuntimeFacade } from '../plugins/runtime.js'
import { patchPreferences, resolvePreferencesPatch } from '../user/preferences.js'

function identity(flavor: 'selfhost' | 'commercial'): FlavorIdentity {
  return { status: 'ok', flavor, manifestPath: '/fixture/flavor.manifest.json', manifest: {
    schema: 1, flavor, sourceCommit: 'a'.repeat(40),
    builder: flavor === 'selfhost' ? 'deploy-v5-selfhost.sh' : 'deploy-v5.sh',
    expectedHosts: ['fixture'], expectedRoots: ['/fixture'], expectedDbNames: ['fixture'], guardGeneration: 1,
  } }
}
configurePluginCatalog(identity('selfhost'))
const unavailable = (error: unknown) => error instanceof ConnectorError && error.code === 'PLUGIN_UNAVAILABLE'

test('selfhost has exactly five plugins; commercial and generic engine identities remain unrestricted', () => {
  for (const slug of SELFHOST_PLUGIN_SLUGS) assert.equal(isPluginAvailable(slug), true)
  for (const slug of ['notion', 'feishu', 'zhihu', 'bilibili', 'imap', 'webdav', 'gnss', 'new-plugin']) {
    assert.equal(isPluginAvailable(slug), false, slug)
    assert.equal(pluginAvailableForIdentity(identity('commercial'), slug), true)
    assert.equal(pluginAvailableForIdentity(undefined, slug), true)
    assert.equal(isMarketplaceArtifactAvailable('connector', slug), false)
    assert.equal(isMarketplaceArtifactAvailable('skill', slug), true)
    assert.equal(isMarketplaceArtifactAvailable('agent', slug), true)
  }
  assert.deepEqual(availableDefaultConnectors().map((entry) => entry.spec.id), ['github'])
  configurePluginCatalog({ status: 'skipped', reason: 'no-manifest' })
  assert.equal(isPluginAvailable('notion'), false, 'skipped identity cannot reset a proven deployment')
  assert.throws(() => configurePluginCatalog(identity('commercial')), /cannot change/)
})

test('empty/failing-open user preferences cannot enable a retired plugin', async () => {
  assert.equal(await isPluginDisabled('7', 'notion'), true)
  await assert.rejects(resolvePreferencesPatch('7', { enabled_plugins: ['notion'] }), /不能启用/)
  await assert.rejects(patchPreferences('7', { enabled_plugins: ['notion'] }), /不能启用/)
  assert.deepEqual(await resolvePreferencesPatch('7', { enabled_plugins: ['ths'] }), { enabled_plugins: ['ths'] })
  assert.deepEqual(await resolvePreferencesPatch('7', { disabled_plugins: ['notion'] }), { disabled_plugins: ['notion'] })
})

test('retired declarative pins cannot bind or execute, even with approved current installed artifacts', async () => {
  let queries = 0
  const runner = { query: async () => { queries++; return { rows: [{
    slug: 'notion', kind: 'connector', version_status: 'approved', artifact_hash: 'a'.repeat(64),
    exec_contract: {}, security_review_state: 'security_approved', functional_verify_state: 'verified',
    exec_revoked_at: null, listing_state: 'active', current_approved_version_id: '42',
  }], rowCount: 1 } } } as never
  await assert.rejects(assertConnectorBindEntitlement(7, '42', runner), unavailable)
  await assert.rejects(assertConnectorExecutionEntitlement(7, 'notion', '42', runner), unavailable)
  assert.equal(queries, 2, 'do not query installation or decrypt any secrets')
})

test('retired runtime install entitlement rejects before database access', async () => {
  await assert.rejects(assertRuntimePluginInstallEntitlement(7, { slug: 'zhihu' } as never, {
    query: async () => { throw new Error('must not query') },
  } as never), unavailable)
})

test('old v1 account ids cannot dispatch read or confirmed write actions', async () => {
  for (const expectedRevision of [null, 1]) {
    await assert.rejects(executeConnectionAction({
      connectionId: '41', userId: 7, action: { id: 'search' } as never, params: {}, expectedRevision,
      deps: { pool: { query: async () => ({ rows: [{ provider: 'notion', revision: 1 }] }) } as never,
        fetchImpl: async () => { throw new Error('must not contact upstream') } },
    }), unavailable)
  }
})

test('RPC state returns normal disabled state for retired plugins so local plugin-exec cannot fail open', async () => {
  const handler = makeConnectorsRpcHandler({
    identityRepo: { findActiveByHostAndBoundIp: async () => ({
      id: 1, user_id: 7, bound_ip: '1.2.3.4', host_uuid: 'h',
      secret_hash: createHash('sha256').update(Buffer.from('b'.repeat(64), 'hex')).digest(),
    }) },
    pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    pluginEnablement: { disabledSet: async () => new Set() }, log: () => {},
  })
  for (const [slug, enabled] of [['zhihu', false], ['ths', true]] as const) {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST', url: '/v3/plugins/state', headers: { authorization: `Bearer oc-v3.1.${'b'.repeat(64)}` },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ slug })) },
    }) as IncomingMessage
    let body = ''
    const res = { statusCode: 200, setHeader() {}, end(chunk: string) { body = chunk } } as unknown as ServerResponse
    await handler(req, res, { hostUuid: 'h', boundIp: '1.2.3.4' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(body), { kind: 'state', slug, enabled })
  }
})


test('standalone retired seeds cannot republish or promote existing artifacts on selfhost', async () => {
  await assert.rejects(seedZhihuPlugin({ functionalVerified: true }), unavailable)
  await assert.rejects(seedBiliAccountPlugin({ functionalVerified: true }), unavailable)
  await assert.rejects(seedOfficialMarketConnector({ slug: 'douyin', dryRun: true } as never), unavailable)
})


test('declarative discovery excludes historical installed defaults before signature loading', async () => {
  let args: unknown
  const pool = { query: async (_sql: string, params: unknown) => {
    args = params
    return { rows: [{ id: '42', slug: 'notion', name: 'Notion' }, { id: '43', slug: 'feishu', name: '飞书' }] }
  } }
  assert.deepEqual(await listDeclarativeCatalog(pool as never, 7), [])
  assert.deepEqual((args as unknown[])[1], ['github'])
})


test('runtime list cannot expose historical retired accounts absent from its catalog', async () => {
  const pool = { query: async (sql: string) => ({ rows: sql.includes('FROM connections c')
    ? [{ id: '41', provider: 'zhihu', connector_version_id: '42' }] : [], rowCount: 0 }) }
  const facade = new PluginRuntimeFacade({ pool: pool as never, redis: null })
  assert.deepEqual(await facade.list(7), [])
})
