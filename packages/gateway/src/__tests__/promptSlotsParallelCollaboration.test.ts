import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

// storage paths.ts 在 import 时读取 OPENCLAUDE_HOME;用隔离配置验证有/无 collaborator 的真实渲染。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'parallel-prompt-home-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
Reflect.deleteProperty(process.env, 'OPENCLAUDE_PLATFORM_PROMPTS_DIR')

function writeAgents(withCollaborator: boolean): void {
  writeFileSync(
    join(TEST_HOME, 'agents.yaml'),
    [
      'agents:',
      '  - id: main',
      ...(withCollaborator
        ? ['  - id: research-assistant', '    displayName: 研究助手', '    source: marketplace']
        : []),
      'routes: []',
      'default: main',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
}

writeAgents(true)
const { buildAgentsSlot } = await import('../promptSlots.js')

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1
}

describe('普通模式协作提示的 scope-safe 关键路径并行契约', () => {
  for (const [engine, provider, model] of [
    ['CCB', 'anthropic', 'claude-opus-4-8'],
    ['Codex', 'codex-native', 'gpt-5.6-sol'],
  ] as const) {
    it(`${engine} 有 collaborator 时渲染唯一权威和三种真实委派通道`, async () => {
      writeAgents(true)
      const slot = await buildAgentsSlot({ agentId: 'main', provider, model })
      assert.match(slot.content, /research-assistant/)
      assert.equal(
        occurrences(slot.content, '### 并行关键路径调度与质量闸门（fan-out 唯一权威）'),
        1,
      )

      const dynamicStart = slot.content.indexOf('## 多 Agent 协作')
      assert.ok(dynamicStart >= 0)
      const dynamic = slot.content.slice(dynamicStart)
      assert.equal(occurrences(dynamic, '**同步**: `delegate_task(goal, agentId?, context?)`'), 1)
      assert.equal(occurrences(dynamic, '**并行同步**: `delegate_tasks(tasks)`'), 1)
      assert.equal(occurrences(dynamic, '**异步**: `send_to_agent(agentId, message)`'), 1)
      assert.equal(occurrences(dynamic, '前文“并行关键路径调度与质量闸门”'), 1)

      const parallelLine = dynamic.split('\n').find((line) => line.startsWith('**并行同步**:'))
      assert.ok(parallelLine)
      for (const trainingSpecific of [
        'V1',
        'V2',
        'Node',
        '浏览器',
        'SQLite',
        'PostgreSQL',
        'Git',
        '论文',
      ]) {
        assert.ok(
          !parallelLine.includes(trainingSpecific),
          `动态新增行不应特化训练领域: ${trainingSpecific}`,
        )
      }
    })

    it(`${engine} 无 collaborator 时不渲染动态协作能力块`, async () => {
      writeAgents(false)
      const slot = await buildAgentsSlot({ agentId: 'main', provider, model })
      assert.equal(
        occurrences(slot.content, '### 并行关键路径调度与质量闸门（fan-out 唯一权威）'),
        1,
      )
      assert.ok(!slot.content.includes('## 多 Agent 协作'))
      assert.ok(!slot.content.includes('**并行同步**: `delegate_tasks(tasks)`'))
    })
  }
})
