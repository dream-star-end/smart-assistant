/**
 * Cursor adapter platform-goal injection.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cursorAdapterGoal.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { GoalStateSnapshot } from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { CursorAdapter, _internals } from '../engine/cursorAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const active: GoalStateSnapshot = {
  sessionId: 'web-goal-1',
  goalId: '11111111-1111-4111-8111-111111111111',
  objective: 'finish the cursor migration',
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
    sessionKey: 'agent:main:webchat:dm:cursor-goal',
    agentId: 'main',
    agentBaseDir: '/tmp',
    config: {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 18789, accessToken: 't' },
      auth: { mode: 'api_key', claudeCodePath: '/tmp' },
      defaults: { model: 'cursor-auto', permissionMode: 'default' },
    } as OpenClaudeConfig,
    model: 'cursor-auto',
  } as EngineCreateOpts
}

describe('CursorAdapter platform goal injection', () => {
  test('setGoalState injects the active objective into the next turn prompt', async () => {
    const adapter = new CursorAdapter(opts())
    await adapter.setGoalState(active)
    const prompt = _internals.promptWithStoredGoal(adapter, 'CTX', 'user payload', 'PREAMBLE')
    assert.match(prompt, /finish the cursor migration/)
    assert.match(prompt, /<openclaude_active_goal>/)
    assert.ok(prompt.indexOf('</openclaude_platform_context>') < prompt.indexOf('<openclaude_active_goal>'))
    assert.ok(prompt.indexOf('</openclaude_active_goal>') < prompt.indexOf('<openclaude_current_turn_payload_json>'))
  })

  test('setGoalState(null) and non-active snapshots omit the goal block', async () => {
    const adapter = new CursorAdapter(opts())
    await adapter.setGoalState(active)
    await adapter.setGoalState(null)
    assert.doesNotMatch(
      _internals.promptWithStoredGoal(adapter, 'CTX', 'user payload', 'PREAMBLE'),
      /finish the cursor migration/,
    )
    for (const status of ['paused', 'blocked', 'completed', 'cleared'] as const) {
      await adapter.setGoalState({ ...active, status })
      assert.equal(
        _internals.promptWithStoredGoal(adapter, 'CTX', 'user payload', 'PREAMBLE').includes('<openclaude_active_goal>'),
        false,
        `status=${status} must not inject`,
      )
    }
  })
})
