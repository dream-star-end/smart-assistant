import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterUserVisibleAgentsForManagement,
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
