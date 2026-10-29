/**
 * OCV5-425: OpenCode Go model-scoped effort in the proxy (ceiling, snapshot check, body rewrite)
 * and the Gemini bridge thinkingLevel mapping.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/openCodeGoModelEffort.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { getStaticProvider } from '@openclaude/protocol'

import { anthropicToGemini, geminiThinkingLevel } from '../http/proxy/geminiGoBridge.js'
import {
  type PickUpstreamDeps,
  checkSnapshotCapabilities,
  pickUpstream,
  providerCapabilityCeiling,
} from '../http/proxy/upstream.js'
import { rootLogger } from '../logging/logger.js'

const log = rootLogger.child({ subsys: 'openCodeGoModelEffort.test' })
const GO = getStaticProvider('opencodego')
const route = (upstreamModel?: string) =>
  upstreamModel === undefined
    ? { kind: 'static' as const, provider: GO }
    : { kind: 'static' as const, provider: GO, upstreamModel }
const deps: PickUpstreamDeps = {
  scheduler: {
    pick: async () => {
      throw new Error('static path must not call scheduler.pick')
    },
    release: async () => {},
  },
  staticProviderKeys: { opencodego: 'GO-KEY' },
} as unknown as PickUpstreamDeps

async function rewrite(upstreamModel: string, extra: Record<string, unknown>) {
  const res = await pickUpstream(
    deps,
    { model: upstreamModel, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    route(upstreamModel),
    log,
  )
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  const body = {
    model: upstreamModel,
    max_tokens: 64,
    messages: [],
    context_management: { edits: [] },
    ...extra,
  } as unknown as Parameters<typeof res.session.applyUpstreamAuth>[1]
  res.session.applyUpstreamAuth({}, body, log)
  return body as unknown as Record<string, unknown>
}

describe('OpenCode Go vision ceiling', () => {
  test('per upstream model: the audited ten are vision-capable; beam-free is not', () => {
    for (const model of [
      'deepseek-v4.1-flash',
      'minimax-m3',
      'qwen3.7-plus',
      'glm-5.3-flash',
      'minimax-m3.1-flash-free',
      'mimo-v2.5',
      'mimo-v2.6-flash',
      'step-5-preview',
      'longcat-2.5-preview-free',
      'muse-spark-1.3-contributor',
    ]) {
      assert.equal(providerCapabilityCeiling(route(model)).supportsVision, true, model)
    }
    assert.equal(providerCapabilityCeiling(route('beam-free')).supportsVision, false)
    assert.equal(providerCapabilityCeiling(route('kimi-k3')).supportsVision, false)
    assert.equal(providerCapabilityCeiling(route()).supportsVision, false)
  })

  test('Flash canonical and legacy alias require the real Go upstream for native vision', () => {
    for (const modelId of ['deepseek-v4-flash', 'deepseek-v4-flash-opencode-go']) {
      const entry = { modelId, engine: 'ccb', state: 'active', providerId: 'opencodego',
        upstreamModelId: 'deepseek-v4.1-flash',
        capabilityProfile: { supportsVision: true, reasoning: { supported: [] } } };
      assert.deepEqual(checkSnapshotCapabilities({ entries: [entry] }), []);
      for (const route of [
        { providerId: 'opencodego', upstreamModelId: 'deepseek-v4-flash' },
        { providerId: 'deepseek', upstreamModelId: 'deepseek-flash' },
      ]) {
        assert.equal(checkSnapshotCapabilities({ entries: [{ ...entry, ...route }] }).length, 1);
      }
    }
  });

  test('snapshot check accepts vision only on allowlisted Go upstream ids', () => {
    const entry = (modelId: string, upstreamModelId: string, supportsVision: boolean) => ({
      modelId,
      engine: 'ccb',
      providerId: 'opencodego',
      upstreamModelId,
      state: 'active',
      capabilityProfile: { supportsVision, reasoning: { supported: [] } },
    })
    assert.deepEqual(
      checkSnapshotCapabilities({
        entries: [
          entry('minimax-m3-go', 'minimax-m3', true),
          entry('muse-spark-1.3-go', 'muse-spark-1.3-contributor', true),
        ],
      }),
      [],
    )
    assert.equal(checkSnapshotCapabilities({ entries: [entry('beam-free-go', 'beam-free', true)] }).length, 1)
    assert.equal(checkSnapshotCapabilities({ entries: [entry('kimi-k3-go', 'kimi-k3', true)] }).length, 1)
  })
})

describe('OpenCode Go effort ceiling', () => {
  test('per upstream model; unlisted models and the bare provider stay at no tiers', () => {
    assert.deepEqual(providerCapabilityCeiling(route('claude-haiku-5-5')).efforts, [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    assert.deepEqual(providerCapabilityCeiling(route('qwen3.8-max')).efforts, ['low', 'high'])
    assert.deepEqual(providerCapabilityCeiling(route('gemini-4-argon-contributor')).efforts, [
      'low',
      'medium',
      'high',
    ])
    assert.deepEqual(providerCapabilityCeiling(route('kimi-k3')).efforts, [])
    assert.deepEqual(providerCapabilityCeiling(route()).efforts, [])
  })

  test('snapshot check judges the catalog upstream id, not the -go catalog id', () => {
    const entry = (modelId: string, upstreamModelId: string | undefined, supported: string[]) => ({
      modelId,
      engine: 'ccb',
      providerId: 'opencodego',
      ...(upstreamModelId === undefined ? {} : { upstreamModelId }),
      state: 'active',
      capabilityProfile: { supportsVision: false, reasoning: { supported } },
    })
    const tiers = ['low', 'medium', 'high', 'xhigh', 'max']
    assert.deepEqual(
      checkSnapshotCapabilities({
        entries: [entry('claude-haiku-5-5-go', 'claude-haiku-5-5', tiers)],
      }),
      [],
    )
    // without the upstream id the -go id resolves to no tiers → caught
    assert.equal(
      checkSnapshotCapabilities({ entries: [entry('claude-haiku-5-5-go', undefined, tiers)] })
        .length,
      1,
    )
    // a tier the upstream model does not honour is caught
    assert.equal(
      checkSnapshotCapabilities({ entries: [entry('kimi-k3-go', 'kimi-k3', ['low'])] }).length,
      1,
    )
    assert.equal(
      checkSnapshotCapabilities({ entries: [entry('qwen3.8-max-go', 'qwen3.8-max', ['max'])] })
        .length,
      1,
    )
  })
})

describe('OpenCode Go output_config rewrite', () => {
  test('allowed effort is kept as exactly {effort}; other sub-fields go', async () => {
    const body = await rewrite('claude-haiku-5-5', {
      output_config: { effort: 'xhigh', task_budget: 9 },
    })
    assert.deepEqual(body.output_config, { effort: 'xhigh' })
    assert.equal(body.context_management, undefined)
  })

  test('an effort outside the model list, or a malformed one, drops output_config', async () => {
    assert.equal(
      (await rewrite('qwen3.8-max', { output_config: { effort: 'max' } })).output_config,
      undefined,
    )
    assert.equal(
      (await rewrite('claude-haiku-5-5', { output_config: { effort: 3 } })).output_config,
      undefined,
    )
    assert.equal(
      (await rewrite('claude-haiku-5-5', { output_config: ['high'] })).output_config,
      undefined,
    )
  })

  test('models without tiers keep the provider-wide strip', async () => {
    for (const model of ['kimi-k3', 'deepseek-v4-flash', 'minimax-m3']) {
      const body = await rewrite(model, { output_config: { effort: 'high' } })
      assert.equal(body.output_config, undefined, model)
    }
  })

  test('Gemini keeps its effort for the bridge', async () => {
    const body = await rewrite('gemini-4-argon-contributor', { output_config: { effort: 'high' } })
    assert.deepEqual(body.output_config, { effort: 'high' })
  })
})

describe('Gemini bridge thinkingLevel', () => {
  test('low/medium/high map to LOW/MEDIUM/HIGH; absent or unknown stays the old LOW', () => {
    assert.equal(geminiThinkingLevel({ effort: 'low' }), 'LOW')
    assert.equal(geminiThinkingLevel({ effort: 'medium' }), 'MEDIUM')
    assert.equal(geminiThinkingLevel({ effort: 'high' }), 'HIGH')
    assert.equal(geminiThinkingLevel(undefined), 'LOW')
    assert.equal(geminiThinkingLevel({ effort: 'max' }), 'LOW')
    assert.equal(geminiThinkingLevel('high'), 'LOW')
  })

  test('the Google body carries the level and never output_config', () => {
    const out = anthropicToGemini({
      model: 'gemini-4-argon-contributor',
      max_tokens: 100,
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: 'hi' }],
    }) as { generationConfig: { thinkingConfig: unknown }; output_config?: unknown }
    assert.deepEqual(out.generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' })
    assert.equal(out.output_config, undefined)
  })
})
