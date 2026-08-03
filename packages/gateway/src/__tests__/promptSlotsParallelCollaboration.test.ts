import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

// storage paths.ts 在 import 时读取 OPENCLAUDE_HOME;先建立带市场 agent 的隔离配置。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'parallel-prompt-home-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
Reflect.deleteProperty(process.env, 'OPENCLAUDE_PLATFORM_PROMPTS_DIR')
writeFileSync(
  join(TEST_HOME, 'agents.yaml'),
  [
    'agents:',
    '  - id: main',
    '  - id: research-assistant',
    '    displayName: 研究助手',
    '    source: marketplace',
    'routes: []',
    'default: main',
    '',
  ].join('\n'),
  { mode: 0o600 },
)

const { buildAgentsSlot } = await import('../promptSlots.js')

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1
}

describe('普通模式协作提示的关键路径并行契约', () => {
  for (const [engine, provider, model] of [
    ['CCB', 'anthropic', 'claude-opus-4-8'],
    ['Codex', 'codex-native', 'gpt-5.6-sol'],
  ] as const) {
    it(`${engine} 渲染唯一权威规则和三种真实委派通道`, async () => {
      const slot = await buildAgentsSlot({ agentId: 'main', provider, model })
      assert.match(slot.content, /research-assistant/)
      assert.equal(occurrences(slot.content, '### 关键路径并行规则（唯一权威）'), 1)

      const dynamic = slot.content.slice(slot.content.indexOf('## 多 Agent 协作'))
      assert.equal(occurrences(dynamic, '**同步**: `delegate_task(goal, agentId?, context?)`'), 1)
      assert.equal(occurrences(dynamic, '**并行同步**: `delegate_tasks(tasks)`'), 1)
      assert.equal(occurrences(dynamic, '**异步**: `send_to_agent(agentId, message)`'), 1)
      assert.equal(occurrences(dynamic, '前文“关键路径并行规则”'), 1)
    })
  }
})
