/**
 * 静态 key 文本 provider 注册表测试。
 *
 * 跑法: npx tsx --test packages/protocol/src/__tests__/staticKeyProviders.test.ts
 *
 * 覆盖:
 *   - matchesRoute(deepseek 大小写敏感前缀 / minimax,ark 精确大小写不敏感)
 *   - inboundModelIds 精确字面量(deepseek 2 项,与 route 面故意不同)
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
} from '../staticKeyProviders.js'

describe('staticKeyProviders — matchesRoute', () => {
  it('deepseek 大小写敏感前缀家族', () => {
    const ds = getStaticProvider('deepseek')
    assert.equal(ds.matchesRoute('deepseek-v4-pro'), true)
    assert.equal(ds.matchesRoute('deepseek-chat'), true)
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
  it('ark(glm-5.1)精确,大小写不敏感', () => {
    const ark = getStaticProvider('ark')
    assert.equal(ark.matchesRoute('glm-5.1'), true)
    assert.equal(ark.matchesRoute('GLM-5.1'), true)
    assert.equal(ark.matchesRoute('glm-5'), false)
    assert.equal(ark.matchesRoute('glm-5.2'), false)
  })
})

describe('staticKeyProviders — findRouteProviderForModel', () => {
  it('命中各 provider;非静态 → undefined', () => {
    assert.equal(findRouteProviderForModel('deepseek-v4-pro')?.id, 'deepseek')
    assert.equal(findRouteProviderForModel('MiniMax-M3')?.id, 'minimax')
    assert.equal(findRouteProviderForModel('glm-5.1')?.id, 'ark')
    assert.equal(findRouteProviderForModel('claude-opus-4-7'), undefined)
    assert.equal(findRouteProviderForModel('DeepSeek-v4-pro'), undefined)
    assert.equal(findRouteProviderForModel(''), undefined)
  })
})

describe('staticKeyProviders — inboundModelIds(与 route 面故意不同)', () => {
  it('deepseek 只放 2 个精确字面量(不放过未声明 deepseek- 变体)', () => {
    assert.deepEqual([...getStaticProvider('deepseek').inboundModelIds], [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
  })
  it('minimax/ark 各 1 项', () => {
    assert.deepEqual([...getStaticProvider('minimax').inboundModelIds], ['MiniMax-M3'])
    assert.deepEqual([...getStaticProvider('ark').inboundModelIds], ['glm-5.1'])
  })
  it('STATIC_KEY_INBOUND_MODEL_IDS = 全 provider 字面量展开', () => {
    assert.deepEqual([...STATIC_KEY_INBOUND_MODEL_IDS], [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'MiniMax-M3',
      'glm-5.1',
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
  it('ark → glm-5.1', () => {
    const ark = getStaticProvider('ark')
    assert.equal(ark.canonicalizeForPricing('GLM-5.1'), 'glm-5.1')
    assert.equal(ark.canonicalizeForPricing('glm-5.1'), 'glm-5.1')
    assert.equal(ark.canonicalizeForPricing('glm-5.2'), null)
  })
})

describe('staticKeyProviders — strip / endpoint', () => {
  it('deepseek strip 仅 anthropic-beta、无 body strip、无 input cap', () => {
    const ds = getStaticProvider('deepseek')
    assert.deepEqual([...ds.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...ds.stripBodyFields], [])
    assert.equal(ds.maxInputTokens, undefined)
  })
  it('minimax strip anthropic-beta + 4 body 字段(含 thinking)', () => {
    const mm = getStaticProvider('minimax')
    assert.deepEqual([...mm.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...mm.stripBodyFields], [
      'output_config',
      'context_management',
      'thinking',
      'service_tier',
    ])
    assert.equal(mm.maxInputTokens, 512_000)
  })
  it('ark strip anthropic-beta + 3 body 字段(**保留 thinking** —— glm-5.1 是 thinking 模型)', () => {
    const ark = getStaticProvider('ark')
    assert.deepEqual([...ark.stripHeaders], ['anthropic-beta'])
    assert.deepEqual([...ark.stripBodyFields], [
      'output_config',
      'context_management',
      'service_tier',
    ])
    assert.equal(ark.stripBodyFields.includes('thinking'), false, 'ark 必须不 strip thinking')
    assert.equal(ark.maxInputTokens, 200_000)
  })
  it('ark endpoint = 火山方舟 coding plan /v1/messages', () => {
    assert.equal(
      getStaticProvider('ark').upstreamEndpoint,
      'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
    )
  })
})

// ─── 漂移守护:protocol-owned 字段 vs 仓库根 snapshot ──────────────────────
describe('staticKeyProviders — snapshot 漂移守护(protocol-owned)', () => {
  it('registry 的 id/inboundModelIds/maxInputTokens/upstreamEndpoint 与 snapshot 一致', () => {
    const snapshotPath = fileURLToPath(
      new URL('../../../../static-key-providers.snapshot.json', import.meta.url),
    )
    const snap = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      providers: Array<{
        id: string
        inboundModelIds: string[]
        maxInputTokens: number | null
        upstreamEndpoint: string
      }>
    }
    // 数量与顺序一致
    assert.deepEqual(
      STATIC_KEY_PROVIDERS.map((p) => p.id),
      snap.providers.map((p) => p.id),
      'provider id 集/顺序漂移 —— 更新 snapshot 或 registry',
    )
    for (const sp of snap.providers) {
      const p = getStaticProvider(sp.id as 'deepseek' | 'minimax' | 'ark')
      assert.deepEqual([...p.inboundModelIds], sp.inboundModelIds, `${sp.id} inboundModelIds 漂移`)
      assert.equal(p.maxInputTokens ?? null, sp.maxInputTokens, `${sp.id} maxInputTokens 漂移`)
      assert.equal(p.upstreamEndpoint, sp.upstreamEndpoint, `${sp.id} upstreamEndpoint 漂移`)
    }
  })
})
