import { query, tx } from '../db/queries.js'
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
      | 'KIND_MISMATCH',
    message: string,
  ) {
    super(message)
    this.name = 'MarketplaceError'
  }
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
            artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,'pending',$11::jsonb,$12,$13)
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
  }>(
    `SELECT v.id::text, v.slug, l.kind, v.version, v.name, v.description, v.tags,
            v.raw_artifact, v.raw_skill_md, v.manifest,
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
  }))
}

/** Approve/reject a pending version. Reviewer must differ from submitter. */
export async function reviewVersion(args: {
  versionId: string
  reviewerUserId: number
  approve: boolean
  note?: string
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
    if (BigInt(row.submitted_by) === BigInt(args.reviewerUserId))
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

export interface ApprovedSearchRow {
  versionId: string
  slug: string
  kind: ArtifactKind
  name: string
  description: string
  tags: string[]
  embeddingHash: string
}

/** Current approved version of every active listing — the searchable catalog.
 *  `kind` lets a caller scope the catalog to skills or agents. */
export async function listApprovedForSearch(kind?: ArtifactKind): Promise<ApprovedSearchRow[]> {
  const r = await query<{
    id: string
    slug: string
    kind: string
    name: string
    description: string
    tags: unknown
    embedding_hash: string
  }>(
    `SELECT v.id::text, v.slug, l.kind, v.name, v.description, v.tags, v.embedding_hash
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.state = 'active' AND v.status = 'approved'
            AND ($1::text IS NULL OR l.kind = $1)`,
    [kind ?? null],
  )
  return r.rows.map((x) => ({
    versionId: x.id,
    slug: x.slug,
    kind: x.kind as ArtifactKind,
    name: x.name,
    description: x.description,
    tags: (x.tags as string[]) ?? [],
    embeddingHash: x.embedding_hash,
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
    install_count: string
  }>(
    `SELECT l.slug, l.kind, l.state, l.owner_user_id::text, v.version, v.id::text AS vid,
            v.name, v.description, v.tags, v.artifact_hash, v.raw_artifact, v.raw_skill_md,
            v.manifest, v.risk_flags,
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
}): Promise<{ slug: string; version: string; name: string }> {
  return tx(async (c) => {
    const v = await query<{
      slug: string
      version: string
      name: string
      artifact_hash: string
    }>(
      // Kind-agnostic install: records the pinned install row for skill OR agent.
      // Kind-specific delivery happens in the container sync (skill→hub/skills,
      // agent→agents.yaml). M3 wired the agent delivery path, so both are installable.
      `SELECT v.slug, v.version, v.name, v.artifact_hash
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

    await query(
      `UPDATE marketplace_installs SET uninstalled_at = NOW()
        WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL`,
      [args.userId, row.slug],
      c,
    )
    await query(
      `INSERT INTO marketplace_installs (user_id, slug, version_id, artifact_hash, installed_by)
            VALUES ($1,$2,$3,$4,$1)`,
      [args.userId, row.slug, args.versionId, row.artifact_hash],
      c,
    )
    return { slug: row.slug, version: row.version, name: row.name }
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
  installedAt: string
  listingState: string
}

export async function listInstalled(userId: number): Promise<InstalledRow[]> {
  const r = await query<{
    slug: string
    kind: string
    version: string
    version_id: string
    name: string
    artifact_hash: string
    installed_at: string
    state: string
  }>(
    `SELECT i.slug, l.kind, v.version, i.version_id::text, v.name, i.artifact_hash,
            i.installed_at::text, l.state
       FROM marketplace_installs i
       JOIN marketplace_skill_versions v ON v.id = i.version_id
       JOIN marketplace_skill_listings l ON l.slug = i.slug
      WHERE i.user_id = $1 AND i.uninstalled_at IS NULL
      ORDER BY i.installed_at DESC`,
    [userId],
  )
  return r.rows.map((x) => ({
    slug: x.slug,
    kind: x.kind as ArtifactKind,
    version: x.version,
    versionId: x.version_id,
    name: x.name,
    artifactHash: x.artifact_hash,
    installedAt: x.installed_at,
    listingState: x.state,
  }))
}

export interface InstalledArtifact {
  slug: string
  version: string
  rawSkillMd: string
  artifactHash: string
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
  }>(
    `SELECT i.slug, v.version, v.raw_skill_md, i.artifact_hash
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
