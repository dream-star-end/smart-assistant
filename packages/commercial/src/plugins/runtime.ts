import type { Pool } from 'pg'
import { canonicalDigestHex } from '../connectors/canonicalJson.js'
import {
  type LedgerRow,
  type LedgerStatus,
  armPluginWriteDispatch,
  beginExecute,
  classifyForExecute,
  finalizeExecute,
  getLedgerRow,
  proposeWrite as proposeLedgerWrite,
} from '../connectors/ledger.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { buildWriteSummary } from '../connectors/service.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { getPool } from '../db/index.js'
import { tx } from '../db/queries.js'
import { type PluginLeaseRedis, acquirePluginAccountLease } from './accountLease.js'
import {
  PluginAccountError,
  type PluginAccountRow,
  assertRuntimePluginInstallEntitlement,
  commitPluginAccountState,
  decryptPluginAccountEnvelope,
  fencePluginAccountInvocation,
  getPluginAccount,
  markPluginAccountRelinkRequiredFenced,
  revokePluginAccountFenced,
} from './accounts.js'
import { ManagedBrowserRuntime } from './browserRuntime.js'
import { RuntimePluginContractError, validateRuntimePluginJson } from './contracts.js'
import { KNOWLEDGE_PLANET_PLUGIN_SLUG } from './knowledgePlanetContract.js'
import {
  type KnowledgePlanetMediaDeps,
  type KnowledgePlanetSealedMedia,
  sealKnowledgePlanetMedia,
  stageKnowledgePlanetMedia,
} from './knowledgePlanetMedia.js'
import type { VerifiedLocalPluginRuntime } from './localRuntime.js'
import {
  type VerifiedRuntimePluginContract,
  listVerifiedRuntimePluginContracts,
  loadVerifiedRuntimePluginContract,
} from './review.js'
import { WEIBO_PLUGIN_SLUG } from './weiboContract.js'
import { managedPluginWritePolicy, managedPluginWritePreapprovalPolicy } from './writePolicy.js'

export class PluginRuntimeFacadeError extends Error {
  readonly code:
    | 'TARGET_NOT_FOUND'
    | 'RUNTIME_UNAVAILABLE'
    | 'RUNTIME_BUSY'
    | 'RELINK_REQUIRED'
    | 'BAD_REQUEST'
    | 'TARGET_STALE'
    | 'WRITE_DISABLED'
    | 'WRITE_REQUIRES_CONFIRMATION'

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
  actions: Array<{ id: string; description: string; readOnly: boolean }>
}

export interface RuntimePluginWriteControl {
  available: boolean
  enabled: boolean
  disclaimerVersion: number
  acceptedVersion: number | null
  acceptedAt: string | null
  disclaimerText: string
  preapproval: {
    available: boolean
    enabled: boolean
    disclaimerVersion: number | null
    acceptedVersion: number | null
    acceptedAt: string | null
    disclaimerText: string | null
  }
}

export interface RuntimePluginManagementEntry extends RuntimePluginCatalogEntry {
  installed: boolean
  installedVersion: string
  latestVersionId: string | null
  latestVersion: string | null
  installedCurrent: boolean
  updateAvailable: boolean
  available: boolean
}

export interface RuntimePluginManagementAccount extends Omit<RuntimePluginTargetEntry, 'status'> {
  status: 'active' | 'error'
  versionId: string
  executable: boolean
  writeControl: RuntimePluginWriteControl | null
}

export interface RuntimePluginTargetEntry {
  id: string
  provider: string
  pluginType: 'sandboxed-local' | 'managed-browser'
  displayName: string
  accountHint: string
  status: 'active'
  actions: Array<{ id: string; description: string; readOnly: boolean }>
  /** Managed-browser write gate projected for the Agent CLI; omitted for local Plugins. */
  writeMode?: 'disabled' | 'confirm_each' | 'account_preapproval'
}

export type RuntimePluginWriteExecution =
  | { kind: 'result'; result: unknown }
  | { kind: 'in_progress' }
  | {
      kind: 'replay'
      status: LedgerStatus
      errorCode: string | null
      resultDigest: string | null
    }

export type KnowledgePlanetAutomationExecution =
  | { kind: 'result'; result: unknown }
  | { kind: 'deferred'; errorCode: 'AUTOMATION_DISPATCH_BUSY' }
  | { kind: 'not_dispatched'; errorCode: string }
  | { kind: 'failed'; errorCode: string }
  | { kind: 'unknown'; errorCode: string }

interface CatalogRow {
  id: string
  slug: string
  name: string
  description: string
  plugin_type: 'sandboxed-local' | 'managed-browser'
}

interface ManagementRow {
  installed: boolean
  installed_id: string
  installed_version: string
  installed_name: string
  installed_description: string
  installed_artifact_hash: string
  install_artifact_hash: string
  slug: string
  plugin_type: 'sandboxed-local' | 'managed-browser'
  listing_state: string
  latest_id: string | null
  latest_version: string | null
  latest_name: string | null
  latest_description: string | null
}

function isSafeDbId(value: string): boolean {
  if (!/^\d{1,16}$/.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0
}

function actionProjection(action: { id: string; description: string; effect: 'read' | 'write' }) {
  return {
    id: action.id,
    description: action.description,
    readOnly: action.effect === 'read',
  }
}

function writeControlFor(
  slug: string,
  actions: readonly { effect: 'read' | 'write' }[],
  row: {
    plugin_write_enabled: boolean
    plugin_write_disclaimer_version: number | null
    plugin_write_disclaimer_accepted_at: Date | null
    plugin_write_preapproval_enabled: boolean
    plugin_write_preapproval_disclaimer_version: number | null
    plugin_write_preapproval_accepted_at: Date | null
  },
): RuntimePluginWriteControl | null {
  if (!actions.some((action) => action.effect === 'write')) return null
  const policy = managedPluginWritePolicy(slug)
  if (!policy) return null
  const enabled =
    row.plugin_write_enabled === true &&
    row.plugin_write_disclaimer_version === policy.version &&
    row.plugin_write_disclaimer_accepted_at instanceof Date
  const preapprovalPolicy = managedPluginWritePreapprovalPolicy(slug)
  const preapprovalEnabled =
    enabled &&
    preapprovalPolicy !== null &&
    row.plugin_write_preapproval_enabled === true &&
    row.plugin_write_preapproval_disclaimer_version === preapprovalPolicy.version &&
    row.plugin_write_preapproval_accepted_at instanceof Date
  return {
    available: true,
    enabled,
    disclaimerVersion: policy.version,
    acceptedVersion: row.plugin_write_disclaimer_version,
    acceptedAt: row.plugin_write_disclaimer_accepted_at?.toISOString() ?? null,
    disclaimerText: policy.disclaimerText,
    preapproval: {
      available: preapprovalPolicy !== null,
      enabled: preapprovalEnabled,
      disclaimerVersion: preapprovalPolicy?.version ?? null,
      acceptedVersion: row.plugin_write_preapproval_disclaimer_version,
      acceptedAt: row.plugin_write_preapproval_accepted_at?.toISOString() ?? null,
      disclaimerText: preapprovalPolicy?.disclaimerText ?? null,
    },
  }
}

function ledgerReplay(row: LedgerRow): RuntimePluginWriteExecution {
  return {
    kind: 'replay',
    status: row.status,
    errorCode: row.error_code,
    resultDigest: row.result_digest,
  }
}

function stablePluginErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'INTERNAL'
}

interface KnowledgePlanetCommentPage {
  count: number
  sort: 'asc' | 'desc'
  beginTime?: string
  endTime?: string
}

