/**
 * Non-declarative Plugin review and load boundary.
 *
 * Declarative HTTP Plugins keep using connectors/spec/review.ts. This module is
 * intentionally limited to sandboxed-local and managed-browser artifacts and
 * always writes the plugin-v2 signature scheme behind migration 0153's
 * transaction-bound writer gate.
 */

import type { Pool, PoolClient } from 'pg'
import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import { signPluginContractV2, verifyPluginContractV2 } from '../connectors/spec/signer.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { getPool } from '../db/index.js'
import { type QueryRunner, tx } from '../db/queries.js'
import { lockMarketplaceListing, lockMarketplaceVersion } from '../marketplace/locking.js'
import {
  type CompiledRuntimePluginArtifact,
  type ManagedBrowserPluginContractV1,
  RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES,
  RUNTIME_PLUGIN_COMPILER_VERSION,
  type SandboxedLocalPluginContractV1,
  compileRuntimePluginArtifact,
} from './contracts.js'

export const CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION = 1

export interface ApproveRuntimePluginVersionInput {
  versionId: string | number
  reviewerUserId: number
  expectedArtifactHash: string
  /** Runtime Plugins never use the declarative-AI shortcut. */
  functionalVerified: true
  note?: string
  env?: NodeJS.ProcessEnv
  pool?: Pool
}

export interface ApproveOfficialRuntimePluginVersionInput {
  versionId: string | number
  ownerUserId: number
  expectedArtifactHash: string
  /** Set only after the deploy gate exercised this exact official worker flow. */
  functionalVerified: true
  /**
   * False approves/signs the immutable target but leaves current selection to a
   * later atomic install/account transition. Official managed-browser upgrades
   * use this to avoid exposing a version before encrypted accounts are ready.
   */
  activateListing?: boolean
  env?: NodeJS.ProcessEnv
  pool?: Pool
}

async function assertActiveAdminNotAuthor(
  reviewerUserId: number,
  authorUserId: string,
  runner: QueryRunner,
): Promise<void> {
  const reviewer = await runner.query<{ role: string; status: string }>(
    'SELECT role, status FROM users WHERE id = $1',
    [reviewerUserId],
  )
  if (reviewer.rows[0]?.role !== 'admin' || reviewer.rows[0]?.status !== 'active')
    throw new ConnectorSpecError('REVIEWER_NOT_ADMIN', 'reviewer must be an active admin')
  if (BigInt(authorUserId) === BigInt(reviewerUserId))
    throw new ConnectorSpecError('REVIEWER_IS_AUTHOR', 'reviewer must differ from author')
}

function parseAndCompileRuntimeArtifact(
  rawArtifact: string,
  expectedArtifactHash: string,
  storedArtifactHash: string,
  slug: string,
  version: string,
): CompiledRuntimePluginArtifact {
  if (Buffer.byteLength(rawArtifact, 'utf8') > RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES)
    throw new ConnectorSpecError('EXEC_CONTRACT_INVALID', 'raw Plugin artifact exceeds byte limit')
  let raw: unknown
  try {
    raw = JSON.parse(rawArtifact)
  } catch {
    throw new ConnectorSpecError('EXEC_CONTRACT_INVALID', 'raw Plugin artifact is invalid JSON')
  }
  let compiled: CompiledRuntimePluginArtifact
  try {
    compiled = compileRuntimePluginArtifact(raw)
  } catch {
    throw new ConnectorSpecError('EXEC_CONTRACT_INVALID', 'runtime Plugin artifact failed compile')
  }
  if (compiled.artifactHash !== storedArtifactHash)
    throw new ConnectorSpecError('ARTIFACT_HASH_MISMATCH', 'stored Plugin artifact hash mismatch')
  if (compiled.artifactHash !== expectedArtifactHash)
    throw new ConnectorSpecError('SPEC_HASH_MISMATCH', 'reviewed Plugin artifact changed')
  if (compiled.execContract.id !== slug)
    throw new ConnectorSpecError('SPEC_ID_MISMATCH', 'Plugin id does not match listing slug')
  if (compiled.execContract.version !== version)
    throw new ConnectorSpecError(
      'EXEC_CONTRACT_INVALID',
      'Plugin version does not match DB version',
    )
  return compiled
}

