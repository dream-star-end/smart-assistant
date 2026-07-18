/** Lossless, reversible version transition for a platform-owned browser Plugin. */

import type { Pool, PoolClient } from 'pg'

import { getPool } from '../db/index.js'
import { tx } from '../db/queries.js'
import {
  lockMarketplaceListing,
  lockMarketplaceUserSlug,
  lockMarketplaceVersion,
} from '../marketplace/locking.js'
import {
  type PluginAccountLease,
  PluginAccountLeaseError,
  type PluginLeaseRedis,
  acquirePluginAccountLease,
} from './accountLease.js'
import {
  type PluginAccountRow,
  migrateManagedBrowserPluginAccountVersionFenced,
} from './accounts.js'
import { loadVerifiedRuntimePluginContract } from './review.js'

const TRANSITION_DEADLINE_MS = 120_000
const LEASE_HARD_TIMEOUT_MS = 120_000
const RETRY_DELAY_MS = 250
export const OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON =
  'openclaude:official-managed-browser-transition-gate:v1'

class CensusChangedError extends Error {}

interface InstallCensusRow {
  id: string
  user_id: number
  version_id: string
  artifact_hash: string
  agent_ids: unknown
}

interface TransitionCensus {
  currentVersionId: string | null
  installs: InstallCensusRow[]
  accounts: PluginAccountRow[]
}

export interface OfficialManagedBrowserTransitionScope {
  currentVersionId: string | null
  installs: ReadonlyArray<{
    id: string
    userId: number
    versionId: string
    artifactHash: string
    agentIds: unknown
  }>
  accounts: ReadonlyArray<{
    id: string
    userId: number
    versionId: string
    revision: number
    secretGeneration: string
    status: string
    specHash: string
    execContractHash: string
    authContractVersion: number
  }>
}

export type OfficialManagedBrowserTransitionCensus = OfficialManagedBrowserTransitionScope

const TRANSITION_ACCOUNT_COLUMNS = `c.id::text AS id, c.user_id::int AS user_id,
  c.provider, c.display_name, c.account_key, c.aad_seed::text AS aad_seed,
  c.secret_enc, c.secret_nonce, c.revision,
  c.secret_generation::text AS secret_generation,
  c.connector_version_id::text AS connector_version_id, c.spec_hash,
  c.exec_contract_hash, c.auth_contract_version,
  c.plugin_write_enabled, c.plugin_write_disclaimer_version,
  c.plugin_write_disclaimer_accepted_at, c.plugin_write_preapproval_enabled,
  c.plugin_write_preapproval_disclaimer_version,
  c.plugin_write_preapproval_accepted_at, c.status, c.meta, c.revoked_at`

async function readCensus(
  runner: Pool | PoolClient,
  slug: string,
  lockRows: boolean,
): Promise<TransitionCensus> {
  const listing = await runner.query<{ current_version_id: string | null }>(
    `SELECT current_approved_version_id::text AS current_version_id
       FROM marketplace_skill_listings WHERE slug = $1`,
    [slug],
  )
  const suffix = lockRows ? ' FOR UPDATE OF i' : ''
  const installs = await runner.query<InstallCensusRow>(
    `SELECT i.id::text, i.user_id::int, i.version_id::text,
            i.artifact_hash, i.agent_ids
       FROM marketplace_installs i
      WHERE i.slug = $1 AND i.uninstalled_at IS NULL
      ORDER BY i.user_id, i.id${suffix}`,
    [slug],
  )
  const accountSuffix = lockRows ? ' FOR UPDATE OF c' : ''
  // Orphan accounts deliberately remain untouched and visible for unlink. Only
  // an account backed by an active install participates in the version cutover.
  const accounts = await runner.query<PluginAccountRow>(
    `SELECT ${TRANSITION_ACCOUNT_COLUMNS}
       FROM connections c
       JOIN marketplace_installs i
         ON i.user_id = c.user_id AND i.slug = c.provider
        AND i.uninstalled_at IS NULL
      WHERE c.provider = $1 AND c.revoked_at IS NULL
      ORDER BY c.user_id, c.id${accountSuffix}`,
    [slug],
  )
  return {
    currentVersionId: listing.rows[0]?.current_version_id ?? null,
    installs: installs.rows,
    accounts: accounts.rows,
  }
}

