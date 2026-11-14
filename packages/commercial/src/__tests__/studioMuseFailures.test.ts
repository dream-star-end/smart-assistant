// OCV5-591: the studio names a Muse failure caused by the image a job carries.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isMuseSourceFailure } from '../media-studio/providers/museFailures.js'

describe('isMuseSourceFailure', () => {
  it('Muse jobs that carry an image, failing on the source-image path', () => {
    for (const code of ['MUSE_BRIDGE_LOST', 'MUSE_SOURCE_TOO_LARGE', 'MUSE_SOURCE_FETCH_FAILED']) {
      assert.equal(isMuseSourceFailure('muse-video', 'video.from_image', code), true, code)
      assert.equal(isMuseSourceFailure('muse-image', 'image.edit', code), true, code)
    }
  })
  it('not for text-only jobs, other providers, other codes or no code', () => {
    assert.equal(isMuseSourceFailure('muse-video', 'video.from_text', 'MUSE_BRIDGE_LOST'), false)
    assert.equal(isMuseSourceFailure('muse-image', 'image.generate', 'MUSE_BRIDGE_LOST'), false)
    assert.equal(isMuseSourceFailure('gpt-image', 'image.edit', 'MUSE_BRIDGE_LOST'), false)
    assert.equal(isMuseSourceFailure('muse-video', 'video.from_image', 'MUSE_TIMEOUT'), false)
    assert.equal(isMuseSourceFailure('muse-video', 'video.from_image', null), false)
  })
})