function safeVersionId(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value))
    throw new ConnectorSpecError('VERSION_NOT_FOUND', 'Plugin version id is invalid')
  return parsed
}

/** Atomic review + plugin-v2 trust write + live verification + marketplace activation. */
export async function approveRuntimePluginVersionWithRunner(
  input: Omit<ApproveRuntimePluginVersionInput, 'pool'>,
  client: PoolClient,
): Promise<CompiledRuntimePluginArtifact> {
  if (input.functionalVerified !== true)
    throw new ConnectorSpecError('INVALID_STATE', 'live functional verification is required')
  const version = await lockMarketplaceVersion(client, input.versionId, {
    maxRawArtifactBytes: RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES,
  })
  if (!version) throw new ConnectorSpecError('VERSION_NOT_FOUND', 'Plugin version not found')
  const listing = await lockMarketplaceListing(client, version.slug)
  if (!listing) throw new ConnectorSpecError('VERSION_NOT_FOUND', 'Plugin listing not found')
  if (
    listing.kind !== 'connector' ||
    (listing.pluginType !== 'sandboxed-local' && listing.pluginType !== 'managed-browser')
  )
    throw new ConnectorSpecError('WRONG_ARTIFACT_KIND', 'version is not a runtime Plugin')
  if (listing.state === 'revoked')
    throw new ConnectorSpecError('EXEC_REVOKED', 'Plugin listing is revoked')
  if (version.execRevokedAt !== null)
    throw new ConnectorSpecError('EXEC_REVOKED', 'Plugin version is revoked')
  if (version.status !== 'pending' || version.securityReviewState !== 'draft')
    throw new ConnectorSpecError('NOT_DRAFT', 'Plugin version is not pending security review')
  await assertActiveAdminNotAuthor(input.reviewerUserId, version.submittedBy, client)

  const compiled = parseAndCompileRuntimeArtifact(
    version.rawArtifact,
    input.expectedArtifactHash,
    version.artifactHash,
    version.slug,
    version.version,
  )
  if (compiled.pluginType !== listing.pluginType)
    throw new ConnectorSpecError('WRONG_ARTIFACT_KIND', 'artifact subtype does not match listing')

  const versionId = safeVersionId(version.id)
  const signature = signPluginContractV2(
    {
      listingSlug: listing.slug,
      versionId,
      kind: listing.kind,
      pluginType: listing.pluginType,
      specHash: compiled.artifactHash,
      execContractHash: compiled.execContractHash,
      compilerVersion: RUNTIME_PLUGIN_COMPILER_VERSION,
      policyVersion: CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION,
    },
    { env: input.env ?? process.env },
  )

  // Migration 0153 rejects plugin-v2 trust writes without this xid-bound LOCAL marker.
  await client.query(
    `SELECT set_config(
       'openclaude.plugin_signature_writer',
       'plugin-v2:' || pg_current_xact_id()::text,
       true
     )`,
  )
  const updated = await client.query(
    `UPDATE marketplace_skill_versions
        SET exec_contract = $2::jsonb,
            exec_contract_hash = $3,
            compiler_version = $4,
            security_policy_version = $5,
            signature = $6,
            key_id = $7,
            signature_scheme = 'plugin-v2',
            security_reviewed_by = $8,
            security_reviewed_at = NOW(),
            security_review_state = 'security_approved',
            functional_verify_state = 'verified',
            functional_verified_by = $8,
            functional_verified_at = NOW(),
            status = 'approved',
            reviewed_by = $8,
            reviewed_at = NOW(),
            review_note = $9,
            review_source = 'human'
      WHERE id = $1
        AND status = 'pending'
        AND security_review_state = 'draft'
        AND artifact_hash = $10`,
    [
      version.id,
      JSON.stringify(compiled.execContract),
      Buffer.from(compiled.execContractHash, 'hex'),
      RUNTIME_PLUGIN_COMPILER_VERSION,
      CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION,
      Buffer.from(signature.signature, 'hex'),
      signature.keyId,
      input.reviewerUserId,
      input.note ?? null,
      version.artifactHash,
    ],
  )
  if (updated.rowCount !== 1)
    throw new ConnectorSpecError('CAS_CONFLICT', 'Plugin version changed during review')

  const listingUpdate = await client.query(
    `UPDATE marketplace_skill_listings
        SET current_approved_version_id = $2,
            state = CASE WHEN state = 'unlisted' THEN 'active' ELSE state END,
            revoked_reason = CASE WHEN state = 'unlisted' THEN NULL ELSE revoked_reason END,
            updated_at = NOW()
      WHERE slug = $1 AND state <> 'revoked'`,
    [listing.slug, version.id],
  )
  if (listingUpdate.rowCount !== 1)
    throw new ConnectorSpecError('EXEC_REVOKED', 'Plugin listing was revoked during review')
  return compiled
}

