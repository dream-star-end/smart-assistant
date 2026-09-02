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
  it('deepseek(确定纯文本)+hasUnderstandImage → CLI 第 1、Read 第 2', () => {
    const hint = buildImageAttachmentHint({
      paths: [SAMPLE],
      textOnlyDefinite: true,
      hasUnderstandImage: true,
    })
    assert.match(hint, /用户附带了以下图片/)
    assert.match(hint, /photo\.png/)
    const cli = hint.indexOf('优先用 Bash 调 `oc-vision understand')
    const read = hint.indexOf('用 Read 工具读图片路径')
    const none = hint.indexOf('如果都不可用')
    assert.ok(cli >= 0 && read >= 0 && none >= 0)
    assert.ok(cli < read && read < none, '确定纯文本必须 CLI 先于 Read')
    assert.match(hint, /^1\. 优先用 Bash 调/m)
    assert.match(hint, /^2\. 用 Read 工具读图片路径/m)
    assert.doesNotMatch(hint, /用 Read 工具直接读图/)
  })

  it('cursor-fable-5.1-high + catalog supportsVision=false → Read 第 1、CLI 第 2', () => {
    const hint = buildImageAttachmentHint({
      paths: [SAMPLE],
      textOnlyDefinite: false,
      hasUnderstandImage: true,
    })
    const read = hint.indexOf('用 Read 工具直接读图(原生多模态直接可见)')
    const cli = hint.indexOf('若 Read 返回的不是图像内容/提示图片被省略/看不到图')
    const none = hint.indexOf('如果都不可用')
    assert.ok(read >= 0 && cli >= 0 && none >= 0)
    assert.ok(read < cli && cli < none, '非确定纯文本必须 Read 先于 oc-vision 兜底')
    assert.match(hint, /^1\. 用 Read 工具直接读图/m)
    assert.match(hint, /^2\. 若 Read 返回的不是图像内容/m)
    assert.match(hint, /oc-vision understand/)
    assert.doesNotMatch(hint, /优先用 Bash 调/)
  })

  it('gpt-5.5/claude 原生(hasUnderstandImage=false)→ 历史文案不变', () => {
    const hint = buildImageAttachmentHint({
      paths: [SAMPLE],
      textOnlyDefinite: false,
      hasUnderstandImage: false,
    })
    assert.equal(
      hint,
      [
        '用户附带了以下图片(已保存到服务器本地):',
        '- `/home/agent/.openclaude/uploads/photo.png` (image/png, 12.0KB, 原名: photo.png)',
        '',
        '如果需要看图片内容,按以下顺序尝试:',
        '1. 用 Read 工具读图片路径(原生多模态 provider 会直接看到图像)。',
        '2. 如果都不可用,告诉用户当前 provider 不支持图片识别。',
      ].join('\n'),
    )
    assert.doesNotMatch(hint, /oc-vision/)
  })

  it('确定纯文本但没有 understand_image → 仍走历史纯 Read 文案', () => {
    const hint = buildImageAttachmentHint({
      paths: [SAMPLE],
      textOnlyDefinite: true,
      hasUnderstandImage: false,
    })
    assert.match(hint, /^1\. 用 Read 工具读图片路径/m)
    assert.match(hint, /^2\. 如果都不可用/m)
    assert.doesNotMatch(hint, /oc-vision/)
  })
})
