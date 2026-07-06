import { query, tx, type QueryRunner } from '../db/queries.js'
import { getActiveMembership } from '../org/memberships.js'
/**
 * Postgres data layer for the station-internal skill marketplace (migration 0087).
 *
 * Invariants enforced here (the security-hardened design):
 *  - slug is owner-locked: only the first publisher owns it (anti-squat).
 *  - approved versions are immutable; an update = a NEW pending version.
 *  - installs pin (version_id, artifact_hash); soft-deleted, never physically.
 *  - reviewer must differ from submitter.
 *  - only `approved` versions of `active` listings are searchable / installable.
 */
import type { RiskFlag } from './skillScanner.js'

/** Artifact kind. The marketplace is generalized over this discriminator; the
 *  lifecycle (publish→scan→review→approve→install→sync→revoke) is shared, only
 *  the scanner / install-applier / detail-renderer vary by kind. */
export type ArtifactKind = 'skill' | 'agent'

export class MarketplaceError extends Error {
  constructor(
    readonly code:
      | 'SLUG_OWNED_BY_OTHER'
      | 'LISTING_REVOKED'
      | 'DUPLICATE_VERSION'
      | 'VERSION_NOT_FOUND'
      | 'NOT_PENDING'
      | 'REVIEWER_IS_AUTHOR'
      | 'NOT_INSTALLABLE'
      | 'KIND_MISMATCH'
      | 'ARTIFACT_MISMATCH'
      | 'INSTALL_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'MarketplaceError'
  }
}

export type InstallScopeMode = 'preserve' | 'replace' | 'merge'

const VALID_AGENT_SCOPE_ID_RE = /^[A-Za-z0-9_-]+$/
export const DEFAULT_INSTALL_AGENT_IDS = ['main']

export function normalizeInstallAgentIds(
  input: unknown,
  fallback: readonly string[] = DEFAULT_INSTALL_AGENT_IDS,
): string[] {
  const raw = Array.isArray(input) ? input : fallback
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || !VALID_AGENT_SCOPE_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length > 0) return out
  const fallbackOut =
    raw === fallback ? DEFAULT_INSTALL_AGENT_IDS : normalizeInstallAgentIds(fallback, DEFAULT_INSTALL_AGENT_IDS)
  return fallbackOut.length > 0 ? fallbackOut : DEFAULT_INSTALL_AGENT_IDS
}

function mergeAgentIds(a: readonly string[], b: readonly string[]): string[] {
  return normalizeInstallAgentIds([...a, ...b], DEFAULT_INSTALL_AGENT_IDS)
}

async function lockInstallScope(c: QueryRunner, userId: number, slug: string): Promise<void> {
  await query(
    `SELECT pg_advisory_xact_lock(hashtext('marketplace_install_scope'), hashtext($1::text || ':' || $2::text))`,
    [userId, slug],
    c,
  )
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}

/**
 * Agent-kind marketplace is v5-only. v3 is skill-only (its vanilla UI + container
 * image lack the agent surface), but v3/v5 share one PG including the marketplace
 * tables — so an approved agent listing is, without this gate, discoverable AND
 * installable from v3 where it cannot work (no research baseline skills / CLIs).
 * Every agent-kind surface (search / detail / install, public + internal) gates on
 * this single predicate, keyed on the runtime channel. After v5 graduates to v3
 * the channel collapses and the gate is a no-op.
 */
export function marketplaceAgentsEnabled(
  channel: string = process.env.OC_RUNTIME_CHANNEL?.trim() || 'v3',
): boolean {
  return channel === 'v5'
}

/**
 * caller 的 org 归属(V1 单 org)。null = 无归属 / 只看公开目录。
 *
 * org 可见性 / 越权判定的**单一权威**:任何 listing 枚举/读取/安装校验都传这个值 →
 * 走 orgVisibleFrag 谓词。它决定"我能看见/装哪些 org-private listing"。
 */
export type CallerOrgId = string | null

/**
 * org listing 可见性谓词片段(单一收口):listing 别名 alias 的行对 caller 可见 iff
 * 公开(org_id IS NULL)或属于 caller 的 org($idx)。
 *
 * callerOrgId 传 null 时,`alias.org_id = NULL::bigint` 对任何行都为 UNKNOWN(≠true),
 * 故整个谓词退化为"仅公开"——无需分支 SQL,null 天然 fail-closed(只见公开)。
 * 这正是防泄露 oracle 所需:无 org 归属者永远看不到、也搜不出任何 org-private listing。
 */
function orgVisibleFrag(alias: string, idx: number): string {
  return `(${alias}.org_id IS NULL OR ${alias}.org_id = $${idx}::bigint)`
}

/**
 * 从 uid 解析 caller 的 active org id(复用批次 A 的 getActiveMembership,不重写成员 SQL)。
 * marketplaceRoutes / internalMarketplaceAgent 现有 handler 都 requireAuth 拿 uid,
 * 需要 org 可见性时调本函数。无 active 归属 → null(只见公开)。
 *
 * 注:这里按成员 active 归属解析(getActiveMembership 语义),不额外判 org.status;org
 * 停用的强制点在 /api/org/*(requireOrgRole 403)与 sync 的 org 分支(见
 * listActiveInstalledArtifacts 内 JOIN orgs status='active')。停用 org 成员仍能浏览/个人
 * 安装本 org 私有技能属良性边界(是本 org 自己的内容),不构成跨 org 泄露。
 */
export async function resolveCallerOrgId(userId: string | number): Promise<CallerOrgId> {
  const m = await getActiveMembership(String(userId))
  return m?.org_id ?? null
}

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
   * 是否将本 pending 版本纳入 AI 自动审批队列(ai_review_state='queued')。默认 **true**:
   * 所有用户面发布路径(web 发布 / oc-market AI 自助发布)自动入列,未来新增发布路径也
   * 默认受审 —— fail toward review。唯一 opt-out 是 platform seed(seedPlatformAgents 直接
   * approvePlatformVersion,不走人审/AI),它显式传 false → ai_review_state 恒 NULL → worker
   * 永不 claim,确保「platform seed 不走 AI」这条红线在数据层结构性成立(非依赖时序竞态)。
   */
  queueAiReview?: boolean
}

