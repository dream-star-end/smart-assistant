import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bonusForTrustLevel } from '../auth/socialLogin.js'

/**
 * 纯函数单测 — bonusForTrustLevel 把 LDC trust_level 映射到 cents + effective TL。
 * 阶梯定义在 socialLogin.ts 顶部,与 linux.do 推广策略绑定:
 *   TL0=300, TL1=500, TL2=1000, TL3=2000, TL4=3000 (cents)
 */
describe('auth.bonusForTrustLevel', () => {
  test('null → TL0 (300 cents)', () => {
    const r = bonusForTrustLevel(null)
    assert.equal(r.bonusCents, 300n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('undefined → TL0', () => {
    const r = bonusForTrustLevel(undefined)
    assert.equal(r.bonusCents, 300n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('negative -1 → TL0 (defensive fallback)', () => {
    const r = bonusForTrustLevel(-1)
    assert.equal(r.bonusCents, 300n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('non-integer 1.5 → TL0', () => {
    const r = bonusForTrustLevel(1.5)
    assert.equal(r.bonusCents, 300n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('NaN → TL0', () => {
    const r = bonusForTrustLevel(Number.NaN)
    assert.equal(r.bonusCents, 300n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('Infinity → clamp to TL4 via tl>=4 guard? No — !Number.isInteger(Infinity)=true so falls to TL0', () => {
    // Number.isInteger(Infinity) === false,所以走 isInteger 兜底分支,结果 TL0。
    // 这是合理的:LDC 不可能返 Infinity,真出现就当异常处理。
    const r = bonusForTrustLevel(Number.POSITIVE_INFINITY)
    assert.equal(r.bonusCents, 300n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('-Infinity → TL0', () => {
    const r = bonusForTrustLevel(Number.NEGATIVE_INFINITY)
    assert.equal(r.bonusCents, 300n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('0 → TL0 (300 cents)', () => {
    const r = bonusForTrustLevel(0)
    assert.equal(r.bonusCents, 300n)
    assert.equal(r.effectiveTrustLevel, 0)
  })

  test('1 → TL1 (500 cents)', () => {
    const r = bonusForTrustLevel(1)
    assert.equal(r.bonusCents, 500n)
    assert.equal(r.effectiveTrustLevel, 1)
  })

  test('2 → TL2 (1000 cents)', () => {
    const r = bonusForTrustLevel(2)
    assert.equal(r.bonusCents, 1000n)
    assert.equal(r.effectiveTrustLevel, 2)
  })

  test('3 → TL3 (2000 cents)', () => {
    const r = bonusForTrustLevel(3)
    assert.equal(r.bonusCents, 2000n)
    assert.equal(r.effectiveTrustLevel, 3)
  })

  test('4 → TL4 (3000 cents)', () => {
    const r = bonusForTrustLevel(4)
    assert.equal(r.bonusCents, 3000n)
    assert.equal(r.effectiveTrustLevel, 4)
  })

  test('5 → clamp to TL4 (3000 cents)', () => {
    // Discourse 实际上限是 4,不会出 5+,但代码 clamp 防御
    const r = bonusForTrustLevel(5)
    assert.equal(r.bonusCents, 3000n)
    assert.equal(r.effectiveTrustLevel, 4)
  })

  test('100 → clamp to TL4', () => {
    const r = bonusForTrustLevel(100)
    assert.equal(r.bonusCents, 3000n)
    assert.equal(r.effectiveTrustLevel, 4)
  })
})
