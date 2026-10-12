import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAgentsSlot, selectPromptBlocks } from '../promptSlots.js'

const text = [
  'head',
  '<!-- oc-engine:ccb:start -->',
  '- CCB line',
  '<!-- oc-engine:ccb:end -->',
  '<!-- oc-engine:codex:start -->',
  '- Codex line',
  '<!-- oc-engine:codex:end -->',
  '<!-- oc-engine:ccb,codex:start -->',
  '- shared line',
  '<!-- oc-engine:ccb,codex:end -->',
  '<!-- oc-engine:cursor:start -->',
  '- Cursor line',
  '<!-- oc-engine:cursor:end -->',
  '',
  '<!-- oc-channel:wechat:start -->',
  '## WeChat',
  'rules',
  '<!-- oc-channel:wechat:end -->',
  '',
  '## Next',
  '',
].join('\n')

describe('engine / channel blocks in platform text (OCV5-382)', () => {
  it('keeps only the current engine lines and never leaves markers', () => {
    assert.equal(
      selectPromptBlocks(text, 'ccb', 'webchat'),
      'head\n- CCB line\n- shared line\n\n## Next\n',
    )
    assert.equal(
      selectPromptBlocks(text, 'cursor', null),
      'head\n- Cursor line\n\n## WeChat\nrules\n\n## Next\n',
    )
    const all = selectPromptBlocks(text, null, null)
    for (const line of [
      '- CCB line',
      '- Codex line',
      '- shared line',
      '- Cursor line',
      '## WeChat',
    ]) {
      assert.ok(all.includes(line), line)
    }
    assert.doesNotMatch(all, /<!-- oc-(engine|channel):/)
  })

  it('a CCB webchat session gets neither Codex/Cursor channel rules nor WeChat rules', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      provider: 'ccb',
      sessionKey: 'agent:main:webchat:dm:abc',
      delegateModelCatalog: false,
    })
    assert.match(slot.content, /AskUserQuestion/)
    assert.doesNotMatch(
      slot.content,
      /request_user_input|present_options|oc-memory delegate --goal/,
    )
    assert.doesNotMatch(slot.content, /微信通道操作技能/)
    assert.doesNotMatch(slot.content, /<!-- oc-(engine|channel):/)
  })

  it('without a known engine or channel every rule stays', async () => {
    const slot = await buildAgentsSlot({ agentId: 'main', delegateModelCatalog: false })
    for (const needle of [
      'AskUserQuestion',
      'request_user_input',
      'present_options',
      '微信通道操作技能',
    ]) {
      assert.ok(slot.content.includes(needle), needle)
    }
    assert.doesNotMatch(slot.content, /<!-- oc-(engine|channel):/)
  })
})
