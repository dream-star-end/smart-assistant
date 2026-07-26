import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultModels, effortsForModel } from '@openclaude/storage'

/**
 * effortsForModel is the SINGLE authority for which thinking-depth levels a
 * model exposes (frontend gates off /api/agents capability, never hardcodes).
 * These tests lock the family mapping so a model — pool member or an agent's
 * own default — never silently loses its control again (the gpt-5.5 regression).
 */
describe('effortsForModel: capability authority', () => {
  it('Codex GPT-5 reasoning depth includes Sol max and tolerates id variants', () => {
    const common = ['low', 'medium', 'high', 'xhigh']
    const sol = [...common, 'max']
    assert.deepEqual(effortsForModel('gpt-5.6-sol'), sol)
    assert.deepEqual(effortsForModel('GPT-5.6-SOL'), sol)
    assert.deepEqual(effortsForModel('openai/gpt-5.6-sol'), sol)
    assert.deepEqual(effortsForModel('gpt-5.6-terra'), common)
    assert.deepEqual(effortsForModel('gpt-5.6-luna'), common)
    assert.deepEqual(effortsForModel('gpt-5.5'), common)
    assert.deepEqual(effortsForModel('GPT-5.5'), common)
    assert.deepEqual(effortsForModel('openai/gpt-5.5'), common)
    // Only concrete GPT-5.6 variants are valid with ChatGPT-auth Codex.
    assert.deepEqual(effortsForModel('gpt-5.6'), [])
    assert.deepEqual(effortsForModel('gpt-5.6-pro'), [])
    // Sol's native `ultra` is automatic delegation, not the Claude-only
    // `ultracode` mode, so it is not exposed as a plain reasoning depth.
    assert.ok(!effortsForModel('gpt-5.6-sol').includes('ultracode'))
  })

  it('Claude family depths (Fable 5 / Opus expose ultracode = xhigh + Workflow 编排)', () => {
    // Fable 5 — flagship, full ladder + ultracode (best for multi-agent orchestration).
    assert.deepEqual(effortsForModel('claude-fable-5'), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ])
    assert.deepEqual(effortsForModel('CLAUDE-FABLE-5'), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ])
    // Opus 5 — Opus 4.8 successor, same full ladder + ultracode; id-variant tolerant.
    assert.deepEqual(effortsForModel('claude-opus-5'), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ])
    assert.deepEqual(effortsForModel('CLAUDE-OPUS-5'), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ])
    // The opus-5 regex must NOT swallow 4.x ids (they hit their own branches below).
    assert.deepEqual(effortsForModel('claude-opus-4-5'), [])
    assert.deepEqual(effortsForModel('claude-opus-4-8'), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ])
    assert.deepEqual(effortsForModel('claude-opus-4-7'), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ])
    // Sonnet keeps high/xhigh — no ultracode (scope = Opus only).
    assert.deepEqual(effortsForModel('claude-sonnet-4-6'), ['high', 'xhigh'])
    assert.ok(!effortsForModel('claude-sonnet-4-6').includes('ultracode'))
  })

  it('models without an extra thinking-depth control → []', () => {
    assert.deepEqual(effortsForModel('claude-haiku-4-5'), [])
    assert.deepEqual(effortsForModel('MiniMax-M2.7'), [])
    assert.deepEqual(effortsForModel('unknown-model'), [])
    assert.deepEqual(effortsForModel(undefined), [])
    assert.deepEqual(effortsForModel(''), [])
  })

  it('defaultModels() efforts stay derived from effortsForModel (no drift)', () => {
    for (const m of defaultModels()) {
      const derived = effortsForModel(m.id)
      if (derived.length > 0) assert.deepEqual(m.efforts, derived)
      else assert.equal(m.efforts, undefined)
    }
  })
})

console.log('modelEfforts tests passed.')
