import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'

import { CcbAdapter } from '../engine/ccbAdapter.js'
import { CodexAdapter } from '../engine/codexAdapter.js'
import type { CodexAppServerRunner } from '../engine/codexAppServerRunner.js'
import type { EngineAdapter } from '../engine/engineAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import { type AgentSession, SessionManager } from '../sessionManager.js'
import type { SubprocessRunner } from '../subprocessRunner.js'

const config = {
  version: 1,
  gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
  auth: { mode: 'subscription', claudeCodePath: '' },
  sessions: { dbPath: '' },
  defaults: { model: 'glm-5.2' },
} as unknown as OpenClaudeConfig

class FakeCcbKernel extends EventEmitter {
  submitted = false
  lastActivityAt = Date.now()
  sessionId: string | null = 'ccb-queue-thread'
  model: string | undefined
  effortLevel: string | undefined
  toolsets: string[] | undefined
  executionTarget = { kind: 'local' as const }
  get isRunning() {
    return true
  }
  async submit(): Promise<void> {
    this.submitted = true
  }
  finish(): void {
    this.emit('message', {
      type: 'result',
      total_cost_usd: 0,
      usage: { output_tokens: 1 },
      stop_reason: 'end_turn',
      is_error: false,
    })
  }
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async waitForOutputDrain(): Promise<void> {}
  interrupt(): boolean {
    return false
  }
  clearSessionId(): void {
    this.sessionId = null
  }
  setModel(value: string | undefined): void {
    this.model = value
  }
  setEffortLevel(value: string | undefined): void {
    this.effortLevel = value
  }
  setTraceId(): void {}
  setGoalState(): boolean {
    return false
  }
  updateConfig(): void {}
  setToolsets(value: string[] | undefined): void {
    this.toolsets = value
  }
  setExecutionTarget(value: { kind: 'local' }): void {
    this.executionTarget = value
  }
  sendPermissionResponse(): boolean {
    return false
  }
  getBoundRepoBinding(): null {
    return null
  }
  async updateTurnLease(): Promise<void> {}
}

class FakeCodexKernel extends EventEmitter {
  submitted = false
  queueTurn: boolean | undefined
  lastActivityAt = Date.now()
  model: string | undefined = 'gpt-5.6-sol'
  effortLevel: string | undefined
  get isRunning() {
    return true
  }
  async submit(
    _input: unknown,
    requestId?: string,
    _policy?: unknown,
    queueTurn?: boolean,
  ): Promise<void> {
    this.submitted = true
    this.queueTurn = queueTurn
    this.requestId = requestId
  }
  private requestId: string | undefined
  finish(): void {
    this.emit('message', {
      type: 'result',
      total_cost_usd: 0,
      usage: { output_tokens: 1 },
      stop_reason: 'end_turn',
      is_error: false,
      requestId: this.requestId,
    })
  }
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async waitForOutputDrain(): Promise<void> {}
  interrupt(): boolean {
    return false
  }
  clearSessionId(): void {}
  setModel(value: string | undefined): void {
    this.model = value
  }
  setEffortLevel(value: string | undefined): void {
    this.effortLevel = value
  }
  setTraceId(): void {}
  async setGoalState(): Promise<void> {}
  updateConfig(): void {}
  setCodexRoute(): void {}
  setConversationMode(): void {}
  sendPermissionResponse(): boolean {
    return false
  }
  getBoundRepoBinding(): null {
    return null
  }
}

