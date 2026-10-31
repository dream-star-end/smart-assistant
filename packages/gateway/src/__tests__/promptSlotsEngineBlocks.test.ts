import * as assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-engine-blocks-'))
process.env.OPENCLAUDE_HOME = home
for (const key of ['OPENCLAUDE_PLATFORM_PROMPTS_DIR', 'OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN']) {
  delete process.env[key]
}
writeFileSync(join(home, 'agents.yaml'), 'agents:\n  - id: main\n  - id: researcher\n    displayName: Researcher\n    source: marketplace\n    model: fixture-model\n    provider: ccb\n')
after(() => rmSync(home, { recursive: true, force: true }))
const { buildAgentsSlot, selectPromptBlocks, _platformPromptFallbacks } = await import('../promptSlots.js')

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


describe('known platform CLI engines', () => {
  for (const provider of ['grok', 'antigravity', 'zcode'] as const) {
    it(`${provider} keeps common rules without another engine's tool instructions`, async () => {
      assert.equal(selectPromptBlocks(text, provider, 'webchat'), 'head\n\n## Next\n')
      const slot = await buildAgentsSlot({
        agentId: 'main', provider,
        sessionKey: 'agent:main:webchat:dm:rf-prompts',
        delegateModelCatalog: false,
      })
      assert.doesNotMatch(slot.content, /AskUserQuestion|request_user_input|present_options|oc-memory delegate|<!-- oc-engine:/)
      assert.match(slot.content, /# Platform capabilities/)
      assert.match(slot.content, /## 需要用户决策时/)
      assert.match(slot.content, /oc-lit/)
      assert.match(slot.content, /Researcher/)
      assert.match(slot.content, /\*\*同步\*\*: MCP `delegate_task`/)
    })
  }
})

describe('existing engines retain the pre-change assembled bytes', () => {
  const before = JSON.parse(readFileSync(new URL('./fixtures/platform-engine-before.json', import.meta.url), 'utf8')) as {
    baseCommit: string; outputs: Record<string, string>
  }
  // Captured by running buildAgentsSlot from baseCommit before the filtering change.
  // Normalize only the deliberately replaced literature/OCR line, then compare every byte.
  for (const provider of ['ccb', 'codex', 'cursor'] as const) {
    it(`${provider} matches its frozen snapshot, apart from the literature/OCR line`, async () => {
      const expected = before.outputs[provider]!
      const oldLine = expected.split('\n').find(line => line.includes('scansci-pdf <子命令>'))!
      const newLine = _platformPromptFallbacks.PLATFORM_CAPABILITIES_FALLBACK
        .split('\n').find(line => line.includes('学术论文检索与元数据'))!
      assert.ok(oldLine && newLine)
      const slot = await buildAgentsSlot({
        agentId: 'main', provider,
        sessionKey: 'agent:main:webchat:dm:rf-prompts',
        delegateModelCatalog: false,
      })
      assert.ok(slot.content.includes(newLine))
      assert.deepEqual(Buffer.from(slot.content.replace(newLine, oldLine)), Buffer.from(expected))
    })
  }
  for (const [provider, engine] of [['codex-native', 'codex'], ['claude-subscription', 'ccb']] as const) {
    it(`${provider} still selects ${engine} rules`, async () => {
      const context = { agentId: 'main', sessionKey: 'agent:main:webchat:dm:rf-prompts', delegateModelCatalog: false as const }
      const alias = await buildAgentsSlot({ ...context, provider })
      const primary = await buildAgentsSlot({ ...context, provider: engine })
      assert.equal(alias.content, primary.content)
    })
  }
})