/** Create the listing (owner- AND kind-locked) if new, then a pending version. */
export async function publishSkillVersion(input: PublishInput): Promise<{ versionId: string }> {
  const kind: ArtifactKind = input.kind ?? 'skill'
  const rawArtifact = input.rawArtifact ?? input.rawSkillMd
  if (rawArtifact == null)
    throw new MarketplaceError('VERSION_NOT_FOUND', 'missing artifact content')
  return tx(async (c) => {
    await query(
      // org_id 仅在首次创建 listing 时落(ON CONFLICT DO NOTHING → 已存在的 listing 保留
      // 其原 org_id,可见性不因新版本发布而变;与 owner/kind 同为 listing 级不可变属性)。
      `INSERT INTO marketplace_skill_listings (slug, owner_user_id, kind, org_id)
            VALUES ($1, $2, $3, $4::bigint) ON CONFLICT (slug) DO NOTHING`,
      [input.slug, input.ownerUserId, kind, input.orgId ?? null],
      c,
    )
    const listing = await query<{ owner_user_id: string; state: string; kind: string }>(
      'SELECT owner_user_id::text, state, kind FROM marketplace_skill_listings WHERE slug = $1 FOR UPDATE',
      [input.slug],
      c,
    )
    const row = listing.rows[0]
    if (!row) throw new MarketplaceError('VERSION_NOT_FOUND', 'listing vanished')
    if (BigInt(row.owner_user_id) !== BigInt(input.ownerUserId))
      throw new MarketplaceError('SLUG_OWNED_BY_OTHER', `slug "${input.slug}" 已被他人占用`)
    if (row.state === 'revoked')
      throw new MarketplaceError('LISTING_REVOKED', `slug "${input.slug}" 已被下架`)
    // slug is kind-locked: an existing skill slug can't be republished as an agent.
    if (row.kind !== kind)
      throw new MarketplaceError(
        'KIND_MISMATCH',
        `slug "${input.slug}" 已是「${row.kind}」类型，不能作为「${kind}」发布`,
      )

    try {
      // ai_review_state 在 INSERT 内原子写入(而非发布后再 UPDATE),消除「pending 但
      // ai_review_state=NULL」的时序窗口。默认 'queued';platform seed 传 queueAiReview:false
      // → NULL → worker 永不 claim(见 PublishInput.queueAiReview 注释)。
      const aiReviewState = input.queueAiReview === false ? null : 'queued'
      const ins = await query<{ id: string }>(
        `INSERT INTO marketplace_skill_versions
           (slug, version, name, description, tags, raw_skill_md, raw_artifact, manifest,
            artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by,
            raw_bundle, benchmark, ai_review_state)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,'pending',$11::jsonb,$12,$13,
                 $14::jsonb,$15::jsonb,$16)
         RETURNING id::text`,
        [
          input.slug,
          input.version,
          input.name,
          input.description,
          JSON.stringify(input.tags),
          input.rawSkillMd,
          rawArtifact,
          input.manifest == null ? null : JSON.stringify(input.manifest),
          input.artifactHash,
          input.embeddingHash,
          JSON.stringify(input.riskFlags),
          input.policyVersion,
          input.submittedBy,
          input.rawBundle == null ? null : JSON.stringify(input.rawBundle),
          input.benchmark == null ? null : JSON.stringify(input.benchmark),
          aiReviewState,
        ],
        c,
      )
      return { versionId: ins.rows[0].id }
    } catch (e) {
      if (e instanceof Error && /duplicate key|unique/i.test(e.message))
        throw new MarketplaceError('DUPLICATE_VERSION', `版本 ${input.version} 已存在`)
      throw e
    }
  })
}

export interface PendingVersionRow {
  versionId: string
  slug: string
  kind: ArtifactKind
  version: string
  name: string
  description: string
  tags: string[]
  /** Generic raw artifact (skill: the SKILL.md; agent: the manifest). */
  rawArtifact: string
  /** Skill-only SKILL.md (null for agents). */
  rawSkillMd: string | null
  /** Structured per-kind metadata (agent: model/toolsets/skillDeps). */
  manifest: unknown
  riskFlags: RiskFlag[]
  submittedBy: string
  ownerUserId: string
  createdAt: string
  rawBundle: Record<string, string> | null
  benchmark: { withPassRate: number; withoutPassRate: number; cases: number } | null
  /** AI 审核意见(escalate/warn 降级/解析失败/skip 时的原因),供人审「供参考」展示;null=AI 未表态。 */
  aiNote: string | null
}

// Admin-only: the full artifact (raw_artifact) is included so the reviewer can
// read exactly the bytes that will install — review is the human governance step
// over the static scan, and it can't be done without the full content. kind +
// manifest let the reviewer judge an agent (capabilities/skillDeps), not just a skill.
export async function listPendingVersions(limit = 100): Promise<PendingVersionRow[]> {
  const r = await query<{
    id: string
    slug: string
    kind: string
    version: string
    name: string
    description: string
    tags: RiskFlag[] | unknown
    raw_artifact: string
    raw_skill_md: string | null
    manifest: unknown
    risk_flags: RiskFlag[] | unknown
    submitted_by: string
    owner_user_id: string
    created_at: string
    raw_bundle: unknown
    benchmark: unknown
    ai_note: string | null
  }>(
    `SELECT v.id::text, v.slug, l.kind, v.version, v.name, v.description, v.tags,
            v.raw_artifact, v.raw_skill_md, v.manifest, v.raw_bundle, v.benchmark,
            v.risk_flags, v.submitted_by::text, l.owner_user_id::text, v.created_at::text,
            v.ai_note
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.status = 'pending'
      ORDER BY v.created_at ASC
      LIMIT $1`,
    [Math.min(limit, 500)],
  )
  return r.rows.map((x) => ({
    versionId: x.id,
    slug: x.slug,
    kind: x.kind as ArtifactKind,
    version: x.version,
    name: x.name,
    description: x.description,
    tags: (x.tags as string[]) ?? [],
    rawArtifact: x.raw_artifact,
    rawSkillMd: x.raw_skill_md,
    manifest: x.manifest ?? null,
    riskFlags: (x.risk_flags as RiskFlag[]) ?? [],
    submittedBy: x.submitted_by,
    ownerUserId: x.owner_user_id,
    createdAt: x.created_at,
    rawBundle: (x.raw_bundle as Record<string, string> | null) ?? null,
    benchmark:
      (x.benchmark as { withPassRate: number; withoutPassRate: number; cases: number } | null) ??
      null,
    aiNote: x.ai_note ?? null,
  }))
}

/**
 * Approve/reject a pending version. Reviewer must differ from submitter unless an admin-only
 * caller opts in.
 *
 * `source` 记录最终决策来源(review_source 列):
 *   - 'human'(默认):admin 人审。reviewerUserId 为 admin uid,写 reviewed_by。
 *   - 'ai':AI 自动审批(marketplace/aiReview.ts)。reviewerUserId 传 null → reviewed_by=NULL
 *     (schema 允许;AI 非任何用户,不占平台账号),并同事务把 ai_review_state 落 'done' +
 *     ai_note + ai_reviewed_at —— worker claim 时已置 'running',这里在同一 status='pending'
 *     守卫下原子翻到终态,无需二次写。AI 从不是发布者本人,故 reviewerUserId=null 时跳过
 *     REVIEWER_IS_AUTHOR 检查(否则 BigInt(null) 会抛)。
 */
