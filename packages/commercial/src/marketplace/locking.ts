import type { QueryRunner } from '../db/queries.js'

/**
 * marketplace 用户态写操作的统一互斥域。
 *
 * 所有 install/update/uninstall/bind/rebind 都必须先按 (user, slug) 取事务级 advisory
 * lock，再按 version → listing → install/connection 的固定顺序取行锁。这样同一连接器的
 * 安装状态与绑定状态不会出现 TOCTOU，也避免各入口各自选锁顺序造成 ABBA 死锁。
 */
export async function lockMarketplaceUserSlug(
  runner: QueryRunner,
  userId: number,
  slug: string,
): Promise<void> {
  await runner.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('marketplace_install_scope'),
       hashtext($1::text || ':' || $2::text)
     )`,
    [userId, slug],
  )
}

/** 只用于定位后续锁域；不得据此做最终授权决定。 */
export async function locateMarketplaceVersionSlug(
  runner: QueryRunner,
  versionId: string | number,
): Promise<string | null> {
  const r = await runner.query<{ slug: string }>(
    'SELECT slug FROM marketplace_skill_versions WHERE id = $1',
    [versionId],
  )
  return r.rows[0]?.slug ?? null
}

export interface LockedMarketplaceVersion {
  id: string
  slug: string
  version: string
  name: string
  artifactHash: string
  status: string
  submittedBy: string
  rawArtifact: string
  securityReviewState: string
  functionalVerifyState: string
  execRevokedAt: Date | null
  execContract: unknown
  execContractHash: Buffer | null
  compilerVersion: number | null
  securityPolicyVersion: number | null
  signature: Buffer | null
  keyId: string | null
}

/** 固定锁序的第一步：只锁 version 行。 */
export async function lockMarketplaceVersion(
  runner: QueryRunner,
  versionId: string | number,
): Promise<LockedMarketplaceVersion | null> {
  const r = await runner.query<{
    id: string
    slug: string
    version: string
    name: string
    artifact_hash: string
    status: string
    submitted_by: string
    raw_artifact: string
    security_review_state: string
    functional_verify_state: string
    exec_revoked_at: Date | null
    exec_contract: unknown
    exec_contract_hash: Buffer | null
    compiler_version: number | null
    security_policy_version: number | null
    signature: Buffer | null
    key_id: string | null
  }>(
    `SELECT id::text, slug, version, name, artifact_hash, status,
            submitted_by::text, raw_artifact, security_review_state,
            functional_verify_state, exec_revoked_at, exec_contract,
            exec_contract_hash, compiler_version, security_policy_version,
            signature, key_id
       FROM marketplace_skill_versions
      WHERE id = $1
      FOR UPDATE`,
    [versionId],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    id: row.id,
    slug: row.slug,
    version: row.version,
    name: row.name,
    artifactHash: row.artifact_hash,
    status: row.status,
    submittedBy: row.submitted_by,
    rawArtifact: row.raw_artifact,
    securityReviewState: row.security_review_state,
    functionalVerifyState: row.functional_verify_state,
    execRevokedAt: row.exec_revoked_at,
    execContract: row.exec_contract,
    execContractHash: row.exec_contract_hash,
    compilerVersion: row.compiler_version,
    securityPolicyVersion: row.security_policy_version,
    signature: row.signature,
    keyId: row.key_id,
  }
}

export interface LockedMarketplaceListing {
  slug: string
  kind: 'skill' | 'agent' | 'connector'
  state: string
  ownerUserId: string
  orgId: string | null
  currentApprovedVersionId: string | null
}

/** 固定锁序的第二步：version 已锁后再锁 listing。 */
export async function lockMarketplaceListing(
  runner: QueryRunner,
  slug: string,
): Promise<LockedMarketplaceListing | null> {
  const r = await runner.query<{
    slug: string
    kind: 'skill' | 'agent' | 'connector'
    state: string
    owner_user_id: string
    org_id: string | null
    current_approved_version_id: string | null
  }>(
    `SELECT slug, kind, state, owner_user_id::text,
            org_id::text, current_approved_version_id::text
       FROM marketplace_skill_listings
      WHERE slug = $1
      FOR UPDATE`,
    [slug],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    slug: row.slug,
    kind: row.kind,
    state: row.state,
    ownerUserId: row.owner_user_id,
    orgId: row.org_id,
    currentApprovedVersionId: row.current_approved_version_id,
  }
}
