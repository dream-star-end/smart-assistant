/**
 * Failed tool-call reporter tests.
 * Run: npx tsx --test packages/gateway/src/__tests__/v3ToolFailureReporter.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import type { ToolCalledEvent } from '@openclaude/protocol'

import {
  TOOL_FAILURE_AUDIT_PATH,
  ToolFailureReportError,
  buildToolFailureReportPayload,
  isToolFailureAuditEnabled,
  makeToolFailureReporter,
  readToolFailureReportConfig,
  sendToolFailureReport,
  startToolFailureReporter,
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
  test('explicit switch requires OC_TOOL_FAILURE_AUDIT to be exactly "1"', () => {
    assert.equal(isToolFailureAuditEnabled({}), false)
    assert.equal(isToolFailureAuditEnabled({ OC_TOOL_FAILURE_AUDIT: '0' }), false)
    assert.equal(isToolFailureAuditEnabled({ OC_TOOL_FAILURE_AUDIT: 'true' }), false)
    assert.equal(isToolFailureAuditEnabled({ OC_TOOL_FAILURE_AUDIT: '1' }), true)
  })

  test('reads config only with explicit switch plus master base and token', () => {
    assert.equal(readToolFailureReportConfig({}), null)
    assert.equal(
      readToolFailureReportConfig({
        OC_TOOL_FAILURE_AUDIT: '1',
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m',
      }),
      null,
    )
    // 容器必备 env 齐全但没显式开关 → 必须视为未配置(隐私红线:不允许事实恒开)
    assert.equal(
      readToolFailureReportConfig({
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
      }),
      null,
    )
    assert.deepEqual(
      readToolFailureReportConfig({
        OC_TOOL_FAILURE_AUDIT: '1',
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m///',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
      }),
      { masterBaseUrl: 'http://m', containerToken: 'tok' },
    )
  })

  test('startToolFailureReporter is a no-op without OC_TOOL_FAILURE_AUDIT=1', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-tool-failure-'))
    const saved = {
      OC_TOOL_FAILURE_AUDIT: process.env.OC_TOOL_FAILURE_AUDIT,
      OPENCLAUDE_V3_MASTER_BASE_URL: process.env.OPENCLAUDE_V3_MASTER_BASE_URL,
      OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    try {
      process.env.OPENCLAUDE_HOME = tmp
      process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://master'
      process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'tok'
      delete process.env.OC_TOOL_FAILURE_AUDIT
      assert.equal(startToolFailureReporter(), null)

      process.env.OC_TOOL_FAILURE_AUDIT = '1'
      const reporter = startToolFailureReporter()
      assert.notEqual(reporter, null)
      reporter!.stop()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
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

  test('enqueue enforces queue cap by dropping oldest entries', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-tool-failure-'))
    let listener: ((ev: ToolCalledEvent) => void) | null = null
    const bus = {
      on(_event: string, cb: (ev: ToolCalledEvent) => void) { listener = cb },
      off() { listener = null },
    }
    // 单调递增 fake now:保证队列文件名(时间戳前缀)严格有序,"丢最旧"可确定性断言;
    // 503 → retryable,条目留在队列(退避期内不重发),便于观察上限行为。
    let t = 1_000_000
    const reporter = makeToolFailureReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir: tmp,
      eventBus: bus as any,
      drainIntervalMs: 60_000,
      maxQueueEntries: 3,
      now: () => (t += 1),
      fetchImpl: async () => new Response('{}', { status: 503 }),
    })
    reporter.start()
    for (let i = 0; i < 6; i += 1) listener!(toolEvent({ id: `evt-${i}` }))
    // enqueue 是串行异步链:以"最后一条 evt-5 已落盘"为收敛信号轮询,
    // 避免中途(evt-2 刚写完时)恰好观察到 3 个文件而提前断言。
    const survivingEventIds = async (): Promise<string[]> => {
      const files = (await readdir(tmp!)).filter((f) => f.endsWith('.json')).sort()
      const ids: string[] = []
      for (const f of files) {
        try {
          ids.push(JSON.parse(await readFile(join(tmp!, f), 'utf8')).payload.eventId as string)
        } catch {
          // 与并发 drain/overflow unlink 竞态的瞬时 ENOENT,忽略即可
        }
      }
      return ids
    }
    let eventIds: string[] = []
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      eventIds = await survivingEventIds()
      if (eventIds.includes('evt-5') && eventIds.length === 3) break
    }
    // 最旧的 evt-0..2 被丢弃,存活的必须是最新 3 条
    assert.deepEqual(eventIds, ['evt-3', 'evt-4', 'evt-5'])
    reporter.stop()
  })
})
