import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildImageAttachmentHint } from '../imageAttachmentHint.js'

const SAMPLE = {
  path: '/home/agent/.openclaude/uploads/photo.png',
  mimeType: 'image/png',
  sizeHint: '12.0KB',
  name: 'photo.png',
}

describe('buildImageAttachmentHint', () => {
  it('only points at native image reading and never at the retired CLI', () => {
    const hint = buildImageAttachmentHint({ paths: [SAMPLE] })
    assert.match(hint, /用户附带了以下图片/)
    assert.match(hint, /photo\.png/)
    assert.match(hint, /^1\. 用 Read 工具读图片路径/m)
    assert.match(hint, /^2\. 如果当前 provider 不支持图片识别/m)
    assert.doesNotMatch(hint, /oc-vision/)
    assert.doesNotMatch(hint, /oc-vision understand/)
    assert.doesNotMatch(hint, /优先用 Bash/)
  })
})
