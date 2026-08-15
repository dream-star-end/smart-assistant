/**
 * 模型权威批次 · BLOCKER-2 —— **本地路径(无 envelope)消费 catalog 投影**。
 *
 * 修的是什么:在此之前 `getLocalCatalogView()` 在生产代码里**没有任何消费者** —— catalog
 * client 只被用来给 CCB submit 生成 `local_catalog` header,而 cron / synthetic / delegate /
 * wechat / prewarm 这些**不经 bridge 签发 authority** 的 runner 创建入口,仍然按容器镜像里
 * baked 的两张表(ALLOWED_INBOUND_MODELS / MODEL_ENGINE_MAP)判定 engine 与可用性。
 * 后果:catalog 一改(新模型 / engine 迁移 / disable / 撤销授权),容器不知道 —— codex
 * delegate 照样 spawn(不进 CCB egress fence = 计费旁路),disabled 模型照样跑。
 *
 * 本文件锁住修复后的六条语义(与任务清单 ①-⑥ 一一对应):
 *   ① flag 未开 → 本地路径**零变化**(不查 catalog、不打网络,仍走 baked);
 *   ② flag 开 + catalog 可用 → canonicalize / 可用性 / engine **全取投影**
 *      (alias 归一;engine 与 baked 相反时以投影为准;不在投影的模型拒);
 *   ③ flag 开 + catalog 不可用 → **拒新 turn**(结构化 MODEL_CATALOG_UNAVAILABLE,无 baked 回落);
 *   ④ codex delegate → `DELEGATE_CODEX_UNSUPPORTED`,且**在创建 runner 之前**返回(未 spawn);
 *   ⑤ provider pin(codex-native agent)的本地 turn → 同 ④;
 *   ⑥ cron/synthetic 的 codex 意图 → **仍降级为非 codex**(既有语义不破)。
 *
 * 外加**背板**(完整性证明):flag 开 + 无任何 master 权威 → `resolveEngine` fail-closed 抛
 * ModelAuthorityRequiredError。createEngine 的唯一调用者是 SessionManager.getOrCreate,
 * 而 getOrCreate 必过 resolveEngine —— 所以"漏了某个 runner 创建入口"不会静默回落 baked,
 * 会在第一个 turn 就炸出来(测试 backstop_* 用例)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/modelAuthorityLocalPath.test.ts
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'

// side-effect:注册真 'ccb' / 'codex' factory(与 sessionManager 同一条注册路径)。
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { CodexAdapter } from '../engine/codexAdapter.js'
import {
  type EngineCreateOpts,
  ModelAuthorityRequiredError,
  registerEngine,
  resolveEngine,
} from '../engine/registry.js'
import {
  type LocalCatalogView,
  ModelCatalogClient,
  ModelCatalogUnavailableError,
  _setModelCatalogClientForTests,
  parseCatalogResponse,
} from '../modelCatalogClient.js'
import {
  Gateway,
  PerTurnDelegationGuard,
  decideLocalExecution,
  localExecutionOverride,
  resolveLocalExecutionIfEnforced,
} from '../server.js'
import { SessionManager } from '../sessionManager.js'

// ── 投影脚手架 ───────────────────────────────────────────────────────────────

const MASTER_ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.invalid:18791',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.deadbeef',
} as NodeJS.ProcessEnv

/** flag 开(托管)。 */
const ON = { ...MASTER_ENV, OC_MODEL_AUTHORITY: '1' } as NodeJS.ProcessEnv
/** flag 未开(个人版 / 过渡期)。 */
const OFF = { ...MASTER_ENV } as NodeJS.ProcessEnv

function row(
  model_id: string,
  engine: 'ccb' | 'codex',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model_id,
    display_name: model_id,
    engine,
    provider_id: engine === 'codex' ? 'codex' : 'ark',
    context_window: 200_000,
    supported_efforts: ['high'],
    supports_vision: false,
    capability_zero: engine === 'ccb',
    supports_thinking: engine === 'ccb',
    default_effort: 'high',
    ...extra,
  }
}

