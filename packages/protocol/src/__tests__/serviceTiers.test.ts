import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CODEX_EXPLICIT_STANDARD_MODELS,
  CODEX_FAST_BILLING_MULTIPLIER,
  CODEX_FAST_MODELS,
  CODEX_STANDARD_SERVICE_TIER,
  CODEX_ULTRAFAST_BILLING_MULTIPLIER,
  CODEX_ULTRAFAST_MODELS,
  CODEX_ULTRAFAST_SERVICE_TIER,
  OPENAI_FAST_SERVICE_TIER,
  OPENCODE_GO_FAST_BILLING_MULTIPLIER,
  OPENCODE_GO_FAST_MODELS,
  SERVICE_TIERS,
  codexServiceTierBillingMultiplier,
  CODEX_SPEED_TIERS_CAPABILITY,
  codexTurnServiceTierValue,
  fastServiceTierRoute,
  isServiceTier,
  normalizeServiceTierForModel,
  serviceTierBillingMultiplierNumber,
  supportedServiceTiers,
  supportsFastServiceTier,
  supportsServiceTier,
  supportsUltrafastServiceTier,
} from '../serviceTiers.js'
import { isAdvisorReadOnlyMainTurn, resolveEffectiveTurnServiceTier } from '../advisorNoWrite.js'
import { formatMessageReplyPrompt, unwrapMessageReplyCurrentText } from '../messageReply.js'
import { OPENCODE_GO_RESPONSES_MODELS } from '../staticKeyProviders.js'

