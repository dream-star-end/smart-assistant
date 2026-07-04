/**
 * Failed tool-call reporter tests.
 * Run: npx tsx --test packages/gateway/src/__tests__/v3ToolFailureReporter.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import type { ToolCalledEvent } from '@openclaude/protocol'

import {
  TOOL_FAILURE_AUDIT_PATH,
  ToolFailureReportError,
  buildToolFailureReportPayload,
  makeToolFailureReporter,
  readToolFailureReportConfig,
  sendToolFailureReport,
} from '../v3ToolFailureReporter.js'

let tmp: string | null = null
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

function toolEvent(overrides: Partial<ToolCalledEvent> = {}): ToolCalledEvent {
  return {
    id: 'evt-1',
    type: 'tool.called',
    timestamp: 123,
    schemaVersion: 1,
    agentId: 'codex',
    sessionKey: 'agent:codex:webchat:dm:sess1',
    turnIndex: 2,
    toolName: 'Bash',
    durationMs: 17,
    isError: true,
    inputPreview: 'Authorization: Bearer secret-token',
    outputPreview: 'failed with oc-v3.7.' + 'a'.repeat(64),
    ...overrides,
  } as ToolCalledEvent
}

describe('v3ToolFailureReporter', () => {
  test('reads config only with master base and token', () => {
    assert.equal(readToolFailureReportConfig({}), null)
    assert.equal(readToolFailureReportConfig({ OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m' }), null)
    assert.deepEqual(
      readToolFailureReportConfig({
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m///',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
      }),
      { masterBaseUrl: 'http://m', containerToken: 'tok' },
    )
  })

  test('builds only failed events and scrubs obvious secrets', () => {
    assert.equal(buildToolFailureReportPayload(toolEvent({ isError: false })), null)
    const payload = buildToolFailureReportPayload(toolEvent())!
    assert.equal(payload.eventId, 'evt-1')
    assert.equal(payload.toolName, 'Bash')
    assert.equal(payload.inputPreview, 'Authorization: Bearer [redacted]')
    assert.equal(payload.outputPreview, 'failed with [redacted-container-token]')
  })

  test('sender posts to master endpoint with container bearer and classifies failures', async () => {
    const payload = buildToolFailureReportPayload(toolEvent())!
    let seenUrl = ''
    let seenAuth = ''
    await sendToolFailureReport(payload, { masterBaseUrl: 'http://master', containerToken: 'tok' }, {
      fetchImpl: async (input, init) => {
        seenUrl = String(input)
        seenAuth = new Headers(init.headers).get('authorization') ?? ''
        return new Response('{}', { status: 200 })
      },
    })
    assert.equal(seenUrl, `http://master${TOOL_FAILURE_AUDIT_PATH}`)
    assert.equal(seenAuth, 'Bearer tok')

    await assert.rejects(
      () => sendToolFailureReport(payload, { masterBaseUrl: 'http://master', containerToken: 'tok' }, {
        fetchImpl: async () => new Response('{}', { status: 400 }),
      }),
      (err) => err instanceof ToolFailureReportError && err.retryable === false,
    )
    await assert.rejects(
      () => sendToolFailureReport(payload, { masterBaseUrl: 'http://master', containerToken: 'tok' }, {
        fetchImpl: async () => new Response('{}', { status: 503 }),
      }),
      (err) => err instanceof ToolFailureReportError && err.retryable === true,
    )
  })

  test('reporter subscribes to failed tool events and drains durable queue', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-tool-failure-'))
    let listener: ((ev: ToolCalledEvent) => void) | null = null
    const bus = {
      on(_event: string, cb: (ev: ToolCalledEvent) => void) { listener = cb },
      off() { listener = null },
    }
    let sent = 0
    const reporter = makeToolFailureReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir: tmp,
      eventBus: bus as any,
      drainIntervalMs: 60_000,
      fetchImpl: async () => {
        sent += 1
        return new Response('{}', { status: 200 })
      },
    })
    reporter.start()
    listener!(toolEvent())
    for (let i = 0; i < 20 && sent === 0; i += 1) await new Promise((r) => setTimeout(r, 20))
    assert.equal(sent, 1)
    assert.equal(await reporter.pendingCount(), 0)
    reporter.stop()
  })
})
