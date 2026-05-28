import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAgentsSlot } from '../promptSlots.js'

describe('buildAgentsSlot DeepSeek vision hint', () => {
  it('adds image-tool guidance for deepseek model when the tool is available', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'deepseek-v4-pro',
      availableMcpTools: ['understand_image'],
    })
    assert.match(slot.content, /DeepSeek 图片理解提示/)
    assert.match(slot.content, /understand_image/)
    assert.match(slot.content, /image_file="绝对路径"/)
  })

  it('does not mention understand_image for deepseek when the tool is unavailable', async () => {
    const slot = await buildAgentsSlot({ agentId: 'main', model: 'deepseek-v4-pro' })
    assert.doesNotMatch(slot.content, /DeepSeek 图片理解提示/)
    assert.doesNotMatch(slot.content, /understand_image/)
  })
})
