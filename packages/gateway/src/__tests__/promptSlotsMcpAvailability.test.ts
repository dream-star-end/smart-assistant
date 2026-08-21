import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildPromptContext } from '../promptSlots.js'

describe('prompt MCP availability projection', () => {
  test('explicitly empty tools never advertise unavailable platform functions', async () => {
    const result = await buildPromptContext({
      agentId: 'main',
      provider: 'zcode',
      availableMcpTools: [],
    })
    for (const name of [
      'skill_search',
      'skill_view',
      'create_reminder',
      'delegate_task',
      'send_to_agent',
    ]) {
      assert.equal(result.content.includes(name), false, name)
    }
    assert.match(result.content, /技能检索函数未注册/)
  })

  test('registered skill and reminder functions retain their actionable instructions', async () => {
    const result = await buildPromptContext({
      agentId: 'main',
      provider: 'zcode',
      availableMcpTools: [
        'skill_search',
        'skill_list',
        'skill_view',
        'skill_save',
        'create_reminder',
        'list_reminders',
        'update_reminder',
        'delete_reminder',
      ],
    })
    assert.match(result.content, /skill_search\(query\)/)
    assert.match(result.content, /skill_view\(name\)/)
    assert.match(result.content, /create_reminder\(/)
    assert.equal(result.content.includes('delegate_task'), false)
  })
})