export async function reviewVersion(args: {
  versionId: string
  reviewerUserId: number | null
  approve: boolean
  note?: string
  allowSelfReview?: boolean
  source?: 'human' | 'ai'
  /** source='ai' 时落 ai_note(AI 审批意见);human 路径忽略(不覆盖既有 ai_note)。 */
  aiNote?: string | null
}): Promise<void> {
  const source = args.source ?? 'human'
  await tx(async (c) => {
    const v = await query<{ slug: string; status: string; submitted_by: string }>(
      'SELECT slug, status, submitted_by::text FROM marketplace_skill_versions WHERE id = $1 FOR UPDATE',
      [args.versionId],
      c,
    )
    const row = v.rows[0]
    if (!row) throw new MarketplaceError('VERSION_NOT_FOUND', 'version 不存在')
    if (row.status !== 'pending') throw new MarketplaceError('NOT_PENDING', '该版本已被审核')
    if (
      args.reviewerUserId != null &&
      !args.allowSelfReview &&
      BigInt(row.submitted_by) === BigInt(args.reviewerUserId)
    )
      throw new MarketplaceError('REVIEWER_IS_AUTHOR', '审核人不能是发布者本人')

    const isAi = source === 'ai'
    await query(
      `UPDATE marketplace_skill_versions
          SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_note = $4,
              review_source = $5,
              ai_review_state = CASE WHEN $6::boolean THEN 'done' ELSE ai_review_state END,
              ai_note = CASE WHEN $6::boolean THEN $7 ELSE ai_note END,
              ai_reviewed_at = CASE WHEN $6::boolean THEN NOW() ELSE ai_reviewed_at END
        WHERE id = $1`,
      [
        args.versionId,
        args.approve ? 'approved' : 'rejected',
        args.reviewerUserId,
        args.note ?? null,
        source,
        isAi,
        isAi ? (args.aiNote ?? null) : null,
      ],
      c,
    )
    if (args.approve) {
      const listing = await query(
        `UPDATE marketplace_skill_listings
            SET current_approved_version_id = $2,
                state = CASE WHEN state = 'unlisted' THEN 'active' ELSE state END,
                revoked_reason = CASE WHEN state = 'unlisted' THEN NULL ELSE revoked_reason END,
                updated_at = NOW()
          WHERE slug = $1 AND state <> 'revoked'`,
        [row.slug, args.versionId],
        c,
      )
      if ((listing.rowCount ?? 0) === 0)
        throw new MarketplaceError('LISTING_REVOKED', `slug "${row.slug}" 已被平台下架`)
    }
  })
}

export interface ReviewVersionBatchResult {
  versionId: string
  ok: boolean
  code?: MarketplaceError['code']
  message?: string
}

/** Batch review helper. Keeps single-version semantics by reusing reviewVersion. */
export async function reviewVersions(args: {
  versionIds: string[]
  reviewerUserId: number
  approve: boolean
  note?: string
  allowSelfReview?: boolean
}): Promise<ReviewVersionBatchResult[]> {
  const results: ReviewVersionBatchResult[] = []
  for (const versionId of args.versionIds) {
    try {
      await reviewVersion({
        versionId,
        reviewerUserId: args.reviewerUserId,
        approve: args.approve,
        note: args.note,
        allowSelfReview: args.allowSelfReview,
      })
      results.push({ versionId, ok: true })
    } catch (e) {
      if (!(e instanceof MarketplaceError)) throw e
      results.push({ versionId, ok: false, code: e.code, message: e.message })
    }
  }
  return results
}

/**
 * Platform-official seed approval. Marks (slug, version) approved + points the
 * listing's current_approved_version_id at it. UNLIKE {@link reviewVersion} this
 * does NOT enforce reviewer≠author: it is for PLATFORM-AUTHORED official content
 * seeded from version control (the built-in research agents), which is trusted at
 * source and has no user submission to peer-review. Idempotent — re-approving an
 * already-approved version just re-points current_approved_version_id (no-op-ish).
 * Throws VERSION_NOT_FOUND if the (slug, version) is absent. Marketplace SQL stays
 * the single authority here (callers never hand-write listing/version SQL).
 */
export async function approvePlatformVersion(
  slug: string,
  version: string,
  expectedArtifactHash: string,
): Promise<void> {
  await tx(async (c) => {
    const v = await query<{ id: string; artifact_hash: string; kind: string }>(
      `SELECT v.id::text, v.artifact_hash, l.kind
         FROM marketplace_skill_versions v
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.slug = $1 AND v.version = $2
        FOR UPDATE OF v`,
      [slug, version],
      c,
    )
    const row = v.rows[0]
    if (!row) throw new MarketplaceError('VERSION_NOT_FOUND', `version ${slug}@${version} 不存在`)
    // 只批准 agent 类(平台 seed 只产 agent)+ 内容必须与代码定义一致。否则可能把一个
    // 早已存在的同名同版本(他人/历史/被拒)版本误批成「官方」——绝不批准外来内容。
    if (row.kind !== 'agent')
      throw new MarketplaceError(
        'KIND_MISMATCH',
        `platform seed 期望 agent 类,实际 ${row.kind}(${slug}@${version})`,
      )
    if (row.artifact_hash !== expectedArtifactHash)
      throw new MarketplaceError(
        'ARTIFACT_MISMATCH',
        `platform seed artifact 不匹配,拒绝批准外来内容(${slug}@${version})`,
      )
    await query(
      `UPDATE marketplace_skill_versions
          SET status = 'approved', reviewed_by = submitted_by, reviewed_at = NOW(),
              review_note = 'platform-official seed', review_source = 'platform'
        WHERE id = $1`,
      [row.id],
      c,
    )
    await query(
      `UPDATE marketplace_skill_listings
          SET current_approved_version_id = $2, updated_at = NOW()
        WHERE slug = $1`,
      [slug, row.id],
      c,
    )
  })
}

// ── AI 自动审批数据层(worker=marketplace/aiReview.ts;SQL 单一权威留在本文件)──────
//
// 单一权威:worker 直接扫版本表(不建第二张 job 表)。状态机与列语义见 0107 迁移头注。
// claim 用 FOR UPDATE SKIP LOCKED(仿 research/store.ts claimNextJob),即便多实例并跑
// 也不会认领同一行;escalate/skip 只翻 ai_review_state(绝不碰 status),status 由
// reviewVersion(approve/reject)或人审改写 —— 职责单一,写回互不越界。

/** worker claim 到的待审版本(PendingVersionRow 的全部字段 + 已 claim 次数)。 */
export interface AiReviewCandidate extends PendingVersionRow {
  /** 本次 claim 后的累计尝试次数(僵尸回收判据)。 */
  aiAttempts: number
}

function mapAiCandidateRow(x: {
  id: string
  slug: string
  kind: string
  version: string
  name: string
  description: string
  tags: unknown
  raw_artifact: string
  raw_skill_md: string | null
  manifest: unknown
  risk_flags: unknown
  submitted_by: string
  owner_user_id: string
  created_at: string
  raw_bundle: unknown
  benchmark: unknown
  ai_note: string | null
  ai_attempts: number | string
}): AiReviewCandidate {
  return {
    versionId: x.id,
    slug: x.slug,
    kind: x.kind as ArtifactKind,
    version: x.version,
    name: x.name,
    description: x.description,
    tags: (x.tags as string[]) ?? [],
    rawArtifact: x.raw_artifact,
    rawSkillMd: x.raw_skill_md,
    manifest: x.manifest ?? null,
    riskFlags: (x.risk_flags as RiskFlag[]) ?? [],
    submittedBy: x.submitted_by,
    ownerUserId: x.owner_user_id,
    createdAt: x.created_at,
    rawBundle: (x.raw_bundle as Record<string, string> | null) ?? null,
    benchmark:
      (x.benchmark as { withPassRate: number; withoutPassRate: number; cases: number } | null) ??
      null,
    aiNote: x.ai_note ?? null,
    aiAttempts: typeof x.ai_attempts === 'string' ? Number.parseInt(x.ai_attempts, 10) : x.ai_attempts,
  }
}

