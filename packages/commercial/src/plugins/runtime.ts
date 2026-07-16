import type { Pool } from 'pg'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { getPool } from '../db/index.js'
import { type PluginLeaseRedis, acquirePluginAccountLease } from './accountLease.js'
import {
  PluginAccountError,
  assertRuntimePluginInstallEntitlement,
  commitPluginAccountState,
  decryptPluginAccountEnvelope,
  fencePluginAccountInvocation,
  getPluginAccount,
} from './accounts.js'
import { ManagedBrowserRuntime } from './browserRuntime.js'
import type { VerifiedLocalPluginRuntime } from './localRuntime.js'
import { listVerifiedRuntimePluginContracts, loadVerifiedRuntimePluginContract } from './review.js'

export class PluginRuntimeFacadeError extends Error {
  readonly code: 'TARGET_NOT_FOUND' | 'RUNTIME_UNAVAILABLE' | 'BAD_REQUEST' | 'TARGET_STALE'

  constructor(code: PluginRuntimeFacadeError['code'], message: string = code) {
    super(message)
    this.name = 'PluginRuntimeFacadeError'
    this.code = code
  }
}

export interface RuntimePluginCatalogEntry {
  versionId: string
  slug: string
  pluginType: 'sandboxed-local' | 'managed-browser'
  label: string
  description: string
  accountMode: 'none' | 'required'
  actions: Array<{ id: string; description: string; readOnly: true }>
}

export interface RuntimePluginTargetEntry {
  id: string
  provider: string
  pluginType: 'sandboxed-local' | 'managed-browser'
  displayName: string
  accountHint: string
  status: 'active'
  actions: Array<{ id: string; description: string; readOnly: true }>
}

interface CatalogRow {
  id: string
  slug: string
  name: string
  description: string
  plugin_type: 'sandboxed-local' | 'managed-browser'
}

