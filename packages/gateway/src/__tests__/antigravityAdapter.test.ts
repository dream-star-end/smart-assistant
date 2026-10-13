/**
 * Antigravity CLI adapter contract without network credentials (OCV5-415).
 *
 * The fake CLI replays NDJSON captured from the real 1.3.4 linux-x64 binary
 * against a loopback Gemini mock (fixtures/antigravity/, see
 * docs/ocv5-415-antigravity-cli.md), and records argv/env/stdin.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityAdapter.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  ANTIGRAVITY_MAX_PROMPT_BYTES,
  AntigravityAdapter,
  _internals,
  validateAntigravityRoute,
} from '../engine/antigravityAdapter.js'
import { antigravityProductToolInput, antigravityProductToolName } from '../engine/antigravityToolNormalize.js'
import type { EngineEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { TurnSummary } from '../engine/engineEvents.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'antigravity')
const TOKEN = 'a'.repeat(64)
const BASE_URL = `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}`

const FAKE_CLI = `#!/usr/bin/env node
const fs = require('node:fs')
let input = ''
let replayed = false
function replay() {
  if (replayed) return
  replayed = true
  fs.writeFileSync(process.env.FAKE_AGY_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: input,
    env: {
      HOME: process.env.HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
      OPENCLAUDE_ENGINE: process.env.OPENCLAUDE_ENGINE,
      OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
      PATH: process.env.PATH,
    },
    settings: fs.readFileSync(process.env.HOME + '/.gemini/antigravity-cli/settings.json', 'utf8'),
    mcp: fs.readFileSync(process.env.HOME + '/.gemini/config/mcp_config.json', 'utf8'),
    conversationsIsLink: fs.lstatSync(process.env.HOME + '/.gemini/antigravity-cli/conversations').isSymbolicLink(),
  }))
  if (process.env.FAKE_AGY_STDERR) process.stderr.write(fs.readFileSync(process.env.FAKE_AGY_STDERR, 'utf8'))
  if (process.env.FAKE_AGY_HANG === '1') { setInterval(() => {}, 1000); return }
  for (const line of fs.readFileSync(process.env.FAKE_AGY_FIXTURE, 'utf8').split('\\n')) {
    if (line.trim()) process.stdout.write(line + '\\n')
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  if (input.includes('\\n')) replay()
})
process.stdin.on('end', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_AGY_EXIT_DELAY_MS || 0)))
`

function config(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'antigravity-gemini-3.1-pro' },
  } as unknown as OpenClaudeConfig
}

interface Harness {
  dir: string
  capture: string
  adapter: AntigravityAdapter
  restore: () => Promise<void>
}

async function harness(opts: Partial<EngineCreateOpts> = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-adapter-'))
  const fake = path.join(dir, 'fake-agy.cjs')
  await writeFile(fake, FAKE_CLI)
  await chmod(fake, 0o755)
  const saved: Record<string, string | undefined> = {}
  const set = (key: string, value: string | undefined): void => {
    if (!(key in saved)) saved[key] = process.env[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  set('OC_ANTIGRAVITY_CLI_BIN', fake)
  set('OPENCLAUDE_HOME', path.join(dir, 'openclaude-home'))
  set('FAKE_AGY_CAPTURE', path.join(dir, 'capture.json'))
  set('OPENCLAUDE_V3_CONTAINER_TOKEN', 'must-not-leak')
  set('GOOGLE_API_KEY', 'must-not-leak-either')
  set('FAKE_AGY_STDERR', undefined)
  set('FAKE_AGY_HANG', undefined)
  set('FAKE_AGY_EXIT_DELAY_MS', undefined)
  const adapter = new AntigravityAdapter({
    sessionKey: 'agent:main:webchat:dm:agy-test',
    agentId: 'main',
    agentBaseDir: dir,
    config: config(),
    model: 'antigravity-gemini-3.1-pro',
    effortLevel: 'high',
    ...opts,
  } as EngineCreateOpts)
  adapter.on('error', () => {})
  return {
    dir,
    capture: path.join(dir, 'capture.json'),
    adapter,
    restore: async () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function runTurn(
  h: Harness,
  fixture: string,  // name under FIXTURES, or an absolute path
  extra: { stderr?: string; input?: string } = {},
): Promise<{ summary: TurnSummary | null; events: EngineEvent[]; sessionIds: string[] }> {
  process.env.FAKE_AGY_FIXTURE = path.isAbsolute(fixture) ? fixture : path.join(FIXTURES, fixture)
  if (extra.stderr) {
    const file = path.join(h.dir, 'stderr.txt')
    await writeFile(file, extra.stderr)
    process.env.FAKE_AGY_STDERR = file
  } else {
    Reflect.deleteProperty(process.env, 'FAKE_AGY_STDERR')
  }
  const events: EngineEvent[] = []
  const sessionIds: string[] = []
  const onSession = (id: string): void => { sessionIds.push(id) }
  h.adapter.on('session_id', onSession)
  const run = h.adapter.submitTurn({
    input: extra.input ?? 'run echo',
    requestId: 'b'.repeat(32),
    assistantMessageId: 'asst-1',
    onEvent: (event) => events.push(event),
    sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(),
  })
  await run.submitted.catch(() => {})
  const summary = await run.summary
  await h.adapter.waitForOutputDrain()
  h.adapter.off('session_id', onSession)
  return { summary, events, sessionIds }
}

describe('validateAntigravityRoute', () => {
  test('accepts only the token-bound loopback relay prefix', () => {
    assert.doesNotThrow(() => validateAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN }))
    assert.throws(() => validateAntigravityRoute(null), /ANTIGRAVITY_ROUTE_REQUIRED/)
    assert.throws(() => validateAntigravityRoute({ baseUrl: BASE_URL, routeToken: 'short' }), /ANTIGRAVITY_ROUTE_REQUIRED/)
    for (const bad of [
      `https://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}`,
      `http://generativelanguage.googleapis.com/internal/v5/antigravity-relay/route/${TOKEN}`,
      `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}/v1beta`,
      `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${'b'.repeat(64)}`,
      `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}?x=1`,
      `http://u:p@127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}`,
    ]) {
      assert.throws(() => validateAntigravityRoute({ baseUrl: bad, routeToken: TOKEN }), /ANTIGRAVITY_ROUTE_INVALID/, bad)
    }
  })
})

describe('AntigravityAdapter', () => {
  test('fails closed without a master relay route and never spawns the CLI', async () => {
    const h = await harness()
    try {
      const { summary } = await runTurn(h, 'tool-success.ndjson')
      assert.ok(summary)
      assert.equal(summary.isError, true)
      assert.match(summary.errorDetail ?? '', /ANTIGRAVITY_ROUTE_REQUIRED/)
      assert.equal(existsSync(h.capture), false)
    } finally {
      await h.restore()
    }
  })

  test('rejects canonical ids outside the Antigravity table before spawning', async () => {
    const h = await harness({ model: 'gemini-3.1-pro-high' })
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary } = await runTurn(h, 'tool-success.ndjson')
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_MODEL_UNSUPPORTED/)
      assert.equal(existsSync(h.capture), false)
    } finally {
      await h.restore()
    }
  })

  test('drives the pinned headless contract through an opaque route and maps the captured tool turn', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary, events, sessionIds } = await runTurn(h, 'tool-success.ndjson')
      const cap = JSON.parse(await readFile(h.capture, 'utf8'))

      assert.deepEqual(cap.argv, [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--model', 'gemini-3.1-pro-high',
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
      ])
      assert.equal(cap.env.GEMINI_API_KEY, TOKEN)
      assert.equal(cap.env.GOOGLE_GEMINI_BASE_URL, BASE_URL)
      assert.equal(cap.env.GOOGLE_API_KEY, undefined)
      assert.equal(cap.env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      assert.equal(cap.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
      assert.equal(cap.env.OPENCLAUDE_ENGINE, 'antigravity')
      const root = path.join(h.dir, 'openclaude-home', 'antigravity-cli')
      assert.ok(cap.env.HOME.startsWith(path.join(root, 'launch') + path.sep))
      assert.equal(cap.env.XDG_CACHE_HOME, path.join(root, 'cache'))
      assert.deepEqual(JSON.parse(cap.settings), { modelProvider: 'gemini' })
      assert.equal(cap.conversationsIsLink, true)
      assert.ok(!cap.argv.join(' ').includes(TOKEN), 'route token must not be on argv')

      const line = JSON.parse(cap.stdin.trim())
      assert.equal(line.event, 'user')
      assert.match(line.message.content, /OpenClaude Platform Context \(Antigravity adapter\)/)
      assert.match(line.message.content, /run echo$/)

      assert.ok(summary)
      assert.equal(summary.isError, false)
      assert.equal(summary.assistantText, 'Done: hi-from-tool\n')
      assert.equal(summary.tools.length, 1)
      assert.equal(summary.tools[0]!.toolName, 'Bash')
      assert.deepEqual(summary.tools[0]!.inputJson, { command: 'echo hi-from-tool' })
      assert.equal(summary.tools[0]!.output, 'hi-from-tool\n')
      assert.equal(summary.tools[0]!.isError, false)
      // Sum of per-step usage (600+300 / 25+7 / 400+900), not result.usage.
      assert.equal(summary.usage.inputTokens, 900)
      assert.equal(summary.usage.outputTokens, 32)
      assert.equal(summary.usage.cacheReadTokens, 1300)
      assert.deepEqual(sessionIds, ['4187c78c-e96d-4840-8c1c-3de86f92ddd9'])
      assert.equal(h.adapter.nativeSessionId, '4187c78c-e96d-4840-8c1c-3de86f92ddd9')
      assert.ok(events.some((e) => e.kind === 'tool_use_detected'))
      assert.ok(events.some((e) => e.kind === 'tool_result_detected'))
      assert.deepEqual(await readdir(path.join(root, 'launch')), [], 'launch HOME is removed after the turn')
    } finally {
      await h.restore()
    }
  })

  test('resumes the committed conversation and ignores cumulative result.usage', async () => {
    const h = await harness({ resumeSessionId: '4187c78c-e96d-4840-8c1c-3de86f92ddd9', effortLevel: 'low' })
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary } = await runTurn(h, 'resume.ndjson')
      const cap = JSON.parse(await readFile(h.capture, 'utf8'))
      assert.deepEqual(cap.argv.slice(-2), ['--conversation', '4187c78c-e96d-4840-8c1c-3de86f92ddd9'])
      assert.ok(cap.argv.includes('gemini-3.1-pro-low'))
      assert.ok(summary)
      assert.equal(summary.isError, false)
      // resume.ndjson result.usage is 1800/64 (both turns); this turn is 900/32.
      assert.equal(summary.usage.inputTokens, 900)
      assert.equal(summary.usage.outputTokens, 32)
    } finally {
      await h.restore()
    }
  })

  test('streams incremental text_delta as live text blocks', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary, events } = await runTurn(h, 'stream-text.ndjson')
      const texts = events.flatMap((e) => (e.kind === 'block' && e.block.kind === 'text' ? [e.block.text] : []))
      assert.deepEqual(texts, ['Alpha ', 'Beta ', 'Gamma', '.\n'])
      assert.equal(summary?.assistantText, 'Alpha Beta Gamma.\n')
      assert.equal(summary?.assistantSegments.length, 1)
      assert.equal(summary?.thinkingText, '')
    } finally {
      await h.restore()
    }
  })

  test('maps lazy call_mcp_tool to the mcp__server__tool card with inner arguments', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary } = await runTurn(h, 'tool-mcp.ndjson')
      assert.equal(summary?.tools[0]?.toolName, 'mcp__openclaude-memory__skill_search')
      assert.deepEqual(summary?.tools[0]?.inputJson, { q: 'deploy' })
      assert.equal(summary?.tools[0]?.output, 'probe-result:{"q": "deploy"}')
    } finally {
      await h.restore()
    }
  })

  test('treats a headless soft-deny (exit 0, empty tool output) as a failed turn', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const stderr = await readFile(path.join(FIXTURES, 'tool-softdeny.stderr.txt'), 'utf8')
      const { summary } = await runTurn(h, 'tool-softdeny.ndjson', { stderr })
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_TOOL_DENIED/)
      assert.equal(h.adapter.nativeSessionId, null)
    } finally {
      await h.restore()
    }
  })

  test('soft-deny is detected from result.denied_actions even before stderr arrives', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary, sessionIds } = await runTurn(h, 'tool-softdeny.ndjson')
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_TOOL_DENIED: command/)
      assert.deepEqual(sessionIds, [])
      assert.equal(h.adapter.nativeSessionId, null)
    } finally {
      await h.restore()
    }
  })

  test('a cancelled resumed turn keeps the committed conversation id (matches the resume map)', async () => {
    const prior = '4187c78c-e96d-4840-8c1c-3de86f92ddd9'
    const h = await harness({ resumeSessionId: prior })
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const canceled = (await readFile(path.join(FIXTURES, 'resume.ndjson'), 'utf8')).replace('"status":"SUCCESS"', '"status":"CANCELED"')
      const file = path.join(h.dir, 'resume-canceled.ndjson')
      await writeFile(file, canceled)
      const { summary, sessionIds } = await runTurn(h, file)
      assert.equal(summary?.isError, true)
      assert.equal(summary?.stopReason, 'interrupted')
      assert.deepEqual(sessionIds, [])
      assert.equal(h.adapter.nativeSessionId, prior)
    } finally {
      await h.restore()
    }
  })

  test('a late close of the previous turn does not stop the next turn keepalive', async () => {
    _internals.setTimingTestHooks({ keepaliveMs: 20, resultSettleMs: 30 })
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      process.env.FAKE_AGY_EXIT_DELAY_MS = '400'
      const first = await runTurn(h, 'tool-success.ndjson')
      assert.equal(first.summary?.isError, false)
      // Turn 1 settled on the timer; its process is still alive for ~400 ms.
      Reflect.deleteProperty(process.env, 'FAKE_AGY_EXIT_DELAY_MS')
      process.env.FAKE_AGY_HANG = '1'
      process.env.FAKE_AGY_FIXTURE = path.join(FIXTURES, 'tool-success.ndjson')
      const run = h.adapter.submitTurn({
        input: 'second',
        requestId: 'c'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      await new Promise((resolve) => setTimeout(resolve, 600))
      let ticks = 0
      const onActivity = (): void => { ticks += 1 }
      h.adapter.on('activity', onActivity)
      await new Promise((resolve) => setTimeout(resolve, 200))
      h.adapter.off('activity', onActivity)
      assert.ok(ticks >= 3, `turn 2 keepalive must survive turn 1 close (ticks=${ticks})`)
      await h.adapter.shutdown()
      await run.summary
    } finally {
      _internals.setTimingTestHooks(null)
      await h.restore()
    }
  })

  test('treats SUCCESS with no output (oversized input in 1.3.4) as a failed turn', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary } = await runTurn(h, 'oversize-silent-empty.ndjson')
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_EMPTY_RUN/)
      assert.equal(h.adapter.nativeSessionId, null)
    } finally {
      await h.restore()
    }
  })

  test('surfaces an upstream error result and does not commit the conversation', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary, sessionIds } = await runTurn(h, 'upstream-error.ndjson')
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /Error 404, Message: mock/)
      assert.deepEqual(sessionIds, [])
      assert.equal(h.adapter.nativeSessionId, null)
    } finally {
      await h.restore()
    }
  })

  test('kills the CLI at once when it falls back to the interactive OAuth prompt', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      process.env.FAKE_AGY_HANG = '1'
      const started = Date.now()
      const { summary } = await runTurn(h, 'auth-required.ndjson', {
        stderr: 'Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x\n',
      })
      assert.ok(Date.now() - started < 15_000, 'must not wait out the 60 s OAuth prompt')
      assert.equal(summary?.isError, true)
      assert.equal(summary?.errorKind, 'auth')
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_AUTH_REQUIRED/)
    } finally {
      await h.restore()
    }
  })

  test('refuses prompts above the verified stdin size before spawning', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute({ baseUrl: BASE_URL, routeToken: TOKEN })
      const { summary } = await runTurn(h, 'tool-success.ndjson', { input: 'x'.repeat(ANTIGRAVITY_MAX_PROMPT_BYTES) })
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_PROMPT_TOO_LARGE/)
      assert.equal(existsSync(h.capture), false)
    } finally {
      await h.restore()
    }
  })
})

describe('antigravity tool normalization', () => {
  test('maps declared native tools and leaves unverified keys untouched', () => {
    assert.equal(antigravityProductToolName('run_command'), 'Bash')
    assert.deepEqual(antigravityProductToolInput('view_file', { AbsolutePath: '/a' }), { file_path: '/a' })
    assert.deepEqual(antigravityProductToolInput('write_to_file', { TargetFile: '/b' }), { file_path: '/b' })
    assert.equal(antigravityProductToolName('grep_search'), 'Grep')
    assert.deepEqual(antigravityProductToolInput('grep_search', { Query: 'x' }), { Query: 'x' })
    assert.equal(antigravityProductToolName('generate_image'), 'generate_image')
    assert.equal(antigravityProductToolName('call_mcp_tool', { ServerName: 'bad name', ToolName: 't' }), 'call_mcp_tool')
  })
})
