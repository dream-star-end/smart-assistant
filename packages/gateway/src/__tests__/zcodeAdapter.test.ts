/**
 * Experimental community ZCode CLI adapter — official 0.16.3 contract,
 * no network credentials.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/zcodeAdapter.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ZCODE_HOSTED_PERMISSION_MODE } from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { existsSync, readFileSync } from 'node:fs'
import { ZcodeAdapter, _internals } from '../engine/zcodeAdapter.js'
import type { EngineEvent, EngineExternalBillingEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const successFixture = JSON.parse(
  readFileSync(new URL('./fixtures/zcode/success.json', import.meta.url), 'utf8'),
) as {
  sessionId: string
  response: string
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  eventCount: number
  projection: { status: string; turnCount: number; totalTokenCount: number; contextUsed: number; contextWindow: number }
}
const doctorFixture = JSON.parse(
  readFileSync(new URL('./fixtures/zcode/doctor.json', import.meta.url), 'utf8'),
) as { cli: { version: string; processName: string } }

const REQUEST_ID = 'b'.repeat(32)
const TURN_KEY = 'c'.repeat(64)

function config(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'zcode-experimental' },
  } as unknown as OpenClaudeConfig
}

function createOpts(cwd: string, model = 'zcode-experimental'): EngineCreateOpts {
  return {
    sessionKey: 'agent:main:webchat:dm:zcode-test',
    agentId: 'main',
    agentBaseDir: cwd,
    config: config(),
    model,
    resumeSessionId: 'sess_prior',
    persona: path.join(cwd, 'persona.md'),
  } as EngineCreateOpts
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

describe('ZcodeAdapter', () => {
  test('resolves the hot-config wrapper before the image fallback', () => {
    assert.equal(
      _internals.resolveZcodeBin(undefined, undefined, true),
      _internals.ZCODE_HOTCFG_WRAPPER_BIN,
    )
    assert.equal(
      _internals.resolveZcodeBin('  /tmp/test-zcode-wrapper  ', undefined, true),
      '/tmp/test-zcode-wrapper',
    )
  })

  // ── P0-2:图片等 base64 二进制 block 绝不 stringify 进纯文本 prompt ──
  test('promptText replaces image blocks with a placeholder and never leaks base64', () => {
    const base64 = 'aVZCT1J3MEtHZ29BQUFBTlNVaEVVZw=='.repeat(64)
    const prompt = _internals.promptText([
      { type: 'text', text: 'describe this image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'tool_result', content: 'structured-passthrough' },
    ])
    assert.ok(prompt.includes('describe this image'))
    assert.ok(prompt.includes('图片附件已省略'), '占位提示必须出现在 prompt 里')
    assert.ok(!prompt.includes(base64.slice(0, 48)), 'base64 数据绝不进 prompt')
    assert.ok(prompt.includes('structured-passthrough'), '非二进制结构化 block 维持 stringify')
  })

  test('keeps the live 0.16.3 doctor/processName fixture experimental', () => {
    assert.equal(doctorFixture.cli.version, '0.16.3')
    assert.equal(doctorFixture.cli.processName, 'zcode-cli')
    assert.equal(ZCODE_HOSTED_PERMISSION_MODE, 'yolo')
  })

  test('runs the headless --json object, locks yolo, and reports external usage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-adapter-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const capture = path.join(dir, 'capture.json')
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(path.join(__dirname, 'capture.json'), JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    OC_ZCODE_UPSTREAM_MODEL: process.env.OC_ZCODE_UPSTREAM_MODEL,
    OC_ZCODE_RELAY_BASE_URL: process.env.OC_ZCODE_RELAY_BASE_URL,
    OC_ZCODE_RELAY_TOKEN: process.env.OC_ZCODE_RELAY_TOKEN,
    ZCODE_API_KEY: process.env.ZCODE_API_KEY,
    OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ZAI_CODING_PLAN_KEY: process.env.ZAI_CODING_PLAN_KEY,
  },
}))
process.stdout.write(${JSON.stringify(`${JSON.stringify(successFixture)}\n`)})
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    const previousToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    const previousKey = process.env.ZCODE_API_KEY
    const previousZai = process.env.ZAI_CODING_PLAN_KEY
    process.env.OC_ZCODE_CLI_BIN = fake
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'must-not-leak'
    process.env.ZCODE_API_KEY = 'must-not-read'
    process.env.ZAI_CODING_PLAN_KEY = 'must-not-read'
    try {
      const adapter = new ZcodeAdapter(createOpts(dir))
      const events: EngineEvent[] = []
      const billing: EngineExternalBillingEvent[] = []
      adapter.on('external_billing', (event: EngineExternalBillingEvent) => billing.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'fix it',
        requestId: REQUEST_ID,
        turnKey: TURN_KEY,
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.ok(summary)
      assert.equal(summary.isError, false)
      assert.equal(summary.assistantText, 'ok')
      assert.equal(summary.usage.inputTokens, 12)
      assert.equal(summary.usage.outputTokens, 4)
      assert.equal(adapter.nativeSessionId, 'sess_live_fixture_001')
      assert.equal(events.at(-1)?.kind, 'final')
      assert.ok(events.some((event) => event.kind === 'block'))
      assert.ok(events.some((event) => event.kind === 'usage'))
      assert.deepEqual(billing.map((event) => event.engine), ['zcode'])
      assert.equal(billing[0]?.status, 'success')
      assert.equal(billing[0]?.requestId, REQUEST_ID)

      const captured = JSON.parse(await readFile(capture, 'utf8')) as {
        argv: string[]
        env: Record<string, string | undefined>
      }
      assert.equal(captured.argv[captured.argv.indexOf('--mode') + 1], 'yolo')
      assert.ok(captured.argv.includes('--json'))
      assert.ok(captured.argv.includes('--no-color'))
      assert.equal(captured.argv[captured.argv.indexOf('--cwd') + 1], dir)
      assert.equal(captured.argv[captured.argv.indexOf('--resume') + 1], 'sess_prior')
      assert.equal(captured.env.OC_ZCODE_UPSTREAM_MODEL, 'zai-coding-plan/glm-5.3')
      assert.equal(captured.env.ZCODE_API_KEY, undefined)
      assert.equal(captured.env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      assert.equal(captured.env.ANTHROPIC_API_KEY, undefined)
      assert.equal(captured.env.ZAI_CODING_PLAN_KEY, undefined)
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      restoreEnv('OPENCLAUDE_V3_CONTAINER_TOKEN', previousToken)
      restoreEnv('ZCODE_API_KEY', previousKey)
      restoreEnv('ZAI_CODING_PLAN_KEY', previousZai)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('projects ZCode hook tools, wires real MCP config, and removes per-turn credentials', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-platform-adapter-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const capture = path.join(dir, 'capture.json')
    const hookCollector = path.resolve(
      process.cwd(),
      'packages/commercial/agent-sandbox/platform-runtime/bin/oc-zcode-hook',
    )
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const configPath = process.env.OC_ZCODE_PLATFORM_CONFIG_FILE
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const hook = config.hooks.events.PreToolUse[0].hooks[0]
const common = {
  sessionId: 'sess_live_fixture_001',
  toolCallId: 'call_hook_1',
  toolName: 'Bash',
  toolInput: { command: 'printf ok', description: 'probe' },
  timestamp: new Date().toISOString(),
}
for (const event of [
  { ...common, hookEventName: 'PreToolUse', sessionId: 'sess_child', toolCallId: 'call_child', toolName: 'Read' },
  { ...common, hookEventName: 'PreToolUse' },
  { ...common, hookEventName: 'PostToolUse', toolResponse: { stdout: 'ok', exitCode: 0 }, toolResultPreview: 'ok' },
]) {
  const result = spawnSync(hook.command, hook.args, { input: JSON.stringify(event), encoding: 'utf8' })
  if (result.status !== 0 || result.stdout.trim() !== '{}') process.exit(9)
}
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  contextDir: path.dirname(configPath),
  configHasBearer: fs.readFileSync(configPath, 'utf8').includes('adapter-secret-bearer'),
  hasMcp: Boolean(config.mcp?.servers?.openclaude_memory),
  tokenFile: config.mcp?.servers?.openclaude_memory?.env?.OPENCLAUDE_GATEWAY_TOKEN_FILE,
}))
process.stdout.write(${JSON.stringify(`${JSON.stringify(successFixture)}\n`)})
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    const previousHook = process.env.OC_ZCODE_HOOK_COLLECTOR_BIN
    const previousAllow = process.env.OC_ZCODE_TEST_ALLOW_UNTRUSTED_HOOK
    const previousNode = process.env.OC_ZCODE_TEST_NODE_BIN
    process.env.OC_ZCODE_CLI_BIN = fake
    process.env.OC_ZCODE_HOOK_COLLECTOR_BIN = hookCollector
    process.env.OC_ZCODE_TEST_ALLOW_UNTRUSTED_HOOK = '1'
    process.env.OC_ZCODE_TEST_NODE_BIN = process.execPath
    try {
      const opts = createOpts(dir)
      opts.config.gateway.accessToken = 'adapter-secret-bearer'
      opts.config.gateway.port = 18789
      const adapter = new ZcodeAdapter(opts)
      adapter.clearSessionId()
      const events: EngineEvent[] = []
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'use a tool',
        requestId: REQUEST_ID,
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.ok(summary)
      assert.equal(summary.tools.length, 1)
      assert.equal(summary.tools[0]?.toolName, 'Bash')
      assert.equal(summary.tools[0]?.completed, true)
      assert.equal(summary.tools[0]?.output.includes('ok'), true)
      assert.ok(events.some((event) => event.kind === 'tool_use_detected'))
      assert.ok(events.some((event) => event.kind === 'tool_result_detected'))
      assert.equal(events.filter((event) => event.kind === 'block' && event.block.kind === 'tool_use').length, 1)
      assert.equal(events.filter((event) => event.kind === 'block' && event.block.kind === 'tool_result').length, 1)
      const captured = JSON.parse(await readFile(capture, 'utf8')) as {
        contextDir: string
        configHasBearer: boolean
        hasMcp: boolean
        tokenFile: string
      }
      assert.equal(captured.configHasBearer, false)
      assert.equal(captured.hasMcp, true)
      assert.equal(existsSync(captured.contextDir), false)
      assert.equal(existsSync(captured.tokenFile), false)
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      restoreEnv('OC_ZCODE_HOOK_COLLECTOR_BIN', previousHook)
      restoreEnv('OC_ZCODE_TEST_ALLOW_UNTRUSTED_HOOK', previousAllow)
      restoreEnv('OC_ZCODE_TEST_NODE_BIN', previousNode)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('streams resumed SQLite reasoning/text before final and does not replay the final response', async (t) => {
    try {
      await import('node:sqlite')
    } catch {
      t.skip('node:sqlite requires Node 22')
      return
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-stream-'))
    const home = path.join(dir, 'home')
    const databaseDir = path.join(home, 'zcode-cli', 'cli', 'db')
    const databaseFile = path.join(databaseDir, 'db.sqlite')
    const fake = path.join(dir, 'fake-zcode-stream.cjs')
    await mkdir(databaseDir, { recursive: true })
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    const { DatabaseSync } = await import('node:sqlite')
    const seed = new DatabaseSync(databaseFile)
    seed.exec([
      'CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)',
      'CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)',
    ].join(';'))
    seed.close()
    await writeFile(fake, [
      '#!/usr/bin/env node',
      "const path = require('node:path')",
      "const { DatabaseSync } = require('node:sqlite')",
      "const db = new DatabaseSync(path.join(process.env.OPENCLAUDE_HOME, 'zcode-cli', 'cli', 'db', 'db.sqlite'))",
      'const now = Date.now()',
      "db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('msg_live','sess_prior',now,JSON.stringify({role:'assistant'}),0)",
      "db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('reason_live','msg_live','sess_prior',now,JSON.stringify({type:'reasoning',text:'先',time:{start:now}}),0)",
      "db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('text_live_a','msg_live','sess_prior',now+1,JSON.stringify({type:'text',text:'答',time:{start:now+1}}),1)",
      "db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('text_live_b','msg_live','sess_prior',now+2,JSON.stringify({type:'text',text:'案',time:{start:now+2}}),2)",
      "setTimeout(() => db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({type:'reasoning',text:'先思考',time:{start:now}}),'reason_live'), 250)",
      "setTimeout(() => { process.stdout.write(JSON.stringify({sessionId:'sess_prior',response:'答案完成',usage:{inputTokens:12,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0},eventCount:3,projection:{status:'idle',turnCount:1,totalTokenCount:16,contextUsed:16,contextWindow:1000}})+'\\n'); db.close() }, 2000)",
    ].join('\n'))
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    const previousHome = process.env.OPENCLAUDE_HOME
    process.env.OC_ZCODE_CLI_BIN = fake
    process.env.OPENCLAUDE_HOME = home
    try {
      const adapter = new ZcodeAdapter(createOpts(dir))
      const events: EngineEvent[] = []
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'stream it',
        requestId: REQUEST_ID,
        assistantMessageId: 'answer-base',
        thinkingMessageId: 'thinking-base',
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const deadline = Date.now() + 1_500
      while (
        Date.now() < deadline &&
        !(
          events
            .filter((event) => event.kind === 'block' && event.block.kind === 'text')
            .map((event) => event.kind === 'block' && event.block.kind === 'text' ? event.block.text : '')
            .join('') === '答案' &&
          events
            .filter((event) => event.kind === 'block' && event.block.kind === 'thinking')
            .map((event) => event.kind === 'block' && event.block.kind === 'thinking' ? event.block.text : '')
            .join('') === '先思考'
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.equal(events.some((event) => event.kind === 'final'), false)
      assert.equal(
        events
          .filter((event) => event.kind === 'block' && event.block.kind === 'thinking')
          .map((event) => event.kind === 'block' && event.block.kind === 'thinking' ? event.block.text : '')
          .join(''),
        '先思考',
      )
      assert.equal(
        events
          .filter((event) => event.kind === 'block' && event.block.kind === 'text')
          .map((event) => event.kind === 'block' && event.block.kind === 'text' ? event.block.text : '')
          .join(''),
        '答案',
      )
      const summary = await run.summary
      assert.equal(summary?.thinkingText, '先思考')
      assert.equal(summary?.assistantText, '答案完成')
      assert.equal(
        events
          .filter((event) => event.kind === 'block' && event.block.kind === 'text')
          .map((event) => event.kind === 'block' && event.block.kind === 'text' ? event.block.text : '')
          .join(''),
        '答案完成',
      )
      assert.equal(events.at(-1)?.kind, 'final')
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      restoreEnv('OPENCLAUDE_HOME', previousHome)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('streams relay SSE deltas before CLI final and keeps final text exact', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-relay-stream-'))
    const fake = path.join(dir, 'fake-zcode-relay-stream.cjs')
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    await writeFile(fake, [
      '#!/usr/bin/env node',
      "setTimeout(() => process.stdout.write(JSON.stringify({sessionId:'sess_prior',response:'第一第二',usage:{inputTokens:12,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0},eventCount:3,projection:{status:'idle',turnCount:1,totalTokenCount:16,contextUsed:16,contextWindow:1000}})+'\\n'), 1200)",
    ].join('\n'))
    await chmod(fake, 0o755)
    const token = 'f'.repeat(64)
    let observedAuth = ''
    const server = createServer((req, res) => {
      observedAuth = String(req.headers.authorization ?? '')
      const parsed = new URL(req.url ?? '/', 'http://local')
      const after = Number(parsed.searchParams.get('after') ?? '0')
      const events = after < 2
        ? [
            { seq: 1, kind: 'thinking', text: '先思考' },
            { seq: 2, kind: 'text', text: '第一' },
          ]
        : after < 3
          ? [{ seq: 3, kind: 'text', text: '第二' }]
          : []
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ events, next: events.at(-1)?.seq ?? after, done: false }))
    })
    const port = await listen(server)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    const previousContainerToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    process.env.OC_ZCODE_CLI_BIN = fake
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = `oc-v3.1.${'a'.repeat(64)}`
    try {
      const adapter = new ZcodeAdapter(createOpts(dir))
      adapter.setZcodeRoute({
        baseUrl: `http://127.0.0.1:${port}/internal/v5/zcode-relay/route/${token}`,
        routeToken: token,
      })
      const events: Array<{ at: number; event: EngineEvent }> = []
      const startedAt = Date.now()
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'relay stream',
        requestId: REQUEST_ID,
        assistantMessageId: 'relay-answer',
        thinkingMessageId: 'relay-thinking',
        onEvent: (event) => events.push({ at: Date.now() - startedAt, event }),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const deadline = Date.now() + 800
      while (
        Date.now() < deadline &&
        events
          .filter(({ event }) => event.kind === 'block' && event.block.kind === 'text')
          .map(({ event }) => event.kind === 'block' && event.block.kind === 'text' ? event.block.text : '')
          .join('') !== '第一第二'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(events.some(({ event }) => event.kind === 'final'), false)
      assert.equal(
        events
          .filter(({ event }) => event.kind === 'block' && event.block.kind === 'text')
          .map(({ event }) => event.kind === 'block' && event.block.kind === 'text' ? event.block.text : '')
          .join(''),
        '第一第二',
      )
      assert.equal(
        events.filter(({ event }) => event.kind === 'block' && event.block.kind === 'text').length,
        2,
      )
      const summary = await run.summary
      assert.equal(summary?.thinkingText, '先思考')
      assert.equal(summary?.assistantText, '第一第二')
      assert.equal(
        events
          .filter(({ event }) => event.kind === 'block' && event.block.kind === 'text')
          .map(({ event }) => event.kind === 'block' && event.block.kind === 'text' ? event.block.text : '')
          .join(''),
        '第一第二',
      )
      assert.equal(events.at(-1)?.event.kind, 'final')
      assert.equal(observedAuth, `Bearer oc-v3.1.${'a'.repeat(64)}`)
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      restoreEnv('OPENCLAUDE_V3_CONTAINER_TOKEN', previousContainerToken)
      await closeServer(server)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('maps live config-missing stderr to a neutral auth-unavailable terminal', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-missing-'))
    const fake = path.join(dir, 'fake-zcode-missing.cjs')
    await writeFile(fake, `#!/usr/bin/env node
process.stderr.write('Error: Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider before running ZCode.\\n')
process.exit(1)
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    process.env.OC_ZCODE_CLI_BIN = fake
    try {
      const adapter = new ZcodeAdapter(createOpts(dir))
      const events: EngineEvent[] = []
      const billing: EngineExternalBillingEvent[] = []
      adapter.on('external_billing', (event: EngineExternalBillingEvent) => billing.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'must fail closed',
        requestId: REQUEST_ID,
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      assert.ok(summary)
      assert.equal(summary.isError, true)
      assert.equal(summary.errorDetail, 'Authentication unavailable')
      assert.equal(events.find((event) => event.kind === 'error')?.error, 'Authentication unavailable')
      assert.equal(events.at(-1)?.kind, 'final')
      assert.equal(billing[0]?.engine, 'zcode')
      assert.equal(billing[0]?.status, 'unavailable')
      assert.equal(billing[0]?.terminalCode, 'AUTH_UNAVAILABLE')
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('maps public glm-5.3-zai and hidden canary to the pinned CLI upstream', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-canonical-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const capture = path.join(dir, 'capture.json')
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(path.join(__dirname, 'capture.json'), JSON.stringify({
  env: {
    OC_ZCODE_UPSTREAM_MODEL: process.env.OC_ZCODE_UPSTREAM_MODEL,
    OC_ZCODE_RELAY_BASE_URL: process.env.OC_ZCODE_RELAY_BASE_URL,
    OC_ZCODE_RELAY_TOKEN: process.env.OC_ZCODE_RELAY_TOKEN,
  },
}))
process.stdout.write(${JSON.stringify(`${JSON.stringify(successFixture)}\n`)})
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    process.env.OC_ZCODE_CLI_BIN = fake
    try {
      const adapter = new ZcodeAdapter(createOpts(dir, 'glm-5.3-zai'))
      adapter.setZcodeRoute({
        baseUrl: 'http://127.0.0.1:18791/internal/v5/zcode-relay/route/' + 'a'.repeat(64),
        routeToken: 'a'.repeat(64),
      })
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'ok',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      assert.equal(summary?.isError, false)
      const captured = JSON.parse(await readFile(capture, 'utf8')) as { env: Record<string, string | undefined> }
      assert.equal(captured.env.OC_ZCODE_UPSTREAM_MODEL, 'zai-coding-plan/glm-5.3')
      assert.equal(captured.env.OC_ZCODE_RELAY_TOKEN, 'a'.repeat(64))
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects a user-supplied upstream id and hosted turns without a relay route', async () => {
    const adapter = new ZcodeAdapter(createOpts(tmpdir(), 'zai-coding-plan/glm-5.3'))
    adapter.on('error', () => {})
    const run = adapter.submitTurn({
      input: 'must not run',
      requestId: REQUEST_ID,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await assert.rejects(run.submitted, /ZCODE_MODEL_REJECTED/)

    const previousBin = process.env.OC_ZCODE_CLI_BIN
    restoreEnv('OC_ZCODE_CLI_BIN', undefined)
    try {
      const hosted = new ZcodeAdapter(createOpts(tmpdir(), 'zcode-experimental'))
      hosted.on('error', () => {})
      const hostedRun = hosted.submitTurn({
        input: 'must not run',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await assert.rejects(hostedRun.submitted, /ZCODE_RELAY_MISSING/)
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
    }
  })

  test('stdout parser accepts only the live fixture object and rejects counterexamples', () => {
    assert.equal(_internals.suffixPrefixOverlap('AB', 'ABC'), 2)
    assert.equal(_internals.suffixPrefixOverlap('prefix-AB', 'ABC'), 2)
    assert.equal(_internals.suffixPrefixOverlap('ABC', 'ABC'), 3)
    assert.equal(_internals.suffixPrefixOverlap('left', 'right'), 0)
    const parsed = _internals.parseJsonResult(JSON.stringify(successFixture))
    assert.equal(parsed.sessionId, 'sess_live_fixture_001')
    assert.equal(parsed.eventCount, 3)
    assert.throws(() => _internals.parseJsonResult('null'), /single JSON object/)
    assert.throws(() => _internals.parseJsonResult('{}'), /empty/)
    assert.throws(() => _internals.parseJsonResult('1'), /single JSON object/)
    assert.throws(() => _internals.parseJsonResult('"x"'), /single JSON object/)
    assert.throws(() => _internals.parseJsonResult('[]'), /single JSON object/)
    assert.throws(
      () => _internals.parseJsonResult(`${JSON.stringify(successFixture)}\n${JSON.stringify(successFixture)}`),
      /single JSON object/,
    )
    assert.throws(
      () => _internals.parseJsonResult(`prefix ${JSON.stringify(successFixture)}`),
      /single JSON object/,
    )
    assert.throws(
      () => _internals.parseJsonResult(JSON.stringify({ ...successFixture, sessionId: 'not-a-session' })),
      /sess_/,
    )
    assert.throws(
      () => _internals.parseJsonResult(JSON.stringify({
        sessionId: 'sess_x',
        response: 'ok',
        eventCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })),
      /projection/,
    )
    const withoutUsage = { ...successFixture } as Record<string, unknown>
    delete withoutUsage.usage
    assert.throws(() => _internals.parseJsonResult(JSON.stringify(withoutUsage)), /usage must be an object/)
    assert.throws(
      () => _internals.parseJsonResult(JSON.stringify({ ...successFixture, usage: {} })),
      /usage.inputTokens/,
    )
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '12', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => _internals.parseJsonResult(JSON.stringify({
          ...successFixture,
          usage: { ...successFixture.usage, inputTokens: bad },
        })),
        /usage.inputTokens/,
      )
    }
    assert.throws(
      () => _internals.parseJsonResult(JSON.stringify({
        ...successFixture,
        usage: { ...successFixture.usage, totalTokens: 99 },
      })),
      /usage totals must match projection.totalTokenCount/,
    )
  })

  test('exit 0 with Error on stderr or invalid stdout becomes one captured failure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-parse-'))
    const cases: Array<{ name: string; script: string }> = [
      {
        name: 'empty-object',
        script: `#!/usr/bin/env node
process.stdout.write('{}\\n')
`,
      },
      {
        name: 'null',
        script: `#!/usr/bin/env node
process.stdout.write('null\\n')
`,
      },
      {
        name: 'mixed',
        script: `#!/usr/bin/env node
process.stdout.write('ok\\n{"sessionId":"sess_x","response":"ok","eventCount":1}\\n')
`,
      },
      {
        name: 'missing-usage',
        script: `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(`${JSON.stringify({
          sessionId: 'sess_x',
          response: 'ok',
          eventCount: 1,
          projection: { status: 'idle', turnCount: 1, totalTokenCount: 0, contextUsed: 0, contextWindow: 1 },
        })}\n`)})
`,
      },
      {
        name: 'stderr-error',
        script: `#!/usr/bin/env node
process.stderr.write('Error: leaked exception after a fake success\\n')
process.stdout.write(${JSON.stringify(`${JSON.stringify(successFixture)}\n`)})
`,
      },
    ]
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    try {
      for (const item of cases) {
        const fake = path.join(dir, `${item.name}.cjs`)
        await writeFile(fake, item.script)
        await chmod(fake, 0o755)
        process.env.OC_ZCODE_CLI_BIN = fake
        const adapter = new ZcodeAdapter(createOpts(dir))
        const events: EngineEvent[] = []
        const billing: EngineExternalBillingEvent[] = []
        const uncaught: unknown[] = []
        const onUncaught = (err: unknown) => { uncaught.push(err) }
        process.on('uncaughtException', onUncaught)
        adapter.on('external_billing', (event: EngineExternalBillingEvent) => billing.push(event))
        adapter.on('error', () => {})
        try {
          const run = adapter.submitTurn({
            input: 'must fail closed',
            requestId: REQUEST_ID,
            onEvent: (event) => events.push(event),
            sessionTotals: { totalCostUSD: 0, turns: 0 },
            toolUseIdToName: new Map(),
          })
          await run.submitted
          const summary = await run.summary
          assert.ok(summary, item.name)
          assert.equal(summary.isError, true, item.name)
          assert.equal(events.filter((event) => event.kind === 'error').length, 1, item.name)
          assert.equal(events.at(-1)?.kind, 'final', item.name)
          assert.equal(billing[0]?.status === 'error' || billing[0]?.status === 'unavailable', true, item.name)
          assert.equal(uncaught.length, 0, item.name)
        } finally {
          process.off('uncaughtException', onUncaught)
        }
      }
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('isZcodeStaleResumeError matches only explicit missing-session CLI text', () => {
    assert.equal(_internals.isZcodeStaleResumeError('Session not found: sess_deadbeef'), true)
    assert.equal(_internals.isZcodeStaleResumeError('Persisted child session not found: sess_deadbeef'), true)
    assert.equal(_internals.isZcodeStaleResumeError('Error: Session not found: sess_abc-def'), true)
    assert.equal(_internals.isZcodeStaleResumeError('CLI failed'), false)
    assert.equal(_internals.isZcodeStaleResumeError('upstream_failed'), false)
    assert.equal(_internals.isZcodeStaleResumeError('ECONNRESET from relay'), false)
    assert.equal(_internals.isZcodeStaleResumeError('Session not found: other-id'), false)
    assert.equal(_internals.isZcodeStaleResumeError('No conversation found with session ID: sess_x'), false)
    assert.equal(_internals.isZcodeStaleResumeError(''), false)
  })

  test('explicit stale resume evicts via staleResumeId and retries once as a fresh session', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-stale-retry-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const count = path.join(dir, 'count')
    const captures = path.join(dir, 'argv.json')
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const countFile = path.join(__dirname, 'count')
const argvFile = path.join(__dirname, 'argv.json')
const n = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '0') + 1
fs.writeFileSync(countFile, String(n))
const argv = process.argv.slice(2)
const prev = fs.existsSync(argvFile) ? JSON.parse(fs.readFileSync(argvFile, 'utf8')) : []
prev.push({ n, argv })
fs.writeFileSync(argvFile, JSON.stringify(prev))
if (argv.includes('--resume')) {
  process.stderr.write('Session not found: sess_prior\\n')
  process.exit(1)
}
process.stdout.write(${JSON.stringify(`${JSON.stringify(successFixture)}\n`)})
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    process.env.OC_ZCODE_CLI_BIN = fake
    try {
      const adapter = new ZcodeAdapter(createOpts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'resume please',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      assert.equal(summary?.isError, false)
      assert.equal(summary?.staleResumeId, false)
      assert.equal(adapter.nativeSessionId, 'sess_live_fixture_001')
      assert.equal(await readFile(count, 'utf8'), '2')
      const spawned = JSON.parse(await readFile(captures, 'utf8')) as Array<{ n: number; argv: string[] }>
      assert.equal(spawned[0]?.argv[spawned[0].argv.indexOf('--resume') + 1], 'sess_prior')
      assert.equal(spawned[1]?.argv.includes('--resume'), false)
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('explicit stale resume without a successful retry sets staleResumeId', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-stale-keep-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const count = path.join(dir, 'count')
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const countFile = path.join(__dirname, 'count')
const n = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '0') + 1
fs.writeFileSync(countFile, String(n))
process.stderr.write('Session not found: sess_prior\\n')
process.exit(1)
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    process.env.OC_ZCODE_CLI_BIN = fake
    try {
      const adapter = new ZcodeAdapter(createOpts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'still missing',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      assert.equal(summary?.isError, true)
      assert.equal(summary?.staleResumeId, true)
      assert.equal(await readFile(count, 'utf8'), '2')
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('generic CLI / upstream errors do not look like stale resume and do not retry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-generic-fail-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const count = path.join(dir, 'count')
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const countFile = path.join(__dirname, 'count')
const n = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '0') + 1
fs.writeFileSync(countFile, String(n))
process.stderr.write('ECONNRESET from relay\\n')
process.exit(1)
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    process.env.OC_ZCODE_CLI_BIN = fake
    try {
      const adapter = new ZcodeAdapter(createOpts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'relay down',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      assert.equal(summary?.isError, true)
      assert.equal(summary?.staleResumeId, false)
      assert.equal(summary?.errorDetail, 'CLI failed')
      assert.equal(await readFile(count, 'utf8'), '1')
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('second submitTurn resumes the native sess_* from the first success', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-r2-resume-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const captures = path.join(dir, 'argv.json')
    await writeFile(path.join(dir, 'persona.md'), 'persona-line')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const argvFile = path.join(__dirname, 'argv.json')
const argv = process.argv.slice(2)
const prev = fs.existsSync(argvFile) ? JSON.parse(fs.readFileSync(argvFile, 'utf8')) : []
prev.push(argv)
fs.writeFileSync(argvFile, JSON.stringify(prev))
process.stdout.write(${JSON.stringify(`${JSON.stringify(successFixture)}\n`)})
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_ZCODE_CLI_BIN
    process.env.OC_ZCODE_CLI_BIN = fake
    try {
      const adapter = new ZcodeAdapter({ ...createOpts(dir), resumeSessionId: undefined })
      adapter.on('error', () => {})
      const run1 = adapter.submitTurn({
        input: 'round-1',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run1.submitted
      const s1 = await run1.summary
      assert.equal(s1?.isError, false)
      assert.equal(adapter.nativeSessionId, 'sess_live_fixture_001')
      const run2 = adapter.submitTurn({
        input: 'round-2',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 1 },
        toolUseIdToName: new Map(),
      })
      await run2.submitted
      const s2 = await run2.summary
      assert.equal(s2?.isError, false)
      assert.equal(s2?.staleResumeId, false)
      const spawned = JSON.parse(await readFile(captures, 'utf8')) as string[][]
      assert.equal(spawned[0]?.includes('--resume'), false)
      assert.equal(spawned[1]?.[spawned[1].indexOf('--resume') + 1], 'sess_live_fixture_001')
    } finally {
      restoreEnv('OC_ZCODE_CLI_BIN', previousBin)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
