/**
 * Official Grok headless adapter contract without network credentials.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/grokAdapter.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { describe, test } from 'node:test'

import type { OpenClaudeConfig } from '@openclaude/storage'
import { GrokAdapter, readLatestGrokNativeHandoff } from '../engine/grokAdapter.js'
import type { EngineBillingEvent, EngineEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const TOKEN = 'a'.repeat(64)
const REQUEST_ID = 'b'.repeat(32)
const TURN_KEY = 'c'.repeat(64)

function config(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'grok-build' },
  } as unknown as OpenClaudeConfig
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

function createOpts(cwd: string): EngineCreateOpts {
  return {
    sessionKey: 'agent:main:webchat:dm:grok-test',
    agentId: 'main',
    agentBaseDir: cwd,
    config: config(),
    model: 'grok-build',
    effortLevel: 'high',
    resumeSessionId: 'prior-session',
  } as EngineCreateOpts
}

describe('GrokAdapter', () => {
  test('runs official grok-build headless stream through an opaque route and reports exact cumulative usage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-grok-adapter-'))
    const fake = path.join(dir, 'fake-grok.cjs')
    const capture = path.join(dir, 'capture.json')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.FAKE_GROK_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), env: {
  XAI_API_KEY: process.env.XAI_API_KEY,
  GROK_XAI_API_BASE_URL: process.env.GROK_XAI_API_BASE_URL,
  GROK_CLI_CHAT_PROXY_BASE_URL: process.env.GROK_CLI_CHAT_PROXY_BASE_URL,
  GROK_MODELS_BASE_URL: process.env.GROK_MODELS_BASE_URL,
  GROK_MODELS_LIST_URL: process.env.GROK_MODELS_LIST_URL,
  GROK_HOME: process.env.GROK_HOME,
  OPENCLAUDE_ENGINE: process.env.OPENCLAUDE_ENGINE,
  PATH: process.env.PATH,
  OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  OPENCLAUDE_GATEWAY_TOKEN: process.env.OPENCLAUDE_GATEWAY_TOKEN,
} }))
for (const event of [
  { type: 'thought', data: 'checking' },
  { type: 'text', data: 'before ' },
  { type: 'tool_call', toolCallId: 'tool-1', toolName: 'read_file', status: 'in_progress', rawInput: { path: 'a.ts' } },
  { type: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: { lines: 42 } },
  { type: 'text', data: 'done' },
  { type: 'usage', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 1 } },
  { type: 'end', stopReason: 'end_turn', sessionId: 'next-session', num_turns: 2, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 2, reasoning_tokens: 3, total_tokens: 37 } },
]) console.log(JSON.stringify(event))
`)
    await chmod(fake, 0o755)

    const previousBin = process.env.OC_GROK_CLI_BIN
    const previousHome = process.env.OPENCLAUDE_HOME
    const previousCapture = process.env.FAKE_GROK_CAPTURE
    const previousContainerToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    process.env.OC_GROK_CLI_BIN = fake
    process.env.OPENCLAUDE_HOME = path.join(dir, 'openclaude-home')
    process.env.FAKE_GROK_CAPTURE = capture
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'must-not-leak'
    try {
      const adapter = new GrokAdapter(createOpts(dir))
      const baseUrl = `http://127.0.0.1:18789/internal/v5/grok-relay/route/${TOKEN}/v1`
      adapter.setGrokRoute({ baseUrl, routeToken: TOKEN })
      const events: EngineEvent[] = []
      const billings: EngineBillingEvent[] = []
      adapter.on('billing', (event: EngineBillingEvent) => billings.push(event))
      adapter.on('error', () => {})
      const totals = { totalCostUSD: 0, turns: 0 }
      const run = adapter.submitTurn({
        input: 'fix it',
        requestId: REQUEST_ID,
        turnKey: TURN_KEY,
        assistantMessageId: 'asst-1',
        thinkingMessageId: 'think-1',
        onEvent: (event) => events.push(event),
        sessionTotals: totals,
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.ok(summary)
      assert.equal(summary.assistantText, 'before done')
      assert.equal(summary.thinkingText, 'checking')
      assert.deepEqual(summary.assistantSegments.map((segment) => segment.text), ['before ', 'done'])
      const textIds = events
        .filter((event) => event.kind === 'block' && event.block.kind === 'text')
        .map((event) => (event.kind === 'block' ? event.block.messageId : undefined))
      const thinkIds = events
        .filter((event) => event.kind === 'block' && event.block.kind === 'thinking')
        .map((event) => (event.kind === 'block' ? event.block.messageId : undefined))
      assert.deepEqual(textIds, ['asst-1-s0', 'asst-1-s1'])
      assert.deepEqual(thinkIds, ['think-1-s0'])
      assert.equal(summary.numTurns, 2)
      assert.deepEqual(summary.usage, {
        cost: 0,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheCreationTokens: 2,
        totalTokens: 37,
      })
      assert.equal(summary.tools[0]?.toolName, 'Read')
      assert.equal(summary.tools[0]?.output, '{"lines":42}')
      assert.equal(summary.tools[0]?.completed, true)
      assert.equal(
        (summary.tools[0]?.inputJson as { file_path?: string } | null)?.file_path,
        'a.ts',
      )
      assert.equal(adapter.nativeSessionId, 'next-session')
      assert.equal(totals.turns, 1)
      assert.ok(events.some((event) => event.kind === 'final' && event.meta?.cacheCreationTokens === 2))
      assert.deepEqual(billings.map((event) => ({ requestId: event.requestId, turnKey: event.turnKey, status: event.status, usage: event.usage })), [{
        requestId: REQUEST_ID,
        turnKey: TURN_KEY,
        status: 'success',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 2,
          reasoning_output_tokens: 3,
        },
      }])

      const captured = JSON.parse(await readFile(capture, 'utf8')) as { argv: string[]; env: Record<string, string> }
      assert.deepEqual(captured.argv.slice(0, 4), ['--agent', 'grok-build', '--model', 'grok-4.6'])
      const prompt = captured.argv[captured.argv.indexOf('-p') + 1]
      assert.match(prompt, /OpenClaude Platform Context \(Grok adapter\)/)
      assert.match(prompt, /fix it/)
      assert.ok(captured.argv.includes('--resume'))
      assert.equal(captured.argv[captured.argv.indexOf('--resume') + 1], 'prior-session')
      assert.equal(captured.argv[captured.argv.indexOf('--reasoning-effort') + 1], 'high')
      assert.equal(captured.env.XAI_API_KEY, TOKEN)
      assert.equal(captured.env.GROK_XAI_API_BASE_URL, baseUrl)
      assert.equal(captured.env.GROK_CLI_CHAT_PROXY_BASE_URL, baseUrl)
      assert.equal(captured.env.GROK_MODELS_BASE_URL, baseUrl)
      assert.equal(captured.env.GROK_MODELS_LIST_URL, `${baseUrl}/models`)
      assert.equal(captured.env.GROK_HOME, path.join(process.env.OPENCLAUDE_HOME!, 'grok-build'))
      assert.equal(captured.env.OPENCLAUDE_ENGINE, 'grok')
      assert.equal(captured.env.PATH, '/run/oc/platform/current/bin:/usr/local/bin:/usr/bin:/bin')
      assert.equal(captured.env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      assert.equal(captured.env.HTTPS_PROXY, undefined)
      const managedConfig = await readFile(path.join(captured.env.GROK_HOME, 'config.toml'), 'utf8')
      assert.match(managedConfig, /\[shell_environment_policy\]/)
      assert.match(managedConfig, /exclude = \["XAI_\*", "GROK_\*"\]/)
      assert.equal(managedConfig.includes('mcp_servers'), false)
    } finally {
      if (previousBin === undefined) delete process.env.OC_GROK_CLI_BIN; else process.env.OC_GROK_CLI_BIN = previousBin
      if (previousHome === undefined) delete process.env.OPENCLAUDE_HOME; else process.env.OPENCLAUDE_HOME = previousHome
      if (previousCapture === undefined) delete process.env.FAKE_GROK_CAPTURE; else process.env.FAKE_GROK_CAPTURE = previousCapture
      if (previousContainerToken === undefined) delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN; else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = previousContainerToken
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fails closed before spawn when the master-owned route is missing', async () => {
    const adapter = new GrokAdapter(createOpts(tmpdir()))
    adapter.on('error', () => {})
    const run = adapter.submitTurn({
      input: 'must not run',
      requestId: REQUEST_ID,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await assert.rejects(run.submitted, /GROK_ROUTE_REQUIRED/)
    assert.equal(await run.summary, null)
  })

  test('normalizes the official cancelled end event into an interrupted error billing result', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-grok-cancel-'))
    const fake = path.join(dir, 'fake-grok-cancel.cjs')
    const ready = path.join(dir, 'ready')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const hold = setInterval(() => {}, 1000)
process.on('SIGINT', () => {
  fs.writeSync(1, JSON.stringify({ type: 'end', stopReason: 'cancelled', sessionId: 'cancelled-session', num_turns: 1, usage: { input_tokens: 9, output_tokens: 1 } }) + '\\n')
  clearInterval(hold)
})
fs.writeFileSync(process.env.FAKE_GROK_READY, 'ready')
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_GROK_CLI_BIN
    const previousReady = process.env.FAKE_GROK_READY
    process.env.OC_GROK_CLI_BIN = fake
    process.env.FAKE_GROK_READY = ready
    try {
      const adapter = new GrokAdapter(createOpts(dir))
      adapter.setGrokRoute({
        baseUrl: `http://127.0.0.1:18789/internal/v5/grok-relay/route/${TOKEN}/v1`,
        routeToken: TOKEN,
      })
      const billings: EngineBillingEvent[] = []
      adapter.on('billing', (event: EngineBillingEvent) => billings.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'stop me',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      while (true) {
        try { await readFile(ready); break } catch { await new Promise<void>((resolve) => setTimeout(resolve, 10)) }
      }
      assert.equal(adapter.interrupt(), true)
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(summary?.stopReason, 'interrupted')
      assert.equal(summary?.isError, true)
      assert.equal(summary?.errorDetail, 'Grok turn cancelled')
      const billing = billings[0]
      assert.ok(billing)
      assert.equal(billing.status, 'error')
      assert.equal(billing.terminalCode, 'USER_CANCELLED')
      assert.equal(billing.usage?.input_tokens, 9)
    } finally {
      if (previousBin === undefined) delete process.env.OC_GROK_CLI_BIN; else process.env.OC_GROK_CLI_BIN = previousBin
      if (previousReady === undefined) delete process.env.FAKE_GROK_READY; else process.env.FAKE_GROK_READY = previousReady
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A tool child that escapes the CLI's process group keeps this turn's stdout
  // open, so 'close' never fires. Shutdown used to await that barrier forever,
  // leaving the turn without a terminal state and the client stuck in
  // "stopping".
  test('shutdown gives up on a descendant that keeps stdout open', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-grok-escaped-'))
    const fake = path.join(dir, 'fake-grok-escaped.cjs')
    const escapedPidFile = path.join(dir, 'escaped.pid')
    await writeFile(fake, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
  { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
escaped.unref()
fs.writeFileSync(process.env.FAKE_GROK_ESCAPED_PID, String(escaped.pid))
setInterval(() => {}, 1000)
`)
    await chmod(fake, 0o755)
    const previousBin = process.env.OC_GROK_CLI_BIN
    const previousPidFile = process.env.FAKE_GROK_ESCAPED_PID
    const previousGrace = process.env.OPENCLAUDE_GROK_SHUTDOWN_GRACE_MS
    const previousFinal = process.env.OPENCLAUDE_GROK_SHUTDOWN_FINAL_DRAIN_MS
    process.env.OC_GROK_CLI_BIN = fake
    process.env.FAKE_GROK_ESCAPED_PID = escapedPidFile
    process.env.OPENCLAUDE_GROK_SHUTDOWN_GRACE_MS = '150'
    process.env.OPENCLAUDE_GROK_SHUTDOWN_FINAL_DRAIN_MS = '150'
    let escapedPid: number | undefined
    try {
      const adapter = new GrokAdapter(createOpts(dir))
      adapter.setGrokRoute({
        baseUrl: `http://127.0.0.1:18789/internal/v5/grok-relay/route/${TOKEN}/v1`,
        routeToken: TOKEN,
      })
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'turn that escapes its process group',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      for (let i = 0; i < 200 && escapedPid === undefined; i += 1) {
        try {
          escapedPid = Number.parseInt(await readFile(escapedPidFile, 'utf8'), 10)
        } catch {
          await new Promise<void>((ready) => setTimeout(ready, 25))
        }
      }
      assert.ok(escapedPid, 'the fake CLI never spawned its escaped descendant')

      adapter.interrupt()
      const started = Date.now()
      await adapter.shutdown()
      await adapter.waitForOutputDrain()
      const elapsed = Date.now() - started
      assert.ok(elapsed < 10_000, `shutdown must be bounded, took ${elapsed}ms`)
      assert.equal(adapter.isRunning, false)
      assert.equal(process.kill(escapedPid, 0), true)
    } finally {
      if (escapedPid) {
        try { process.kill(escapedPid, 'SIGKILL') } catch { /* already reaped */ }
      }
      restoreEnv('OC_GROK_CLI_BIN', previousBin)
      restoreEnv('FAKE_GROK_ESCAPED_PID', previousPidFile)
      restoreEnv('OPENCLAUDE_GROK_SHUTDOWN_GRACE_MS', previousGrace)
      restoreEnv('OPENCLAUDE_GROK_SHUTDOWN_FINAL_DRAIN_MS', previousFinal)
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Giving up on a process hands it to the OS but keeps the adapter alive for
  // the next turn. The abandoned turn's 'close' can then fire hours later,
  // when the barrier it would resolve and the `active` context it would clear
  // belong to a live turn — freezing that turn's transcript mid-stream.
  test('a late close from an abandoned turn cannot settle the next one', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-grok-late-close-'))
    const escaping = path.join(dir, 'fake-grok-escaping.cjs')
    const surviving = path.join(dir, 'fake-grok-surviving.cjs')
    const escapedPidFile = path.join(dir, 'escaped.pid')
    await writeFile(escaping, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
  { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
escaped.unref()
fs.writeFileSync(process.env.FAKE_GROK_ESCAPED_PID, String(escaped.pid))
setInterval(() => {}, 1000)
`)
    await writeFile(surviving, `#!/usr/bin/env node
setInterval(() => {}, 1000)
`)
    await chmod(escaping, 0o755)
    await chmod(surviving, 0o755)
    const previousBin = process.env.OC_GROK_CLI_BIN
    const previousPidFile = process.env.FAKE_GROK_ESCAPED_PID
    const previousGrace = process.env.OPENCLAUDE_GROK_SHUTDOWN_GRACE_MS
    const previousFinal = process.env.OPENCLAUDE_GROK_SHUTDOWN_FINAL_DRAIN_MS
    process.env.FAKE_GROK_ESCAPED_PID = escapedPidFile
    process.env.OPENCLAUDE_GROK_SHUTDOWN_GRACE_MS = '150'
    process.env.OPENCLAUDE_GROK_SHUTDOWN_FINAL_DRAIN_MS = '150'
    const adapter = new GrokAdapter(createOpts(dir))
    adapter.setGrokRoute({
      baseUrl: `http://127.0.0.1:18789/internal/v5/grok-relay/route/${TOKEN}/v1`,
      routeToken: TOKEN,
    })
    adapter.on('error', () => {})
    let escapedPid: number | undefined
    try {
      process.env.OC_GROK_CLI_BIN = escaping
      const abandoned = adapter.submitTurn({
        input: 'turn whose descendant never lets go of stdout',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await abandoned.submitted
      for (let i = 0; i < 200 && escapedPid === undefined; i += 1) {
        try {
          escapedPid = Number.parseInt(await readFile(escapedPidFile, 'utf8'), 10)
        } catch {
          await new Promise<void>((ready) => setTimeout(ready, 25))
        }
      }
      assert.ok(escapedPid, 'the fake CLI never spawned its escaped descendant')
      adapter.interrupt()
      await adapter.shutdown()

      process.env.OC_GROK_CLI_BIN = surviving
      const live = adapter.submitTurn({
        input: 'the turn that must not be settled by its predecessor',
        requestId: REQUEST_ID,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await live.submitted

      // Whatever the abandoned CLI was still holding is released now.
      process.kill(escapedPid, 'SIGKILL')
      escapedPid = undefined

      const stillOpen = Symbol('still-open')
      const settled: unknown = await Promise.race([
        adapter.waitForOutputDrain().then(() => 'drained'),
        new Promise((late) => setTimeout(() => late(stillOpen), 500)),
      ])
      assert.equal(settled, stillOpen, 'the abandoned turn resolved the live turn\'s close barrier')
      assert.equal(adapter.isRunning, true)
      assert.equal(live.finalized, false)
      live.end()
    } finally {
      if (escapedPid) {
        try { process.kill(escapedPid, 'SIGKILL') } catch { /* already reaped */ }
      }
      await adapter.shutdown().catch(() => {})
      restoreEnv('OC_GROK_CLI_BIN', previousBin)
      restoreEnv('FAKE_GROK_ESCAPED_PID', previousPidFile)
      restoreEnv('OPENCLAUDE_GROK_SHUTDOWN_GRACE_MS', previousGrace)
      restoreEnv('OPENCLAUDE_GROK_SHUTDOWN_FINAL_DRAIN_MS', previousFinal)
      await rm(dir, { recursive: true, force: true })
    }
  })
})


test('projects openclaude-memory into GROK_HOME when a gateway token is present', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oc-grok-mcp-'))
  const fake = path.join(dir, 'fake-grok.cjs')
  const capture = path.join(dir, 'capture.json')
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.FAKE_GROK_CAPTURE, JSON.stringify({ argv: process.argv.slice(2) }))
console.log(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 } }))
`)
  await chmod(fake, 0o755)
  const previousBin = process.env.OC_GROK_CLI_BIN
  const previousHome = process.env.OPENCLAUDE_HOME
  const previousCapture = process.env.FAKE_GROK_CAPTURE
  process.env.OC_GROK_CLI_BIN = fake
  process.env.OPENCLAUDE_HOME = path.join(dir, 'openclaude-home')
  process.env.FAKE_GROK_CAPTURE = capture
  try {
    const opts = createOpts(dir)
    opts.config = {
      ...opts.config,
      gateway: { ...opts.config.gateway, port: 18790, accessToken: 'bearer-must-not-enter-argv' },
    }
    const adapter = new GrokAdapter(opts)
    adapter.setGrokRoute({
      baseUrl: `http://127.0.0.1:18790/internal/v5/grok-relay/route/${TOKEN}/v1`,
      routeToken: TOKEN,
    })
    adapter.on('error', () => {})
    const run = adapter.submitTurn({
      input: 'use memory',
      requestId: REQUEST_ID,
      turnKey: TURN_KEY,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await run.submitted
    await run.summary
    const captured = JSON.parse(await readFile(capture, 'utf8')) as { argv: string[] }
    const prompt = captured.argv[captured.argv.indexOf('-p') + 1]
    assert.match(prompt, /use memory/)
    assert.equal(prompt.includes('bearer-must-not-enter-argv'), false)
    assert.equal(JSON.stringify(captured.argv).includes('bearer-must-not-enter-argv'), false)
    const managedConfig = await readFile(path.join(process.env.OPENCLAUDE_HOME!, 'grok-build', 'config.toml'), 'utf8')
    assert.match(managedConfig, /\[mcp_servers\."openclaude-memory"\]/)
    assert.equal(managedConfig.includes('bearer-must-not-enter-argv'), false)
    assert.equal(
      await readFile(path.join(process.env.OPENCLAUDE_HOME!, 'grok-build', 'gateway-token'), 'utf8'),
      'bearer-must-not-enter-argv',
    )
  } finally {
    restoreEnv('OC_GROK_CLI_BIN', previousBin)
    restoreEnv('OPENCLAUDE_HOME', previousHome)
    restoreEnv('FAKE_GROK_CAPTURE', previousCapture)
    await rm(dir, { recursive: true, force: true })
  }
})

test('reads the cleaned native Grok summary carrier from the new checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-handoff-'))
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const dir = join(root, 'sessions', 'workspace', sessionId, 'compaction_checkpoints')
  await mkdir(dir, { recursive: true })
  const started = Date.now()
  await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({
    schema_version: 1,
    compacted_history: [
      { type: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: stale' }] },
      { type: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: native grok' }], synthetic_reason: 'compaction_meta' },
    ],
  }))
  try {
    assert.deepEqual(await readLatestGrokNativeHandoff(root, sessionId, started), {
      summaryText: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: native grok',
      source: 'grok',
      compactStartedAt: started,
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})