function publicCensus(census: TransitionCensus): OfficialManagedBrowserTransitionCensus {
  return {
    currentVersionId: census.currentVersionId,
    installs: census.installs.map((row) => ({
      id: row.id,
      userId: row.user_id,
      versionId: row.version_id,
      artifactHash: row.artifact_hash,
      agentIds: row.agent_ids,
    })),
    accounts: census.accounts.map((row) => ({
      id: row.id,
      userId: row.user_id,
      versionId: row.connector_version_id,
      revision: row.revision,
      secretGeneration: row.secret_generation,
      status: row.status,
      specHash: row.spec_hash.toString('hex'),
      execContractHash: row.exec_contract_hash.toString('hex'),
      authContractVersion: row.auth_contract_version,
    })),
  }
}

function scopeFingerprint(scope: OfficialManagedBrowserTransitionScope): string {
  return JSON.stringify(scope)
}

function assertExpectedScope(
  census: TransitionCensus,
  expectedFingerprint: string,
): void {
  if (scopeFingerprint(publicCensus(census)) !== expectedFingerprint)
    throw new Error('official managed-browser Plugin transition scope changed')
}

/** Non-secret deploy census used to pin an explicitly verified upgrade scope. */
export async function readOfficialManagedBrowserTransitionCensus(
  slug: string,
  pool: Pool = getPool(),
): Promise<OfficialManagedBrowserTransitionCensus> {
  const census = await readCensus(pool, slug, false)
  return publicCensus(census)
}

function censusFingerprint(census: TransitionCensus): string {
  return scopeFingerprint(publicCensus(census))
}

async function acquireAllAccountLeases(
  redis: PluginLeaseRedis | null | undefined,
  accountIds: readonly string[],
): Promise<PluginAccountLease[]> {
  if (accountIds.length > 0 && !redis)
    throw new PluginAccountLeaseError(
      'LEASE_UNAVAILABLE',
      'Plugin account transition requires the shared Redis lease backend',
    )
  const leases: PluginAccountLease[] = []
  try {
    for (const accountId of accountIds)
      leases.push(
        await acquirePluginAccountLease(redis, accountId, {
          hardTimeoutMs: LEASE_HARD_TIMEOUT_MS,
        }),
      )
    return leases
  } catch (error) {
    await Promise.all([...leases].reverse().map((lease) => lease.release()))
    throw error
  }
}

