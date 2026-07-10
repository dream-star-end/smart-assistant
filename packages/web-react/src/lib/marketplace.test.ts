import { describe, expect, it } from 'vitest'
import {
  benchmarkBadgeLabel,
  benchmarkSuspect,
  formatInstallCount,
  groupCardsByCategory,
  suggestSlug,
  updateAvailable,
  validateHumanMeta,
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

describe('groupCardsByCategory (分区导航的纯分组;信任服务端顺序)', () => {
  const card = (slug: string, over: Partial<MarketplaceCard> = {}): MarketplaceCard => ({
    slug,
    kind: 'skill',
    name: slug,
    description: '',
    tags: [],
    ...over,
  })

  it('按 taxonomy 顺序分区,空分区剔除,组内保持输入(=服务端)顺序', () => {
    const g = groupCardsByCategory([
      card('a', { category: 'coding-dev' }),
      card('b', { category: 'office-docs' }),
      card('c', { category: 'office-docs' }),
    ])
    // office-docs 在 taxonomy 里排在 coding-dev 之前 → 分区顺序应为 [office-docs, coding-dev]
    expect(g.categories.map((s) => s.id)).toEqual(['office-docs', 'coding-dev'])
    // 组内顺序即输入顺序(b 在 c 前)
    expect(g.categories[0].cards.map((c) => c.slug)).toEqual(['b', 'c'])
    expect(g.categories[0].label).toBe('办公文档')
  })

  it('featured = featuredRank 非空的卡片(仅过滤不重排),与其分类分区共存', () => {
    const g = groupCardsByCategory([
      card('feat', { category: 'office-docs', featuredRank: 0 }),
      card('plain', { category: 'office-docs' }),
    ])
    expect(g.featured.map((c) => c.slug)).toEqual(['feat'])
    // 精选卡片仍出现在自己的分类分区里(计数如实=2)
    const office = g.categories.find((s) => s.id === 'office-docs')
    expect(office?.cards.map((c) => c.slug)).toEqual(['feat', 'plain'])
  })

  it('分类缺失/未知 id → 归入未分类兜底', () => {
    const g = groupCardsByCategory([
      card('x'),
      card('y', { category: null }),
      card('z', { category: 'not-a-real-category' }),
      card('ok', { category: 'daily-tools' }),
    ])
    expect(g.uncategorized.map((c) => c.slug)).toEqual(['x', 'y', 'z'])
    expect(g.categories.map((s) => s.id)).toEqual(['daily-tools'])
  })
})

describe('validateHumanMeta (发布前人向元数据 UX 预检)', () => {
  const base = () => ({
    category: 'coding-dev',
    useCases: ['把一段代码重构得更可读'],
    outcomeExamples: [],
    humanMd: '',
  })

  it('全部合法 → null', () => {
    expect(validateHumanMeta(base())).toBeNull()
  })

  it('分类缺失/非法 → 提示选分类', () => {
    expect(validateHumanMeta({ ...base(), category: '' })).toBe('请为它选择一个分类')
    expect(validateHumanMeta({ ...base(), category: 'bogus' })).toBe('请为它选择一个分类')
  })

  it('适用场景为空(仅空白也算空)→ 提示至少 1 条', () => {
    expect(validateHumanMeta({ ...base(), useCases: [] })).toBe('请至少填写 1 条适用场景')
    expect(validateHumanMeta({ ...base(), useCases: ['   '] })).toBe('请至少填写 1 条适用场景')
  })

  it('适用场景超 4 条 / 单条过短过长 → 各自提示', () => {
    expect(validateHumanMeta({ ...base(), useCases: ['一', '二', '三', '四', '五'] })).toMatch(
      /最多 4 条/,
    )
    expect(validateHumanMeta({ ...base(), useCases: ['太短'] })).toMatch(/4–120 字/)
    expect(validateHumanMeta({ ...base(), useCases: ['x'.repeat(121)] })).toMatch(/4–120 字/)
  })

  it('效果示例超 4 条 / 单条过长 → 提示', () => {
    expect(
      validateHumanMeta({ ...base(), outcomeExamples: ['a', 'b', 'c', 'd', 'e'] }),
    ).toMatch(/效果示例最多 4 条/)
    expect(validateHumanMeta({ ...base(), outcomeExamples: ['y'.repeat(201)] })).toMatch(
      /不超过 200 字/,
    )
  })

  it('详细介绍超长 → 提示', () => {
    expect(validateHumanMeta({ ...base(), humanMd: 'm'.repeat(16385) })).toMatch(/不超过 16384 字/)
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