function makeSession(runner: EngineAdapter, suffix: string): AgentSession {
  return {
    sessionKey: `agent:main:webchat:dm:queue-engine-${suffix}`,
    agentId: 'main',
    channel: 'unit',
    peerId: `queue-engine-${suffix}`,
    title: 'Queue Engine Unit',
    startedAt: Date.now(),
    runner,
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 3,
    _lastCcbCumulativeCost: 0,
    _activeClientTurnCount: 1,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: runner.engineId,
  } as unknown as AgentSession
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

describe('prompt queue execution through real engine adapters', () => {
  test('accepted pre-submit fence blocks hidden submit and cross-engine replacement', async () => {
    const kernel = new FakeCcbKernel()
    const adapter = new CcbAdapter(
      {
        sessionKey: 'agent:main:webchat:dm:queue-pre-submit-fence',
        agentId: 'main',
        agentBaseDir: process.cwd(),
        model: 'glm-5.2',
      } as EngineCreateOpts,
      kernel as unknown as SubprocessRunner,
    )
    const session = makeSession(adapter, 'pre-submit-fence')
    session._activeClientTurnCount = 0
    const manager = new SessionManager(config)
    ;(manager as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
    ;(manager as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      session.sessionKey,
      session,
    )
    const fence = manager.beginPromptQueueExecutionFence(session.sessionKey)
    try {
      await assert.rejects(
        manager.submit(session, 'hidden legacy submit', () => {}),
        /PROMPT_QUEUE_EXECUTION_INVARIANT/,
      )
      await assert.rejects(
        manager.getOrCreate({
          sessionKey: session.sessionKey,
          agent: { id: 'main', name: 'Main', model: 'gpt-5.6-sol' } as any,
          channel: 'webchat',
          peerId: session.peerId,
          model: 'gpt-5.6-sol',
        }),
        /PROMPT_QUEUE_EXECUTION_INVARIANT/,
      )
      assert.equal(
        (manager as unknown as { sessions: Map<string, AgentSession> }).sessions.get(
          session.sessionKey,
        ),
        session,
      )
      assert.equal(
        await manager.getOrCreate({
          sessionKey: session.sessionKey,
          agent: { id: 'main', name: 'Main', model: 'glm-5.2' } as any,
          channel: 'webchat',
          peerId: session.peerId,
          model: 'glm-5.2',
          promptQueueExecutionFence: fence,
        }),
        session,
      )
    } finally {
      fence.release()
    }
  })

  for (const engine of ['ccb', 'codex'] as const) {
    test(`${engine} reserves once, owns the execution mutex and rejects a hidden submit`, async () => {
      const kernel = engine === 'ccb' ? new FakeCcbKernel() : new FakeCodexKernel()
      const opts = {
        sessionKey: `queue-${engine}`,
        agentId: 'main',
        agentBaseDir: process.cwd(),
        model: engine === 'codex' ? 'gpt-5.6-sol' : 'glm-5.2',
      } as EngineCreateOpts
      const adapter: EngineAdapter =
        engine === 'ccb'
          ? new CcbAdapter(opts, kernel as unknown as SubprocessRunner)
          : new CodexAdapter(opts, kernel as unknown as CodexAppServerRunner)
      const session = makeSession(adapter, engine)
      const originalLock = session.lock
      const reservations: Array<{ turnIndex: number; turnKey: string }> = []
      const manager = new SessionManager(config)
      ;(manager as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
      ;(manager as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
        session.sessionKey,
        session,
      )

      const execution = manager.submit(
        session,
        'queued turn',
        () => {},
        undefined,
        undefined,
        engine === 'codex' ? 'ab'.repeat(16) : undefined,
        undefined,
        undefined,
        {
          queueLifecycle: {
            queueTurn: true,
            onTurnReserved: async ({ turnIndex, turnKey }) => {
              reservations.push({ turnIndex, turnKey })
            },
          },
        },
      )
      await waitFor(() => kernel.submitted)
      assert.notEqual(session.lock, originalLock, 'the active provider turn must own the mutex')
      let mutexReleased = false
      void session.lock.then(() => { mutexReleased = true })
      await Promise.resolve()
      assert.equal(mutexReleased, false)
      await assert.rejects(
        manager.submit(session, 'hidden second turn', () => {}),
        /PROMPT_QUEUE_EXECUTION_INVARIANT/,
      )
      const switchedModel = engine === 'ccb' ? 'gpt-5.6-sol' : 'glm-5.2'
      await assert.rejects(
        manager.getOrCreate({
          sessionKey: session.sessionKey,
          agent: { id: 'main', name: 'Main', model: switchedModel } as any,
          channel: 'webchat',
          peerId: session.peerId,
          title: session.title,
          model: switchedModel,
        }),
        /PROMPT_QUEUE_EXECUTION_INVARIANT/,
      )
      assert.equal(
        (manager as unknown as { sessions: Map<string, AgentSession> }).sessions.get(
          session.sessionKey,
        ),
        session,
        'cross-engine admission must not replace the active queue session object',
      )
      assert.equal(reservations.length, 1)
      if (kernel instanceof FakeCodexKernel) assert.equal(kernel.queueTurn, true)

      kernel.finish()
      await execution
      await session.lock
      assert.equal(mutexReleased, true)
      assert.equal(session._activeTurnCount, 0)
    })
  }

  test('ImageEdit reserves before relay while owning the execution mutex', async () => {
    const kernel = new FakeCodexKernel()
    const adapter = new CodexAdapter(
      {
        sessionKey: 'queue-image-edit',
        agentId: 'main',
        agentBaseDir: process.cwd(),
        model: 'gpt-5.6-sol',
      } as EngineCreateOpts,
      kernel as unknown as CodexAppServerRunner,
    )
    const session = makeSession(adapter, 'image-edit')
    session._activeClientTurnCount = 0
    const originalLock = session.lock
    const manager = new SessionManager(config)
    ;(manager as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
    const reservations: Array<{ turnIndex: number; turnKey: string }> = []
    const lifecycle = {
      queueTurn: true as const,
      onTurnReserved: async (reservation: { turnIndex: number; turnKey: string }) => {
        reservations.push(reservation)
      },
    }

    const guard = await manager.beginExternalTurn(session, { queueTurn: true })
    assert.notEqual(session.lock, originalLock)
    let mutexReleased = false
    void session.lock.then(() => { mutexReleased = true })
    await Promise.resolve()
    assert.equal(mutexReleased, false)
    const reservation = await manager.reservePromptQueueExternalTurn(session, lifecycle)
    assert.deepEqual(reservations, [reservation])
    assert.equal(session._currentTurnKey, reservation.turnKey)
    await assert.rejects(
      manager.submit(session, 'hidden while ImageEdit runs', () => {}),
      /PROMPT_QUEUE_EXECUTION_INVARIANT/,
    )

    guard.finish('completed')
    await session.lock
    assert.equal(mutexReleased, true)
    assert.equal(session._activeClientTurnCount, 0)
    assert.equal(session._currentTurnKey, undefined)
  })
})