export async function approveRuntimePluginVersion(
  input: ApproveRuntimePluginVersionInput,
): Promise<CompiledRuntimePluginArtifact> {
  if (input.functionalVerified !== true)
    throw new ConnectorSpecError('INVALID_STATE', 'live functional verification is required')
  const pool = input.pool ?? getPool()
  return tx(
    (client) =>
      approveRuntimePluginVersionWithRunner(
        {
          versionId: input.versionId,
          reviewerUserId: input.reviewerUserId,
          expectedArtifactHash: input.expectedArtifactHash,
          functionalVerified: input.functionalVerified,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.env ? { env: input.env } : {}),
        },
        client,
      ),
    pool,
  )
}

/**
 * Idempotent approval for a version-control-owned official runtime Plugin.
 * Unlike user submissions, the version-controlled platform seed is the reviewer;
 * the recorded owner is provenance only and may later be disabled without making
 * an already trusted official artifact undeployable.
 */
export async function approveOfficialRuntimePluginVersion(
  input: ApproveOfficialRuntimePluginVersionInput,
): Promise<CompiledRuntimePluginArtifact> {
  if (input.functionalVerified !== true)
    throw new ConnectorSpecError('INVALID_STATE', 'live functional verification is required')
  const pool = input.pool ?? getPool()
  return tx(async (client) => {
    const version = await lockMarketplaceVersion(client, input.versionId, {
      maxRawArtifactBytes: RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES,
    })
    if (!version) throw new ConnectorSpecError('VERSION_NOT_FOUND', 'Plugin version not found')
    const listing = await lockMarketplaceListing(client, version.slug)
    if (!listing) throw new ConnectorSpecError('VERSION_NOT_FOUND', 'Plugin listing not found')
    if (
      listing.kind !== 'connector' ||
      (listing.pluginType !== 'sandboxed-local' && listing.pluginType !== 'managed-browser')
    )
      throw new ConnectorSpecError('WRONG_ARTIFACT_KIND', 'version is not a runtime Plugin')
    if (
      listing.state === 'revoked' ||
      version.execRevokedAt !== null ||
      listing.ownerUserId !== String(input.ownerUserId) ||
      version.submittedBy !== String(input.ownerUserId)
    )
      throw new ConnectorSpecError('EXEC_REVOKED', 'official Plugin ownership or state mismatch')
    const compiled = parseAndCompileRuntimeArtifact(
      version.rawArtifact,
      input.expectedArtifactHash,
      version.artifactHash,
      version.slug,
      version.version,
    )
    if (compiled.pluginType !== listing.pluginType)
      throw new ConnectorSpecError('WRONG_ARTIFACT_KIND', 'artifact subtype does not match listing')
    const versionId = safeVersionId(version.id)
    const signedInput = {
      listingSlug: listing.slug,
      versionId,
      kind: listing.kind,
      pluginType: listing.pluginType,
      specHash: compiled.artifactHash,
      execContractHash: compiled.execContractHash,
      compilerVersion: RUNTIME_PLUGIN_COMPILER_VERSION,
      policyVersion: CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION,
    } as const

    if (version.status === 'approved') {
      if (
        version.reviewSource !== 'platform' ||
        version.securityReviewState !== 'security_approved' ||
        version.functionalVerifyState !== 'verified' ||
        version.execContractHash === null ||
        version.signature === null ||
        version.keyId === null ||
        version.signatureScheme !== 'plugin-v2' ||
        version.compilerVersion !== RUNTIME_PLUGIN_COMPILER_VERSION ||
        version.securityPolicyVersion !== CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION ||
        Buffer.from(version.execContractHash).toString('hex') !== compiled.execContractHash ||
        canonicalSha256Hex(version.execContract) !== compiled.execContractHash ||
        !verifyPluginContractV2(
          signedInput,
          Buffer.from(version.signature).toString('hex'),
          version.keyId,
          input.env ?? process.env,
        )
      )
        throw new ConnectorSpecError('SIGNATURE_INVALID', 'approved official Plugin trust mismatch')
    } else {
      if (
        version.status !== 'pending' ||
        version.securityReviewState !== 'draft' ||
        version.aiReviewState !== null
      )
        throw new ConnectorSpecError('NOT_DRAFT', 'official Plugin version is not reviewable')
      const signature = signPluginContractV2(signedInput, { env: input.env ?? process.env })
      await client.query(
        `SELECT set_config(
           'openclaude.plugin_signature_writer',
           'plugin-v2:' || pg_current_xact_id()::text,
           true
         )`,
      )
      const updated = await client.query(
        `UPDATE marketplace_skill_versions
            SET exec_contract = $2::jsonb,
                exec_contract_hash = $3,
                compiler_version = $4,
                security_policy_version = $5,
                signature = $6,
                key_id = $7,
                signature_scheme = 'plugin-v2',
                security_reviewed_by = submitted_by,
                security_reviewed_at = NOW(),
                security_review_state = 'security_approved',
                functional_verify_state = 'verified',
                functional_verified_by = submitted_by,
                functional_verified_at = NOW(),
                status = 'approved',
                reviewed_by = submitted_by,
                reviewed_at = NOW(),
                review_note = 'platform-official Plugin seed',
                review_source = 'platform'
          WHERE id = $1 AND status = 'pending' AND security_review_state = 'draft'
            AND artifact_hash = $8`,
        [
          version.id,
          JSON.stringify(compiled.execContract),
          Buffer.from(compiled.execContractHash, 'hex'),
          RUNTIME_PLUGIN_COMPILER_VERSION,
          CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION,
          Buffer.from(signature.signature, 'hex'),
          signature.keyId,
          version.artifactHash,
        ],
      )
      if (updated.rowCount !== 1)
        throw new ConnectorSpecError('CAS_CONFLICT', 'official Plugin changed during approval')
    }

    const listingUpdate = await client.query(
      `UPDATE marketplace_skill_listings
          SET current_approved_version_id = CASE WHEN $3::boolean THEN $2
                                                 ELSE current_approved_version_id END,
              state = CASE WHEN $3::boolean AND state = 'unlisted'
                           THEN 'active' ELSE state END,
              revoked_reason = CASE WHEN $3::boolean AND state = 'unlisted'
                                    THEN NULL ELSE revoked_reason END,
              updated_at = NOW()
        WHERE slug = $1 AND state <> 'revoked'`,
      [listing.slug, version.id, input.activateListing !== false],
    )
    if (listingUpdate.rowCount !== 1)
      throw new ConnectorSpecError('EXEC_REVOKED', 'official Plugin listing is revoked')
    return compiled
  }, pool)
}

