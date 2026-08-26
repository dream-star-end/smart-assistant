/**
 * resolveSyntheticTurnModel — 服务端合成首帧(cron/webhook/task/inter-agent/openai-compat)
 * 的执行模型解析回归测试。
 *
 * 铁律对偶面:codex engine 的真扣费依赖 master bridge 铸造的 server-owned requestId +
 * preCheck/journal 编排;这些进程内合成首帧铸不出该 requestId,host 平台 agent 又无
 * per-user 计费主体,故**不得落 codex**(否则 CODEX_BILLING_GUARD 100% fail-closed 拒)。
 * 本函数把"解析为 codex 的合成首帧"改路由到显式非 codex 模型(返回 { model, originalModel,
 * downgraded } 供用户面透明披露 —— MAJOR-2),并 respect 已是非 codex 的配置(不改变既有行为)。
 *
 * MAJOR-1 routable 自检:兜底模型必须在当前进程形态下真正可路由(host 需对应平台静态 key
 * 经 seam 注入),否则**不降级**返回 undefined(保持 CODEX_BILLING_GUARD fail-closed)。故本套
 * 用例默认注入全量静态 key seam;个别用例显式清空以验证 routable gate。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/syntheticTurnModel.test.ts
 */

import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveExecutionModel,
  resolveSyntheticTurnModel,
  SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT,
} from '../server.js'
import { setHostStaticProviderKeys } from '../hostStaticProviders.js'
import type { AgentDef } from '@openclaude/storage'
import { AGENT_MODEL_AUTO } from '@openclaude/protocol'

const ENV_KEY = 'OPENCLAUDE_SYNTHETIC_TURN_MODEL'
const savedEnv = process.env[ENV_KEY]

// routable 自检需要 host 上有对应静态 provider 的平台 key;测试进程非容器,故显式注入
// 全量 seam(等价 commercial 已装配)。个别用例覆盖 gate 时会重设。
const FULL_KEYS = {
  deepseek: 'sk-deep',
  minimax: 'ark-agent',
  ark: 'ark-coding',
  opencodego: 'og-key',
  kimi: 'ark-agent',
}

beforeEach(() => setHostStaticProviderKeys({ ...FULL_KEYS }))

