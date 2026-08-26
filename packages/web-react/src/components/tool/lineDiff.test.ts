/** 行级 LCS diff(F2)的纯函数单测:上下文识别、行号、退化路径。 */
import { describe, expect, test } from 'vitest'
import { diffLines } from './lineDiff'

describe('diffLines', () => {
  test('未变行识别为上下文,变化行标 +/-', () => {
    const rows = diffLines('keep\nold\nkeep2', 'keep\nnew\nkeep2')
    expect(rows.map((r) => `${r.sign}${r.text}`)).toEqual([' keep', '-old', '+new', ' keep2'])
  })

  test('行号:上下文行有双侧行号,增删行单侧', () => {
    const rows = diffLines('a\nb', 'a\nc')
    expect(rows[0]).toEqual({ sign: ' ', oldNo: 1, newNo: 1, text: 'a' })
    expect(rows[1]).toEqual({ sign: '-', oldNo: 2, newNo: null, text: 'b' })
    expect(rows[2]).toEqual({ sign: '+', oldNo: null, newNo: 2, text: 'c' })
  })

  test('纯新增(old 为空)→ 全部 + 行', () => {
    const rows = diffLines('', 'x\ny')
    expect(rows.every((r) => r.sign === '+')).toBe(true)
    expect(rows).toHaveLength(2)
  })

  test('纯删除(new 为空)→ 全部 - 行', () => {
    const rows = diffLines('x\ny', '')
    expect(rows.every((r) => r.sign === '-')).toBe(true)
  })

  test('完全相同 → 全部上下文行', () => {
    const rows = diffLines('a\nb', 'a\nb')
    expect(rows.every((r) => r.sign === ' ')).toBe(true)
  })

  test('超大输入退化为整删整增(不 OOM),行数守恒', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line-${i}`).join('\n')
    const rows = diffLines(big, `${big}\nextra`)
    // 2000*2001 > 上限 → 退化:2000 删 + 2001 增
    expect(rows).toHaveLength(4001)
    expect(rows.filter((r) => r.sign === '-')).toHaveLength(2000)
    expect(rows.filter((r) => r.sign === '+')).toHaveLength(2001)
  })
})
