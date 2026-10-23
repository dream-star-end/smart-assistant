import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test, type TestContext } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'

const home = await mkdtemp(join(tmpdir(), 'oc-iui-restart-'))
process.env.OPENCLAUDE_HOME = home
Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL')
Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN')
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
async function run(t: TestContext, opts: { applied?: string; failShutdown?: boolean; stillAlive?: boolean; metadataFailure?: boolean; interruptDuringMetadata?: boolean }) {
  const id = ++serial
  const dir = join(home, `fx-${id}`)
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
  const errors: string[] = []
  const onEvent = (event: { kind: string; error?: string }) => { if (event.kind === 'error') errors.push(String(event.error)) }
  let metadataAvailable = opts.interruptDuringMetadata === true
  let interruptedAtMetadata = false
  let firstAttemptCalls: string[] | undefined
  if (opts.metadataFailure || opts.interruptDuringMetadata) {
    // Exercise the post-admission warm runner gate, without an identity factory replacing this fixture.
    session._identityCreationOpts = undefined
    const { setV3MasterSinkSingleton } = await import('../v3MasterSink.js')
    setV3MasterSinkSingleton({ persistOrQueue: async () => ({ ok: true }), attemptOnce: async () => {} })
    t.after(() => setV3MasterSinkSingleton(null))
    const before = [process.env.OPENCLAUDE_V3_MASTER_BASE_URL, process.env.OPENCLAUDE_V3_CONTAINER_TOKEN, process.env.OC_USER_ID]
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/internal/v3/marketplace/sync')) {
        res.end(JSON.stringify({ identityCompat: { schema: 1, userId: '765', profiles: [] } })); return
      }
      if (!req.url?.startsWith('/internal/v3/platform-prompt-slots')) { res.statusCode = 404; res.end(); return }
      if (opts.interruptDuringMetadata) {
        const abort = session._externalTurnAbort
        assert.ok(abort, 'privacy await must already have the logical turn cancellation signal')
        sm.interrupt(session.sessionKey, 'user')
        assert.equal(abort.signal.aborted, true)
        interruptedAtMetadata = true
      }
      res.statusCode = metadataAvailable ? 200 : 503
      res.end(metadataAvailable ? JSON.stringify({ slots: [], promptPolicy: { schemaVersion: 1, profile: null } }) : '')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'synthetic-fixture-only'
    process.env.OC_USER_ID = '765'
    t.after(() => {
      for (const [i, key] of ['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN', 'OC_USER_ID'].entries()) {
        if (before[i] === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = before[i]
      }
    })
    // Stop exactly at the model invocation boundary; engine/billing admission is covered independently.
    if (opts.metadataFailure) t.mock.method(sm as unknown as { runOneTurnWithRetry: (...args: unknown[]) => Promise<void> }, 'runOneTurnWithRetry', async () => {
      calls.push('submitTurn'); throw new Error('stop-at-model-boundary')
    })
    let model = 'fixture-old-model'
    let effort = 'high'
    let serviceTier: string | null = 'fast'
    Object.defineProperty(session.runner, 'model', { get: () => model, configurable: true })
    Object.defineProperty(session.runner, 'effortLevel', { get: () => effort, configurable: true })
    t.mock.method(session.runner, 'setModel', (next: string | undefined) => { calls.push('setModel'); model = next ?? '' })
    t.mock.method(session.runner, 'setEffortLevel', (next: string | undefined) => { calls.push('setEffort'); effort = next ?? '' })
    let tools = ['Bash']
    Object.defineProperty(session.runner, 'toolsets', { get: () => tools, configurable: true })
    Object.assign(session.runner, {
      setToolsets(next: string[]) { calls.push('setToolsets'); tools = next },
      setServiceTier(next: string | null) { const changed = next !== serviceTier; calls.push('setTier'); serviceTier = next; return changed ? 'restart' : 'none' },
    })
  }
  // The stub throws inside submitTurn, before the turn can settle, so the turn's 30-minute idle timer is
  // never cleared and kept this file's process alive (CI cancelled the gateway job, OCV5-380). Fake it.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  if (opts.metadataFailure) {
    const attempt = () => sm.submit(session, 'hi', onEvent, 'low', 'grok-build', 'a'.repeat(32), undefined, undefined, { serviceTier: null, toolsets: ['Read'] }).catch(error => { errors.push(String(error)) })
    await attempt(); await session.lock
    firstAttemptCalls = [...calls]
    calls.length = 0; metadataAvailable = true
    await attempt()
  } else await sm.submit(session, 'hi', () => {}).catch(() => {})
  await session.lock
  return { calls, frozen, firstAttemptCalls, errors, interruptedAtMetadata }
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

test('failed privacy metadata leaves all warm desired configuration unchanged; retry still restarts', { timeout: 15000 }, async t => {
  desired = false
  const { promptPrivacyFingerprint } = await import('../promptPrivacyPolicy.js')
  const off = promptPrivacyFingerprint({ schemaVersion: 1, profile: null }, undefined)
  const result = await run(t, { applied: off, metadataFailure: true })
  assert.deepEqual(result.firstAttemptCalls, [])
  assert.ok(result.calls.includes('setModel'), JSON.stringify(result.errors))
  assert.ok(result.calls.includes('setEffort'))
  assert.ok(result.calls.includes('setToolsets'))
  assert.ok(result.calls.includes('setTier'))
  assert.equal(result.calls.filter(call => call === 'shutdown').length, 1)
  assert.equal(result.calls.at(-1), 'submitTurn')
})


test('user interrupt during awaited privacy metadata cannot reach a model invocation', { timeout: 15000 }, async t => {
  const result = await run(t, { applied: 'previous-private-policy', interruptDuringMetadata: true })
  assert.equal(result.interruptedAtMetadata, true)
  assert.equal(result.calls.includes('submitTurn'), false)
})
