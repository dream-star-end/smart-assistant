import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAgentsSlot } from '../promptSlots.js'

// 识图从 openclaude-vision MCP 迁到 oc-vision CLI(baseline skill)后:
//  - 是否发"图片理解提示"不再看 availableMcpTools(那已恒空),而看模型是否需要识图兜底
//    (shouldEnableOpenClaudeVision:纯文本静态模型 → 发;原生多模态 → 不发)。
//  - 提示文案从 `understand_image` MCP 工具改成 `oc-vision understand` CLI。
describe('buildAgentsSlot 纯文本模型 vision hint(oc-vision CLI)', () => {
  it('deepseek(纯文本静态)给 oc-vision 图片理解提示', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'deepseek-v4-pro',
    })
    assert.match(slot.content, /图片理解提示/)
    assert.match(slot.content, /oc-vision understand/)
    assert.doesNotMatch(slot.content, /understand_image/)
  })

  it('glm-5.2(火山 ark 纯文本)给 oc-vision 提示', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'glm-5.2',
      provider: 'ark',
    })
    assert.match(slot.content, /图片理解提示/)
    assert.match(slot.content, /oc-vision understand/)
  })

  it('纯文本模型的提示不再依赖 availableMcpTools(迁移点:按模型门控,恒发)', async () => {
    // 旧行为需 availableMcpTools 含 understand_image 才发;迁移后 CLI 常在,只按模型判定。
    const withoutTools = await buildAgentsSlot({ agentId: 'main', model: 'deepseek-v4-pro' })
    const withStaleTool = await buildAgentsSlot({
      agentId: 'main',
      model: 'deepseek-v4-pro',
      availableMcpTools: [],
    })
    assert.match(withoutTools.content, /图片理解提示/)
    assert.match(withStaleTool.content, /图片理解提示/)
  })

  it('minimax(MiniMax-M3 原生多模态)不提图片理解(直接识图)', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'MiniMax-M3',
      provider: 'minimax',
    })
    assert.doesNotMatch(slot.content, /图片理解提示/)
    assert.doesNotMatch(slot.content, /oc-vision/)
    assert.doesNotMatch(slot.content, /understand_image/)
  })

  it('gpt-5.6-sol(原生多模态,codex 底座)默认不发 oc-vision 提示(保持迁移前行为,不加噪音)', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'gpt-5.6-sol',
      provider: 'codex-native',
    })
    assert.doesNotMatch(slot.content, /图片理解提示/)
    assert.doesNotMatch(slot.content, /oc-vision/)
  })
})
