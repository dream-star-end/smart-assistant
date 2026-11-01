/** Isolated, opt-in P0 probe; no production entrypoint imports this file. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.OC_AGENT_REMOTE_P0 !== '1') {
  throw new Error('P0 disabled; explicit OC_AGENT_REMOTE_P0=1 required')
}
const repo = process.env.P0_TASK_REPO ?? ''
assert(repo.endsWith('/ocv5-agentremote-t1555u'))
const fixture = process.env.P0_FIXTURE_ROOT ?? ''
assert.equal(fixture, `${repo}/.task-tmp/world`)
const container = process.env.P0_CONTAINER
assert.equal(container, 'oc-v5-agentremote-p0-t1555u-20261101')
const endpoint = new URL(process.env.P0_ENDPOINT ?? '')
assert.equal(endpoint.protocol, 'http:')
assert.equal(endpoint.hostname, '127.0.0.1')
assert(endpoint.port && endpoint.pathname === '/' && !endpoint.username && !endpoint.password)
const evidence = process.env.P0_EVIDENCE ?? ''
assert.equal(evidence, `${repo}/.task-evidence`)
assert.equal(process.env.HOME, `${repo}/.task-tmp/worker-home`)
assert.equal(process.env.CLAUDE_CONFIG_DIR, `${repo}/.task-tmp/worker-config`)
const testEnv = process.env.P0_TEST_ENV ?? ''
assert.equal(testEnv, `${repo}/.task-tmp/execd-test.env`)
// Only our fresh synthetic test credential is read; it is never logged.
const access = readFileSync(testEnv, 'utf8')
  .trim()
  .replace(/^EXECD_ACCESS_TOKEN=/, '')
assert(/^[a-f0-9]{48}$/.test(access))
process.chdir(`${repo}/.task-tmp/worker-cwd`)
Object.assign(globalThis, {
  MACRO: {
    VERSION: '2.8.4-p0',
    BUILD_TIME: '',
    FEEDBACK_CHANNEL: '',
    ISSUES_EXPLAINER: '',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: '',
    VERSION_CHANGELOG: '',
  },
})

// Seed synthetic settings before importing the actual CCB dispatcher.
const cache = await import('../src/utils/settings/settingsCache.ts')
cache.setSessionSettingsCache({ settings: { disableAllHooks: true, hooks: {} }, errors: [] })
for (const source of [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const) {
  cache.setCachedSettingsForSource(source, {})
}
const { buildTool, getEmptyToolPermissionContext } = await import('../src/Tool.ts')
const { runToolUse } = await import('../src/services/tools/toolExecution.ts')
const { getDefaultAppState } = await import('../src/state/AppStateStore.ts')
const { createAssistantMessage } = await import('../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../src/utils/fileStateCache.ts')
const { FileReadTool } = await import(
  '../packages/builtin-tools/src/tools/FileReadTool/FileReadTool.ts'
)
const { FileWriteTool } = await import(
  '../packages/builtin-tools/src/tools/FileWriteTool/FileWriteTool.ts'
)
const { FileEditTool } = await import(
  '../packages/builtin-tools/src/tools/FileEditTool/FileEditTool.ts'
)
const { BashTool } = await import('../packages/builtin-tools/src/tools/BashTool/BashTool.tsx')
type Input = Record<string, unknown>
const observations: Record<string, unknown>[] = []
let httpCalls = 0
let wrapperCalls = 0
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  httpCalls++
  const response = await fetch(new URL(path, endpoint), {
    ...init,
    signal: AbortSignal.timeout(15000),
    headers: { ...Object.fromEntries(new Headers(init.headers)), 'X-EXECD-ACCESS-TOKEN': access },
  })
  if (!response.ok) throw new Error(`execd ${path.split('?')[0]} HTTP ${response.status}`)
  return response
}
async function download(path: string): Promise<string> {
  const response = await request(`/files/download?path=${encodeURIComponent(path)}`)
  const bytes = await response.arrayBuffer()
  assert(bytes.byteLength <= 1024 * 1024, 'P0 output cap')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
function fixturePath(input: Input): string {
  assert.equal(typeof input.file_path, 'string')
  const path = resolve(String(input.file_path))
  assert(path.startsWith(`${fixture}/`), 'P0 fixture root only')
  return path
}
function checkInput(name: string, input: Input): void {
  if (name === 'Bash') {
    assert.equal(typeof input.command, 'string')
    assert(String(input.command).length <= 4096)
    assert(!input.dangerouslyDisableSandbox, 'P0 has no sandbox bypass')
  } else {
    fixturePath(input)
    assert(
      input.pages === undefined && input.offset === undefined && input.limit === undefined,
      'P0 text fixture only',
    )
  }
}
async function verifyEnvironment(): Promise<void> {
  assert.equal(
    await download(`${fixture}/sentinel.txt`),
    'REMOTE_SENTINEL\n',
    'execution world identity mismatch',
  )
}
async function command(input: Input): Promise<Record<string, unknown>> {
  const response = await request('/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: input.command,
      cwd: fixture,
      background: Boolean(input.run_in_background),
      timeout: 10000,
      envs: { TMPDIR: `${repo}/.task-tmp/tmp` },
    }),
  })
  const wire = await response.text()
  writeFileSync(`${evidence}/command-wire.txt`, wire)
  assert(wire.length <= 1024 * 1024, 'P0 command output cap')
  const frames = wire
    .split(/\r?\n\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => JSON.parse(x.startsWith('data:') ? x.slice(5).trim() : x))
  let id: string | undefined
  let stdout = ''
  let stderr = ''
  let exitCode: number | undefined
  let terminal = false
  for (const event of frames) {
    if (event.type === 'init') id = event.text
    if (event.type === 'stdout') stdout += event.text ?? ''
    if (event.type === 'stderr') stderr += event.text ?? ''
    if (event.type === 'execution_complete' || event.type === 'error') {
      terminal = true
      const code = event.exit_code ?? event.error?.exit_code
      if (Number.isInteger(code)) exitCode = code
    }
  }
  assert(id && terminal, 'missing command identity/terminal receipt')
  if (!input.run_in_background)
    assert(Number.isInteger(exitCode), 'EOF/HTTP 200 is not command success')
  return { id, stdout, stderr, exitCode, background: Boolean(input.run_in_background), frames }
}
async function execute(name: string, input: Input): Promise<Record<string, unknown>> {
  checkInput(name, input)
  await verifyEnvironment()
  wrapperCalls++
  const operationId = randomUUID()
  const common = {
    operationId,
    environmentId: container,
    payloadHash: digest(JSON.stringify({ name, input })),
    prototype: 'ccb-dispatch-wrapper-execd',
  }
  if (name === 'Read') {
    const content = await download(fixturePath(input))
    return { ...common, content, sha256: digest(content) }
  }
  if (name === 'Write') {
    assert.equal(typeof input.content, 'string')
    assert(Buffer.byteLength(String(input.content)) <= 65536)
    const form = new FormData()
    form.append(
      'metadata',
      new Blob([JSON.stringify({ path: fixturePath(input), mode: 600 })], {
        type: 'application/json',
      }),
      'metadata.json',
    )
    form.append('file', new Blob([String(input.content)]), 'fixture.txt')
    await request('/files/upload', { method: 'POST', body: form })
    const content = await download(fixturePath(input))
    assert.equal(content, input.content)
    return {
      ...common,
      sha256: digest(content),
      bytes: Buffer.byteLength(content),
      atomicCas: false,
    }
  }
  if (name === 'Edit') {
    const path = fixturePath(input)
    const before = await download(path)
    const oldText = String(input.old_string)
    const newText = String(input.new_string)
    assert(oldText.length > 0, 'P0 does not implement empty-old_string creation')
    const matches = before.split(oldText).length - 1
    assert(matches > 0 && (input.replace_all || matches === 1), 'missing/ambiguous edit match')
    const expected = before.split(oldText).join(newText)
    await request('/files/replace?verbose=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [path]: { old: oldText, new: newText } }),
    })
    const after = await download(path)
    assert.equal(after, expected)
    return { ...common, sha256: digest(after), replacedCount: matches, atomicCas: false }
  }
  assert.equal(name, 'Bash')
  return { ...common, ...(await command(input)) }
}
const nativeTools = [FileReadTool, FileWriteTool, FileEditTool, BashTool]
const tools = nativeTools.map((native) =>
  buildTool({
    name: native.name,
    inputSchema: native.inputSchema,
    maxResultSizeChars: 1024 * 1024,
    async description() {
      return 'P0 synthetic remote fixture only'
    },
    async prompt() {
      return 'P0 synthetic remote fixture only'
    },
    renderToolUseMessage() {
      return null
    },
    isReadOnly() {
      return native.name === 'Read'
    },
    isConcurrencySafe() {
      return false
    },
    async validateInput(input: Input) {
      checkInput(native.name, input)
      return { result: true as const }
    },
    async checkPermissions(input: Input) {
      try {
        checkInput(native.name, input)
        return { behavior: 'allow' as const, updatedInput: input }
      } catch {
        return { behavior: 'deny' as const, message: 'P0 fixture authorization denied' }
      }
    },
    async call(input: Input) {
      return { data: await execute(native.name, input) }
    },
    mapToolResultToToolResultBlockParam(data: unknown, id: string) {
      return { type: 'tool_result' as const, tool_use_id: id, content: JSON.stringify(data) }
    },
  }),
)
let state = {
  ...getDefaultAppState(),
  settings: { disableAllHooks: true, hooks: {} },
  toolPermissionContext: getEmptyToolPermissionContext(),
  sessionHooks: new Map(),
}
assert.equal(state.toolPermissionContext.mode, 'default')
const context: any = {
  options: {
    commands: [],
    debug: false,
    mainLoopModel: 'p0-no-model',
    tools,
    verbose: false,
    thinkingConfig: { type: 'disabled' },
    mcpClients: [],
    mcpResources: {},
    isNonInteractiveSession: true,
    agentDefinitions: { activeAgents: [], allAgents: [] },
  },
  abortController: new AbortController(),
  readFileState: createFileStateCacheWithSizeLimit(32, 1024 * 1024),
  getAppState: () => state,
  setAppState: (update: any) => {
    state = update(state)
  },
  setInProgressToolUseIDs() {},
  setResponseLength() {},
  updateFileHistoryState() {},
  updateAttributionState() {},
  requireCanUseTool: true,
  messages: [],
  toolDecisions: new Map(),
  langfuseTrace: null,
}
const canUseTool: any = async (
  tool: any,
  input: Input,
  ctx: any,
  _assistant: unknown,
  _id: string,
  force: any,
) => {
  if (force && force.behavior !== 'allow')
    return { behavior: 'deny', message: 'P0 cannot approve interactively' }
  return tool.checkPermissions(input, ctx)
}
async function dispatch(name: string, input: Input, expectedError = false): Promise<any> {
  const disk = statfsSync(repo)
  assert(disk.bavail * disk.bsize >= 8000000000, 'BLOCKER: disk below 8 GB')
  const block = {
    type: 'tool_use' as const,
    id: `toolu_p0_${randomUUID().replaceAll('-', '')}`,
    name,
    input,
  }
  const assistant = createAssistantMessage({ content: [block] })
  const results: any[] = []
  const start = performance.now()
  for await (const update of runToolUse(block, assistant, canUseTool, context)) {
    const message = (update as any).message
    if (message?.type === 'user' && Array.isArray(message.message?.content)) {
      results.push(
        ...message.message.content.filter(
          (x: any) => x.type === 'tool_result' && x.tool_use_id === block.id,
        ),
      )
    }
  }
  assert.equal(results.length, 1, `exactly one ${name} tool_result required`)
  assert.equal(results[0].is_error === true, expectedError, JSON.stringify(results[0]))
  const elapsedMs = performance.now() - start
  observations.push({ name, elapsedMs, expectedError })
  if (expectedError) return results[0]
  const receipt = JSON.parse(results[0].content)
  assert.equal(receipt.environmentId, container)
  return receipt
}
function assertWorkerUntouched(): void {
  assert.equal(readFileSync(`${fixture}/sentinel.txt`, 'utf8'), 'WORKER_TRAP\n')
  assert.equal(readFileSync(`${fixture}/edit.txt`, 'utf8'), 'WORKER_ORIGINAL\n')
  assert.equal(readFileSync(`${fixture}/write.txt`, 'utf8'), 'WORKER_UNTOUCHED\n')
  assert(!existsSync(`${fixture}/worker-bash-trap`))
}
if (process.env.P0_FAILURE_PROBE === '1') {
  await dispatch('Read', { file_path: `${fixture}/sentinel.txt` }, true)
  await dispatch('Bash', { command: 'touch worker-bash-trap' }, true)
  assert.equal(wrapperCalls, 0, 'disconnected environment must fail before execution')
  assertWorkerUntouched()
  writeFileSync(
    `${evidence}/fail-closed.json`,
    JSON.stringify({ passed: true, modelCalls: 0, observations, httpCalls, wrapperCalls }, null, 2),
  )
} else {
  const sentinel = await dispatch('Read', { file_path: `${fixture}/sentinel.txt` })
  assert.equal(sentinel.content, 'REMOTE_SENTINEL\n')
  const content = 'written remotely: 中文🌏\n'
  const written = await dispatch('Write', { file_path: `${fixture}/write.txt`, content })
  assert.equal(written.sha256, digest(content))
  const edited = await dispatch('Edit', {
    file_path: `${fixture}/edit.txt`,
    old_string: 'before:',
    new_string: 'after:',
  })
  assert.equal(edited.sha256, digest('after: 中文🌏\n'))
  const shell = await dispatch('Bash', {
    command:
      'printf "cwd=%s\\n" "$PWD"; printf "uid="; id -u; printf "pid=%s\\n" "$$"; printf "pidns="; readlink /proc/self/ns/pid; printf "remote-stdout\\n"; printf "remote-stderr\\n" >&2; exit 7',
  })
  assert.equal(shell.exitCode, 7)
  assert(
    shell.stdout.includes(`cwd=${fixture}`) &&
      shell.stdout.includes('uid=65534') &&
      shell.stdout.includes('pidns=pid:['),
  )
  assert(shell.stderr.includes('remote-stderr'))
  writeFileSync(`${evidence}/command-receipt.json`, JSON.stringify(shell, null, 2))
  for (let i = 0; i < 8; i++) {
    await dispatch('Read', { file_path: `${fixture}/write.txt` })
    await dispatch('Write', { file_path: `${fixture}/write.txt`, content })
    await dispatch('Edit', {
      file_path: `${fixture}/edit.txt`,
      old_string: i % 2 === 0 ? 'after:' : 'before:',
      new_string: i % 2 === 0 ? 'before:' : 'after:',
    })
    const result = await dispatch('Bash', { command: 'printf "p0-rtt\\n"' })
    assert.equal(result.exitCode, 0)
  }
  assertWorkerUntouched()
  const background = await dispatch('Bash', {
    command: 'printf "%s\\n" "$$" > bg.pid; printf "bg-one 中文🌏\\n"; exec sleep 30',
    run_in_background: true,
  })
  const jobId = String(background.id)
  let status: any
  let logText = ''
  let cursor = ''
  for (let i = 0; i < 30; i++) {
    status = await (await request(`/command/status/${encodeURIComponent(jobId)}`)).json()
    const logs = await request(`/command/${encodeURIComponent(jobId)}/logs?cursor=0`)
    logText = await logs.text()
    cursor = logs.headers.get('EXECD-COMMANDS-TAIL-CURSOR') ?? ''
    if (logText.includes('bg-one 中文🌏')) break
    await Bun.sleep(100)
  }
  assert.equal(status.id, jobId)
  assert.equal(status.running, true)
  assert(logText.includes('bg-one 中文🌏'))
  assert.equal(
    Number(cursor),
    Buffer.byteLength(logText),
    'fixed-version log cursor must match raw UTF-8 bytes',
  )
  const tail = await request(`/command/${encodeURIComponent(jobId)}/logs?cursor=${cursor}`)
  assert.equal(await tail.text(), '')
  await request(`/command?id=${encodeURIComponent(jobId)}`, { method: 'DELETE' })
  for (let i = 0; i < 40; i++) {
    status = await (await request(`/command/status/${encodeURIComponent(jobId)}`)).json()
    if (status.running === false) break
    await Bun.sleep(100)
  }
  assert.equal(status.running, false, 'job must reach a stopped state')
  assert(Number.isInteger(status.exit_code) && status.finished_at)
  writeFileSync(
    `${evidence}/background-receipt.json`,
    JSON.stringify({ jobId, logText, cursor, status, wholeProcessTreeProven: false }, null, 2),
  )
  const samples = observations.slice(4, 36)
  const metrics = Object.fromEntries(
    ['Read', 'Write', 'Edit', 'Bash'].map((name) => {
      const values = samples
        .filter((x) => x.name === name)
        .map((x) => Number(x.elapsedMs))
        .sort((a, b) => a - b)
      return [
        name,
        {
          n: values.length,
          p50Ms: values[Math.ceil(values.length * 0.5) - 1],
          p95Ms: values[Math.ceil(values.length * 0.95) - 1],
        },
      ]
    }),
  )
  writeFileSync(
    `${evidence}/ccb-wrapper-results.json`,
    JSON.stringify(
      {
        passed: true,
        modelCalls: 0,
        ccbEntry: 'runToolUse',
        nativeBuiltinRemote: false,
        httpCalls,
        wrapperCalls,
        observations,
        metrics,
        workerRssBytes: process.memoryUsage().rss,
      },
      null,
      2,
    ),
  )
}
console.log(
  JSON.stringify({
    p0: 'passed',
    failureProbe: process.env.P0_FAILURE_PROBE === '1',
    modelCalls: 0,
    httpCalls,
    wrapperCalls,
  }),
)
process.exit(0)
