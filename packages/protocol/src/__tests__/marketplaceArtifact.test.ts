import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  marketplaceArtifactCompatibility,
  marketplaceCapabilityKind,
  marketplaceCapabilityStorageKind,
  marketplaceReviewSource,
} from '../marketplaceArtifact.js'

describe('marketplace artifact compatibility', () => {
  it('projects legacy connector rows as declarative HTTP plugins', () => {
    assert.deepEqual(marketplaceArtifactCompatibility('connector', 'declarative-http'), {
      artifactKind: 'plugin',
      pluginType: 'declarative-http',
    })
    assert.deepEqual(marketplaceArtifactCompatibility('connector', 'sandboxed-local'), {
      artifactKind: 'plugin',
      pluginType: 'sandboxed-local',
    })
    assert.deepEqual(marketplaceArtifactCompatibility('connector', 'managed-browser'), {
      artifactKind: 'plugin',
      pluginType: 'managed-browser',
    })
    assert.deepEqual(marketplaceArtifactCompatibility('skill', null), { artifactKind: 'skill' })
    assert.deepEqual(marketplaceArtifactCompatibility('agent', null), { artifactKind: 'agent' })
  })

  it('rejects missing or cross-kind Plugin subtype projections', () => {
    assert.throws(() => marketplaceArtifactCompatibility('connector', null), /pluginType/)
    assert.throws(
      () => marketplaceArtifactCompatibility('skill', 'managed-browser'),
      /cannot be a Plugin/,
    )
  })

  it('maps stored human reviews to the public manual vocabulary', () => {
    assert.equal(marketplaceReviewSource('human'), 'manual')
    assert.equal(marketplaceReviewSource('ai'), 'ai')
    assert.equal(marketplaceReviewSource('platform'), 'platform')
    assert.equal(marketplaceReviewSource('unknown'), null)
    assert.equal(marketplaceReviewSource(null), null)
  })

  it('maps public Plugin capability vocabulary at the storage boundary', () => {
    assert.equal(marketplaceCapabilityStorageKind('skill'), 'skill')
    assert.equal(marketplaceCapabilityStorageKind('plugin'), 'connector')
    assert.equal(marketplaceCapabilityKind('skill'), 'skill')
    assert.equal(marketplaceCapabilityKind('connector'), 'plugin')
  })
})
