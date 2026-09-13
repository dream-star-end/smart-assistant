import { getCommandQueue, remove as removeFromQueue } from '../messageQueueManager.js'
import { hasQueuedReceiptInput, resolveQueuedReceiptInput } from '../receiptQueuedInput.js'
import { bindReceiptShellCommand } from '../receiptToolInvocation.js'
import { exec } from '../Shell.js'
import { registerForeground, backgroundAll, backgroundExistingForegroundTask, spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
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
  removeFromQueue(getCommandQueue())
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

async function until(fn: () => boolean) {
  const deadline = Date.now() + 15000
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('background completion deadline')
    await new Promise(r => setTimeout(r, 20))
  }
}
const cli = (f: Awaited<ReturnType<typeof fixture>>) => `node --import ${JSON.stringify(join(root, 'node_modules/tsx/dist/loader.mjs'))} ${JSON.stringify(join(root, 'packages/mcp-memory/src/ocMemoryCli.ts'))} delegate-wait ${f.info.jobId}`

for (const mode of ['explicit', 'user', 'auto'] as const) test(`actual ShellCommand ${mode} background -> authenticated queue -> strict native user input once`, async () => {
  const f = await fixture(); seedLocator(f)
  const opts = f.options('waiter'), ctx = context()
  const first = createUserMessage({ content: 'background child' })
  await recordTranscript([first, opts.assistantMessage])
  const invocation = await prepareReceiptToolInvocation(opts)
  await invocation!.run(async () => {
    const shell = await exec(cli(f), ctx.abortController.signal, 'bash', { timeout: 20000 })
    bindReceiptShellCommand(shell)
    if (mode === 'explicit') await spawnShellTask({ command: cli(f), description: 'child', shellCommand: shell, toolUseId: 'waiter' }, ctx)
    else {
      const id = registerForeground({ command: cli(f), description: 'child', shellCommand: shell }, ctx.setAppState, 'waiter')
      if (mode === 'user') backgroundAll(ctx.getAppState, ctx.setAppState)
      else expect(backgroundExistingForegroundTask(id, shell, 'child', ctx.setAppState, 'waiter')).toBe(true)
    }
    expect(await invocation!.finish()).toBeUndefined()
    await shell.result
  })
  await until(() => getCommandQueue().length > 0)
  const queued = getCommandQueue()[0]!
  expect(hasQueuedReceiptInput(queued)).toBe(true) // actual queue clone retained binding
  expect(hasQueuedReceiptInput({ ...queued })).toBe(false)
  expect(JSON.stringify(queued)).not.toContain('AUTHORITATIVE_NATIVE_RESULT')
  expect(f.inspect().receipt.state).toBe('offered') // shell latch is NOT receipt ACK
  const input = await resolveQueuedReceiptInput(queued)
  expect(input.sourceToolAssistantUUID).toBeUndefined()
  expect(JSON.stringify(input.message.content)).not.toContain('tool_result')
  const admitted = await admitReceiptInput(input, [first, opts.assistantMessage])
  expect(JSON.stringify(admitted)).toContain('AUTHORITATIVE_NATIVE_RESULT')
  expect(f.inspect().receipt.state).toBe('ingested')
  expect(f.inspect().receipt.native_tool_use_id).toBe('creator')
  expect(f.inspect().job.callback_state).toBe('none')
  const restored = await f.restored()
  expect(restored.messages.filter(m => m.type === 'user' && JSON.stringify(m).includes('AUTHORITATIVE_NATIVE_RESULT'))).toHaveLength(1)
}, 60000)

test('actual query Bash background placeholder never repeats tool_result; queue admission produces native user notification', async () => {
  const f = await fixture(); seedLocator(f)
  const opts = f.options('waiter'), ctx = context()
  opts.assistantMessage.message.content[0].input = { command: cli(f), timeout: 20000, run_in_background: true }
  const first = createUserMessage({ content: 'background child then observe completion' }); ctx.messages = [first]
  let modelCalls = 0
  const persisted: any[] = [first]
  const stream = query({ messages: [first], systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext: ctx, querySource: 'sdk', maxTurns: 2,
    deps: { uuid: randomUUID, microcompact: async (messages: unknown[]) => ({ messages }),
      autocompact: async () => ({ compactionResult: undefined, consecutiveFailures: 0 }),
      callModel: async function* () {
        modelCalls++
        if (modelCalls === 1) yield opts.assistantMessage
        else {
          await until(() => getCommandQueue().length > 0)
          const assistant = f.options('creator').assistantMessage
          assistant.message.content[0].input = { command: 'printf checkpoint' }
          yield assistant
        }
      } } as any })
  for await (const message of stream) if (['user','assistant','system'].includes(message.type)) {
    persisted.push(message); await recordTranscript(persisted)
  }
  await flushSessionStorage()
  expect(modelCalls).toBe(2)
  const restored = await f.restored()
  const results = restored.messages.filter(m => m.type === 'user' && JSON.stringify(m).includes('AUTHORITATIVE_NATIVE_RESULT'))
  expect(results).toHaveLength(1)
  expect(JSON.stringify(results[0])).not.toContain('tool_result')
  const paired = restored.messages.flatMap((m:any) => m.type === 'user' && Array.isArray(m.message?.content) ? m.message.content.filter((c:any) => c.type === 'tool_result' && c.tool_use_id === 'waiter') : [])
  expect(paired).toHaveLength(1)
  expect(JSON.stringify(paired)).not.toContain('AUTHORITATIVE_NATIVE_RESULT')
  expect(getCommandQueue()).toHaveLength(0)
  expect(f.inspect().receipt.state).toBe('ingested')
}, 60000)

