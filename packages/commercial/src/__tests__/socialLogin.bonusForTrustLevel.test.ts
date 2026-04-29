import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bonusForTrustLevel } from '../auth/socialLogin.js'

/**
 * 纯函数单测 — bonusForTrustLevel 把 LDC trust_level 映射到 cents + effective TL。
 * 2026-04-29 起 LDC 首登统一 ¥5 / 500 cents,与 trust_level 无关。
 * effectiveTrustLevel 仍按原规则规范化(异常→0,正常 clamp 0..4),仅作 audit 标签。
 */
describe('auth.bonusForTrustLevel', () => {
  test('null → bonus 500, TL0 (defensive fallback)', () => {
    const r = bonusForTrustLevel(null)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('undefined → bonus 500, TL0', () => {
    const r = bonusForTrustLevel(undefined)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('negative -1 → bonus 500, TL0 (defensive fallback)', () => {
    const r = bonusForTrustLevel(-1)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('non-integer 1.5 → bonus 500, TL0', () => {
    const r = bonusForTrustLevel(1.5)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('NaN → bonus 500, TL0', () => {
    const r = bonusForTrustLevel(Number.NaN)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('Infinity → bonus 500, TL0 (Number.isInteger(Infinity)=false)', () => {
    const r = bonusForTrustLevel(Number.POSITIVE_INFINITY)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('-Infinity → bonus 500, TL0', () => {
    const r = bonusForTrustLevel(Number.NEGATIVE_INFINITY)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('0 → bonus 500, TL0', () => {
    const r = bonusForTrustLevel(0)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('1 → bonus 500, TL1', () => {
    const r = bonusForTrustLevel(1)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 1)
  })

  test('2 → bonus 500, TL2', () => {
    const r = bonusForTrustLevel(2)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 2)
  })

  test('3 → bonus 500, TL3', () => {
    const r = bonusForTrustLevel(3)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 3)
  })

  test('4 → bonus 500, TL4', () => {
    const r = bonusForTrustLevel(4)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 4)
  })

  test('5 → bonus 500, clamp to TL4', () => {
    // Discourse 实际上限是 4,不会出 5+,但代码 clamp 防御
    const r = bonusForTrustLevel(5)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 4)
  })

  test('100 → bonus 500, clamp to TL4', () => {
    const r = bonusForTrustLevel(100)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 4)
  })
})
