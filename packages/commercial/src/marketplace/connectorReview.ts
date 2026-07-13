/** 原子连接器审核：安全编译/签名、功能验收、市场上架在同一事务提交。 */
import type { Pool, PoolClient } from 'pg'
import { isDefaultConnectorArtifact } from '../connectors/defaults/index.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import {
  markFunctionalVerifiedWithRunner,
  securityApproveWithRunner,
} from '../connectors/spec/review.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { getPool } from '../db/index.js'
import { type QueryRunner, tx } from '../db/queries.js'
import { lockMarketplaceListing, lockMarketplaceVersion } from './locking.js'
import { MarketplaceError } from './marketplaceDb.js'

export async function getMarketplaceArtifactKind(
  versionId: string,
  pool: Pool = getPool(),
): Promise<'skill' | 'agent' | 'connector' | null> {
  const r = await pool.query<{ kind: 'skill' | 'agent' | 'connector' }>(
    `SELECT l.kind FROM marketplace_skill_versions v
      JOIN marketplace_skill_listings l ON l.slug = v.slug WHERE v.id = $1`,
    [versionId],
  )
  return r.rows[0]?.kind ?? null
}

async function assertActiveAdminNotAuthor(
  reviewerUserId: number,
  submittedBy: string,
  pool: QueryRunner,
): Promise<void> {
  const r = await pool.query<{ role: string; status: string }>(
    'SELECT role, status FROM users WHERE id = $1',
    [reviewerUserId],
  )
  if (r.rows[0]?.role !== 'admin' || r.rows[0]?.status !== 'active')
    throw new ConnectorSpecError('REVIEWER_NOT_ADMIN', 'reviewer must be active admin')
  if (BigInt(submittedBy) === BigInt(reviewerUserId))
    throw new ConnectorSpecError('REVIEWER_IS_AUTHOR', 'reviewer must differ from author')
}

function parseAndCompile(
  rawArtifact: string,
  securityDecision: unknown,
  expectedSpecHash: string,
  slug: string,
  artifactHash: string,
) {
  let rawSpec: unknown
  try {
    rawSpec = JSON.parse(rawArtifact)
  } catch {
    throw new ConnectorSpecError('SPEC_SCHEMA_INVALID', 'raw connector spec is invalid JSON')
  }
  const compiled = compileSpec(rawSpec, securityDecision)
  if (compiled.specHash !== artifactHash)
    throw new ConnectorSpecError('ARTIFACT_HASH_MISMATCH', 'stored artifact hash mismatch')
  if (compiled.specHash !== expectedSpecHash)
    throw new ConnectorSpecError('SPEC_HASH_MISMATCH', 'reviewed spec changed')
  if ((rawSpec as { id?: unknown }).id !== slug)
    throw new ConnectorSpecError('SPEC_ID_MISMATCH', 'spec.id != listing slug')
  return compiled
}

export interface ApproveMarketplaceConnectorInput {
  versionId: string
  reviewerUserId: number
  securityDecision: unknown
  expectedSpecHash: string
  functionalVerified: boolean
  note?: string
  env?: NodeJS.ProcessEnv
  /** 仅平台 seed：允许把同一已签版本重新收敛为 active/current。 */
  allowPlatformConvergence?: boolean
  pool?: Pool
}

