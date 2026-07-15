/**
 * Failed tool-call reporter tests.
 * Run: npx tsx --test packages/gateway/src/__tests__/v3ToolFailureReporter.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import type { ToolCalledEvent } from '@openclaude/protocol'

import {
  TOOL_AUDIT_SCHEMA_HEADER,
  TOOL_CALL_ROLLUP_PATH,
  TOOL_FAILURE_AUDIT_PATH,
  ToolFailureReportError,
  type ToolCallRollupPayload,
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
    outputPreview: `failed with oc-v3.7.${'a'.repeat(64)}`,
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
      Reflect.deleteProperty(process.env, 'OC_TOOL_FAILURE_AUDIT')
      assert.equal(startToolFailureReporter(), null)

      process.env.OC_TOOL_FAILURE_AUDIT = '1'
      const reporter = startToolFailureReporter()
      assert.notEqual(reporter, null)
      reporter!.stop()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = v
      }
    }
  })

  test('builds only failed events and emits hashes/categories without raw previews', () => {
    assert.equal(buildToolFailureReportPayload(toolEvent({ isError: false })), null)
    const payload = buildToolFailureReportPayload(toolEvent())!
    const rawInput = 'Authorization: Bearer secret-token'
    const rawOutput = `failed with oc-v3.7.${'a'.repeat(64)}`
    assert.equal(payload.eventId, 'evt-1')
    assert.equal(payload.toolName, 'Bash')
    assert.equal(payload.schemaVersion, 3)
    assert.equal(payload.inputHash, createHash('sha256').update(rawInput).digest('hex'))
    assert.equal(payload.outputHash, createHash('sha256').update(rawOutput).digest('hex'))
    assert.equal(payload.errorClass, 'other')
    assert.equal(payload.failureKind, 'unknown')
    assert.equal('inputPreview' in payload, false)
    assert.equal('outputPreview' in payload, false)
  })

  test('structured exit metadata takes priority and is the only persisted process detail', () => {
    const payload = buildToolFailureReportPayload(
      toolEvent({
        exitCode: 127,
        terminationReason: 'exit_code',
        outputPreview: 'opaque',
      }),
    )!
    assert.equal(payload.errorClass, 'command_not_found')
    assert.equal(payload.failureKind, 'process_exit')
    assert.equal(payload.exitCode, 127)
    assert.equal(payload.terminationReason, 'exit_code')
    assert.equal(JSON.stringify(payload).includes('secret-token'), false)
  })

  test('sender posts to master endpoint with container bearer and classifies failures', async () => {
    const payload = buildToolFailureReportPayload(toolEvent())!
    let seenUrl = ''
    let seenAuth = ''
    let seenBody = ''
    await sendToolFailureReport(
      payload,
      { masterBaseUrl: 'http://master', containerToken: 'tok' },
      {
        fetchImpl: async (input, init) => {
          seenUrl = String(input)
          seenAuth = new Headers(init.headers).get('authorization') ?? ''
          seenBody = String(init.body ?? '')
          return new Response('{}', { status: 200 })
        },
      },
    )
    assert.equal(seenUrl, `http://master${TOOL_FAILURE_AUDIT_PATH}`)
    assert.equal(seenAuth, 'Bearer tok')
    assert.equal(seenBody.includes('secret-token'), false)
    assert.equal(seenBody.includes('oc-v3.7.'), false)

    await assert.rejects(
      () =>
        sendToolFailureReport(
          payload,
          { masterBaseUrl: 'http://master', containerToken: 'tok' },
          {
            fetchImpl: async () => new Response('{}', { status: 400 }),
          },
        ),
      (err) => err instanceof ToolFailureReportError && err.retryable === false,
    )
    await assert.rejects(
      () =>
        sendToolFailureReport(
          payload,
          { masterBaseUrl: 'http://master', containerToken: 'tok' },
          {
            fetchImpl: async () => new Response('{}', { status: 503 }),
          },
        ),
      (err) => err instanceof ToolFailureReportError && err.retryable === true,
    )
  })

  test('schema-v3 falls back only when a 400 lacks the new-master schema header', async () => {
    const payload = buildToolFailureReportPayload(
      toolEvent({
        exitCode: 2,
        terminationReason: 'exit_code',
      }),
    )!
    const bodies: any[] = []
    await sendToolFailureReport(
      payload,
      { masterBaseUrl: 'http://master', containerToken: 'tok' },
      {
        fetchImpl: async (_input, init) => {
          bodies.push(JSON.parse(String(init.body)))
          return bodies.length === 1
            ? new Response(JSON.stringify({ error: { code: 'INVALID_BODY' } }), { status: 400 })
            : new Response('{}', { status: 200 })
        },
      },
    )
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0].schemaVersion, 3)
    assert.equal(bodies[1].schemaVersion, 2)
    assert.equal(bodies[1].errorClass, 'other')
    assert.equal('failureKind' in bodies[1], false)

    let calls = 0
    await assert.rejects(
      () =>
        sendToolFailureReport(
          payload,
          { masterBaseUrl: 'http://master', containerToken: 'tok' },
          {
            fetchImpl: async () => {
              calls += 1
              return new Response('{}', {
                status: 400,
                headers: { [TOOL_AUDIT_SCHEMA_HEADER]: '3' },
              })
            },
          },
        ),
      (err) => err instanceof ToolFailureReportError && err.retryable === false,
    )
    assert.equal(calls, 1)
  })

  test('reporter subscribes to failed tool events and drains durable queue', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-tool-failure-'))
    let listener: ((ev: ToolCalledEvent) => void) | null = null
    const bus = {
      on(_event: string, cb: (ev: ToolCalledEvent) => void) {
        listener = cb
      },
      off() {
        listener = null
      },
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
      on(_event: string, cb: (ev: ToolCalledEvent) => void) {
        listener = cb
      },
      off() {
        listener = null
      },
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
    await reporter.shutdown()
  })

  test('graceful shutdown fsyncs success/failure rollup and failure rows', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-tool-rollup-'))
    let listener: ((ev: ToolCalledEvent) => void) | null = null
    const bus = {
      on(_event: string, cb: (ev: ToolCalledEvent) => void) {
        listener = cb
      },
      off() {
        listener = null
      },
    }
    const reporter = makeToolFailureReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir: tmp,
      eventBus: bus as any,
      reporterRunId: '1'.repeat(32),
      drainIntervalMs: 60_000,
      rollupIntervalMs: 60_000,
      fetchImpl: async () => new Response('{}', { status: 503 }),
    })
    reporter.start()
    listener!(toolEvent({ id: 'ok-1', isError: false, inputPreview: 'private-success' }))
    listener!(toolEvent({ id: 'fail-1', exitCode: 127, terminationReason: 'exit_code' }))
    await reporter.shutdown()

    const files = (await readdir(tmp)).filter((file) => file.endsWith('.json'))
    const rollupFile = files.find((file) => file.startsWith('rollup-'))
    const failureFile = files.find((file) => file.startsWith('failure-'))
    assert.ok(rollupFile)
    assert.ok(failureFile)
    const rollup = JSON.parse(await readFile(join(tmp, rollupFile), 'utf8')).payload
    assert.equal(rollup.reporterRunId, '1'.repeat(32))
    assert.equal(rollup.sequence, 1)
    assert.deepEqual(
      rollup.counts.map((c: any) => [c.outcome, c.errorClass, c.failureKind, c.count]).sort(),
      [
        ['failure', 'command_not_found', 'process_exit', 1],
        ['success', 'none', 'none', 1],
      ],
    )
    assert.equal(JSON.stringify(rollup).includes('private-success'), false)
  })

  test('flush splits more than 256 dimensions into consecutive durable reports', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-tool-rollup-split-'))
    let listener: ((ev: ToolCalledEvent) => void) | null = null
    const bus = {
      on(_event: string, cb: (ev: ToolCalledEvent) => void) {
        listener = cb
      },
      off() {
        listener = null
      },
    }
    const reporter = makeToolFailureReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir: tmp,
      eventBus: bus as any,
      reporterRunId: '3'.repeat(32),
      drainIntervalMs: 60_000,
      rollupIntervalMs: 60_000,
      fetchImpl: async () => new Response('{}', { status: 503 }),
    })
    reporter.start()
    for (let i = 0; i < 257; i += 1) {
      listener!(toolEvent({ id: `ok-${i}`, toolName: `Tool${i}`, isError: false }))
    }
    await reporter.flushRollup()
    reporter.stop()

    const reports: ToolCallRollupPayload[] = []
    for (const file of (await readdir(tmp)).filter((name) => name.startsWith('rollup-'))) {
      reports.push(JSON.parse(await readFile(join(tmp, file), 'utf8')).payload)
    }
    reports.sort((a, b) => a.sequence - b.sequence)
    assert.deepEqual(
      reports.map((report) => [report.sequence, report.counts.length]),
      [
        [1, 256],
        [2, 1],
      ],
    )
    assert.equal(
      reports.flatMap((report) => report.counts).reduce((sum, count) => sum + count.count, 0),
      257,
    )
    assert.equal(
      new Set(reports.flatMap((report) => report.counts.map((count) => count.toolName))).size,
      257,
    )
  })

  test('flush splits oversized dimension counts without loss or duplicate dimensions per report', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-tool-rollup-count-split-'))
    let listener: ((ev: ToolCalledEvent) => void) | null = null
    const bus = {
      on(_event: string, cb: (ev: ToolCalledEvent) => void) {
        listener = cb
      },
      off() {
        listener = null
      },
    }
    const reporter = makeToolFailureReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir: tmp,
      eventBus: bus as any,
      reporterRunId: '4'.repeat(32),
      maxRollupCount: 2,
      drainIntervalMs: 60_000,
      rollupIntervalMs: 60_000,
      fetchImpl: async () => new Response('{}', { status: 503 }),
    })
    reporter.start()
    for (let i = 0; i < 5; i += 1) {
      listener!(toolEvent({ id: `same-${i}`, toolName: 'SameTool', isError: false }))
    }
    await reporter.flushRollup()
    reporter.stop()

    const reports: ToolCallRollupPayload[] = []
    for (const file of (await readdir(tmp)).filter((name) => name.startsWith('rollup-'))) {
      reports.push(JSON.parse(await readFile(join(tmp, file), 'utf8')).payload)
    }
    reports.sort((a, b) => a.sequence - b.sequence)
    assert.deepEqual(
      reports.map((report) => [report.sequence, report.counts.length, report.counts[0].count]),
      [
        [1, 1, 2],
        [2, 1, 2],
        [3, 1, 1],
      ],
    )
    assert.equal(
      reports.flatMap((report) => report.counts).reduce((sum, count) => sum + count.count, 0),
      5,
    )
  })

  test('failure storms cannot evict rollup batches and old unprefixed queue files still drain', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-tool-isolated-'))
    let listener: ((ev: ToolCalledEvent) => void) | null = null
    const bus = {
      on(_event: string, cb: (ev: ToolCalledEvent) => void) {
        listener = cb
      },
      off() {
        listener = null
      },
    }
    let t = 2_000_000
    const reporter = makeToolFailureReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir: tmp,
      eventBus: bus as any,
      now: () => (t += 1),
      reporterRunId: '2'.repeat(32),
      maxQueueEntries: 3,
      maxRollupQueueEntries: 3,
      drainIntervalMs: 60_000,
      rollupIntervalMs: 60_000,
      fetchImpl: async () => new Response('{}', { status: 503 }),
    })
    reporter.start()
    for (let batch = 0; batch < 3; batch += 1) {
      listener!(toolEvent({ id: `ok-${batch}`, isError: false }))
      await reporter.flushRollup()
    }
    for (let i = 0; i < 10; i += 1) listener!(toolEvent({ id: `storm-${i}` }))
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const failureFiles = (await readdir(tmp)).filter((file) => file.startsWith('failure-'))
      const ids: string[] = []
      for (const file of failureFiles) {
        try {
          ids.push(JSON.parse(await readFile(join(tmp, file), 'utf8')).payload.eventId as string)
        } catch {
          // drain retry can be rewriting metadata; wait for the durable queue to settle
        }
      }
      if (ids.includes('storm-9') && ids.length === 3) break
    }
    // Wait for the serialized enqueue chain before reading queue cardinality.
    // Otherwise the assertion can land in the intentional unlink-oldest →
    // atomic-rename-new gap and observe two files for a few milliseconds.
    await reporter.shutdown()
    const names = (await readdir(tmp)).filter((file) => file.endsWith('.json'))
    assert.equal(names.filter((file) => file.startsWith('rollup-')).length, 3)
    assert.equal(names.filter((file) => file.startsWith('failure-')).length, 3)

    const legacyPayload = buildToolFailureReportPayload(toolEvent({ id: 'legacy' }))!
    await writeFile(
      join(tmp, '1000-legacy.json'),
      JSON.stringify({
        schemaVersion: 1,
        payload: legacyPayload,
        firstSeenAt: t,
        attempts: 0,
      }),
    )
    const seenPaths: string[] = []
    const drainer = makeToolFailureReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir: tmp,
      now: () => (t += 1),
      fetchImpl: async (input) => {
        seenPaths.push(String(input))
        return new Response('{}', { status: 200 })
      },
    })
    await drainer.drainOnce()
    assert.ok(seenPaths.some((path) => path.endsWith(TOOL_FAILURE_AUDIT_PATH)))
    assert.ok(seenPaths.some((path) => path.endsWith(TOOL_CALL_ROLLUP_PATH)))
  })
})