function view(
  models: Array<Record<string, unknown>>,
  aliases?: Record<string, string>,
): LocalCatalogView {
  return parseCatalogResponse({
    models,
    projection_revision: 'proj-1',
    security_epoch: '7',
    ...(aliases ? { aliases } : {}),
  })
}

/** 该 uid 的常规投影:glm-5.2(ccb)+ deepseek-v4-flash(ccb 兜底)+ gpt-5.6-sol(codex)。 */
function normalView(): LocalCatalogView {
  return view([row('glm-5.2', 'ccb'), row('deepseek-v4-flash', 'ccb'), row('gpt-5.6-sol', 'codex')], {
    'glm-latest': 'glm-5.2',
  })
}

const AGENT: Pick<AgentDef, 'id' | 'model' | 'provider'> = { id: 'main', model: 'glm-5.2' }
const CODEX_PINNED: Pick<AgentDef, 'id' | 'model' | 'provider'> = {
  id: 'codex-leader',
  model: 'gpt-5.6-sol',
  provider: 'codex-native',
}

/** undici 桩:catalog + epoch 端点。`fail:true` → 网络不可达(master 不可达)。 */
function fetcherFor(body: unknown, opts: { fail?: boolean; calls?: string[] } = {}) {
  return (async (url: string): Promise<any> => {
    opts.calls?.push(String(url))
    if (opts.fail) throw new Error('ECONNREFUSED')
    const text = url.includes('epoch') ? JSON.stringify({ epoch: '7' }) : JSON.stringify(body)
    return {
      statusCode: 200,
      body: (async function* () {
        yield Buffer.from(text, 'utf8')
      })(),
    }
  }) as any
}

function installCatalog(opts: { fail?: boolean; calls?: string[] } = {}): void {
  _setModelCatalogClientForTests(
    new ModelCatalogClient({
      env: MASTER_ENV,
      lkgPath: `/tmp/oc-lp-lkg-${Math.random().toString(36).slice(2)}.json`,
      fetcher: fetcherFor(
        {
          models: [
            row('glm-5.2', 'ccb'),
            row('deepseek-v4-flash', 'ccb'),
            row('gpt-5.6-sol', 'codex'),
          ],
          projection_revision: 'proj-1',
          security_epoch: '7',
          aliases: { 'glm-latest': 'glm-5.2' },
        },
        opts,
      ),
    }),
  )
}

afterEach(() => {
  _setModelCatalogClientForTests(null)
})

/** flag env 还原(Reflect.deleteProperty:biome performance/noDelete)。 */
function restoreFlag(prev: string | undefined): void {
  if (prev === undefined) Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
  else process.env.OC_MODEL_AUTHORITY = prev
}

// ── ① flag 未开 → 零变化(连网络都不许打)───────────────────────────────────

describe('① flag 未开 → 本地路径零变化', () => {
  test('resolveLocalExecutionIfEnforced 返回 undefined,且**完全不碰 catalog client**', async () => {
    // 单例装成"一碰就炸":证明 flag 未开时本地路径根本不查投影(不是"查了但忽略")。
    _setModelCatalogClientForTests({
      getView: () => {
        throw new Error('catalog must NOT be consulted while OC_MODEL_AUTHORITY is unset')
      },
    } as any)
    const decision = await resolveLocalExecutionIfEnforced({
      agent: AGENT,
      kind: 'synthetic',
      defaultModel: 'glm-5.2',
      env: OFF,
    })
    assert.equal(decision, undefined)
    // getOrCreate 的执行覆盖为空对象 → 展开后逐字等于改造前的入参。
    assert.deepEqual(localExecutionOverride(decision), {})
  })

  test('resolveEngine 无 requireAuthority → baked 判定不变(codex 系模型仍判 codex)', () => {
    assert.equal(resolveEngine('gpt-5.6-sol', { id: 'main' }), 'codex')
    assert.equal(resolveEngine('glm-5.2', { id: 'main' }), 'ccb')
    assert.equal(resolveEngine(undefined, CODEX_PINNED as AgentDef), 'codex')
  })

  test('getOrCreate 无 authority + flag 未开 → 照常创建 runner(baked engine)', async () => {
    const sm = new SessionManager(makeConfig())
    const session = await sm.getOrCreate({
      sessionKey: 'agent:main:cron:dm:flagoff',
      agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
      channel: 'cron',
      peerId: 'flagoff',
    })
    assert.equal(session.providerTag, 'ccb')
    assert.equal(session.model, 'glm-5.2')
  })
})

