import { query } from '../../query.js'
import { BashTool } from '../../../packages/builtin-tools/src/tools/BashTool/BashTool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { ReceiptCliTransport, RECEIPT_CAP_ENV, RECEIPT_CACHE_ENV, RECEIPT_REPORT_ENV } from '../../../../packages/mcp-memory/src/receiptCliTransport.js'
import { prepareReceiptToolInvocation, receiptShellEnvironment } from '../receiptToolInvocation.js'
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
  'OPENCLAUDE_GATEWAY_TOKEN_FILE', 'OPENCLAUDE_DELEGATE_CONTEXT_FILE', 'OPENCLAUDE_HOME', 'OPENCLAUDE_DELEGATE_JOBS_DB', 'OPENCLAUDE_RECEIPT_CALLER_V2', 'CLAUDE_CODE_DISABLE_ATTACHMENTS']
let old: Array<string | undefined>
beforeEach(async () => {
  old = keys.map(k => process.env[k]); cleanup = []
  dir = await mkdtemp(join(tmpdir(), 'native-receipt-http-'))
  process.env.OPENCLAUDE_HOME = dir; process.env.OPENCLAUDE_RECEIPT_CALLER_V2 = '1'; process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1';
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
  const child = spawn('node', ['--import', 'tsx', 'packages/gateway/src/__tests__/fixtures/receiptNativeHttp.fixture.ts', dir, getSessionId(), 'caller'], {
    cwd: root, env: { PATH: process.env.PATH!, HOME: dir, OPENCLAUDE_HOME: dir, NODE_ENV: 'test', OC_DELEGATE_SM: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
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
  process.env.OPENCLAUDE_DELEGATE_JOBS_DB = info.dbPath
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


function context() {
  let state: any = { toolPermissionContext: getEmptyToolPermissionContext(), fastMode: false,
    mcp: { tools: [], clients: [] }, sessionHooks: new Map(), tasks: {}, speculation: { status: 'idle' } }
  return { options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-5-20250929', tools: [BashTool],
      verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] } },
    abortController: new AbortController(), readFileState: new Map(), getAppState: () => state,
    setAppState: (fn: any) => { state = fn(state) }, setInProgressToolUseIDs() {}, setResponseLength() {},
    updateFileHistoryState() {}, updateAttributionState() {}, messages: [] } as any
}
function seedLocator(f: Awaited<ReturnType<typeof fixture>>) {
  // CREATE has already durably bound this nonce in the fixture. This is an
  // untrusted persisted locator, not a shortcut past HTTP or native checks.
  new ReceiptCliTransport({ [RECEIPT_CAP_ENV]: 'cache-only-not-authority',
    [RECEIPT_CACHE_ENV]: join(dir, 'receipt-locators'), [RECEIPT_REPORT_ENV]: join(dir, 'unused') }).remember(f.options().locator)
}

for (const mode of ['create', 'wait'] as const) test(`actual query -> BashTool -> Shell -> ${mode} CLI -> HTTP -> native input`, async () => {
  const f = await fixture(); seedLocator(f)
  const opts = f.options(mode === 'create' ? 'creator' : 'waiter')
  const command = `node --import ${JSON.stringify(join(root, 'node_modules/tsx/dist/loader.mjs'))} ${JSON.stringify(join(root, 'packages/mcp-memory/src/ocMemoryCli.ts'))} ${mode === 'create' ? 'delegate --agent-id coding-assistant --goal local-fixture-only' : `delegate-wait ${f.info.jobId}`}`
  opts.assistantMessage.message.content[0].input = { command, timeout: 20000 }
  const first = createUserMessage({ content: 'wait for child' })
  const ctx = context(); ctx.messages = [first]
  let modelCalls = 0
  const persisted: any[] = [first]
  const stream = query({ messages: [first], systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext: ctx, querySource: 'sdk', maxTurns: 1,
    deps: { uuid: randomUUID, microcompact: async (messages: unknown[]) => ({ messages }),
      autocompact: async () => ({ compactionResult: undefined, consecutiveFailures: 0 }),
      callModel: async function* () { modelCalls++; yield opts.assistantMessage } } as any })
  for await (const message of stream) if (['user', 'assistant', 'system'].includes(message.type)) {
    persisted.push(message); await recordTranscript(persisted)
  }
  await flushSessionStorage()
  expect(modelCalls).toBe(1)
  const expected = mode === 'create' ? 'NEW_CLI_AUTHORITATIVE_RESULT' : 'AUTHORITATIVE_NATIVE_RESULT'
  const state = mode === 'wait' ? f.inspect() : JSON.parse(execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', `
    import Database from 'better-sqlite3';const db=new Database(${JSON.stringify(f.info.dbPath)},{fileMustExist:true});
    console.log(JSON.stringify({receipt:db.prepare("SELECT * FROM delegate_delivery_receipt WHERE job_id!=?").get(${JSON.stringify(f.info.jobId)}),
      job:db.prepare("SELECT callback_state FROM delegate_jobs WHERE job_id!=?").get(${JSON.stringify(f.info.jobId)})}));db.close();
  `], { cwd: root, env: { PATH: process.env.PATH!, HOME: dir }, encoding: 'utf8', timeout: 15000 }))
  expect({ receipt: state.receipt.state, creator: state.receipt.native_tool_use_id, callback: state.job.callback_state }).toEqual({
    receipt: 'ingested', creator: 'creator', callback: 'none' })
  const restored = await f.restored()
  const results = restored.messages.filter((m: any) => m.type === 'user' && JSON.stringify(m.message.content).includes(expected))
  expect(results).toHaveLength(1)
  expect(JSON.stringify(results[0])).not.toContain('等待原生持久接收')
  expect(JSON.stringify(results[0])).not.toContain('cache-only-not-authority')
}, 60000)

test('native invocation scopes stay isolated across concurrent actual Shell spawns', async () => {
  const f = await fixture()
  const a = await prepareReceiptToolInvocation(f.options('creator'))
  const b = await prepareReceiptToolInvocation(f.options('waiter'))
  expect(a).toBeDefined(); expect(b).toBeDefined()
  const { exec } = await import('../Shell.js')
  const run = async (invocation: NonNullable<typeof a>) => invocation.run(async () => {
    const shell = await exec(`node -e 'process.stdout.write(JSON.stringify({cap:process.env.${RECEIPT_CAP_ENV},report:process.env.${RECEIPT_REPORT_ENV}}))'`, new AbortController().signal, 'bash', { timeout: 10000 })
    const result = await shell.result
    return JSON.parse(result.stdout)
  })
  const [one, two] = await Promise.all([run(a!), run(b!)])
  expect(one.report).not.toBe(two.report)
  expect(JSON.parse(Buffer.from(one.cap.split('.')[0], 'base64url').toString()).consumerToolUseId).toBe('creator')
  expect(JSON.parse(Buffer.from(two.cap.split('.')[0], 'base64url').toString()).consumerToolUseId).toBe('waiter')
  expect(process.env[RECEIPT_CAP_ENV]).toBeUndefined()
  expect(receiptShellEnvironment()[RECEIPT_CAP_ENV]).toBeUndefined()
  expect(await prepareReceiptToolInvocation({ ...f.options(), agentId: 'nested' })).toBeUndefined()
}, 60000)

test('status is scoped metadata only; forged enrollment/disabled admission create no jobs', async () => {
  const f = await fixture()
  const capability = (await f.post('issue', { toolUseId: 'creator' })).data.capability
  const request = { ...f.options().locator, capability }
  const ready = await f.post('status', request)
  expect(ready).toEqual({ status: 200, data: { status: 'ready' } })
  expect(JSON.stringify(ready)).not.toContain('AUTHORITATIVE_NATIVE_RESULT')
  expect((await f.post('status', { ...request, receiptNonce: '0'.repeat(64) })).status).toBe(404)
  expect((await f.post('status', request, { Authorization: '' })).status).toBe(401)
  const postStart = async (receipt: unknown) => postJsonToGateway(gatewayBaseUrl() + '/api/agents/coding-assistant/delegate', {
    headers: gatewayDelegateHeaders(), body: JSON.stringify({ goal: 'fixture admission', async: true, receipt }), timeoutMs: 5000 })
  expect((await postStart({ capability: 'fake', receiptNonce: '1'.repeat(64) })).statusCode).toBe(401)
  await f.control('disable-admission')
  expect((await postStart({ capability, receiptNonce: '1'.repeat(64) })).statusCode).toBe(409)
  await f.control('stop')
  expect((await f.post('status', request)).status).toBe(409)
  expect(f.inspect().receipt.state).toBe('offered')
  const count = execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', `
    import Database from 'better-sqlite3';const db=new Database(${JSON.stringify(f.info.dbPath)},{fileMustExist:true});
    process.stdout.write(String(db.prepare('SELECT count(*) n FROM delegate_jobs').get().n));db.close();
  `], { cwd: root, env: { PATH: process.env.PATH!, HOME: dir }, encoding: 'utf8', timeout: 15000 })
  expect(count).toBe('1')
}, 60000)
