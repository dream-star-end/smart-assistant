import { describe, expect, test } from 'bun:test'
import { roughTokenCountEstimation } from '../roughTokenEstimate.js'

describe('roughTokenCountEstimation', () => {
  test('keeps the four ASCII characters per token heuristic', () => {
    expect(roughTokenCountEstimation('abcdefgh')).toBe(2)
    expect(roughTokenCountEstimation('abcde')).toBe(2)
  })

  test('counts non-ASCII code points conservatively', () => {
    expect(roughTokenCountEstimation('中文测试')).toBe(4)
    expect(roughTokenCountEstimation('abcd中文')).toBe(3)
  })

  test('counts a surrogate-pair emoji once', () => {
    expect(roughTokenCountEstimation('😀')).toBe(1)
  })

  test('puts a reconstructed Chinese 512k history at the proactive compact threshold', () => {
    // 512k execution window - 20k summary output - 13k compact buffer.
    const threshold = 479_000
    expect(roughTokenCountEstimation('界'.repeat(threshold))).toBeGreaterThanOrEqual(threshold)
  })
})