/**
 * Claim 下一个 pending+queued 版本给本 worker 处理:置 running / ai_locked_at=NOW() /
 * ai_attempts+1,返回全量内容(供 LLM 审)。无候选返回 null。FOR UPDATE SKIP LOCKED
 * 保证并发 worker 不抢同一行。
 */
export async function claimNextAiReview(): Promise<AiReviewCandidate | null> {
  return tx(async (c) => {
    const sel = await query<{ id: string }>(
      `SELECT id::text AS id
         FROM marketplace_skill_versions
        WHERE status = 'pending' AND ai_review_state = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [],
      c,
    )
    const id = sel.rows[0]?.id
    if (!id) return null
    await query(
      `UPDATE marketplace_skill_versions
          SET ai_review_state = 'running', ai_locked_at = NOW(), ai_attempts = ai_attempts + 1
        WHERE id = $1`,
      [id],
      c,
    )
    const full = await query<Parameters<typeof mapAiCandidateRow>[0]>(
      `SELECT v.id::text, v.slug, l.kind, v.version, v.name, v.description, v.tags,
              v.raw_artifact, v.raw_skill_md, v.manifest, v.raw_bundle, v.benchmark,
              v.risk_flags, v.submitted_by::text, l.owner_user_id::text, v.created_at::text,
              v.ai_note, v.ai_attempts
         FROM marketplace_skill_versions v
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.id = $1`,
      [id],
      c,
    )
    const row = full.rows[0]
    return row ? mapAiCandidateRow(row) : null
  })
}

/**
 * 僵尸回收:running 且 ai_locked_at 超过 staleMs 的行(worker 崩在半路)。attempts≥maxAttempts
 * → 'skipped'(转人工,不再重试);否则回 'queued' 重新排队。返回两类计数。
 */
export async function recoverStaleAiReviews(
  staleMs: number,
  maxAttempts: number,
): Promise<{ requeued: number; skipped: number }> {
  const r = await query<{ ai_review_state: string }>(
    `UPDATE marketplace_skill_versions
        SET ai_review_state = CASE WHEN ai_attempts >= $2 THEN 'skipped' ELSE 'queued' END,
            ai_note = CASE WHEN ai_attempts >= $2
                           THEN 'AI 审核多次未完成(疑似中断),已转人工复核' ELSE ai_note END,
            ai_reviewed_at = CASE WHEN ai_attempts >= $2 THEN NOW() ELSE ai_reviewed_at END,
            ai_locked_at = NULL
      WHERE status = 'pending'
        AND ai_review_state = 'running'
        AND ai_locked_at < NOW() - ($1 * INTERVAL '1 millisecond')
    RETURNING ai_review_state`,
    [staleMs, maxAttempts],
  )
  let requeued = 0
  let skipped = 0
  for (const row of r.rows) {
    if (row.ai_review_state === 'skipped') skipped++
    else requeued++
  }
  return { requeued, skipped }
}

/**
 * ESCALATE:LLM 给出 escalate / warn 降级 / 输出解析失败 —— 保持 pending 进人审队列,
 * 只把 ai_review_state 落 'done' + 记录 AI 意见。**绝不改 status**。仅当行仍 'running'
 * (本 worker 持有)时生效,避免覆盖并发人审已翻的终态。
 */
export async function finishAiReviewEscalate(versionId: string, note: string): Promise<void> {
  await query(
    `UPDATE marketplace_skill_versions
        SET ai_review_state = 'done', ai_note = $2, ai_reviewed_at = NOW(), ai_locked_at = NULL
      WHERE id = $1 AND ai_review_state = 'running'`,
    [versionId, note],
  )
}

/**
 * SKIP:worker 无法给出可用决策(缺 key / 网络失败重试耗尽 / 写回时版本已被人审抢先)。
 * 保持 pending,ai_review_state 落 'skipped' + 原因。同样只在 'running' 时生效。
 */
export async function markAiReviewSkipped(versionId: string, note: string): Promise<void> {
  await query(
    `UPDATE marketplace_skill_versions
        SET ai_review_state = 'skipped', ai_note = $2, ai_reviewed_at = NOW(), ai_locked_at = NULL
      WHERE id = $1 AND ai_review_state = 'running'`,
    [versionId, note],
  )
}

/**
 * 缺 key 时的兜底:把所有 queued 且未 claim 的版本批量置 'skipped'(转人工),避免
 * 无人处理的 queued backlog 无声堆积。返回处理行数(worker 仅在 >0 时记日志)。
 */
export async function skipQueuedAiReviews(note: string): Promise<number> {
  const r = await query(
    `UPDATE marketplace_skill_versions
        SET ai_review_state = 'skipped', ai_note = $1, ai_reviewed_at = NOW()
      WHERE status = 'pending' AND ai_review_state = 'queued'`,
    [note],
  )
  return r.rowCount ?? 0
}

/** admin「AI 审批记录」:AI 最终决策过(approved/rejected)的版本,按 reviewed_at DESC。 */
export interface AiReviewRecord {
  versionId: string
  slug: string
  kind: ArtifactKind
  version: string
  name: string
  /** AI 的最终裁决落到 status:'approved' | 'rejected'。 */
  status: string
  aiNote: string | null
  reviewedAt: string | null
}

export async function listRecentAiReviews(limit = 50): Promise<AiReviewRecord[]> {
  const r = await query<{
    id: string
    slug: string
    kind: string
    version: string
    name: string
    status: string
    ai_note: string | null
    reviewed_at: string | null
  }>(
    `SELECT v.id::text, v.slug, l.kind, v.version, v.name, v.status, v.ai_note,
            v.reviewed_at::text
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.review_source = 'ai'
      ORDER BY v.reviewed_at DESC NULLS LAST
      LIMIT $1`,
    [Math.min(Math.max(1, limit), 200)],
  )
  return r.rows.map((x) => ({
    versionId: x.id,
    slug: x.slug,
    kind: x.kind as ArtifactKind,
    version: x.version,
    name: x.name,
    status: x.status,
    aiNote: x.ai_note ?? null,
    reviewedAt: x.reviewed_at ?? null,
  }))
}

export interface ApprovedSearchRow {
  versionId: string
  slug: string
  kind: ArtifactKind
  name: string
  description: string
  tags: string[]
  embeddingHash: string
  /** 当前活跃安装数(卸载不计;每用户同 slug 至多一条活跃安装,即≈使用人数)。 */
  installCount: number
  /** 发布者自报评测摘要(聚合值;展示须标注"发布者提供,未经平台验证")。null=未提供。 */
  benchmark: { withPassRate: number; withoutPassRate: number; cases: number } | null
}

/** Current approved version of every active listing — the searchable catalog.
 *  `kind` lets a caller scope the catalog to skills or agents. */
// 搜索候选集硬上限:search 是"全量拉回内存 → 关键词过滤/embedding 相似度"的实现,
// 无上限时目录增长线性劣化(每次搜索全表 + 全量 embedding cache lookup)。
// 500 覆盖上市初期数个量级;命中上限时告警日志 —— 那是"该把检索下沉到 SQL/pgvector"
// 的偿还触发条件,不是调大数字。
const SEARCH_CATALOG_CAP = 500

export async function listApprovedForSearch(
  kind?: ArtifactKind,
  callerOrgId: CallerOrgId = null,
): Promise<ApprovedSearchRow[]> {
  const r = await query<{
    id: string
    slug: string
    kind: string
    name: string
    description: string
    tags: unknown
    embedding_hash: string
    benchmark: unknown
    install_count: string | null
  }>(
    // install_count 走一次性聚合 JOIN(而非逐行 correlated 子查询):目录上限 500 行,
    // 逐行子查询会对共享的 v3 search 端点放大 500 次 installs 扫描。
    // org 可见性收口:org-private listing 仅本 org 成员可搜出(callerOrgId=null → 仅公开)。
    `SELECT v.id::text, v.slug, l.kind, v.name, v.description, v.tags, v.embedding_hash,
            v.benchmark, ic.n::text AS install_count
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
       LEFT JOIN (SELECT slug, count(*) AS n FROM marketplace_installs
                   WHERE uninstalled_at IS NULL GROUP BY slug) ic ON ic.slug = l.slug
      WHERE l.state = 'active' AND v.status = 'approved'
            AND ($1::text IS NULL OR l.kind = $1)
            AND ${orgVisibleFrag('l', 2)}
      ORDER BY v.id DESC
      LIMIT ${SEARCH_CATALOG_CAP + 1}`,
    [kind ?? null, callerOrgId],
  )
  if (r.rows.length > SEARCH_CATALOG_CAP) {
    // eslint-disable-next-line no-console
    console.warn(
      `[marketplace] search catalog exceeded cap (${SEARCH_CATALOG_CAP}); older listings invisible to search — move retrieval into SQL/pgvector`,
    )
    r.rows.length = SEARCH_CATALOG_CAP
  }
  return r.rows.map((x) => ({
    versionId: x.id,
    slug: x.slug,
    kind: x.kind as ArtifactKind,
    name: x.name,
    description: x.description,
    tags: (x.tags as string[]) ?? [],
    embeddingHash: x.embedding_hash,
    installCount: Number.parseInt(x.install_count ?? '0', 10) || 0,
    benchmark:
      (x.benchmark as { withPassRate: number; withoutPassRate: number; cases: number } | null) ??
      null,
  }))
}

export interface ListingDetail {
  slug: string
  kind: ArtifactKind
  state: string
  ownerUserId: string
  version: string
  versionId: string
  name: string
  description: string
  tags: string[]
  artifactHash: string
  /** Generic raw artifact (skill: the SKILL.md; agent: the manifest). */
  rawArtifact: string
  /** Skill-only: the SKILL.md (null for agents). Kept for the skill read path. */
  rawSkillMd: string | null
  /** Structured per-kind metadata (agent: model/toolsets/skillDeps); null for skills. */
  manifest: unknown
  riskFlags: RiskFlag[]
  installCount: number
  /** 附属文件(references/assets/evals;null = 无)。 */
  rawBundle: Record<string, string> | null
  /** 发布者自报评测摘要(展示须标注"发布者提供")。 */
  benchmark: { withPassRate: number; withoutPassRate: number; cases: number } | null
}

/**
 * Public detail for an active listing's current approved version (incl. the full artifact for the confirm dialog).
 *
 * org 可见性收口:org-private listing 对非本 org caller **返回 null**(路由层据此 404,
 * 不是 403——对齐既有 hidden/pending listing 的处理语义,不泄露存在性 oracle)。
 * callerOrgId=null → 仅公开 listing。
 */
export async function getListingDetail(
  slug: string,
  callerOrgId: CallerOrgId = null,
): Promise<ListingDetail | null> {
  const r = await query<{
    slug: string
    kind: string
    state: string
    owner_user_id: string
    version: string
    vid: string
    name: string
    description: string
    tags: unknown
    artifact_hash: string
    raw_artifact: string
    raw_skill_md: string | null
    manifest: unknown
    risk_flags: unknown
    raw_bundle: unknown
    benchmark: unknown
    install_count: string
  }>(
    `SELECT l.slug, l.kind, l.state, l.owner_user_id::text, v.version, v.id::text AS vid,
            v.name, v.description, v.tags, v.artifact_hash, v.raw_artifact, v.raw_skill_md,
            v.manifest, v.risk_flags, v.raw_bundle, v.benchmark,
            (SELECT count(*) FROM marketplace_installs i
              WHERE i.slug = l.slug AND i.uninstalled_at IS NULL)::text AS install_count
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.slug = $1 AND l.state = 'active' AND v.status = 'approved'
            AND ${orgVisibleFrag('l', 2)}`,
    [slug, callerOrgId],
  )
  const x = r.rows[0]
  if (!x) return null
  return {
    slug: x.slug,
    kind: x.kind as ArtifactKind,
    state: x.state,
    ownerUserId: x.owner_user_id,
    version: x.version,
    versionId: x.vid,
    name: x.name,
    description: x.description,
    tags: (x.tags as string[]) ?? [],
    artifactHash: x.artifact_hash,
    rawArtifact: x.raw_artifact,
    rawSkillMd: x.raw_skill_md,
    manifest: x.manifest ?? null,
    riskFlags: (x.risk_flags as RiskFlag[]) ?? [],
    installCount: Number.parseInt(x.install_count, 10) || 0,
    rawBundle: (x.raw_bundle as Record<string, string> | null) ?? null,
    benchmark:
      (x.benchmark as { withPassRate: number; withoutPassRate: number; cases: number } | null) ??
      null,
  }
}

/**
 * Install an approved version, pinning (version_id, artifact_hash).
 *
 * Validity (version approved + listing active + version is the listing's CURRENT
 * approved one) is re-checked inside the same transaction that inserts the
 * install, with `FOR UPDATE OF l` on the listing row. This closes the TOCTOU
 * window: a concurrent revoke/new-approve either blocks until we commit, or — if
 * it committed first — the locked re-read no longer matches the WHERE and we
 * raise NOT_INSTALLABLE instead of recording an install for a revoked/superseded
 * version. Re-install supersedes the prior active row (soft-delete, audit kept).
 */
export async function installApprovedVersion(args: {
  userId: number
  versionId: string
  agentIds?: string[]
  scopeMode?: InstallScopeMode
  /** org 可见性收口:org-private 版本仅本 org 成员可装(null=仅公开)。不可见 → NOT_INSTALLABLE(404)。 */
  callerOrgId?: CallerOrgId
}): Promise<{ slug: string; version: string; name: string }> {
  const callerOrgId = args.callerOrgId ?? null
  return tx(async (c) => {
    const v = await query<{
      slug: string
      version: string
      name: string
      artifact_hash: string
      kind: string
    }>(
      // Kind-agnostic delivery (skill→hub/skills, agent→agents.yaml), but the
      // install row carries the listing kind so we can channel-gate agents below.
      // org 可见性谓词与 approved/active/current 的 TOCTOU 再校验同事务、同 FOR UPDATE OF l:
      // 越权(org-private 且非本 org)→ 行不匹配 → NOT_INSTALLABLE(404,不泄露存在性)。
      `SELECT v.slug, v.version, v.name, v.artifact_hash, l.kind
         FROM marketplace_skill_versions v
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.id = $1 AND v.status = 'approved' AND l.state = 'active'
              AND l.current_approved_version_id = v.id
              AND ${orgVisibleFrag('l', 2)}
        FOR UPDATE OF l`,
      [args.versionId, callerOrgId],
      c,
    )
    const row = v.rows[0]
    if (!row)
      throw new MarketplaceError('NOT_INSTALLABLE', 'skill 不可安装(未上架/已下架/非当前版本)')
    // agent 类仅 v5 可装(单一总闸:覆盖浏览器 install + 容器内 internal install +
    // agent 的 skillDep 联动)。skillDep 都是 kind='skill',不受影响。
    if (row.kind === 'agent' && !marketplaceAgentsEnabled())
      throw new MarketplaceError('NOT_INSTALLABLE', 'agent 类市场仅在 v5 可用')

    await lockInstallScope(c, args.userId, row.slug)
    const existing = await query<{ id: string; agent_ids: unknown }>(
      `SELECT id::text, agent_ids
         FROM marketplace_installs
        WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL
        FOR UPDATE`,
      [args.userId, row.slug],
      c,
    )
    const previous = existing.rows[0]
    const previousScope = previous
      ? normalizeInstallAgentIds(previous.agent_ids, DEFAULT_INSTALL_AGENT_IDS)
      : null
    const providedScope =
      args.agentIds !== undefined ? normalizeInstallAgentIds(args.agentIds, []) : null
    const scopeMode: InstallScopeMode =
      args.scopeMode ?? (args.agentIds !== undefined ? 'replace' : 'preserve')
    let finalScope: string[]
    if (row.kind === 'agent') {
      finalScope = DEFAULT_INSTALL_AGENT_IDS
    } else if (scopeMode === 'replace') {
      finalScope = providedScope && providedScope.length > 0 ? providedScope : DEFAULT_INSTALL_AGENT_IDS
    } else if (scopeMode === 'merge') {
      finalScope = mergeAgentIds(previousScope ?? [], providedScope ?? [])
    } else {
      finalScope = previousScope ?? (providedScope && providedScope.length > 0 ? providedScope : DEFAULT_INSTALL_AGENT_IDS)
    }

    if (previous) {
      await query(
        `UPDATE marketplace_installs SET uninstalled_at = NOW()
          WHERE id = $1`,
        [previous.id],
        c,
      )
    }
    try {
      await query(
        `INSERT INTO marketplace_installs (user_id, slug, version_id, artifact_hash, installed_by, agent_ids)
              VALUES ($1,$2,$3,$4,$1,$5::jsonb)`,
        [args.userId, row.slug, args.versionId, row.artifact_hash, JSON.stringify(finalScope)],
        c,
      )
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new MarketplaceError('INSTALL_CONFLICT', '安装状态冲突,请重试')
      }
      throw err
    }
    return { slug: row.slug, version: row.version, name: row.name }
  })
}

export async function getInstallableVersionTarget(
  versionId: string,
  callerOrgId: CallerOrgId = null,
): Promise<{
  slug: string
  kind: ArtifactKind
  version: string
} | null> {
  const r = await query<{ slug: string; kind: string; version: string }>(
    // org 可见性收口:org-private 版本对非本 org caller 视同不存在(→ 路由 NOT_INSTALLABLE 404)。
    `SELECT v.slug, l.kind, v.version
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.id = $1 AND v.status = 'approved' AND l.state = 'active'
            AND l.current_approved_version_id = v.id
            AND ${orgVisibleFrag('l', 2)}`,
    [versionId, callerOrgId],
  )
  const row = r.rows[0]
  if (!row) return null
  if (row.kind === 'agent' && !marketplaceAgentsEnabled())
    throw new MarketplaceError('NOT_INSTALLABLE', 'agent 类市场仅在 v5 可用')
  return { slug: row.slug, kind: row.kind as ArtifactKind, version: row.version }
}

export async function updateInstalledAgentScope(
  userId: number,
  slug: string,
  agentIds: string[],
): Promise<boolean> {
  const finalScope = normalizeInstallAgentIds(agentIds, DEFAULT_INSTALL_AGENT_IDS)
  return tx(async (c) => {
    await lockInstallScope(c, userId, slug)
    const existing = await query<{ id: string }>(
      `SELECT i.id::text
         FROM marketplace_installs i
         JOIN marketplace_skill_listings l ON l.slug = i.slug
        WHERE i.user_id = $1 AND i.slug = $2 AND i.uninstalled_at IS NULL
              AND l.kind = 'skill'
        FOR UPDATE OF i`,
      [userId, slug],
      c,
    )
    const row = existing.rows[0]
    if (!row) return false
    await query(
      `UPDATE marketplace_installs SET agent_ids = $2::jsonb WHERE id = $1`,
      [row.id, JSON.stringify(finalScope)],
      c,
    )
    return true
  })
}

export async function recordUninstall(userId: number, slug: string): Promise<boolean> {
  const r = await query(
    `UPDATE marketplace_installs SET uninstalled_at = NOW()
      WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL`,
    [userId, slug],
  )
  return (r.rowCount ?? 0) > 0
}

export interface InstalledRow {
  slug: string
  kind: ArtifactKind
  version: string
  versionId: string
  name: string
  artifactHash: string
  agentIds: string[]
  installedAt: string
  listingState: string
  /** listing 当前上架版本(升级可见性;listing 无 approved 版本时为 null)。 */
  latestVersion: string | null
  latestVersionId: string | null
}

export async function listInstalled(userId: number): Promise<InstalledRow[]> {
  const r = await query<{
    slug: string
    kind: string
    version: string
    version_id: string
    name: string
    artifact_hash: string
    agent_ids: unknown
    installed_at: string
    state: string
    latest_version: string | null
    latest_version_id: string | null
  }>(
    // cv = listing 当前上架版本(升级可见性:安装 pin 旧 versionId,新版获批后
    // latest_version_id ≠ version_id 即「可更新」)。LEFT JOIN:revoked/无 approved 时为 null。
    `SELECT i.slug, l.kind, v.version, i.version_id::text, v.name, i.artifact_hash,
            i.agent_ids,
            i.installed_at::text, l.state,
            cv.version AS latest_version, cv.id::text AS latest_version_id
       FROM marketplace_installs i
       JOIN marketplace_skill_versions v ON v.id = i.version_id
       JOIN marketplace_skill_listings l ON l.slug = i.slug
       LEFT JOIN marketplace_skill_versions cv ON cv.id = l.current_approved_version_id
      WHERE i.user_id = $1 AND i.uninstalled_at IS NULL
      ORDER BY i.installed_at DESC`,
    [userId],
  )
  // agent 类仅 v5:v3 渠道滤掉已装 agent(共享 installs 跨渠道,见 listActiveInstalledAgents)。
  const agentsOk = marketplaceAgentsEnabled()
  return r.rows
    .filter((x) => agentsOk || x.kind !== 'agent')
    .map((x) => ({
      slug: x.slug,
      kind: x.kind as ArtifactKind,
      version: x.version,
      versionId: x.version_id,
      name: x.name,
      artifactHash: x.artifact_hash,
      agentIds: normalizeInstallAgentIds(x.agent_ids, DEFAULT_INSTALL_AGENT_IDS),
      installedAt: x.installed_at,
      listingState: x.state,
      latestVersion: x.latest_version,
      latestVersionId: x.latest_version_id,
    }))
}

export interface MyPublishRow {
  versionId: string
  slug: string
  kind: ArtifactKind
  version: string
  name: string
  /** pending | approved | rejected */
  status: string
  /** 审核备注(拒绝理由等;管理员输入,前端须按纯文本渲染)。 */
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
  /** 该版本是否 listing 当前上架版本。 */
  isCurrent: boolean
  /** listing 状态(active/revoked) —— 已通过但被下架时给发布者可见。 */
  listingState: string
}

/** 我的发布记录上限:只展示最近 N 条(超出的老提交对状态闭环无增量价值)。 */
const MY_PUBLISHES_LIMIT = 50

/**
 * 发布者视角的自有提交列表(发布闭环:提交→pending→approved/rejected+理由 全程可见)。
 * 身份口径与发布写入一致(submitted_by = uid)。不含正文 —— 状态可见性接口,
 * 防 50 × SKILL.md 的 payload 膨胀;重发编辑时正文从「我的技能」再导入。
 */
export async function listMyPublishes(userId: number): Promise<MyPublishRow[]> {
  const r = await query<{
    id: string
    slug: string
    kind: string
    version: string
    name: string
    status: string
    review_note: string | null
    created_at: string
    reviewed_at: string | null
    is_current: boolean | null
    state: string
  }>(
    `SELECT v.id::text, v.slug, l.kind, v.version, v.name, v.status,
            v.review_note, v.created_at::text, v.reviewed_at::text,
            (l.current_approved_version_id = v.id) AS is_current, l.state
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.submitted_by = $1
      ORDER BY v.id DESC
      LIMIT ${MY_PUBLISHES_LIMIT}`,
    [userId],
  )
  return r.rows.map((x) => ({
    versionId: x.id,
    slug: x.slug,
    kind: x.kind as ArtifactKind,
    version: x.version,
    name: x.name,
    status: x.status,
    reviewNote: x.review_note,
    createdAt: x.created_at,
    reviewedAt: x.reviewed_at,
    isCurrent: x.is_current === true,
    listingState: x.state,
  }))
}

/**
 * Publisher self-unlist: remove an active approved listing from search/install/sync without
 * using the admin kill-switch state. Owners may later publish a new version; approval relists
 * `unlisted` listings, while `revoked` remains terminal.
 */
export async function ownerUnlistListing(
  slug: string,
  ownerUserId: number,
  reason = 'unlisted by owner',
): Promise<number[]> {
  return tx(async (c) => {
    const listing = await query<{
      owner_user_id: string
      state: string
      current_approved_version_id: string | null
    }>(
      `SELECT owner_user_id::text, state, current_approved_version_id::text
         FROM marketplace_skill_listings
        WHERE slug = $1
        FOR UPDATE`,
      [slug],
      c,
    )
    const row = listing.rows[0]
    if (!row) throw new MarketplaceError('VERSION_NOT_FOUND', `slug "${slug}" 不存在`)
    if (BigInt(row.owner_user_id) !== BigInt(ownerUserId))
      throw new MarketplaceError('SLUG_OWNED_BY_OTHER', `slug "${slug}" 不属于当前用户`)
    if (row.state === 'revoked')
      throw new MarketplaceError('LISTING_REVOKED', `slug "${slug}" 已被平台下架`)
    if (row.state !== 'active' || row.current_approved_version_id == null)
      throw new MarketplaceError('NOT_INSTALLABLE', `slug "${slug}" 当前未上架`)

    await query(
      `UPDATE marketplace_skill_listings
          SET state = 'unlisted', revoked_reason = $2, updated_at = NOW()
        WHERE slug = $1`,
      [slug, reason],
      c,
    )
    const affected = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id::text FROM marketplace_installs
        WHERE slug = $1 AND uninstalled_at IS NULL`,
      [slug],
      c,
    )
    return affected.rows.map((x) => Number.parseInt(x.user_id, 10))
  })
}

