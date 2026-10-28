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
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
import { resetEnvFactsCache } from '../envProbe.js'
import { classifyRunError } from '../errorClassify.js'
import { renderHistoricalContextJsonPrompt } from '../historicalContextPrompt.js'
import { buildHistoricalContextPayload } from '../historicalContextPayload.js'
import type { EngineEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { TurnSummary } from '../engine/engineEvents.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'antigravity')
const TOKEN = 'a'.repeat(64)
const BASE_URL = `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}`
const LIMITED_TOKEN = 'ya29.limited-openid-userinfo-only-token'
const ROUTE = {
  baseUrl: BASE_URL,
  routeToken: TOKEN,
  accessToken: LIMITED_TOKEN,
  accessTokenExpiresAt: '2026-10-14T06:00:00Z',
  idToken: 'eyJhbGciOi.id-token-payload.sig',
}

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
      CLOUD_CODE_URL: process.env.CLOUD_CODE_URL,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
      OPENCLAUDE_ENGINE: process.env.OPENCLAUDE_ENGINE,
      OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
      PATH: process.env.PATH,
    },
    settings: fs.readFileSync(process.env.HOME + '/.gemini/antigravity-cli/settings.json', 'utf8'),
    oauthToken: fs.readFileSync(process.env.HOME + '/.gemini/antigravity-cli/antigravity-oauth-token', 'utf8'),
    oauthTokenMode: fs.statSync(process.env.HOME + '/.gemini/antigravity-cli/antigravity-oauth-token').mode & 0o777,
    mcp: fs.readFileSync(process.env.HOME + '/.gemini/config/mcp_config.json', 'utf8'),
    profile: fs.existsSync(process.env.HOME + '/.profile') ? fs.readFileSync(process.env.HOME + '/.profile', 'utf8') : null,
    hostLink: fs.existsSync(process.env.HOME + '/.oc-host-bin/host') ? fs.readlinkSync(process.env.HOME + '/.oc-host-bin/host') : null,
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
process.stdin.on('end', () => setTimeout(() => process.exit(Number(process.env.FAKE_AGY_EXIT_CODE || 0)), Number(process.env.FAKE_AGY_EXIT_DELAY_MS || 0)))
`

function config(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'antigravity-gemini-3.8-flash' },
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
  set('FAKE_AGY_EXIT_CODE', undefined)
  const adapter = new AntigravityAdapter({
    sessionKey: 'agent:main:webchat:dm:agy-test',
    agentId: 'main',
    agentBaseDir: dir,
    config: config(),
    model: 'antigravity-gemini-3.8-flash',
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
  extra: { stderr?: string; input?: Parameters<AntigravityAdapter['submitTurn']>[0]['input'] } = {},
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
    assert.doesNotThrow(() => validateAntigravityRoute(ROUTE))
    assert.throws(() => validateAntigravityRoute(null), /ANTIGRAVITY_ROUTE_REQUIRED/)
    assert.throws(() => validateAntigravityRoute({ ...ROUTE, accessToken: '' }), /ANTIGRAVITY_ROUTE_REQUIRED/)
    assert.throws(() => validateAntigravityRoute({ ...ROUTE, routeToken: 'short' }), /ANTIGRAVITY_ROUTE_REQUIRED/)
    for (const bad of [
      `https://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}`,
      `http://generativelanguage.googleapis.com/internal/v5/antigravity-relay/route/${TOKEN}`,
      `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}/v1beta`,
      `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${'b'.repeat(64)}`,
      `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}?x=1`,
      `http://u:p@127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}`,
    ]) {
      assert.throws(() => validateAntigravityRoute({ ...ROUTE, baseUrl: bad }), /ANTIGRAVITY_ROUTE_INVALID/, bad)
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
    const h = await harness({ model: 'gemini-3.8-flash-high' })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
      const { summary, events, sessionIds } = await runTurn(h, 'tool-success.ndjson')
      const cap = JSON.parse(await readFile(h.capture, 'utf8'))

      assert.deepEqual(cap.argv, [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--model', 'gemini-3.8-flash-high',
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
      ])
      // Google-account mode: every Cloud Code call goes through the relay route.
      assert.equal(cap.env.CLOUD_CODE_URL, BASE_URL)
      assert.equal(cap.env.GEMINI_API_KEY, undefined)
      assert.equal(cap.env.GOOGLE_GEMINI_BASE_URL, undefined)
      assert.equal(cap.env.GOOGLE_API_KEY, undefined)
      assert.equal(cap.env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      assert.equal(cap.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
      assert.equal(cap.env.OPENCLAUDE_ENGINE, 'antigravity')
      const root = path.join(h.dir, 'openclaude-home', 'antigravity-cli')
      assert.ok(cap.env.HOME.startsWith(path.join(root, 'launch') + path.sep))
      assert.equal(cap.env.XDG_CACHE_HOME, path.join(root, 'cache'))
      assert.deepEqual(JSON.parse(cap.settings), {})
      // The CLI only gets the limited token, never a refresh token.
      const oauth = JSON.parse(cap.oauthToken)
      assert.deepEqual({ ...oauth, token: { ...oauth.token, expiry: '<checked below>' } }, {
        token: {
          access_token: LIMITED_TOKEN,
          token_type: 'Bearer',
          refresh_token: '',
          expiry: '<checked below>',
        },
        auth_method: 'consumer',
        id_token: 'eyJhbGciOi.id-token-payload.sig',
      })
      // OCV5-556: without a refresh token Go oauth2 refuses locally once the
      // file's expiry passes, so the file outlives any turn (the relay swaps
      // Authorization; the limited token only passes the start-up userinfo check).
      assert.ok(
        Date.parse(oauth.token.expiry) >= Date.now() + 23 * 60 * 60 * 1000,
        `CLI token file expiry must outlive the turn: ${oauth.token.expiry}`,
      )
      assert.equal(cap.oauthTokenMode, 0o600)
      assert.ok(!cap.stdin.includes(LIMITED_TOKEN), 'limited token must not reach the prompt')
      assert.equal(cap.conversationsIsLink, true)
      assert.ok(!cap.argv.join(' ').includes(TOKEN), 'route token must not be on argv')
      assert.ok(!cap.argv.join(' ').includes(LIMITED_TOKEN), 'limited token must not be on argv')

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

  test('puts the selfhost host wrapper on the CLI PATH (OCV5-530)', async () => {
    const h = await harness()
    try {
      const hostDir = path.join(h.dir, '.local', 'bin')
      await mkdir(hostDir, { recursive: true })
      const hostBin = path.join(hostDir, 'host')
      await writeFile(hostBin, '#!/bin/sh\nexit 0\n')
      await chmod(hostBin, 0o755)
      resetEnvFactsCache()
      h.adapter.setAntigravityRoute(ROUTE)
      const { summary } = await runTurn(h, 'tool-success.ndjson')
      const cap = JSON.parse(await readFile(h.capture, 'utf8'))
      assert.ok(summary)
      const launchBin = path.join(cap.env.HOME, '.oc-host-bin')
      const pathDirs = cap.env.PATH.split(':')
      assert.equal(pathDirs[0], launchBin, `expected ${launchBin} first on the CLI PATH, got ${cap.env.PATH}`)
      assert.ok(!pathDirs.includes(hostDir), 'user-writable ~/.local/bin must stay off the CLI PATH')
      assert.equal(cap.hostLink, hostBin, 'launch PATH dir links only the probed host wrapper')
      assert.equal(cap.profile, `export PATH='${launchBin}':"$PATH"\n`)
      const prompt = JSON.parse(cap.stdin.trim()).message.content as string
      assert.ok(prompt.includes('host=yes'), 'ENV slot should advertise the host channel')
    } finally {
      resetEnvFactsCache()
      await h.restore()
    }
  })

  test('resumes the committed conversation and ignores cumulative result.usage', async () => {
    const h = await harness({ resumeSessionId: '4187c78c-e96d-4840-8c1c-3de86f92ddd9', effortLevel: 'low' })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const { summary } = await runTurn(h, 'resume.ndjson')
      const cap = JSON.parse(await readFile(h.capture, 'utf8'))
      assert.deepEqual(cap.argv.slice(-2), ['--conversation', '4187c78c-e96d-4840-8c1c-3de86f92ddd9'])
      assert.ok(cap.argv.includes('gemini-3.8-flash-low'))
      assert.ok(summary)
      assert.equal(summary.isError, false)
      // resume.ndjson result.usage is 1800/64 (both turns); this turn is 900/32.
      assert.equal(summary.usage.inputTokens, 900)
      assert.equal(summary.usage.outputTokens, 32)
    } finally {
      await h.restore()
    }
  })

  // OCV5-556 (webmvhtasuy8z35hs 2026-10-21 18:35-18:42): four resumed turns
  // whose own relay calls all returned 200 were failed with an earlier launch's
  // `oauth2: token expired` step (old route), which drove three useless
  // automatic recoveries.
  async function resumeFixtureWith(dir: string, extraSteps: object[], status = 'SUCCESS'): Promise<string> {
    const lines = (await readFile(path.join(FIXTURES, 'resume.ndjson'), 'utf8')).trim().split('\n')
    const result = lines.pop()!.replace('"status":"SUCCESS"', `"status":"${status}"`)
    const file = path.join(dir, `resume-extra-${Math.random().toString(16).slice(2)}.ndjson`)
    const extra = extraSteps.map((step) => JSON.stringify({ event: 'step_update', step_update: step }))
    await writeFile(file, `${[...lines, ...extra, result].join('\n')}\n`)
    return file
  }
  const STALE_ERROR = {
    conversation_id: '4187c78c-e96d-4840-8c1c-3de86f92ddd9',
    state: 'DONE',
    step_type: 'error_message',
    error: {
      message: `agent executor error: generating and executing: request failed: Post "http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${'c'.repeat(64)}/v1internal:streamGenerateContent?alt=sse": oauth2: token expired and refresh token is not set`,
    },
  }

  test('ignores an earlier launch error step replayed by a resumed conversation', async () => {
    const h = await harness({ resumeSessionId: '4187c78c-e96d-4840-8c1c-3de86f92ddd9' })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const fixture = await resumeFixtureWith(h.dir, [{ ...STALE_ERROR, step_index: 2 }])
      const { summary, sessionIds } = await runTurn(h, fixture)
      assert.equal(summary?.isError, false, summary?.errorDetail)
      assert.match(summary?.assistantText ?? '', /hi-from-tool/)
      assert.deepEqual(sessionIds, ['4187c78c-e96d-4840-8c1c-3de86f92ddd9'])
    } finally {
      await h.restore()
    }
  })

  test('an error step of this launch still fails the turn as a platform credential error', async () => {
    const h = await harness({ resumeSessionId: '4187c78c-e96d-4840-8c1c-3de86f92ddd9' })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const fixture = await resumeFixtureWith(h.dir, [{ ...STALE_ERROR, step_index: 9 }])
      const { summary, sessionIds } = await runTurn(h, fixture)
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /^ANTIGRAVITY_CREDENTIAL_EXPIRED: .*oauth2: token expired/)
      assert.deepEqual(sessionIds, [])
    } finally {
      await h.restore()
    }
  })

  test('an error step before this launch user_input only counts when the run fails', async () => {
    const h = await harness({ resumeSessionId: '4187c78c-e96d-4840-8c1c-3de86f92ddd9' })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const lines = (await readFile(path.join(FIXTURES, 'resume.ndjson'), 'utf8')).trim().split('\n')
      const prelude = JSON.stringify({ event: 'step_update', step_update: { ...STALE_ERROR, step_index: 3 } })
      const ok = path.join(h.dir, 'prelude-ok.ndjson')
      await writeFile(ok, `${[lines[0], prelude, ...lines.slice(1)].join('\n')}\n`)
      assert.equal((await runTurn(h, ok)).summary?.isError, false)
      // A run that really failed: ERROR and no answer. (ERROR on a run that
      // answered is the CLI repeating an earlier launch's error; see below.)
      const failed = path.join(h.dir, 'prelude-failed.ndjson')
      const failedResult = JSON.parse(lines.at(-1)!)
      failedResult.result.status = 'ERROR'
      failedResult.result.response = ''
      const unanswered = lines.slice(1, -1).filter((line) => !line.includes('"agent_response"'))
      await writeFile(failed, `${[lines[0], prelude, ...unanswered, JSON.stringify(failedResult)].join('\n')}\n`)
      const { summary } = await runTurn(h, failed)
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /^ANTIGRAVITY_CREDENTIAL_EXPIRED: /)
    } finally {
      await h.restore()
    }
  })

  test('streams incremental text_delta as live text blocks', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
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
      h.adapter.setAntigravityRoute(ROUTE)
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

  test('trims injected history to the stdin envelope instead of refusing the turn', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      // History sized to the builder's budget on its own; quotes double under
      // the stdin JSON encoding and the platform context adds more on top.
      const entry = (i: number) => ({ role: i % 2 ? 'Assistant' : 'User', text: `turn-${i} ${'"'.repeat(250)}${'q'.repeat(250)}` })
      const transcript = Array.from({ length: 300 }, (_, i) => entry(i))
      const input = renderHistoricalContextJsonPrompt(transcript, 'latest question')
      assert.ok(Buffer.byteLength(input, 'utf8') <= ANTIGRAVITY_MAX_PROMPT_BYTES)
      assert.ok(Buffer.byteLength(JSON.stringify(input), 'utf8') > ANTIGRAVITY_MAX_PROMPT_BYTES)
      const { summary, events } = await runTurn(h, 'tool-success.ndjson', { input })
      assert.equal(summary?.isError, false, summary?.errorDetail)
      const compacted = events.find((e) => e.kind === 'context_compacted')
      assert.ok(compacted?.kind === 'context_compacted' && compacted.compaction.strategy === 'history_suffix')
      assert.ok(compacted?.kind === 'context_compacted' && compacted.compaction.droppedEntries > 0)
      const cap = JSON.parse(await readFile(h.capture, 'utf8'))
      assert.ok(Buffer.byteLength(cap.stdin, 'utf8') <= ANTIGRAVITY_MAX_PROMPT_BYTES)
      const prompt = JSON.parse(cap.stdin.trim()).message.content as string
      assert.match(prompt, /latest question/)
      assert.match(prompt, /turn-299 /, 'the newest history is kept')
      assert.doesNotMatch(prompt, /turn-0 /, 'the oldest history is dropped')
    } finally {
      await h.restore()
    }
  })

  test('multimodal switch history fits the actual stdin envelope and retains the current text', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const history = [{ role: 'assistant', text: '"'.repeat(120000) },
        { role: 'assistant', text: 'LATEST_HISTORY' }]
      const input = buildHistoricalContextPayload(history, [
        { type: 'text', text: 'CURRENT_ATTACHMENT_QUESTION' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ], ANTIGRAVITY_MAX_PROMPT_BYTES)
      assert.ok(Array.isArray(input))
      const { summary } = await runTurn(h, 'tool-success.ndjson', { input })
      assert.equal(summary?.isError, false, summary?.errorDetail)
      const cap = JSON.parse(await readFile(h.capture, 'utf8'))
      assert.ok(Buffer.byteLength(cap.stdin, 'utf8') <= ANTIGRAVITY_MAX_PROMPT_BYTES)
      const prompt = JSON.parse(cap.stdin.trim()).message.content as string
      assert.match(prompt, /CURRENT_ATTACHMENT_QUESTION/)
      assert.match(prompt, /LATEST_HISTORY/)
    } finally {
      await h.restore()
    }
  })

  test('spools an oversized current input without losing its history or native continuation', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const current = '最新任务\n"quoted" 😀'.repeat(100_000)
      const input = renderHistoricalContextJsonPrompt([{ role: 'User', text: 'previous decision' }], current)
      const { summary, events } = await runTurn(h, 'tool-success.ndjson', { input })
      assert.equal(summary?.isError, false, summary?.errorDetail)
      const cap = JSON.parse(await readFile(h.capture, 'utf8'))
      assert.ok(Buffer.byteLength(cap.stdin, 'utf8') <= ANTIGRAVITY_MAX_PROMPT_BYTES)
      const prompt = JSON.parse(cap.stdin.trim()).message.content as string
      const fileLine = prompt.split('\n').find((line) => line.startsWith('Input file: '))!
      const file = JSON.parse(fileLine.slice('Input file: '.length)) as string
      assert.ok(file.startsWith(h.dir + path.sep))
      assert.equal(await readFile(file, 'utf8'), input)
      const observations = events.filter((e) => e.kind === 'context_pressure' || e.kind === 'context_compacted')
      assert.equal(observations[0]?.kind, 'context_pressure')
      assert.equal(observations[1]?.kind, 'context_compacted')
      assert.ok(observations[0]?.kind === 'context_pressure' && observations[0].pressure.usedRatio > 1)
      assert.ok(observations[1]?.kind === 'context_compacted' && observations[1].compaction.strategy === 'file_reference')
      assert.ok(observations[1]?.kind === 'context_compacted' && observations[1].compaction.droppedEntries === 0)
      // A later turn retains the same native conversation and sends only its
      // new input. The original file remains readable from native history.
      const resumed = await runTurn(h, 'tool-success.ndjson', { input: 'continue' })
      assert.equal(resumed.summary?.isError, false)
      const next = JSON.parse(await readFile(h.capture, 'utf8'))
      assert.ok(next.argv.includes('--conversation'))
      assert.doesNotMatch(next.stdin, /Input file:/)
      assert.equal(await readFile(file, 'utf8'), input)
    } finally {
      await h.restore()
    }
  })

  test('ending during context preparation never spawns a late CLI', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const events: EngineEvent[] = []
      const run = h.adapter.submitTurn({
        input: 'x'.repeat(2 * ANTIGRAVITY_MAX_PROMPT_BYTES),
        onEvent: (event) => {
          events.push(event)
          if (event.kind === 'context_pressure') run.end()
        },
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      assert.equal(await run.summary, null)
      await h.adapter.waitForOutputDrain()
      assert.equal(existsSync(h.capture), false)
      assert.equal(events.some((e) => e.kind === 'context_compacted'), false)
    } finally {
      await h.restore()
    }
  })

  test('ordinary prompts do not create context artifacts or compaction observations', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const { summary, events } = await runTurn(h, 'tool-success.ndjson', { input: 'hello' })
      assert.equal(summary?.isError, false)
      assert.equal(events.some((e) => e.kind === 'context_compacted' || e.kind === 'context_pressure'), false)
      assert.equal((await readdir(h.dir)).some((name) => name.startsWith('.openclaude-context-')), false)
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

describe('antigravity external billing sideband', () => {
  async function billingFor(
    fixture: string,
    opts: { stderr?: string; rewrite?: [string, string] } = {},
  ): Promise<Record<string, unknown>[]> {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      let file = fixture
      if (opts.rewrite) {
        file = path.join(h.dir, 'rewritten.ndjson')
        const raw = await readFile(path.join(FIXTURES, fixture), 'utf8')
        await writeFile(file, raw.split(opts.rewrite[0]).join(opts.rewrite[1]))
      }
      const seen: Record<string, unknown>[] = []
      const onBilling = (event: Record<string, unknown>): void => { seen.push(event) }
      h.adapter.on('external_billing', onBilling)
      await runTurn(h, file, opts.stderr ? { stderr: opts.stderr } : {})
      h.adapter.off('external_billing', onBilling)
      return seen
    } finally {
      await h.restore()
    }
  }

  test('a successful turn reports status only (master settles from relay rows)', async () => {
    const seen = await billingFor('tool-success.ndjson')
    assert.equal(seen.length, 1)
    const { durationMs, ...rest } = seen[0]!
    assert.equal(typeof durationMs, 'number')
    assert.deepEqual(rest, { requestId: 'b'.repeat(32), engine: 'antigravity', status: 'success' })
  })

  test('an upstream failure is an engine error (no charge)', async () => {
    const seen = await billingFor('upstream-error.ndjson')
    assert.equal(seen[0]?.status, 'error')
    assert.equal(seen[0]?.terminalCode, 'ENGINE_ERROR')
  })

  test('a relay budget refusal settles the tokens already consumed', async () => {
    const seen = await billingFor('upstream-error.ndjson', {
      rewrite: ['Error 404, Message: mock', 'Error 402, Message: antigravity relay: ANTIGRAVITY_BUDGET_EXHAUSTED'],
    })
    assert.equal(seen[0]?.status, 'success')
    assert.equal(seen[0]?.terminalCode, undefined)
  })

  test('a 429 from the account is reported as quota unavailable', async () => {
    const seen = await billingFor('upstream-error.ndjson', {
      rewrite: ['Error 404, Message: mock', 'Error 429, Message: RESOURCE_EXHAUSTED'],
    })
    assert.equal(seen[0]?.status, 'unavailable')
    assert.equal(seen[0]?.terminalCode, 'QUOTA_UNAVAILABLE')
  })

  test('the OAuth fallback is reported as auth unavailable', async () => {
    const seen = await billingFor('auth-required.ndjson', {
      stderr: 'Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x\n',
    })
    assert.equal(seen[0]?.status, 'unavailable')
    assert.equal(seen[0]?.terminalCode, 'AUTH_UNAVAILABLE')
  })
})