// ── ② flag 开 + catalog 可用 → 判定全取投影 ─────────────────────────────────

describe('② flag 开 + catalog 可用 → engine/model 取投影', () => {
  test('alias 归一:frame/agent 用 alias → canonicalModel 落 canonical id', () => {
    const d = decideLocalExecution({
      view: normalView(),
      agent: AGENT,
      model: 'glm-latest',
      kind: 'turn',
    })
    assert.equal(d.canonicalModel, 'glm-5.2')
    assert.equal(d.engine, 'ccb')
  })

  test('engine **取自投影**,与 baked MODEL_ENGINE_MAP 相反时以投影为准(两个方向)', () => {
    // 方向 A:baked 认为 gpt-5.6-sol 是 codex,投影说它是 ccb → 判 ccb(不查 baked)。
    const asCcb = decideLocalExecution({
      view: view([row('gpt-5.6-sol', 'ccb')]),
      agent: { id: 'main', model: 'gpt-5.6-sol' },
      kind: 'turn',
    })
    assert.equal(asCcb.engine, 'ccb', 'baked 说 codex,投影说 ccb → 取投影')
    assert.equal(resolveEngine('gpt-5.6-sol', { id: 'main' }), 'codex', 'baked 本身仍是 codex')

    // 方向 B:baked 不认识的 codex 模型(catalog 新 active)→ 投影说 codex → 本地 turn 拒。
    assert.throws(
      () =>
        decideLocalExecution({
          view: view([row('brand-new-codex', 'codex')]),
          agent: { id: 'main', model: 'brand-new-codex' },
          kind: 'turn',
        }),
      (err: unknown) => (err as { code?: string })?.code === 'DELEGATE_CODEX_UNSUPPORTED',
    )
    assert.equal(resolveEngine('brand-new-codex', { id: 'main' }), 'ccb', 'baked 会误判成 ccb')
  })

  test('disabled / 未授权模型(不在投影)→ 按多级 route 逐级兜底', () => {
    // glm / MiniMax 都不在投影，route 末级 deepseek-v4-flash 可用。
    const routed = decideLocalExecution({
      view: view([row('deepseek-v4-flash', 'ccb')]),
      agent: { id: 'x', model: 'retired-model' },
      defaultModel: 'missing-default',
      kind: 'turn',
    })
    assert.equal(routed.canonicalModel, 'deepseek-v4-flash')

    // 全 route 都不在投影 → 保持结构化 MODEL_NOT_AVAILABLE。
    assert.throws(
      () =>
        decideLocalExecution({
          view: view([]),
          agent: { id: 'x', model: 'glm-5.2' },
          defaultModel: 'glm-5.2',
          kind: 'turn',
        }),
      (err: unknown) => (err as { code?: string })?.code === 'MODEL_NOT_AVAILABLE',
    )
  })

  test('provider unavailable 会跳过 agent/default 与 route 前级，选择下一可用模型', () => {
    const d = decideLocalExecution({
      view: view([
        row('glm-5.2', 'ccb', { available: false }),
        row('MiniMax-M3', 'ccb'),
        row('deepseek-v4-pro', 'ccb'),
      ]),
      agent: { id: 'research-assistant', model: 'deepseek-v4-pro' },
      model: 'glm-5.2',
      defaultModel: 'glm-5.2',
      kind: 'turn',
    })
    // agent 自身 deepseek 仍可用，所以显式/默认 glm 不可用后先尊重 agent 默认。
    assert.equal(d.canonicalModel, 'deepseek-v4-pro')
  })

  test('agent 默认也不可用时按 glm → MiniMax → DeepSeek Flash 多级路由', () => {
    const d = decideLocalExecution({
      view: view([
        row('glm-5.2', 'ccb', { available: false }),
        row('MiniMax-M3', 'ccb'),
        row('deepseek-v4-pro', 'ccb', { available: false }),
        row('deepseek-v4-flash', 'ccb'),
      ]),
      agent: { id: 'research-assistant', model: 'deepseek-v4-pro' },
      defaultModel: 'glm-5.2',
      kind: 'turn',
    })
    assert.equal(d.canonicalModel, 'MiniMax-M3')
  })

  test('测试账号投影没有 deepseek-v4-pro 时自动跳过，其他模型仍可路由', () => {
    const d = decideLocalExecution({
      view: view([
        row('glm-5.2', 'ccb', { available: false }),
        row('MiniMax-M3', 'ccb', { available: false }),
        row('deepseek-v4-flash', 'ccb'),
      ]),
      agent: { id: 'research-assistant', model: 'deepseek-v4-pro' },
      defaultModel: 'glm-5.2',
      kind: 'turn',
    })
    assert.equal(d.canonicalModel, 'deepseek-v4-flash')
  })

  test('端到端:flag 开 → resolveLocalExecutionIfEnforced 真的去拉投影并按投影判定', async () => {
    const calls: string[] = []
    installCatalog({ calls })
    const d = await resolveLocalExecutionIfEnforced({
      agent: { id: 'main', model: 'glm-latest' },
      kind: 'turn',
      defaultModel: 'glm-5.2',
      env: ON,
    })
    assert.equal(d?.canonicalModel, 'glm-5.2')
    assert.equal(d?.engine, 'ccb')
    assert.ok(
      calls.some((u) => u.includes('/internal/v3/model-catalog')),
      '必须真的打了投影端点',
    )
    assert.deepEqual(localExecutionOverride(d), {
      model: 'glm-5.2',
      executionAuthority: {
        canonicalModel: 'glm-5.2',
        engine: 'ccb',
        source: 'local_catalog',
      },
    })
  })
})

