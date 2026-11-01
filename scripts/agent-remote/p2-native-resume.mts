/** Explicit offline native-resume probe. Source CCB CLI, localhost fake only.
 * Run at repository root: tsx scripts/agent-remote/p2-native-resume.mts
 * No user configuration/auth environment is inherited by the CCB subprocess.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { NativeStateRepository } from '../../packages/gateway/src/agentRemote/nativeState.js'
const wt = process.cwd()
mkdirSync(join(wt, '.task-tmp'), { recursive: true, mode: 0o700 })
mkdirSync(join(wt, '.task-evidence'), { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(wt, '.task-tmp/native-cli-'))
const nativeId = randomUUID()
const configRoot = join(root, 'config')
const cwd = join(root, 'cwd')
for (const path of [cwd, configRoot, join(root, 'home'), join(root, 'openclaude')])
  mkdirSync(path, { mode: 0o700 })
const repo = new NativeStateRepository({ nativeRoot: configRoot, stateRoot: join(root, 'state') })
const identity = {
  principalId: 'fixture',
  sessionId: 'fixture',
  nativeSessionId: nativeId,
  engine: 'ccb' as const,
  engineVersion: '2.8.4',
  cwd,
  environmentId: 'synthetic',
  environmentGeneration: 1,
}
const prompt = 'SYNTHETIC_NATIVE_REMEMBER_72c40'
let phase = 1
let calls = 0
let restoredHistory = false
const requestPaths: string[] = []
const server = createServer(async (req, res) => {
  requestPaths.push(req.url ?? '')
  if (req.method !== 'POST') {
    res.writeHead(404).end()
    return
  }
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 4 * 1024 * 1024) {
      res.writeHead(413).end()
      return
    }
  }
  if (req.url?.startsWith('/v1/messages/count_tokens')) {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ input_tokens: 100 }))
    return
  }
  if (!/^\/v1\/messages(?:\?|$)/.test(req.url ?? '')) {
    res.writeHead(404).end()
    return
  }
  calls++
  if (calls > 6) {
    res.writeHead(429).end()
    return
  }
  const body = JSON.parse(raw)
  const messages = JSON.stringify(body.messages)
  if (phase === 2)
    restoredHistory =
      messages.includes(prompt) &&
      messages.includes('NATIVE_READY') &&
      messages.includes('SYNTHETIC_NATIVE_CHECK')
  const answer =
    phase === 1 ? 'NATIVE_READY' : restoredHistory ? 'NATIVE_RESTORED' : 'HISTORY_MISSING'
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_fixture_${calls}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address === 'object')
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: join(root, 'home'),
  OPENCLAUDE_HOME: join(root, 'openclaude'),
  CLAUDE_CONFIG_DIR: configRoot,
  TMPDIR: join(wt, '.task-tmp'),
  NODE_ENV: 'production',
  CLAUDE_CODE_VERSION: '2.8.4',
  CLAUDE_CODE_SIMPLE: '1',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  ANTHROPIC_API_KEY: 'fixture-only-not-a-real-key',
  CLAUDE_CODE_MAX_RETRIES: '0',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTO_COMPACT: '1',
  NO_PROXY: '127.0.0.1,localhost',
}
const bun = process.env.OC_AGENT_REMOTE_TEST_BUN ?? '/usr/bin/bun'
async function cli(resume = false) {
  const args = [
    'run',
    join(wt, 'claude-code-best/src/entrypoints/cli.tsx'),
    '-p',
    '--bare',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model',
    'claude-opus-5-5',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--system-prompt',
    'Synthetic native persistence fixture.',
    resume ? '--resume' : '--session-id',
    nativeId,
  ]
  const command = repo.writerCommand(identity, bun, args)
  const child = spawn(command.executable, command.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b) => {
    stdout += b
  })
  child.stderr.on('data', (b) => {
    stderr += b
  })
  child.stdin.on('error', () => {})
  child.stdin.end(
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: resume ? 'SYNTHETIC_NATIVE_CHECK' : prompt }] } })}\n`,
  )
  const [code, signal] = await once(child, 'close')
  clearTimeout(timeout)
  writeFileSync(join(root, `cli-${phase}-stdout.jsonl`), stdout)
  writeFileSync(join(root, `cli-${phase}-stderr.txt`), stderr)
  return { code, signal, stdout, stderr }
}
async function task(mode: string, extra: Record<string, unknown>) {
  const path = join(root, `${mode}.json`)
  writeFileSync(path, JSON.stringify({ options: repo.options, identity, ...extra }))
  const command = repo.stateTaskCommand(identity, process.execPath, [
    '--import',
    'tsx',
    join(wt, 'packages/gateway/src/agentRemote/fixtures/stateChild.ts'),
    mode,
    path,
  ])
  const child = spawn(command.executable, command.args, {
    cwd: wt,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (b) => {
    out += b
  })
  child.stderr.on('data', (b) => {
    err += b
  })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, err)
  return out
}
try {
  const first = await cli()
  assert.equal(first.code, 0, first.stderr)
  const result = first.stdout
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x))
    .find((x) => x.type === 'result')
  assert.equal(result?.is_error, false, first.stdout)
  assert.equal(result?.session_id, nativeId)
  const projectDirectories = readdirSync(join(configRoot, 'projects'))
  const project = projectDirectories.find((x) =>
    existsSync(join(configRoot, 'projects', x, `${nativeId}.jsonl`)),
  )!
  assert(project, 'real CLI transcript absent')
  const transcriptRelativePath = `projects/${project}/${nativeId}.jsonl`
  const transcript = join(configRoot, transcriptRelativePath)
  const original = readFileSync(transcript)
  const rows = original
    .toString()
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x))
  const head = rows.filter((x) => typeof x.uuid === 'string').at(-1)?.uuid
  assert(head, 'native head missing')
  const pointer = join(root, 'pointer.json')
  await task('checkpoint', {
    transcript,
    pointer,
    request: {
      identity,
      bindingRevision: 1,
      authority: {
        dispatchId: 'synthetic-d1',
        turnKey: 'synthetic-turn1',
        tapeCursor: 1,
        nativeHeadUuid: head,
      },
      transcriptRelativePath,
      createdAtMs: Date.now(),
    },
  })
  const checkpoint = JSON.parse(readFileSync(pointer, 'utf8'))
  rmSync(join(configRoot, 'projects'), { recursive: true })
  await task('restore', { checkpointId: checkpoint.checkpointId })
  assert.deepEqual(readFileSync(transcript), original)
  phase = 2
  const second = await cli(true)
  assert.equal(second.code, 0, second.stderr)
  const resumedResult = second.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((row) => row.type === 'result')
  assert.equal(resumedResult?.session_id, nativeId)
  assert.equal(resumedResult?.is_error, false)

  assert.equal(restoredHistory, true, second.stdout)
  assert.match(second.stdout, /NATIVE_RESTORED/)
  assert(readFileSync(transcript).length > original.length)
  const callsBefore = calls
  rmSync(join(configRoot, 'projects'), { recursive: true })
  phase = 3
  const negative = await cli(true)
  assert(
    negative.code !== 0 || !negative.stdout.includes('NATIVE_RESTORED'),
    'missing native data silently resumed',
  )
  assert.equal(calls, callsBefore, 'negative resume reached fake model')
  const report = {
    ok: true,
    realUpstreamCalls: 0,
    nativeSessionId: nativeId,
    checkpointId: checkpoint.checkpointId,
    fakeMessagesCalls: calls,
    restoredHistory,
    originalTranscriptBytes: original.length,
    missingTranscriptRejected: true,
    requestPaths,
    root,
  }
  writeFileSync(
    join(wt, '.task-evidence/p2-native-cli-result.json'),
    JSON.stringify(report, null, 2),
  )
  process.stdout.write(`${JSON.stringify(report)}\n`)
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\nfixtureRoot=${root}\n`,
  )
  process.exitCode = 1
} finally {
  server.close()
  server.closeAllConnections()
}
