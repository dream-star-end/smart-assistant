import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAgentsSlot } from '../promptSlots.js'

// OCV5-547: 非原生多模态模型已从用户目录下架,oc-vision CLI 兜底已删除。
describe('retired oc-vision fallback', () => {
  it('never injects a text-only vision fallback hint', async () => {
    for (const [provider, model] of [
      ['deepseek', 'deepseek-v4-pro'],
      ['ark', 'glm-5.2'],
      ['cursor', 'cursor-fable-5.1-high'],
      ['codex-native', 'gpt-6-luna'],
    ] as const) {
      const slot = await buildAgentsSlot({
        agentId: 'main',
        provider,
        model,
        modelSupportsVision: false,
      })
      assert.doesNotMatch(slot.content, /oc-vision/)
      assert.doesNotMatch(slot.content, /图片理解提示/)
      assert.doesNotMatch(slot.content, /当前模型按纯文本接入、看不到图/)
      assert.doesNotMatch(slot.content, /GPT\/Codex 图片理解提示/)
    }
  })

  it('keeps the WeChat image hint on native reading only', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      provider: 'codex-native',
      model: 'gpt-6-luna',
    })
    assert.match(slot.content, /直接读图回答/)
    assert.doesNotMatch(slot.content, /oc-vision/)
  })
})
