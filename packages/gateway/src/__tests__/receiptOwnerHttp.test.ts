/** Real Gateway HTTP + CcbAdapter/parser, synthetic SDK process (no model/CLI).
 * Proves native identity and lifecycle, NOT receipt ingestion/notification ACK. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createServer, request } from 'node:http'
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
const { SubprocessRunner: NativeRunner } = await import('../subprocessRunner.js')
const { issueDelegateContextToken, DELEGATE_CONTEXT_HEADER } = await import('../delegateContext.js')
const { signJwt } = await import('../auth.js')
const { ReceiptOwnerCapabilities } = await import('../receiptOwnerCapability.js')

const TOKEN = 'receipt-http-test-only-token'
const SESSION = 'agent:main:webchat:dm:receipt-http'
const TURN = 'server-owned-turn-1'
class SdkProcess extends EventEmitter {
  sessionId = 'native-ccb-session'
  isRunning = true
  receiptProcessIdentity: object = {}
  beforeInput?: () => void
  afterInput?: () => void
  submitGate: Promise<void> = Promise.resolve()
  shutdownGate: Promise<void> = Promise.resolve()
  setConsultTurn(): void {}
  async submit(_input?: unknown, _requestId?: string, _authority?: unknown, _turn?: string,
    onInput?: (identity: object) => void): Promise<void> {
    await this.submitGate
    this.beforeInput?.()
    onInput?.(this.receiptProcessIdentity)
    this.afterInput?.()
  }
  interrupt(): boolean { return true }
  async shutdown(): Promise<void> { await this.shutdownGate; this.isRunning = false }
  tool(id: string, name = 'Bash', parent?: string, input: Record<string, unknown> = {}): void {
    this.emit('message', { type: 'assistant', parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id, name, input }] } })
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
  async function partialPost(action: string, body: unknown, authorization: string, completeAt: number) {
    const bytes = JSON.stringify(body)
    let atDispatch = 0
    let atCompletion = 0
    const result = await new Promise<{ status: number; data: any }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const req = request(`http://127.0.0.1:${port}/api/delegate/receipt-owner/${action}`, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(bytes), [DELEGATE_CONTEXT_HEADER]: context },
      }, res => {
        let text = ''
        res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode!, data: JSON.parse(text) }) })
      })
      req.on('error', reject)
      req.setTimeout(6000, () => req.destroy(new Error('partial-body test watchdog')))
      // This listener runs after the actual Gateway.handleHttp listener has
      // entered authentication/readBody; no auth or clock is mocked.
      server.once('request', () => {
        atDispatch = Date.now()
        timer = setTimeout(() => { atCompletion = Date.now(); req.end(bytes.slice(1)) }, Math.max(1, completeAt - Date.now()))
      })
      req.write(bytes.slice(0, 1))
    })
    return { ...result, atDispatch, atCompletion }
  }
  async function issue(id = 'creator') {
    const result = await post('issue', { toolUseId: id })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(typeof result.data.capability, 'string')
    assert.equal(result.cache, 'no-store')
    return result.data.capability as string
  }
  return { process, adapter, turn, parent, post, partialPost, issue, context,
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

test('platform turn transition before adapter submit cannot attest old consumer as active', async () => {
  const f = await fixture()
  try {
    f.process.tool('creator')
    const capability = await f.issue()
    f.parent._currentTurnKey = 'platform-next-turn-before-native-submit'
    assert.equal((await f.post('issue', { toolUseId: 'creator' })).status, 409)
    assert.equal((await f.post('check', { capability })).data.ownerState, 'unknown')
    f.adapter.interrupt()
    assert.equal((await f.post('check', { capability })).data.ownerState, 'inactive')
  } finally { await f.close() }
})

test('capability verification handles expiry, future issue, non-ASCII signature and key replacement', () => {
  const caps = new ReceiptOwnerCapabilities()
  const owner = { userId: 'u', agentId: 'main', sessionKey: 's', contextHash: 'h',
    adapterInstanceId: 'a', parentOwnerEpoch: 'p', turnKey: 't', nativeSessionId: 'n',
    consumerToolUseId: 'tu', toolName: 'Bash' }
  const token = caps.issue(owner, 1000)
  const verified = caps.verify(token, 1001)
  assert.ok(verified)
  assert.equal(caps.verify(token, 999), null)
  assert.equal(caps.verify(token, verified.exp), null)
  assert.equal(caps.verify(token.split('.')[0] + '.' + '中'.repeat(43), 1001), null)
  assert.equal(new ReceiptOwnerCapabilities().verify(token, 1001), null)
  assert.equal(caps.verify(caps.issue({ ...owner, toolName: 'Read' }, 1000), 1001), null)
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


test('body wait expiry rejects foreign JWT instead of changing it to default on issue and check', async () => {
  const f = await fixture()
  try {
    f.process.tool('creator')
    const capability = await f.issue()
    assert.equal((await f.post('issue', { toolUseId: 'creator' }, { authorization: jwt('foreign') })).status, 403)
    const expired = signJwt({ userId: 'foreign', exp: Math.floor(Date.now() / 1000) - 1 }, TOKEN)
    assert.equal((await f.post('issue', { toolUseId: 'creator' }, { authorization: `Bearer ${expired}` })).status, 401)
    for (const action of ['issue', 'check']) {
      const exp = Math.floor(Date.now() / 1000) + 2
      const token = signJwt({ userId: 'foreign', exp }, TOKEN)
      const r = await f.partialPost(action, action === 'issue' ? { toolUseId: 'creator' } : { capability },
        `Bearer ${token}`, exp * 1000 + 100)
      assert.ok(r.atDispatch < exp * 1000, 'fixture must reach real handler before expiry')
      assert.ok(r.atCompletion > exp * 1000, 'body must finish after real expiry')
      assert.equal(r.status, 401, `${action}: expired foreign user must not become default`)
      assert.equal(r.data.capability, undefined)
      assert.notEqual(r.data.ownerState, 'active')
    }
    assert.equal((await f.post('issue', { toolUseId: 'creator' }, { authorization: jwt('default') })).status, 200)
    assert.equal((await f.post('check', { capability }, { authorization: jwt('default') })).data.ownerState, 'active')
    assert.equal((await f.post('check', { capability })).data.ownerState, 'active', 'explicit raw service remains supported')
  } finally { await f.close() }
})

for (const event of ['exit-before-input', 'error-before-input', 'exit-after-input', 'stop-before-input', 'stop-after-input'] as const) {
  test(`new writer ${event} during successful submit never revives receipt authority`, async () => {
    const { adapter, process } = makeAdapter()
    adapter.on('error', () => {})
    const action = () => {
      if (event.startsWith('stop')) adapter.interrupt()
      else if (event.startsWith('error')) process.emit('error', new Error('synthetic writer error'))
      else process.emit('exit', { code: 1, signal: null, crashed: true })
    }
    if (event.endsWith('before-input')) process.beforeInput = action
    else process.afterInput = action
    const turn = start(adapter)
    await turn.submitted // deliberately successful callback even after the terminal signal
    process.tool('creator')
    assert.equal(adapter.getReceiptToolOwner('creator'), null)
    turn.end()
  })
}

const descriptor = { canonicalModel: 'glm-5.2', contextWindow: 1000000, capabilityZero: true,
  supportsThinking: true, supportsVision: false, supportedEfforts: ['high'] }
function nativeSubmitHarness() {
  const runner = new NativeRunner({ sessionKey: SESSION, agentId: 'main', agentBaseDir: home,
    model: 'glm-5.2', config: {} } as never)
  const adapter = new CcbAdapter({ harness: 'ccb' } as EngineCreateOpts, runner)
  const writes: Array<{ process: object; type: string }> = []
  let duringUserWrite: (() => void) | undefined
  const makeProcess = () => {
    const proc = { stdin: {
      write(line: string, cb?: (err?: Error | null) => void) {
        const type = JSON.parse(line).type
        writes.push({ process: proc, type })
        if (type === 'user') duringUserWrite?.()
        queueMicrotask(() => cb?.(null))
        return true
      }, destroy() {},
    }, kill() { return true } }
    return proc
  }
  const install = (nativeId: string) => {
    const proc = makeProcess()
    Object.assign(runner, { proc, closed: false, currentSessionId: nativeId,
      spawnedExecutionDescriptor: descriptor })
    return proc
  }
  const first = install('native-before')
  runner.shutdown = async () => {
    const proc = runner.receiptProcessIdentity
    assert.ok(proc)
    ;(runner as any)._forwardDrainedExitForProcess(proc, { code: 0, signal: null, crashed: false })
  }
  runner.start = async () => { install('native-after') }
  const submit = (key: string, vision: boolean) => adapter.submitTurn({
    input: 'native submit path', turnKey: key, onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    modelAuthority: { authorityEnvelope: 'synthetic-authority', leaseEnvelope: 'synthetic-lease',
      executionDescriptor: { ...descriptor, supportsVision: vision } },
  })
  const tool = (id: string) => runner.emit('message', { type: 'assistant', message: {
    content: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
  } })
  return { runner, adapter, first, writes, submit, tool, install,
    onUserWrite: (fn: () => void) => { duringUserWrite = fn } }
}

test('actual SubprocessRunner.submit vision recycle binds only the new user-line writer', async () => {
  const h = nativeSubmitHarness()
  const first = h.submit('first-turn', false); await first.submitted; h.tool('first-tool')
  const oldOwner = h.adapter.getReceiptToolOwner('first-tool'); assert.ok(oldOwner); first.end()
  const next = h.submit('second-turn', true) // actual shouldRecycleForVisionCapability branch
  await next.submitted; h.tool('next-tool')
  const owner = h.adapter.getReceiptToolOwner('next-tool')
  assert.ok(owner, 'successful new stdin writer must have receipt authority')
  assert.equal(owner.nativeSessionId, 'native-after')
  assert.notEqual(owner.parentOwnerEpoch, oldOwner.parentOwnerEpoch)
  assert.equal(h.adapter.checkReceiptOwner(oldOwner), 'inactive')
  assert.deepEqual(h.writes.map(w => w.type), ['update_environment_variables', 'user', 'update_environment_variables', 'user'])
  assert.equal(h.writes[0].process, h.first)
  assert.notEqual(h.writes[2].process, h.first)
  assert.equal(h.writes[3].process, h.runner.receiptProcessIdentity)
  next.end()
})

test('actual user stdin success followed by writer exit cannot mint authority on a later process', async () => {
  const h = nativeSubmitHarness()
  h.onUserWrite(() => {
    ;(h.runner as any)._forwardDrainedExitForProcess(h.runner.receiptProcessIdentity, { code: 1, signal: null, crashed: true })
  })
  const turn = h.submit('first-turn', false)
  await turn.submitted
  h.install('native-after')
  h.tool('late-tool')
  assert.equal(h.adapter.getReceiptToolOwner('late-tool'), null)
  turn.end()
})


test('deferred receipt capability preserves outer SDK identity and immutable exact inner target', async () => {
  const f = await fixture()
  const target = 'mcp__openclaude-memory__delegate_task'
  try {
    f.process.tool('outer', 'ExecuteExtraTool', undefined, {tool_name:target,params:{goal:'synthetic'}})
    const cap = await f.issue('outer')
    const claims = JSON.parse(Buffer.from(cap.split('.')[0], 'base64url').toString())
    assert.equal(claims.consumerToolUseId, 'outer'); assert.equal(claims.toolName, 'ExecuteExtraTool')
    assert.equal(claims.receiptMcpTarget, target)
    const owner = f.adapter.getReceiptToolOwner('outer')!
    assert.equal(f.adapter.checkReceiptOwner({...owner,receiptMcpTarget:'mcp__openclaude-memory__delegate_wait'}),'inactive')
    f.process.tool('outer','ExecuteExtraTool',undefined,{tool_name:'mcp__untrusted__delegate_task'})
    assert.deepEqual(f.adapter.getReceiptToolOwner('outer'),owner)
    assert.equal((await f.post('check',{capability:cap})).data.ownerState,'active')
    f.process.tool('wait-outer','ExecuteExtraTool',undefined,{tool_name:'mcp__openclaude-memory__delegate_wait'})
    const wait = f.adapter.getReceiptToolOwner('wait-outer')!
    assert.equal(wait.parentOwnerEpoch,owner.parentOwnerEpoch); assert.notEqual(wait.consumerToolUseId,owner.consumerToolUseId)
    await f.issue('wait-outer')
    f.adapter.interrupt();assert.equal((await f.post('check',{capability:cap})).data.ownerState,'inactive')
  } finally {await f.close()}
})
test('deferred receipt rejects missing, third-party, nested or HTTP-asserted target',async()=>{
  const f=await fixture()
  try {
    for(const [id,input] of [['missing',{}],['untrusted',{tool_name:'mcp__untrusted__delegate_task'}],['ordinary',{tool_name:'Read'}],['composite',{tool_name:'mcp__openclaude-memory__delegate_tasks'}]] as const){
      f.process.tool(id,'ExecuteExtraTool',undefined,input)
      assert.equal((await f.post('issue',{toolUseId:id})).status,409)
    }
    f.process.tool('nested','ExecuteExtraTool','parent-agent',{tool_name:'mcp__openclaude-memory__delegate_task'})
    assert.equal((await f.post('issue',{toolUseId:'nested'})).status,409)
    assert.equal((await f.post('issue',{toolUseId:'missing',receiptMcpTarget:'mcp__openclaude-memory__delegate_task'})).status,400)
  }finally{await f.close()}
})
test('deferred receipt signed capability schema disallows absent or misplaced inner target',()=>{
  const issuer=new ReceiptOwnerCapabilities()
  const input={adapterInstanceId:'instance',parentOwnerEpoch:'epoch',turnKey:'turn',nativeSessionId:'session',consumerToolUseId:'outer',toolName:'ExecuteExtraTool',userId:'user',agentId:'main',sessionKey:'parent',contextHash:'context'}
  assert.equal(issuer.verify(issuer.issue(input)),null)
  assert.equal(issuer.verify(issuer.issue({...input,receiptMcpTarget:'mcp__untrusted__delegate_task'})),null)
  const accepted=issuer.verify(issuer.issue({...input,receiptMcpTarget:'mcp__openclaude-memory__delegate_task'}))!
  assert.equal(accepted.toolName,'ExecuteExtraTool');assert.equal(accepted.consumerToolUseId,'outer')
  assert.equal(issuer.verify(issuer.issue({...input,toolName:'Bash',receiptMcpTarget:'mcp__openclaude-memory__delegate_task'})),null)
})
