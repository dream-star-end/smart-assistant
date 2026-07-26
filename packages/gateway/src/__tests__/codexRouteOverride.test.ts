/**
 * v5 codex route 消费链(feat/v5-codex-oauth-egress A1/A2)——
 * `__oc_codex_route` 帧 → _buildSafeCodexRouteOverride 严格校验 →
 * submit(opts.codexRoute) → runner.setCodexRoute → buildCodexProviderConfigArgs argv。
 *
 * 安全面重点:override 直接变成 codex CLI 的 base_url。恶意 override
 * (非 loopback / 未知字段 / 超长)必须被拒;official_oauth 在 v5 是
 * loopback relay override(数据面强制代理转发),不是 v3 的空哨兵。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexRouteOverride.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  CODEX_OFFICIAL_RELAY_BASE_PATH,
  CODEX_OFFICIAL_RELAY_PROVIDER_ID,
  _buildSafeCodexRouteOverride,
} from '../server.js'
import { SessionManager, type AgentSession } from '../sessionManager.js'
import {
  buildCodexProviderConfigArgs,
  type CodexProviderConfigOverride,
} from '../engine/codexShared.js'
import type { EngineCapabilities, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import type { OpenClaudeConfig } from '@openclaude/storage'

// ── fixtures ────────────────────────────────────────────────────────────────

const CODEX_AGENT = { id: 'main', provider: undefined as string | undefined, runnerKind: undefined as string | undefined }
const PORT = 18789

const VALID_API_RELAY_ROUTE = {
  baseUrl: `http://127.0.0.1:${PORT}/internal/v3/codex-relay/route/${'a'.repeat(64)}`,
  modelProvider: 'api111',
  providerName: 'Yunwu',
  wireApi: 'responses',
  preferredAuthMethod: 'apikey',
  disableResponseStorage: true,
}

function buildOfficial(overrides: Partial<{ model?: string; agent: typeof CODEX_AGENT; port: number; rawRoute: unknown }> = {}) {
  return _buildSafeCodexRouteOverride({
    agent: overrides.agent ?? CODEX_AGENT,
    model: 'model' in overrides ? overrides.model : 'gpt-5.6-sol',
    rawRoute: 'rawRoute' in overrides ? overrides.rawRoute : { kind: 'official_oauth' },
    officialRelayPort: overrides.port ?? PORT,
  })
}

// ── official_oauth → loopback relay override(v5 语义)──────────────────────

describe('_buildSafeCodexRouteOverride — official_oauth(v5 relay 语义)', () => {
  test('exact-shape marker → loopback relay override(非 v3 空哨兵)', () => {
    const route = buildOfficial()
    assert.deepEqual(route, {
      modelProvider: CODEX_OFFICIAL_RELAY_PROVIDER_ID,
      baseUrl: `http://127.0.0.1:${PORT}${CODEX_OFFICIAL_RELAY_BASE_PATH}`,
      providerName: 'OpenAI (OpenClaude relay)',
      wireApi: 'responses',
      preferredAuthMethod: 'chatgpt',
      disableResponseStorage: true,
      requiresOpenaiAuth: true,
    })
    // 显式锁死 base path 形状:master relay 的 chatgpt 上游映射依赖这个前缀。
    assert.equal(CODEX_OFFICIAL_RELAY_BASE_PATH, '/internal/v3/codex-relay/backend-api/codex')
  })

  test('marker 带多余字段 → 拒(不得被重新解释)', () => {
    assert.equal(
      buildOfficial({ rawRoute: { kind: 'official_oauth', baseUrl: 'http://127.0.0.1:1/x' } }),
      null,
    )
    assert.equal(buildOfficial({ rawRoute: { kind: 'official_oauth', extra: 1 } }), null)
  })

  test('codex-native agent 无 model 也走 codex engine → override 仍生成', () => {
    const route = buildOfficial({
      agent: { id: 'codex', provider: 'codex-native', runnerKind: undefined },
      model: undefined,
    })
    assert.ok(route)
    assert.equal(route?.requiresOpenaiAuth, true)
  })

  test('非 codex engine(glm-5.2 / 无 model 的普通 agent)→ null', () => {
    assert.equal(buildOfficial({ model: 'glm-5.2' }), null)
    assert.equal(buildOfficial({ model: undefined }), null)
  })

  test('非法 runnerKind(resolveEngine fail-closed 抛错)→ null 不抛', () => {
    assert.equal(
      buildOfficial({ agent: { id: 'codex', provider: 'codex-native', runnerKind: 'exec' } }),
      null,
    )
  })

  test('非法 relay port → null(不产出畸形 base_url)', () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      assert.equal(buildOfficial({ port }), null, `port=${port} must be rejected`)
    }
  })

  test('rawRoute 非对象 / 数组 / 缺省 → null', () => {
    for (const raw of [undefined, null, 'official_oauth', 42, ['official_oauth']]) {
      assert.equal(buildOfficial({ rawRoute: raw }), null)
    }
  })
})

// ── api_relay 校验(v3 兼容形状,v5 收紧)───────────────────────────────────

describe('_buildSafeCodexRouteOverride — api_relay(严格 allowlist)', () => {
  test('合法 route → 透传(且不带 requiresOpenaiAuth)', () => {
    const route = buildOfficial({ rawRoute: VALID_API_RELAY_ROUTE })
    assert.deepEqual(route, {
      baseUrl: VALID_API_RELAY_ROUTE.baseUrl,
      modelProvider: 'api111',
      providerName: 'Yunwu',
      wireApi: 'responses',
      preferredAuthMethod: 'apikey',
      disableResponseStorage: true,
    })
    assert.equal('requiresOpenaiAuth' in (route as object), false)
  })

  test('恶意 baseUrl:非 loopback / 非 http / 错误前缀 → 拒', () => {
    for (const baseUrl of [
      `https://127.0.0.1:${PORT}/internal/v3/codex-relay/route/${'a'.repeat(64)}`,
      `http://evil.example/internal/v3/codex-relay/route/${'a'.repeat(64)}`,
      `http://localhost:${PORT}/internal/v3/codex-relay/route/${'a'.repeat(64)}`,
      `http://127.0.0.1:${PORT}/internal/v3/codex-relay/backend-api/codex`,
      `http://127.0.0.1:${PORT}/api/whatever`,
      'not-a-url',
    ]) {
      assert.equal(
        buildOfficial({ rawRoute: { ...VALID_API_RELAY_ROUTE, baseUrl } }),
        null,
        `baseUrl=${baseUrl} must be rejected`,
      )
    }
  })

  test('未知字段 → 整体拒(严于 v3 的"取已知字段")', () => {
    assert.equal(
      buildOfficial({ rawRoute: { ...VALID_API_RELAY_ROUTE, evil: 'x' } }),
      null,
    )
  })

  test('超长字段 → 拒(baseUrl > 512 / providerName > 128 / modelProvider > 64)', () => {
    assert.equal(
      buildOfficial({
        rawRoute: {
          ...VALID_API_RELAY_ROUTE,
          baseUrl: `http://127.0.0.1:${PORT}/internal/v3/codex-relay/route/${'a'.repeat(64)}?x=${'b'.repeat(512)}`,
        },
      }),
      null,
    )
    assert.equal(
      buildOfficial({ rawRoute: { ...VALID_API_RELAY_ROUTE, providerName: 'p'.repeat(129) } }),
      null,
    )
    assert.equal(
      buildOfficial({ rawRoute: { ...VALID_API_RELAY_ROUTE, modelProvider: 'm'.repeat(65) } }),
      null,
    )
  })

  test('modelProvider 非法字符(TOML key 注入面)→ 拒', () => {
    for (const modelProvider of ['a.b', 'a"b', 'a b', '', 'a\nb']) {
      assert.equal(
        buildOfficial({ rawRoute: { ...VALID_API_RELAY_ROUTE, modelProvider } }),
        null,
      )
    }
  })

  test('wireApi / preferredAuthMethod / disableResponseStorage 非法值 → 归 null 不拒', () => {
    const route = buildOfficial({
      rawRoute: {
        ...VALID_API_RELAY_ROUTE,
        wireApi: 'grpc',
        preferredAuthMethod: 'magic',
        disableResponseStorage: 'yes',
      },
    })
    assert.ok(route)
    assert.equal(route?.wireApi, null)
    assert.equal(route?.preferredAuthMethod, null)
    assert.equal(route?.disableResponseStorage, null)
  })
})

// ── override → codex CLI argv(requires_openai_auth)────────────────────────

describe('buildCodexProviderConfigArgs — requiresOpenaiAuth argv', () => {
  test('official override → 完整 -c 序列含 requires_openai_auth=true', () => {
    const route = buildOfficial()
    assert.ok(route)
    // env 全带毒:override 存在时必须完全无视 env OC_CODEX_*。
    const env = {
      OC_CODEX_MODEL_PROVIDER: 'evil',
      OC_CODEX_BASE_URL: 'https://evil.example/v1',
      OC_CODEX_PREFERRED_AUTH_METHOD: 'apikey',
    } as NodeJS.ProcessEnv
    const args = buildCodexProviderConfigArgs(env, route)
    const id = CODEX_OFFICIAL_RELAY_PROVIDER_ID
    assert.deepEqual(args, [
      '-c', `model_provider="${id}"`,
      '-c', `model_providers.${id}.name="OpenAI (OpenClaude relay)"`,
      '-c', `model_providers.${id}.base_url="http://127.0.0.1:${PORT}${CODEX_OFFICIAL_RELAY_BASE_PATH}"`,
      '-c', `model_providers.${id}.wire_api="responses"`,
      // turn-retry 批:原生重试旋钮(乘性 → 单 API 调用最多 12 次尝试)。
      '-c', `model_providers.${id}.request_max_retries=1`,
      '-c', `model_providers.${id}.stream_max_retries=5`,
      '-c', `model_providers.${id}.requires_openai_auth=true`,
      '-c', 'preferred_auth_method="chatgpt"',
      '-c', 'disable_response_storage=true',
    ])
  })

  test('api_relay override(requiresOpenaiAuth 缺省)→ 不出现 requires_openai_auth', () => {
    const route = buildOfficial({ rawRoute: VALID_API_RELAY_ROUTE })
    assert.ok(route)
    const args = buildCodexProviderConfigArgs({} as NodeJS.ProcessEnv, route)
    assert.equal(args.some((a) => a.includes('requires_openai_auth')), false)
  })

  test('env 路径(无 override)恒不带 requires_openai_auth(不新增 env 键)', () => {
    const env = {
      OC_CODEX_MODEL_PROVIDER: 'api111',
      OC_CODEX_BASE_URL: 'https://yunwu.ai/v1',
    } as NodeJS.ProcessEnv
    const args = buildCodexProviderConfigArgs(env, null)
    assert.ok(args.length > 0)
    assert.equal(args.some((a) => a.includes('requires_openai_auth')), false)
  })
})

// ── submit(opts.codexRoute) → runner.setCodexRoute ─────────────────────────

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.2' },
  } as unknown as OpenClaudeConfig
}

const PROXY_CAPS: EngineCapabilities = {
  billingMode: 'proxy',
  supportsEffort: true,
  resumeKind: 'ccb-session',
  needsServerRequestId: false,
}

class FakeRouteRunner extends EventEmitter {
  readonly engineId = 'codex'
  readonly capabilities = PROXY_CAPS
  lastActivityAt = Date.now()
  effortLevel: string | undefined = undefined
  model: string | undefined = 'gpt-5.6-sol'
  routeCalls: Array<CodexProviderConfigOverride | null> = []

  setTraceId(): void {}
  setEffortLevel(): void {}
  setModel(): void {}
  setCodexRoute(route: CodexProviderConfigOverride | null | undefined): void {
    this.routeCalls.push(route ?? null)
  }
  interrupt(): boolean { return false }
  async shutdown(): Promise<void> {}

  submitTurn(_params: TurnParams): EngineTurnRun {
    return {
      submitted: Promise.resolve(),
      summary: Promise.resolve({
        usage: {
          cost: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
        },
        assistantText: '',
        thinkingText: '',
        assistantSegments: [],
        thinkingSegments: [],
        tools: [],
        runtimeEvents: [],
        stopReason: 'end_turn',
        numTurns: 1,
        isError: false,
        staleResumeId: false,
        phantomSignals: { apiState: 'skipped' as const, skipReason: 'unit-test' },
      }),
      end: () => {},
      getPartialSnapshot: () => ({
        assistantText: '',
        thinkingText: '',
        completedTools: [],
        assistantSegments: [],
        thinkingSegments: [],
        runtimeEvents: [],
      }),
      getPhantomSignals: () => ({ apiState: 'skipped' as const, skipReason: 'unit-test' }),
      finalized: true,
      pendingToolCalls: 0,
    }
  }
}

function makeSession(runner: FakeRouteRunner): AgentSession {
  return {
    sessionKey: `agent:main:webchat:dm:route-peer-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'main',
    channel: 'unit',
    peerId: 'route-peer',
    title: 'Route Unit',
    startedAt: Date.now(),
    runner,
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 3,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: runner.engineId,
    agentProvider: undefined,
  } as unknown as AgentSession
}

describe('sessionManager.submit — opts.codexRoute 消费', () => {
  test('带 codexRoute → setCodexRoute(route);缺省 → setCodexRoute(null) 清除 stale route', async () => {
    const runner = new FakeRouteRunner()
    const session = makeSession(runner)
    const sm = new SessionManager(makeConfigStub())
    ;(sm as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}

    const route = buildOfficial()
    assert.ok(route)
    await sm.submit(session, 'hi', () => {}, undefined, undefined, undefined, undefined, undefined, {
      codexRoute: route,
    })
    assert.equal(runner.routeCalls.length, 1)
    assert.deepEqual(runner.routeCalls[0], route)

    // 下一 turn 不带 codexRoute → 显式 null(不残留上一 turn 的 override)
    await sm.submit(session, 'hi again', () => {})
    assert.equal(runner.routeCalls.length, 2)
    assert.equal(runner.routeCalls[1], null)
  })

  test('runner 无 setCodexRoute(非 codex engine)→ duck-type noop 不抛', async () => {
    const runner = new FakeRouteRunner()
    ;(runner as unknown as Record<string, unknown>).setCodexRoute = undefined
    const session = makeSession(runner)
    const sm = new SessionManager(makeConfigStub())
    ;(sm as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
    await sm.submit(session, 'hi', () => {}, undefined, undefined, undefined, undefined, undefined, {
      codexRoute: buildOfficial(),
    })
    // 走到 submitTurn 即证明没有在 setCodexRoute 缺失上抛 TypeError
  })
})
