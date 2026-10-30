import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatImageGenerationFailure,
  imageFailureDetail,
  noteFromImageGenerationStderr,
  redactImageUpstream,
} from '../engine/imageGenerationFailure.js'

const SENTINEL = 'demo-secret-123'
const GENERIC = '图片生成没有完成。点「继续」，助手会改用其他方式做完。'

describe('imageGenerationFailure', () => {
  it('maps IMAGE2_DISABLED stderr to Chinese without the internal code', () => {
    const note = noteFromImageGenerationStderr(
      'image generation failed: http 503 Service Unavailable: Some("{\\"error\\":{\\"code\\":\\"IMAGE2_DISABLED\\",\\"message\\":\\"Image 2 is temporarily unavailable\\"},\\"requestId\\":\\"abc\\"}")',
    )
    assert.ok(note)
    assert.match(note!, /Image 2 还没打开/)
    assert.match(note!, /继续/)
    assert.equal(note!.includes('IMAGE2_DISABLED'), false)
    assert.equal(note!.includes('abc'), false)
    assert.equal(note!.includes('requestId'), false)
  })

  it('uses a short item error and drops base64-looking text', () => {
    const shown = formatImageGenerationFailure({ detail: 'upstream failed' })
    assert.equal(shown.includes('upstream failed'), false)
    assert.equal(shown, GENERIC)
    const hidden = imageFailureDetail({
      error: { message: `${'A'.repeat(50)}private-bytes` },
      failure: { message: 'upstream failed' },
    })
    assert.equal(hidden, 'upstream failed')
    assert.equal(imageFailureDetail({ error: { message: 'sk-live-secret-value' } }), undefined)
  })

  it('keeps a short upstream token out of the user-facing image failure', () => {
    const raw = `access_token=${SENTINEL}`
    const detail = imageFailureDetail({ error: { message: raw } })
    const message = formatImageGenerationFailure({ detail })
    assert.equal(detail, undefined)
    assert.equal(message.includes(SENTINEL), false)
    assert.equal(message.includes('access_token'), false)
    assert.equal(formatImageGenerationFailure({ detail: raw }).includes(SENTINEL), false)
    assert.equal(message, GENERIC)
  })

  it('unknown reasons use the generic Chinese sentence', () => {
    const message = formatImageGenerationFailure({
      code: 'SOME_NEW_CODE',
      httpStatus: '503',
      detail: 'upstream failed',
    })
    assert.equal(message.includes('SOME_NEW_CODE'), false)
    assert.equal(message.includes('503'), false)
    assert.equal(message.includes('upstream failed'), false)
    assert.equal(message, GENERIC)
  })

  it('redacts token, key, bearer, and cookie values', () => {
    for (const raw of [
      `access_token=${SENTINEL}`,
      `api_key=${SENTINEL}`,
      `cookie=${SENTINEL}`,
      `Bearer ${SENTINEL}`,
      `secret=${SENTINEL}`,
    ]) {
      assert.equal(redactImageUpstream(raw).includes(SENTINEL), false, raw)
    }
  })
})
