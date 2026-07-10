/**
 * 市场分类体系(taxonomy)——**跨包单一权威**。
 *
 * 消费方:
 *  - commercial 发布校验(marketplace/marketplaceMeta.ts):category 必须 ∈ 本枚举;
 *  - web-react 市场浏览分区/发布表单下拉/详情徽章:按本序渲染(数组顺序=展示顺序);
 *  - gateway oc-market CLI / market baseline skill:向容器内 AI 描述可选分类。
 *
 * 设计约束:
 *  - id 入库(marketplace_skill_versions.category,DB 不建 CHECK——枚举权威只在这一处,
 *    加分类=改这里,不碰迁移);label/blurb 是人向展示文案。
 *  - 分类给「人」导航用,粒度按用户需求域划分,不按技术栈;新增须谨慎(每个分类都是
 *    浏览页一个分区,太多=回到"乱")。
 */

export interface MarketplaceCategoryDef {
  /** 入库/传输用稳定 id(小写 kebab)。 */
  id: string
  /** 人向分类名。 */
  label: string
  /** 一句话说明该分类覆盖什么需求(浏览分区副标题/发布表单提示)。 */
  blurb: string
}

/** 展示顺序即数组顺序(高频需求在前,合集在最后)。 */
export const MARKETPLACE_CATEGORIES: readonly MarketplaceCategoryDef[] = [
  { id: 'office-docs', label: '办公文档', blurb: 'PPT、Word、PDF、周报公文、会议纪要等文档产出' },
  { id: 'data-analysis', label: '数据分析', blurb: 'Excel 处理、统计分析、数据可视化与报表' },
  { id: 'coding-dev', label: '编程开发', blurb: '写代码、调试测试、技术选型与开发者工具' },
  { id: 'research-academic', label: '科研学术', blurb: '文献检索、论文写作、实验设计、学术评审' },
  { id: 'design-creative', label: '设计创意', blurb: '海报、网页视觉、图形创作等设计产出' },
  { id: 'finance-business', label: '金融商业', blurb: '投资研判、商业分析、行业与市场研究' },
  { id: 'daily-tools', label: '实用工具', blurb: '搜索、地图、格式转换等日常效率工具' },
  { id: 'skill-pack', label: '技能包合集', blurb: '一次安装、打包一整套子能力的大型合集' },
] as const

const CATEGORY_BY_ID = new Map(MARKETPLACE_CATEGORIES.map((c) => [c.id, c]))

/** category id 合法性判定(发布校验用)。 */
export function isMarketplaceCategoryId(id: unknown): id is string {
  return typeof id === 'string' && CATEGORY_BY_ID.has(id)
}

/** id → 人向 label;未知/缺失(存量未补齐数据)统一显示「未分类」。 */
export function marketplaceCategoryLabel(id: string | null | undefined): string {
  return (id != null ? CATEGORY_BY_ID.get(id)?.label : undefined) ?? '未分类'
}
