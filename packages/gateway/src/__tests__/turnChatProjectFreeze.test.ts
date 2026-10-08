/**
 * The project a turn's outputs are registered in is the one that turn
 * resolved at its start: a queued next message that resolved another project
 * must not replace it while the turn runs.
 * Run: npx tsx --test packages/gateway/src/__tests__/turnChatProjectFreeze.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'

import type { OpenClaudeConfig } from '@openclaude/storage'
import type { EngineCapabilities, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import { type AgentSession, SessionManager } from '../sessionManager.js'

const CAPS: EngineCapabilities = {
  billingMode: 'proxy',
  supportsEffort: true,
  resumeKind: 'ccb-session',
  needsServerRequestId: false,
  historyMode: 'native-resume',
  permissionModel: 'native',
  emitsCallUsage: true,
  emitsToolInputDeltas: true,
  supportsNativeCompact: true,
  multimodalInput: 'native',
}

function config(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.2' },
  } as unknown as OpenClaudeConfig
}

/** Each turn waits for release(); records the session's project at start and at end. */
class GatedRunner extends EventEmitter {
  readonly engineId = 'ccb'
  readonly capabilities = CAPS
  lastActivityAt = Date.now()
  effortLevel: string | undefined = undefined
  model: string | undefined = 'glm-5.2'
  session!: AgentSession
  seen: Array<{ at: 'start' | 'end'; project: string | null | undefined }> = []
  private gates: Array<() => void> = []
  started = 0

  setTraceId(): void {}
  setEffortLevel(): void {}
  setModel(): void {}
  interrupt(): boolean { return false }
  async shutdown(): Promise<void> {}
  release(): void { this.gates.shift()?.() }

  submitTurn(_params: TurnParams): EngineTurnRun {
    this.started += 1
    this.seen.push({ at: 'start', project: this.session.turnChatProjectId })
    const gate = new Promise<void>((done) => this.gates.push(done))
    const summary = gate.then(() => {
      this.seen.push({ at: 'end', project: this.session.turnChatProjectId })
      return {
        usage: { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 },
        assistantText: '',
        thinkingText: '',
        assistantSegments: [],
        thinkingSegments: [],
        tools: [],
        runtimeEvents: [],
        stopReason: 'end_turn',
        numTurns: 1,
        isError: false,
        staleResumeId: false,
        phantomSignals: { apiState: 'skipped' as const, skipReason: 'unit-test' },
      }
    })
    return {
      submitted: Promise.resolve(),
      summary,
      end: () => {},
      getPartialSnapshot: () => ({
        assistantText: '',
        thinkingText: '',
        completedTools: [],
        assistantSegments: [],
        thinkingSegments: [],
        runtimeEvents: [],
      }),
      getPhantomSignals: () => ({ apiState: 'skipped' as const, skipReason: 'unit-test' }),
      finalized: true,
      pendingToolCalls: 0,
    } as unknown as EngineTurnRun
  }
}

function makeSession(runner: GatedRunner): AgentSession {
  const session = {
    sessionKey: `agent:main:unit:dm:freeze-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'main',
    channel: 'unit',
    peerId: 'freeze-peer',
    title: 'Freeze',
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
    turns: 0,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: runner.engineId,
    agentProvider: undefined,
  } as unknown as AgentSession
  runner.session = session
  return session
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((done) => setTimeout(done, 5))
  assert.ok(cond(), 'timed out')
}

describe('turnChatProjectId is frozen per turn', () => {
  test('a queued next message in another project does not change the running turn', async () => {
    const runner = new GatedRunner()
    const session = makeSession(runner)
    const sm = new SessionManager(config())
    ;(sm as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}

    const first = sm.submit(session, 'in project A', () => {}, undefined, undefined, undefined, undefined, undefined, {
      turnChatProjectId: 'proj-a',
    })
    await until(() => runner.started === 1)
    // The user moved the chat to project B and sent again while turn 1 runs.
    const second = sm.submit(session, 'now in project B', () => {}, undefined, undefined, undefined, undefined, undefined, {
      turnChatProjectId: 'proj-b',
    })
    await new Promise((done) => setTimeout(done, 20))
    runner.release()
    await until(() => runner.started === 2)
    runner.release()
    await Promise.all([first, second])
    assert.deepEqual(runner.seen, [
      { at: 'start', project: 'proj-a' },
      { at: 'end', project: 'proj-a' },
      { at: 'start', project: 'proj-b' },
      { at: 'end', project: 'proj-b' },
    ])
  })

  test('a turn that did not resolve a project does not inherit the previous one', async () => {
    const runner = new GatedRunner()
    const session = makeSession(runner)
    const sm = new SessionManager(config())
    ;(sm as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
    const a = sm.submit(session, 'one', () => {}, undefined, undefined, undefined, undefined, undefined, {
      turnChatProjectId: 'proj-a',
    })
    await until(() => runner.started === 1)
    runner.release()
    await a
    const b = sm.submit(session, 'two', () => {})
    await until(() => runner.started === 2)
    runner.release()
    await b
    assert.equal(runner.seen[2]?.project, undefined)
  })
})
