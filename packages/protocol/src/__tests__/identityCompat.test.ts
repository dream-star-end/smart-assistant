import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertIdentityCompatReady, identityCompatAgentIdsEqual, parseIdentityCompatProjection,
  resolveIdentityCompat, type IdentityCompatProjection,
} from '../identityCompat.js'

const projection: IdentityCompatProjection = {
  schema: 1, userId: '3', profiles: [{ readiness: 'ready', profile: {
    profileId: 'registered-v1', legacyAgentId: 'old-agent', canonicalAgentId: 'current-agent',
    localPersonaPath: 'agents/old-agent/CLAUDE.md', localSkillStorageId: 'old-agent',
  } }],
}

describe('explicit identity compatibility wire and pure semantics', () => {
  it('resolves only an explicitly registered pair and retains the requested id', () => {
    const alias = resolveIdentityCompat('old-agent', projection)
    const canonical = resolveIdentityCompat('current-agent', projection)
    assert.equal(alias.executionAgentId, canonical.executionAgentId)
    assert.equal(alias.profile, canonical.profile)
    assert.equal(alias.requestedId, 'old-agent')
    assert.equal(alias.status, 'registered-ready')
    assert.equal('sessionKey' in alias, false)
    assert.equal(resolveIdentityCompat('butler', projection).status, 'no-registration')
  })
  it('an explicit empty registry does not map even well-known slugs', () => {
    const empty = parseIdentityCompatProjection({ schema: 1, userId: '3', profiles: [] }, '3')
    assert.equal(identityCompatAgentIdsEqual('butler', 'personal-butler', empty), false)
  })
  it('unavailable retains semantic identity but cannot authorize execution', () => {
    const unavailable: IdentityCompatProjection = { ...projection, profiles: [{ ...projection.profiles[0]!, readiness: 'unavailable' }] }
    assert.equal(identityCompatAgentIdsEqual('old-agent', 'current-agent', unavailable), true)
    for (const id of ['old-agent', 'current-agent']) {
      assert.throws(() => assertIdentityCompatReady(resolveIdentityCompat(id, unavailable)), { code: 'COMPAT_NOT_READY' })
    }
    assert.equal(identityCompatAgentIdsEqual('main', 'current-agent', unavailable), false)
  })
  for (const [name, value] of [
    ['missing', undefined], ['old response', {}], ['wrong schema', { ...projection, schema: 2 }],
    ['wrong user', { ...projection, userId: '4' }], ['missing registry', { schema: 1, userId: '3' }],
    ['bad ready', { ...projection, profiles: [{ ...projection.profiles[0], readiness: false }] }],
    ['overlap', { ...projection, profiles: [projection.profiles[0], projection.profiles[0]] }],
    ['path traversal', { ...projection, profiles: [{ ...projection.profiles[0], profile: { ...projection.profiles[0]!.profile, localPersonaPath: 'agents/../main/CLAUDE.md' } }] }],
  ] as const) {
    it(`rejects ${name} instead of treating failure as no-registration`, () => {
      assert.throws(() => parseIdentityCompatProjection(value, '3'), { code: 'COMPAT_AUTHORITY_UNAVAILABLE' })
    })
  }
  it('accepts an authenticated valid projection and readiness', () => {
    assert.equal(parseIdentityCompatProjection(projection, '3'), projection)
    assert.doesNotThrow(() => assertIdentityCompatReady(resolveIdentityCompat('old-agent', projection)))
  })
})