for (const mode of ['ordinary-failure','rejected-create','stopped-parent'] as const) test(`background ${mode} preserves shell failure notification`, async () => {
  const f = await fixture(); seedLocator(f)
  if (mode === 'rejected-create') await f.control('disable-admission')
  const opts = f.options('waiter'), ctx = context()
  const invocation = await prepareReceiptToolInvocation(opts)
  await invocation!.run(async () => {
    const command = mode === 'ordinary-failure' ? 'exit 7' : mode === 'rejected-create'
      ? `node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate --agent-id coding-assistant --goal rejected`
      : `sleep 0.2; ${cli(f)}`
    const shell = await exec(command, ctx.abortController.signal, 'bash', { timeout: 20000 })
    bindReceiptShellCommand(shell)
    await spawnShellTask({ command, description: 'ordinary-visible', shellCommand: shell, toolUseId: 'waiter' }, ctx)
    if (mode === 'stopped-parent') await f.control('stop')
    await shell.result
  })
  await until(() => getCommandQueue().length > 0)
  const queued = getCommandQueue()[0]!
  expect(hasQueuedReceiptInput(queued)).toBe(false)
  expect(queued.value).toContain('ordinary-visible')
  expect(queued.value).toContain('<status>failed</status>')
  expect(f.inspect().receipt.state).toBe('offered')
}, 60000)

test('Stop after confirmed enqueue never admits original text or acknowledges receipt', async () => {
  const f = await fixture(); seedLocator(f)
  const opts = f.options('waiter'), ctx = context()
  const invocation = await prepareReceiptToolInvocation(opts)
  await invocation!.run(async () => {
    const shell = await exec(cli(f), ctx.abortController.signal, 'bash', { timeout: 20000 })
    bindReceiptShellCommand(shell)
    await spawnShellTask({ command: cli(f), description: 'child', shellCommand: shell, toolUseId: 'waiter' }, ctx)
    await shell.result
  })
  await until(() => getCommandQueue().length > 0)
  const queued = getCommandQueue()[0]!
  expect(hasQueuedReceiptInput(queued)).toBe(true)
  await f.control('stop')
  const input = await resolveQueuedReceiptInput(queued)
  expect(JSON.stringify(input)).not.toContain('AUTHORITATIVE_NATIVE_RESULT')
  expect(f.inspect().receipt.state).toBe('offered')
}, 60000)

test('actual background-completion handoff keeps an active-turn receipt path', async () => {
  const f = await fixture(); seedLocator(f)
  const opts = f.options('waiter'), ctx = context()
  ctx.setToolJSX = () => {}
  const fs = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const ready = join(dir, 'exit-ready'), release = join(dir, 'exit-release'), preload = join(dir, 'gate-exit.mjs')
  await fs.writeFile(preload, `import {writeFileSync,existsSync} from 'node:fs';const end=process.exit.bind(process);process.exit=(code)=>{writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{if(existsSync(${JSON.stringify(release)}))end(code)},5)}`)
  const command = `node --import ${JSON.stringify(preload)} --import ${JSON.stringify(join(root,'node_modules/tsx/dist/loader.mjs'))} ${JSON.stringify(join(root,'packages/mcp-memory/src/ocMemoryCli.ts'))} delegate-wait ${f.info.jobId}`
  opts.assistantMessage.message.content[0].input = { command, timeout:20000 }
  const first = createUserMessage({content:'background completion race'});ctx.messages=[first]
  const persisted:any[]=[first]
  const stream=query({messages:[first],systemPrompt:asSystemPrompt([]),userContext:{},systemContext:{},canUseTool:async(_tool: unknown,input: unknown)=>({behavior:'allow',updatedInput:input}),toolUseContext:ctx,querySource:'sdk',maxTurns:1,deps:{uuid:randomUUID,microcompact:async(messages:unknown[])=>({messages}),autocompact:async()=>({compactionResult:undefined,consecutiveFailures:0}),callModel:async function*(){yield opts.assistantMessage}}} as any)
  const running=(async()=>{for await(const message of stream)if(['user','assistant','system'].includes(message.type)){persisted.push(message);await recordTranscript(persisted)}})()
  try {
    await until(()=>existsSync(ready)&&Object.values(ctx.getAppState().tasks).some((t:any)=>t.status==='running'&&!t.isBackgrounded))
    backgroundAll(ctx.getAppState,ctx.setAppState)
    await fs.writeFile(release,'release')
    await running
    await until(()=>Object.values(ctx.getAppState().tasks).some((t:any)=>t.status==='completed'&&t.shellCommand===null))
    await flushSessionStorage()
    const restored=await f.restored()
    const actual=restored.messages.filter(m=>m.type==='user'&&JSON.stringify(m).includes('AUTHORITATIVE_NATIVE_RESULT')).length
    console.log('REVIEWER_HANDOFF',JSON.stringify({actual,queue:getCommandQueue().length,receipt:f.inspect().receipt.state,tasks:Object.values(ctx.getAppState().tasks).map((t:any)=>({status:t.status,notified:t.notified,isBackgrounded:t.isBackgrounded}))}))
    expect(actual).toBe(1)
    expect(f.inspect().receipt.state).toBe('ingested')
    expect(f.inspect().receipt.native_tool_use_id).toBe('creator')
    const paired=restored.messages.flatMap((m:any)=>m.type==='user'&&Array.isArray(m.message?.content)?m.message.content.filter((b:any)=>b.type==='tool_result'&&b.tool_use_id==='waiter'):[])
    expect(paired).toHaveLength(1)
    expect(getCommandQueue()).toHaveLength(0)
  } finally {await fs.writeFile(release,'release');await running}
},60000)
