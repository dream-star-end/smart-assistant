import { query, tx, type QueryRunner } from '../db/queries.js'
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
const DEFAULT_INSTALL_AGENT_IDS = ['main']

function normalizeInstallAgentIds(
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
  /** SKILL.md 之外的附属文本文件(references/assets/evals;已过 bundle 校验)。 */
  rawBundle?: Record<string, string> | null
  /** 发布者自报评测摘要(展示须标注"发布者提供",非平台背书)。 */
  benchmark?: { withPassRate: number; withoutPassRate: number; cases: number } | null
}

/** Create the listing (owner- AND kind-locked) if new, then a pending version. */
export async function publishSkillVersion(input: PublishInput): Promise<{ versionId: string }> {
  const kind: ArtifactKind = input.kind ?? 'skill'
  const rawArtifact = input.rawArtifact ?? input.rawSkillMd
  if (rawArtifact == null)
    throw new MarketplaceError('VERSION_NOT_FOUND', 'missing artifact content')
  return tx(async (c) => {
    await query(
      `INSERT INTO marketplace_skill_listings (slug, owner_user_id, kind)
            VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING`,
      [input.slug, input.ownerUserId, kind],
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
      const ins = await query<{ id: string }>(
        `INSERT INTO marketplace_skill_versions
           (slug, version, name, description, tags, raw_skill_md, raw_artifact, manifest,
            artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by,
            raw_bundle, benchmark)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,'pending',$11::jsonb,$12,$13,
                 $14::jsonb,$15::jsonb)
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
  }>(
    `SELECT v.id::text, v.slug, l.kind, v.version, v.name, v.description, v.tags,
            v.raw_artifact, v.raw_skill_md, v.manifest, v.raw_bundle, v.benchmark,
            v.risk_flags, v.submitted_by::text, l.owner_user_id::text, v.created_at::text
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
  }))
}

/** Approve/reject a pending version. Reviewer must differ from submitter unless an admin-only caller opts in. */
export async function reviewVersion(args: {
  versionId: string
  reviewerUserId: number
  approve: boolean
  note?: string
  allowSelfReview?: boolean
}): Promise<void> {
  await tx(async (c) => {
    const v = await query<{ slug: string; status: string; submitted_by: string }>(
      'SELECT slug, status, submitted_by::text FROM marketplace_skill_versions WHERE id = $1 FOR UPDATE',
      [args.versionId],
      c,
    )
    const row = v.rows[0]
    if (!row) throw new MarketplaceError('VERSION_NOT_FOUND', 'version 不存在')
    if (row.status !== 'pending') throw new MarketplaceError('NOT_PENDING', '该版本已被审核')
    if (!args.allowSelfReview && BigInt(row.submitted_by) === BigInt(args.reviewerUserId))
      throw new MarketplaceError('REVIEWER_IS_AUTHOR', '审核人不能是发布者本人')

    await query(
      `UPDATE marketplace_skill_versions
          SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_note = $4
        WHERE id = $1`,
      [
        args.versionId,
        args.approve ? 'approved' : 'rejected',
        args.reviewerUserId,
        args.note ?? null,
      ],
      c,
    )
    if (args.approve) {
      await query(
        `UPDATE marketplace_skill_listings
            SET current_approved_version_id = $2, updated_at = NOW()
          WHERE slug = $1`,
        [row.slug, args.versionId],
        c,
      )
    }
  })
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
              review_note = 'platform-official seed'
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
}

/** Current approved version of every active listing — the searchable catalog.
 *  `kind` lets a caller scope the catalog to skills or agents. */
// 搜索候选集硬上限:search 是"全量拉回内存 → 关键词过滤/embedding 相似度"的实现,
// 无上限时目录增长线性劣化(每次搜索全表 + 全量 embedding cache lookup)。
// 500 覆盖上市初期数个量级;命中上限时告警日志 —— 那是"该把检索下沉到 SQL/pgvector"
// 的偿还触发条件,不是调大数字。
const SEARCH_CATALOG_CAP = 500

export async function listApprovedForSearch(kind?: ArtifactKind): Promise<ApprovedSearchRow[]> {
  const r = await query<{
    id: string
    slug: string
    kind: string
    name: string
    description: string
    tags: unknown
    embedding_hash: string
    install_count: string | null
  }>(
    // install_count 走一次性聚合 JOIN(而非逐行 correlated 子查询):目录上限 500 行,
    // 逐行子查询会对共享的 v3 search 端点放大 500 次 installs 扫描。
    `SELECT v.id::text, v.slug, l.kind, v.name, v.description, v.tags, v.embedding_hash,
            ic.n::text AS install_count
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
       LEFT JOIN (SELECT slug, count(*) AS n FROM marketplace_installs
                   WHERE uninstalled_at IS NULL GROUP BY slug) ic ON ic.slug = l.slug
      WHERE l.state = 'active' AND v.status = 'approved'
            AND ($1::text IS NULL OR l.kind = $1)
      ORDER BY v.id DESC
      LIMIT ${SEARCH_CATALOG_CAP + 1}`,
    [kind ?? null],
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

/** Public detail for an active listing's current approved version (incl. the full artifact for the confirm dialog). */
export async function getListingDetail(slug: string): Promise<ListingDetail | null> {
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
      WHERE l.slug = $1 AND l.state = 'active' AND v.status = 'approved'`,
    [slug],
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
}): Promise<{ slug: string; version: string; name: string }> {
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
      `SELECT v.slug, v.version, v.name, v.artifact_hash, l.kind
         FROM marketplace_skill_versions v
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.id = $1 AND v.status = 'approved' AND l.state = 'active'
              AND l.current_approved_version_id = v.id
        FOR UPDATE OF l`,
      [args.versionId],
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

export async function getInstallableVersionTarget(versionId: string): Promise<{
  slug: string
  kind: ArtifactKind
  version: string
} | null> {
  const r = await query<{ slug: string; kind: string; version: string }>(
    `SELECT v.slug, l.kind, v.version
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.id = $1 AND v.status = 'approved' AND l.state = 'active'
            AND l.current_approved_version_id = v.id`,
    [versionId],
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
 */
export async function listActiveInstalledArtifacts(userId: number): Promise<InstalledArtifact[]> {
  const r = await query<{
    slug: string
    version: string
    raw_skill_md: string
    artifact_hash: string
    agent_ids: unknown
    raw_bundle: unknown
  }>(
    `SELECT i.slug, v.version, v.raw_skill_md, i.artifact_hash, i.agent_ids, v.raw_bundle
       FROM marketplace_installs i
       JOIN marketplace_skill_versions v ON v.id = i.version_id
       JOIN marketplace_skill_listings l ON l.slug = i.slug
      WHERE i.user_id = $1 AND i.uninstalled_at IS NULL AND l.state = 'active'
            AND l.kind = 'skill' AND v.raw_skill_md IS NOT NULL
            AND i.artifact_hash = v.artifact_hash`,
    [userId],
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
export async function getApprovedSkillVersions(slugs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (slugs.length === 0) return out
  const r = await query<{ slug: string; vid: string }>(
    `SELECT l.slug, l.current_approved_version_id::text AS vid
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.slug = ANY($1::text[]) AND l.kind = 'skill'
            AND l.state = 'active' AND v.status = 'approved'`,
    [slugs],
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