// OCV5-556: a relay route that lapsed mid-turn (404 ANTIGRAVITY_ROUTE_EXPIRED,
// 60 minutes into a live turn) was recorded as a successful turn with no reply
// ("本轮未能产出可见回复"). route-expired.ndjson/.stderr.txt are the raw output of
// the real 1.4.0 CLI against a relay answering ROUTE_EXPIRED after one tool:
// its error_message step carries no text at all.
describe('Antigravity route expiry mid-turn (OCV5-556)', () => {
  const ROUTE_EXPIRED_STDERR = path.join(FIXTURES, 'route-expired.stderr.txt')

  async function fixtureWithStatus(dir: string, status: string, extra: object[] = []): Promise<string> {
    const lines = (await readFile(path.join(FIXTURES, 'route-expired.ndjson'), 'utf8')).trim().split('\n')
    const result = JSON.parse(lines.pop()!)
    result.result.status = status
    if (status === 'SUCCESS') result.result.error = ''
    const steps = extra.map((step) => JSON.stringify({ event: 'step_update', step_update: step }))
    const file = path.join(dir, `route-expired-${status}-${extra.length}.ndjson`)
    await writeFile(file, `${[...lines, ...steps, JSON.stringify(result)].join('\n')}\n`)
    return file
  }

  test('raw CLI output: the turn fails as a recoverable upstream failure', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const stderr = await readFile(ROUTE_EXPIRED_STDERR, 'utf8')
      const { summary, sessionIds } = await runTurn(h, 'route-expired.ndjson', { stderr })
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_ROUTE_EXPIRED/)
      assert.equal(classifyRunError(summary?.errorDetail).code, 'upstream_failed')
      assert.deepEqual(sessionIds, [])
    } finally {
      await h.restore()
    }
  })

  test('CLI reporting SUCCESS right after its own error step is still a failure', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const stderr = await readFile(ROUTE_EXPIRED_STDERR, 'utf8')
      const fixture = await fixtureWithStatus(h.dir, 'SUCCESS')
      const { summary, events, sessionIds } = await runTurn(h, fixture, { stderr })
      assert.equal(summary?.isError, true, 'not a successful turn with no reply')
      assert.match(summary?.errorDetail ?? '', /^ANTIGRAVITY_ERROR_STEP: [\s\S]*ANTIGRAVITY_ROUTE_EXPIRED/)
      assert.equal(classifyRunError(summary?.errorDetail).code, 'upstream_failed')
      assert.ok(events.some((e) => e.kind === 'error'))
      assert.deepEqual(sessionIds, [], 'the failed launch does not move the resume id')

      const bare = await fixtureWithStatus(h.dir, 'SUCCESS')
      const quiet = await runTurn(h, bare)
      assert.equal(quiet.summary?.isError, true, 'also without any stderr')
      assert.equal(classifyRunError(quiet.summary?.errorDetail).code, 'upstream_failed')
    } finally {
      await h.restore()
    }
  })

  test('an error step the CLI recovered from (tool and reply after it) is not a failure', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const conversation_id = '90a2f047-c919-49fa-850d-1d1e4c88fe7b'
      const fixture = await fixtureWithStatus(h.dir, 'SUCCESS', [
        { conversation_id, step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'done after retry' },
      ])
      const { summary } = await runTurn(h, fixture)
      assert.equal(summary?.isError, false, summary?.errorDetail)
      assert.match(summary?.assistantText ?? '', /done after retry/)
    } finally {
      await h.restore()
    }
  })
})

