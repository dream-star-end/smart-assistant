// OCV5-361: Intelligent UI toggle reaches spawn-time prompts (CCB/Codex) on the next turn.
// A runner that recorded `promptIntelligentUi` is restarted under the turn lock when the
// master-side setting no longer matches; unknown (fetch failure / non-recording engine) never restarts.
// The master fetch itself is covered in intelligentUi.test.ts; here it is replaced by a stub.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
  await rm(home, { recursive: true, force: true })
})

let desired: boolean | undefined
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
async function run(t: TestContext, opts: { applied?: boolean; channel?: string }) {
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
    sessionKey: `agent:main:${opts.channel ?? 'webchat'}:dm:iui-${id}`,
    agent: { id: 'main', model: 'grok-build', cwd: dir },
    model: 'grok-build',
    executionAuthority: { engine: 'grok', canonicalModel: 'grok-build', source: 'local_catalog' },
    workspaceCwd: dir,
  })
  // Stand-in for a CCB/Codex runner that recorded its spawn-time prompt.
  if (opts.applied !== undefined) {
    Object.defineProperty(session.runner, 'promptIntelligentUi', { get: () => opts.applied, configurable: true })
  }
  const calls: string[] = []
  t.mock.method(session.runner, 'shutdown', async () => { calls.push('shutdown') })
  t.mock.method(session.runner, 'submitTurn', () => {
    calls.push('submitTurn')
    throw new Error('stop-after-submit')
  })
  await sm.submit(session, 'hi', () => {}).catch(() => {})
  await session.lock
  return calls
}

test('on → off: runner restarted before the turn', { timeout: 15000 }, async (t) => {
  desired = false
  assert.deepEqual((await run(t, { applied: true })).slice(0, 2), ['shutdown', 'submitTurn'])
})

test('off → on: runner restarted before the turn', { timeout: 15000 }, async (t) => {
  desired = true
  assert.deepEqual((await run(t, { applied: false })).slice(0, 2), ['shutdown', 'submitTurn'])
})

test('unchanged: no restart', { timeout: 15000 }, async (t) => {
  desired = true
  const calls = await run(t, { applied: true })
  assert.equal(calls.includes('shutdown'), false)
  assert.ok(calls.includes('submitTurn'))
})

test('master unreachable (undefined): never restarts — failure is not "off"', { timeout: 15000 }, async (t) => {
  desired = undefined
  const calls = await run(t, { applied: true })
  assert.equal(calls.includes('shutdown'), false)
  assert.ok(calls.includes('submitTurn'))
})

test('engines that rebuild per turn (no record): no lookup, no restart', { timeout: 15000 }, async (t) => {
  desired = false
  const calls = await run(t, {})
  assert.equal(calls.includes('shutdown'), false)
  assert.equal(fetches, 0)
})

test('non-webchat session: no lookup, no restart', { timeout: 15000 }, async (t) => {
  desired = true
  const calls = await run(t, { applied: false, channel: 'wechat' })
  assert.equal(calls.includes('shutdown'), false)
  assert.equal(fetches, 0)
})
