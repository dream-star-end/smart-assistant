/**
 * hostStaticProviders — host(master 进程、非容器)CCB 静态 provider 平台直连路由回归测试。
 *
 * 覆盖(MAJOR-1):
 *   - isV3ContainerRuntime 双信号收口;
 *   - resolveHostStaticProviderEnv:容器 null / 个人版 null / 非静态模型 null / bearer 与
 *     x-api-key 两种 authScheme 的 env 组装 / BASE_URL 去 /v1/messages / NO_PROXY 追加去重 /
 *     另一鉴权字段显式置空 / key 缺失 throw fail-closed;
 *   - isHostRoutableStaticModel 各分支(routable 自检,resolveSyntheticTurnModel 降级决策消费);
 *   - seam set/get/clear 生命周期;
 *   - subprocessRunner 顺序不变量:host static env 键与 secondary-model 注入键不相交(证明注入
 *     不会被后续 _buildSecondaryUtilityModelEnv 的 Object.assign 清空)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/hostStaticProviders.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  isV3ContainerRuntime,
  resolveHostStaticProviderEnv,
  isHostRoutableStaticModel,
  setHostStaticProviderKeys,
  getHostStaticProviderKeys,
} from '../hostStaticProviders.js'
import { _buildSecondaryUtilityModelEnv, buildHostSpawnProviderEnv } from '../subprocessRunner.js'

// 每个用例后清空模块级 seam,避免 cross-test 污染(isHostRoutableStaticModel 读模块全局)。
afterEach(() => setHostStaticProviderKeys(null))

describe('isV3ContainerRuntime — 双信号 OR 兜底', () => {
  it('OC_CONTAINER_ID 存在 → true', () => {
    assert.equal(isV3ContainerRuntime({ OC_CONTAINER_ID: 'c-1' }), true)
  })
  it('CLAUDE_CONFIG_DIR === /run/oc/claude-config(降级模式无 OC_CONTAINER_ID)→ true', () => {
    assert.equal(isV3ContainerRuntime({ CLAUDE_CONFIG_DIR: '/run/oc/claude-config' }), true)
  })
  it('host/dev 两信号都无 → false', () => {
    assert.equal(isV3ContainerRuntime({}), false)
    // CLAUDE_CONFIG_DIR 是别的值(个人版/dev)不误判为容器。
    assert.equal(isV3ContainerRuntime({ CLAUDE_CONFIG_DIR: '/home/agent/.claude' }), false)
  })
})

describe('resolveHostStaticProviderEnv', () => {
  it('容器身份 → null(绝不覆盖容器 internal proxy env)', () => {
    assert.equal(
      resolveHostStaticProviderEnv('deepseek-v4-pro', {
        keys: { deepseek: 'k' },
        env: { OC_CONTAINER_ID: 'c-1' },
      }),
      null,
    )
  })

  it('个人版:seam 未注入(keys=null)→ null(settings.json 继续掌权)', () => {
    assert.equal(resolveHostStaticProviderEnv('deepseek-v4-pro', { keys: null, env: {} }), null)
  })

  it('模型不属静态 provider(OAuth/codex gpt-5.6-sol)→ null(不干预)', () => {
    assert.equal(resolveHostStaticProviderEnv('gpt-5.6-sol', { keys: { deepseek: 'k' }, env: {} }), null)
  })

  it('model undefined → null', () => {
    assert.equal(resolveHostStaticProviderEnv(undefined, { keys: { deepseek: 'k' }, env: {} }), null)
  })

  it('host + deepseek(bearer)→ AUTH_TOKEN 注入 / API_KEY 置空 / BASE_URL 去 /v1/messages / NO_PROXY 含上游 host', () => {
    const r = resolveHostStaticProviderEnv('deepseek-v4-pro', { keys: { deepseek: 'sk-deep' }, env: {} })
    assert.ok(r)
    assert.equal(r.providerId, 'deepseek')
    assert.equal(r.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1')
    assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'sk-deep')
    // 另一鉴权字段显式置空,防 stray env 按 CCB 优先级(AUTH_TOKEN > API_KEY)串路由。
    assert.equal(r.env.ANTHROPIC_API_KEY, '')
    assert.ok(r.env.NO_PROXY.split(',').includes('api.deepseek.com'))
    assert.equal(r.env.no_proxy, r.env.NO_PROXY)
  })

  it('host + opencodego(x-api-key)→ API_KEY 注入 / AUTH_TOKEN 置空', () => {
    const r = resolveHostStaticProviderEnv('qwen3.7-max', { keys: { opencodego: 'og-key' }, env: {} })
    assert.ok(r)
    assert.equal(r.providerId, 'opencodego')
    assert.equal(r.env.ANTHROPIC_API_KEY, 'og-key')
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, '')
    assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://opencode.ai/zen/go')
    assert.ok(r.env.NO_PROXY.split(',').includes('opencode.ai'))
  })

  it('host-static 显式清空继承的 OAuth 凭据(x-api-key provider 防宿主残留 OAuth token 被误判 subscriber)', () => {
    const r = resolveHostStaticProviderEnv('qwen3.7-max', {
      keys: { opencodego: 'og-key' },
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'stale-oauth', ANTHROPIC_MODEL: 'gpt-5.6-sol' },
    })
    assert.ok(r)
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, '') // 显式清空,不靠 AUTH_TOKEN 遮蔽(x-api-key 路径没有 AUTH_TOKEN)
    assert.equal(r.env.ANTHROPIC_MODEL, '') // 清宿主 pin,防串模型
    assert.equal(r.env.ANTHROPIC_API_KEY, 'og-key')
  })

  it('已存在 NO_PROXY → 追加上游 host(不覆盖既有),已列则不重复追加', () => {
    const r = resolveHostStaticProviderEnv('deepseek-v4-pro', {
      keys: { deepseek: 'k' },
      env: { NO_PROXY: 'localhost,foo.com' },
    })
    assert.equal(r?.env.NO_PROXY, 'localhost,foo.com,api.deepseek.com')
    const r2 = resolveHostStaticProviderEnv('deepseek-v4-pro', {
      keys: { deepseek: 'k' },
      env: { NO_PROXY: 'api.deepseek.com' },
    })
    assert.equal(r2?.env.NO_PROXY, 'api.deepseek.com')
  })

  it('host + 模型属静态 provider 但 key 缺失 → throw(fail-closed,不 spawn 必 401 的 CCB)', () => {
    assert.throws(
      () => resolveHostStaticProviderEnv('deepseek-v4-pro', { keys: { ark: 'only-ark' }, env: {} }),
      /host 静态 provider 'deepseek'.*平台 key 未配置/,
    )
  })
})

describe('isHostRoutableStaticModel — routable 自检各分支', () => {
  it('容器身份 → 恒 true(经 master internal proxy 按模型名可达)', () => {
    setHostStaticProviderKeys(null)
    assert.equal(isHostRoutableStaticModel('deepseek-v4-pro', { OC_CONTAINER_ID: 'c-1' }), true)
  })
  it('host + seam 未注入(个人版/dev)→ false', () => {
    setHostStaticProviderKeys(null)
    assert.equal(isHostRoutableStaticModel('deepseek-v4-pro', {}), false)
  })
  it('host + seam 注入且该 provider key 存在 → true', () => {
    setHostStaticProviderKeys({ deepseek: 'k' })
    assert.equal(isHostRoutableStaticModel('deepseek-v4-pro', {}), true)
  })
  it('host + seam 注入但该 provider key 缺失 → false', () => {
    setHostStaticProviderKeys({ ark: 'k' })
    assert.equal(isHostRoutableStaticModel('deepseek-v4-pro', {}), false)
  })
  it('host + 模型不属任何静态 provider(codex)→ false', () => {
    setHostStaticProviderKeys({ deepseek: 'k' })
    assert.equal(isHostRoutableStaticModel('gpt-5.6-sol', {}), false)
  })
})

describe('setHostStaticProviderKeys seam 生命周期', () => {
  it('默认 null → 注入 → 读取 → 清理', () => {
    assert.equal(getHostStaticProviderKeys(), null)
    setHostStaticProviderKeys({ deepseek: 'k' })
    assert.deepEqual(getHostStaticProviderKeys(), { deepseek: 'k' })
    setHostStaticProviderKeys(null)
    assert.equal(getHostStaticProviderKeys(), null)
  })
})

describe('buildHostSpawnProviderEnv — 路由决策对称性(MAJOR/MINOR 2026-07-07)', () => {
  it('MAJOR:claude-subscription + OAuth + deepseek-v4-pro → host-static 优先(不清空 BASE_URL,不走 OAuth direct)', () => {
    // 对称性根治:合成首帧已裁定跑静态 provider,agent=claude-subscription 也不得把出站改回
    // direct-Anthropic。否则 isHostRoutableStaticModel 说 deepseek 可路由、spawn 却把它发去
    // api.anthropic.com 必挂。
    const r = buildHostSpawnProviderEnv({
      model: 'deepseek-v4-pro',
      effectiveProvider: 'claude-subscription',
      claudeOAuthAccessToken: 'oauth-tok',
      hostStaticKeys: { deepseek: 'sk-deep' },
      env: {},
    })
    assert.equal(r.routing, 'host-static')
    assert.equal(r.providerId, 'deepseek')
    assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic') // 未被 OAuth 分支清空
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'sk-deep')
    assert.equal(r.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1')
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, '') // 显式清空(round-3 加固),非 oauth-tok → 未走 OAuth direct
    assert.equal(r.env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-v4-pro') // secondary 同 provider
  })

  it('MINOR:host-static 指向 ark(glm-5.2)→ secondary 用主模型(glm-5.2),不跨 provider 打 deepseek-v4-flash', () => {
    const r = buildHostSpawnProviderEnv({
      model: 'glm-5.2',
      effectiveProvider: 'claude-subscription',
      claudeOAuthAccessToken: 'oauth-tok',
      hostStaticKeys: { ark: 'ark-coding' },
      env: {},
    })
    assert.equal(r.routing, 'host-static')
    assert.equal(r.providerId, 'ark')
    assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://ark.cn-beijing.volces.com/api/coding')
    assert.equal(r.env.ANTHROPIC_SMALL_FAST_MODEL, 'glm-5.2')
    assert.notEqual(r.env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-v4-flash')
  })

  it('claude-subscription + OAuth + 非静态模型 → oauth-direct(清空 BASE_URL,不 pin secondary)', () => {
    const r = buildHostSpawnProviderEnv({
      model: 'claude-opus-4-7', // 不属任何静态 provider
      effectiveProvider: 'claude-subscription',
      claudeOAuthAccessToken: 'oauth-tok',
      hostStaticKeys: { deepseek: 'sk-deep' }, // seam 有 key 但模型非静态 → hostStatic=null
      env: {},
    })
    assert.equal(r.routing, 'oauth-direct')
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-tok')
    assert.equal(r.env.ANTHROPIC_BASE_URL, '')
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, '')
    assert.equal(r.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1')
    assert.equal(r.env.ANTHROPIC_SMALL_FAST_MODEL, undefined) // direct-Anthropic 留 Haiku
  })

  it('claude-subscription 无 OAuth token → settings-default(MANAGED_BY_HOST 仍设 + secondary 注入)', () => {
    const prev = process.env.OPENCLAUDE_SECONDARY_MODEL
    delete process.env.OPENCLAUDE_SECONDARY_MODEL
    try {
      const r = buildHostSpawnProviderEnv({
        model: 'claude-opus-4-7',
        effectiveProvider: 'claude-subscription',
        claudeOAuthAccessToken: undefined,
        hostStaticKeys: null,
        env: {},
      })
      assert.equal(r.routing, 'settings-default')
      assert.equal(r.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1')
      assert.equal(r.env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-v4-flash')
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_SECONDARY_MODEL
      else process.env.OPENCLAUDE_SECONDARY_MODEL = prev
    }
  })

  it('非 claude-subscription + seam 未注入(个人版)→ settings-default(零行为变化,secondary=deepseek-v4-flash)', () => {
    const prev = process.env.OPENCLAUDE_SECONDARY_MODEL
    delete process.env.OPENCLAUDE_SECONDARY_MODEL
    try {
      const r = buildHostSpawnProviderEnv({
        model: 'glm-5.2',
        effectiveProvider: 'minimax',
        hostStaticKeys: null,
        env: {},
      })
      assert.equal(r.routing, 'settings-default')
      assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
      assert.equal(r.env.ANTHROPIC_BASE_URL, undefined) // 不注入 provider auth,靠 settings.json
      assert.equal(r.env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-v4-flash')
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_SECONDARY_MODEL
      else process.env.OPENCLAUDE_SECONDARY_MODEL = prev
    }
  })

  // 注:这是**不可达防护**场景,非生产路径。生产上容器静态模型走 master internal proxy
  // (commercial runtime entrypoint 会 scrub provider-routing env,minimal openclaude.json 不写
  // claudeOAuth),不会同时出现"容器身份 + claude-subscription + OAuth"。此用例只钉住一条不变量:
  // **host static 恒让位容器身份**(容器内 resolveHostStaticProviderEnv 返回 null,不抢占容器 proxy
  // 路由)。勿据此反推"容器静态模型应走 OAuth direct"——容器静态模型的权威路由是 internal proxy。
  it('容器身份让位(不可达防护:容器内 host static 恒返回 null,不抢占容器 proxy 路由)', () => {
    const r = buildHostSpawnProviderEnv({
      model: 'deepseek-v4-pro',
      effectiveProvider: 'claude-subscription',
      claudeOAuthAccessToken: 'oauth-tok',
      hostStaticKeys: { deepseek: 'sk-deep' },
      env: { OC_CONTAINER_ID: 'c-1' }, // 容器身份 → resolveHostStaticProviderEnv null
    })
    assert.equal(r.routing, 'oauth-direct')
    assert.equal(r.env.ANTHROPIC_BASE_URL, '')
  })

  it('host + 模型属静态 provider 但 key 缺失 → throw(fail-closed,冒泡到 start 清理)', () => {
    assert.throws(
      () =>
        buildHostSpawnProviderEnv({
          model: 'deepseek-v4-pro',
          effectiveProvider: 'minimax',
          hostStaticKeys: { ark: 'x' }, // deepseek key 缺失
          env: {},
        }),
      /平台 key 未配置/,
    )
  })
})

describe('subprocessRunner 顺序不变量 — host static env 不被 secondary-model 注入清空', () => {
  it('_buildSecondaryUtilityModelEnv 只设 ANTHROPIC_SMALL_FAST_MODEL,与 host static 路由键不相交', () => {
    // subprocessRunner.start 在注入 hostStatic.env 之后(非 direct-Anthropic 路径)会
    // Object.assign(_buildSecondaryUtilityModelEnv())。若二者键相交(尤其 ANTHROPIC_BASE_URL /
    // ANTHROPIC_AUTH_TOKEN),host 直连路由会被清空 → 必 401。这里从 env 构造层守住该不变量。
    const hostStatic = resolveHostStaticProviderEnv('deepseek-v4-pro', { keys: { deepseek: 'k' }, env: {} })
    assert.ok(hostStatic)
    const secondary = _buildSecondaryUtilityModelEnv()
    assert.deepEqual(Object.keys(secondary), ['ANTHROPIC_SMALL_FAST_MODEL'])
    const overlap = Object.keys(hostStatic.env).filter((k) => k in secondary)
    assert.deepEqual(overlap, [], `secondary 注入不得覆盖 host static 路由键;实际相交=${overlap.join(',')}`)
  })
})