interface StoredRuntimePluginRow {
  id: string
  slug: string
  version: string
  kind: string
  plugin_type: string | null
  listing_state: string
  version_status: string
  artifact_hash: string
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
  signature_scheme: string | null
}

interface VerifiedRuntimePluginContractBase {
  slug: string
  versionId: number
  artifactHash: string
  execContractHash: string
}

export type VerifiedRuntimePluginContract =
  | (VerifiedRuntimePluginContractBase & {
      pluginType: 'sandboxed-local'
      contract: SandboxedLocalPluginContractV1
      compiled: Extract<CompiledRuntimePluginArtifact, { pluginType: 'sandboxed-local' }>
    })
  | (VerifiedRuntimePluginContractBase & {
      pluginType: 'managed-browser'
      contract: ManagedBrowserPluginContractV1
      compiled: Extract<CompiledRuntimePluginArtifact, { pluginType: 'managed-browser' }>
    })

async function readStoredRuntimeRows(
  versionIds: readonly number[],
  runner: QueryRunner,
): Promise<StoredRuntimePluginRow[]> {
  if (versionIds.length === 0) return []
  const rows = await runner.query<StoredRuntimePluginRow>(
    `SELECT v.id::text, v.slug, v.version, l.kind, l.plugin_type,
            l.state AS listing_state, v.status AS version_status,
            v.artifact_hash, v.raw_artifact, v.security_review_state,
            v.functional_verify_state, v.exec_revoked_at, v.exec_contract,
            v.exec_contract_hash, v.compiler_version, v.security_policy_version,
            v.signature, v.key_id, v.signature_scheme
      FROM marketplace_skill_versions v
      JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.id = ANY($1::bigint[])
        AND octet_length(v.raw_artifact) <= $2`,
    [versionIds, RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES],
  )
  return rows.rows
}

