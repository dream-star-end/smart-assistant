import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterUserVisibleAgentsForManagement,
  filterUserVisibleByAgentField,
  filterUserVisibleRoutesForManagement,
  isHiddenSystemAgentId,
  userVisibleDefaultAgentId,
} from '../agentVisibility.js'

test('agent management visibility hides system-only hidden reviewer', () => {
  assert.equal(isHiddenSystemAgentId('hidden-reviewer'), true)
  assert.deepEqual(
    filterUserVisibleAgentsForManagement([
      { id: 'main' },
      { id: 'hidden-reviewer' },
      { id: 'market-writer', source: 'marketplace' },
    ]),
    [{ id: 'main' }, { id: 'market-writer', source: 'marketplace' }],
  )
  assert.deepEqual(
    filterUserVisibleRoutesForManagement([
      { match: {}, agent: 'main' },
      { match: {}, agent: 'hidden-reviewer' },
    ]),
    [{ match: {}, agent: 'main' }],
  )
  assert.equal(userVisibleDefaultAgentId('hidden-reviewer'), 'main')
  assert.equal(userVisibleDefaultAgentId('main'), 'main')
})

test('filterUserVisibleByAgentField (re-exported) hides items targeting the hidden reviewer', () => {
  // task / cron / webhook 列表面共用的 by-agent-field 投影(经 gateway re-export）:
  // 剔除指向隐藏系统 agent 的条目,保留其余(含指向未知/已删 agent 的存量条目)。
  assert.deepEqual(
    filterUserVisibleByAgentField([
      { agent: 'main' },
      { agent: 'hidden-reviewer' },
      { agent: 'market-writer' },
    ]),
    [{ agent: 'main' }, { agent: 'market-writer' }],
  )
})
