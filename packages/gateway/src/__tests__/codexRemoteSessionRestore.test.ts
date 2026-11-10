import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { EngineCreateOpts } from '../engine/registry.js'

const home = await mkdtemp(join(tmpdir(), 'codex-remote-restore-'))
process.env.OPENCLAUDE_HOME = home
Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
const { closeSessionsDb } = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { registerEngine } = await import('../engine/registry.js')
const { MinimalPrivacyRunner } = await import('./fixtures/minimalPrivacyRunner.js')

after(async () => { await closeSessionsDb(); await rm(home, { recursive: true, force: true }) })

const MODEL = 'gpt-6.1-sol-remote'
const created: EngineCreateOpts[] = []
class FixtureRunner extends MinimalPrivacyRunner {
  sessionId: string | null = null
  isRunning = false
  lastActivityAt = Date.now()
  readonly executionBackend: EngineCreateOpts['executionBackend']
  constructor(opts: EngineCreateOpts) { super(); this.executionBackend = opts.executionBackend; this.sessionId = opts.resumeSessionId ?? null }
  get nativeSessionId() { return this.sessionId }
  async start() { throw new Error('NO_MODEL_OR_PROCESS_ALLOWED') }
  async shutdown() { this.isRunning = false }
  clearSessionId() { this.sessionId = null }
  setModel() {}
  setResumeSessionId(id: string) { this.sessionId = id }
  async waitForOutputDrain() {}
  interrupt() { return false }
}
registerEngine('codex', (opts) => { created.push(opts); return new FixtureRunner(opts) as never })
registerEngine('ccb', (opts) => new FixtureRunner(opts) as never)
const config = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
  auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' }, defaults: { model: MODEL },
} as unknown as OpenClaudeConfig

test('a remote Codex chat rebuilt after a restart resumes its saved thread instead of refusing', async () => {
  const sm = new SessionManager(config)
  const m = sm as any
  m._saveResumeMap = () => {}
  const peer = 'codex_restore_1', sessionKey = `agent:main:webchat:dm:${peer}`, thread = randomUUID()
  m._resumeMap.set(sessionKey, thread); m._resumeMapProvider.set(sessionKey, 'codex')
  const executionBackend = { kind: 'codex-app-server-v1' as const, version: 1 as const, sessionKey,
    operationId: randomUUID(), generation: '2', profileId: 'default', authEpoch: 'epoch-1' }
  const session = await sm.getOrCreate({ sessionKey, peerId: peer, channel: 'webchat',
    agent: { id: 'main', cwd: home }, model: MODEL, workspaceCwd: home,
    executionAuthority: { engine: 'codex', canonicalModel: MODEL, source: 'bridge_signed', executionBackend } } as never)
  assert.equal(created.at(-1)?.resumeSessionId, thread)
  assert.equal(session.runner.nativeSessionId, thread)
})

test('a chat pre-warmed after the restart still resumes on its remote Codex lane', async () => {
  const sm = new SessionManager(config)
  const m = sm as any
  m._saveResumeMap = () => {}
  const peer = 'codex_restore_2', sessionKey = `agent:main:webchat:dm:${peer}`, thread = randomUUID()
  m._resumeMap.set(sessionKey, thread); m._resumeMapProvider.set(sessionKey, 'codex')
  const base = { sessionKey, peerId: peer, channel: 'webchat', agent: { id: 'main', cwd: home }, model: MODEL, workspaceCwd: home }
  // Auto-resume pre-warms every chat on the agent's default model (CCB) before its first turn arrives.
  await sm.getOrCreate({ ...base, model: 'box-claude-opus-5-5',
    executionAuthority: { engine: 'ccb', canonicalModel: 'box-claude-opus-5-5', source: 'local_catalog' } } as never)
  const executionBackend = { kind: 'codex-app-server-v1' as const, version: 1 as const, sessionKey,
    operationId: randomUUID(), generation: '3', profileId: 'default', authEpoch: 'epoch-1' }
  const session = await sm.getOrCreate({ ...base,
    executionAuthority: { engine: 'codex', canonicalModel: MODEL, source: 'bridge_signed', executionBackend } } as never)
  assert.equal(session.runner.executionBackend, executionBackend)
  assert.equal(session.runner.nativeSessionId, thread)
})

test('a chat whose saved history is local, not a Codex thread, still needs a new chat on the remote lane', async () => {
  const sm = new SessionManager(config)
  const m = sm as any
  m._saveResumeMap = () => {}
  const peer = 'codex_restore_3', sessionKey = `agent:main:webchat:dm:${peer}`
  m._resumeMap.set(sessionKey, randomUUID()); m._resumeMapProvider.set(sessionKey, 'ccb')
  const executionBackend = { kind: 'codex-app-server-v1' as const, version: 1 as const, sessionKey,
    operationId: randomUUID(), generation: '1', profileId: 'default', authEpoch: 'epoch-1' }
  await assert.rejects(sm.getOrCreate({ sessionKey, peerId: peer, channel: 'webchat',
    agent: { id: 'main', cwd: home }, model: MODEL, workspaceCwd: home,
    executionAuthority: { engine: 'codex', canonicalModel: MODEL, source: 'bridge_signed', executionBackend } } as never),
  /CC5_BACKEND_REQUIRES_NEW_SESSION/)
})
