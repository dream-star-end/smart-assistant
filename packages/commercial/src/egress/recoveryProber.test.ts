/**
 * 降级探活恢复器单测。
 * 覆盖:只探 auto+degraded 的静态 provider / forced 两态与健康态都不探 / 缺 key 跳过 /
 *      非静态 provider 跳过 / 成功才写样本、失败只告警 / tick 异常只 warn 不冒泡 /
 *      DISABLED=1 不启动 / runOnStart 启动即积累证据。
 * 不发真实网络(probeRequest 注入)、不写真实 PG(query/recordSuccess 注入)。
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { type StaticProviderKeys, getStaticProvider } from '@openclaude/protocol'
import {
  type RecoveryProbeRequest,
  type RecoveryProbeResult,
  buildRecoveryProbeHeaders,
  requestRecoveryProbe,
  startRecoveryProber,
} from './recoveryProber.js'

const logState = { infos: [] as string[], warns: [] as string[] }
const fakeLog = {
  info: (msg: string) => logState.infos.push(msg),
  warn: (msg: string) => logState.warns.push(msg),
}

const keys: StaticProviderKeys = {
  opencodego: 'sk-opencodego',
  ark: 'sk-ark',
}

const recorded: Array<{ providerId: string; model: string }> = []

function okResult(model: string): RecoveryProbeResult {
  return { ok: true, statusCode: 200, error: null, model }
}
function failResult(model: string, statusCode: number | null = 429): RecoveryProbeResult {
  return { ok: false, statusCode, error: 'boom', model }
}

type Deps = NonNullable<Parameters<typeof startRecoveryProber>[0]['_deps']>
type QueryFn = Deps['query']

interface OpsRow {
  provider_id: string
  health_status: string | null
  health_mode: string
}

function run(rows: OpsRow[], probe: RecoveryProbeRequest) {
  return startRecoveryProber({
    resolveKey: async (provider) => keys[provider] ?? null,
    log: fakeLog,
    _deps: {
      query: (async () => ({ rows })) as unknown as QueryFn,
      probeRequest: probe,
      recordSuccess: (providerId, model) => recorded.push({ providerId, model }),
    },
  })
}

afterEach(() => {
  recorded.length = 0
  logState.infos = []
  logState.warns = []
  Reflect.deleteProperty(process.env, 'OC_PROVIDER_HEALTH_RECOVERY_PROBE_DISABLED')
  Reflect.deleteProperty(process.env, 'OC_PROVIDER_HEALTH_RECOVERY_PROBE_INTERVAL_MS')
})

describe('startRecoveryProber — 探活对象筛选', () => {
  test('只探 auto+degraded 的静态 provider;forced 两态与健康态都不探', async () => {
    const probed: string[] = []
    const h = run(
      [
        { provider_id: 'opencodego', health_status: 'degraded', health_mode: 'auto' },
        { provider_id: 'ark', health_status: 'degraded', health_mode: 'auto' },
        { provider_id: 'zai', health_status: 'degraded', health_mode: 'forced_healthy' },
        { provider_id: 'kimi', health_status: 'healthy', health_mode: 'auto' },
        { provider_id: 'minimax', health_status: 'degraded', health_mode: 'forced_degraded' },
        { provider_id: 'not-a-static-provider', health_status: 'degraded', health_mode: 'auto' },
      ],
      async (spec) => {
        probed.push(spec.id)
        return okResult('m')
      },
    )
    assert.ok(h)
    await h.runNow()
    assert.deepEqual(probed.sort(), ['ark', 'opencodego'])
    h.stop()
  })

  test('缺 key 的 degraded provider 跳过(无法探活,保持降级)', async () => {
    const probed: string[] = []
    const h = run(
      [{ provider_id: 'zai', health_status: 'degraded', health_mode: 'auto' }], // keys 无 zai
      async (spec) => {
        probed.push(spec.id)
        return okResult('m')
      },
    )
    assert.ok(h)
    await h.runNow()
    assert.equal(probed.length, 0)
    h.stop()
  })
})

describe('startRecoveryProber — 样本写入(只写成功)', () => {
  test('探活成功 → 写成功样本;失败 → 不写样本只告警', async () => {
    const h = run(
      [
        { provider_id: 'opencodego', health_status: 'degraded', health_mode: 'auto' },
        { provider_id: 'ark', health_status: 'degraded', health_mode: 'auto' },
      ],
      async (spec) =>
        spec.id === 'opencodego' ? okResult('deepseek-v4-flash') : failResult('glm-5.2'),
    )
    assert.ok(h)
    await h.runNow()
    assert.deepEqual(recorded, [{ providerId: 'opencodego', model: 'deepseek-v4-flash' }])
    assert.ok(logState.warns.includes('recovery_probe_failed'))
    h.stop()
  })

  test('tick 内 query 抛错 → 只 warn 不冒泡', async () => {
    const h = startRecoveryProber({
      resolveKey: async (provider) => keys[provider] ?? null,
      log: fakeLog,
      _deps: {
        query: (() => Promise.reject(new Error('pg down'))) as unknown as QueryFn,
        probeRequest: async () => {
          throw new Error('should not probe')
        },
        recordSuccess: () => {
          throw new Error('should not record')
        },
      },
    })
    assert.ok(h)
    await h.runNow() // 不 reject 即通过
    assert.ok(logState.warns.includes('recovery_prober_tick_failed'))
    h.stop()
  })
})

describe('startRecoveryProber — 开关与启动', () => {
  test('DISABLED=1 → 返回 null 不启动', () => {
    process.env.OC_PROVIDER_HEALTH_RECOVERY_PROBE_DISABLED = '1'
    const h = startRecoveryProber({
      resolveKey: async (provider) => keys[provider] ?? null,
      log: fakeLog,
    })
    assert.equal(h, null)
    assert.ok(logState.infos.includes('recovery_prober_disabled'))
  })

  test('runOnStart:启动即跑一轮(部署后降级 provider 立即开始积累恢复证据)', async () => {
    const probed: string[] = []
    const h = run(
      [{ provider_id: 'opencodego', health_status: 'degraded', health_mode: 'auto' }],
      async (spec) => {
        probed.push(spec.id)
        return okResult('deepseek-v4-flash')
      },
    )
    assert.ok(h)
    await new Promise((r) => setImmediate(r))
    assert.equal(probed.length, 1)
    h.stop()
  })
})

describe('buildRecoveryProbeHeaders — 与真实流量同源的头集', () => {
  test('opencodego:x-api-key + x-opencode-session(随机 UUID,缺失即上游 400 → 探活永不恢复)', () => {
    const h = buildRecoveryProbeHeaders(getStaticProvider('opencodego'), 'GO-KEY')
    assert.equal(h['x-api-key'], 'GO-KEY')
    assert.equal(h.authorization, undefined)
    assert.match(h['x-opencode-session'] ?? '', /^[0-9a-f-]{36}$/)
    // 每次探活独立会话:两次构造不得复用同一 id。
    const h2 = buildRecoveryProbeHeaders(getStaticProvider('opencodego'), 'GO-KEY')
    assert.notEqual(h2['x-opencode-session'], h['x-opencode-session'])
  })

  test('未声明 sessionIdHeader 的 provider(deepseek direct)不注入任何会话头', () => {
    const h = buildRecoveryProbeHeaders(getStaticProvider('deepseek'), 'DS-KEY')
    assert.equal(h.authorization, 'Bearer DS-KEY')
    assert.equal(h['x-opencode-session'], undefined)
    assert.deepEqual(Object.keys(h).sort(), ['anthropic-version', 'authorization', 'content-type'])
  })
})

describe('recovery probe pool identity', () => {
  test('selects an active pool identity even when the old raw-env identity is disabled', async () => {
    const selected: string[] = []
    const sent: string[] = []
    const h = startRecoveryProber({
      resolveKey: async (provider) => {
        selected.push(provider)
        return 'active-admin-pool-key'
      },
      log: fakeLog,
      _deps: {
        query: (async () => ({
          rows: [{ provider_id: 'opencodego', health_status: 'degraded', health_mode: 'auto' }],
        })) as unknown as QueryFn,
        probeRequest: async (_spec, key) => {
          sent.push(key)
          return okResult('deepseek-v4-flash')
        },
        recordSuccess: (providerId, model) => recorded.push({ providerId, model }),
      },
    })
    assert.ok(h)
    try {
      await h.runNow()
      assert.deepEqual(selected, ['opencodego'])
      assert.deepEqual(sent, ['active-admin-pool-key'])
      assert.equal(recorded.length, 1)
    } finally {
      h.stop()
    }
  })

  test('null or throwing pool resolution sends nothing and continues other providers', async () => {
    const selected: string[] = []
    const sent: string[] = []
    const h = startRecoveryProber({
      resolveKey: async (provider) => {
        selected.push(provider)
        if (provider === 'opencodego') throw new Error('must not leak key detail')
        return provider === 'ark' ? null : 'eligible'
      },
      log: fakeLog,
      _deps: {
        query: (async () => ({
          rows: ['opencodego', 'ark', 'deepseek'].map((provider_id) => ({
            provider_id,
            health_status: 'degraded',
            health_mode: 'auto',
          })),
        })) as unknown as QueryFn,
        probeRequest: async (spec) => {
          sent.push(spec.id)
          return okResult('m')
        },
        recordSuccess: (providerId, model) => recorded.push({ providerId, model }),
      },
    })
    assert.ok(h)
    try {
      await h.runNow()
      assert.deepEqual(selected, ['opencodego', 'ark', 'deepseek'])
      assert.deepEqual(sent, ['deepseek'])
      assert.equal(logState.warns.includes('recovery_probe_key_unavailable'), true)
    } finally {
      h.stop()
    }
  })

  test('concurrent runNow shares one in-flight key selection and probe', async () => {
    let release!: () => void
    let selections = 0
    let probes = 0
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = startRecoveryProber({
      resolveKey: async () => {
        selections++
        await paused
        return 'eligible'
      },
      log: fakeLog,
      _deps: {
        query: (async () => ({
          rows: [{ provider_id: 'opencodego', health_status: 'degraded', health_mode: 'auto' }],
        })) as unknown as QueryFn,
        probeRequest: async () => {
          probes++
          return okResult('m')
        },
        recordSuccess: () => {},
      },
    })
    assert.ok(h)
    try {
      const a = h.runNow()
      const b = h.runNow()
      assert.equal(a, b)
      release()
      await Promise.all([a, b])
      assert.equal(selections, 1)
      assert.equal(probes, 1)
    } finally {
      h.stop()
    }
  })
})

// Exercise the real HTTP/result path with an injected transport; no sockets, credentials, or database.
import { Readable } from 'node:stream'
import type { request } from 'undici'
const inference = (overrides: Record<string, unknown> = {}) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
  ...overrides,
})
function transport(
  responses: Array<{ status: number; value?: unknown; raw?: string; truncated?: boolean }>,
) {
  const calls: Array<{
    url: string
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  const send = (async (url: string, options: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers })
    const response = responses.shift()
    assert.ok(response, 'unexpected extra provider request')
    const raw = response.raw ?? JSON.stringify(response.value ?? inference())
    const body = response.truncated
      ? Readable.from(
          (async function* () {
            yield Buffer.from(raw.slice(0, 12))
            throw new Error('secret response text must never be logged')
          })(),
        )
      : Readable.from([Buffer.from(raw)])
    return { statusCode: response.status, body }
  }) as unknown as typeof request
  return { send, calls }
}

describe('requestRecoveryProbe — complete inference evidence', () => {
  for (const [name, value] of [
    ['text', inference()],
    [
      'thinking-only max_tokens',
      inference({ content: [{ type: 'thinking', thinking: 'reason' }], stop_reason: 'max_tokens' }),
    ],
    [
      'redacted thinking',
      inference({
        content: [{ type: 'redacted_thinking', data: 'opaque' }],
        stop_reason: 'stop_sequence',
      }),
    ],
    ['upstream alias', inference({ model: 'canonical-model-alias', id: 'different-id' })],
  ] as const) {
    test(`accepts ${name}`, async () => {
      const t = transport([{ status: 200, value }])
      const result = await requestRecoveryProbe(getStaticProvider('opencodego'), 'eligible', t.send)
      assert.equal(result.ok, true)
      assert.equal(t.calls.length, 1)
      assert.deepEqual(t.calls[0].body, {
        model:
          getStaticProvider('opencodego').upstreamModelForRequest?.(
            getStaticProvider('opencodego').inboundModelIds[0],
          ) ?? getStaticProvider('opencodego').inboundModelIds[0],
        max_tokens: 512,
        messages: [{ role: 'user', content: 'ping' }],
      })
    })
  }
  for (const [name, response, expectedError] of [
    [
      '200 error envelope',
      { status: 200, value: { type: 'error', error: { message: 'secret' } } },
      'probe_response_invalid',
    ],
    ['200 HTML', { status: 200, raw: '<html>secret</html>' }, 'probe_response_invalid'],
    ['204 empty', { status: 204, raw: '' }, 'probe_response_invalid'],
    ['empty content', { status: 200, value: inference({ content: [] }) }, 'probe_response_invalid'],
    [
      'zero output',
      { status: 200, value: inference({ usage: { input_tokens: 1, output_tokens: 0 } }) },
      'probe_response_invalid',
    ],
    ['missing usage', { status: 200, value: inference({ usage: null }) }, 'probe_response_invalid'],
    [
      'tool use',
      {
        status: 200,
        value: inference({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
        }),
      },
      'probe_response_invalid',
    ],
    [
      'paused inference',
      { status: 200, value: inference({ stop_reason: 'pause_turn' }) },
      'probe_response_invalid',
    ],
    [
      'truncated body',
      { status: 200, value: inference(), truncated: true },
      'probe_response_read_failed',
    ],
    [
      'oversized body',
      { status: 200, raw: 'x'.repeat(256 * 1024 + 1) },
      'probe_response_too_large',
    ],
  ] as const) {
    test(`rejects ${name} without recovery evidence or leaking body`, async () => {
      const t = transport([response])
      const result = await requestRecoveryProbe(getStaticProvider('opencodego'), 'eligible', t.send)
      assert.equal(result.ok, false)
      assert.equal(result.error, expectedError)
      assert.equal(t.calls.length, 1)
      assert.equal(JSON.stringify(result).includes('secret'), false)
    })
  }
  test('complete 400/404 tries the next model with the same identity, session and request shape', async () => {
    const t = transport([{ status: 400 }, { status: 404 }, { status: 200 }])
    const result = await requestRecoveryProbe(getStaticProvider('opencodego'), 'eligible', t.send)
    assert.equal(result.ok, true)
    assert.equal(t.calls.length, 3)
    assert.equal(new Set(t.calls.map((c) => c.headers['x-api-key'])).size, 1)
    assert.equal(new Set(t.calls.map((c) => c.headers['x-opencode-session'])).size, 1)
    assert.equal(new Set(t.calls.map((c) => c.body.model)).size, 3)
  })
  for (const status of [401, 429, 503]) {
    test(`${status} does not rotate keys or try other models`, async () => {
      const t = transport([{ status }])
      const result = await requestRecoveryProbe(getStaticProvider('opencodego'), 'eligible', t.send)
      assert.equal(result.ok, false)
      assert.equal(result.statusCode, status)
      assert.equal(t.calls.length, 1)
    })
  }
  test('transport failures expose only a static error code', async () => {
    const send = (async () => {
      throw new Error('secret credential detail')
    }) as unknown as typeof request
    const result = await requestRecoveryProbe(getStaticProvider('opencodego'), 'eligible', send)
    assert.deepEqual(
      { ok: result.ok, status: result.statusCode, error: result.error },
      { ok: false, status: null, error: 'probe_transport_failed' },
    )
  })
})