// ── ③ flag 开 + catalog 不可用 → 拒新 turn ─────────────────────────────────

describe('③ flag 开 + catalog 不可用 → 拒新 turn(无 baked 回落)', () => {
  test('master 不可达 + 无 LKG → ModelCatalogUnavailableError(code=MODEL_CATALOG_UNAVAILABLE)', async () => {
    installCatalog({ fail: true })
    await assert.rejects(
      resolveLocalExecutionIfEnforced({
        agent: AGENT,
        kind: 'synthetic',
        defaultModel: 'glm-5.2',
        env: ON,
      }),
      (err: unknown) => {
        assert.ok(err instanceof ModelCatalogUnavailableError)
        assert.equal((err as ModelCatalogUnavailableError).code, 'MODEL_CATALOG_UNAVAILABLE')
        return true
      },
    )
  })

  test('backstop:flag 开 + 无 authority → resolveEngine fail-closed(**不回落 baked**)', () => {
    assert.throws(
      () => resolveEngine('glm-5.2', { id: 'main' }, undefined, { requireAuthority: true }),
      ModelAuthorityRequiredError,
    )
    // codex-native 硬 pin 也不能绕过门 0(否则漏接 catalog 的入口能继续 spawn codex)。
    assert.throws(
      () =>
        resolveEngine(undefined, CODEX_PINNED as AgentDef, undefined, { requireAuthority: true }),
      ModelAuthorityRequiredError,
    )
    // 有权威(catalog 投影 or 签名 descriptor)→ 正常判定。
    assert.equal(
      resolveEngine(
        'glm-5.2',
        { id: 'main' },
        { canonicalModel: 'glm-5.2', engine: 'ccb' },
        { requireAuthority: true },
      ),
      'ccb',
    )
  })

  test('backstop:getOrCreate(flag 开 + 无 authority)→ 抛且**未创建任何 runner**', async () => {
    const spawned = countingEngines()
    const prev = process.env.OC_MODEL_AUTHORITY
    process.env.OC_MODEL_AUTHORITY = '1'
    try {
      const sm = new SessionManager(makeConfig())
      await assert.rejects(
        sm.getOrCreate({
          sessionKey: 'agent:main:cron:dm:backstop',
          agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
          channel: 'cron',
          peerId: 'backstop',
        }),
        ModelAuthorityRequiredError,
      )
      assert.equal(spawned.count, 0, '判定失败必须先于 createEngine —— 一个 runner 都不许起')
      assert.equal(sm.getByKey('agent:main:cron:dm:backstop'), undefined)
    } finally {
      restoreFlag(prev)
      spawned.restore()
    }
  })

  test('flag 开 + catalog 投影在场 → getOrCreate 正常创建(engine 取投影)', async () => {
    const prev = process.env.OC_MODEL_AUTHORITY
    process.env.OC_MODEL_AUTHORITY = '1'
    try {
      const sm = new SessionManager(makeConfig())
      const session = await sm.getOrCreate({
        sessionKey: 'agent:main:cron:dm:withproj',
        agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
        channel: 'cron',
        peerId: 'withproj',
        ...localExecutionOverride({ canonicalModel: 'deepseek-v4-pro', engine: 'ccb', supportsVision: false }),
      })
      assert.equal(session.providerTag, 'ccb')
      assert.equal(session.model, 'deepseek-v4-pro', 'model 取投影的 canonicalModel')
    } finally {
      restoreFlag(prev)
    }
  })
})

