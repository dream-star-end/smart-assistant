/**
 * OCV5-755 phase 2: a pre-expiry idle op compacts from the gateway's floor;
 * other idle ops keep the near-limit fit. The 400k working window lowers the
 * ordinary autocompact threshold without touching the model's own window.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { outerHistoryNeedsCompact } from './idleRecover'
import { getAutoCompactThreshold, getEffectiveContextWindowSize } from './autoCompact'

const fit = (inputTokens: number) => ({ inputTokens, inputBudget: 822_000 })

describe('idle compaction floor', () => {
  test('without a floor a 300k history is short (pre-OCV5-755 behavior)', () => {
    expect(outerHistoryNeedsCompact([], fit(300_000))).toBe(false)
  })
  test('a pre-expiry floor compacts a 300k history', () => {
    expect(outerHistoryNeedsCompact([], fit(300_000), 167_000)).toBe(true)
  })
  test('below the floor stays short', () => {
    expect(outerHistoryNeedsCompact([], fit(120_000), 167_000)).toBe(false)
  })
  test('the floor never raises the near-limit budget', () => {
    expect(outerHistoryNeedsCompact([], fit(830_000), 900_000)).toBe(true)
  })
  test('invalid floors are ignored', () => {
    expect(outerHistoryNeedsCompact([], fit(300_000), 0)).toBe(false)
    expect(outerHistoryNeedsCompact([], fit(300_000), Number.NaN)).toBe(false)
  })
})

describe('400k working window', () => {
  const model = 'claude-opus-4-1[1m]'
  afterEach(() => {
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  })
  test('the env caps the autocompact window below the model window', () => {
    const full = getEffectiveContextWindowSize(model)
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '400000'
    const capped = getEffectiveContextWindowSize(model)
    expect(capped).toBeLessThan(full)
    expect(capped).toBeLessThanOrEqual(400_000)
    expect(getAutoCompactThreshold(model)).toBeLessThan(400_000)
    expect(getAutoCompactThreshold(model)).toBeGreaterThan(300_000)
  })
  test('an empty env value (non-Box models) keeps the model window', () => {
    const full = getEffectiveContextWindowSize(model)
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = ''
    expect(getEffectiveContextWindowSize(model)).toBe(full)
  })
})
