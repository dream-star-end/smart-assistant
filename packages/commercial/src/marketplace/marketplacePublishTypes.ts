import type { RiskFlag } from './skillScanner.js';
import type { MarketplacePluginType } from '@openclaude/protocol';
import type { ArtifactKind } from './marketplaceDb.js';

export interface PublishInput {
  slug: string
  ownerUserId: number
  version: string
  name: string
  description: string
  tags: string[]
  /** Skill artifact (full SKILL.md). Required for kind='skill'; null for agents. */
  rawSkillMd: string | null
  /** Generic raw published text. Defaults to rawSkillMd for skills. */
  rawArtifact?: string
  /** Structured per-kind metadata (agent: model/toolsets/skillDeps). */
  manifest?: unknown
  artifactHash: string
  embeddingHash: string
  riskFlags: RiskFlag[]
  policyVersion: number
  submittedBy: number
  /** Artifact kind; the listing is owner- AND kind-locked. Defaults to 'skill'. */
  kind?: ArtifactKind
  /** Required for kind='connector'; null/omitted for Skill and Agent. */
  pluginType?: MarketplacePluginType | null
  /**
   * 可见范围(企业版 P3.1):null/缺省 = 公开;非空 = 仅该 org 成员可见/可装(listing.org_id)。
   * 仅在**首次创建 listing** 时落库(org_id 与 owner/kind 同为 listing 级不可变属性,
   * 后续新版本不改可见性——ON CONFLICT DO NOTHING 保留原 org_id)。路由层保证:传非空时
   * 发布者必须是该 org 的 active 成员。
   */
  orgId?: string | null
  /** SKILL.md 之外的附属文本文件(references/assets/evals;已过 bundle 校验)。 */
  rawBundle?: Record<string, string> | null
  /** 发布者自报评测摘要(展示须标注"发布者提供",非平台背书)。 */
  benchmark?: { withPassRate: number; withoutPassRate: number; cases: number } | null
  /**
   * 人向商品层元数据(storefront,**不进工件、不影响 artifactHash**;校验权威 = marketplaceMeta.parseHumanMeta)。
   * 用户面两条路由强制传;平台 seed 可只传 category/useCases(缺省 → null/[])。
   */
  category?: string | null
  useCases?: string[]
  outcomeExamples?: string[]
  humanMd?: string | null
  /**
   * 是否将本 pending 版本纳入 AI 自动审批队列(ai_review_state='queued')。默认 **true**:
   * 所有用户面发布路径(web 发布 / oc-market AI 自助发布)自动入列,未来新增发布路径也
   * 默认受审 —— fail toward review。唯一 opt-out 是 platform seed(seedPlatformAgents 直接
   * approvePlatformVersion,不走人审/AI),它显式传 false → ai_review_state 恒 NULL → worker
   * 永不 claim,确保「platform seed 不走 AI」这条红线在数据层结构性成立(非依赖时序竞态)。
   */
  queueAiReview?: boolean
}
