import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatImageGenerationFailure,
  imageFailureDetail,
  noteFromImageGenerationStderr,
} from '../engine/imageGenerationFailure.js'

describe('imageGenerationFailure', () => {
  it('maps IMAGE2_DISABLED stderr without echoing the body', () => {
    const note = noteFromImageGenerationStderr(
      'image generation failed: http 503 Service Unavailable: Some("{\\"error\\":{\\"code\\":\\"IMAGE2_DISABLED\\",\\"message\\":\\"Image 2 is temporarily unavailable\\"},\\"requestId\\":\\"abc\\"}")',
    )
    assert.ok(note)
    assert.match(note!, /Image 2 还没打开/)
    assert.match(note!, /继续/)
    assert.equal(note!.includes('IMAGE2_DISABLED'), true)
    assert.equal(note!.includes('abc'), false)
  })

  it('uses a short item error and drops base64-looking text', () => {
    assert.equal(
      formatImageGenerationFailure({ detail: 'upstream failed' }).includes('upstream failed'),
      true,
    )
    const hidden = imageFailureDetail({
      error: { message: `${'A'.repeat(50)}private-bytes` },
      failure: { message: 'upstream failed' },
    })
    assert.equal(hidden, 'upstream failed')
    assert.equal(imageFailureDetail({ error: { message: 'sk-live-secret-value' } }), undefined)
  })
})