/** Publisher self-withdraw: pending versions can be cancelled before admin review. */
export async function withdrawPublishVersion(versionId: string, ownerUserId: number): Promise<void> {
  await tx(async (c) => {
    const v = await query<{
      status: string
      submitted_by: string
      owner_user_id: string
      slug: string
    }>(
      `SELECT v.status, v.submitted_by::text, l.owner_user_id::text, v.slug
         FROM marketplace_skill_versions v
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.id = $1
        FOR UPDATE OF v, l`,
      [versionId],
      c,
    )
    const row = v.rows[0]
    if (!row) throw new MarketplaceError('VERSION_NOT_FOUND', 'version 不存在')
    if (
      BigInt(row.submitted_by) !== BigInt(ownerUserId) ||
      BigInt(row.owner_user_id) !== BigInt(ownerUserId)
    ) {
      throw new MarketplaceError('SLUG_OWNED_BY_OTHER', `slug "${row.slug}" 不属于当前用户`)
    }
    if (row.status !== 'pending') throw new MarketplaceError('NOT_PENDING', '该版本已被审核')

    await query(
      `UPDATE marketplace_skill_versions
          SET status = 'rejected', reviewed_at = NOW(), review_note = '作者撤销发布'
        WHERE id = $1`,
      [versionId],
      c,
    )
  })
}

