import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { projectIdentityCompat, registeredIdentityCompatProfiles, type MarketplaceRuntimeSnapshot } from '../identity/identityCompat.js'
import { makeMarketplaceSyncHandler } from '../http/internalMarketplaceSync.js'
import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import type { FlavorIdentity } from '../flavor/assertFlavor.js'
import { loadAgentModelResolverForUser } from '../ws/agentModelAuthority.js'
import type { InstalledAgent } from '../marketplace/marketplaceDb.js'

const selfhost: FlavorIdentity = { status: 'ok', flavor: 'selfhost', manifestPath: '/fixture/flavor.manifest.json', manifest: {
  schema: 1, flavor: 'selfhost', sourceCommit: 'a'.repeat(40), builder: 'deploy-v5-selfhost.sh',
  expectedHosts: ['fixture'], expectedRoots: ['/fixture'], expectedDbNames: ['openclaude_v5_selfhost'], guardGeneration: 1,
} }
const commercial: FlavorIdentity = { ...selfhost, flavor: 'commercial', manifest: { ...selfhost.manifest, flavor: 'commercial', builder: 'deploy-v5.sh' } }
function agent(slug: string, model: unknown = 'gpt-6-astra'): InstalledAgent {
  return { slug, version: '1.0.0', versionId: `${slug}-v1`, rawManifest: JSON.stringify({ name: slug, model }), artifactHash: `hash-${slug}` }
}
function snapshot(agents: InstalledAgent[] = []): MarketplaceRuntimeSnapshot {
  return { skills: [], agentSets: { installed: agents, presets: [], denied: new Set() } }
}

describe('master scoped registration and readiness', () => {
  it('registers only uid3 with an already verified selfhost identity', () => {
    assert.equal(registeredIdentityCompatProfiles(selfhost, 3n).length, 1)
    for (const [identity, uid] of [[commercial, 3n], [selfhost, 4n], [undefined, 3n], [{ status: 'skipped', reason: 'no-manifest' }, 3n]] as const) {
      assert.equal(registeredIdentityCompatProfiles(identity, uid).length, 0)
    }
  })
  it('registration survives uninstall; no denied entry is not proof of ready', () => {
    const profiles = registeredIdentityCompatProfiles(selfhost, 3)
    const before = projectIdentityCompat(3, profiles, snapshot([agent('personal-butler')]))
    const after = projectIdentityCompat(3, profiles, snapshot([agent('butler')]))
    assert.equal(before.profiles[0]!.readiness, 'ready')
    assert.equal(after.profiles[0]!.readiness, 'unavailable')
    assert.equal(after.profiles[0]!.profile, before.profiles[0]!.profile)
  })
})

describe('per-execution resolver authorization (also required for explicit model)', () => {
  async function rig() {
    let current = snapshot([agent('personal-butler'), agent('butler', 'local-decoy')])
    let fail = false
    let reads = 0
    const resolver = await loadAgentModelResolverForUser(3n, {
      flavorIdentity: selfhost, env: { OC_SEED_AUTHORITY_BY_REV: '0' }, loadPresetSlugs: async () => [],
      loadRuntimeSnapshot: async () => { reads++; if (fail) throw new Error('DB unavailable'); return current },
    })
    return { resolver, get reads() { return reads }, set: (value: MarketplaceRuntimeSnapshot) => { current = value }, fail: () => { fail = true } }
  }
  it('both ids resolve canonical model and independently reread every execution', async () => {
    const r = await rig()
    assert.equal(r.resolver('butler'), 'gpt-6-astra')
    for (const id of ['butler', 'personal-butler', 'butler']) {
      const result = await r.resolver.authorizeExecution!(id)
      assert.equal(result.identity.executionAgentId, 'personal-butler')
      assert.equal(result.identity.requestedId, id)
      assert.equal(result.model, 'gpt-6-astra')
    }
    assert.equal(r.reads, 4)
  })
  it('uninstall after a warm snapshot rejects both aliases without a denied entry', async () => {
    const r = await rig()
    r.set(snapshot([agent('butler', 'local-decoy')]))
    for (const id of ['butler', 'personal-butler']) {
      await assert.rejects(r.resolver.authorizeExecution!(id), { code: 'COMPAT_NOT_READY' })
    }
  })
  it('DB failure never uses the previously ready snapshot', async () => {
    const r = await rig()
    r.fail()
    await assert.rejects(r.resolver.authorizeExecution!('butler'), { code: 'COMPAT_AUTHORITY_UNAVAILABLE' })
  })
  it('canonical model refresh comes from the same fresh readiness snapshot', async () => {
    const r = await rig()
    r.set(snapshot([agent('personal-butler', 'next-model')]))
    assert.equal((await r.resolver.authorizeExecution!('butler')).model, 'next-model')
    r.set(snapshot([agent('personal-butler', null)]))
    await assert.rejects(r.resolver.authorizeExecution!('personal-butler'), { code: 'COMPAT_NOT_READY' })
  })
  it('an initially unavailable registration is denied synchronously too, but can recover', async () => {
    let current = snapshot([agent('butler', 'local-decoy')])
    const resolver = await loadAgentModelResolverForUser(3n, {
      flavorIdentity: selfhost, env: { OC_SEED_AUTHORITY_BY_REV: '0' }, loadPresetSlugs: async () => [],
      loadRuntimeSnapshot: async () => current,
    })
    for (const id of ['butler', 'personal-butler']) {
      assert.equal(resolver.isRuntimeDenied!(id), true)
      assert.equal(resolver(id), null)
    }
    current = snapshot([agent('personal-butler')])
    assert.equal((await resolver.authorizeExecution!('butler')).identity.status, 'registered-ready')
    assert.equal(resolver.isRuntimeDenied!('butler'), false)
    assert.equal(resolver('butler'), 'gpt-6-astra')
  })
  it('ordinary agents retain existing model lookup without the compat recheck', async () => {
    const r = await rig()
    const before = r.reads
    assert.equal((await r.resolver.authorizeExecution!('main')).identity.status, 'no-registration')
    assert.equal(r.reads, before)
  })
  it('an unready legacy listing cannot split a ready registered identity', async () => {
    const ready = snapshot([agent('personal-butler')])
    ready.agentSets.denied.add('butler')
    const resolver = await loadAgentModelResolverForUser(3n, {
      flavorIdentity: selfhost, env: { OC_SEED_AUTHORITY_BY_REV: '0' }, loadPresetSlugs: async () => [],
      loadRuntimeSnapshot: async () => ready,
    })
    assert.equal(resolver.isRuntimeDenied!('butler'), false)
    assert.equal(resolver.isRuntimeDenied!('personal-butler'), false)
    assert.equal((await resolver.authorizeExecution!('butler')).model, 'gpt-6-astra')
  })
})

