/**
 * Marketplace skill-usage reporter tests.
 * Run: npx tsx --test packages/gateway/src/__tests__/skillUsageReporter.test.ts
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import type { ToolCalledEvent } from '@openclaude/protocol'

import {
  SKILL_USAGE_PATH,
  SKILL_VIEW_TOOL,
  SkillUsageReportError,
  isSkillUsageEnabled,
  makeSkillUsageReporter,
  normalizeTraceId,
  parseSkillSlug,
  readSkillUsageReportConfig,
  sendSkillUsageReport,
  startSkillUsageReporter,
} from '../skillUsageReporter.js'

const TRACE = 'a'.repeat(32)

let dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** hub 目录带若干技能子目录(= slug 集)。 */
async function makeHub(slugs: string[]): Promise<string> {
  const hub = await tmp('oc-hub-')
  for (const s of slugs) await mkdir(join(hub, s), { recursive: true })
  return hub
}

function skillViewEvent(overrides: Partial<ToolCalledEvent> = {}): ToolCalledEvent {
  return {
    id: 'evt-1',
    type: 'tool.called',
    timestamp: 123,
    schemaVersion: 1,
    agentId: 'main',
    sessionKey: 'agent:main:webchat:dm:sess1',
    turnIndex: 2,
    toolName: SKILL_VIEW_TOOL,
    durationMs: 5,
    isError: false,
    inputPreview: '{"name":"browser"}',
    ...overrides,
  } as ToolCalledEvent
}

/** 可控 eventBus:捕获 tool.called listener 供测试手动触发。 */
function fakeBus() {
  let listener: ((ev: ToolCalledEvent) => void) | null = null
  return {
    bus: {
      on(_e: string, cb: (ev: ToolCalledEvent) => void) {
        listener = cb
      },
      off() {
        listener = null
      },
    },
    emit(ev: ToolCalledEvent) {
      listener?.(ev)
    },
  }
}