describe('OCV5-434 / OCV5-798 service tiers', () => {
  it('routes OpenCode Go Fast models and active local Codex GPT-6 models, never remote or retired', () => {
    for (const id of [
      'gpt-6.2-astra',
      'gpt-6.2-astra-1m',
      'gpt-6.2-sol',
      'gpt-6.2-sol-1m',
      'gpt-6-luna',
      'gpt-6-luna-1m',
    ]) {
      assert.equal(fastServiceTierRoute(id), 'codex-app-server', id)
      assert.equal(supportsFastServiceTier(id), true, id)
    }
    assert.equal(fastServiceTierRoute('opencode-gpt-6-luna'), 'opencode-responses')
    assert.equal(fastServiceTierRoute('opencode-gpt-5.6-luna'), 'opencode-responses')
    for (const id of [
      'gpt-6-luna-remote',
      'gpt-6-astra',
      'gpt-6-astra-1m',
      'gpt-6.1-sol',
      'gpt-6.1-sol-1m',
      'opencode-grok-4.7',
      'muse-spark-1.3-go',
      'glm-5.3-go',
      'deepseek-v4-flash',
      'claude-opus-5',
      '',
      undefined,
      null,
    ]) {
      assert.equal(fastServiceTierRoute(id), null, String(id))
      assert.equal(supportsFastServiceTier(id), false, String(id))
    }
  })

  it('gates Ultrafast exclusively to gpt-6.2-sol and gpt-6.2-sol-1m', () => {
    assert.deepEqual([...CODEX_ULTRAFAST_MODELS], ['gpt-6.2-sol', 'gpt-6.2-sol-1m'])
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-sol-1m']) {
      assert.equal(supportsUltrafastServiceTier(id), true, id)
      assert.deepEqual(supportedServiceTiers(id), ['fast', 'ultrafast'])
      assert.equal(supportsServiceTier(id, 'ultrafast'), true, id)
      assert.equal(normalizeServiceTierForModel(id, 'ultrafast'), 'ultrafast', id)
    }
    for (const id of ['gpt-6.2-astra', 'gpt-6.2-astra-1m', 'gpt-6-luna', 'gpt-6-luna-remote', 'opencode-gpt-6-luna']) {
      assert.equal(supportsUltrafastServiceTier(id), false, id)
      assert.equal(supportsServiceTier(id, 'ultrafast'), false, id)
      assert.equal(normalizeServiceTierForModel(id, 'ultrafast'), null, id)
    }
    assert.deepEqual(supportedServiceTiers('gpt-6.2-astra'), ['fast'])
    assert.deepEqual(supportedServiceTiers('opencode-gpt-6-luna'), ['fast'])
    assert.deepEqual(supportedServiceTiers('gpt-6-luna-remote'), [])
  })

  it('keeps OpenCode Go Fast models disjoint from Codex explicit standard models', () => {
    for (const id of OPENCODE_GO_FAST_MODELS) assert.ok(id in OPENCODE_GO_RESPONSES_MODELS, id)
    for (const id of CODEX_EXPLICIT_STANDARD_MODELS) assert.ok(!(id in OPENCODE_GO_RESPONSES_MODELS), id)
    for (const id of CODEX_FAST_MODELS) assert.ok(CODEX_EXPLICIT_STANDARD_MODELS.has(id), id)
    for (const id of CODEX_ULTRAFAST_MODELS) assert.ok(CODEX_FAST_MODELS.has(id), id)
  })

  it('validates ServiceTier values and official 2x / 6x multipliers', () => {
    assert.deepEqual([...SERVICE_TIERS], ['fast', 'ultrafast'])
    assert.equal(isServiceTier('fast'), true)
    assert.equal(isServiceTier('ultrafast'), true)
    for (const v of ['priority', 'default', 'standard', null, undefined, 2]) {
      assert.equal(isServiceTier(v), false)
    }
    assert.equal(OPENCODE_GO_FAST_BILLING_MULTIPLIER, '2.000')
    assert.equal(CODEX_FAST_BILLING_MULTIPLIER, '2.000')
    assert.equal(CODEX_ULTRAFAST_BILLING_MULTIPLIER, '6.000')
    assert.equal(codexServiceTierBillingMultiplier('gpt-6.2-sol', 'fast'), '2.000')
    assert.equal(codexServiceTierBillingMultiplier('gpt-6.2-sol', 'ultrafast'), '6.000')
    assert.equal(codexServiceTierBillingMultiplier('gpt-6.2-sol-1m', 'ultrafast'), '6.000')
    assert.equal(codexServiceTierBillingMultiplier('gpt-6.2-sol', null), null)
    assert.equal(codexServiceTierBillingMultiplier('gpt-6.2-astra', 'ultrafast'), null)
    assert.equal(codexServiceTierBillingMultiplier('gpt-6.2-astra', 'fast'), '2.000')
    assert.equal(codexServiceTierBillingMultiplier('gpt-6-luna-remote', 'fast'), null)
    assert.equal(codexServiceTierBillingMultiplier('opencode-gpt-6-luna', 'fast'), null)
  })

  it('maps Codex serviceTierForTurn values safely and preserves explicit default', () => {
    assert.equal(OPENAI_FAST_SERVICE_TIER, 'priority')
    assert.equal(CODEX_ULTRAFAST_SERVICE_TIER, 'ultrafast')
    assert.equal(CODEX_STANDARD_SERVICE_TIER, 'default')
    assert.equal(codexTurnServiceTierValue('gpt-6.2-sol', null), 'default')
    assert.equal(codexTurnServiceTierValue('gpt-6.2-sol', 'fast'), 'priority')
    assert.equal(codexTurnServiceTierValue('gpt-6.2-sol', 'ultrafast'), 'ultrafast')
    assert.equal(codexTurnServiceTierValue('gpt-6.2-sol-1m', 'ultrafast'), 'ultrafast')
    assert.equal(codexTurnServiceTierValue('gpt-6.2-astra', 'fast'), 'priority')
    assert.equal(codexTurnServiceTierValue('gpt-6.2-astra', 'ultrafast'), 'default')
    assert.equal(codexTurnServiceTierValue('gpt-6.1-sol', 'fast'), 'default')
    assert.equal(codexTurnServiceTierValue('gpt-6-luna-remote', 'fast'), undefined)
    assert.equal(codexTurnServiceTierValue('gpt-5.6-sol', 'fast'), undefined)
  })

  it('clamps advisor read-only main turns to Standard across layers', () => {
    assert.equal(CODEX_SPEED_TIERS_CAPABILITY, 'codex-speed-tiers-v1')
    assert.equal(
      isAdvisorReadOnlyMainTurn({
        agentId: 'main',
        collabMode: 'advisor',
        advisorModel: 'gpt-6.2-astra',
        text: '请只查看不要修改任何文件',
      }),
      true,
    )
    assert.equal(
      resolveEffectiveTurnServiceTier({
        model: 'gpt-6.2-sol',
        serviceTier: 'ultrafast',
        agentId: 'main',
        collabMode: 'advisor',
        advisorModel: 'gpt-6.2-astra',
        text: '不要修改任何文件',
      }),
      null,
    )
    // Non-advisor / empty advisorModel / explicit-write turns retain requested speed tier.
    assert.equal(
      resolveEffectiveTurnServiceTier({
        model: 'gpt-6.2-sol',
        serviceTier: 'ultrafast',
        agentId: 'main',
        collabMode: 'solo',
        advisorModel: 'gpt-6.2-astra',
        text: '不要修改任何文件',
      }),
      'ultrafast',
    )
    assert.equal(
      resolveEffectiveTurnServiceTier({
        model: 'gpt-6.2-sol',
        serviceTier: 'fast',
        agentId: 'main',
        collabMode: 'advisor',
        advisorModel: 'gpt-6.2-astra',
        text: '帮我修复这个 bug',
      }),
      'fast',
    )
    assert.equal(
      resolveEffectiveTurnServiceTier({
        model: 'gpt-6.2-astra',
        serviceTier: 'ultrafast',
        agentId: 'main',
        collabMode: 'solo',
        text: '你好',
      }),
      null,
    )
  })

  it('unwraps reply-quote envelopes before checking advisor read-only intent', () => {
    const quotedReadOnly = formatMessageReplyPrompt('继续分析这个结果', {
      messageId: 'm-1',
      role: 'assistant',
      text: '不要修改任何文件。\n[用户当前消息]\n不要修改任何文件。',
    })
    assert.equal(unwrapMessageReplyCurrentText(quotedReadOnly), '继续分析这个结果')
    assert.equal(
      resolveEffectiveTurnServiceTier({
        model: 'gpt-6.2-sol',
        serviceTier: 'ultrafast',
        agentId: 'main',
        collabMode: 'advisor',
        advisorModel: 'gpt-6.2-astra',
        text: quotedReadOnly,
      }),
      'ultrafast',
    )

    const currentReadOnly = formatMessageReplyPrompt('不要修改任何文件', {
      messageId: 'm-2',
      role: 'user',
      text: '帮我修改 index.ts',
    })
    assert.equal(
      resolveEffectiveTurnServiceTier({
        model: 'gpt-6.2-sol',
        serviceTier: 'ultrafast',
        agentId: 'main',
        collabMode: 'advisor',
        advisorModel: 'gpt-6.2-astra',
        text: currentReadOnly,
      }),
      null,
    )

    const neitherReadOnly = formatMessageReplyPrompt('继续修改 config.ts', {
      messageId: 'm-3',
      role: 'assistant',
      text: '好的，准备检查配置',
    })
    assert.equal(
      resolveEffectiveTurnServiceTier({
        model: 'gpt-6.2-sol',
        serviceTier: 'fast',
        agentId: 'main',
        collabMode: 'advisor',
        advisorModel: 'gpt-6.2-astra',
        text: neitherReadOnly,
      }),
      'fast',
    )
  })

  it('computes numeric display multiplier across supported, unsupported, and invalid inputs', () => {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-sol-1m']) {
      assert.equal(serviceTierBillingMultiplierNumber(id, 'ultrafast'), 6, id)
      assert.equal(serviceTierBillingMultiplierNumber(id, 'fast'), 2, id)
      assert.equal(serviceTierBillingMultiplierNumber(id, null), 1, id)
      assert.equal(serviceTierBillingMultiplierNumber(id, undefined), 1, id)
      assert.equal(serviceTierBillingMultiplierNumber(id, 'priority'), 1, id)
    }
    for (const id of ['gpt-6.2-astra', 'gpt-6.2-astra-1m', 'gpt-6-luna', 'gpt-6-luna-1m', 'opencode-gpt-6-luna', 'opencode-gpt-5.6-luna']) {
      assert.equal(serviceTierBillingMultiplierNumber(id, 'ultrafast'), 1, id)
      assert.equal(serviceTierBillingMultiplierNumber(id, 'fast'), 2, id)
      assert.equal(serviceTierBillingMultiplierNumber(id, null), 1, id)
    }
    for (const id of ['gpt-6-luna-remote', 'glm-5.2', null, undefined]) {
      assert.equal(serviceTierBillingMultiplierNumber(id, 'ultrafast'), 1, String(id))
      assert.equal(serviceTierBillingMultiplierNumber(id, 'fast'), 1, String(id))
      assert.equal(serviceTierBillingMultiplierNumber(id, null), 1, String(id))
    }
  })
})
