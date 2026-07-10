/**
 * 市场「人向商品层」发布元数据的**单一校验权威**。
 *
 * 两条用户面发布路径(浏览器 marketplaceRoutes / 容器 internalMarketplaceAgent)都调
 * {@link parseHumanMeta} 做完全相同的校验,不各写一套 —— 否则字段约束会在两处漂移。
 * 校验失败抛携带 code 的 {@link HumanMetaError},两个路由各自映射到 400(带 code)。
 *
 * 语义(数据契约,与 protocol 枚举 + 0127 迁移列一一对应):
 *   - category        必填,须 ∈ MARKETPLACE_CATEGORIES(枚举权威在 @openclaude/protocol)。
 *   - useCases        必填 1-4 条,每条 trim 后 4-120 字符(「适用场景」)。
 *   - outcomeExamples 选填 0-4 条,每条 trim 后 ≤200 字符(「给它 X→得到 Y」的效果示例);
 *                     trim 后为空的行直接丢弃(前端动态列表允许留空行)。
 *   - humanMd         选填,≤16384 字符(人向富介绍,Markdown 渲染);trim 后为空 → null。
 *
 * 平台 seed(seedPlatformAgents)走 publishSkillVersion 直发、**不过本校验**,故其新字段全部
 * 可选(缺省=null/[]);但用户面两条路由必须强制,这就是本文件的职责边界。
 */
import { isMarketplaceCategoryId } from '@openclaude/protocol'

export type HumanMetaErrorCode = 'BAD_CATEGORY' | 'BAD_USE_CASES' | 'BAD_OUTCOMES' | 'BAD_HUMAN_MD'

/** 校验失败错误,携带路由可直接映射为 400 的稳定 code。 */
export class HumanMetaError extends Error {
  constructor(
    readonly code: HumanMetaErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HumanMetaError'
  }
}

export interface HumanMeta {
  /** 分类 id(∈ 枚举)。 */
  category: string
  /** 适用场景(1-4 条,已 trim)。 */
  useCases: string[]
  /** 效果示例(0-4 条,已 trim,已丢弃空行)。 */
  outcomeExamples: string[]
  /** 富介绍(Markdown);无 → null。 */
  humanMd: string | null
}

/** 约束常量(与 0127 迁移头注 / 前端表单一致)。 */
export const USE_CASE_MIN = 4
export const USE_CASE_MAX = 120
export const USE_CASES_MAX_COUNT = 4
export const OUTCOME_MAX = 200
export const OUTCOMES_MAX_COUNT = 4
export const HUMAN_MD_MAX = 16384

/**
 * 校验并归一化用户面发布体里的人向元数据。纯函数(不做扫描/落库);扫描由路由拿
 * {@link humanMetaScanBody} 的拼接文本过 scanSkillArtifact(blocked→422),防密钥/注入进商品页。
 */
export function parseHumanMeta(body: Record<string, unknown>): HumanMeta {
  // ── category:必填 ∈ 枚举 ──
  const category = body.category
  if (!isMarketplaceCategoryId(category))
    throw new HumanMetaError('BAD_CATEGORY', '请选择一个有效的分类')

  // ── useCases:必填 1-4 条,每条 trim 后 4-120 字符 ──
  const rawUseCases = body.useCases
  if (!Array.isArray(rawUseCases))
    throw new HumanMetaError('BAD_USE_CASES', 'useCases 须为字符串数组')
  const useCases: string[] = []
  for (const uc of rawUseCases) {
    if (typeof uc !== 'string')
      throw new HumanMetaError('BAD_USE_CASES', '适用场景每条须为字符串')
    const t = uc.trim()
    if (t.length < USE_CASE_MIN || t.length > USE_CASE_MAX)
      throw new HumanMetaError(
        'BAD_USE_CASES',
        `适用场景每条须为 ${USE_CASE_MIN}-${USE_CASE_MAX} 字符`,
      )
    useCases.push(t)
  }
  if (useCases.length < 1 || useCases.length > USE_CASES_MAX_COUNT)
    throw new HumanMetaError('BAD_USE_CASES', `适用场景须填 1-${USE_CASES_MAX_COUNT} 条`)

  // ── outcomeExamples:选填 0-4 条,每条 trim 后 ≤200 字符;空行丢弃 ──
  const outcomeExamples: string[] = []
  const rawOutcomes = body.outcomeExamples
  if (rawOutcomes !== undefined && rawOutcomes !== null) {
    if (!Array.isArray(rawOutcomes))
      throw new HumanMetaError('BAD_OUTCOMES', 'outcomeExamples 须为字符串数组')
    for (const oc of rawOutcomes) {
      if (typeof oc !== 'string')
        throw new HumanMetaError('BAD_OUTCOMES', '效果示例每条须为字符串')
      const t = oc.trim()
      if (!t) continue // 前端动态列表允许留空行 → 丢弃
      if (t.length > OUTCOME_MAX)
        throw new HumanMetaError('BAD_OUTCOMES', `效果示例每条须 ≤${OUTCOME_MAX} 字符`)
      outcomeExamples.push(t)
    }
    if (outcomeExamples.length > OUTCOMES_MAX_COUNT)
      throw new HumanMetaError('BAD_OUTCOMES', `效果示例最多 ${OUTCOMES_MAX_COUNT} 条`)
  }

  // ── humanMd:选填,≤16384 字符;trim 后为空 → null ──
  let humanMd: string | null = null
  const rawHuman = body.humanMd
  if (rawHuman !== undefined && rawHuman !== null) {
    if (typeof rawHuman !== 'string')
      throw new HumanMetaError('BAD_HUMAN_MD', '详细介绍须为字符串')
    if (rawHuman.length > HUMAN_MD_MAX)
      throw new HumanMetaError('BAD_HUMAN_MD', `详细介绍须 ≤${HUMAN_MD_MAX} 字符`)
    const t = rawHuman.trim()
    humanMd = t.length ? t : null
  }

  return { category, useCases, outcomeExamples, humanMd }
}

/**
 * 把人向元数据拼成一段纯文本,供发布路由复用 scanSkillArtifact 对正文的同一套安全扫描
 * (密钥/注入/内网地址对商品页文案同样有害)。category 是枚举 id,无需扫描。
 */
export function humanMetaScanBody(meta: HumanMeta): string {
  return [...meta.useCases, ...meta.outcomeExamples, meta.humanMd ?? ''].join('\n')
}
