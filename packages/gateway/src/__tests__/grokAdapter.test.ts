/**
 * Official Grok headless adapter contract without network credentials.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/grokAdapter.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import type { OpenClaudeConfig } from '@openclaude/storage'
import { GrokAdapter } from '../engine/grokAdapter.js'
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
  OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
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
      assert.equal(summary.numTurns, 2)
      assert.deepEqual(summary.usage, {
        cost: 0,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheCreationTokens: 2,
        totalTokens: 37,
      })
      assert.equal(summary.tools[0]?.toolName, 'read_file')
      assert.equal(summary.tools[0]?.output, '{"lines":42}')
      assert.equal(summary.tools[0]?.completed, true)
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
      assert.ok(captured.argv.includes('--resume'))
      assert.equal(captured.argv[captured.argv.indexOf('--resume') + 1], 'prior-session')
      assert.equal(captured.argv[captured.argv.indexOf('--reasoning-effort') + 1], 'high')
      assert.equal(captured.env.XAI_API_KEY, TOKEN)
      assert.equal(captured.env.GROK_XAI_API_BASE_URL, baseUrl)
      assert.equal(captured.env.GROK_CLI_CHAT_PROXY_BASE_URL, baseUrl)
      assert.equal(captured.env.GROK_MODELS_BASE_URL, baseUrl)
      assert.equal(captured.env.GROK_MODELS_LIST_URL, `${baseUrl}/models`)
      assert.equal(captured.env.GROK_HOME, path.join(process.env.OPENCLAUDE_HOME!, 'grok-build'))
      assert.equal(captured.env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      assert.equal(captured.env.HTTPS_PROXY, undefined)
      const managedConfig = await readFile(path.join(captured.env.GROK_HOME, 'config.toml'), 'utf8')
      assert.match(managedConfig, /\[shell_environment_policy\]/)
      assert.match(managedConfig, /exclude = \["XAI_\*", "GROK_\*"\]/)
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
})
