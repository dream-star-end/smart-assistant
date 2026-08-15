/**
 * Stop must always reach a terminal state.
 *
 * The post-shutdown stdout-close barrier keeps late paid bytes inside the turn,
 * but the supervisor's own shutdown is already bounded — so still waiting here
 * means a descendant outlived a process-group SIGKILL and owns the pipe. That
 * wait used to be unbounded: `interrupt ok:true` was the last line the session
 * ever logged and the client sat in "stopping" forever.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/terminalOutputDrainDeadline.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { OpenClaudeConfig } from '@openclaude/storage'
import { type AgentSession, SessionManager } from '../sessionManager.js'

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
  } as unknown as OpenClaudeConfig
}

function sessionStub(): AgentSession {
  return {
    sessionKey: 'agent:main:webchat:dm:drain-deadline',
    providerTag: 'cursor',
  } as unknown as AgentSession
}

type DrainSeam = {
  _terminalOutputDrainTimeoutMs: number
  _awaitBoundedOutputDrain(
    runner: { waitForOutputDrain(): Promise<void> },
    session: AgentSession,
  ): Promise<void>
}

function seam(): DrainSeam {
  return new SessionManager(makeConfigStub()) as unknown as DrainSeam
}

describe('bounded terminal output drain', () => {
  test('returns at the deadline when stdout never closes', async () => {
    const manager = seam()
    manager._terminalOutputDrainTimeoutMs = 60
    const startedAt = Date.now()
    await manager._awaitBoundedOutputDrain(
      { waitForOutputDrain: () => new Promise<void>(() => {}) },
      sessionStub(),
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 50, `expected the deadline to be honoured, returned after ${elapsed}ms`)
    assert.ok(elapsed < 10_000, `expected a bounded wait, returned after ${elapsed}ms`)
  })

  test('does not delay a turn whose stdout closes normally', async () => {
    const manager = seam()
    manager._terminalOutputDrainTimeoutMs = 60_000
    const startedAt = Date.now()
    await manager._awaitBoundedOutputDrain(
      { waitForOutputDrain: () => Promise.resolve() },
      sessionStub(),
    )
    assert.ok(Date.now() - startedAt < 5_000, 'a normal close must not wait for the deadline')
  })

  test('a disabled deadline keeps the original unbounded barrier', async () => {
    const manager = seam()
    manager._terminalOutputDrainTimeoutMs = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let settled = false
    const waiting = manager
      ._awaitBoundedOutputDrain({ waitForOutputDrain: () => held }, sessionStub())
      .then(() => {
        settled = true
      })
    await new Promise((tick) => setTimeout(tick, 100))
    assert.equal(settled, false, 'a disabled deadline must not release the barrier early')
    release()
    await waiting
    assert.equal(settled, true)
  })
})