export interface InstalledArtifact {
  slug: string
  version: string
  rawSkillMd: string
  artifactHash: string
  agentIds: string[]
  /** 附属文件(容器侧独立验 bundleHash 后落盘 hub)。 */
  bundle: Record<string, string> | null
}

/**
 * Active SKILL installs of a user, with the full SKILL.md, for container-side hub
 * reconciliation. Excludes revoked listings — that is the kill-switch: a revoked
 * skill drops out of this list and the next container sync removes it.
 *
 * Hard-scoped to kind='skill' with a non-null raw_skill_md so an approved agent
 * (whose raw_skill_md is NULL) can never leak into the skill hub feed. Agent
 * delivery is a separate M3 reconcile against agents.yaml.
 *
 * 企业版 P3.1(方案 §5):个人 install ∪ caller **active org(且 org active)** 的
 * org_installs。同 slug 冲突时**个人优先**(priority 0 < 1:用户自留地不被组织覆盖)。
 * org 分支 JOIN orgs status='active' —— 成员离开(getActiveMembership 返 null → 无 org 行)
 * 或 org 停用(JOIN 滤掉)→ 该分支自然为空 → 容器 sync 差集比对删除,无需主动清理。
 * 个人分支不做 org 可见性过滤:个人 install 是安装时已按可见性授权的自留地,离开 org 后
 * 仍保留(与"个人优先"一致),不构成新增泄露(内容安装时已合法取得)。
 * org install 的 agent_ids 与个人 install 同语义,容器侧 sidecar 零改动。
 */
