/**
 * Experimental community ZCode CLI adapter — official 0.16.3 contract,
 * no network credentials.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/zcodeAdapter.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ZCODE_HOSTED_PERMISSION_MODE } from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { readFileSync } from 'node:fs'
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
})