function normalizeKnowledgePlanetCommentPage(value: unknown): KnowledgePlanetCommentPage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin comment lookup page is invalid')
  const raw = value as Record<string, unknown>
  const allowed = new Set(['count', 'sort', 'beginTime', 'endTime'])
  if (Object.keys(raw).some((key) => !allowed.has(key)))
    throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin comment lookup page is invalid')
  if (
    !Number.isInteger(raw.count) ||
    (raw.count as number) < 1 ||
    (raw.count as number) > 50 ||
    !['asc', 'desc'].includes(String(raw.sort)) ||
    (raw.beginTime !== undefined &&
      (typeof raw.beginTime !== 'string' || raw.beginTime.length > 80)) ||
    (raw.endTime !== undefined && (typeof raw.endTime !== 'string' || raw.endTime.length > 80))
  )
    throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin comment lookup page is invalid')
  return {
    count: raw.count as number,
    sort: raw.sort as 'asc' | 'desc',
    ...(typeof raw.beginTime === 'string' ? { beginTime: raw.beginTime } : {}),
    ...(typeof raw.endTime === 'string' ? { endTime: raw.endTime } : {}),
  }
}

function knowledgePlanetRemovalIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin media removal ids are invalid')
  return [...new Set(value)] as string[]
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
      knowledgePlanetMedia?: KnowledgePlanetMediaDeps
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

  private async loadManagedTarget(
    userId: number,
    targetId: string,
    opts: { includeError?: boolean } = {},
  ): Promise<{
    row: PluginAccountRow
    verified: Extract<VerifiedRuntimePluginContract, { pluginType: 'managed-browser' }>
  }> {
    if (!isSafeDbId(targetId))
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin account id is malformed')
    const row = await getPluginAccount(targetId, userId, this.pool, opts)
    if (!row) throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND', 'Plugin account not found')
    const verified = await loadVerifiedRuntimePluginContract(
      Number(row.connector_version_id),
      this.pool,
      { env: this.opts.env },
    )
    if (verified.pluginType !== 'managed-browser' || verified.slug !== row.provider)
      throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND', 'Plugin account subtype mismatch')
    if (!this.browser.supportsContract(verified.contract))
      throw new PluginRuntimeFacadeError(
        'RUNTIME_UNAVAILABLE',
        'managed-browser Plugin runtime unavailable',
      )
    await assertRuntimePluginInstallEntitlement(userId, verified, this.pool, {
      requireCurrent: true,
    })
    return { row, verified }
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
        verified.contract.account.contractVersion !== candidate.auth_contract_version ||
        !this.browser.supportsContract(verified.contract)
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
      if (item.pluginType === 'managed-browser' && !this.browser.supportsContract(item.contract))
        continue
      out.push({
        versionId: row.id,
        slug: row.slug,
        pluginType: item.pluginType,
        label: row.name,
        description: row.description,
        accountMode: item.contract.account.mode,
        actions: item.contract.actions.map(actionProjection),
      })
    }
    return out
  }

  /**
   * Browser management view. Unlike the executable Agent catalog, this keeps
   * stale/revoked installs and accounts visible so users can update, revoke or
   * uninstall them instead of losing the only recovery controls.
   */
  async management(userId: number): Promise<{
    catalog: RuntimePluginManagementEntry[]
    accounts: RuntimePluginManagementAccount[]
  }> {
    const rows = await this.pool.query<ManagementRow>(
      `WITH orphan_targets AS (
         SELECT DISTINCT ON (c.provider)
                c.provider AS slug, c.connector_version_id AS version_id,
                v.artifact_hash
           FROM connections c
           JOIN marketplace_skill_versions v ON v.id = c.connector_version_id
          WHERE c.user_id = $1 AND c.revoked_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM marketplace_installs i
               WHERE i.user_id = c.user_id AND i.slug = c.provider
                 AND i.uninstalled_at IS NULL
            )
          ORDER BY c.provider, c.created_at DESC, c.id DESC
       ), targets AS (
         SELECT i.slug, i.version_id, i.artifact_hash, TRUE AS installed
           FROM marketplace_installs i
          WHERE i.user_id = $1 AND i.uninstalled_at IS NULL
         UNION ALL
         SELECT slug, version_id, artifact_hash, FALSE AS installed
           FROM orphan_targets
       )
       SELECT t.installed, iv.id::text AS installed_id, iv.version AS installed_version,
              iv.name AS installed_name, iv.description AS installed_description,
              iv.artifact_hash AS installed_artifact_hash,
              t.artifact_hash AS install_artifact_hash,
              t.slug, l.plugin_type, l.state AS listing_state,
              cv.id::text AS latest_id, cv.version AS latest_version,
              cv.name AS latest_name, cv.description AS latest_description
         FROM targets t
         JOIN marketplace_skill_versions iv ON iv.id = t.version_id AND iv.slug = t.slug
         JOIN marketplace_skill_listings l ON l.slug = t.slug
         LEFT JOIN marketplace_skill_versions cv ON cv.id = l.current_approved_version_id
        WHERE l.kind = 'connector'
          AND l.plugin_type IN ('sandboxed-local','managed-browser')
        ORDER BY COALESCE(cv.name, iv.name) ASC, t.slug ASC
        LIMIT 100`,
      [userId],
    )
    const versionIds = [
      ...new Set(
        rows.rows
          .flatMap((row) => [row.installed_id, row.latest_id])
          .filter((id): id is string => id !== null && isSafeDbId(id))
          .map(Number),
      ),
    ]
    const verified = await listVerifiedRuntimePluginContracts(versionIds, this.pool, {
      env: this.opts.env,
    })
    const runtimeSupportedVersionIds = new Set(
      [...verified.values()]
        .filter(
          (item) =>
            item.pluginType !== 'managed-browser' || this.browser.supportsContract(item.contract),
        )
        .map((item) => String(item.versionId)),
    )
    const catalog: RuntimePluginManagementEntry[] = rows.rows.map((row) => {
      const installed = verified.get(Number(row.installed_id))
      const latest = row.latest_id ? verified.get(Number(row.latest_id)) : undefined
      const installedTrusted =
        row.install_artifact_hash === row.installed_artifact_hash &&
        installed?.pluginType === row.plugin_type
      const latestTrusted = latest?.pluginType === row.plugin_type
      const available = row.listing_state === 'active' && latestTrusted
      const installedCurrent =
        available &&
        row.installed &&
        installedTrusted &&
        row.latest_id === row.installed_id &&
        latest?.artifactHash === installed?.artifactHash
      const contract = latestTrusted ? latest : installedTrusted ? installed : null
      return {
        versionId: row.installed_id,
        slug: row.slug,
        pluginType: row.plugin_type,
        label: (latestTrusted ? row.latest_name : row.installed_name) ?? row.installed_name,
        description:
          (latestTrusted ? row.latest_description : row.installed_description) ??
          row.installed_description,
        accountMode:
          contract?.pluginType === 'managed-browser' ? contract.contract.account.mode : 'none',
        actions: contract?.contract.actions.map(actionProjection) ?? [],
        installed: row.installed,
        installedVersion: row.installed_version,
        latestVersionId: available ? row.latest_id : null,
        latestVersion: available ? row.latest_version : null,
        installedCurrent,
        updateAvailable:
          available && (!row.installed || !installedTrusted || row.latest_id !== row.installed_id),
        available,
      }
    })
    const bySlug = new Map(catalog.map((item) => [item.slug, item]))
    const accountRows = await this.pool.query<{
      id: string
      provider: string
      display_name: string
      connector_version_id: string
      status: 'active' | 'error'
      meta: Record<string, unknown>
      plugin_write_enabled: boolean
      plugin_write_disclaimer_version: number | null
      plugin_write_disclaimer_accepted_at: Date | null
      plugin_write_preapproval_enabled: boolean
      plugin_write_preapproval_disclaimer_version: number | null
      plugin_write_preapproval_accepted_at: Date | null
    }>(
      `SELECT c.id::text, c.provider, c.display_name,
              c.connector_version_id::text, c.status, c.meta,
              c.plugin_write_enabled, c.plugin_write_disclaimer_version,
              c.plugin_write_disclaimer_accepted_at,
              c.plugin_write_preapproval_enabled,
              c.plugin_write_preapproval_disclaimer_version,
              c.plugin_write_preapproval_accepted_at
         FROM connections c
         JOIN marketplace_skill_versions v ON v.id = c.connector_version_id
         JOIN marketplace_skill_listings l ON l.slug = v.slug AND l.slug = c.provider
        WHERE c.user_id = $1 AND c.revoked_at IS NULL
          AND l.kind = 'connector' AND l.plugin_type = 'managed-browser'
        ORDER BY c.created_at DESC`,
      [userId],
    )
    const accounts: RuntimePluginManagementAccount[] = accountRows.rows.map((row) => {
      const plugin = bySlug.get(row.provider)
      const writeControl = plugin
        ? writeControlFor(
            row.provider,
            plugin.actions.map((action) => ({
              effect: action.readOnly ? ('read' as const) : ('write' as const),
            })),
            row,
          )
        : null
      return {
        id: row.id,
        provider: row.provider,
        pluginType: 'managed-browser',
        displayName: row.display_name || row.provider,
        accountHint: typeof row.meta?.account_hint === 'string' ? row.meta.account_hint : '',
        status: row.status,
        actions: plugin?.actions ?? [],
        versionId: row.connector_version_id,
        executable:
          row.status === 'active' &&
          plugin?.installedCurrent === true &&
          plugin.versionId === row.connector_version_id &&
          runtimeSupportedVersionIds.has(row.connector_version_id),
        writeControl,
      }
    })
    return { catalog, accounts }
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
      plugin_write_enabled: boolean
      plugin_write_disclaimer_version: number | null
      plugin_write_disclaimer_accepted_at: Date | null
      plugin_write_preapproval_enabled: boolean
      plugin_write_preapproval_disclaimer_version: number | null
      plugin_write_preapproval_accepted_at: Date | null
    }>(
      `SELECT c.id::text, c.provider, c.display_name,
              c.connector_version_id::text, c.meta,
              c.plugin_write_enabled, c.plugin_write_disclaimer_version,
              c.plugin_write_disclaimer_accepted_at,
              c.plugin_write_preapproval_enabled,
              c.plugin_write_preapproval_disclaimer_version,
              c.plugin_write_preapproval_accepted_at
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
      if (
        !item ||
        item.pluginType !== 'managed-browser' ||
        !this.browser.supportsContract(item.contract)
      )
        continue
      const writeControl = writeControlFor(row.provider, item.contract.actions, row)
      managedTargets.push({
        id: row.id,
        provider: row.provider,
        pluginType: 'managed-browser',
        displayName: row.display_name || row.provider,
        accountHint: typeof row.meta?.account_hint === 'string' ? row.meta.account_hint : '',
        status: 'active',
        actions: item.contract.actions
          .filter((action) => action.effect === 'read' || writeControl?.enabled === true)
          .map(actionProjection),
        ...(writeControl
          ? {
              writeMode: !writeControl.enabled
                ? ('disabled' as const)
                : writeControl.preapproval.enabled
                  ? ('account_preapproval' as const)
                  : ('confirm_each' as const),
            }
          : {}),
      })
    }
    return [...managedTargets, ...localTargets]
  }

  async actionEffect(input: {
    userId: number
    targetId: string
    actionId: string
  }): Promise<'read' | 'write'> {
    const local = /^plugin:(\d{1,16})$/.exec(input.targetId)
    if (local) {
      if (!isSafeDbId(local[1]!))
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin target id is malformed')
      const verified = await loadVerifiedRuntimePluginContract(Number(local[1]), this.pool, {
        env: this.opts.env,
      })
      if (verified.pluginType !== 'sandboxed-local')
        throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND', 'Plugin target subtype mismatch')
      await assertRuntimePluginInstallEntitlement(input.userId, verified, this.pool, {
        requireCurrent: true,
      })
      if (!verified.contract.actions.some((action) => action.id === input.actionId))
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin action not found')
      return 'read'
    }
    const { verified } = await this.loadManagedTarget(input.userId, input.targetId)
    const action = verified.contract.actions.find((candidate) => candidate.id === input.actionId)
    if (!action) throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin action not found')
    return action.effect
  }

  async setManagedAccountWriteAccess(input: {
    userId: number
    targetId: string
    enabled: boolean
    accepted?: true
    disclaimerVersion?: number
  }): Promise<RuntimePluginWriteControl> {
    const initial = await this.loadManagedTarget(input.userId, input.targetId)
    const policy = managedPluginWritePolicy(initial.verified.slug)
    if (!policy || !initial.verified.contract.actions.some((action) => action.effect === 'write'))
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin does not expose managed writes')
    if (input.enabled && (input.accepted !== true || input.disclaimerVersion !== policy.version))
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'current write disclaimer is required')

    const lease = await acquirePluginAccountLease(this.opts.redis, input.targetId, {
      hardTimeoutMs: 15_000,
    })
    try {
      const current = await this.loadManagedTarget(input.userId, input.targetId)
      if (
        current.verified.artifactHash !== initial.verified.artifactHash ||
        current.verified.execContractHash !== initial.verified.execContractHash
      )
        throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin changed before write toggle')
      await lease.assertHeld()
      const updated = await tx<{
        plugin_write_enabled: boolean
        plugin_write_disclaimer_version: number | null
        plugin_write_disclaimer_accepted_at: Date | null
        plugin_write_preapproval_enabled: boolean
        plugin_write_preapproval_disclaimer_version: number | null
        plugin_write_preapproval_accepted_at: Date | null
      }>(async (client) => {
        const locked = await client.query<PluginAccountRow>(
          `SELECT id::text AS id, user_id::int AS user_id, provider, display_name,
                  account_key, aad_seed::text AS aad_seed, secret_enc, secret_nonce,
                  revision, secret_generation::text AS secret_generation,
                  connector_version_id::text AS connector_version_id, spec_hash,
                  exec_contract_hash, auth_contract_version,
                  plugin_write_enabled, plugin_write_disclaimer_version,
                  plugin_write_disclaimer_accepted_at,
                  plugin_write_preapproval_enabled,
                  plugin_write_preapproval_disclaimer_version,
                  plugin_write_preapproval_accepted_at,
                  status, meta, revoked_at
             FROM connections
            WHERE id = $1::bigint AND user_id = $2
            FOR UPDATE`,
          [input.targetId, input.userId],
        )
        const row = locked.rows[0]
        if (
          !row ||
          row.status !== 'active' ||
          row.revoked_at !== null ||
          row.provider !== current.verified.slug ||
          row.revision !== current.row.revision ||
          row.connector_version_id !== String(current.verified.versionId) ||
          row.spec_hash.toString('hex') !== current.verified.artifactHash ||
          row.exec_contract_hash.toString('hex') !== current.verified.execContractHash ||
          row.auth_contract_version !== current.verified.contract.account.contractVersion
        )
          throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin account changed')
        await assertRuntimePluginInstallEntitlement(input.userId, current.verified, client, {
          requireCurrent: true,
        })
        const result = await client.query<{
          plugin_write_enabled: boolean
          plugin_write_disclaimer_version: number | null
          plugin_write_disclaimer_accepted_at: Date | null
          plugin_write_preapproval_enabled: boolean
          plugin_write_preapproval_disclaimer_version: number | null
          plugin_write_preapproval_accepted_at: Date | null
        }>(
          `UPDATE connections
              SET plugin_write_enabled = $3,
                  plugin_write_preapproval_enabled = CASE WHEN $3 THEN plugin_write_preapproval_enabled ELSE FALSE END,
                  plugin_write_disclaimer_version = CASE WHEN $3 THEN $4 ELSE plugin_write_disclaimer_version END,
                  plugin_write_disclaimer_accepted_at = CASE WHEN $3 THEN now() ELSE plugin_write_disclaimer_accepted_at END,
                  revision = revision + 1, updated_at = now()
            WHERE id = $1::bigint AND user_id = $2 AND revision = $5
              AND status = 'active' AND revoked_at IS NULL
            RETURNING plugin_write_enabled, plugin_write_disclaimer_version,
                      plugin_write_disclaimer_accepted_at,
                      plugin_write_preapproval_enabled,
                      plugin_write_preapproval_disclaimer_version,
                      plugin_write_preapproval_accepted_at`,
          [input.targetId, input.userId, input.enabled, policy.version, row.revision],
        )
        if ((result.rowCount ?? 0) !== 1)
          throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin write toggle CAS failed')
        if (!input.enabled) {
          await client.query(
            `UPDATE plugin_automation_controls
                SET enabled = FALSE, paused_reason = 'MANUAL_WRITE_DISABLED',
                    revision = revision + 1, updated_at = now()
              WHERE connection_id = $1::bigint AND user_id = $2`,
            [input.targetId, input.userId],
          )
          await client.query(
            `UPDATE plugin_automation_rules
                SET enabled = FALSE, paused_reason = 'MANUAL_WRITE_DISABLED',
                    lease_token = NULL, lease_until = NULL,
                    revision = revision + 1, updated_at = now()
              WHERE connection_id = $1::bigint AND user_id = $2 AND deleted_at IS NULL`,
            [input.targetId, input.userId],
          )
          await client.query(
            `UPDATE plugin_automation_runs
                SET status = 'skipped', reason_code = 'MANUAL_WRITE_DISABLED',
                    reply_enc = NULL, reply_nonce = NULL, reply_hash = NULL,
                    dispatch_claim_token = NULL, dispatch_claim_until = NULL,
                    finished_at = now()
              WHERE connection_id = $1::bigint AND user_id = $2
                AND status IN ('reserved','generating','ready')`,
            [input.targetId, input.userId],
          )
        }
        return result.rows[0]!
      }, this.pool)
      const control = writeControlFor(
        current.verified.slug,
        current.verified.contract.actions,
        updated,
      )
      if (!control) throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin write policy missing')
      return control
    } finally {
      await lease.release()
    }
  }

  async setManagedAccountWritePreapproval(input: {
    userId: number
    targetId: string
    enabled: boolean
    accepted?: true
    disclaimerVersion?: number
  }): Promise<RuntimePluginWriteControl> {
    const initial = await this.loadManagedTarget(input.userId, input.targetId)
    const policy = managedPluginWritePreapprovalPolicy(initial.verified.slug)
    if (!policy || !initial.verified.contract.actions.some((action) => action.effect === 'write'))
      throw new PluginRuntimeFacadeError(
        'BAD_REQUEST',
        'Plugin does not support account write preapproval',
      )
    if (input.enabled && (input.accepted !== true || input.disclaimerVersion !== policy.version))
      throw new PluginRuntimeFacadeError(
        'BAD_REQUEST',
        'current preapproval disclaimer is required',
      )

    const lease = await acquirePluginAccountLease(this.opts.redis, input.targetId, {
      hardTimeoutMs: 15_000,
    })
    try {
      const current = await this.loadManagedTarget(input.userId, input.targetId)
      if (
        current.verified.artifactHash !== initial.verified.artifactHash ||
        current.verified.execContractHash !== initial.verified.execContractHash
      )
        throw new PluginRuntimeFacadeError(
          'TARGET_STALE',
          'Plugin changed before preapproval toggle',
        )
      await lease.assertHeld()
      const updated = await tx<{
        plugin_write_enabled: boolean
        plugin_write_disclaimer_version: number | null
        plugin_write_disclaimer_accepted_at: Date | null
        plugin_write_preapproval_enabled: boolean
        plugin_write_preapproval_disclaimer_version: number | null
        plugin_write_preapproval_accepted_at: Date | null
      }>(async (client) => {
        const locked = await client.query<PluginAccountRow>(
          `SELECT id::text AS id, user_id::int AS user_id, provider, display_name,
                  account_key, aad_seed::text AS aad_seed, secret_enc, secret_nonce,
                  revision, secret_generation::text AS secret_generation,
                  connector_version_id::text AS connector_version_id, spec_hash,
                  exec_contract_hash, auth_contract_version,
                  plugin_write_enabled, plugin_write_disclaimer_version,
                  plugin_write_disclaimer_accepted_at,
                  plugin_write_preapproval_enabled,
                  plugin_write_preapproval_disclaimer_version,
                  plugin_write_preapproval_accepted_at,
                  status, meta, revoked_at
             FROM connections
            WHERE id = $1::bigint AND user_id = $2
            FOR UPDATE`,
          [input.targetId, input.userId],
        )
        const row = locked.rows[0]
        if (
          !row ||
          row.status !== 'active' ||
          row.revoked_at !== null ||
          row.provider !== current.verified.slug ||
          row.revision !== current.row.revision ||
          row.connector_version_id !== String(current.verified.versionId) ||
          row.spec_hash.toString('hex') !== current.verified.artifactHash ||
          row.exec_contract_hash.toString('hex') !== current.verified.execContractHash ||
          row.auth_contract_version !== current.verified.contract.account.contractVersion
        )
          throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin account changed')
        await assertRuntimePluginInstallEntitlement(input.userId, current.verified, client, {
          requireCurrent: true,
        })
        if (
          input.enabled &&
          writeControlFor(current.verified.slug, current.verified.contract.actions, row)
            ?.enabled !== true
        )
          throw new PluginRuntimeFacadeError(
            'WRITE_DISABLED',
            'Plugin writes must be enabled before preapproval',
          )
        const result = await client.query<{
          plugin_write_enabled: boolean
          plugin_write_disclaimer_version: number | null
          plugin_write_disclaimer_accepted_at: Date | null
          plugin_write_preapproval_enabled: boolean
          plugin_write_preapproval_disclaimer_version: number | null
          plugin_write_preapproval_accepted_at: Date | null
        }>(
          `UPDATE connections
              SET plugin_write_preapproval_enabled = $3,
                  plugin_write_preapproval_disclaimer_version = CASE WHEN $3 THEN $4 ELSE plugin_write_preapproval_disclaimer_version END,
                  plugin_write_preapproval_accepted_at = CASE WHEN $3 THEN now() ELSE plugin_write_preapproval_accepted_at END,
                  revision = revision + 1, updated_at = now()
            WHERE id = $1::bigint AND user_id = $2 AND revision = $5
              AND status = 'active' AND revoked_at IS NULL
            RETURNING plugin_write_enabled, plugin_write_disclaimer_version,
                      plugin_write_disclaimer_accepted_at,
                      plugin_write_preapproval_enabled,
                      plugin_write_preapproval_disclaimer_version,
                      plugin_write_preapproval_accepted_at`,
          [input.targetId, input.userId, input.enabled, policy.version, row.revision],
        )
        if ((result.rowCount ?? 0) !== 1)
          throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin preapproval toggle CAS failed')
        return result.rows[0]!
      }, this.pool)
      const control = writeControlFor(
        current.verified.slug,
        current.verified.contract.actions,
        updated,
      )
      if (!control) throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin write policy missing')
      return control
    } finally {
      await lease.release()
    }
  }

  private async prepareKnowledgePlanetWriteParams(input: {
    userId: number
    targetId: string
    actionId: string
    params: Record<string, unknown>
  }): Promise<Record<string, unknown>> {
    if (
      Object.hasOwn(input.params, 'mediaManifest') ||
      Object.hasOwn(input.params, 'editSnapshot') ||
      Object.hasOwn(input.params, 'deleteSnapshot') ||
      Object.hasOwn(input.params, 'automationSourceSnapshot')
    )
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'server-owned Plugin fields are forbidden')

    const prepared: Record<string, unknown> = { ...input.params }
    const imagePaths = Array.isArray(input.params.images)
      ? (input.params.images as unknown[]).filter(
          (value): value is string => typeof value === 'string',
        )
      : []
    const filePaths = Array.isArray(input.params.files)
      ? (input.params.files as unknown[]).filter(
          (value): value is string => typeof value === 'string',
        )
      : []
    if (imagePaths.length + filePaths.length > 0) {
      if (!this.opts.knowledgePlanetMedia)
        throw new PluginRuntimeFacadeError('RUNTIME_UNAVAILABLE', 'Plugin media is unavailable')
      prepared.mediaManifest = await sealKnowledgePlanetMedia({
        userId: input.userId,
        items: [
          ...imagePaths.map((path) => ({ path, kind: 'image' as const })),
          ...filePaths.map((path) => ({ path, kind: 'file' as const })),
        ],
        deps: this.opts.knowledgePlanetMedia,
      })
    } else if (['create_topic', 'create_comment', 'edit_topic'].includes(input.actionId)) {
      prepared.mediaManifest = []
    }
    if (['create_topic', 'create_comment', 'edit_topic'].includes(input.actionId))
      prepared.text = typeof input.params.text === 'string' ? input.params.text : ''

    if (input.actionId === 'edit_topic' || input.actionId === 'delete_topic') {
      const read = (await this.call({
        userId: input.userId,
        targetId: input.targetId,
        actionId: 'get_topic',
        params: { topicId: String(input.params.topicId ?? '') },
      })) as { topic?: Record<string, unknown> }
      const topic = read?.topic
      const digest = topic?.contentDigest
      if (!topic || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin topic snapshot is unavailable')
      const imageIds = Array.isArray(topic.images)
        ? topic.images.flatMap((item) => {
            const id = (item as Record<string, unknown>)?.id
            return typeof id === 'string' ? [id] : []
          })
        : []
      const fileIds = Array.isArray(topic.files)
        ? topic.files.flatMap((item) => {
            const id = (item as Record<string, unknown>)?.id
            return typeof id === 'string' ? [id] : []
          })
        : []
      if (input.actionId === 'edit_topic') {
        if (topic.type !== 'talk')
          throw new PluginRuntimeFacadeError(
            'BAD_REQUEST',
            'Plugin can edit ordinary Knowledge Planet topics only',
          )
        const preserve = input.params.preserveExistingMedia !== false
        const hasRemoveImageIds = Object.hasOwn(input.params, 'removeImageIds')
        const hasRemoveFileIds = Object.hasOwn(input.params, 'removeFileIds')
        if (!preserve && (hasRemoveImageIds || hasRemoveFileIds))
          throw new PluginRuntimeFacadeError(
            'BAD_REQUEST',
            'Plugin media removal cannot be combined with clearing all existing media',
          )
        const removeImageIds = hasRemoveImageIds
          ? knowledgePlanetRemovalIds(input.params.removeImageIds)
          : []
        const removeFileIds = hasRemoveFileIds
          ? knowledgePlanetRemovalIds(input.params.removeFileIds)
          : []
        if (
          removeImageIds.some((id) => !imageIds.includes(id)) ||
          removeFileIds.some((id) => !fileIds.includes(id))
        )
          throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin media removal target is stale')
        const removeImages = new Set(removeImageIds)
        const removeFiles = new Set(removeFileIds)
        const keepImageIds = preserve ? imageIds.filter((id) => !removeImages.has(id)) : []
        const keepFileIds = preserve ? fileIds.filter((id) => !removeFiles.has(id)) : []
        const previousText = typeof topic.text === 'string' ? topic.text : ''
        // edit_topic is a full-replacement upstream API. Omitting `text` means
        // "media-only edit", not "clear the body"; an explicitly supplied
        // empty string still keeps its existing clear-text semantics.
        if (!Object.hasOwn(input.params, 'text')) prepared.text = previousText
        const manifest = prepared.mediaManifest as KnowledgePlanetSealedMedia[]
        const newImages = manifest.filter((item) => item.kind === 'image').length
        const newFiles = manifest.filter((item) => item.kind === 'file').length
        if (keepImageIds.length + newImages > 9 || keepFileIds.length + newFiles > 9)
          throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin topic media limit exceeded')
        prepared.preserveExistingMedia = preserve
        if (hasRemoveImageIds) prepared.removeImageIds = removeImageIds
        if (hasRemoveFileIds) prepared.removeFileIds = removeFileIds
        prepared.editSnapshot = {
          expectedDigest: digest,
          previousText,
          keepImageIds,
          keepFileIds,
        }
        if (
          String(prepared.text ?? '').length === 0 &&
          keepImageIds.length + keepFileIds.length + newImages + newFiles === 0
        )
          throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin topic cannot be empty')
      } else {
        prepared.deleteSnapshot = {
          expectedDigest: digest,
          preview: String(topic.text ?? topic.title ?? '').slice(0, 1000),
        }
      }
    }

    if (input.actionId === 'delete_comment') {
      const topicId = String(input.params.topicId ?? '')
      const commentId = String(input.params.commentId ?? '')
      const lookupPage = Object.hasOwn(input.params, 'lookupPage')
        ? normalizeKnowledgePlanetCommentPage(input.params.lookupPage)
        : null
      if (lookupPage) prepared.lookupPage = lookupPage
      let comment: Record<string, unknown> | undefined
      const pages: KnowledgePlanetCommentPage[] = lookupPage
        ? [lookupPage]
        : [
            { count: 50, sort: 'desc' },
            { count: 50, sort: 'asc' },
          ]
      for (const page of pages) {
        const read = (await this.call({
          userId: input.userId,
          targetId: input.targetId,
          actionId: 'list_comments',
          params: { topicId, ...page },
        })) as { comments?: Record<string, unknown>[] }
        comment = read.comments?.find((candidate) => candidate.id === commentId)
        if (comment) break
      }
      const digest = comment?.contentDigest
      if (!comment || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin comment snapshot is unavailable')
      prepared.deleteSnapshot = {
        expectedDigest: digest,
        preview: String(comment.text ?? '').slice(0, 1000),
      }
    }

    if (input.actionId === 'create_topic') {
      const manifest = prepared.mediaManifest as KnowledgePlanetSealedMedia[]
      if (String(prepared.text ?? '').length === 0 && manifest.length === 0)
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin topic cannot be empty')
    }
    if (input.actionId === 'create_comment') {
      const manifest = prepared.mediaManifest as KnowledgePlanetSealedMedia[]
      if (
        manifest.some((item) => item.kind !== 'image') ||
        (String(prepared.text ?? '').length === 0 && manifest.length === 0)
      )
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin comment cannot be empty')
    }
    return prepared
  }

  private async prepareWeiboWriteParams(input: {
    userId: number
    targetId: string
    actionId: string
    params: Record<string, unknown>
  }): Promise<Record<string, unknown>> {
    if (
      Object.hasOwn(input.params, 'mediaManifest') ||
      Object.hasOwn(input.params, 'editSnapshot') ||
      Object.hasOwn(input.params, 'deleteSnapshot')
    )
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'server-owned Plugin fields are forbidden')

    const prepared: Record<string, unknown> = { ...input.params }
    if (input.actionId === 'create_post') {
      const imagePaths = Array.isArray(input.params.images)
        ? (input.params.images as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : []
      if (imagePaths.length > 0) {
        if (!this.opts.knowledgePlanetMedia)
          throw new PluginRuntimeFacadeError('RUNTIME_UNAVAILABLE', 'Plugin media is unavailable')
        prepared.mediaManifest = await sealKnowledgePlanetMedia({
          userId: input.userId,
          items: imagePaths.map((path) => ({ path, kind: 'image' as const })),
          deps: this.opts.knowledgePlanetMedia,
        })
      } else prepared.mediaManifest = []
      prepared.text = typeof input.params.text === 'string' ? input.params.text : ''
      if (String(prepared.text).length === 0 && imagePaths.length === 0)
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin post cannot be empty')
    }

    if (input.actionId === 'edit_post' || input.actionId === 'delete_post') {
      const read = (await this.call({
        userId: input.userId,
        targetId: input.targetId,
        actionId: 'get_post',
        params: {
          userId: String(input.params.userId ?? ''),
          postId: String(input.params.postId ?? ''),
        },
      })) as { post?: Record<string, unknown> }
      const post = read.post
      const expectedDigest = post?.contentDigest
      const expectedUserId = String(input.params.userId ?? '')
      const expectedPostId = String(input.params.postId ?? '')
      if (
        !post ||
        post.userId !== expectedUserId ||
        post.id !== expectedPostId ||
        post.owned !== true ||
        typeof expectedDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(expectedDigest)
      )
        throw new PluginRuntimeFacadeError(
          'BAD_REQUEST',
          'Plugin owned-post snapshot is unavailable',
        )
      const snapshot = { expectedDigest, owned: true }
      if (input.actionId === 'edit_post') prepared.editSnapshot = snapshot
      else prepared.deleteSnapshot = snapshot
    }

    if (input.actionId === 'delete_comment') {
      const read = (await this.call({
        userId: input.userId,
        targetId: input.targetId,
        actionId: 'list_comments',
        params: {
          userId: String(input.params.userId ?? ''),
          postId: String(input.params.postId ?? ''),
          count: 50,
        },
      })) as { comments?: Record<string, unknown>[] }
      const comment = read.comments?.find(
        (candidate) => candidate.id === String(input.params.commentId ?? ''),
      )
      const expectedDigest = comment?.contentDigest
      if (
        !comment ||
        comment.postId !== String(input.params.postId ?? '') ||
        typeof expectedDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(expectedDigest)
      )
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin comment snapshot is unavailable')
      if (comment.owned === true) {
        prepared.deleteSnapshot = { expectedDigest, targetKind: 'own_comment' }
      } else {
        const postRead = (await this.call({
          userId: input.userId,
          targetId: input.targetId,
          actionId: 'get_post',
          params: {
            userId: String(input.params.userId ?? ''),
            postId: String(input.params.postId ?? ''),
          },
        })) as { post?: Record<string, unknown> }
        const post = postRead.post
        const postExpectedDigest = post?.contentDigest
        if (
          !post ||
          post.id !== String(input.params.postId ?? '') ||
          post.userId !== String(input.params.userId ?? '') ||
          post.owned !== true ||
          typeof postExpectedDigest !== 'string' ||
          !/^[0-9a-f]{64}$/.test(postExpectedDigest)
        )
          throw new PluginRuntimeFacadeError(
            'BAD_REQUEST',
            'Plugin received-comment target is not an owned post',
          )
        prepared.deleteSnapshot = {
          expectedDigest,
          targetKind: 'received_on_own_post',
          postExpectedDigest,
        }
      }
    }
    return prepared
  }

  async proposeWrite(input: {
    userId: number
    targetId: string
    actionId: string
    params: Record<string, unknown>
  }): Promise<{
    confirmId: string
    provider: string
    summary: string
    expiresAt: Date
    approvalMode: 'interactive' | 'account_preapproval'
  }> {
    const initial = await this.loadManagedTarget(input.userId, input.targetId)
    const initialAction = initial.verified.contract.actions.find(
      (candidate) => candidate.id === input.actionId,
    )
    if (!initialAction || initialAction.effect !== 'write')
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin write action not found')
    const policy = managedPluginWritePolicy(initial.verified.slug)
    if (!policy)
      throw new PluginRuntimeFacadeError('WRITE_DISABLED', 'Plugin write policy is unavailable')
    try {
      validateRuntimePluginJson(initialAction.params, input.params, 'params')
    } catch (error) {
      if (error instanceof RuntimePluginContractError)
        throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin write params are invalid')
      throw error
    }

    const sealedParams =
      initial.verified.slug === KNOWLEDGE_PLANET_PLUGIN_SLUG
        ? await this.prepareKnowledgePlanetWriteParams(input)
        : initial.verified.slug === WEIBO_PLUGIN_SLUG
          ? await this.prepareWeiboWriteParams(input)
          : input.params

    const lease = await acquirePluginAccountLease(this.opts.redis, input.targetId, {
      hardTimeoutMs: 15_000,
    })
    try {
      const current = await this.loadManagedTarget(input.userId, input.targetId)
      const action = current.verified.contract.actions.find(
        (candidate) => candidate.id === input.actionId,
      )
      if (
        !action ||
        action.effect !== 'write' ||
        current.verified.artifactHash !== initial.verified.artifactHash ||
        current.verified.execContractHash !== initial.verified.execContractHash
      )
        throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin write action changed')
      const control = writeControlFor(
        current.verified.slug,
        current.verified.contract.actions,
        current.row,
      )
      if (!control?.enabled)
        throw new PluginRuntimeFacadeError('WRITE_DISABLED', 'Plugin writes are disabled')
      const approvalMode = control.preapproval.enabled
        ? ('account_preapproval' as const)
        : ('interactive' as const)
      validateRuntimePluginJson(action.params, sealedParams, 'params')
      await lease.assertHeld()
      const proposed = await proposeLedgerWrite(
        {
          userId: input.userId,
          connectionId: current.row.id,
          connectionRevision: current.row.revision,
          provider: current.verified.slug,
          action: action.id,
          params: sealedParams,
          summary: buildWriteSummary(
            current.verified.slug,
            action.id,
            sealedParams,
            typeof current.row.meta?.account_hint === 'string' ? current.row.meta.account_hint : '',
          ),
          contractPins: {
            connectorVersionId: current.verified.versionId,
            specHashHex: current.verified.artifactHash,
            execContractHashHex: current.verified.execContractHash,
            authContractVersion: current.verified.contract.account.contractVersion,
          },
          dispatchFenceRequired: true,
          approval:
            approvalMode === 'account_preapproval'
              ? {
                  source: 'account_preapproval',
                  policyVersion: control.preapproval.disclaimerVersion!,
                }
              : { source: 'user_confirmation' },
        },
        this.pool,
      )
      return {
        confirmId: proposed.id,
        provider: current.verified.slug,
        summary: proposed.summary,
        expiresAt: proposed.expiresAt,
        approvalMode,
      }
    } finally {
      await lease.release()
    }
  }

  private async authoritativeWriteOutcome(
    userId: number,
    targetId: string,
    confirmId: string,
  ): Promise<RuntimePluginWriteExecution> {
    const row = await getLedgerRow(confirmId, userId, this.pool)
    if (!row || row.connection_id !== targetId)
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin confirmation binding changed')
    if (row.status === 'executing') return { kind: 'in_progress' }
    if (['succeeded', 'failed', 'unknown', 'expired', 'denied'].includes(row.status))
      return ledgerReplay(row)
    throw new PluginRuntimeFacadeError('RUNTIME_UNAVAILABLE', 'Plugin ledger state is invalid')
  }

  async executeConfirmedWrite(input: {
    userId: number
    targetId: string
    confirmId: string
  }): Promise<RuntimePluginWriteExecution> {
    if (!isSafeDbId(input.targetId))
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin account id is malformed')
    const snapshot = await getLedgerRow(input.confirmId, input.userId, this.pool)
    if (!snapshot || snapshot.connection_id !== input.targetId)
      throw new PluginRuntimeFacadeError(
        'BAD_REQUEST',
        'Plugin confirmation does not match account',
      )
    const classification = classifyForExecute(snapshot)
    if (classification.kind === 'in_progress') return { kind: 'in_progress' }
    if (classification.kind === 'replay') return ledgerReplay(snapshot)

    const lease = await acquirePluginAccountLease(this.opts.redis, input.targetId, {
      hardTimeoutMs: 700_000,
    })
    let begun: Extract<Awaited<ReturnType<typeof beginExecute>>, { kind: 'ok' }> | null = null
    let fencedRow: PluginAccountRow | null = null
    let verified: Extract<VerifiedRuntimePluginContract, { pluginType: 'managed-browser' }> | null =
      null
    let armed = false
    let armAttempted = false
    try {
      const started = await beginExecute(
        {
          id: input.confirmId,
          userId: input.userId,
          connectionId: input.targetId,
          expectedProvider: snapshot.provider,
        },
        this.pool,
      )
      if (started.kind === 'in_progress') return { kind: 'in_progress' }
      if (started.kind === 'replay') {
        return {
          kind: 'replay',
          status: started.status,
          errorCode: started.errorCode,
          resultDigest: started.resultDigest,
        }
      }
      begun = started

      try {
        const current = await this.loadManagedTarget(input.userId, input.targetId)
        verified = current.verified
        const action = verified.contract.actions.find(
          (candidate) => candidate.id === begun!.row.action,
        )
        if (!action || action.effect !== 'write')
          throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin write action changed')
        validateRuntimePluginJson(action.params, begun.params, 'params')
        const policy = managedPluginWritePolicy(verified.slug)
        const preapprovalPolicy = managedPluginWritePreapprovalPolicy(verified.slug)
        if (!policy)
          throw new PluginRuntimeFacadeError('WRITE_DISABLED', 'Plugin write policy is unavailable')
        await lease.assertHeld()
        fencedRow = await fencePluginAccountInvocation({
          connectionId: input.targetId,
          userId: input.userId,
          expectedRevision: begun.row.connection_revision,
          verified,
          runner: this.pool,
        })
        const envelope = decryptPluginAccountEnvelope(fencedRow, verified.contract, this.opts.env)
        const manifest = Array.isArray(begun.params.mediaManifest)
          ? (begun.params.mediaManifest as KnowledgePlanetSealedMedia[])
          : []
        let staged: Awaited<ReturnType<typeof stageKnowledgePlanetMedia>> | null = null
        if (
          [KNOWLEDGE_PLANET_PLUGIN_SLUG, WEIBO_PLUGIN_SLUG].includes(verified.slug) &&
          manifest.length > 0
        ) {
          const mediaDeps = this.opts.knowledgePlanetMedia
          if (!mediaDeps)
            throw new PluginRuntimeFacadeError('RUNTIME_UNAVAILABLE', 'Plugin media is unavailable')
          staged = await stageKnowledgePlanetMedia({
            userId: input.userId,
            manifest,
            deps: mediaDeps,
          })
        }
        let executed: Awaited<ReturnType<ManagedBrowserRuntime['runAction']>>
        try {
          executed = await this.browser.runAction({
            contract: verified.contract,
            storageState: envelope.storageState,
            actionId: begun.row.action,
            params: begun.params,
            signal: lease.signal,
            ...(staged ? { inputDirectory: staged.directory } : {}),
            beforeDispatch: async () => {
              await lease.assertHeld()
              armAttempted = true
              await armPluginWriteDispatch(
                {
                  id: input.confirmId,
                  userId: input.userId,
                  connectionId: input.targetId,
                  currentDisclaimerVersion: policy.version,
                  ...(preapprovalPolicy
                    ? { currentPreapprovalDisclaimerVersion: preapprovalPolicy.version }
                    : {}),
                },
                this.pool,
              )
              armed = true
            },
          })
        } finally {
          await staged?.cleanup()
        }
        const currentVerified = await loadVerifiedRuntimePluginContract(
          verified.versionId,
          this.pool,
          {
            env: this.opts.env,
          },
        )
        if (
          currentVerified.pluginType !== 'managed-browser' ||
          currentVerified.artifactHash !== verified.artifactHash ||
          currentVerified.execContractHash !== verified.execContractHash ||
          !this.browser.supportsContract(currentVerified.contract)
        )
          throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin contract changed during write')
        await assertRuntimePluginInstallEntitlement(input.userId, currentVerified, this.pool, {
          requireCurrent: true,
        })
        await lease.assertHeld()
        await commitPluginAccountState({
          row: fencedRow,
          verified: currentVerified,
          envelope: { ...envelope, storageState: executed.storageState },
          runner: this.pool,
          env: this.opts.env,
        })
        const finalized = await finalizeExecute(
          {
            id: input.confirmId,
            status: 'succeeded',
            resultDigest: canonicalDigestHex(executed.result),
          },
          this.pool,
        )
        if (!finalized)
          return this.authoritativeWriteOutcome(input.userId, input.targetId, input.confirmId)
        return { kind: 'result', result: executed.result }
      } catch (error) {
        const code = stablePluginErrorCode(error)
        const dispatchProvenNotStarted =
          (error as { dispatchProvenNotStarted?: unknown } | null)?.dispatchProvenNotStarted ===
          true
        let dispatchMayHaveStarted = armed && !dispatchProvenNotStarted
        if (!dispatchProvenNotStarted && !dispatchMayHaveStarted && armAttempted) {
          // The COMMIT response itself can be lost. Never trust a local flag
          // across that ambiguity; reread the durable dispatch boundary.
          const authoritative = await getLedgerRow(input.confirmId, input.userId, this.pool)
          if (!authoritative || authoritative.connection_id !== input.targetId)
            throw new PluginRuntimeFacadeError(
              'RUNTIME_UNAVAILABLE',
              'Plugin dispatch state is unavailable',
            )
          dispatchMayHaveStarted = authoritative.dispatch_armed_at !== null
        }
        if (dispatchMayHaveStarted) {
          if (code === 'LOGIN_EXPIRED_ACCOUNT' && fencedRow && verified) {
            await markPluginAccountRelinkRequiredFenced({
              row: fencedRow,
              verified,
              runner: this.pool,
            }).catch(() => {})
          }
          await finalizeExecute(
            { id: input.confirmId, status: 'unknown', errorCode: code },
            this.pool,
          ).catch(() => false)
          return this.authoritativeWriteOutcome(input.userId, input.targetId, input.confirmId)
        }
        await finalizeExecute(
          { id: input.confirmId, status: 'failed', errorCode: code },
          this.pool,
        ).catch(() => false)
        return this.authoritativeWriteOutcome(input.userId, input.targetId, input.confirmId)
      }
    } finally {
      await lease.release()
    }
  }

  /**
   * Platform-only unattended path. This is deliberately not exposed by the Plugin RPC or HTTP
   * write-confirmation surface: it can perform exactly one text-only Knowledge Planet comment,
   * and only while both the signed current Plugin and the manual-write consent remain valid.
   * The caller owns the separate automation consent/run ledger and must durably arm it in
   * `beforeDispatch`; an ambiguous post-arm outcome is never retried.
   */
  async executeKnowledgePlanetAutomationComment(input: {
    userId: number
    targetId: string
    topicId: string
    text: string
    sourceDigest: string
    beforeDispatch: () => Promise<void>
  }): Promise<KnowledgePlanetAutomationExecution> {
    if (!isSafeDbId(input.targetId))
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin account id is malformed')
    const lease = await acquirePluginAccountLease(this.opts.redis, input.targetId, {
      hardTimeoutMs: 620_000,
    })
    let fencedRow: PluginAccountRow | null = null
    let verified: Extract<VerifiedRuntimePluginContract, { pluginType: 'managed-browser' }> | null =
      null
    let armAttempted = false
    let armed = false
    try {
      try {
        const current = await this.loadManagedTarget(input.userId, input.targetId)
        verified = current.verified
        if (verified.slug !== KNOWLEDGE_PLANET_PLUGIN_SLUG)
          throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Automation target is unsupported')
        const action = verified.contract.actions.find(
          (candidate) => candidate.id === 'create_comment',
        )
        if (!action || action.effect !== 'write')
          throw new PluginRuntimeFacadeError('TARGET_STALE', 'Automation action changed')
        const params = {
          topicId: input.topicId,
          text: input.text,
          images: [],
          mediaManifest: [],
          automationSourceSnapshot: { expectedDigest: input.sourceDigest },
        }
        validateRuntimePluginJson(action.params, params, 'params')
        const policy = managedPluginWritePolicy(verified.slug)
        const control = writeControlFor(verified.slug, verified.contract.actions, current.row)
        if (!policy || !control?.enabled)
          throw new PluginRuntimeFacadeError('WRITE_DISABLED', 'Plugin writes are disabled')
        await lease.assertHeld()
        fencedRow = await fencePluginAccountInvocation({
          connectionId: input.targetId,
          userId: input.userId,
          expectedRevision: current.row.revision,
          verified,
          runner: this.pool,
        })
        const envelope = decryptPluginAccountEnvelope(fencedRow, verified.contract, this.opts.env)
        const executed = await this.browser.runAction({
          contract: verified.contract,
          storageState: envelope.storageState,
          actionId: action.id,
          params,
          signal: lease.signal,
          beforeDispatch: async () => {
            await lease.assertHeld()
            armAttempted = true
            await input.beforeDispatch()
            armed = true
          },
        })
        const currentVerified = await loadVerifiedRuntimePluginContract(
          verified.versionId,
          this.pool,
          { env: this.opts.env },
        )
        if (
          currentVerified.pluginType !== 'managed-browser' ||
          currentVerified.slug !== KNOWLEDGE_PLANET_PLUGIN_SLUG ||
          currentVerified.artifactHash !== verified.artifactHash ||
          currentVerified.execContractHash !== verified.execContractHash ||
          !this.browser.supportsContract(currentVerified.contract)
        )
          throw new PluginRuntimeFacadeError('TARGET_STALE', 'Plugin contract changed during write')
        await assertRuntimePluginInstallEntitlement(input.userId, currentVerified, this.pool, {
          requireCurrent: true,
        })
        await lease.assertHeld()
        await commitPluginAccountState({
          row: fencedRow,
          verified: currentVerified,
          envelope: { ...envelope, storageState: executed.storageState },
          runner: this.pool,
          env: this.opts.env,
        })
        return { kind: 'result', result: executed.result }
      } catch (error) {
        const code = stablePluginErrorCode(error)
        if (code === 'AUTOMATION_DISPATCH_BUSY') {
          return { kind: 'deferred', errorCode: 'AUTOMATION_DISPATCH_BUSY' }
        }
        if (
          (error as { dispatchProvenNotStarted?: unknown } | null)?.dispatchProvenNotStarted ===
          true
        )
          return { kind: 'not_dispatched', errorCode: code }
        if (code === 'LOGIN_EXPIRED_ACCOUNT' && fencedRow && verified) {
          await markPluginAccountRelinkRequiredFenced({
            row: fencedRow,
            verified,
            runner: this.pool,
          }).catch(() => {})
        }
        // Once the automation arm transaction may have committed, a lost callback/stream/result
        // is conservatively unknown. The scheduler disables automation globally for this account.
        if (armed || armAttempted) return { kind: 'unknown', errorCode: code }
        return { kind: 'failed', errorCode: code }
      }
    } finally {
      await lease.release()
    }
  }

  async revokeManagedAccount(userId: number, targetId: string): Promise<{ id: string }> {
    if (!isSafeDbId(targetId))
      throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin account id is malformed')
    if (!(await getPluginAccount(targetId, userId, this.pool, { includeError: true })))
      throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND', 'Plugin account not found')
    const lease = await acquirePluginAccountLease(this.opts.redis, targetId, {
      hardTimeoutMs: 15_000,
    })
    try {
      const row = await getPluginAccount(targetId, userId, this.pool, { includeError: true })
      if (!row) throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND', 'Plugin account not found')
      await lease.assertHeld()
      await revokePluginAccountFenced({ row, runner: this.pool })
      return { id: targetId }
    } finally {
      await lease.release()
    }
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
    if (!this.browser.supportsContract(initialVerified.contract))
      throw new PluginRuntimeFacadeError(
        'RUNTIME_UNAVAILABLE',
        'managed-browser Plugin runtime unavailable',
      )
    const action = initialVerified.contract.actions.find((item) => item.id === input.actionId)
    if (!action) throw new PluginRuntimeFacadeError('BAD_REQUEST', 'Plugin action not found')
    if (action.effect !== 'read')
      throw new PluginRuntimeFacadeError(
        'WRITE_REQUIRES_CONFIRMATION',
        'Plugin writes require an approved confirmation',
      )

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
        verified.execContractHash !== initialVerified.execContractHash ||
        !this.browser.supportsContract(verified.contract)
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
      let executed: Awaited<ReturnType<ManagedBrowserRuntime['runReadAction']>>
      try {
        executed = await this.browser.runReadAction({
          contract: verified.contract,
          storageState: envelope.storageState,
          actionId: input.actionId,
          params: input.params,
          signal: lease.signal,
        })
      } catch (error) {
        const code = (error as { code?: unknown })?.code
        if (code === 'LOGIN_EXPIRED_ACCOUNT') {
          await lease.assertHeld()
          await markPluginAccountRelinkRequiredFenced({
            row: fencedRow,
            verified,
            runner: this.pool,
          })
          throw new PluginRuntimeFacadeError('RELINK_REQUIRED', 'Plugin account login has expired')
        }
        if (code === 'CAPACITY_EXCEEDED')
          throw new PluginRuntimeFacadeError('RUNTIME_BUSY', 'Plugin worker capacity is full')
        throw error
      }

      // Browser/context/profile cleanup has completed at this point. Recheck kill switch and
      // exact install before the one final irreversible DB CAS.
      const current = await loadVerifiedRuntimePluginContract(verified.versionId, this.pool, {
        env: this.opts.env,
      })
      if (
        current.pluginType !== 'managed-browser' ||
        current.artifactHash !== verified.artifactHash ||
        current.execContractHash !== verified.execContractHash ||
        !this.browser.supportsContract(current.contract)
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