// ── ④/⑤ codex delegate + provider pin → 结构化错误,创建 runner 之前 ─────────

describe('④⑤ codex delegate / provider pin 的本地 turn → DELEGATE_CODEX_UNSUPPORTED', () => {
  test('codex 模型的 delegate(kind=turn)→ 结构化拒,不降级、不换模型', () => {
    assert.throws(
      () =>
        decideLocalExecution({
          view: normalView(),
          agent: { id: 'member', model: 'gpt-5.6-sol' },
          kind: 'turn',
        }),
      (err: unknown) => {
        assert.equal((err as { code?: string })?.code, 'DELEGATE_CODEX_UNSUPPORTED')
        return true
      },
    )
  })

  test('provider pin(codex-native)的本地 turn → 结构化拒(换模型救不了 pin)', () => {
    assert.throws(
      () => decideLocalExecution({ view: normalView(), agent: CODEX_PINNED, kind: 'turn' }),
      (err: unknown) => (err as { code?: string })?.code === 'DELEGATE_CODEX_UNSUPPORTED',
    )
  })

  test('prewarm 不套 codex 真值表(不是 turn:不执行/不计费),engine 仍取投影', () => {
    const d = decideLocalExecution({ view: normalView(), agent: CODEX_PINNED, kind: 'prewarm' })
    assert.equal(d.engine, 'codex')
    assert.equal(d.canonicalModel, 'gpt-5.6-sol')
  })

  test('HTTP delegate 端点:codex 目标 → 409 + code,且 getOrCreate **从未被调用**(未 spawn)', async () => {
    installCatalog()
    const prev = process.env.OC_MODEL_AUTHORITY
    process.env.OC_MODEL_AUTHORITY = '1'
    try {
      const gw = makeDelegateGateway()
      const r = await runDelegate(gw, 'codex-leader', {
        goal: '跑个 codex 子任务',
        sourceAgent: 'main',
      })
      assert.equal(r.status, 409)
      assert.equal(r.body.code, 'DELEGATE_CODEX_UNSUPPORTED')
      assert.equal(gw.sessions.getOrCreateCalls, 0, '结构化拒必须发生在 runner 创建之前')
      // 资源闸也没被占用(拒绝先于排队:codex delegate 是语义冲突,不该等内存名额)。
      assert.equal(gw._activeDelegations, 0)
    } finally {
      restoreFlag(prev)
    }
  })

  test('HTTP delegate:catalog 不可用 → 503 + MODEL_CATALOG_UNAVAILABLE,同样未 spawn', async () => {
    installCatalog({ fail: true })
    const prev = process.env.OC_MODEL_AUTHORITY
    process.env.OC_MODEL_AUTHORITY = '1'
    try {
      const gw = makeDelegateGateway()
      const r = await runDelegate(gw, 'coding-assistant', {
        goal: '普通子任务',
        sourceAgent: 'main',
      })
      assert.equal(r.status, 503)
      assert.equal(r.body.code, 'MODEL_CATALOG_UNAVAILABLE')
      assert.equal(gw.sessions.getOrCreateCalls, 0)
    } finally {
      restoreFlag(prev)
    }
  })

  test('flag 未开 → delegate 完全走旧路(不查 catalog,codex 目标照旧放行到 runner)', async () => {
    _setModelCatalogClientForTests({
      getView: () => {
        throw new Error('catalog must NOT be consulted while flag is off')
      },
    } as any)
    const gw = makeDelegateGateway()
    const r = await runDelegate(gw, 'codex-leader', { goal: '旧行为', sourceAgent: 'main' })
    assert.equal(r.status, 200)
    assert.equal(gw.sessions.getOrCreateCalls, 1)
  })
})

