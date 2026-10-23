import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { SessionManager, type AgentSession } from '../sessionManager.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { SubprocessRunner } from '../subprocessRunner.js'
import { SystemHelpRelay, setSystemHelpRelay } from '../systemHelpRelay.js'
import { MinimalPrivacyRunner } from './fixtures/minimalPrivacyRunner.js'
class IsolatedRunner extends MinimalPrivacyRunner {
  isRunning = true
  lastActivityAt = Date.now()
  onSubmit: () => void = () => {}
  consultTurn: unknown
  setConsultTurn(value: unknown) { this.consultTurn = value }
  async start() { this.recordBuiltPromptPrivacy(); this.isRunning = true }
  async submit() { this.recordBuiltPromptPrivacy(); this.onSubmit() }
  interrupt() { return false }
  async shutdown() { this.isRunning = false }
  clearSessionId() {}
  async waitForOutputDrain() {}
  finish() {
    this.emit('message', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'synthetic completion' } } })
    this.emit('message', { type: 'result', total_cost_usd: 0, usage: {}, is_error: false })
  }
}
function fixture(t: import('node:test').TestContext) {
  const config = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' }, auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' } } as unknown as OpenClaudeConfig
  const manager = new SessionManager(config)
  const raw = new IsolatedRunner()
  const runner = new CcbAdapter({ config } as EngineCreateOpts, raw as unknown as SubprocessRunner)
  const session = { sessionKey: 'agent:main:webchat:dm:synthetic-help-lifecycle', agentId: 'main', channel: 'unit', peerId: 'synthetic-help-lifecycle', title: 'isolated', startedAt: Date.now(), runner,
    lock: Promise.resolve(), lastUsedAt: 0, totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0, turns: 0, _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(), executionTarget: { kind: 'local' }, providerTag: 'ccb', _currentTurnKey: 'synthetic-turn', _currentTurnTraceId: 'synthetic-trace', _externalTurnAbort: new AbortController() } as unknown as AgentSession
  const map = (manager as unknown as { sessions: Map<string, AgentSession> }).sessions
  map.set(session.sessionKey, session)
  const relay = new SystemHelpRelay(async raw => (raw as { kind: string }).kind === 'refresh' ? { token: 'synthetic-short', expiresAt: Date.now() + 60000 } : { visible: true })
  setSystemHelpRelay(manager, relay)
  const end = relay.begin(session, 'synthetic-bootstrap')
  let submitted!: () => void
  const started = new Promise<void>(resolve => { submitted = resolve })
  raw.onSubmit = submitted
  const run = () => (manager as unknown as { _runOneTurn: (...args: unknown[]) => Promise<void> })._runOneTurn(session, 'synthetic request', () => {}, 'synthetic-request', 'synthetic-trace', undefined, undefined, undefined, undefined, 'synthetic-turn')
  const request = () => {
    const context = JSON.parse(readFileSync(relay.contextFile(session.sessionKey), 'utf8'))
    return relay.request({ nonce: context.nonce, context: context.context, command: { kind: 'catalog' } })
  }
  t.after(async () => { end(); await manager.shutdownAll() })
  return { manager, raw, runner, session, map, relay, run, started, request }
}
test('real turn orchestration exposes help only during its current runner attempt and revokes it before completion persistence', { timeout: 5000 }, async t => {
  const f = fixture(t); const running = f.run(); await f.started
  assert.deepEqual(await f.request(), { visible: true })
  f.session._plannedTeardown = 'service_restart'; await assert.rejects(f.request()); f.session._plannedTeardown = undefined
  f.map.delete(f.session.sessionKey); await assert.rejects(f.request()); f.map.set(f.session.sessionKey, f.session)
  f.session._currentTurnTraceId = 'synthetic-next-trace'; await assert.rejects(f.request()); f.session._currentTurnTraceId = 'synthetic-trace'
  f.raw.finish(); await running
  await assert.rejects(f.request())
})
test('Stop synchronously closes help before a cooperative runner can finish', { timeout: 5000 }, async t => {
  const f = fixture(t); const running = f.run(); await f.started
  assert.deepEqual(await f.request(), { visible: true })
  f.manager.interrupt(f.session.sessionKey, 'user')
  await assert.rejects(f.request())
  f.raw.finish(); await running
})
test('synchronous engine submission failure revokes help and detaches the turn listeners', { timeout: 5000 }, async t => {
  const f = fixture(t)
  f.runner.submitTurn = () => { throw new Error('synthetic synchronous submit failure') }
  await assert.rejects(f.run(), /synthetic synchronous submit failure/)
  await assert.rejects(f.request())
  assert.equal(f.runner.listenerCount('activity'), 0)
})
