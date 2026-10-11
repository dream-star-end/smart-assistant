// OCV5-368: every Box API model request carries the model's official output
// cap (128k for the 5.5 models, 64k for Haiku 4.5), not CCB's generic 32k.
import { afterEach, describe, expect, test } from 'bun:test'
import { getModelMaxOutputTokens } from '../context.js'
import { getMaxOutputTokensForModel } from '../../services/api/claude.js'

const saved = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = saved
})

describe('Box API output cap', () => {
  test('each Box model defaults to and is bounded by its official cap', () => {
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    for (const [model, cap] of [['box-api-claude-opus-5-5', 128_000], ['box-api-claude-sonnet-5-5', 128_000],
      ['box-api-claude-haiku-4-5', 64_000], ['box-api-claude-haiku-5-5', 128_000]] as const) {
      expect(getModelMaxOutputTokens(model)).toEqual({ default: cap, upperLimit: cap })
      expect(getMaxOutputTokensForModel(model)).toBe(cap)
    }
  })

  test('an explicit lower env value still wins, a higher one is bounded', () => {
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000'
    expect(getMaxOutputTokensForModel('box-api-claude-opus-5-5')).toBe(20_000)
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '200000'
    expect(getMaxOutputTokensForModel('box-api-claude-opus-5-5')).toBe(128_000)
    expect(getMaxOutputTokensForModel('box-api-claude-haiku-4-5')).toBe(64_000)
  })

  test('other models and near-miss ids keep their previous caps', () => {
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    for (const model of ['box-api-claude-opus-5-5 ', 'BOX-API-CLAUDE-OPUS-5-5', 'box-api-claude-haiku-4-5-20251001',
      'box-claude-opus-5-5', 'toString']) {
      expect(getModelMaxOutputTokens(model)).toEqual({ default: 32_000, upperLimit: 64_000 })
    }
  })
})
