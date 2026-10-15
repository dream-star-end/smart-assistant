import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CODEX_FAST_MODELS,
  OPENCODE_GO_FAST_BILLING_MULTIPLIER,
  OPENCODE_GO_FAST_MODELS,
  CODEX_FAST_SERVICE_TIER,
  codexFastHint,
  fastServiceTierRoute,
  isServiceTier,
  supportsFastServiceTier,
} from '../serviceTiers.js'
import { OPENCODE_GO_RESPONSES_MODELS } from '../staticKeyProviders.js'

describe('OCV5-434 service tiers', () => {
  it('routes the documented Fast models and nothing else', () => {
    assert.equal(fastServiceTierRoute('gpt-6-astra'), 'codex')
    assert.equal(fastServiceTierRoute('gpt-6.1-sol-1m'), 'codex')
    assert.equal(fastServiceTierRoute('gpt-6-luna'), 'codex')
    assert.equal(fastServiceTierRoute('opencode-gpt-6-luna'), 'opencode-responses')
    assert.equal(fastServiceTierRoute('opencode-gpt-5.6-luna'), 'opencode-responses')
    for (const id of [
      'opencode-grok-4.7',
      'muse-spark-1.3-go',
      'glm-5.3-go',
      'deepseek-v4-flash',
      'claude-opus-5',
      '',
      undefined,
      null,
    ]) {
      assert.equal(supportsFastServiceTier(id), false, String(id))
    }
  })
  it('every OpenCode Go Fast model is a real /responses model', () => {
    for (const id of OPENCODE_GO_FAST_MODELS) assert.ok(id in OPENCODE_GO_RESPONSES_MODELS, id)
    for (const id of CODEX_FAST_MODELS) assert.ok(!(id in OPENCODE_GO_RESPONSES_MODELS), id)
  })
  it('only fast is a tier; the Go billing multiplier is the published 2×', () => {
    assert.equal(isServiceTier('fast'), true)
    for (const v of ['priority', 'default', null, undefined, 2])
      assert.equal(isServiceTier(v), false)
    assert.equal(OPENCODE_GO_FAST_BILLING_MULTIPLIER, '2.000')
  })
  it('Codex Fast uses the catalog id priority; hints follow the shipped Codex catalog', () => {
    assert.equal(CODEX_FAST_SERVICE_TIER, 'priority')
    assert.equal(codexFastHint('gpt-6-luna'), '1.5x')
    assert.equal(codexFastHint('gpt-6-luna-1m'), '1.5x')
    assert.equal(codexFastHint('gpt-6-astra'), '2x')
    assert.equal(codexFastHint('gpt-6.1-sol-1m'), '2x')
    assert.equal(codexFastHint('opencode-gpt-6-luna'), null)
  })
})