// ── ⑥ cron/synthetic 的 codex 意图 → 仍降级为非 codex ───────────────────────

describe('⑥ cron/synthetic 的 codex 意图 → 降级为非 codex(既有语义不破)', () => {
  test('agent 默认模型是 codex → 降级到投影里可路由的非 codex 兜底 + 披露原模型', () => {
    const d = decideLocalExecution({
      view: normalView(),
      agent: { id: 'main', model: 'gpt-5.6-sol' },
      defaultModel: 'glm-5.2',
      kind: 'synthetic',
      env: {} as NodeJS.ProcessEnv,
    })
    assert.equal(d.engine, 'ccb')
    assert.equal(d.canonicalModel, 'deepseek-v4-flash', '默认合成兜底')
    assert.equal(d.downgradedFrom, 'gpt-5.6-sol', 'MAJOR-2 透明披露:降级不静默')
  })

  test('env 覆盖的兜底模型也必须过投影(不可路由 → 换下一级,不是"换个必 401 的模型")', () => {
    const d = decideLocalExecution({
      view: normalView(),
      agent: { id: 'main', model: 'gpt-5.6-sol' },
      defaultModel: 'glm-5.2',
      kind: 'synthetic',
      env: { OPENCLAUDE_SYNTHETIC_TURN_MODEL: 'not-in-projection' } as NodeJS.ProcessEnv,
    })
    assert.equal(d.canonicalModel, 'deepseek-v4-flash')

    const d2 = decideLocalExecution({
      view: normalView(),
      agent: { id: 'main', model: 'gpt-5.6-sol' },
      defaultModel: 'glm-5.2',
      kind: 'synthetic',
      env: { OPENCLAUDE_SYNTHETIC_TURN_MODEL: 'glm-5.2' } as NodeJS.ProcessEnv,
    })
    assert.equal(d2.canonicalModel, 'glm-5.2', 'env 兜底在投影里 → 用它')
  })

  test('投影里没有任何可路由的非 codex 模型 → MODEL_NOT_AVAILABLE(不静默落 codex)', () => {
    assert.throws(
      () =>
        decideLocalExecution({
          view: view([row('gpt-5.6-sol', 'codex')]),
          agent: { id: 'main', model: 'gpt-5.6-sol' },
          kind: 'synthetic',
          env: {} as NodeJS.ProcessEnv,
        }),
      (err: unknown) => (err as { code?: string })?.code === 'MODEL_NOT_AVAILABLE',
    )
  })

  test('codex-native pin 的 cron(synthetic)→ 仍是结构化拒(model 替换救不了 pin)', () => {
    assert.throws(
      () => decideLocalExecution({ view: normalView(), agent: CODEX_PINNED, kind: 'synthetic' }),
      (err: unknown) => (err as { code?: string })?.code === 'DELEGATE_CODEX_UNSUPPORTED',
    )
  })
})