async function releaseAll(leases: PluginAccountLease[]): Promise<void> {
  await Promise.all([...leases].reverse().map((lease) => lease.release()))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface OfficialManagedBrowserTransitionResult {
  previousVersionId: string | null
  targetVersionId: string
  migratedInstalls: number
  migratedAccounts: number
}

async function setOfficialManagedBrowserListingGate(input: {
  slug: string
  open: boolean
  expectedVersionId?: string
  expectedArtifactHash?: string
  expectedExecContractHash?: string
  env?: NodeJS.ProcessEnv
  pool?: Pool
}): Promise<{ changed: boolean; currentVersionId: string | null }> {
  const pool = input.pool ?? getPool()
  return tx(async (client) => {
    const located = await client.query<{ version_id: string | null }>(
      `SELECT current_approved_version_id::text AS version_id
         FROM marketplace_skill_listings WHERE slug = $1`,
      [input.slug],
    )
    const versionId = located.rows[0]?.version_id ?? null
    // First publication has no listing/current version and therefore no old
    // executable surface to gate before source activation.
    if (versionId === null) return { changed: false, currentVersionId: null }
    const version = await lockMarketplaceVersion(client, versionId)
    const listing = await lockMarketplaceListing(client, input.slug)
    const gate = await client.query<{ revoked_reason: string | null }>(
      'SELECT revoked_reason FROM marketplace_skill_listings WHERE slug = $1',
      [input.slug],
    )
    const gateReason = gate.rows[0]?.revoked_reason ?? null
    if (
      !version ||
      !listing ||
      listing.currentApprovedVersionId !== versionId ||
      listing.kind !== 'connector' ||
      listing.pluginType !== 'managed-browser' ||
      !['active', 'unlisted'].includes(listing.state) ||
      version.slug !== input.slug ||
      version.status !== 'approved' ||
      version.reviewSource !== 'platform' ||
      version.submittedBy !== listing.ownerUserId ||
      version.securityReviewState !== 'security_approved' ||
      version.functionalVerifyState !== 'verified' ||
      version.execRevokedAt !== null
    )
      throw new Error('official managed-browser Plugin gate trust mismatch')
    if (
      (input.expectedVersionId && versionId !== input.expectedVersionId) ||
      (input.expectedArtifactHash && version.artifactHash !== input.expectedArtifactHash) ||
      (input.expectedExecContractHash &&
        version.execContractHash?.toString('hex') !== input.expectedExecContractHash)
    )
      throw new Error('official managed-browser Plugin gate target mismatch')
    const verified = await loadVerifiedRuntimePluginContract(Number(versionId), client, {
      env: input.env,
      allowUnlisted: true,
    })
    if (
      verified.pluginType !== 'managed-browser' ||
      verified.slug !== input.slug ||
      verified.artifactHash !== version.artifactHash ||
      verified.execContractHash !== version.execContractHash?.toString('hex')
    )
      throw new Error('official managed-browser Plugin gate signature mismatch')
    if (input.open) {
      if (
        listing.state !== 'unlisted' ||
        gateReason !== OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON
      )
        throw new Error('official managed-browser Plugin gate was not closed by deploy')
    } else if (listing.state === 'unlisted') {
      if (gateReason !== OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON)
        throw new Error('official managed-browser Plugin is independently unlisted')
      return { changed: false, currentVersionId: versionId }
    } else if (listing.state !== 'active' || gateReason !== null) {
      throw new Error('official managed-browser Plugin gate cannot be closed from this state')
    }
    const desired = input.open ? 'active' : 'unlisted'
    const changed = await client.query(
      `UPDATE marketplace_skill_listings
          SET state = $2, revoked_reason = $3, updated_at = NOW()
        WHERE slug = $1 AND state = $4
          AND revoked_reason IS NOT DISTINCT FROM $5::text
          AND current_approved_version_id = $6`,
      [
        input.slug,
        desired,
        input.open ? null : OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
        listing.state,
        gateReason,
        versionId,
      ],
    )
    if (changed.rowCount !== 1) throw new CensusChangedError('Plugin gate CAS failed')
    return { changed: true, currentVersionId: versionId }
  }, pool)
}

export async function closeOfficialManagedBrowserPluginListingGate(input: {
  slug: string
  env?: NodeJS.ProcessEnv
  pool?: Pool
}): Promise<{ changed: boolean; currentVersionId: string | null }> {
  return setOfficialManagedBrowserListingGate({ ...input, open: false })
}

export async function openOfficialManagedBrowserPluginListingGate(input: {
  slug: string
  expectedVersionId: string
  expectedArtifactHash: string
  expectedExecContractHash: string
  env?: NodeJS.ProcessEnv
  pool?: Pool
}): Promise<{ changed: boolean; currentVersionId: string | null }> {
  return setOfficialManagedBrowserListingGate({ ...input, open: true })
}

/**
 * Atomically moves the listing, active installs and their encrypted accounts.
 * All account leases remain held through COMMIT. The normalized Agent bindings
 * and install agent_ids cache need no rewrite because slug/kind/scope do not
 * change; the install row is updated in place and its projection is asserted by
 * the exact pre/post census tests.
 */
export async function transitionOfficialManagedBrowserPluginVersion(input: {
  slug: string
  targetVersionId: string
  expectedArtifactHash: string
  expectedExecContractHash: string
  ownerUserId: number
  env?: NodeJS.ProcessEnv
  pool?: Pool
  redis?: PluginLeaseRedis | null
  /** Exact deploy-verified active install/account rows; checked before and inside every retry. */
  expectedScope?: OfficialManagedBrowserTransitionScope
  /** Keep the global Plugin gate closed while a different source is activated. */
  openListingAtCommit?: boolean
  failureInjector?: (
    point: 'after-locked-census' | 'after-accounts' | 'after-installs',
  ) => void | Promise<void>
}): Promise<OfficialManagedBrowserTransitionResult> {
  const pool = input.pool ?? getPool()
  const expectedScopeFingerprint = input.expectedScope
    ? scopeFingerprint(input.expectedScope)
    : null
  const deadline = Date.now() + TRANSITION_DEADLINE_MS
  for (;;) {
    const discovered = await readCensus(pool, input.slug, false)
    if (expectedScopeFingerprint) assertExpectedScope(discovered, expectedScopeFingerprint)
    let leases: PluginAccountLease[] = []
    try {
      leases = await acquireAllAccountLeases(
        input.redis,
        discovered.accounts.map((row) => row.id),
      )
    } catch (error) {
      if (
        error instanceof PluginAccountLeaseError &&
        error.code === 'LEASE_BUSY' &&
        Date.now() + RETRY_DELAY_MS < deadline
      ) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      throw error
    }

    let client: PoolClient | null = null
    let began = false
    try {
      client = await pool.connect()
      await client.query('BEGIN')
      began = true
      // Version-only pin movement must not invoke 0152's legacy projection
      // trigger. Normalized bindings and agent_ids are intentionally preserved.
      await client.query("SELECT set_config('openclaude.capability_writer', 'normalized', true)")
      // Repository-wide mutation order is advisory user+slug before
      // version→listing→install/connection row locks. Unknown concurrent users
      // either commit before the final census (forcing retry) or observe the new
      // current version and fail their stale mutation after this transaction.
      const userIds = [...new Set(discovered.installs.map((row) => row.user_id))].sort(
        (a, b) => a - b,
      )
      for (const userId of userIds) await lockMarketplaceUserSlug(client, userId, input.slug)
      const versionIds = [
        input.targetVersionId,
        ...(discovered.currentVersionId ? [discovered.currentVersionId] : []),
        ...discovered.installs.map((row) => row.version_id),
        ...discovered.accounts.map((row) => row.connector_version_id),
      ]
        .filter((id, index, all) => all.indexOf(id) === index)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
      const lockedVersions = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof lockMarketplaceVersion>>>
      >()
      for (const versionId of versionIds) {
        const version = await lockMarketplaceVersion(client, versionId)
        if (version) lockedVersions.set(version.id, version)
      }
      const listing = await lockMarketplaceListing(client, input.slug)
      const gate = await client.query<{ revoked_reason: string | null }>(
        'SELECT revoked_reason FROM marketplace_skill_listings WHERE slug = $1',
        [input.slug],
      )
      const gateReason = gate.rows[0]?.revoked_reason ?? null
      const firstPublication = discovered.currentVersionId === null
      if (
        !listing ||
        listing.kind !== 'connector' ||
        listing.pluginType !== 'managed-browser' ||
        listing.ownerUserId !== String(input.ownerUserId) ||
        (firstPublication
          ? listing.state !== 'active' ||
            gateReason !== null ||
            discovered.installs.length !== 0 ||
            discovered.accounts.length !== 0
          : listing.state !== 'unlisted' ||
            gateReason !== OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON)
      )
        throw new Error('official managed-browser Plugin listing trust mismatch')
      const target = lockedVersions.get(input.targetVersionId)
      if (
        !target ||
        target.slug !== input.slug ||
        target.status !== 'approved' ||
        target.reviewSource !== 'platform' ||
        target.submittedBy !== String(input.ownerUserId) ||
        target.artifactHash !== input.expectedArtifactHash ||
        target.execContractHash?.toString('hex') !== input.expectedExecContractHash ||
        target.securityReviewState !== 'security_approved' ||
        target.functionalVerifyState !== 'verified' ||
        target.execRevokedAt !== null
      )
        throw new Error('official managed-browser Plugin target trust mismatch')

      const locked = await readCensus(client, input.slug, true)
      if (censusFingerprint(locked) !== censusFingerprint(discovered))
        throw new CensusChangedError('Plugin transition census changed')
      if (expectedScopeFingerprint) assertExpectedScope(locked, expectedScopeFingerprint)
      await input.failureInjector?.('after-locked-census')
      const targetVerified = await loadVerifiedRuntimePluginContract(
        Number(input.targetVersionId),
        client,
        { env: input.env, allowUnlisted: true },
      )
      if (
        targetVerified.pluginType !== 'managed-browser' ||
        targetVerified.slug !== input.slug ||
        targetVerified.artifactHash !== input.expectedArtifactHash ||
        targetVerified.execContractHash !== input.expectedExecContractHash
      )
        throw new Error('official managed-browser Plugin target signature mismatch')

      let migratedAccounts = 0
      const verifiedByVersion = new Map<
        number,
        Awaited<ReturnType<typeof loadVerifiedRuntimePluginContract>>
      >()
      for (const row of locked.accounts) {
        if (row.connector_version_id === input.targetVersionId) continue
        const versionId = Number(row.connector_version_id)
        const sourceVersion = lockedVersions.get(row.connector_version_id)
        if (
          !sourceVersion ||
          sourceVersion.slug !== input.slug ||
          sourceVersion.status !== 'approved' ||
          sourceVersion.reviewSource !== 'platform' ||
          sourceVersion.submittedBy !== String(input.ownerUserId) ||
          sourceVersion.securityReviewState !== 'security_approved' ||
          sourceVersion.functionalVerifyState !== 'verified' ||
          sourceVersion.execRevokedAt !== null
        )
          throw new Error('official managed-browser Plugin source trust mismatch')
        let from = verifiedByVersion.get(versionId)
        if (!from) {
          from = await loadVerifiedRuntimePluginContract(versionId, client, {
            env: input.env,
            allowUnlisted: true,
          })
          verifiedByVersion.set(versionId, from)
        }
        await migrateManagedBrowserPluginAccountVersionFenced({
          row,
          from,
          to: targetVerified,
          runner: client,
          env: input.env,
        })
        migratedAccounts++
      }
      await input.failureInjector?.('after-accounts')

      const installIds = locked.installs
        .filter((row) => row.version_id !== input.targetVersionId)
        .map((row) => row.id)
      if (installIds.length > 0) {
        const changed = await client.query(
          `UPDATE marketplace_installs
              SET version_id = $2, artifact_hash = $3
            WHERE id = ANY($1::bigint[]) AND slug = $4 AND uninstalled_at IS NULL`,
          [installIds, input.targetVersionId, input.expectedArtifactHash, input.slug],
        )
        if (changed.rowCount !== installIds.length)
          throw new CensusChangedError('Plugin install transition CAS failed')
      }
      await input.failureInjector?.('after-installs')
      const switched = await client.query(
        `UPDATE marketplace_skill_listings
            SET current_approved_version_id = $2,
                state = CASE WHEN $4::boolean THEN 'active' ELSE 'unlisted' END,
                revoked_reason = CASE WHEN $4::boolean THEN NULL ELSE $5 END,
                updated_at = NOW()
          WHERE slug = $1 AND state = $6
            AND revoked_reason IS NOT DISTINCT FROM $7::text
            AND current_approved_version_id IS NOT DISTINCT FROM $3::bigint`,
        [
          input.slug,
          input.targetVersionId,
          discovered.currentVersionId,
          input.openListingAtCommit !== false,
          OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
          listing.state,
          gateReason,
        ],
      )
      if (switched.rowCount !== 1)
        throw new CensusChangedError('Plugin listing transition CAS failed')
      await Promise.all(leases.map((lease) => lease.assertHeld()))
      await client.query('COMMIT')
      began = false
      return {
        previousVersionId: discovered.currentVersionId,
        targetVersionId: input.targetVersionId,
        migratedInstalls: installIds.length,
        migratedAccounts,
      }
    } catch (error) {
      if (began && client) await client.query('ROLLBACK').catch(() => {})
      if (error instanceof CensusChangedError && Date.now() + RETRY_DELAY_MS < deadline) {
        await releaseAll(leases)
        leases = []
        await sleep(RETRY_DELAY_MS)
        continue
      }
      throw error
    } finally {
      client?.release()
      await releaseAll(leases)
    }
  }
}
