/** 行级 LCS diff(F2)的纯函数单测:上下文识别、行号、退化路径。 */
import { describe, expect, test } from 'vitest'
import { diffLines } from './lineDiff'
import { collapseDiffContext, diffStats, parseUnifiedDiffLines } from './diffHunk'

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

describe('OCV5-817 diffStats / collapseDiffContext / parseUnifiedDiffLines', () => {
  test('diffStats 精确统计新增与删除行数', () => {
    const rows = diffLines('a\nb\nc', 'a\nb2\nc\nd')
    expect(diffStats(rows)).toEqual({ added: 2, removed: 1 })
  })

  test('collapseDiffContext 按 ±3 行折叠中间大段未改动上下文，展开单个 gap 后恢复', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`)
    const after = [...before]
    after[0] = 'line-1-changed'
    after[19] = 'line-20-changed'
    const rows = diffLines(before.join('\n'), after.join('\n'))
    const collapsed = collapseDiffContext(rows, 3)
    const gaps = collapsed.filter((e) => e.kind === 'gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.kind === 'gap' && gaps[0]!.count).toBeGreaterThanOrEqual(10)

    const expanded = collapseDiffContext(rows, 3, new Set([gaps[0]!.kind === 'gap' ? gaps[0]!.start : -1]))
    expect(expanded.filter((e) => e.kind === 'gap')).toHaveLength(0)
    expect(expanded).toHaveLength(rows.length)
  })

  test('parseUnifiedDiffLines 区分 file-header / hunk-header 与行号统计', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10,3 +10,3 @@ export function demo() {',
      ' const keep = 1;',
      '-const oldVal = 2;',
      '+const newVal = 3;',
    ].join('\n')
    const parsed = parseUnifiedDiffLines(diff)
    expect(parsed.added).toBe(1)
    expect(parsed.removed).toBe(1)
    expect(parsed.lines[0]?.kind).toBe('file-header')
    expect(parsed.lines[1]?.kind).toBe('file-header')
    expect(parsed.lines[2]?.kind).toBe('hunk-header')
    expect(parsed.lines[3]).toMatchObject({ kind: 'context', oldNo: 10, newNo: 10, text: 'const keep = 1;' })
    expect(parsed.lines[4]).toMatchObject({ kind: 'del', oldNo: 11, newNo: null, text: 'const oldVal = 2;' })
    expect(parsed.lines[5]).toMatchObject({ kind: 'add', oldNo: null, newNo: 11, text: 'const newVal = 3;' })
  })
})