function isSafeDbId(value: string): boolean {
  if (!/^\d{1,16}$/.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0
}

export class PluginRuntimeFacade {
  private readonly pool: Pool
  private readonly browser: ManagedBrowserRuntime

  constructor(
    private readonly opts: {
      pool?: Pool
      redis?: PluginLeaseRedis | null
      browserRuntime?: ManagedBrowserRuntime
      localRuntime?: VerifiedLocalPluginRuntime
      profileRoot?: string
      resolver?: DnsResolver
      env?: NodeJS.ProcessEnv
    } = {},
  ) {
    this.pool = opts.pool ?? getPool()
    this.browser =
      opts.browserRuntime ??
      new ManagedBrowserRuntime({
        profileRoot: opts.profileRoot ?? '/var/lib/openclaude-v5/plugin-browser-profiles',
        expectedOwnerUid: 0,
        ...(opts.resolver ? { resolver: opts.resolver } : {}),
      })
  }

  async classifyTarget(
    userId: number,
    targetId: string,
  ): Promise<'sandboxed-local' | 'managed-browser' | null> {
    const local = /^plugin:(\d{1,16})$/.exec(targetId)
    if (local) {
      if (!isSafeDbId(local[1]!)) return null
      const entitled = await this.pool.query<{ version_id: string }>(
        `SELECT v.id::text AS version_id
           FROM marketplace_installs i
           JOIN marketplace_skill_versions v
             ON v.id = i.version_id AND i.artifact_hash = v.artifact_hash
           JOIN marketplace_skill_listings l ON l.slug = i.slug AND l.slug = v.slug
          WHERE i.user_id = $1 AND i.version_id = $2::bigint
            AND i.uninstalled_at IS NULL
            AND l.kind = 'connector' AND l.plugin_type = 'sandboxed-local'
            AND l.state = 'active' AND l.current_approved_version_id = v.id
            AND v.status = 'approved' AND v.security_review_state = 'security_approved'
            AND v.functional_verify_state = 'verified'
            AND v.signature_scheme = 'plugin-v2' AND v.exec_revoked_at IS NULL
          LIMIT 1`,
        [userId, local[1]],
      )
      if (entitled.rowCount !== 1) return null
      try {
        const verified = await loadVerifiedRuntimePluginContract(
          Number(entitled.rows[0]!.version_id),
          this.pool,
          { env: this.opts.env },
        )
        if (verified.pluginType !== 'sandboxed-local') return null
        await assertRuntimePluginInstallEntitlement(userId, verified, this.pool, {
          requireCurrent: true,
        })
        return 'sandboxed-local'
      } catch (error) {
        if (error instanceof ConnectorSpecError || error instanceof PluginAccountError) return null
        throw error
      }
    }
    if (!isSafeDbId(targetId)) return null
    const row = await this.pool.query<{
      version_id: string
      plugin_type: string
      account_artifact_hash: string
      account_exec_contract_hash: string
      auth_contract_version: number
    }>(
      `SELECT v.id::text AS version_id, l.plugin_type,
              encode(c.spec_hash, 'hex') AS account_artifact_hash,
              encode(c.exec_contract_hash, 'hex') AS account_exec_contract_hash,
              c.auth_contract_version
         FROM connections c
         JOIN marketplace_skill_versions v ON v.id = c.connector_version_id
         JOIN marketplace_skill_listings l ON l.slug = v.slug AND c.provider = v.slug
         JOIN marketplace_installs i
           ON i.user_id = c.user_id AND i.slug = v.slug
          AND i.version_id = v.id AND i.artifact_hash = v.artifact_hash
          AND i.uninstalled_at IS NULL
        WHERE c.id = $1::bigint AND c.user_id = $2 AND c.revoked_at IS NULL
          AND c.status = 'active'
          AND encode(c.spec_hash, 'hex') = v.artifact_hash
          AND c.exec_contract_hash = v.exec_contract_hash
          AND l.kind = 'connector' AND l.plugin_type = 'managed-browser'
          AND l.state = 'active' AND l.current_approved_version_id = v.id
          AND v.status = 'approved' AND v.security_review_state = 'security_approved'
          AND v.functional_verify_state = 'verified'
          AND v.signature_scheme = 'plugin-v2' AND v.exec_revoked_at IS NULL
        LIMIT 1`,
      [targetId, userId],
    )
    const candidate = row.rows[0]
    if (!candidate || candidate.plugin_type !== 'managed-browser') return null
    try {
      const verified = await loadVerifiedRuntimePluginContract(
        Number(candidate.version_id),
        this.pool,
        { env: this.opts.env },
      )
      if (
        verified.pluginType !== 'managed-browser' ||
        verified.artifactHash !== candidate.account_artifact_hash ||
        verified.execContractHash !== candidate.account_exec_contract_hash ||
        verified.contract.account.contractVersion !== candidate.auth_contract_version
      )
        return null
      return 'managed-browser'
    } catch (error) {
      if (error instanceof ConnectorSpecError || error instanceof PluginAccountError) return null
      throw error
    }
  }

  private async installedCurrentCatalog(userId: number, query?: string): Promise<CatalogRow[]> {
    const needle = query?.trim().slice(0, 128) ?? ''
    const rows = await this.pool.query<CatalogRow>(
      `SELECT v.id::text, v.slug, v.name, v.description, l.plugin_type
         FROM marketplace_installs i
         JOIN marketplace_skill_versions v ON v.id = i.version_id
         JOIN marketplace_skill_listings l ON l.slug = i.slug
        WHERE i.user_id = $1 AND i.uninstalled_at IS NULL
          AND i.artifact_hash = v.artifact_hash
          AND l.kind = 'connector'
          AND l.plugin_type IN ('sandboxed-local','managed-browser')
          AND l.state = 'active' AND v.status = 'approved'
          AND l.current_approved_version_id = v.id
          AND ($2::text = '' OR v.slug ILIKE '%' || $2 || '%'
               OR v.name ILIKE '%' || $2 || '%'
               OR v.description ILIKE '%' || $2 || '%')
        ORDER BY v.name ASC, v.id DESC
        LIMIT 100`,
      [userId, needle],
    )
    return rows.rows
  }

  async catalog(userId: number, query?: string): Promise<RuntimePluginCatalogEntry[]> {
    const rows = await this.installedCurrentCatalog(userId, query)
    const verified = await listVerifiedRuntimePluginContracts(
      rows.map((row) => Number(row.id)),
      this.pool,
      { env: this.opts.env },
    )
    const out: RuntimePluginCatalogEntry[] = []
    for (const row of rows) {
      const item = verified.get(Number(row.id))
      if (!item || item.pluginType !== row.plugin_type) continue
      out.push({
        versionId: row.id,
        slug: row.slug,
        pluginType: item.pluginType,
        label: row.name,
        description: row.description,
        accountMode: item.contract.account.mode,
        actions: item.contract.actions.map((action) => ({
          id: action.id,
          description: action.description,
          readOnly: true,
        })),
      })
    }
    return out
  }

  async list(userId: number): Promise<RuntimePluginTargetEntry[]> {
    const catalog = await this.catalog(userId)
    const localTargets: RuntimePluginTargetEntry[] = catalog
      .filter((item) => item.pluginType === 'sandboxed-local')
      .map((item) => ({
        id: `plugin:${item.versionId}`,
        provider: item.slug,
        pluginType: 'sandboxed-local',
        displayName: item.label,
        accountHint: '',
        status: 'active',
        actions: item.actions,
      }))
    const accounts = await this.pool.query<{
      id: string
      provider: string
      display_name: string
      connector_version_id: string
      meta: Record<string, unknown>
    }>(
      `SELECT c.id::text, c.provider, c.display_name,
              c.connector_version_id::text, c.meta
         FROM connections c
         JOIN marketplace_skill_versions v ON v.id = c.connector_version_id
         JOIN marketplace_skill_listings l ON l.slug = v.slug
         JOIN marketplace_installs i
           ON i.user_id = c.user_id AND i.slug = c.provider
          AND i.version_id = c.connector_version_id AND i.artifact_hash = v.artifact_hash
          AND i.uninstalled_at IS NULL
        WHERE c.user_id = $1 AND c.revoked_at IS NULL AND c.status = 'active'
          AND l.state = 'active' AND l.plugin_type = 'managed-browser'
          AND l.current_approved_version_id = v.id
        ORDER BY c.created_at DESC`,
      [userId],
    )
    const verified = await listVerifiedRuntimePluginContracts(
      accounts.rows.map((row) => Number(row.connector_version_id)),
      this.pool,
      { env: this.opts.env },
    )
    const managedTargets: RuntimePluginTargetEntry[] = []
    for (const row of accounts.rows) {
      const item = verified.get(Number(row.connector_version_id))
      if (!item || item.pluginType !== 'managed-browser') continue
      managedTargets.push({
        id: row.id,
        provider: row.provider,
        pluginType: 'managed-browser',
        displayName: row.display_name || row.provider,
        accountHint: typeof row.meta?.account_hint === 'string' ? row.meta.account_hint : '',
        status: 'active',
        actions: item.contract.actions.map((action) => ({
          id: action.id,
          description: action.description,
          readOnly: true,
        })),
      })
    }
    return [...managedTargets, ...localTargets]
  }

  async call(input: {
    userId: number
    targetId: string
    actionId: string
    params: Record<string, unknown>
  }): Promise<unknown> {
    const local = /^plugin:(\d{1,16})$/.exec(input.targetId)
    if (local) {
      if (!isSafeDbId(local[1]!))
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin target id is malformed')
      if (!this.opts.localRuntime)
        throw new PluginRuntimeFacadeError(
          'RUNTIME_UNAVAILABLE',
          'local Plugin runtime unavailable',
        )
      const verified = await loadVerifiedRuntimePluginContract(Number(local[1]), this.pool, {
        env: this.opts.env,
      })
      if (verified.pluginType !== 'sandboxed-local')
        throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND', 'Plugin target subtype mismatch')
      await assertRuntimePluginInstallEntitlement(input.userId, verified, this.pool, {
        requireCurrent: true,
      })
      const executed = await this.opts.localRuntime.runReadAction({
        verified,
        userId: input.userId,
        actionId: input.actionId,
        params: input.params,
      })
      const current = await loadVerifiedRuntimePluginContract(verified.versionId, this.pool, {
        env: this.opts.env,
      })
      if (
        current.pluginType !== 'sandboxed-local' ||
        current.artifactHash !== verified.artifactHash ||
        current.execContractHash !== verified.execContractHash
      )
        throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin contract changed during invoke')
      await assertRuntimePluginInstallEntitlement(input.userId, current, this.pool, {
        requireCurrent: true,
      })
      return executed.result
    }
    if (!isSafeDbId(input.targetId))
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin target id is malformed')
    const initialRow = await getPluginAccount(input.targetId, input.userId, this.pool)
    if (!initialRow)
      throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND', 'Plugin account not found')
    const initialVerified = await loadVerifiedRuntimePluginContract(
      Number(initialRow.connector_version_id),
      this.pool,
      { env: this.opts.env },
    )
    if (initialVerified.pluginType !== 'managed-browser')
      throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND', 'Plugin account subtype mismatch')
    const action = initialVerified.contract.actions.find((item) => item.id === input.actionId)
    if (!action) throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin action not found')

    const lease = await acquirePluginAccountLease(this.opts.redis, input.targetId, {
      hardTimeoutMs: action.timeoutSeconds * 1000,
    })
    try {
      // Re-load every trust byte after acquiring the cross-process account lease.
      const verified = await loadVerifiedRuntimePluginContract(
        Number(initialRow.connector_version_id),
        this.pool,
        { env: this.opts.env },
      )
      if (
        verified.pluginType !== 'managed-browser' ||
        verified.artifactHash !== initialVerified.artifactHash ||
        verified.execContractHash !== initialVerified.execContractHash
      )
        throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin contract changed before invoke')
      const fencedRow = await fencePluginAccountInvocation({
        connectionId: input.targetId,
        userId: input.userId,
        expectedRevision: initialRow.revision,
        verified,
        runner: this.pool,
      })
      const envelope = decryptPluginAccountEnvelope(fencedRow, verified.contract, this.opts.env)
      const executed = await this.browser.runReadAction({
        contract: verified.contract,
        storageState: envelope.storageState,
        actionId: input.actionId,
        params: input.params,
        signal: lease.signal,
      })

      // Browser/context/profile cleanup has completed at this point. Recheck kill switch and
      // exact install before the one final irreversible DB CAS.
      const current = await loadVerifiedRuntimePluginContract(verified.versionId, this.pool, {
        env: this.opts.env,
      })
      if (
        current.pluginType !== 'managed-browser' ||
        current.artifactHash !== verified.artifactHash ||
        current.execContractHash !== verified.execContractHash
      )
        throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin contract changed during invoke')
      await assertRuntimePluginInstallEntitlement(input.userId, current, this.pool, {
        requireCurrent: true,
      })
      await lease.assertHeld()
      await commitPluginAccountState({
        row: fencedRow,
        verified: current,
        envelope: { ...envelope, storageState: executed.storageState },
        runner: this.pool,
        env: this.opts.env,
      })
      // The DB CAS above is the success commit point. No fallible gate follows it.
      return executed.result
    } finally {
      await lease.release()
    }
  }
}
