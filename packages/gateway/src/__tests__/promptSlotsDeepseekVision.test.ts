import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAgentsSlot } from '../promptSlots.js'

describe('buildAgentsSlot 纯文本模型 vision hint', () => {
  it('deepseek 有 understand_image 工具时给图片理解提示', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'deepseek-v4-pro',
      availableMcpTools: ['understand_image'],
    })
    assert.match(slot.content, /图片理解提示/)
    assert.match(slot.content, /understand_image/)
    assert.match(slot.content, /image_file="绝对路径"/)
  })

  it('glm-5.2(火山 ark 纯文本)有 understand_image 工具时给图片理解提示', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'glm-5.2',
      provider: 'ark',
      availableMcpTools: ['understand_image'],
    })
    assert.match(slot.content, /图片理解提示/)
    assert.match(slot.content, /understand_image/)
  })

  it('工具不可用时不提 understand_image', async () => {
    const slot = await buildAgentsSlot({ agentId: 'main', model: 'deepseek-v4-pro' })
    assert.doesNotMatch(slot.content, /图片理解提示/)
    assert.doesNotMatch(slot.content, /understand_image/)
  })

  it('minimax(MiniMax-M3 原生多模态)不再提 understand_image(直接识图)', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'MiniMax-M3',
      provider: 'minimax',
      availableMcpTools: [],
    })
    assert.doesNotMatch(slot.content, /understand_image/)
  })
})
