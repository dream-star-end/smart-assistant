import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSessionId, switchSession } from '../../bootstrap/state.js'
import { createUserMessage } from '../messages.js'
import { createHttpReceiptInput } from '../receiptHttpInput.js'
import { admitReceiptInput } from '../receiptInputAdmission.js'
import { openReceiptDelivery } from '../receiptSqlite.js'
import { clearSessionMessagesCache, resetProjectForTesting, getProjectDir, flushSessionStorage,
  recordTranscript, loadFullLog, getTranscriptPath } from '../sessionStorage.js'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway } from '../../../../packages/mcp-memory/src/gatewayClient.js'
import { signJwt } from '../../../../packages/gateway/src/auth.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
let dir: string
let cleanup: Array<() => Promise<unknown>>
const keys = ['CLAUDE_CONFIG_DIR', 'TEST_ENABLE_SESSION_PERSISTENCE', 'OPENCLAUDE_GATEWAY_PORT',
  'OPENCLAUDE_GATEWAY_TOKEN_FILE', 'OPENCLAUDE_DELEGATE_CONTEXT_FILE']
let old: Array<string | undefined>
beforeEach(async () => {
  old = keys.map(k => process.env[k]); cleanup = []
  dir = await mkdtemp(join(tmpdir(), 'native-receipt-http-'))
  process.env.CLAUDE_CONFIG_DIR = dir; process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  getProjectDir.cache.clear?.(); resetProjectForTesting(); clearSessionMessagesCache()
  switchSession(randomUUID() as ReturnType<typeof getSessionId>)
})
afterEach(async () => {
  await flushSessionStorage()
  for (const fn of cleanup.reverse()) await fn()
  resetProjectForTesting()
  keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i] })
  await rm(dir, { recursive: true, force: true })
})
async function fixture() {
  const child = spawn('node', ['--import', 'tsx', 'packages/gateway/src/__tests__/fixtures/receiptNativeHttp.fixture.ts', dir, getSessionId()], {
    cwd: root, env: { PATH: process.env.PATH!, HOME: dir, OPENCLAUDE_HOME: dir, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = '', err = ''
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  child.stdout.on('data', b => { out += b }); child.stderr.on('data', b => { err += b })
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 45000)
  cleanup.push(async () => { clearTimeout(watchdog); if (child.exitCode === null) child.kill('SIGKILL'); await exited })
  async function line(prefix: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = () => { const found = out.split('\n').find(l => l.startsWith(prefix)); if (found) { detach(); resolve(found.slice(prefix.length)) } }
      const fail = () => { detach(); reject(new Error(err || out || 'gateway fixture exited')) }
      const timer = setTimeout(() => { detach(); reject(new Error('gateway fixture deadline: ' + err)) }, 20000)
      const detach = () => { clearTimeout(timer); child.stdout.off('data', check); child.off('close', fail) }
      child.stdout.on('data', check); child.once('close', fail); check()
    })
  }
  const info = JSON.parse(await line('PAIR_READY '))
  process.env.OPENCLAUDE_GATEWAY_PORT = String(info.port)
  process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE = info.tokenFile
  process.env.OPENCLAUDE_DELEGATE_CONTEXT_FILE = info.contextFile
  const delivery = await openReceiptDelivery(info.dbPath)
  cleanup.push(async () => delivery.close())
  const control = async (action: string) => { child.stdin.write(JSON.stringify({ action }) + '\n'); await line('PAIR_ACK ' + action) }
  const assistant = (toolId: string, toolName = 'Bash'): any => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(),
    message: { id: 'synthetic-api', role: 'assistant', type: 'message', model: 'synthetic', content: [
      { type: 'tool_use', id: toolId, name: toolName, input: {} }], stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } } })
  const options = (toolId = 'creator') => ({ locator: { jobId: info.jobId, generation: info.generation, receiptNonce: info.receiptNonce },
    toolUseId: toolId, assistantMessage: assistant(toolId), delivery })
  const inspect = () => JSON.parse(execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', `
    import Database from 'better-sqlite3';const db=new Database(${JSON.stringify(info.dbPath)},{fileMustExist:true});
    console.log(JSON.stringify({receipt:db.prepare('SELECT * FROM delegate_delivery_receipt').get(),job:db.prepare('SELECT callback_state FROM delegate_jobs').get()}));db.close();
  `], { cwd: root, env: { PATH: process.env.PATH!, HOME: dir }, encoding: 'utf8', timeout: 15000 }))
  const post = async (action: string, body: unknown, extra = {}) => {
    const r = await postJsonToGateway(gatewayBaseUrl() + '/api/delegate/receipt-owner/' + action,
      { headers: { ...gatewayDelegateHeaders(), ...extra }, body: JSON.stringify(body), timeoutMs: 5000 })
    return { status: r.statusCode, data: JSON.parse(r.body) }
  }
  const restored = () => loadFullLog({ isLite: true, sessionId: getSessionId(), fullPath: getTranscriptPath(), messages: [], date: '',
    value: 0, created: new Date(), modified: new Date(), firstPrompt: '', messageCount: 3, isSidechain: false })
  return { info, options, control, inspect, post, restored }
}

for (const toolId of ['creator', 'waiter']) {
  test(`real HTTP ${toolId} consumer binds canonical result into native history, preserving creator and epoch`, async () => {
    const f = await fixture(); const opts = f.options(toolId)
    const capability = (await f.post('issue', { toolUseId: toolId })).data.capability
    const offered = await f.post('input', { ...opts.locator, capability })
    expect(offered.status).toBe(200)
    expect(f.inspect().receipt.state).toBe('offered') // HTTP read is not input ACK
    const message = await createHttpReceiptInput(opts)
    expect(JSON.stringify(message)).toContain('AUTHORITATIVE_NATIVE_RESULT')
    expect(() => { (message.message.content as any)[0].content = 'TAMPERED_STDOUT' }).toThrow()
    const history = [createUserMessage({ content: 'do task' }), opts.assistantMessage]
    const admitted = await admitReceiptInput(message, history)
    await recordTranscript([...history, admitted]); await flushSessionStorage()
    const state = f.inspect()
    expect(state.receipt.state).toBe('ingested')
    expect(state.receipt.parent_owner_epoch).toBe(f.info.epoch)
    expect(state.receipt.native_tool_use_id).toBe('creator')
    expect(state.job.callback_state).toBe('none')
    expect((await f.restored()).messages.filter(m => m.uuid === message.uuid)).toHaveLength(1)
    const repeated = await admitReceiptInput(message, history)
    expect(JSON.stringify(repeated)).not.toContain('AUTHORITATIVE_NATIVE_RESULT')
  }, 60000)
}

test('actual HTTP owner check under native barrier blocks result after Stop without a callback ACK', async () => {
  const f = await fixture(); const opts = f.options('waiter')
  const message = await createHttpReceiptInput(opts)
  await f.control('stop')
  const result = await admitReceiptInput(message, [createUserMessage({ content: 'task' }), opts.assistantMessage])
  expect(JSON.stringify(result)).not.toContain('AUTHORITATIVE_NATIVE_RESULT')
  expect(f.inspect().receipt.state).toBe('offered')
  expect(f.inspect().job.callback_state).toBe('none')
}, 60000)

test('HTTP input requires exact user/nonce/parent/turn and never accepts identity asserted in body', async () => {
  const f = await fixture(); const opts = f.options()
  const capability = (await f.post('issue', { toolUseId: 'creator' })).data.capability
  const request = { ...opts.locator, capability }
  expect((await f.post('input', request, { Authorization: '' })).status).toBe(401)
  const foreign = signJwt({ userId: 'foreign', exp: Math.floor(Date.now() / 1000) + 300 }, await readFile(f.info.tokenFile, 'utf8'))
  expect((await f.post('input', request, { Authorization: `Bearer ${foreign}` })).status).toBe(403)
  expect((await f.post('input', { ...request, userId: 'default' })).status).toBe(400)
  expect((await f.post('input', { ...request, receiptNonce: '0'.repeat(64) })).status).toBe(404)
  expect((await f.post('input', { ...request, generation: 1 })).status).toBe(404)
  await f.control('change-turn')
  expect((await f.post('input', request)).status).toBe(409)
  expect(f.inspect().receipt.state).toBe('offered')
}, 60000)

test('native consumer rejects wrong session, actual tool/name and nested invocation; original creator stays immutable', async () => {
  const f = await fixture(); const opts = f.options()
  await expect(createHttpReceiptInput({ ...opts, agentId: 'nested' })).rejects.toThrow('main thread')
  await expect(createHttpReceiptInput({ ...opts, toolUseId: 'other' })).rejects.toThrow('actual native tool')
  await expect(createHttpReceiptInput({ ...opts, assistantMessage: { ...opts.assistantMessage,
    message: { ...opts.assistantMessage.message, content: 'not an SDK tool' } } })).rejects.toThrow('actual native tool')
  const wrongName = f.options(); wrongName.assistantMessage.message.content[0].name = 'Read'
  await expect(createHttpReceiptInput(wrongName)).rejects.toThrow('binding mismatch')
  switchSession(randomUUID() as ReturnType<typeof getSessionId>)
  await expect(createHttpReceiptInput(opts)).rejects.toThrow('binding mismatch')
  expect(f.inspect().receipt.state).toBe('offered')
  expect(f.inspect().receipt.native_tool_use_id).toBe('creator')
}, 60000)

test('actual SDK registration lag gets bounded same-tool HTTP retries before native input', async () => {
  const f = await fixture(); const opts = f.options('late-waiter')
  await f.control('late-tool')
  const message = await createHttpReceiptInput(opts)
  const history = [createUserMessage({ content: 'task' }), opts.assistantMessage]
  await admitReceiptInput(message, history)
  expect(f.inspect().receipt.state).toBe('ingested')
  expect(f.inspect().receipt.native_tool_use_id).toBe('creator')
}, 60000)

test('corrupted durable result bytes fail closed rather than creating a matching-looking native receipt', async () => {
  const f = await fixture(); await f.control('corrupt')
  await expect(createHttpReceiptInput(f.options())).rejects.toThrow('input rejected (500)')
  expect(f.inspect().receipt.state).toBe('offered')
}, 60000)

test('HTTP unavailable during locked parent check is unknown and cannot become consumed or notified', async () => {
  const f = await fixture(); const opts = f.options()
  const message = await createHttpReceiptInput(opts)
  await f.control('exit')
  await expect(admitReceiptInput(message, [createUserMessage({ content: 'task' }), opts.assistantMessage])).rejects.toThrow()
  expect(f.inspect().receipt.state).toBe('offered')
  expect(f.inspect().job.callback_state).toBe('none')
}, 60000)