function verifyStoredRuntimeRow(
  row: StoredRuntimePluginRow,
  policyFloor: number,
  env: NodeJS.ProcessEnv,
  allowUnlisted = false,
): VerifiedRuntimePluginContract {
  const pluginType = row.plugin_type
  if (
    row.kind !== 'connector' ||
    (pluginType !== 'sandboxed-local' && pluginType !== 'managed-browser')
  )
    throw new ConnectorSpecError('WRONG_ARTIFACT_KIND', 'version is not a runtime Plugin')
  if (
    (row.listing_state !== 'active' && !(allowUnlisted && row.listing_state === 'unlisted')) ||
    row.version_status !== 'approved' ||
    row.security_review_state !== 'security_approved'
  )
    throw new ConnectorSpecError('NOT_SECURITY_APPROVED', 'runtime Plugin is not executable')
  if (row.functional_verify_state !== 'verified')
    throw new ConnectorSpecError('NOT_FUNCTIONALLY_VERIFIED', 'live verification is required')
  if (row.exec_revoked_at !== null)
    throw new ConnectorSpecError('EXEC_REVOKED', 'runtime Plugin is revoked')
  if (
    row.exec_contract == null ||
    row.exec_contract_hash == null ||
    row.compiler_version == null ||
    row.security_policy_version == null ||
    row.signature == null ||
    row.key_id == null ||
    row.signature_scheme == null
  )
    throw new ConnectorSpecError('CONTRACT_MISSING', 'runtime Plugin trust columns are incomplete')
  if (row.compiler_version !== RUNTIME_PLUGIN_COMPILER_VERSION)
    throw new ConnectorSpecError('POLICY_STALE', 'runtime Plugin compiler version is stale')
  if (row.security_policy_version < policyFloor)
    throw new ConnectorSpecError('POLICY_STALE', 'runtime Plugin security policy is stale')
  if (row.signature_scheme !== 'plugin-v2')
    throw new ConnectorSpecError('SIGNATURE_INVALID', 'runtime Plugin requires plugin-v2')

  const compiled = parseAndCompileRuntimeArtifact(
    row.raw_artifact,
    row.artifact_hash,
    row.artifact_hash,
    row.slug,
    row.version,
  )
  if (compiled.pluginType !== pluginType)
    throw new ConnectorSpecError('WRONG_ARTIFACT_KIND', 'runtime Plugin subtype drift')
  const storedHash = Buffer.from(row.exec_contract_hash).toString('hex')
  if (
    storedHash !== compiled.execContractHash ||
    canonicalSha256Hex(row.exec_contract) !== storedHash ||
    canonicalSha256Hex(row.exec_contract) !== canonicalSha256Hex(compiled.execContract)
  )
    throw new ConnectorSpecError('HASH_MISMATCH', 'runtime Plugin contract hash mismatch')
  const versionId = safeVersionId(row.id)
  if (
    !verifyPluginContractV2(
      {
        listingSlug: row.slug,
        versionId,
        kind: row.kind,
        pluginType,
        specHash: compiled.artifactHash,
        execContractHash: compiled.execContractHash,
        compilerVersion: row.compiler_version,
        policyVersion: row.security_policy_version,
      },
      Buffer.from(row.signature).toString('hex'),
      row.key_id,
      env,
    )
  )
    throw new ConnectorSpecError('SIGNATURE_INVALID', 'runtime Plugin signature is invalid')
  const common: VerifiedRuntimePluginContractBase = {
    slug: row.slug,
    versionId,
    artifactHash: compiled.artifactHash,
    execContractHash: compiled.execContractHash,
  }
  if (compiled.pluginType === 'sandboxed-local')
    return {
      ...common,
      pluginType: 'sandboxed-local',
      contract: compiled.execContract,
      compiled,
    }
  return {
    ...common,
    pluginType: 'managed-browser',
    contract: compiled.execContract,
    compiled,
  }
}