// ── 脚手架 ───────────────────────────────────────────────────────────────────

function makeConfig(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.2' },
  } as unknown as OpenClaudeConfig
}

/**
 * 把 ccb/codex factory 换成**计数即失败**的桩:任何一次 createEngine 调用都会被记到 count。
 * restore() 用与 ccbAdapter/codexAdapter 模块顶层**逐字相同**的注册表达式还原(同进程内
 * 后续用例仍能拿到真 adapter)。
 */
function countingEngines(): { readonly count: number; restore: () => void } {
  const state = { count: 0 }
  const boom = () => {
    state.count++
    throw new Error('createEngine must not be reached')
  }
  registerEngine('ccb', boom)
  registerEngine('codex', boom)
  return {
    get count() {
      return state.count
    },
    restore: () => {
      registerEngine('ccb', (opts: EngineCreateOpts) => new CcbAdapter(opts))
      registerEngine('codex', (opts: EngineCreateOpts) => new CodexAdapter(opts))
    },
  }
}

/** hiddenDelegateLimit.test.ts 同款:Object.create(Gateway.prototype) + 手工 stub。 */
function makeDelegateGateway(): any {
  const main = { id: 'main', model: 'glm-5.2' }
  const codexLeader = { id: 'codex-leader', model: 'gpt-5.6-sol', provider: 'codex-native' }
  const coding = { id: 'coding-assistant', model: 'glm-5.2' }
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw.clientsByPeer = new Map()
  gw.lastActiveChannel = new Map()
  gw._seenIdempotencyKeys = new Map()
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.rateLimiter = { check: () => true }
  gw.deps = {
    config: {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test' },
      auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
      defaults: { model: 'glm-5.2', permissionMode: 'default' },
      channels: { webchat: { enabled: true } },
    },
  }
  gw._getAgentsConfig = async () => ({ default: 'main', agents: [main, codexLeader, coding] })
  gw._isIdempotencyDuplicate = () => false
  gw._markIdempotencyKey = () => {}
  gw._runLog = { start: () => ({}), complete: () => {} }
  gw.sessions = {
    getOrCreateCalls: 0,
    destroySession: async () => {},
    beginClientTurn: () => {},
    endClientTurn: () => {},
    getByKey: () => undefined,
    getOrCreate: async () => {
      gw.sessions.getOrCreateCalls++
      return {
        agentId: 'x',
        currentTurnStatus: null,
        runner: { interrupt: () => {}, sendPermissionResponse: () => {} },
      }
    },
    submit: async (_s: unknown, _p: string, onEvent: (e: any) => void) => {
      onEvent({ kind: 'block', block: { kind: 'text', text: 'done' } })
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
  }
  gw.deliver = () => {}
  return gw
}

async function runDelegate(
  gw: any,
  targetAgentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const req: any = { method: 'POST', headers: {} }
  gw.readBody = async () => JSON.stringify(body)
  let status = 0
  let raw = ''
  const res: any = {
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: unknown) => {
      raw = String(chunk ?? '')
    },
  }
  await gw.handleDelegateTask(req, res, targetAgentId)
  return { status, body: raw ? JSON.parse(raw) : {} }
}
