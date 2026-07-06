import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HIDDEN_SYSTEM_AGENT_IDS,
  filterUserVisibleAgentsForManagement,
  filterUserVisibleByAgentField,
  filterUserVisibleRoutesForManagement,
  isHiddenSystemAgentId,
  userVisibleDefaultAgentId,
} from '../agentVisibility.js'

test('hidden system agent authority: hidden-reviewer is the reserved id', () => {
  assert.equal(HIDDEN_SYSTEM_AGENT_IDS.has('hidden-reviewer'), true)
  assert.equal(isHiddenSystemAgentId('hidden-reviewer'), true)
  assert.equal(isHiddenSystemAgentId('main'), false)
  assert.equal(isHiddenSystemAgentId('market-writer'), false)
})

test('UserView projection: agents/routes/default all exclude the hidden system agent', () => {
  const cfg = {
    default: 'hidden-reviewer',
    agents: [
      { id: 'main' },
      { id: 'hidden-reviewer' },
      { id: 'market-writer', source: 'marketplace' },
    ],
    routes: [
      { match: {}, agent: 'main' },
      { match: {}, agent: 'hidden-reviewer' },
    ],
  }

  const view = {
    agents: filterUserVisibleAgentsForManagement(cfg.agents),
    routes: filterUserVisibleRoutesForManagement(cfg.routes),
    default: userVisibleDefaultAgentId(cfg.default),
  }

  assert.deepEqual(
    view.agents.map((a) => a.id),
    ['main', 'market-writer'],
  )
  assert.deepEqual(
    view.routes.map((r) => r.agent),
    ['main'],
  )
  // default was the hidden id → collapsed to main
  assert.equal(view.default, 'main')
  // no projection surface leaks the hidden id
  assert.ok(!view.agents.some((a) => isHiddenSystemAgentId(a.id)))
  assert.ok(!view.routes.some((r) => isHiddenSystemAgentId(r.agent)))
  assert.equal(isHiddenSystemAgentId(view.default), false)
})

test('userVisibleDefaultAgentId keeps a visible default and falls back on illegal values', () => {
  assert.equal(userVisibleDefaultAgentId('market-writer'), 'market-writer')
  assert.equal(userVisibleDefaultAgentId('hidden-reviewer'), 'main')
  assert.equal(userVisibleDefaultAgentId(undefined), 'main')
  assert.equal(userVisibleDefaultAgentId(42), 'main')
})

test('filterUserVisibleByAgentField drops hidden-targeting items but keeps unknown/deleted-agent items (zero drift)', () => {
  const items = [
    { id: 't1', agent: 'main' },
    { id: 't2', agent: 'hidden-reviewer' },
    { id: 't3', agent: 'market-writer' },
    // references a deleted/unknown (but not hidden) agent — must be RETAINED
    // (blacklist semantics, not whitelist-by-visible-set).
    { id: 't4', agent: 'deleted-agent' },
    // non-string agent field is left untouched
    { id: 't5' },
  ]
  assert.deepEqual(
    filterUserVisibleByAgentField(items).map((i) => i.id),
    ['t1', 't3', 't4', 't5'],
  )
})
