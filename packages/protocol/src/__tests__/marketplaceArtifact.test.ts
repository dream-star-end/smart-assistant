import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  marketplaceArtifactCompatibility,
  marketplaceReviewSource,
} from '../marketplaceArtifact.js'

describe('marketplace artifact compatibility', () => {
  it('projects legacy connector rows as declarative HTTP plugins', () => {
    assert.deepEqual(marketplaceArtifactCompatibility('connector'), {
      artifactKind: 'plugin',
      pluginType: 'declarative-http',
    })
    assert.deepEqual(marketplaceArtifactCompatibility('skill'), { artifactKind: 'skill' })
    assert.deepEqual(marketplaceArtifactCompatibility('agent'), { artifactKind: 'agent' })
  })

  it('maps stored human reviews to the public manual vocabulary', () => {
    assert.equal(marketplaceReviewSource('human'), 'manual')
    assert.equal(marketplaceReviewSource('ai'), 'ai')
    assert.equal(marketplaceReviewSource('platform'), 'platform')
    assert.equal(marketplaceReviewSource('unknown'), null)
    assert.equal(marketplaceReviewSource(null), null)
  })
})
