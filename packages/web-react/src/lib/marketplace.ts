// 市场纯函数助手 —— 升级可见性与目录排序的唯一权威（面板间共享，可测）。
import type { MarketplaceCard, MarketplaceInstalled } from './types'

/**
 * 该安装是否有新版本可更新：listing 仍在架（active）、后端带回了当前上架版本、
 * 且与安装 pin 的版本不同。revoked（已下架）不算可更新——那是「已失效」态。
 */
export function updateAvailable(
  row: Pick<MarketplaceInstalled, 'listingState' | 'versionId' | 'latestVersionId'>,
): boolean {
  return (
    row.listingState === 'active' && !!row.latestVersionId && row.latestVersionId !== row.versionId
  )
}

/**
 * 目录态（空查询）按热度排序：安装数降序，相等时保持后端顺序（新→旧）稳定。
 * 只对已取回的目录集排序 —— 有查询词时不介入（相关度排序归后端）。
 */
export function sortByPopularity(cards: MarketplaceCard[]): MarketplaceCard[] {
  return [...cards].sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0))
}

/** 「N 人在用」的紧凑显示（1200 → 1.2k）。 */
export function formatInstallCount(n: number | undefined): string | null {
  if (!n || n <= 0) return null
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return String(n)
}

/** 由显示名生成 slug 建议（发布表单联动；与后端 SLUG_RE 对齐）。 */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
