import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { selectRunsToEvict } from '../skillJobRetention.js'

const DAY = 24 * 60 * 60 * 1000
const cfg = (over = {}) => ({
  now: 100 * DAY,
  retentionMs: 7 * DAY,
  keepPerSkill: 2,
  maxEntries: 100,
  ...over,
})

describe('selectRunsToEvict · S-02 retention policy', () => {
  it('never evicts non-terminal runs even when ancient', () => {
    const entries = [
      { id: 'a', skillKey: 's', finishedAt: 0, evictable: false }, // active/diff_ready, very old
    ]
    assert.deepEqual([...selectRunsToEvict(entries, cfg())], [])
  })

  it('evicts terminal runs older than retention (isolating age via keepPerSkill:0)', () => {
    const entries = [
      { id: 'old', skillKey: 's', finishedAt: 100 * DAY - 8 * DAY, evictable: true },
      { id: 'fresh', skillKey: 's', finishedAt: 100 * DAY - 1 * DAY, evictable: true },
    ]
    const out = selectRunsToEvict(entries, cfg({ keepPerSkill: 0 }))
    assert.equal(out.has('old'), true)
    assert.equal(out.has('fresh'), false)
  })

  it('keeps the newest N terminal runs per skill regardless of age', () => {
    // 3 ancient terminal runs, keepPerSkill=2 → only the oldest one is evicted.
    const entries = [
      { id: 'r1', skillKey: 's', finishedAt: 10 * DAY, evictable: true },
      { id: 'r2', skillKey: 's', finishedAt: 11 * DAY, evictable: true },
      { id: 'r3', skillKey: 's', finishedAt: 12 * DAY, evictable: true },
    ]
    const out = selectRunsToEvict(entries, cfg())
    assert.deepEqual([...out], ['r1']) // r2,r3 protected as newest-2
  })

  it('keep-floor is per skill, not global', () => {
    const entries = [
      { id: 'a1', skillKey: 'a', finishedAt: 10 * DAY, evictable: true },
      { id: 'a2', skillKey: 'a', finishedAt: 11 * DAY, evictable: true },
      { id: 'b1', skillKey: 'b', finishedAt: 10 * DAY, evictable: true },
    ]
    // keepPerSkill=2 → a1,a2 both protected; b1 protected (only 1 for b). None evicted.
    assert.deepEqual([...selectRunsToEvict(entries, cfg())], [])
  })

  it('enforces maxEntries by evicting oldest unprotected terminal runs, sparing active + keep-floor', () => {
    const entries = [
      { id: 'active', skillKey: 's', finishedAt: 0, evictable: false },
      { id: 't1', skillKey: 's', finishedAt: 99 * DAY, evictable: true },
      { id: 't2', skillKey: 's', finishedAt: 99.5 * DAY, evictable: true },
      { id: 't3', skillKey: 's', finishedAt: 99.8 * DAY, evictable: true },
    ]
    // all terminal are fresh (< retention). keepPerSkill=2 protects t2,t3. maxEntries=3
    // → 4 entries, must drop 1 → the only unprotected terminal is t1.
    const out = selectRunsToEvict(entries, cfg({ maxEntries: 3 }))
    assert.deepEqual([...out], ['t1'])
    assert.equal(out.has('active'), false)
  })

  it('cap eviction never touches active even if over cap', () => {
    const entries = [
      { id: 'a1', skillKey: 's', finishedAt: 0, evictable: false },
      { id: 'a2', skillKey: 's', finishedAt: 0, evictable: false },
    ]
    // both active, maxEntries=1 → cannot evict active → returns empty.
    assert.deepEqual([...selectRunsToEvict(entries, cfg({ maxEntries: 1 }))], [])
  })
})
