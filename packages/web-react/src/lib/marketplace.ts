// 市场纯函数助手 —— 升级可见性、分区导航与发布校验的唯一权威（面板间共享，可测）。
import {
  MARKETPLACE_CATEGORIES,
  isMarketplaceCategoryId,
} from '@openclaude/protocol'
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

/** 一个分类分区(浏览分区视图的一块)。 */
export type MarketplaceCategorySection = {
  id: string
  label: string
  blurb: string
  cards: MarketplaceCard[]
}

/** 分区视图的完整结构:平台精选 + 按 taxonomy 顺序的分类分区 + 未分类兜底。 */
export type MarketplaceGrouped = {
  /** featuredRank 非空的卡片(服务端已按 rank ASC 排;此处仅过滤,不重排)。 */
  featured: MarketplaceCard[]
  /** 按 MARKETPLACE_CATEGORIES 顺序的分区;空分区已剔除。 */
  categories: MarketplaceCategorySection[]
  /** 分类缺失/未知(存量 NULL)的卡片,兜底成「未分类」分区。 */
  uncategorized: MarketplaceCard[]
}

/**
 * 把目录卡片分区化(空查询浏览视图用)。**信任服务端顺序** —— 不再自行按热度重排,
 * 服务端已按 `featured_rank ASC NULLS LAST, installCount DESC, id DESC` 排好;这里
 * 只做纯分组,保持组内相对顺序不变。
 *
 * 设计:featured 是平台运维的少量精选高亮,与它所属分类**共存**(既出现在「平台精选」,
 * 也出现在自己的分类分区里),故分类计数如实反映该分类的真实成员数,不因精选而减少。
 */
export function groupCardsByCategory(cards: MarketplaceCard[]): MarketplaceGrouped {
  const featured = cards.filter((c) => c.featuredRank != null)
  const categories: MarketplaceCategorySection[] = []
  for (const cat of MARKETPLACE_CATEGORIES) {
    const inCat = cards.filter((c) => c.category === cat.id)
    if (inCat.length > 0)
      categories.push({ id: cat.id, label: cat.label, blurb: cat.blurb, cards: inCat })
  }
  const uncategorized = cards.filter((c) => !isMarketplaceCategoryId(c.category))
  return { featured, categories, uncategorized }
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

// ── 人向元数据发布校验（客户端 UX 预检；服务端 parseHumanMeta 为最终权威） ──
// 约束镜像发布契约(marketplaceMeta.ts):与既有 SLUG_RE/VERSION_RE 一样,前端只做
// 友好预检+禁用提交,后端仍会独立强校验。数值改动须与后端契约同步。
export const USE_CASE_MIN_LEN = 4
export const USE_CASE_MAX_LEN = 120
export const USE_CASES_MAX = 4
export const OUTCOME_MAX_LEN = 200
export const OUTCOMES_MAX = 4
export const HUMAN_MD_MAX_LEN = 16384

/** 发布表单里的人向元数据草稿(受控输入原样,含空串/未 trim)。 */
export type HumanMetaDraft = {
  category: string
  useCases: string[]
  outcomeExamples: string[]
  humanMd: string
}

/**
 * 校验人向元数据;返回**首个**错误的中文文案,全部通过返 null。发布表单据此
 * 阻断提交并展示提示 —— category 必填且合法、useCases 必填 1-4 条且每条 4-120 字、
 * outcomeExamples 选填 ≤4 条每条 ≤200 字、humanMd 选填 ≤16384 字。
 */
export function validateHumanMeta(d: HumanMetaDraft): string | null {
  if (!isMarketplaceCategoryId(d.category)) return '请为它选择一个分类'
  const uc = d.useCases.map((s) => s.trim()).filter(Boolean)
  if (uc.length < 1) return '请至少填写 1 条适用场景'
  if (uc.length > USE_CASES_MAX) return `适用场景最多 ${USE_CASES_MAX} 条`
  if (uc.some((s) => s.length < USE_CASE_MIN_LEN || s.length > USE_CASE_MAX_LEN))
    return `每条适用场景需 ${USE_CASE_MIN_LEN}–${USE_CASE_MAX_LEN} 字`
  const oc = d.outcomeExamples.map((s) => s.trim()).filter(Boolean)
  if (oc.length > OUTCOMES_MAX) return `效果示例最多 ${OUTCOMES_MAX} 条`
  if (oc.some((s) => s.length > OUTCOME_MAX_LEN)) return `每条效果示例不超过 ${OUTCOME_MAX_LEN} 字`
  if (d.humanMd.trim().length > HUMAN_MD_MAX_LEN) return `详细介绍不超过 ${HUMAN_MD_MAX_LEN} 字`
  return null
}

/** 由显示名生成 slug 建议（发布表单联动；与后端 SLUG_RE 对齐）。 */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