describe('skillUsageReporter', () => {
  test('gate is default-on: only explicit "0" disables', () => {
    assert.equal(isSkillUsageEnabled({}), true) // 未设 → 开
    assert.equal(isSkillUsageEnabled({ OC_MARKET_SKILL_USAGE: '1' }), true)
    assert.equal(isSkillUsageEnabled({ OC_MARKET_SKILL_USAGE: 'anything' }), true)
    assert.equal(isSkillUsageEnabled({ OC_MARKET_SKILL_USAGE: '0' }), false) // 显式 0 → 关
  })

  test('readConfig requires gate-on plus master base and token', () => {
    // 默认开:base+token 齐全即成立(与 tool-failure 语义相反)。
    assert.deepEqual(
      readSkillUsageReportConfig({
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m///',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
      }),
      { masterBaseUrl: 'http://m', containerToken: 'tok' },
    )
    // 显式关 → 无条件 null,即使 env 齐全。
    assert.equal(
      readSkillUsageReportConfig({
        OC_MARKET_SKILL_USAGE: '0',
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
      }),
      null,
    )
    // 缺 token → null。
    assert.equal(readSkillUsageReportConfig({ OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m' }), null)
  })

  test('parseSkillSlug reads name from JSON, regex-falls-back on truncation', () => {
    assert.equal(parseSkillSlug('{"name":"browser"}'), 'browser')
    assert.equal(parseSkillSlug('{"name":"web-context","path":"references/x.md"}'), 'web-context')
    // 截断的 JSON(path 值被切断)→ 正则仍能抓到 name。
    assert.equal(parseSkillSlug('{"name":"oc-vision","path":"references/verylongpath-that-is-'), 'oc-vision')
    assert.equal(parseSkillSlug('{"path":"x"}'), null) // 无 name
    assert.equal(parseSkillSlug(''), null)
    assert.equal(parseSkillSlug(undefined), null)
  })

  test('normalizeTraceId only passes valid 32hex, else null (never mints)', () => {
    assert.equal(normalizeTraceId(TRACE), TRACE)
    assert.equal(normalizeTraceId(TRACE.toUpperCase()), null) // 大写不合法
    assert.equal(normalizeTraceId('short'), null)
    assert.equal(normalizeTraceId(undefined), null)
    assert.equal(normalizeTraceId(null), null)
  })

  test('sender posts batch to master endpoint with container bearer and classifies failures', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let seenBody: any = null
    await sendSkillUsageReport(
      [{ eventId: 'e1', slug: 'browser', agentId: 'main', sessionKey: 's', traceId: TRACE, at: '2026-07-10T00:00:00Z' }],
      { masterBaseUrl: 'http://master', containerToken: 'tok' },
      {
        fetchImpl: async (input, init) => {
          seenUrl = String(input)
          seenAuth = new Headers(init.headers).get('authorization') ?? ''
          seenBody = JSON.parse(String(init.body))
          return new Response('{"ok":true,"accepted":1,"duplicate":0}', { status: 200 })
        },
      },
    )
    assert.equal(seenUrl, `http://master${SKILL_USAGE_PATH}`)
    assert.equal(seenAuth, 'Bearer tok')
    assert.equal(seenBody.events.length, 1)
    assert.equal(seenBody.events[0].slug, 'browser')

    await assert.rejects(
      () =>
        sendSkillUsageReport([], { masterBaseUrl: 'http://m', containerToken: 't' }, {
          fetchImpl: async () => new Response('{}', { status: 400 }),
        }),
      (err) => err instanceof SkillUsageReportError && err.retryable === false,
    )
    await assert.rejects(
      () =>
        sendSkillUsageReport([], { masterBaseUrl: 'http://m', containerToken: 't' }, {
          fetchImpl: async () => new Response('{}', { status: 503 }),
        }),
      (err) => err instanceof SkillUsageReportError && err.retryable === true,
    )
  })

  test('reports only successful hub skill_view; filters errors, non-skill_view, non-hub; carries traceId', async () => {
    const queueDir = await tmp('oc-usage-')
    const hubDir = await makeHub(['browser']) // 'browser' 在 hub;'platform-capabilities' 不在
    const { bus, emit } = fakeBus()
    const posts: any[] = []
    const reporter = makeSkillUsageReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir,
      hubSkillsDir: hubDir,
      eventBus: bus as any,
      drainIntervalMs: 60_000,
      resolveTraceId: () => TRACE,
      fetchImpl: async (_i, init) => {
        posts.push(JSON.parse(String(init.body)))
        return new Response('{"ok":true,"accepted":1,"duplicate":0}', { status: 200 })
      },
    })
    reporter.start()

    emit(skillViewEvent()) // hub browser → 上报
    emit(skillViewEvent({ isError: true })) // 失败 → 丢弃
    emit(skillViewEvent({ toolName: 'Bash', inputPreview: '{"command":"ls"}' })) // 非 skill_view → 丢弃
    emit(skillViewEvent({ inputPreview: '{"name":"platform-capabilities"}' })) // 非 hub → 丢弃

    for (let i = 0; i < 50 && posts.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20))
    // 让串行 enqueue 链把其余(被丢弃的)事件也处理完,确保没有额外 POST。
    await new Promise((r) => setTimeout(r, 60))

    assert.equal(posts.length, 1)
    const events = posts.flatMap((p) => p.events)
    assert.equal(events.length, 1)
    assert.equal(events[0].slug, 'browser')
    assert.equal(events[0].agentId, 'main')
    assert.equal(events[0].sessionKey, 'agent:main:webchat:dm:sess1')
    assert.equal(events[0].traceId, TRACE)
    assert.equal(typeof events[0].eventId, 'string')
    assert.ok(events[0].eventId.length > 0)
    assert.ok(!Number.isNaN(Date.parse(events[0].at)))
    assert.equal(await reporter.pendingCount(), 0)
    reporter.stop()
  })

  test('non-32hex resolved traceId is coerced to null (best-effort, never mints)', async () => {
    const queueDir = await tmp('oc-usage-')
    const hubDir = await makeHub(['browser'])
    const { bus, emit } = fakeBus()
    const posts: any[] = []
    const reporter = makeSkillUsageReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir,
      hubSkillsDir: hubDir,
      eventBus: bus as any,
      drainIntervalMs: 60_000,
      resolveTraceId: () => 'not-a-valid-trace', // 非法 → null
      fetchImpl: async (_i, init) => {
        posts.push(JSON.parse(String(init.body)))
        return new Response('{"ok":true}', { status: 200 })
      },
    })
    reporter.start()
    emit(skillViewEvent())
    for (let i = 0; i < 50 && posts.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20))
    assert.equal(posts.flatMap((p) => p.events)[0].traceId, null)
    reporter.stop()
  })

  test('drainOnce batches multiple queued events into a single POST (<=100)', async () => {
    const queueDir = await tmp('oc-usage-')
    const hubDir = await makeHub(['browser'])
    // 预置 5 条队列条目(直接落盘),绕过事件管道以确定性检验批量 drain。
    for (let i = 0; i < 5; i += 1) {
      await writeFile(
        join(queueDir, `${1_000_000 + i}-seed${i}.json`),
        JSON.stringify({
          schemaVersion: 1,
          payload: { eventId: `e${i}`, slug: 'browser', agentId: 'main', sessionKey: 's', traceId: TRACE, at: '2026-07-10T00:00:00Z' },
          firstSeenAt: Date.now(),
          attempts: 0,
        }),
        'utf8',
      )
    }
    let calls = 0
    let batchSize = 0
    const reporter = makeSkillUsageReporter({
      config: { masterBaseUrl: 'http://master', containerToken: 'tok' },
      queueDir,
      hubSkillsDir: hubDir,
      eventBus: fakeBus().bus as any,
      drainIntervalMs: 60_000,
      fetchImpl: async (_i, init) => {
        calls += 1
        batchSize = JSON.parse(String(init.body)).events.length
        return new Response('{"ok":true,"accepted":5,"duplicate":0}', { status: 200 })
      },
    })
    const stats = await reporter.drainOnce()
    assert.equal(calls, 1) // 5 条一次 POST
    assert.equal(batchSize, 5)
    assert.equal(stats.sent, 5)
    assert.equal(await reporter.pendingCount(), 0)
  })

  test('startSkillUsageReporter no-ops when OC_MARKET_SKILL_USAGE=0, starts when default-on', async () => {
    const home = await tmp('oc-usage-home-')
    const saved = {
      OC_MARKET_SKILL_USAGE: process.env.OC_MARKET_SKILL_USAGE,
      OPENCLAUDE_V3_MASTER_BASE_URL: process.env.OPENCLAUDE_V3_MASTER_BASE_URL,
      OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    try {
      process.env.OPENCLAUDE_HOME = home
      process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://master'
      process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'tok'

      process.env.OC_MARKET_SKILL_USAGE = '0'
      assert.equal(startSkillUsageReporter(), null) // 门控关 → 零上报

      delete process.env.OC_MARKET_SKILL_USAGE // 未设 = 默认开
      const reporter = startSkillUsageReporter()
      assert.notEqual(reporter, null)
      reporter!.stop()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
