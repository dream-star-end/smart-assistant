/** Real Gateway HTTP + CcbAdapter/parser, synthetic SDK process (no model/CLI).
 * Proves native identity and lifecycle, NOT receipt ingestion/notification ACK. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SubprocessRunner } from '../subprocessRunner.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { TurnParams } from '../engine/engineAdapter.js'

const home = mkdtempSync(join(tmpdir(), 'receipt-owner-http-'))
process.env.OPENCLAUDE_HOME = home
const { Gateway } = await import('../server.js')
const { CcbAdapter } = await import('../engine/ccbAdapter.js')
const { issueDelegateContextToken, DELEGATE_CONTEXT_HEADER } = await import('../delegateContext.js')
const { signJwt } = await import('../auth.js')
const { ReceiptOwnerCapabilities } = await import('../receiptOwnerCapability.js')

const TOKEN = 'receipt-http-test-only-token'
const SESSION = 'agent:main:webchat:dm:receipt-http'
const TURN = 'server-owned-turn-1'
class SdkProcess extends EventEmitter {
  sessionId = 'native-ccb-session'
  isRunning = true
  submitGate: Promise<void> = Promise.resolve()
  shutdownGate: Promise<void> = Promise.resolve()
  setConsultTurn(): void {}
  async submit(): Promise<void> { await this.submitGate }
  interrupt(): boolean { return true }
  async shutdown(): Promise<void> { await this.shutdownGate; this.isRunning = false }
  tool(id: string, name = 'Bash', parent?: string): void {
    this.emit('message', { type: 'assistant', parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id, name, input: {} }] } })
  }
}
function makeAdapter(harness: 'ccb' | 'official-cc' = 'ccb') {
  const process = new SdkProcess()
  const adapter = new CcbAdapter({ harness } as EngineCreateOpts, process as unknown as SubprocessRunner)
  return { process, adapter }
}
function start(adapter: InstanceType<typeof CcbAdapter>, turnKey: string | undefined = TURN) {
  return adapter.submitTurn({ input: 'synthetic SDK test', turnKey, onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
    toolUseIdToName: new Map(),
  } as TurnParams)
}
async function fixture(userId = 'default') {
  const { process, adapter } = makeAdapter()
  const turn = start(adapter)
  await turn.submitted
  const parent = { agentId: 'main', sessionKey: SESSION, userId, _currentTurnKey: TURN, runner: adapter }
  let visibleParent: typeof parent | undefined = parent
  const gw = new Gateway({
    config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
      auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(home, 'sessions.db') },
      defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } },
    } as never,
    agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' },
  })
  // Only session lookup is a fixture. Request dispatch, auth, adapter and parser are real.
  ;(gw as any).sessions = { getByKey: (key: string) => key === SESSION ? visibleParent : undefined }
  const server = createServer((req, res) => (gw as any).handleHttp(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const context = issueDelegateContextToken({ agentId: 'main', sessionKey: SESSION, depth: 0 })
  async function post(action: string, body: unknown, overrides: Record<string, string> = {}, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}/api/delegate/receipt-owner/${action}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
        [DELEGATE_CONTEXT_HEADER]: context, ...overrides },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, data: await response.json() as any, cache: response.headers.get('cache-control') }
  }
  async function issue(id = 'creator') {
    const result = await post('issue', { toolUseId: id })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(typeof result.data.capability, 'string')
    assert.equal(result.cache, 'no-store')
    return result.data.capability as string
  }
  return { process, adapter, turn, parent, post, issue, context,
    hideParent: () => { visibleParent = undefined },
    close: async () => { turn.end(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
const jwt = (userId: string) => `Bearer ${signJwt({ userId, exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN)}`

test('HTTP requires both ordinary auth and a valid signed parent; body cannot assert identity', async () => {
  const f = await fixture()
  try {
    f.process.tool('creator')
    assert.equal((await f.post('issue', { toolUseId: 'creator' }, { authorization: '' })).status, 401)
    assert.equal((await f.post('issue', { toolUseId: 'creator' }, { [DELEGATE_CONTEXT_HEADER]: '' })).status, 401)
    assert.equal((await f.post('issue', { toolUseId: 'creator' }, { [DELEGATE_CONTEXT_HEADER]: f.context + 'x' })).status, 401)
    for (const body of [null, [], { toolUseId: 'creator', userId: 'default' },
      { toolUseId: 'creator', parentOwnerEpoch: 'forged' }, { nativeToolUseId: 'creator' }, { jobId: 'creator' }]) {
      assert.equal((await f.post('issue', body)).status, 400)
    }
    assert.equal((await f.post('issue', {}, {}, 'GET')).status, 405)
    const otherAgent = issueDelegateContextToken({ agentId: 'other', sessionKey: SESSION, depth: 0 })
    assert.equal((await f.post('issue', { toolUseId: 'creator' }, { [DELEGATE_CONTEXT_HEADER]: otherAgent })).status, 409)
    assert.equal((await f.post('check', { capability: await f.issue() })).data.ownerState, 'active')
  } finally { await f.close() }
})

test('JWT is user-bound; explicit raw service bearer uses signed parent partition, not default fallback', async () => {
  const f = await fixture('c:3')
  try {
    f.process.tool('creator')
    assert.equal((await f.post('issue', { toolUseId: 'creator' }, { authorization: jwt('c:3') })).status, 200)
    for (const user of ['default', 'c:4']) {
      assert.equal((await f.post('issue', { toolUseId: 'creator' }, { authorization: jwt(user) })).status, 403)
    }
    const capability = await f.issue()
    assert.equal((await f.post('check', { capability }, { authorization: jwt('c:4') })).status, 403)
    assert.equal((await f.post('check', { capability }, { authorization: jwt('c:3') })).data.ownerState, 'active')
  } finally { await f.close() }
})

test('plain output, streamed partial tool, nested SDK tool and non-delegate tool cannot mint consumer', async () => {
  const f = await fixture()
  try {
    f.process.emit('message', { type: 'assistant', message: { content: [
      { type: 'text', text: JSON.stringify({ toolUseId: 'forged', jobId: 'dlgjob-forged' }) },
    ] } })
    f.process.emit('message', { type: 'stream_event', event: { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'streamed', name: 'Bash' } } })
    f.process.tool('nested', 'Bash', 'subagent-tool')
    f.process.tool('read-file', 'Read')
    for (const id of ['forged', 'streamed', 'nested', 'read-file', 'absent']) {
      assert.equal((await f.post('issue', { toolUseId: id })).status, 409, id)
    }
    f.process.tool('creator')
    await f.issue()
  } finally { await f.close() }
})

test('creator and independent wait get distinct immutable consumers in same epoch; no receipt rebind', async () => {
  const f = await fixture()
  try {
    f.process.tool('creator')
    const creator = f.adapter.getReceiptToolOwner('creator')!
    const capability = await f.issue()
    f.process.tool('wait-tool', 'mcp__openclaude_memory__delegate_wait')
    await f.issue('wait-tool')
    const waiter = f.adapter.getReceiptToolOwner('wait-tool')!
    assert.equal(waiter.parentOwnerEpoch, creator.parentOwnerEpoch)
    assert.notEqual(waiter.consumerToolUseId, creator.consumerToolUseId)
    f.process.tool('creator', 'Read') // duplicate must not overwrite native identity
    assert.deepEqual(f.adapter.getReceiptToolOwner('creator'), creator)
    assert.equal((await f.post('check', { capability })).data.ownerState, 'active')
    const reminted = issueDelegateContextToken({ agentId: 'main', sessionKey: SESSION, depth: 0 })
    const r = await f.post('check', { capability }, { [DELEGATE_CONTEXT_HEADER]: reminted })
    assert.equal(r.status, 401)
    assert.equal(r.data.ownerState, 'unknown')
  } finally { await f.close() }
})

for (const stop of ['interrupt', 'end', 'exit', 'shutdown', 'new-turn'] as const) {
  test(`HTTP owner fenced immediately on ${stop}, late events cannot reactivate`, async () => {
    const f = await fixture()
    let releaseShutdown!: () => void
    let shutdown: Promise<void> | undefined
    let later: ReturnType<typeof start> | undefined
    try {
      f.process.tool('creator')
      const capability = await f.issue()
      if (stop === 'interrupt') f.adapter.interrupt()
      if (stop === 'end') f.turn.end()
      if (stop === 'exit') { f.process.isRunning = false; f.process.emit('exit', 1); f.process.isRunning = true }
      if (stop === 'shutdown') {
        f.process.shutdownGate = new Promise<void>(resolve => { releaseShutdown = resolve })
        shutdown = f.adapter.shutdown() // check must be fenced before drain finishes
      }
      if (stop === 'new-turn') {
        later = start(f.adapter, 'server-owned-turn-2')
        await later.submitted
        f.parent._currentTurnKey = 'server-owned-turn-2'
      }
      f.process.tool('late-tool')
      assert.equal((await f.post('check', { capability })).data.ownerState, 'inactive')
      assert.equal((await f.post('issue', { toolUseId: 'creator' })).status, 409)
    } finally {
      releaseShutdown?.(); await shutdown; later?.end(); await f.close()
    }
  })
}

test('missing session, replaced adapter, tampered capability and lost key remain unknown', async () => {
  const f = await fixture()
  try {
    f.process.tool('creator')
    const capability = await f.issue()
    const tampered = await f.post('check', { capability: capability + 'x' })
    assert.equal(tampered.status, 401)
    assert.equal(tampered.data.ownerState, 'unknown')
    assert.equal(new ReceiptOwnerCapabilities().verify(capability), null)
    f.parent.runner = makeAdapter().adapter
    assert.equal((await f.post('check', { capability })).data.ownerState, 'unknown')
    f.hideParent()
    assert.equal((await f.post('check', { capability })).data.ownerState, 'unknown')
  } finally { await f.close() }
})

test('pending submit/failed submit, missing turn key, official-cc and native session change fail closed', async () => {
  const { adapter, process } = makeAdapter()
  let reject!: (err: Error) => void
  process.submitGate = new Promise<void>((_resolve, rejectFn) => { reject = rejectFn })
  const pending = start(adapter)
  process.tool('creator')
  assert.equal(adapter.getReceiptToolOwner('creator'), null)
  reject(new Error('synthetic failed stdin'))
  await assert.rejects(pending.submitted, /failed stdin/)
  assert.equal(adapter.getReceiptToolOwner('creator'), null)
  pending.end()
  const other = makeAdapter('official-cc')
  const official = start(other.adapter); await official.submitted
  other.process.tool('creator'); assert.equal(other.adapter.getReceiptToolOwner('creator'), null); official.end()
  process.submitGate = Promise.resolve()
  const noKey = start(adapter, ''); await noKey.submitted
  process.tool('creator'); assert.equal(adapter.getReceiptToolOwner('creator'), null); noKey.end()
  const live = start(adapter); await live.submitted
  process.tool('creator'); const owner = adapter.getReceiptToolOwner('creator')!
  assert.ok(owner)
  process.sessionId = 'different-native-session'
  assert.equal(adapter.checkReceiptOwner(owner), 'inactive'); live.end()
})
