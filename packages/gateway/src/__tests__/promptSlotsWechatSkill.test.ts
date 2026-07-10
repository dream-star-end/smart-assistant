import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAgentsSlot, buildPromptContext } from '../promptSlots.js'

async function withoutRemotePlatformSlots<T>(fn: () => Promise<T> | T): Promise<T> {
  const keys = ['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN']
  const old = new Map<string, string | undefined>()
  for (const key of keys) {
    old.set(key, process.env[key])
    Reflect.deleteProperty(process.env, key)
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('WeChat channel operation skill prompt', () => {
  it('is present in the shared AGENTS slot with exact media path rules', async () => {
    const slot = await buildAgentsSlot({ agentId: 'main' })
    assert.match(slot.content, /微信通道操作技能/)
    assert.match(slot.content, /\/home\/agent\/\.openclaude\/uploads\/<安全文件名>/)
    assert.match(slot.content, /\/home\/agent\/\.openclaude\/generated\/<安全文件名>/)
    assert.match(slot.content, /最终回复/)
    assert.match(slot.content, /思考过程或工具调用说明/)
    assert.match(slot.content, /A-Za-z0-9/)
    assert.match(slot.content, /png\/jpg\/jpeg\/gif\/webp/)
    assert.match(slot.content, /txt` 或 `md/)
  })

  it('always advertises the oc-browser CLI workflow (browser retired from MCP)', async () => {
    // browser is now the always-available oc-browser daemon + CLI, so the section
    // no longer depends on availableMcpTools and never mentions browser_* tools.
    const slot = await buildAgentsSlot({ agentId: 'main', availableMcpTools: [] })
    assert.match(slot.content, /## 浏览器操作 \(CLI\)/)
    assert.match(slot.content, /oc-browser navigate --url/)
    assert.match(slot.content, /oc-browser snapshot/)
    assert.match(slot.content, /skill_view\("browser"\)/)
    assert.doesNotMatch(slot.content, /browser_navigate|browser_snapshot/)
  })

  it('is injected into DeepSeek/CCB prompt context', async () => {
    await withoutRemotePlatformSlots(async () => {
      const result = await buildPromptContext({
        agentId: 'nonexistent-agent-for-test',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      })
      assert.match(result.content, /微信通道操作技能/)
      assert.match(result.content, /\/home\/agent\/\.openclaude\/generated\/example\.txt/)
      assert.ok(result.applied.some((slot) => slot.name === 'AGENTS'))
    })
  })

  it('is injected into Codex-native prompt context', async () => {
    await withoutRemotePlatformSlots(async () => {
      const result = await buildPromptContext({
        agentId: 'nonexistent-agent-for-test',
        provider: 'codex-native',
        model: 'gpt-5.6-sol',
      })
      assert.match(result.content, /微信通道操作技能/)
      assert.match(result.content, /最终回答/)
      assert.match(result.content, /\/home\/agent\/\.openclaude\/generated\/example\.txt/)
      assert.ok(result.applied.some((slot) => slot.name === 'AGENTS'))
    })
  })
})
