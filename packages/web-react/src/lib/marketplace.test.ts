import { describe, expect, it } from 'vitest'
import {
  benchmarkBadgeLabel,
  benchmarkSuspect,
  formatInstallCount,
  sortByPopularity,
  suggestSlug,
  updateAvailable,
} from './marketplace'
import type { MarketplaceCard } from './types'

describe('updateAvailable', () => {
  it('true only when active listing has a different current version', () => {
    expect(updateAvailable({ listingState: 'active', versionId: '1', latestVersionId: '2' })).toBe(
      true,
    )
    expect(updateAvailable({ listingState: 'active', versionId: '2', latestVersionId: '2' })).toBe(
      false,
    )
  })

  it('revoked listing is never updatable (it is the dead state, not an upgrade)', () => {
    expect(updateAvailable({ listingState: 'revoked', versionId: '1', latestVersionId: '2' })).toBe(
      false,
    )
  })

  it('missing latestVersionId (old backend / no approved version) → false', () => {
    expect(updateAvailable({ listingState: 'active', versionId: '1', latestVersionId: null })).toBe(
      false,
    )
    expect(
      updateAvailable({ listingState: 'active', versionId: '1', latestVersionId: undefined }),
    ).toBe(false)
  })
})

describe('sortByPopularity', () => {
  const card = (slug: string, installCount?: number): MarketplaceCard => ({
    slug,
    kind: 'skill',
    name: slug,
    description: '',
    tags: [],
    installCount,
  })

  it('sorts by installCount desc, stable for ties, missing counts as 0', () => {
    const sorted = sortByPopularity([card('a', 1), card('b', 5), card('c'), card('d', 1)])
    expect(sorted.map((c) => c.slug)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('does not mutate the input array', () => {
    const input = [card('a', 1), card('b', 5)]
    sortByPopularity(input)
    expect(input.map((c) => c.slug)).toEqual(['a', 'b'])
  })
})

describe('formatInstallCount', () => {
  it('hides zero/undefined, keeps small numbers, compacts thousands', () => {
    expect(formatInstallCount(undefined)).toBeNull()
    expect(formatInstallCount(0)).toBeNull()
    expect(formatInstallCount(37)).toBe('37')
    expect(formatInstallCount(1000)).toBe('1k')
    expect(formatInstallCount(1234)).toBe('1.2k')
  })
})

describe('suggestSlug', () => {
  it('lowercases, collapses illegal runs to hyphens, trims edges, caps at 64', () => {
    expect(suggestSlug('Academic Translate!')).toBe('academic-translate')
    expect(suggestSlug('  中文名 skill ')).toBe('skill')
    expect(suggestSlug('a'.repeat(80))).toHaveLength(64)
  })
})

describe('benchmarkBadgeLabel (卡片评测徽记的渲染决策)', () => {
  it('无 benchmark → null(卡片完全不渲染该行,无数据不占位)', () => {
    expect(benchmarkBadgeLabel(undefined)).toBeNull()
    expect(benchmarkBadgeLabel(null)).toBeNull()
  })

  it('有 benchmark → 「实测 X%→Y%」+ title 标注发布者提供·N 用例·未经平台验证', () => {
    const out = benchmarkBadgeLabel({ withoutPassRate: 0.62, withPassRate: 0.91, cases: 4 })
    expect(out).not.toBeNull()
    expect(out?.label).toBe('实测 62%→91%')
    expect(out?.title).toBe('发布者提供·4 用例·未经平台验证')
  })

  it('百分比四舍五入到整数(与详情页口径一致)', () => {
    const out = benchmarkBadgeLabel({ withoutPassRate: 0.333, withPassRate: 0.666, cases: 3 })
    expect(out?.label).toBe('实测 33%→67%')
  })
})

describe('benchmarkSuspect (审核黄牌判定)', () => {
  it('无 benchmark → false(不渲染黄牌)', () => {
    expect(benchmarkSuspect(undefined)).toBe(false)
    expect(benchmarkSuspect(null)).toBe(false)
  })

  it('增益为正且通过率≥0.5 → false(健康,不打牌)', () => {
    expect(benchmarkSuspect({ withoutPassRate: 0.62, withPassRate: 0.91, cases: 4 })).toBe(false)
    expect(benchmarkSuspect({ withoutPassRate: 0.4, withPassRate: 0.5, cases: 2 })).toBe(false)
  })

  it('withPassRate ≤ withoutPassRate(增益≤0)→ true', () => {
    expect(benchmarkSuspect({ withoutPassRate: 0.8, withPassRate: 0.6, cases: 5 })).toBe(true)
    // 相等也算存疑(装了没变好)
    expect(benchmarkSuspect({ withoutPassRate: 0.7, withPassRate: 0.7, cases: 3 })).toBe(true)
  })

  it('withPassRate < 0.5(绝对通过率过低)→ true,即便有正增益', () => {
    expect(benchmarkSuspect({ withoutPassRate: 0.1, withPassRate: 0.4, cases: 3 })).toBe(true)
  })
})
