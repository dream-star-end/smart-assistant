import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test, type TestContext } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'

const home = await mkdtemp(join(tmpdir(), 'oc-iui-restart-'))
process.env.OPENCLAUDE_HOME = home
delete process.env.OC_RUNTIME_CHANNEL
delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
const { closeSessionsDb } = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { __resetIntelligentUiDesiredCacheForTests, __setIntelligentUiDesiredFetchForTests } = await import(
  '../intelligentUiDesired.js'
)

after(async () => {
  __resetIntelligentUiDesiredCacheForTests()
  await closeSessionsDb()
})

const ON = 'a'.repeat(64)
const ON_NO_PREDICTION = 'b'.repeat(64)
let desired: string | false | undefined
let fetches = 0
beforeEach(() => {
  __resetIntelligentUiDesiredCacheForTests()
  fetches = 0
  __setIntelligentUiDesiredFetchForTests(async () => {
    fetches += 1
    return desired
  })
})

let serial = 0
async function run(t: TestContext, opts: { applied?: string; failShutdown?: boolean; stillAlive?: boolean }) {
  const id = ++serial
  const dir = join(home, 'fx-' + id)
  await mkdir(dir, { recursive: true })
  const config = {
    version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' },
    defaults: { model: 'glm-5.3-zai' },
  } as unknown as OpenClaudeConfig
  const sm = new SessionManager(config)
  const session = await sm.getOrCreate({
    sessionKey: `agent:main:webchat:dm:iui-${id}`,
    agent: { id: 'main', model: 'grok-build', cwd: dir },
    model: 'grok-build',
    executionAuthority: { engine: 'grok', canonicalModel: 'grok-build', source: 'local_catalog' },
    workspaceCwd: dir,
  })
  let frozen: unknown
  Object.defineProperty(session.runner, 'promptPolicyFingerprint', { get: () => opts.applied, configurable: true })
  Object.assign(session.runner, { setPromptPrivacy: (p: unknown) => { frozen = p }, assertPromptPrivacyStopped: () => { if (opts.stillAlive) throw new Error('fixture-not-closed') } })
  const calls: string[] = []
  t.mock.method(session.runner, 'shutdown', async () => { calls.push('shutdown'); if (opts.failShutdown) throw new Error('fixture-shutdown-failed') })
  t.mock.method(session.runner, 'submitTurn', () => {
    calls.push('submitTurn')
    throw new Error('stop-after-submit')
  })
  // The stub throws inside submitTurn, before the turn can settle, so the turn's 30-minute idle timer is
  // never cleared and kept this file's process alive (CI cancelled the gateway job, OCV5-380). Fake it.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await sm.submit(session, 'hi', () => {}).catch(() => {})
  await session.lock
  return { calls, frozen }
}

test('privacy withdrawal restarts even with IUI and prediction off, then uses the frozen off snapshot', { timeout: 15000 }, async t => {
  desired = false
  const { calls, frozen } = await run(t, { applied: 'old-personal-prompt' })
  assert.deepEqual(calls.slice(0, 2), ['shutdown', 'submitTurn'])
  assert.deepEqual(frozen, { schemaVersion: 1, profile: null })
})
test('privacy shutdown failure never submits using the previous prompt', { timeout: 15000 }, async t => {
  desired = false
  const { calls } = await run(t, { applied: 'old-personal-prompt', failShutdown: true })
  assert.deepEqual(calls, ['shutdown'])
})

test('a resolved shutdown with an unclosed process cannot submit old context', { timeout: 15000 }, async t => {
  desired = false
  const { calls } = await run(t, { applied: 'old-personal-prompt', stillAlive: true })
  assert.deepEqual(calls, ['shutdown'])
})
test('unknown preheat fingerprint is recycled before any new submit', { timeout: 15000 }, async t => {
  desired = false
  const { calls } = await run(t, {})
  assert.deepEqual(calls.slice(0, 2), ['shutdown', 'submitTurn'])
})
