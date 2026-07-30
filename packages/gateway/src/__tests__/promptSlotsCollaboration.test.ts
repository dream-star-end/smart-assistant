import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = mkdtempSync(join(tmpdir(), 'prompt-collaboration-'))
process.env.OPENCLAUDE_HOME = testHome

const { buildAgentsSlot } = await import('../promptSlots.js')

describe('普通模式动态协作块', () => {
  it('有 marketplace 成员时明确列出 delegate_tasks', async () => {
    writeFileSync(
      join(testHome, 'agents.yaml'),
      [
        'agents:',
        '  - id: main',
        '  - id: coding-assistant',
        '    source: marketplace',
        '    displayName: 编程助手',
        'routes: []',
        'default: main',
        '',
      ].join('\n'),
    )

    const slot = await buildAgentsSlot({ agentId: 'main' })
    assert.ok(slot)
    assert.match(slot.content, /## 多 Agent 协作/)
    assert.match(slot.content, /\*\*并行\*\*: `delegate_tasks\(tasks\)`/)
  })

  it('没有 marketplace 成员时不生成虚假的动态成员块', async () => {
    writeFileSync(
      join(testHome, 'agents.yaml'),
      ['agents:', '  - id: main', 'routes: []', 'default: main', ''].join('\n'),
    )

    const slot = await buildAgentsSlot({ agentId: 'main' })
    assert.ok(slot)
    assert.doesNotMatch(slot.content, /你当前是 `main`。系统中还有以下 agent 可以协作/)
  })
})