export async function listActiveInstalledArtifacts(userId: number): Promise<InstalledArtifact[]> {
  const membership = await getActiveMembership(String(userId))
  const orgId = membership?.org_id ?? null
  const r = await query<{
    slug: string
    version: string
    raw_skill_md: string
    artifact_hash: string
    agent_ids: unknown
    raw_bundle: unknown
  }>(
    `SELECT DISTINCT ON (m.slug) m.slug, m.version, m.raw_skill_md, m.artifact_hash,
            m.agent_ids, m.raw_bundle
       FROM (
         -- 个人 install(priority 0 = 同 slug 优先)
         SELECT i.slug, v.version, v.raw_skill_md, i.artifact_hash, i.agent_ids, v.raw_bundle,
                0 AS priority
           FROM marketplace_installs i
           JOIN marketplace_skill_versions v ON v.id = i.version_id
           JOIN marketplace_skill_listings l ON l.slug = i.slug
          WHERE i.user_id = $1 AND i.uninstalled_at IS NULL AND l.state = 'active'
                AND l.kind = 'skill' AND v.raw_skill_md IS NOT NULL
                AND i.artifact_hash = v.artifact_hash
         UNION ALL
         -- org install(priority 1):仅当 caller 有 active org 且该 org active
         SELECT oi.slug, v.version, v.raw_skill_md, oi.artifact_hash, oi.agent_ids, v.raw_bundle,
                1 AS priority
           FROM org_installs oi
           JOIN orgs o ON o.id = oi.org_id AND o.status = 'active'
           JOIN marketplace_skill_versions v ON v.id = oi.version_id
           JOIN marketplace_skill_listings l ON l.slug = oi.slug
          WHERE oi.org_id = $2::bigint AND oi.uninstalled_at IS NULL AND l.state = 'active'
                AND l.kind = 'skill' AND v.raw_skill_md IS NOT NULL
                AND oi.artifact_hash = v.artifact_hash
       ) m
      ORDER BY m.slug, m.priority`,
    [userId, orgId],
  )
  return r.rows.map((x) => ({
    slug: x.slug,
    version: x.version,
    rawSkillMd: x.raw_skill_md,
    artifactHash: x.artifact_hash,
    agentIds: normalizeInstallAgentIds(x.agent_ids, DEFAULT_INSTALL_AGENT_IDS),
    bundle: (x.raw_bundle as Record<string, string> | null) ?? null,
  }))
}

