/**
 * Grok adapter platform-goal injection.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/grokAdapterGoal.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { GoalStateSnapshot } from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { GrokAdapter, _internals } from '../engine/grokAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const active: GoalStateSnapshot = {
  sessionId: 'web-goal-1',
  goalId: '11111111-1111-4111-8111-111111111111',
  objective: 'finish the grok migration',
  status: 'active',
  tokenBudget: 1000,
  creditBudget: '500',
  tokensUsed: 120,
  creditsUsed: '34',
  timeUsedSeconds: 9,
  stateRevision: 1,
  snapshotRevision: 2,
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  statusChangedAt: '2026-07-16T00:00:00.000Z',
}

function opts(): EngineCreateOpts {
  return {
    sessionKey: 'agent:main:webchat:dm:grok-goal',
    agentId: 'main',
    agentBaseDir: '/tmp',
    config: {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: '' },
      defaults: { model: 'grok-build' },
    } as unknown as OpenClaudeConfig,
    model: 'grok-build',
  } as EngineCreateOpts
}

describe('GrokAdapter platform goal injection', () => {
  test('setGoalState injects the active objective into the next turn prompt', async () => {
    const adapter = new GrokAdapter(opts())
    await adapter.setGoalState(active)
    const prompt = _internals.promptWithStoredGoal(adapter, 'platform ctx', 'hello')
    assert.match(prompt, /finish the grok migration/)
    assert.match(prompt, /<openclaude_active_goal>/)
    assert.ok(prompt.indexOf('</openclaude_active_goal>') < prompt.indexOf('hello'))
  })

  test('setGoalState(null) and non-active snapshots omit the goal block', async () => {
    const adapter = new GrokAdapter(opts())
    await adapter.setGoalState(active)
    await adapter.setGoalState(null)
    assert.doesNotMatch(
      _internals.promptWithStoredGoal(adapter, 'platform ctx', 'hello'),
      /finish the grok migration/,
    )
    for (const status of ['paused', 'blocked', 'completed', 'cleared'] as const) {
      await adapter.setGoalState({ ...active, status })
      assert.equal(
        _internals.promptWithStoredGoal(adapter, 'platform ctx', 'hello').includes('<openclaude_active_goal>'),
        false,
        `status=${status} must not inject`,
      )
    }
  })
})
