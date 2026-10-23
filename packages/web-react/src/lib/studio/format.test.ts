import { describe, expect, test } from 'vitest'
import { budgetPercent, formatAgo, formatCredits, formatDuration, formatTimecode } from './format'

describe('studio format (OCV5-593)', () => {
  test('credits, durations and time codes', () => {
    expect(formatCredits('32205')).toBe('32,205')
    expect(formatDuration(37)).toBe('0:37')
    expect(formatDuration(75)).toBe('1:15')
    expect(formatTimecode(2.4)).toBe('00:02.4')
    expect(formatTimecode(66)).toBe('01:06.0')
  })

  test('relative time', () => {
    const now = Date.parse('2026-10-23T10:00:00Z')
    expect(formatAgo('2026-10-23T09:59:30Z', now)).toBe('刚刚')
    expect(formatAgo('2026-10-23T09:00:00Z', now)).toBe('1 小时前')
    expect(formatAgo('2026-10-22T09:00:00Z', now)).toBe('昨天')
    expect(formatAgo('2026-10-20T09:00:00Z', now)).toBe('3 天前')
    expect(formatAgo('garbage', now)).toBe('')
  })

  test('budget share counts reservations and clamps', () => {
    expect(budgetPercent('500', '500', '2000')).toBe(50)
    expect(budgetPercent('3000', '0', '2000')).toBe(100)
    expect(budgetPercent('1', '0', '0')).toBe(0)
  })
})
