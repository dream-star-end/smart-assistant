/**
 * OCV5-425 OpenCode Go `/messages` models and model-scoped effort tiers.
 *
 * Run: npx tsx --test packages/protocol/src/__tests__/openCodeGoModels.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL,
  isMorePickerModelId,
  modelReasoningPolicy,
} from '../engineModels.js'
import {
  OPENCODE_GO_CHAT_MODELS,
  OPENCODE_GO_EXTRA_MODELS,
  OPENCODE_GO_MESSAGES_MODELS,
  OPENCODE_GO_RESPONSES_MODELS,
  STATIC_KEY_INBOUND_MODEL_IDS,
  findRouteProviderForModel,
  getStaticProvider,
  isOpenCodeGoChatUpstream,
  isOpenCodeGoResponsesUpstream,
  staticProviderOutputConfigEfforts,
} from '../staticKeyProviders.js'

const GO = getStaticProvider('opencodego')

describe('OpenCode Go /messages models', () => {
  it('every -go id routes to opencodego (never the same-named direct provider) with its upstream id', () => {
    for (const [id, upstream] of Object.entries(OPENCODE_GO_EXTRA_MODELS)) {
      assert.match(id, /-go$|^opencode-/)
      assert.equal(findRouteProviderForModel(id)?.id, 'opencodego', id)
      assert.equal(GO.upstreamModelForRequest?.(id), upstream, id)
      assert.equal(GO.canonicalizeForPricing(id), id, id)
      assert.ok(STATIC_KEY_INBOUND_MODEL_IDS.includes(id), id)
    }
    // the DeepSeek prefix family must not swallow the Go alias, and the bare names keep their owners
    assert.equal(getStaticProvider('deepseek').matchesRoute('deepseek-v4-pro-go'), false)
    assert.equal(findRouteProviderForModel('deepseek-v4-pro')?.id, 'deepseek')
    assert.equal(findRouteProviderForModel('kimi-k3')?.id, 'moonshot')
    assert.equal(findRouteProviderForModel('qwen3.8-max')?.id, 'bailian')
    assert.equal(findRouteProviderForModel('minimax-m3')?.id, 'minimax')
    assert.equal(findRouteProviderForModel('glm-5.3')?.id, 'ark')
    assert.equal(findRouteProviderForModel('glm-5.3-zai')?.id, 'zai')
    assert.equal(findRouteProviderForModel('kimi-k2.7-code')?.id, 'kimi')
  })

  it('responses-only upstreams get their own bridge; gpt/grok ids avoid the engine prefixes', () => {
    assert.equal(Object.keys(OPENCODE_GO_RESPONSES_MODELS).length, 6)
    for (const [id, upstream] of Object.entries(OPENCODE_GO_RESPONSES_MODELS)) {
      assert.equal(isOpenCodeGoResponsesUpstream(upstream), true, upstream)
      assert.equal(isOpenCodeGoChatUpstream(upstream), false, upstream)
      assert.doesNotMatch(id, /^(gpt-|grok)/, id)
    }
    assert.equal(isOpenCodeGoResponsesUpstream('glm-5.3'), false)
    assert.equal(findRouteProviderForModel('gpt-6-luna'), undefined)
    assert.equal(findRouteProviderForModel('opencode-gpt-6-luna')?.id, 'opencodego')
  })

  it('chat-only upstreams are flagged for the bridge; /messages ones are not', () => {
    assert.equal(Object.keys(OPENCODE_GO_CHAT_MODELS).length, 14)
    for (const upstream of Object.values(OPENCODE_GO_CHAT_MODELS))
      assert.equal(isOpenCodeGoChatUpstream(upstream), true, upstream)
    assert.equal(isOpenCodeGoChatUpstream('GLM-5.3'), true)
    for (const upstream of [
      ...Object.values(OPENCODE_GO_MESSAGES_MODELS),
      'gemini-4-argon-contributor',
      'deepseek-v4-flash',
    ])
      assert.equal(isOpenCodeGoChatUpstream(upstream), false, upstream)
    for (const id of Object.keys(OPENCODE_GO_CHAT_MODELS))
      assert.ok(!(id in OPENCODE_GO_MESSAGES_MODELS))
  })

  it('existing OpenCode Go routes are unchanged', () => {
    assert.equal(GO.upstreamModelForRequest?.('deepseek-v4-flash'), 'deepseek-v4-flash')
    assert.equal(
      GO.upstreamModelForRequest?.('gemini-4-argon-contributor'),
      'gemini-4-argon-contributor',
    )
    assert.equal(GO.canonicalizeForPricing('deepseek-v4-flash-opencode-go'), 'deepseek-v4-flash')
    assert.equal(GO.canonicalizeForPricing('kimi-k3'), null)
  })
})

describe('model-scoped effort tiers', () => {
  it('only probed upstream models get tiers; the rest keep the provider-wide strip', () => {
    assert.deepEqual(staticProviderOutputConfigEfforts(GO, 'gemini-4-argon-contributor'), [
      'low',
      'medium',
      'high',
    ])
    assert.deepEqual(staticProviderOutputConfigEfforts(GO, 'Claude-Haiku-5-5'), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    assert.deepEqual(staticProviderOutputConfigEfforts(GO, 'qwen3.8-max'), ['low', 'high'])
    for (const upstream of [
      'kimi-k3',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'minimax-m3',
      'space-bunny',
    ]) {
      assert.deepEqual(staticProviderOutputConfigEfforts(GO, upstream), [], upstream)
    }
    assert.deepEqual(staticProviderOutputConfigEfforts(GO), [])
  })

  it('chat bridge models: tiers only where reasoning_effort changes the reasoning', () => {
    assert.deepEqual(modelReasoningPolicy('glm-5.3-go').supported, ['low', 'medium', 'high'])
    assert.deepEqual(modelReasoningPolicy('glm-5.2-go').supported, ['low', 'medium', 'high'])
    assert.deepEqual(modelReasoningPolicy('glm-5.3-flash-go').supported, ['low', 'high'])
    assert.deepEqual(modelReasoningPolicy('hy3-go').supported, ['low', 'high'])
    assert.deepEqual(modelReasoningPolicy('longcat-2.0-go').supported, ['low', 'high'])
    for (const id of [
      'kimi-k2.7-code-go',
      'kimi-k2.6-go',
      'mimo-v2.6-pro-go',
      'hy4-preview-go',
      'step-5-preview-free-go',
    ])
      assert.deepEqual(modelReasoningPolicy(id).supported, [], id)
    for (const id of ['opencode-grok-4.7', 'opencode-grok-4.6', 'opencode-gpt-6-luna', 'muse-spark-1.2-go'])
      assert.deepEqual(modelReasoningPolicy(id).supported, ['low', 'high'], id)
    for (const id of ['opencode-gpt-5.6-luna', 'muse-spark-1.3-go'])
      assert.deepEqual(modelReasoningPolicy(id).supported, [], id)
    // Codex's own gpt-6-luna keeps its engine policy
    assert.notDeepEqual(modelReasoningPolicy('gpt-6-luna').supported, ['low', 'high'])
    // Ark's own glm-5.3 keeps its provider-wide tiers
    assert.deepEqual(modelReasoningPolicy('glm-5.3').supported, ['high', 'max'])
  })

  it('provider-wide rules are unchanged for other providers', () => {
    assert.deepEqual(staticProviderOutputConfigEfforts(getStaticProvider('ark'), 'glm-5.2'), [
      'high',
      'max',
    ])
    assert.deepEqual(staticProviderOutputConfigEfforts(getStaticProvider('moonshot'), 'kimi-k3'), [
      'low',
      'high',
      'max',
    ])
  })

  it('modelReasoningPolicy resolves catalog id → upstream model', () => {
    assert.deepEqual(modelReasoningPolicy('claude-haiku-5-5-go').supported, [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    assert.deepEqual(modelReasoningPolicy('qwen3.8-max-go').supported, ['low', 'high'])
    assert.deepEqual(modelReasoningPolicy('gemini-4-argon-contributor').supported, [
      'low',
      'medium',
      'high',
    ])
    assert.deepEqual(modelReasoningPolicy('kimi-k3-go').supported, [])
    assert.deepEqual(modelReasoningPolicy('deepseek-v4-flash').supported, [])
    // same-named model on another provider keeps its own tiers
    assert.deepEqual(modelReasoningPolicy('kimi-k3').supported, ['low', 'high', 'max'])
  })
})

describe('picker「更多模型」', () => {
  it('lists exactly the new Go models; the main-list models stay out', () => {
    for (const id of Object.keys(OPENCODE_GO_MESSAGES_MODELS))
      assert.equal(isMorePickerModelId(id), true, id)
    for (const id of [
      'deepseek-v4-flash',
      'gemini-4-argon-contributor',
      'kimi-k3',
      'gpt-6-luna',
      'glm-5.3',
      'glm-5.3-zai',
    ])
      assert.equal(isMorePickerModelId(id), false, id)
    assert.equal(COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL, '更多模型')
  })
})