export async function loadVerifiedRuntimePluginContract(
  versionId: number,
  runner: QueryRunner,
  opts: { minPolicyVersion?: number; env?: NodeJS.ProcessEnv; allowUnlisted?: boolean } = {},
): Promise<VerifiedRuntimePluginContract> {
  safeVersionId(versionId)
  if (
    opts.minPolicyVersion !== undefined &&
    (!Number.isSafeInteger(opts.minPolicyVersion) || opts.minPolicyVersion < 0)
  )
    throw new ConnectorSpecError('POLICY_STALE', 'runtime Plugin policy floor is invalid')
  const row = (await readStoredRuntimeRows([versionId], runner))[0]
  if (!row) throw new ConnectorSpecError('VERSION_NOT_FOUND', 'runtime Plugin version not found')
  return verifyStoredRuntimeRow(
    row,
    Math.max(CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION, opts.minPolicyVersion ?? 0),
    opts.env ?? process.env,
    opts.allowUnlisted === true,
  )
}

export async function listVerifiedRuntimePluginContracts(
  versionIds: readonly number[],
  runner: QueryRunner,
  opts: { minPolicyVersion?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Map<number, VerifiedRuntimePluginContract>> {
  if (versionIds.some((versionId) => !Number.isSafeInteger(versionId) || versionId <= 0))
    throw new ConnectorSpecError('VERSION_NOT_FOUND', 'runtime Plugin version id is invalid')
  if (
    opts.minPolicyVersion !== undefined &&
    (!Number.isSafeInteger(opts.minPolicyVersion) || opts.minPolicyVersion < 0)
  )
    throw new ConnectorSpecError('POLICY_STALE', 'runtime Plugin policy floor is invalid')
  const rows = await readStoredRuntimeRows(versionIds, runner)
  const floor = Math.max(CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION, opts.minPolicyVersion ?? 0)
  const env = opts.env ?? process.env
  const out = new Map<number, VerifiedRuntimePluginContract>()
  for (const row of rows) {
    try {
      const verified = verifyStoredRuntimeRow(row, floor, env)
      out.set(verified.versionId, verified)
    } catch (error) {
      if (!(error instanceof ConnectorSpecError)) throw error
    }
  }
  return out
}
