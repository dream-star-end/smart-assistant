// OCV5-368: Box Opus/Sonnet 5.5 requests carry the model's official 128k output
// cap (the Box CLI's own default), not CCB's generic 32k default.
import { afterEach, describe, expect, test } from 'bun:test'
import { getModelMaxOutputTokens } from '../context.js'
import { getMaxOutputTokensForModel } from '../../services/api/claude.js'

const saved = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = saved
})

describe('Box API output cap', () => {
  test('Box Opus and Sonnet 5.5 default to and are bounded by 128000', () => {
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    for (const model of ['box-api-claude-opus-5-5', 'box-api-claude-sonnet-5-5']) {
      expect(getModelMaxOutputTokens(model)).toEqual({ default: 128_000, upperLimit: 128_000 })
      expect(getMaxOutputTokensForModel(model)).toBe(128_000)
    }
  })

  test('an explicit lower env value still wins, a higher one is bounded', () => {
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000'
    expect(getMaxOutputTokensForModel('box-api-claude-opus-5-5')).toBe(20_000)
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '200000'
    expect(getMaxOutputTokensForModel('box-api-claude-opus-5-5')).toBe(128_000)
  })

  test('other models, both Box haikus and near-miss ids keep their previous caps', () => {
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    for (const model of ['box-api-claude-haiku-4-5', 'box-api-claude-haiku-5-5',
      'box-api-claude-opus-5-5 ', 'BOX-API-CLAUDE-OPUS-5-5', 'box-claude-opus-5-5', 'toString']) {
      expect(getModelMaxOutputTokens(model)).toEqual({ default: 32_000, upperLimit: 64_000 })
    }
  })
})
