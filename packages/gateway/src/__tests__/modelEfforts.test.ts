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
  it('gpt-5.5 (codex reasoning depth) → low/medium/high/xhigh, tolerant of id variants', () => {
    const expected = ['low', 'medium', 'high', 'xhigh']
    assert.deepEqual(effortsForModel('gpt-5.5'), expected)
    assert.deepEqual(effortsForModel('GPT-5.5'), expected)
    assert.deepEqual(effortsForModel('openai/gpt-5.5'), expected)
    // codex has no 'max' depth — must not appear.
    assert.ok(!effortsForModel('gpt-5.5').includes('max'))
  })

  it('Claude family depths', () => {
    assert.deepEqual(effortsForModel('claude-opus-4-8'), ['high', 'xhigh', 'max'])
    assert.deepEqual(effortsForModel('claude-opus-4-7'), ['xhigh', 'max'])
    assert.deepEqual(effortsForModel('claude-sonnet-4-6'), ['high', 'xhigh'])
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
