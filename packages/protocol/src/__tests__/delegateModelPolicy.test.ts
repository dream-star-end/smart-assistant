/**
 * OCV5-897 delegateModelPolicy unit tests:
 *   - canonical model family resolution & 4-family delegation allowlist;
 *   - strong-tier scientific audit eligibility (exact frozen variants, matching
 *     provider prefix normalization, strict rejection of unapproved suffixes
 *     like `-pro` / `box-`, mismatched prefixes, weak tiers, and non-4-family models).
 *
 * Run: npx tsx --test packages/protocol/src/__tests__/delegateModelPolicy.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATE_ALLOWED_MODEL_FAMILIES,
  SCIENTIFIC_AUDIT_STRONG_POOL_LABEL,
  evaluateScientificAuditReviewer,
  isAllowedDelegateModel,
  isAllowedDelegateModelFamily,
  resolveCanonicalModelFamily,
} from '../delegateModelPolicy.js'

describe('OCV5-897 delegateModelPolicy', () => {
  it('freezes the four allowed delegation families and strong pool label', () => {
    assert.deepEqual(DELEGATE_ALLOWED_MODEL_FAMILIES, ['openai', 'google', 'xai', 'deepseek'])
    assert.match(SCIENTIFIC_AUDIT_STRONG_POOL_LABEL, /gpt-6\.2-astra/)
    assert.match(SCIENTIFIC_AUDIT_STRONG_POOL_LABEL, /antigravity-gemini-4-neon/)
    assert.match(SCIENTIFIC_AUDIT_STRONG_POOL_LABEL, /grok-build/)
    assert.match(SCIENTIFIC_AUDIT_STRONG_POOL_LABEL, /deepseek-v4-flash/)
    assert.equal(isAllowedDelegateModelFamily('openai'), true)
    assert.equal(isAllowedDelegateModelFamily('google'), true)
    assert.equal(isAllowedDelegateModelFamily('xai'), true)
    assert.equal(isAllowedDelegateModelFamily('deepseek'), true)
    assert.equal(isAllowedDelegateModelFamily('anthropic'), false)
    assert.equal(isAllowedDelegateModelFamily('zhipu'), false)
  })

  it('resolves canonical model families and enforces 4-family delegation predicate', () => {
    assert.equal(resolveCanonicalModelFamily('gpt-6.2-astra'), 'openai')
    assert.equal(resolveCanonicalModelFamily('antigravity-gemini-4-neon'), 'google')
    assert.equal(resolveCanonicalModelFamily('grok-build'), 'xai')
    assert.equal(resolveCanonicalModelFamily('cursor-grok-4.7-high'), 'xai')
    assert.equal(resolveCanonicalModelFamily('deepseek-v4-flash'), 'deepseek')

    assert.equal(resolveCanonicalModelFamily('antigravity-gpt-oss-120b'), 'gpt_oss')
    assert.equal(resolveCanonicalModelFamily('cursor-auto'), 'cursor_auto')
    assert.equal(resolveCanonicalModelFamily('box-api-claude-opus-5-5'), 'anthropic')
    assert.equal(resolveCanonicalModelFamily('anthropic/gpt-6.2-astra'), 'anthropic')
    assert.equal(resolveCanonicalModelFamily('glm-5.3-flash-go'), 'zhipu')
    assert.equal(resolveCanonicalModelFamily('qwen3.7-plus-go'), 'qwen')
    assert.equal(resolveCanonicalModelFamily('k3.1-pro'), 'moonshot')
    assert.equal(resolveCanonicalModelFamily('minimax-m3-go'), 'minimax')

    assert.equal(isAllowedDelegateModel('gpt-6.2-sol-1m'), true)
    assert.equal(isAllowedDelegateModel('antigravity-gemini-4-carbon'), true)
    assert.equal(isAllowedDelegateModel('grok-build'), true)
    assert.equal(isAllowedDelegateModel('deepseek-v4-flash'), true)

    assert.equal(isAllowedDelegateModel('box-api-claude-opus-5-5'), false)
    assert.equal(isAllowedDelegateModel('anthropic/gpt-6.2-astra'), false)
    assert.equal(isAllowedDelegateModel('antigravity-gpt-oss-120b'), false)
    assert.equal(isAllowedDelegateModel('cursor-auto'), false)
    assert.equal(isAllowedDelegateModel('glm-5.3-flash-go'), false)
  })

  it('admits exact frozen strong-tier variants and matching provider prefixes (B8)', () => {
    const admitted: Array<[string, string]> = [
      ['gpt-6.2-astra', 'openai'],
      ['gpt-6.2-sol', 'openai'],
      ['gpt-6.2-astra-1m', 'openai'],
      ['gpt-6.2-sol-1m', 'openai'],
      ['gpt-6.2-astra-remote', 'openai'],
      ['gpt-6.2-sol-remote', 'openai'],
      ['openai/gpt-6.2-sol-1m', 'openai'],
      ['OPENAI/GPT-6.2-ASTRA', 'openai'],
      ['codex/gpt-6.2-astra', 'openai'],
      ['antigravity-gemini-4-neon', 'google'],
      ['antigravity-gemini-4-carbon', 'google'],
      ['gemini-4-neon', 'google'],
      ['gemini-4-carbon-high', 'google'],
      ['antigravity-gemini-4-neon-remote', 'google'],
      ['google/gemini-4-neon', 'google'],
      ['antigravity/antigravity-gemini-4-carbon', 'google'],
      ['grok-build', 'xai'],
      ['cursor-grok-4.7-high', 'xai'],
      ['cursor-grok-4.7-xhigh', 'xai'],
      ['cursor-grok-4.7-max', 'xai'],
      ['xai/grok-build', 'xai'],
      ['x-ai/grok-build', 'xai'],
      ['deepseek-v4-flash', 'deepseek'],
      ['deepseek-v4-pro', 'deepseek'],
      ['deepseek/deepseek-v4-flash', 'deepseek'],
    ]
    for (const [model, expectedFamily] of admitted) {
      assert.deepEqual(
        evaluateScientificAuditReviewer(model),
        { eligible: true, family: expectedFamily },
        `expected ${model} to be admitted as ${expectedFamily}`,
      )
    }
  })

  it('rejects unapproved suffixes (-pro, box-), weak tiers, mismatched prefixes, and non-4-family models (B8)', () => {
    const nonStrong: Array<[string, string]> = [
      ['gpt-6.2-sol-pro', 'openai'],
      ['gpt-6.2-astra-pro', 'openai'],
      ['openai/gpt-6.2-sol-pro', 'openai'],
      ['box-gpt-6.2-astra', 'openai'],
      ['box-gpt-6.2-sol', 'openai'],
      ['gpt-6-luna', 'openai'],
      ['gpt-5.6-sol', 'openai'],
      ['antigravity-gemini-4-hydrogen', 'google'],
      ['antigravity-orchestrator-neon', 'google'],
      ['gemini-4-pro', 'google'],
      ['google/gemini-4-hydrogen', 'google'],
      ['google/gpt-6.2-astra', 'google'],
      ['grok-build-fast', 'xai'],
      ['xai/grok-build-fast', 'xai'],
      ['openai/grok-build', 'xai'],
      ['deepseek-v3', 'deepseek'],
    ]
    for (const [model, expectedFamily] of nonStrong) {
      assert.deepEqual(
        evaluateScientificAuditReviewer(model),
        { eligible: false, family: expectedFamily, reason: 'non_strong_tier' },
        `expected ${model} to be rejected as non_strong_tier (${expectedFamily})`,
      )
    }

    const familyNotAllowed: Array<[string, string]> = [
      ['anthropic/gpt-6.2-astra', 'anthropic'],
      ['box-api-claude-opus-5-5', 'anthropic'],
      ['glm-5.3-flash-go', 'zhipu'],
      ['qwen3.7-plus-go', 'qwen'],
      ['k3.1-pro', 'moonshot'],
      ['minimax-m3-go', 'minimax'],
      ['antigravity-gpt-oss-120b', 'gpt_oss'],
      ['cursor-auto', 'cursor_auto'],
    ]
    for (const [model, expectedFamily] of familyNotAllowed) {
      assert.deepEqual(
        evaluateScientificAuditReviewer(model),
        { eligible: false, family: expectedFamily, reason: 'family_not_allowed' },
        `expected ${model} to be rejected as family_not_allowed (${expectedFamily})`,
      )
    }
  })
})