describe('authenticated marketplace sync projection', () => {
  async function rig(uid: number, identity: FlavorIdentity = selfhost) {
    const secret = 'ab'.repeat(32)
    const repo: ContainerIdentityRepo = { findActiveByHostAndBoundIp: async (host, ip) => ({ id: 19, user_id: uid, bound_ip: ip, host_uuid: host, secret_hash: hashSecret(secret) }) }
    let current = snapshot([agent('personal-butler')])
    let fail = false
    const reads: number[] = []
    const handler = makeMarketplaceSyncHandler({ identityRepo: repo, flavorIdentity: identity,
      loadPresetSlugs: async () => [], loadRuntimeSnapshot: async (userId) => { reads.push(userId); if (fail) throw new Error('snapshot failed'); return current },
    })
    const server = createServer((req: IncomingMessage, res: ServerResponse) => { void handler(req, res, { hostUuid: 'fixture', boundIp: '127.0.0.1' }) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/v3/marketplace/sync?userId=3`
    return { reads, get: (authorized = true) => fetch(url, { headers: authorized ? { authorization: `Bearer oc-v3.19.${secret}` } : {} }),
      set: (value: MarketplaceRuntimeSnapshot) => { current = value }, fail: () => { fail = true },
      close: () => new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); server.closeAllConnections() }),
    }
  }
  it('authenticated uid projection is fresh each request and survives uninstall', async () => {
    const r = await rig(3)
    try {
      const first = await (await r.get()).json()
      assert.equal(first.identityCompat.profiles[0].readiness, 'ready')
      r.set(snapshot())
      const second = await (await r.get()).json()
      assert.equal(second.identityCompat.profiles[0].readiness, 'unavailable')
      assert.equal(second.identityCompat.profiles[0].profile.profileId, first.identityCompat.profiles[0].profile.profileId)
      assert.deepEqual(r.reads, [3, 3])
      r.fail()
      const failed = await r.get()
      assert.equal(failed.status, 500)
      assert.equal('identityCompat' in await failed.json(), false)
    } finally { await r.close() }
  })
  it('query uid cannot register another authenticated user', async () => {
    const r = await rig(4)
    try {
      const body = await (await r.get()).json()
      assert.deepEqual(body.identityCompat, { schema: 1, userId: '4', profiles: [] })
      assert.deepEqual(r.reads, [4])
    } finally { await r.close() }
  })
  it('commercial returns explicit no-registration even with the same installed slugs', async () => {
    const r = await rig(3, commercial)
    try { assert.deepEqual((await (await r.get()).json()).identityCompat.profiles, []) }
    finally { await r.close() }
  })
  it('unauthenticated request receives no projection and does not query readiness', async () => {
    const r = await rig(3)
    try {
      const response = await r.get(false)
      assert.equal(response.status, 401)
      assert.equal('identityCompat' in await response.json(), false)
      assert.deepEqual(r.reads, [])
    } finally { await r.close() }
  })
})
