/** 原子连接器审核：安全编译/签名、功能验证方式留痕、市场上架在同一事务提交。 */
import type { Pool, PoolClient } from 'pg'
import { isDefaultConnectorArtifact } from '../connectors/defaults/index.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import {
  markDeclarativeVerifiedWithRunner,
  markFunctionalVerifiedWithRunner,
  securityApproveWithRunner,
} from '../connectors/spec/review.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { getPool } from '../db/index.js'
import { type QueryRunner, tx } from '../db/queries.js'
import { lockMarketplaceListing, lockMarketplaceVersion } from './locking.js'
import { MarketplaceError } from './marketplaceDb.js'

export const AI_CONNECTOR_REVIEWER_EMAIL = 'marketplace-ai-reviewer@users.claudeai.chat'
export const AI_CONNECTOR_REVIEWER_PASSWORD_SENTINEL =
  '!openclaude-system-principal:marketplace-ai-reviewer:v1!'

/**
 * 连接器 AI 审核需要 active-admin FK 才能写既有安全/功能审计表。该主体不可登录：
 * 合成域禁止密码重置，password_hash 是刻意无效的非 Argon2 sentinel，且不允许存在
 * OAuth identity 或有效 refresh token。冲突时只 fail-closed，绝不接管/提权已有账号。
 */
export async function ensureAiConnectorReviewer(pool: Pool = getPool()): Promise<number> {
  await pool.query(
    `INSERT INTO users(email, password_hash, email_verified, role, status)
       VALUES ($1, $2, TRUE, 'admin', 'active')
     ON CONFLICT (email) DO NOTHING`,
    [AI_CONNECTOR_REVIEWER_EMAIL, AI_CONNECTOR_REVIEWER_PASSWORD_SENTINEL],
  )
  const r = await pool.query<{
    id: string
    email: string
    password_hash: string
    email_verified: boolean
    role: string
    status: string
    has_oauth_identity: boolean
    has_active_refresh: boolean
  }>(
    `SELECT u.id::text AS id, u.email, u.password_hash, u.email_verified, u.role, u.status,
            EXISTS(SELECT 1 FROM oauth_identities oi WHERE oi.user_id = u.id) AS has_oauth_identity,
            EXISTS(SELECT 1 FROM refresh_tokens rt
                    WHERE rt.user_id = u.id AND rt.revoked_at IS NULL AND rt.expires_at > NOW())
              AS has_active_refresh
       FROM users u WHERE u.email = $1`,
    [AI_CONNECTOR_REVIEWER_EMAIL],
  )
  const row = r.rows[0]
  if (
    !row ||
    row.email !== AI_CONNECTOR_REVIEWER_EMAIL ||
    row.password_hash !== AI_CONNECTOR_REVIEWER_PASSWORD_SENTINEL ||
    row.email_verified !== true ||
    row.role !== 'admin' ||
    row.status !== 'active' ||
    row.has_oauth_identity ||
    row.has_active_refresh
  ) {
    throw new Error('marketplace AI reviewer principal collision')
  }
  return Number(row.id)
}

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
  /** 人工路径必须显式确认隔离账号实测；AI 路径改用 declarative-ai，不得伪造该确认。 */
  functionalVerified?: boolean
  functionalVerificationMode?: 'live' | 'declarative-ai'
  note?: string
  source?: 'human' | 'ai'
  aiNote?: string | null
  env?: NodeJS.ProcessEnv
  /** 仅平台 seed：允许把同一已签版本重新收敛为 active/current。 */
  allowPlatformConvergence?: boolean
  pool?: Pool
}

export async function approveMarketplaceConnectorVersionWithRunner(
  input: Omit<ApproveMarketplaceConnectorInput, 'pool'>,
  client: PoolClient,
): Promise<void> {
  const verificationMode = input.functionalVerificationMode ?? 'live'
  if (verificationMode === 'live' && input.functionalVerified !== true)
    throw new ConnectorSpecError('INVALID_STATE', 'functional verification attestation required')
  if (verificationMode === 'declarative-ai' && input.source !== 'ai')
    throw new ConnectorSpecError(
      'INVALID_STATE',
      'declarative verification is reserved for AI review',
    )
  const expectedFunctionalState =
    verificationMode === 'declarative-ai' ? 'declarative_verified' : 'verified'

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
        version.functionalVerifyState !== expectedFunctionalState ||
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
    if (version.functionalVerifyState === 'unverified') {
      if (verificationMode === 'declarative-ai')
        await markDeclarativeVerifiedWithRunner(Number(version.id), input.reviewerUserId, client)
      else await markFunctionalVerifiedWithRunner(Number(version.id), input.reviewerUserId, client)
    } else if (version.functionalVerifyState !== expectedFunctionalState)
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

  if (version.functionalVerifyState === 'unverified') {
    if (verificationMode === 'declarative-ai')
      await markDeclarativeVerifiedWithRunner(Number(version.id), input.reviewerUserId, client)
    else await markFunctionalVerifiedWithRunner(Number(version.id), input.reviewerUserId, client)
  } else if (version.functionalVerifyState !== expectedFunctionalState)
    throw new ConnectorSpecError('INVALID_STATE', 'invalid functional verification state')

  await client.query(
    `UPDATE marketplace_skill_versions
        SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(),
            review_note = $3, review_source = $4,
            ai_review_state = CASE
              WHEN $4 = 'ai' THEN 'done'
              WHEN ai_review_state IN ('queued','running') THEN 'done'
              ELSE ai_review_state END,
            ai_note = CASE WHEN $4 = 'ai' THEN $5 ELSE ai_note END,
            ai_reviewed_at = CASE WHEN $4 = 'ai' THEN NOW() ELSE ai_reviewed_at END,
            ai_locked_at = CASE WHEN $4 = 'ai' THEN NULL ELSE ai_locked_at END
      WHERE id = $1 AND status = 'pending'`,
    [
      version.id,
      input.reviewerUserId,
      input.note ?? null,
      input.source ?? 'human',
      input.source === 'ai' ? (input.aiNote ?? null) : null,
    ],
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
          ...(input.functionalVerified !== undefined
            ? { functionalVerified: input.functionalVerified }
            : {}),
          ...(input.functionalVerificationMode !== undefined
            ? { functionalVerificationMode: input.functionalVerificationMode }
            : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.aiNote !== undefined ? { aiNote: input.aiNote } : {}),
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
  source?: 'human' | 'ai'
  aiNote?: string | null
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
              review_note = $3, review_source = $4,
              security_review_state = CASE
                WHEN security_review_state = 'draft' THEN 'security_rejected'
                ELSE security_review_state END,
              exec_revoked_at = CASE
                WHEN security_review_state = 'security_approved' THEN COALESCE(exec_revoked_at, NOW())
                ELSE exec_revoked_at END,
              ai_review_state = CASE
                WHEN $4 = 'ai' THEN 'done'
                WHEN ai_review_state IN ('queued','running') THEN 'done'
                ELSE ai_review_state END,
              ai_note = CASE WHEN $4 = 'ai' THEN $5 ELSE ai_note END,
              ai_reviewed_at = CASE WHEN $4 = 'ai' THEN NOW() ELSE ai_reviewed_at END,
              ai_locked_at = CASE WHEN $4 = 'ai' THEN NULL ELSE ai_locked_at END
        WHERE id = $1`,
      [
        version.id,
        args.reviewerUserId,
        args.note,
        args.source ?? 'human',
        args.source === 'ai' ? (args.aiNote ?? null) : null,
      ],
    )
  }, pool)
}

export { projectSignedConnectorContract } from '../connectors/spec/projection.js'