// OCV5-556 (live, uid 765): after one launch of a conversation failed on a
// lapsed relay route, every later `--conversation` launch of the real 1.4.0
// CLI ended status ERROR with that old 404 although it answered normally
// (exit 0, empty stderr). The automatic recovery and the next message both
// "failed" until the retry circuit opened. Raw CLI output, offline fake relay:
// resume-route-expired = the failing launch, resume-after-error = the next one.
describe('Antigravity stale result error after a failed launch (OCV5-556)', () => {
  const CONVERSATION = '4de23c8d-7a49-4e45-8244-f9a97d41a8f7'

  test('a resumed launch that answered is a success despite the repeated old error', async () => {
    const h = await harness({ resumeSessionId: CONVERSATION })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const { summary, sessionIds } = await runTurn(h, 'resume-after-error.ndjson')
      assert.equal(summary?.isError, false, summary?.errorDetail)
      assert.match(summary?.assistantText ?? '', /hi there/)
      assert.deepEqual(sessionIds, [CONVERSATION], 'the conversation keeps resuming')
    } finally {
      await h.restore()
    }
  })

  test('the launch that really failed still fails', async () => {
    const h = await harness({ resumeSessionId: CONVERSATION })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const stderr = await readFile(path.join(FIXTURES, 'resume-route-expired.stderr.txt'), 'utf8')
      const { summary, sessionIds } = await runTurn(h, 'resume-route-expired.ndjson', { stderr })
      assert.equal(summary?.isError, true)
      assert.equal(classifyRunError(summary?.errorDetail).code, 'upstream_failed')
      assert.deepEqual(sessionIds, [])
    } finally {
      await h.restore()
    }
  })

  // Codex r1 P1: a partial reply followed by a real failure is not the CLI
  // repeating an old error, whether it shows in stderr or only in the exit code.
  test('a partial reply then a real failure still fails', async () => {
    const h = await harness({ resumeSessionId: CONVERSATION })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const lines = (await readFile(path.join(FIXTURES, 'resume-after-error.ndjson'), 'utf8')).trim().split('\n')
      const result = JSON.parse(lines.pop()!)
      result.result.error = 'request failed (code 503): upstream unavailable'
      const file = path.join(h.dir, 'resume-partial-then-503.ndjson')
      await writeFile(file, `${[...lines, JSON.stringify(result)].join('\n')}\n`)
      const stderr = 'error: request failed (code 503): upstream unavailable\nAGY_ERROR: {"short_error":"request failed (code 503)"}\n'
      const viaStderr = await runTurn(h, file, { stderr })
      assert.equal(viaStderr.summary?.isError, true)
      assert.match(viaStderr.summary?.errorDetail ?? '', /503/)
      assert.deepEqual(viaStderr.sessionIds, [])

      process.env.FAKE_AGY_EXIT_CODE = '3'
      const viaExit = await runTurn(h, file)
      assert.equal(viaExit.summary?.isError, true, 'non-zero exit with no stderr still fails')
    } finally {
      await h.restore()
    }
  })

  // Codex r2 P1: the result timer must not fail the turn before the exit code
  // arrives; a CLI still running past the bounded wait fails.
  test('waits for the exit code when the CLI exits after the result timer', async () => {
    const h = await harness({ resumeSessionId: CONVERSATION })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      _internals.setTimingTestHooks({ resultSettleMs: 50, staleErrorExitWaitMs: 2_000 })
      process.env.FAKE_AGY_EXIT_DELAY_MS = '400'
      const late = await runTurn(h, 'resume-after-error.ndjson')
      assert.equal(late.summary?.isError, false, late.summary?.errorDetail)
      assert.deepEqual(late.sessionIds, [CONVERSATION])

      _internals.setTimingTestHooks({ resultSettleMs: 50, staleErrorExitWaitMs: 200 })
      process.env.FAKE_AGY_EXIT_DELAY_MS = '1500'
      const stuck = await runTurn(h, 'resume-after-error.ndjson')
      assert.equal(stuck.summary?.isError, true, 'no exit code within the bound: not waved through')
    } finally {
      _internals.setTimingTestHooks(null)
      await h.restore()
    }
  })

  test('a fresh (not resumed) launch with an ERROR result and a reply still fails', async () => {
    const h = await harness()
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const { summary } = await runTurn(h, 'resume-after-error.ndjson')
      assert.equal(summary?.isError, true)
    } finally {
      await h.restore()
    }
  })

  test('an ERROR result with no answer from this launch is not waved through', async () => {
    const h = await harness({ resumeSessionId: CONVERSATION })
    try {
      h.adapter.setAntigravityRoute(ROUTE)
      const lines = (await readFile(path.join(FIXTURES, 'resume-after-error.ndjson'), 'utf8')).trim().split('\n')
      const kept = lines.filter((line) => !line.includes('"agent_response"'))
      const result = JSON.parse(kept.pop()!)
      result.result.response = ''
      const file = path.join(h.dir, 'resume-error-no-answer.ndjson')
      await writeFile(file, `${[...kept, JSON.stringify(result)].join('\n')}\n`)
      const { summary } = await runTurn(h, file)
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_ROUTE_EXPIRED/)
    } finally {
      await h.restore()
    }
  })
})