export async function approveMarketplaceConnectorVersionWithRunner(
  input: Omit<ApproveMarketplaceConnectorInput, 'pool'>,
  client: PoolClient,
): Promise<void> {
  if (!input.functionalVerified)
    throw new ConnectorSpecError('INVALID_STATE', 'functional verification attestation required')

  const version = await lockMarketplaceVersion(client, input.versionId)
  if (!version) throw new MarketplaceError('VERSION_NOT_FOUND', 'version 不存在')
  const listing = await lockMarketplaceListing(client, version.slug)
  if (!listing) throw new MarketplaceError('VERSION_NOT_FOUND', 'listing 不存在')
  if (listing.kind !== 'connector')
    throw new MarketplaceError('KIND_MISMATCH', '该版本不是 connector')
  if (listing.state === 'revoked')
    throw new MarketplaceError('LISTING_REVOKED', `slug "${version.slug}" 已被平台下架`)
  await assertActiveAdminNotAuthor(input.reviewerUserId, version.submittedBy, client)
  const compiled = parseAndCompile(
    version.rawArtifact,
    input.securityDecision,
    input.expectedSpecHash,
    version.slug,
    version.artifactHash,
  )
  if (
    compiled.execContract.authMode === 'oauth2-auth-code' &&
    compiled.execContract.oauth2?.clientProvisioning === 'platform' &&
    !isDefaultConnectorArtifact(version.slug, version.artifactHash)
  ) {
    throw new ConnectorSpecError(
      'PLATFORM_OAUTH_FORBIDDEN',
      'platform-managed OAuth is reserved for an exact built-in connector artifact',
    )
  }

  if (version.status === 'approved') {
    const storedHash = version.execContractHash?.toString('hex') ?? ''
    if (!input.allowPlatformConvergence) {
      const signedStateInvalid =
        version.securityReviewState !== 'security_approved' ||
        version.functionalVerifyState !== 'verified' ||
        version.execRevokedAt !== null ||
        storedHash !== compiled.execContractHash
      if (signedStateInvalid)
        throw new MarketplaceError('NOT_PENDING', '已审核版本与本次决定不一致')
      if (listing.state !== 'active' || listing.currentApprovedVersionId !== version.id)
        throw new MarketplaceError('NOT_PENDING', '已审核版本与当前 listing 状态不一致')
      return
    }

    // 平台默认 seed 可恢复“市场状态已 approved，但签名/功能/指针只完成一部分”的中断。
    // 仍复用同一套安全编译、验签 hash 与管理员校验，绝不把不一致内容静默收敛。
    if (version.execRevokedAt !== null)
      throw new MarketplaceError('NOT_PENDING', '已审核版本已被执行撤销')
    if (version.securityReviewState === 'draft') {
      await securityApproveWithRunner(
        {
          versionId: Number(version.id),
          reviewerUserId: input.reviewerUserId,
          securityDecision: input.securityDecision,
          expectedSpecHash: input.expectedSpecHash,
          ...(input.env ? { env: input.env } : {}),
        },
        client,
      )
    } else if (
      version.securityReviewState !== 'security_approved' ||
      storedHash !== compiled.execContractHash
    ) {
      throw new MarketplaceError('NOT_PENDING', '已审核版本与本次决定不一致')
    }
    if (version.functionalVerifyState === 'unverified')
      await markFunctionalVerifiedWithRunner(Number(version.id), input.reviewerUserId, client)
    else if (version.functionalVerifyState !== 'verified')
      throw new MarketplaceError('NOT_PENDING', '已审核版本功能验收状态无效')
    await client.query(
      `UPDATE marketplace_skill_listings
          SET current_approved_version_id = $2, state = 'active', revoked_reason = NULL,
              updated_at = NOW()
        WHERE slug = $1`,
      [version.slug, version.id],
    )
    return
  }
  if (version.status !== 'pending') throw new MarketplaceError('NOT_PENDING', '该版本已被审核')

  if (version.securityReviewState === 'draft') {
    await securityApproveWithRunner(
      {
        versionId: Number(version.id),
        reviewerUserId: input.reviewerUserId,
        securityDecision: input.securityDecision,
        expectedSpecHash: input.expectedSpecHash,
        ...(input.env ? { env: input.env } : {}),
      },
      client,
    )
  } else if (version.securityReviewState === 'security_approved') {
    const storedHash = version.execContractHash?.toString('hex') ?? ''
    if (storedHash !== compiled.execContractHash)
      throw new ConnectorSpecError('CAS_CONFLICT', 'existing signed decision differs')
  } else {
    throw new ConnectorSpecError('INVALID_STATE', 'connector security review was rejected')
  }

  if (version.functionalVerifyState === 'unverified')
    await markFunctionalVerifiedWithRunner(Number(version.id), input.reviewerUserId, client)
  else if (version.functionalVerifyState !== 'verified')
    throw new ConnectorSpecError('INVALID_STATE', 'invalid functional verification state')

  await client.query(
    `UPDATE marketplace_skill_versions
        SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(),
            review_note = $3, review_source = 'human',
            ai_review_state = CASE WHEN ai_review_state IN ('queued','running') THEN 'done' ELSE ai_review_state END
      WHERE id = $1 AND status = 'pending'`,
    [version.id, input.reviewerUserId, input.note ?? null],
  )
  const listingUpdate = await client.query(
    `UPDATE marketplace_skill_listings
        SET current_approved_version_id = $2,
            state = CASE WHEN state = 'unlisted' THEN 'active' ELSE state END,
            revoked_reason = CASE WHEN state = 'unlisted' THEN NULL ELSE revoked_reason END,
            updated_at = NOW()
      WHERE slug = $1 AND state <> 'revoked'`,
    [version.slug, version.id],
  )
  if (listingUpdate.rowCount !== 1)
    throw new MarketplaceError('LISTING_REVOKED', `slug "${version.slug}" 已被平台下架`)
}

export async function approveMarketplaceConnectorVersion(
  input: ApproveMarketplaceConnectorInput,
): Promise<void> {
  const pool = input.pool ?? getPool()
  await tx(
    (client) =>
      approveMarketplaceConnectorVersionWithRunner(
        {
          versionId: input.versionId,
          reviewerUserId: input.reviewerUserId,
          securityDecision: input.securityDecision,
          expectedSpecHash: input.expectedSpecHash,
          functionalVerified: input.functionalVerified,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.allowPlatformConvergence ? { allowPlatformConvergence: true } : {}),
        },
        client,
      ),
    pool,
  )
}

export async function rejectMarketplaceConnectorVersion(args: {
  versionId: string
  reviewerUserId: number
  note: string
  pool?: Pool
}): Promise<void> {
  const pool = args.pool ?? getPool()
  await tx(async (client) => {
    const version = await lockMarketplaceVersion(client, args.versionId)
    if (!version) throw new MarketplaceError('VERSION_NOT_FOUND', 'version 不存在')
    const listing = await lockMarketplaceListing(client, version.slug)
    if (listing?.kind !== 'connector')
      throw new MarketplaceError('KIND_MISMATCH', '该版本不是 connector')
    await assertActiveAdminNotAuthor(args.reviewerUserId, version.submittedBy, client)
    if (version.status !== 'pending') throw new MarketplaceError('NOT_PENDING', '该版本已被审核')
    await client.query(
      `UPDATE marketplace_skill_versions
          SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(),
              review_note = $3, review_source = 'human',
              security_review_state = CASE
                WHEN security_review_state = 'draft' THEN 'security_rejected'
                ELSE security_review_state END,
              exec_revoked_at = CASE
                WHEN security_review_state = 'security_approved' THEN COALESCE(exec_revoked_at, NOW())
                ELSE exec_revoked_at END,
              ai_review_state = CASE WHEN ai_review_state IN ('queued','running') THEN 'done' ELSE ai_review_state END
        WHERE id = $1`,
      [version.id, args.reviewerUserId, args.note],
    )
  }, pool)
}

export { projectSignedConnectorContract } from '../connectors/spec/projection.js'