afterEach(() => {
  setHostStaticProviderKeys(null)
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

function agent(partial: Partial<AgentDef>): Pick<AgentDef, 'id' | 'model' | 'provider'> {
  return { id: 'main', ...partial } as Pick<AgentDef, 'id' | 'model' | 'provider'>
}

describe('resolveExecutionModel × AGENT_MODEL_AUTO(不锁模型的预设 agent)', () => {
  test('agent.model=auto 被候选阶梯跳过:帧模型优先,缺省落 fallback(与无 model 同形)', () => {
    assert.equal(resolveExecutionModel('glm-5.3', AGENT_MODEL_AUTO), 'glm-5.3')
    assert.equal(resolveExecutionModel(undefined, AGENT_MODEL_AUTO), 'glm-5.3-zai')
    assert.equal(resolveExecutionModel(AGENT_MODEL_AUTO, 'MiniMax-M3'), 'MiniMax-M3')
  })

  test('auto 单独出现 → 平台兜底(不会把 "auto" 当模型 id 泄给 runner)', () => {
    assert.equal(resolveExecutionModel(AGENT_MODEL_AUTO, undefined), 'glm-5.3-zai')
    assert.notEqual(resolveExecutionModel(AGENT_MODEL_AUTO, undefined), 'auto')
  })

  test('auto 的合成首帧语义:归一到平台默认(非 codex)→ 不降级、不干预', () => {
    delete process.env[ENV_KEY]
    assert.equal(resolveSyntheticTurnModel(agent({ model: AGENT_MODEL_AUTO }), undefined), undefined)
  })
})

describe('resolveSyntheticTurnModel', () => {
  test('host main 复现:agent 无 model + defaults=gpt-5.6-sol(codex)→ 降级到非 codex 兜底(带 originalModel)', () => {
    // 线上 openclaude.json defaults.model=gpt-5.6-sol;cron 的 main agent 无自带 model。
    delete process.env[ENV_KEY]
    const r = resolveSyntheticTurnModel(agent({ model: undefined }), 'gpt-5.6-sol')
    assert.deepEqual(r, {
      model: SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT,
      originalModel: 'gpt-5.6-sol',
      downgraded: true,
    })
  })

  test('agent.model 显式 gpt-5.6-sol(codex)→ 降级为非 codex 兜底', () => {
    delete process.env[ENV_KEY]
    const r = resolveSyntheticTurnModel(agent({ model: 'gpt-5.6-sol' }), 'glm-5.2')
    assert.equal(r?.model, SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT)
    assert.equal(r?.originalModel, 'gpt-5.6-sol')
    assert.equal(r?.downgraded, true)
  })

  test('agent.model 已是非 codex(glm-5.2)→ undefined(尊重原配置,行为不变)', () => {
    delete process.env[ENV_KEY]
    assert.equal(resolveSyntheticTurnModel(agent({ model: 'glm-5.2' }), 'gpt-5.6-sol'), undefined)
  })

  test('defaults 非 codex + agent 无 model → undefined(不覆盖)', () => {
    delete process.env[ENV_KEY]
    assert.equal(resolveSyntheticTurnModel(agent({ model: undefined }), 'glm-5.2'), undefined)
  })

  test('codex-native 硬 pin → undefined(model 替换救不了 provider pin,保持 fail-closed)', () => {
    delete process.env[ENV_KEY]
    // provider pin 下即便 defaults 是 codex,也返回 undefined —— 交由 guard fail-closed,
    // 不静默降级到 CCB(显式 codex 意图 + 无扣费主体 = 显式拒)。
    assert.equal(
      resolveSyntheticTurnModel(agent({ provider: 'codex-native', model: undefined }), 'gpt-5.6-sol'),
      undefined,
    )
  })

  test('下线/非法 agent.model 被 resolveExecutionModel 收敛到 codex 默认 → 仍降级', () => {
    // agent.model 不在白名单(如残留下线模型)→ resolveExecutionModel 回落 defaults=gpt-5.6-sol
    // → 实际会落 codex,必须同样降级(不能因 agent.model 字面非 codex 而漏判)。
    delete process.env[ENV_KEY]
    const r = resolveSyntheticTurnModel(agent({ model: 'claude-3-7-sonnet-retired' }), 'gpt-5.6-sol')
    assert.equal(r?.model, SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT)
    assert.equal(r?.originalModel, 'gpt-5.6-sol')
  })

  test('env 覆盖为合法且可路由的非 codex 模型 → 采用', () => {
    process.env[ENV_KEY] = 'deepseek-v4-flash'
    const r = resolveSyntheticTurnModel(agent({ model: 'gpt-5.6-sol' }), 'glm-5.2')
    assert.equal(r?.model, 'deepseek-v4-flash')
    assert.equal(r?.originalModel, 'gpt-5.6-sol')
  })

  test('env 覆盖为 codex 模型(gpt-5.6-sol)→ 忽略,回默认(防把 bug 换个门再引入)', () => {
    process.env[ENV_KEY] = 'gpt-5.6-sol'
    const r = resolveSyntheticTurnModel(agent({ model: 'gpt-5.6-sol' }), 'glm-5.2')
    assert.equal(r?.model, SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT)
  })

  test('env 覆盖为白名单外模型 → 忽略,回默认(否则会被 resolveExecutionModel 收敛掉)', () => {
    process.env[ENV_KEY] = 'some-unlisted-model'
    const r = resolveSyntheticTurnModel(agent({ model: 'gpt-5.6-sol' }), 'gpt-5.6-sol')
    assert.equal(r?.model, SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT)
  })

  test('兜底默认自身必须非 codex 且在白名单内(闭环自检)', () => {
    // SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT 必须能通过 resolveExecutionModel 不被收敛,
    // 且解析结果非 codex —— 否则替换后仍触 guard。用"agent.model=默认值 + defaults 非 codex"
    // 反查:结果应为 undefined(说明默认值被判为非 codex,不再触发替换,routable 自检前即返回)。
    delete process.env[ENV_KEY]
    assert.equal(
      resolveSyntheticTurnModel(agent({ model: SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT }), 'glm-5.2'),
      undefined,
    )
  })

  // ── MAJOR-1 routable 自检 ────────────────────────────────────────────────
  test('routable gate:host + seam 未注入(兜底不可路由)→ undefined(保持 fail-closed,不换必 401 模型)', () => {
    delete process.env[ENV_KEY]
    setHostStaticProviderKeys(null)
    assert.equal(resolveSyntheticTurnModel(agent({ model: 'gpt-5.6-sol' }), 'glm-5.2'), undefined)
  })

  test('routable gate:兜底 deepseek-v4-flash 但 seam 只有 ark key → undefined(该 provider 不可路由)', () => {
    delete process.env[ENV_KEY]
    setHostStaticProviderKeys({ ark: 'ark-coding' })
    assert.equal(resolveSyntheticTurnModel(agent({ model: 'gpt-5.6-sol' }), 'glm-5.2'), undefined)
  })

  test('routable gate:env 覆盖到 MiniMax-M3 但 seam 缺 minimax key → undefined', () => {
    process.env[ENV_KEY] = 'MiniMax-M3'
    setHostStaticProviderKeys({ deepseek: 'sk-deep' })
    assert.equal(resolveSyntheticTurnModel(agent({ model: 'gpt-5.6-sol' }), 'glm-5.2'), undefined)
  })

  test('routable gate:容器身份下兜底恒可路由(经 internal proxy)→ 正常降级', () => {
    // 容器进程 isHostRoutableStaticModel 恒 true,即便 seam 未注入也降级(容器经 master
    // internal proxy 按模型名路由静态 provider)。
    delete process.env[ENV_KEY]
    setHostStaticProviderKeys(null)
    const prevContainer = process.env.OC_CONTAINER_ID
    process.env.OC_CONTAINER_ID = 'c-test'
    try {
      const r = resolveSyntheticTurnModel(agent({ model: 'gpt-5.6-sol' }), 'glm-5.2')
      assert.equal(r?.model, SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT)
      assert.equal(r?.originalModel, 'gpt-5.6-sol')
    } finally {
      if (prevContainer === undefined) delete process.env.OC_CONTAINER_ID
      else process.env.OC_CONTAINER_ID = prevContainer
    }
  })
})
