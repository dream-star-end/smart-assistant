/**
 * TTL parse / expiry boundary for auto-written Core memories.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/memoryTtl.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  AUTO_MEMORY_TTL_DAYS,
  addCalendarDays,
  defaultAutoExpires,
  isMemoryExpired,
  memoryCalendarDate,
  parseMemoryExpires,
} = await import('../memoryTtl.js')

describe('memoryTtl', () => {
  it('formats and adds days in UTC without calling Date.now in the comparator', () => {
    assert.equal(memoryCalendarDate(new Date(Date.UTC(2026, 7, 18))), '2026-08-18')
    assert.equal(addCalendarDays('2026-08-18', AUTO_MEMORY_TTL_DAYS), '2026-09-17')
    assert.equal(defaultAutoExpires('2026-08-18'), '2026-09-17')
  })

  it('expires only after the calendar day (today still valid)', () => {
    const warns: string[] = []
    const warn = (m: string) => warns.push(m)
    assert.equal(isMemoryExpired('2026-08-17', '2026-08-18', warn), true)
    assert.equal(isMemoryExpired('2026-08-18', '2026-08-18', warn), false)
    assert.equal(isMemoryExpired('2026-08-19', '2026-08-18', warn), false)
    assert.equal(isMemoryExpired(undefined, '2026-08-18', warn), false)
    assert.equal(isMemoryExpired('not-a-date', '2026-08-18', warn), false)
    assert.equal(isMemoryExpired('2026-13-40', '2026-08-18', warn), false)
    assert.ok(warns.some((m) => m.includes('not-a-date')))
    assert.ok(warns.some((m) => m.includes('2026-13-40')))
  })

  it('parseMemoryExpires keeps invalid values as never-expire', () => {
    const warns: string[] = []
    assert.equal(parseMemoryExpires(undefined), null)
    assert.equal(parseMemoryExpires('2026-08-18'), '2026-08-18')
    assert.equal(parseMemoryExpires('bogus', (m) => warns.push(m), 'x.md'), null)
    assert.ok(warns[0]?.includes('x.md'))
  })
})
