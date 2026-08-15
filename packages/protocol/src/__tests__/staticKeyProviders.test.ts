/**
 * 静态 key 文本 provider 注册表测试。
 *
 * 跑法: npx tsx --test packages/protocol/src/__tests__/staticKeyProviders.test.ts
 *
 * 覆盖:
 *   - matchesRoute(deepseek 大小写敏感前缀 / minimax,ark 精确大小写不敏感)
 *   - inboundModelIds 精确字面量(Flash 归 OpenCode Go；direct DeepSeek 只保留 Pro)
 *   - canonicalizeForPricing(deepseek→null 原样 / minimax→MiniMax-M3 / ark→glm-5.1)
 *   - findRouteProviderForModel / STATIC_KEY_INBOUND_MODEL_IDS
 *   - 漂移守护:protocol-owned 字段与仓库根 static-key-providers.snapshot.json 一致
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  STATIC_KEY_PROVIDERS,
  STATIC_KEY_INBOUND_MODEL_IDS,
  findRouteProviderForModel,
  getStaticProvider,
  type StaticProviderId,
} from '../staticKeyProviders.js'

describe('staticKeyProviders — matchesRoute', () => {
  it('deepseek 大小写敏感前缀家族', () => {
    const ds = getStaticProvider('deepseek')
    assert.equal(ds.matchesRoute('deepseek-v4-pro'), true)
    assert.equal(ds.matchesRoute('deepseek-chat'), true)
    assert.equal(ds.matchesRoute('deepseek-v4-flash'), false)
    assert.equal(ds.matchesRoute('deepseek-v4-flash-opencode-go'), false)
    assert.equal(ds.matchesRoute('deepseek-V4-Flash-OpenCode-Go'), false)
    // 大小写敏感:大写 D 不命中(等价 shared.ts:87 现状)
    assert.equal(ds.matchesRoute('DeepSeek-v4-pro'), false)
    assert.equal(ds.matchesRoute('claude-x'), false)
  })
  it('minimax 精确,大小写不敏感', () => {
    const mm = getStaticProvider('minimax')
    assert.equal(mm.matchesRoute('MiniMax-M3'), true)
    assert.equal(mm.matchesRoute('minimax-m3'), true)
    assert.equal(mm.matchesRoute('minimax-m2'), false)
  })
  it('ark(glm-5.1 + glm-5.2 + glm-5.3)精确,大小写不敏感', () => {
    const ark = getStaticProvider('ark')
    assert.equal(ark.matchesRoute('glm-5.1'), true)
    assert.equal(ark.matchesRoute('GLM-5.1'), true)
    assert.equal(ark.matchesRoute('glm-5.2'), true)
    assert.equal(ark.matchesRoute('GLM-5.2'), true)
    assert.equal(ark.matchesRoute('glm-5.3'), true)
    assert.equal(ark.matchesRoute('GLM-5.3'), true)
    assert.equal(ark.matchesRoute('glm-5'), false)
    assert.equal(ark.matchesRoute('glm-5.4'), false)
  })
  it('zai 只匹配独立 glm-5.3-zai alias，不抢 Ark glm-5.3', () => {
    const zai = getStaticProvider('zai')
    assert.equal(zai.matchesRoute('glm-5.3-zai'), true)
    assert.equal(zai.matchesRoute('GLM-5.3-ZAI'), true)
    assert.equal(zai.matchesRoute('glm-5.3'), false)
    assert.equal(zai.matchesRoute('glm-5.3-zai-preview'), false)
    assert.equal(getStaticProvider('ark').matchesRoute('glm-5.3-zai'), false)
  })
  it('opencodego(Flash canonical + 历史 alias + qwen3.7 legacy)精确,大小写不敏感', () => {
    const og = getStaticProvider('opencodego')
    assert.equal(og.matchesRoute('deepseek-v4-flash-opencode-go'), true)
    assert.equal(og.matchesRoute('DeepSeek-V4-Flash-OpenCode-Go'), true)
    assert.equal(og.matchesRoute('deepseek-v4-flash'), true)
    assert.equal(og.matchesRoute('DeepSeek-V4-Flash'), true)
    assert.equal(og.matchesRoute('qwen3.7-max'), true)
    assert.equal(og.matchesRoute('Qwen3.7-Max'), true)
    assert.equal(og.matchesRoute('qwen3.7-plus'), true)
    assert.equal(og.matchesRoute('QWEN3.7-PLUS'), true)
    assert.equal(og.matchesRoute('qwen3.6-plus'), false)
    assert.equal(og.matchesRoute('qwen3.7'), false)
    assert.equal(og.matchesRoute('qwen3.7-max-preview'), false)
  })
  it('kimi(kimi-k2.7-code)精确,大小写不敏感', () => {
    const km = getStaticProvider('kimi')
    assert.equal(km.matchesRoute('kimi-k2.7-code'), true)
    assert.equal(km.matchesRoute('Kimi-K2.7-Code'), true)
    assert.equal(km.matchesRoute('kimi-k2.7'), false)
    assert.equal(km.matchesRoute('kimi-k2.6'), false)
    assert.equal(km.matchesRoute('kimi-k2.7-code-preview'), false)
  })
  it('moonshot(kimi-k3/k3-256k)精确,大小写不敏感;与 kimi(k2.7)互不越界', () => {
    const ms = getStaticProvider('moonshot')
    assert.equal(ms.matchesRoute('kimi-k3'), true)
    assert.equal(ms.matchesRoute('Kimi-K3'), true)
    assert.equal(ms.matchesRoute('k3-256k'), true)
    assert.equal(ms.matchesRoute('K3-256K'), true)
    assert.equal(ms.matchesRoute('kimi-k3-preview'), false)
    assert.equal(ms.matchesRoute('k3-256k-preview'), false)
    assert.equal(ms.matchesRoute('k3-128k'), false)
    assert.equal(ms.matchesRoute('kimi-k2.7-code'), false)
    // 两家 kimi 上游的路由面必须互斥:k2.7 → 火山 'kimi',k3 → 官方 'moonshot'
    assert.equal(getStaticProvider('kimi').matchesRoute('kimi-k3'), false)
  })
  it('ark-k3 只匹配平台 alias kimi-k3-ark，不抢 Moonshot 官方 kimi-k3', () => {
    const arkK3 = getStaticProvider('ark-k3')
    assert.equal(arkK3.matchesRoute('kimi-k3-ark'), true)
    assert.equal(arkK3.matchesRoute('Kimi-K3-Ark'), true)
    assert.equal(arkK3.matchesRoute('kimi-k3'), false)
    assert.equal(getStaticProvider('moonshot').matchesRoute('kimi-k3-ark'), false)
  })
  it('bailian 只匹配正式 qwen3.8-max，不抢 preview/旧 Qwen', () => {
    const bailian = getStaticProvider('bailian')
    assert.equal(bailian.matchesRoute('qwen3.8-max'), true)
    assert.equal(bailian.matchesRoute('Qwen3.8-Max'), true)
    assert.equal(bailian.matchesRoute('qwen3.8-max-preview'), false)
    assert.equal(bailian.matchesRoute('qwen3.7-max'), false)
  })
})

describe('staticKeyProviders — findRouteProviderForModel', () => {
  it('命中各 provider;非静态 → undefined', () => {
    assert.equal(findRouteProviderForModel('deepseek-v4-pro')?.id, 'deepseek')
    assert.equal(findRouteProviderForModel('deepseek-v4-flash')?.id, 'opencodego')
    assert.equal(findRouteProviderForModel('MiniMax-M3')?.id, 'minimax')
    assert.equal(findRouteProviderForModel('glm-5.1')?.id, 'ark')
    assert.equal(findRouteProviderForModel('glm-5.2')?.id, 'ark')
    assert.equal(findRouteProviderForModel('glm-5.3')?.id, 'ark')
    assert.equal(findRouteProviderForModel('glm-5.3-zai')?.id, 'zai')
    assert.equal(findRouteProviderForModel('deepseek-v4-flash-opencode-go')?.id, 'opencodego')
    assert.equal(findRouteProviderForModel('qwen3.7-max')?.id, 'opencodego')
    assert.equal(findRouteProviderForModel('qwen3.7-plus')?.id, 'opencodego')
    assert.equal(findRouteProviderForModel('kimi-k2.7-code')?.id, 'kimi')
    assert.equal(findRouteProviderForModel('kimi-k3-ark')?.id, 'ark-k3')
    assert.equal(findRouteProviderForModel('kimi-k3')?.id, 'moonshot')
    assert.equal(findRouteProviderForModel('k3-256k')?.id, 'moonshot')
    assert.equal(findRouteProviderForModel('qwen3.8-max')?.id, 'bailian')
    assert.equal(findRouteProviderForModel('claude-opus-4-7'), undefined)
    assert.equal(findRouteProviderForModel('DeepSeek-v4-pro'), undefined)
    assert.equal(findRouteProviderForModel(''), undefined)
  })
})

describe('staticKeyProviders — inboundModelIds(与 route 面故意不同)', () => {
  it('deepseek direct 只放 Pro(Flash 已统一归 OpenCode Go)', () => {
    assert.deepEqual([...getStaticProvider('deepseek').inboundModelIds], ['deepseek-v4-pro'])
  })
  it('minimax 1 项 / ark 3 项 / opencodego Flash canonical+alias + 2 个历史 Qwen', () => {
    assert.deepEqual([...getStaticProvider('minimax').inboundModelIds], ['MiniMax-M3'])
    assert.deepEqual([...getStaticProvider('ark').inboundModelIds], ['glm-5.3', 'glm-5.2', 'glm-5.1'])
    assert.deepEqual([...getStaticProvider('zai').inboundModelIds], ['glm-5.3-zai'])
    assert.deepEqual([...getStaticProvider('opencodego').inboundModelIds], [
      'deepseek-v4-flash-opencode-go',
      'deepseek-v4-flash',
      'qwen3.7-max',
      'qwen3.7-plus',
    ])
    assert.deepEqual([...getStaticProvider('kimi').inboundModelIds], ['kimi-k2.7-code'])
    assert.deepEqual([...getStaticProvider('ark-k3').inboundModelIds], ['kimi-k3-ark'])
    assert.deepEqual([...getStaticProvider('moonshot').inboundModelIds], ['kimi-k3', 'k3-256k'])
    assert.deepEqual([...getStaticProvider('bailian').inboundModelIds], ['qwen3.8-max'])
  })
  it('STATIC_KEY_INBOUND_MODEL_IDS = 全 provider 字面量展开', () => {
    assert.deepEqual([...STATIC_KEY_INBOUND_MODEL_IDS], [
      'deepseek-v4-pro',
      'MiniMax-M3',
      'glm-5.3',
      'glm-5.2',
      'glm-5.1',
      'glm-5.3-zai',
      'deepseek-v4-flash-opencode-go',
      'deepseek-v4-flash',
      'qwen3.7-max',
      'qwen3.7-plus',
      'kimi-k2.7-code',
      'kimi-k3-ark',
      'kimi-k3',
      'k3-256k',
      'qwen3.8-max',
    ])
  })
})

describe('staticKeyProviders — canonicalizeForPricing', () => {
  it('deepseek 恒 null(原样透传,与 pricing.ts 历史等价)', () => {
    const ds = getStaticProvider('deepseek')
    assert.equal(ds.canonicalizeForPricing('deepseek-v4-pro'), null)
    assert.equal(ds.canonicalizeForPricing('deepseek-chat'), null)
  })
  it('minimax → MiniMax-M3', () => {
    const mm = getStaticProvider('minimax')
    assert.equal(mm.canonicalizeForPricing('minimax-m3'), 'MiniMax-M3')
    assert.equal(mm.canonicalizeForPricing('MiniMax-M3'), 'MiniMax-M3')
    assert.equal(mm.canonicalizeForPricing('claude-x'), null)
  })
  it('ark → glm-5.1 / glm-5.2 / glm-5.3(各自原样)', () => {
    const ark = getStaticProvider('ark')
    assert.equal(ark.canonicalizeForPricing('GLM-5.1'), 'glm-5.1')
    assert.equal(ark.canonicalizeForPricing('glm-5.1'), 'glm-5.1')
    assert.equal(ark.canonicalizeForPricing('GLM-5.2'), 'glm-5.2')
    assert.equal(ark.canonicalizeForPricing('glm-5.2'), 'glm-5.2')
    assert.equal(ark.canonicalizeForPricing('GLM-5.3'), 'glm-5.3')
    assert.equal(ark.canonicalizeForPricing('glm-5.3'), 'glm-5.3')
    assert.equal(ark.canonicalizeForPricing('glm-5.4'), null)
  })
  it('zai pricing 保持平台 alias；legacy transport 精确改写为上游 glm-5.3', () => {
    const zai = getStaticProvider('zai')
    assert.equal(zai.canonicalizeForPricing('GLM-5.3-ZAI'), 'glm-5.3-zai')
    assert.equal(zai.canonicalizeForPricing('glm-5.3'), null)
    assert.equal(zai.upstreamModelForRequest?.('GLM-5.3-ZAI'), 'glm-5.3')
  })
  it('opencodego → provider-neutral Flash canonical / 历史 alias 同归一 / qwen3.7 legacy', () => {
    const og = getStaticProvider('opencodego')
    assert.equal(og.canonicalizeForPricing('DeepSeek-V4-Flash-OpenCode-Go'), 'deepseek-v4-flash')
    assert.equal(og.upstreamModelForRequest?.('DeepSeek-V4-Flash-OpenCode-Go'), 'deepseek-v4-flash')
    assert.equal(og.canonicalizeForPricing('deepseek-v4-flash'), 'deepseek-v4-flash')
    assert.equal(og.upstreamModelForRequest?.('DeepSeek-V4-Flash'), 'deepseek-v4-flash')
    assert.equal(og.canonicalizeForPricing('qwen3.7-max'), 'qwen3.7-max')
    assert.equal(og.canonicalizeForPricing('Qwen3.7-Max'), 'qwen3.7-max')
    assert.equal(og.canonicalizeForPricing('qwen3.7-plus'), 'qwen3.7-plus')
    assert.equal(og.canonicalizeForPricing('QWEN3.7-PLUS'), 'qwen3.7-plus')
    assert.equal(og.canonicalizeForPricing('qwen3.6-plus'), null)
  })
  it('kimi → kimi-k2.7-code(小写归一)', () => {
    const km = getStaticProvider('kimi')
    assert.equal(km.canonicalizeForPricing('kimi-k2.7-code'), 'kimi-k2.7-code')
    assert.equal(km.canonicalizeForPricing('Kimi-K2.7-Code'), 'kimi-k2.7-code')
    assert.equal(km.canonicalizeForPricing('kimi-k2.6'), null)
  })
  it('moonshot → kimi-k3/k3-256k(分别小写归一)', () => {
    const ms = getStaticProvider('moonshot')
    assert.equal(ms.canonicalizeForPricing('kimi-k3'), 'kimi-k3')
    assert.equal(ms.canonicalizeForPricing('Kimi-K3'), 'kimi-k3')
    assert.equal(ms.canonicalizeForPricing('k3-256k'), 'k3-256k')
    assert.equal(ms.canonicalizeForPricing('K3-256K'), 'k3-256k')
    assert.equal(ms.canonicalizeForPricing('k3-256k-preview'), null)
    assert.equal(ms.canonicalizeForPricing('kimi-k2.7-code'), null)
  })
  it('ark-k3 pricing 保持平台 alias；legacy transport 精确改写为上游 kimi-k3', () => {
    const arkK3 = getStaticProvider('ark-k3')
    assert.equal(arkK3.canonicalizeForPricing('Kimi-K3-Ark'), 'kimi-k3-ark')
    assert.equal(arkK3.canonicalizeForPricing('kimi-k3'), null)
    assert.equal(arkK3.upstreamModelForRequest?.('Kimi-K3-Ark'), 'kimi-k3')
  })
  it('bailian → qwen3.8-max(小写归一)', () => {
    const bailian = getStaticProvider('bailian')
    assert.equal(bailian.canonicalizeForPricing('qwen3.8-max'), 'qwen3.8-max')
    assert.equal(bailian.canonicalizeForPricing('Qwen3.8-Max'), 'qwen3.8-max')
    assert.equal(bailian.canonicalizeForPricing('qwen3.8-max-preview'), null)
  })
})

describe('staticKeyProviders — strip / endpoint', () => {
  it('deepseek strip 仅 anthropic-beta、无 body strip、无 input cap', () => {
    const ds = getStaticProvider('deepseek')
    assert.deepEqual([...ds.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...ds.stripBodyFields], [])
    assert.equal(ds.maxInputTokens, undefined)
  })
  it('minimax strip anthropic-beta + 3 body 字段(**保留 thinking** —— MiniMax-M3 是思考模型,2026-06-16)', () => {
    const mm = getStaticProvider('minimax')
    assert.deepEqual([...mm.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...mm.stripBodyFields], [
      'output_config',
      'context_management',
      'service_tier',
    ])
    assert.equal(mm.stripBodyFields.includes('thinking'), false, 'minimax 不能 strip thinking(直连验证支持)')
    assert.equal(mm.maxInputTokens, 512_000)
  })
  it('ark strip anthropic-beta + 2 body 字段(output_config 改 effort 白名单不整体 strip;**保留 thinking**)', () => {
    const ark = getStaticProvider('ark')
    assert.deepEqual([...ark.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...ark.stripBodyFields], [
      'context_management',
      'service_tier',
    ])
    assert.equal(
      ark.stripBodyFields.includes('output_config'),
      false,
      'ark 不能整体 strip output_config(要透传 effort 思考深度)',
    )
    assert.equal(ark.stripBodyFields.includes('thinking'), false, 'ark 必须不 strip thinking')
    assert.equal(ark.maxInputTokens, 1_000_000)
  })
  it('ark endpoint = 火山方舟 coding plan /v1/messages', () => {
    assert.equal(
      getStaticProvider('ark').upstreamEndpoint,
      'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
    )
  })
  it('zai 使用 Bearer、1M/text-only，并按白名单保留 high|max effort', () => {
    const zai = getStaticProvider('zai')
    assert.equal(zai.upstreamEndpoint, 'https://api.z.ai/api/anthropic/v1/messages')
    assert.equal(zai.authScheme, undefined)
    assert.deepEqual([...zai.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...zai.stripBodyFields], ['context_management', 'service_tier'])
    assert.deepEqual([...(zai.allowedOutputConfigEfforts ?? [])], ['high', 'max'])
    assert.equal(zai.stripDisabledThinking, undefined)
    assert.equal(zai.maxInputTokens, 1_000_000)
    assert.equal(zai.supportsVision, false)
  })
  it('opencodego strip anthropic-beta + 3 body 字段(**保留 thinking**,2026-07-05 实测)+ 1M cap', () => {
    const og = getStaticProvider('opencodego')
    assert.deepEqual([...og.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...og.stripBodyFields], [
      'output_config',
      'context_management',
      'service_tier',
    ])
    assert.equal(og.stripBodyFields.includes('thinking'), false, 'opencodego 不能 strip thinking(实测 enabled/disabled 语义均正确)')
    assert.equal(og.maxInputTokens, 1_000_000)
    assert.equal(og.upstreamEndpoint, 'https://opencode.ai/zen/go/v1/messages')
  })
  it('kimi strip anthropic-beta + 3 body 字段(**保留 thinking**)+ 256k cap + Agent Plan 端点', () => {
    const km = getStaticProvider('kimi')
    assert.deepEqual([...km.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...km.stripBodyFields], [
      'output_config',
      'context_management',
      'service_tier',
    ])
    assert.equal(km.stripBodyFields.includes('thinking'), false, 'kimi 不能 strip thinking(恒思考模型,enabled+budget 实测可用)')
    assert.equal(km.maxInputTokens, 256_000)
    assert.equal(
      km.upstreamEndpoint,
      'https://ark.cn-beijing.volces.com/api/plan/v1/messages',
      'kimi 与 minimax 同 Agent Plan 端点(同订阅同 key,独立 spec)',
    )
  })
  it('ark-k3 共用 Agent Plan 端点，但为 1M/vision 且保留 disabled thinking', () => {
    const arkK3 = getStaticProvider('ark-k3')
    assert.deepEqual([...arkK3.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...arkK3.stripBodyFields], [
      'output_config',
      'context_management',
      'service_tier',
    ])
    assert.equal(arkK3.stripBodyFields.includes('thinking'), false)
    assert.equal(arkK3.stripDisabledThinking, undefined)
    assert.equal(arkK3.maxInputTokens, 1_048_576)
    assert.equal(arkK3.supportsVision, true)
    assert.equal(
      arkK3.upstreamEndpoint,
      'https://ark.cn-beijing.volces.com/api/plan/v1/messages',
    )
  })
  it('moonshot K3 family 使用 x-api-key、provider 1M ceiling，并按白名单保留 effort', () => {
    const moonshot = getStaticProvider('moonshot')
    assert.equal(moonshot.authScheme, 'x-api-key')
    assert.deepEqual([...moonshot.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...moonshot.stripBodyFields], ['context_management', 'service_tier'])
    assert.equal(moonshot.stripBodyFields.includes('output_config'), false)
    assert.equal(moonshot.stripBodyFields.includes('thinking'), false)
    assert.equal(moonshot.maxInputTokens, 1_048_576)
    assert.equal(moonshot.supportsVision, true)
  })
  it('bailian qwen3.8-max 使用 Token Plan x-api-key、983616 窗口并保留 thinking', () => {
    const bailian = getStaticProvider('bailian')
    assert.equal(
      bailian.upstreamEndpoint,
      'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages',
    )
    assert.equal(bailian.authScheme, 'x-api-key')
    assert.deepEqual([...bailian.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...bailian.stripBodyFields], [
      'output_config',
      'context_management',
      'service_tier',
    ])
    assert.equal(bailian.stripBodyFields.includes('thinking'), false)
    assert.equal(bailian.stripDisabledThinking, undefined)
    assert.equal(bailian.maxInputTokens, 983_616)
    assert.equal(bailian.supportsVision, true)
  })
})

describe('staticKeyProviders — authScheme(上游鉴权头风格)', () => {
  it('opencodego/moonshot/bailian = x-api-key;zai 与其余缺省 bearer', () => {
    assert.equal(getStaticProvider('opencodego').authScheme, 'x-api-key')
    assert.equal(getStaticProvider('moonshot').authScheme, 'x-api-key')
    assert.equal(getStaticProvider('deepseek').authScheme, undefined)
    assert.equal(getStaticProvider('minimax').authScheme, undefined)
    assert.equal(getStaticProvider('ark').authScheme, undefined)
    assert.equal(getStaticProvider('zai').authScheme, undefined)
    assert.equal(getStaticProvider('kimi').authScheme, undefined)
    assert.equal(getStaticProvider('ark-k3').authScheme, undefined)
    assert.equal(getStaticProvider('bailian').authScheme, 'x-api-key')
  })
})

describe('staticKeyProviders — stripDisabledThinking(恒思考模型删参兜底)', () => {
  it('kimi provider-wide；ark 仅 glm-5.3 model-scoped', () => {
    assert.equal(getStaticProvider('kimi').stripDisabledThinking, true)
    assert.deepEqual(getStaticProvider('ark').stripDisabledThinkingModels, ['glm-5.3'])
    assert.equal(getStaticProvider('deepseek').stripDisabledThinking, undefined)
    assert.equal(getStaticProvider('minimax').stripDisabledThinking, undefined)
    assert.equal(getStaticProvider('ark').stripDisabledThinking, undefined)
    assert.equal(getStaticProvider('zai').stripDisabledThinking, undefined)
    assert.equal(getStaticProvider('opencodego').stripDisabledThinking, undefined)
    assert.equal(getStaticProvider('ark-k3').stripDisabledThinking, undefined)
    assert.equal(getStaticProvider('bailian').stripDisabledThinking, undefined)
  })
})

describe('staticKeyProviders — allowedOutputConfigEfforts(思考深度白名单)', () => {
  it('ark/zai = [high,max]；moonshot = [low,high,max]；其余未声明', () => {
    assert.deepEqual([...(getStaticProvider('ark').allowedOutputConfigEfforts ?? [])], [
      'high',
      'max',
    ])
    assert.deepEqual([...(getStaticProvider('zai').allowedOutputConfigEfforts ?? [])], [
      'high',
      'max',
    ])
    assert.deepEqual([...(getStaticProvider('moonshot').allowedOutputConfigEfforts ?? [])], [
      'low',
      'high',
      'max',
    ])
    assert.equal(getStaticProvider('deepseek').allowedOutputConfigEfforts, undefined)
    assert.equal(getStaticProvider('minimax').allowedOutputConfigEfforts, undefined)
    assert.equal(getStaticProvider('opencodego').allowedOutputConfigEfforts, undefined)
    assert.equal(getStaticProvider('kimi').allowedOutputConfigEfforts, undefined)
    assert.equal(getStaticProvider('ark-k3').allowedOutputConfigEfforts, undefined)
    assert.equal(getStaticProvider('bailian').allowedOutputConfigEfforts, undefined)
  })
  it('硬约束:声明 allowedOutputConfigEfforts 的 provider 不能把 output_config 放进 stripBodyFields', () => {
    for (const p of STATIC_KEY_PROVIDERS) {
      if (p.allowedOutputConfigEfforts) {
        assert.equal(
          p.stripBodyFields.includes('output_config'),
          false,
          `${p.id} 声明 effort 白名单却整体 strip output_config —— effort 永远透不过去`,
        )
      }
    }
  })
})

describe('staticKeyProviders — supportsVision(原生多模态标记)', () => {
  it('minimax/ark-k3/moonshot/bailian=true;deepseek/ark/zai/opencodego/kimi(纯文本)=false', () => {
    assert.equal(getStaticProvider('minimax').supportsVision, true)
    assert.equal(getStaticProvider('ark-k3').supportsVision, true)
    assert.equal(getStaticProvider('moonshot').supportsVision, true)
    assert.equal(getStaticProvider('bailian').supportsVision, true)
    assert.equal(getStaticProvider('deepseek').supportsVision ?? false, false)
    assert.equal(getStaticProvider('ark').supportsVision ?? false, false)
    assert.equal(getStaticProvider('zai').supportsVision ?? false, false)
    // opencodego 2026-07-05 实测 image block → 400 InvalidParameter,纯文本接入。
    assert.equal(getStaticProvider('opencodego').supportsVision ?? false, false)
    // kimi 2026-07-06 实测 image block → 400 InvalidParameter(同 lane 的 M3 反而是多模态)。
    assert.equal(getStaticProvider('kimi').supportsVision ?? false, false)
  })
})

// ─── 漂移守护:protocol-owned 字段 vs 仓库根 snapshot ──────────────────────
describe('staticKeyProviders — snapshot 漂移守护(protocol-owned)', () => {
  it('registry 的 id/inboundModelIds/maxInputTokens/upstreamEndpoint/supportsVision 与 snapshot 一致', () => {
    const snapshotPath = fileURLToPath(
      new URL('../../../../static-key-providers.snapshot.json', import.meta.url),
    )
    const snap = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      providers: Array<{
        id: string
        inboundModelIds: string[]
        maxInputTokens: number | null
        upstreamEndpoint: string
        supportsVision?: boolean
      }>
    }
    // 数量与顺序一致
    assert.deepEqual(
      STATIC_KEY_PROVIDERS.map((p) => p.id),
      snap.providers.map((p) => p.id),
      'provider id 集/顺序漂移 —— 更新 snapshot 或 registry',
    )
    for (const sp of snap.providers) {
      const p = getStaticProvider(sp.id as StaticProviderId)
      assert.deepEqual([...p.inboundModelIds], sp.inboundModelIds, `${sp.id} inboundModelIds 漂移`)
      assert.equal(p.maxInputTokens ?? null, sp.maxInputTokens, `${sp.id} maxInputTokens 漂移`)
      assert.equal(p.upstreamEndpoint, sp.upstreamEndpoint, `${sp.id} upstreamEndpoint 漂移`)
      assert.equal(
        p.supportsVision ?? false,
        sp.supportsVision ?? false,
        `${sp.id} supportsVision 漂移`,
      )
    }
  })
})
