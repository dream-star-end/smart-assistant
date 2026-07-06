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

/** 发布者自报评测摘要(聚合值)。—— 前端徽记与黄牌判定共用此形状。 */
export type MarketplaceBenchmark = {
  withPassRate: number;
  withoutPassRate: number;
  cases: number;
};

/**
 * 市场卡片评测徽记文案(仅聚合值)。无 benchmark 返 null —— 调用方据此
 * **完全不渲染该行**(无数据不占位不噪音)。title 恒标注"发布者提供·未经平台
 * 验证",不得当平台背书。百分比四舍五入到整数(与详情页 DetailModal 口径一致)。
 */
export function benchmarkBadgeLabel(
  b?: MarketplaceBenchmark | null,
): { label: string; title: string } | null {
  if (!b) return null;
  return {
    label: `实测 ${Math.round(b.withoutPassRate * 100)}%→${Math.round(b.withPassRate * 100)}%`,
    title: `发布者提供·${b.cases} 用例·未经平台验证`,
  };
}

/**
 * 审核黄牌判定:发布者自报评测「增益存疑」。命中即在审核队列打 warning 徽章,
 * 提示人审留意 —— 不阻断审核(数据为发布者自报、未经平台验证,仅作提示)。
 * 判定依据(任一命中):
 *   - withPassRate ≤ withoutPassRate:装了不比不装好(声称的增益 ≤ 0);
 *   - withPassRate < 0.5:绝对通过率过低(过半用例仍失败)。
 * 无 benchmark → 不判定(返 false,不渲染徽章)。
 */
export function benchmarkSuspect(b?: MarketplaceBenchmark | null): boolean {
  if (!b) return false;
  return b.withPassRate <= b.withoutPassRate || b.withPassRate < 0.5;
}

/** 由显示名生成 slug 建议（发布表单联动；与后端 SLUG_RE 对齐）。 */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