export interface InstalledAgent {
  slug: string
  version: string
  /** Canonical agent manifest JSON (raw_artifact). */
  rawManifest: string
  artifactHash: string
}

/**
 * Active AGENT installs of a user, with the full manifest, for container-side
 * agents.yaml reconciliation (the agent analogue of listActiveInstalledArtifacts).
 * Excludes revoked listings (kill-switch) + requires a non-null raw_artifact.
 */
export async function listActiveInstalledAgents(userId: number): Promise<InstalledAgent[]> {
  // agent 类仅 v5。marketplace_installs 是 v3/v5 共享且非渠道隔离:同一用户在 v5 装过、
  // 或本次门控前已装的 agent,若不在此过滤,会经容器 sync(reconcileAgents → agents.yaml)
  // 在 v3 容器复活(v3 无对应能力 → 坏 agent),也会出现在 v3 my-agents。v3 渠道直接返空。
  if (!marketplaceAgentsEnabled()) return []
  const r = await query<{
    slug: string
    version: string
    raw_artifact: string
    artifact_hash: string
  }>(
    `SELECT i.slug, v.version, v.raw_artifact, i.artifact_hash
       FROM marketplace_installs i
       JOIN marketplace_skill_versions v ON v.id = i.version_id
       JOIN marketplace_skill_listings l ON l.slug = i.slug
      WHERE i.user_id = $1 AND i.uninstalled_at IS NULL AND l.state = 'active'
            AND l.kind = 'agent' AND v.raw_artifact IS NOT NULL
            AND i.artifact_hash = v.artifact_hash`,
    [userId],
  )
  return r.rows.map((x) => ({
    slug: x.slug,
    version: x.version,
    rawManifest: x.raw_artifact,
    artifactHash: x.artifact_hash,
  }))
}

/**
 * 平台预设 agent 的 current approved manifest(与 listActiveInstalledAgents 同形,
 * 供 my-agents 与容器 sync 合并)。预设不 pin 版本 —— 恒取 listing 当前上架版本;
 * revoke / 无 approved 版本的 slug 自动缺席(kill-switch 优先于预设)。
 */
export async function listPlatformPresetAgents(slugs: readonly string[]): Promise<InstalledAgent[]> {
  if (slugs.length === 0 || !marketplaceAgentsEnabled()) return []
  const r = await query<{
    slug: string
    version: string
    raw_artifact: string
    artifact_hash: string
  }>(
    `SELECT l.slug, v.version, v.raw_artifact, v.artifact_hash
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.slug = ANY($1::text[]) AND l.state = 'active' AND l.kind = 'agent'
            AND v.status = 'approved' AND v.raw_artifact IS NOT NULL`,
    [slugs],
  )
  return r.rows.map((x) => ({
    slug: x.slug,
    version: x.version,
    rawManifest: x.raw_artifact,
    artifactHash: x.artifact_hash,
  }))
}

/**
 * For a set of skill slugs, return the current approved version id of each that is
 * an active, approved SKILL listing. Used to (a) validate an agent's skillDeps all
 * resolve to approved skills, and (b) auto-install them with the agent.
 */
export async function getApprovedSkillVersions(
  slugs: string[],
  callerOrgId: CallerOrgId = null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (slugs.length === 0) return out
  const r = await query<{ slug: string; vid: string }>(
    // org 可见性收口:skillDep 解析(发布校验 + agent 装配时自动装依赖)只认 caller 可见的
    // skill(公开 ∪ 本 org 私有)。org-private 依赖对非本 org caller 不解析 → 视为未上架,
    // 与 install 层的可见性双重防护一致(不会把他 org 私有技能经依赖旁路装进容器)。
    `SELECT l.slug, l.current_approved_version_id::text AS vid
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.slug = ANY($1::text[]) AND l.kind = 'skill'
            AND l.state = 'active' AND v.status = 'approved'
            AND ${orgVisibleFrag('l', 2)}`,
    [slugs, callerOrgId],
  )
  for (const row of r.rows) out.set(row.slug, row.vid)
  return out
}

/** Kill-switch: revoke a listing. Returns the user_ids with an active install (to notify). */
export async function revokeListing(slug: string, reason: string): Promise<number[]> {
  return tx(async (c) => {
    await query(
      `UPDATE marketplace_skill_listings
          SET state = 'revoked', revoked_reason = $2, updated_at = NOW()
        WHERE slug = $1`,
      [slug, reason],
      c,
    )
    const affected = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id::text FROM marketplace_installs
        WHERE slug = $1 AND uninstalled_at IS NULL`,
      [slug],
      c,
    )
    return affected.rows.map((x) => Number.parseInt(x.user_id, 10))
  })
}
