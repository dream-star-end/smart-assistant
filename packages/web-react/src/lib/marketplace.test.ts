import { describe, expect, it } from 'vitest'
import { formatInstallCount, sortByPopularity, suggestSlug, updateAvailable } from './marketplace'
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
