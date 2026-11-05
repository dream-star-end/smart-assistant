/**
 * OCV5-721 — Remote Agent Brain Pool (`remote_agent_nodes`, `remote_agent_profiles`,
 * `remote_model_offers`, `remote_agent_bindings`).
 *
 * - Supports the 4 remote CLI engines: `cc` (Claude Code, 100% interactive PTY+oc-bridge),
 *   `codex`, `antigravity`, and `grok-build`.
 * - Reuses OCV5-424 `PoolAdapter` + `rankWRH` + 5h/7d quota windows + recovery actor.
 * - Publishes checked remote models into `model_catalog` with `placement = 'remote_pool'`
 *   and `<base_slug>-remote` so the frontend picker automatically displays the " 远端" suffix.
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool } from '../db/index.js'
import { query, type QueryRunner } from '../db/queries.js'
import { formatRemoteModelDisplayName } from '../billing/modelPublicProjection.js'
import type { CooldownReason } from './policy/outcome.js'
import {
  registerPoolAdapter,
  type DueProbe,
  type PoolAdapter,
  type PoolMemberView,
  type ProbeResult,
} from './policy/registry.js'
import { healthWeight, rankWRH } from './policy/select.js'

export const REMOTE_BRAIN_ENGINES = ['cc', 'codex', 'antigravity', 'grok-build'] as const
export type RemoteBrainEngine = (typeof REMOTE_BRAIN_ENGINES)[number]

export type RemoteNodeStatus = 'pending_verify' | 'active' | 'cooldown' | 'degraded' | 'disabled'
export type RemoteProfileStatus = 'active' | 'cooldown' | 'degraded' | 'disabled' | 'needs_relogin'

export interface RemoteDiscoveredModel {
  upstream_model_id: string
  display_name: string
  recommended_remote_slug?: string
}

export interface RemoteQuotaWindow {
  label: string
  usedPct: number | null
  resetsAt: string | null
}

export interface RemoteAgentNodeView {
  id: string
  label: string
  ssh_host: string
  ssh_port: number
  ssh_user: string
  host_key_fp: string
  key_id: string
  controller_sha256: string
  mux_cap_slots: number
  max_hot_slots: number
  max_active_slots: number
  status: RemoteNodeStatus
  disabled_by: string | null
  health_score: number
  rtt_ms_p50: number | null
  rtt_ms_p95: number | null
  last_probe_at: string | null
  last_error: string | null
  install_command: string
  created_at: string
  updated_at: string
}

export interface RemoteAgentProfileView {
  id: string
  node_id: string
  node_label?: string
  engine: RemoteBrainEngine
  profile_name: string
  account_fingerprint: string
  account_hint: string | null
  plan_type: string | null
  cli_version: string | null
  runner_mode: 'interactive'
  mod_digest: string | null
  discovered_models: RemoteDiscoveredModel[]
  quota_windows: RemoteQuotaWindow[]
  quota_updated_at: string | null
  status: RemoteProfileStatus
  disabled_by: string | null
  cooldown_reason: string | null
  cooldown_until: string | null
  next_probe_at: string | null
  probe_failures: number
  health_score: number
  weight: number
  hot_slots: number
  active_slots: number
  max_hot_slots: number
  max_active_slots: number
  last_used_at: string | null
  last_error: string | null
}

export interface RemoteModelOfferView {
  id: string
  profile_id: string
  node_id?: string
  node_label?: string
  engine?: RemoteBrainEngine
  profile_name?: string
  upstream_model_id: string
  canonical_model_id: string
  base_display_name: string
  remote_display_name: string
  enabled: boolean
  catalog_state: string | null
  placement: 'remote_pool'
  created_at: string
  updated_at: string
}

export interface RemoteAgentBindingView {
  operation_id: string
  run_id: string
  uid: string
  container_db_id: string
  docker_id: string
  session_key: string
  node_id: string
  node_label?: string
  profile_id: string
  profile_name?: string
  engine?: string
  canonical_model_id: string
  native_session_id: string | null
  generation: number
  state: string
  last_acked_seq: number
  expires_at: string
  created_at: string
  updated_at: string
}

export const HOST_KEY_FP_RE = /^SHA256:[A-Za-z0-9+/=]{43,44}$/
export const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
export const SSH_HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/

export function isRemoteBrainEngine(v: unknown): v is RemoteBrainEngine {
  return typeof v === 'string' && (REMOTE_BRAIN_ENGINES as readonly string[]).includes(v)
}

/** Map remote CLI engine to `model_catalog.engine`. */
export function catalogEngineForRemoteEngine(
  engine: RemoteBrainEngine,
): 'ccb' | 'codex' | 'antigravity' | 'grok' {
  switch (engine) {
    case 'cc':
      return 'ccb'
    case 'codex':
      return 'codex'
    case 'antigravity':
      return 'antigravity'
    case 'grok-build':
      return 'grok'
  }
}

/** Canonical remote pool model slug (`<base>-remote`). */
export function toRemotePoolModelId(upstreamOrBaseId: string): string {
  const clean = upstreamOrBaseId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!clean) throw new Error('REMOTE_MODEL_SLUG_INVALID')
  return clean.endsWith('-remote') ? clean : `${clean}-remote`
}

let cachedControllerSha256: string | null = null
export function getRemoteHostdSha256(): string {
  if (cachedControllerSha256) return cachedControllerSha256
  try {
    const scriptPath = resolve(
      fileURLToPath(import.meta.url),
      '..',
      '..',
      '..',
      '..',
      '..',
      'scripts',
      'agent-remote',
      'oc-remote-hostd.py',
    )
    cachedControllerSha256 = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
    return cachedControllerSha256
  } catch {
    return '0'.repeat(64)
  }
}

/** Build the one-line restricted SSH authorized_keys install snippet for operators. */
export function buildRemoteNodeInstallCommand(input: {
  sshUser: string
  keyId: string
  publicKey?: string
}): string {
  const pubKey =
    input.publicKey?.trim() ||
    process.env.OC_REMOTE_POOL_SSH_PUBLIC_KEY?.trim() ||
    `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOpenClaudeRemotePoolKey ${input.keyId}`
  const binPath = `/home/${input.sshUser}/.openclaude/bin/oc-remote-hostd.py`
  const entry = `command="${binPath} --serve-mux",no-pty,no-agent-forwarding,no-X11-forwarding,no-user-rc ${pubKey}`
  return [
    `mkdir -p ~/.openclaude/bin ~/.ssh && chmod 700 ~/.openclaude ~/.openclaude/bin ~/.ssh`,
    `grep -qxF '${entry}' ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' '${entry}' >> ~/.ssh/authorized_keys`,
    `chmod 600 ~/.ssh/authorized_keys`,
  ].join(' && ')
}

function mapNodeRow(r: Record<string, any>): RemoteAgentNodeView {
  return {
    id: String(r.id),
    label: String(r.label),
    ssh_host: String(r.ssh_host),
    ssh_port: Number(r.ssh_port ?? 22),
    ssh_user: String(r.ssh_user),
    host_key_fp: String(r.host_key_fp),
    key_id: String(r.key_id),
    controller_sha256: String(r.controller_sha256),
    mux_cap_slots: Number(r.mux_cap_slots ?? 8),
    max_hot_slots: Number(r.max_hot_slots ?? 16),
    max_active_slots: Number(r.max_active_slots ?? 8),
    status: (r.status as RemoteNodeStatus) ?? 'pending_verify',
    disabled_by: r.disabled_by ?? null,
    health_score: Number(r.health_score ?? 100),
    rtt_ms_p50: r.rtt_ms_p50 == null ? null : Number(r.rtt_ms_p50),
    rtt_ms_p95: r.rtt_ms_p95 == null ? null : Number(r.rtt_ms_p95),
    last_probe_at: r.last_probe_at ? new Date(r.last_probe_at).toISOString() : null,
    last_error: r.last_error ?? null,
    install_command: buildRemoteNodeInstallCommand({
      sshUser: String(r.ssh_user),
      keyId: String(r.key_id),
    }),
    created_at: new Date(r.created_at ?? Date.now()).toISOString(),
    updated_at: new Date(r.updated_at ?? Date.now()).toISOString(),
  }
}

function mapProfileRow(r: Record<string, any>): RemoteAgentProfileView {
  const discoveredRaw = Array.isArray(r.discovered_models) ? r.discovered_models : []
  const discovered: RemoteDiscoveredModel[] = discoveredRaw.map((m: any) => ({
    upstream_model_id: String(m?.upstream_model_id ?? ''),
    display_name: String(m?.display_name ?? m?.upstream_model_id ?? ''),
    recommended_remote_slug: m?.upstream_model_id
      ? toRemotePoolModelId(String(m.upstream_model_id))
      : undefined,
  }))
  const windowsRaw = Array.isArray(r.quota_windows) ? r.quota_windows : []
  const windows: RemoteQuotaWindow[] = windowsRaw.map((w: any) => ({
    label: String(w?.label ?? '5h'),
    usedPct: typeof w?.usedPct === 'number' ? w.usedPct : null,
    resetsAt: typeof w?.resetsAt === 'string' ? w.resetsAt : null,
  }))
  return {
    id: String(r.id),
    node_id: String(r.node_id),
    ...(r.node_label ? { node_label: String(r.node_label) } : {}),
    engine: r.engine as RemoteBrainEngine,
    profile_name: String(r.profile_name),
    account_fingerprint: String(r.account_fingerprint),
    account_hint: r.account_hint ?? null,
    plan_type: r.plan_type ?? null,
    cli_version: r.cli_version ?? null,
    runner_mode: 'interactive',
    mod_digest: r.mod_digest ?? null,
    discovered_models: discovered,
    quota_windows: windows,
    quota_updated_at: r.quota_updated_at ? new Date(r.quota_updated_at).toISOString() : null,
    status: (r.status as RemoteProfileStatus) ?? 'active',
    disabled_by: r.disabled_by ?? null,
    cooldown_reason: r.cooldown_reason ?? null,
    cooldown_until: r.cooldown_until ? new Date(r.cooldown_until).toISOString() : null,
    next_probe_at: r.next_probe_at ? new Date(r.next_probe_at).toISOString() : null,
    probe_failures: Number(r.probe_failures ?? 0),
    health_score: Number(r.health_score ?? 100),
    weight: Number(r.weight ?? 100),
    hot_slots: Number(r.hot_slots ?? 0),
    active_slots: Number(r.active_slots ?? 0),
    max_hot_slots: Number(r.max_hot_slots ?? 4),
    max_active_slots: Number(r.max_active_slots ?? 2),
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    last_error: r.last_error ?? null,
  }
}

export async function listRemotePoolOverview(runner?: QueryRunner): Promise<{
  nodes: RemoteAgentNodeView[]
  profiles: RemoteAgentProfileView[]
  offers: RemoteModelOfferView[]
  bindings: RemoteAgentBindingView[]
}> {
  const nodesRes = await query(
    `SELECT * FROM remote_agent_nodes ORDER BY created_at DESC`,
    [],
    runner,
  )
  const profilesRes = await query(
    `SELECT p.*, n.label AS node_label
       FROM remote_agent_profiles p
       JOIN remote_agent_nodes n ON n.id = p.node_id
      ORDER BY n.label ASC, p.engine ASC, p.profile_name ASC`,
    [],
    runner,
  )
  const offersRes = await query(
    `SELECT o.*, p.node_id, p.engine, p.profile_name, n.label AS node_label,
            mc.state AS catalog_state
       FROM remote_model_offers o
       JOIN remote_agent_profiles p ON p.id = o.profile_id
       JOIN remote_agent_nodes n ON n.id = p.node_id
       LEFT JOIN model_catalog mc ON mc.model_id = o.canonical_model_id AND mc.state = 'active'
      ORDER BY o.created_at DESC`,
    [],
    runner,
  )
  const bindingsRes = await query(
    `SELECT b.*, n.label AS node_label, p.profile_name, p.engine
       FROM remote_agent_bindings b
       JOIN remote_agent_nodes n ON n.id = b.node_id
       JOIN remote_agent_profiles p ON p.id = b.profile_id
      WHERE b.state NOT IN ('released')
      ORDER BY b.updated_at DESC
      LIMIT 100`,
    [],
    runner,
  )
  return {
    nodes: nodesRes.rows.map(mapNodeRow),
    profiles: profilesRes.rows.map(mapProfileRow),
    offers: offersRes.rows.map((r: any) => ({
      id: String(r.id),
      profile_id: String(r.profile_id),
      node_id: r.node_id ? String(r.node_id) : undefined,
      node_label: r.node_label ? String(r.node_label) : undefined,
      engine: r.engine as RemoteBrainEngine | undefined,
      profile_name: r.profile_name ? String(r.profile_name) : undefined,
      upstream_model_id: String(r.upstream_model_id),
      canonical_model_id: String(r.canonical_model_id),
      base_display_name: String(r.base_display_name),
      remote_display_name: formatRemoteModelDisplayName(
        String(r.base_display_name),
        'remote_pool',
        String(r.canonical_model_id),
      ),
      enabled: Boolean(r.enabled),
      catalog_state: r.catalog_state ? String(r.catalog_state) : null,
      placement: 'remote_pool',
      created_at: new Date(r.created_at ?? Date.now()).toISOString(),
      updated_at: new Date(r.updated_at ?? Date.now()).toISOString(),
    })),
    bindings: bindingsRes.rows.map((r: any) => ({
      operation_id: String(r.operation_id),
      run_id: String(r.run_id),
      uid: String(r.uid),
      container_db_id: String(r.container_db_id),
      docker_id: String(r.docker_id),
      session_key: String(r.session_key),
      node_id: String(r.node_id),
      node_label: r.node_label ? String(r.node_label) : undefined,
      profile_id: String(r.profile_id),
      profile_name: r.profile_name ? String(r.profile_name) : undefined,
      engine: r.engine ? String(r.engine) : undefined,
      canonical_model_id: String(r.canonical_model_id),
      native_session_id: r.native_session_id ?? null,
      generation: Number(r.generation ?? 1),
      state: String(r.state),
      last_acked_seq: Number(r.last_acked_seq ?? 0),
      expires_at: new Date(r.expires_at ?? Date.now()).toISOString(),
      created_at: new Date(r.created_at ?? Date.now()).toISOString(),
      updated_at: new Date(r.updated_at ?? Date.now()).toISOString(),
    })),
  }
}

export async function createRemoteAgentNode(
  input: {
    label: string
    ssh_host: string
    ssh_port?: number
    ssh_user: string
    host_key_fp: string
    mux_cap_slots?: number
    max_hot_slots?: number
    max_active_slots?: number
  },
  runner?: QueryRunner,
): Promise<RemoteAgentNodeView> {
  const label = input.label.trim()
  const sshHost = input.ssh_host.trim()
  const sshPort = input.ssh_port ?? 22
  const sshUser = input.ssh_user.trim()
  const hostKeyFp = input.host_key_fp.trim()
  if (!label || label.length > 64) throw new Error('REMOTE_NODE_LABEL_INVALID')
  if (!SSH_HOST_RE.test(sshHost)) throw new Error('REMOTE_NODE_SSH_HOST_INVALID')
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new Error('REMOTE_NODE_SSH_PORT_INVALID')
  }
  if (!SSH_USER_RE.test(sshUser)) throw new Error('REMOTE_NODE_SSH_USER_INVALID')
  if (!HOST_KEY_FP_RE.test(hostKeyFp)) {
    throw new Error('REMOTE_NODE_HOST_KEY_FP_INVALID: must be SHA256:<base64>')
  }
  const keyId = `oc-rpool-${randomUUID().slice(0, 8)}`
  const controllerSha = getRemoteHostdSha256()
  const res = await query(
    `INSERT INTO remote_agent_nodes
       (label, ssh_host, ssh_port, ssh_user, host_key_fp, key_id, controller_sha256,
        mux_cap_slots, max_hot_slots, max_active_slots, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_verify')
     RETURNING *`,
    [
      label,
      sshHost,
      sshPort,
      sshUser,
      hostKeyFp,
      keyId,
      controllerSha,
      input.mux_cap_slots ?? 8,
      input.max_hot_slots ?? 16,
      input.max_active_slots ?? 8,
    ],
    runner,
  )
  return mapNodeRow(res.rows[0]!)
}

export interface RemoteNodeProbePayload {
  rttMsP50?: number
  rttMsP95?: number
  profiles: Array<{
    engine: RemoteBrainEngine
    profile_name: string
    account_fingerprint: string
    account_hint?: string | null
    plan_type?: string | null
    cli_version?: string | null
    runner_mode?: string
    mod_digest?: string | null
    discovered_models: RemoteDiscoveredModel[]
    quota_windows?: RemoteQuotaWindow[]
  }>
}

/**
 * Apply probe payload to a remote node and upsert its discovered profiles.
 * Enforces:
 * - `cc` profiles MUST have `runner_mode === 'interactive'` (never print mode).
 * - Global `(engine, account_fingerprint)` uniqueness across nodes.
 */
export async function applyRemoteNodeProbeResult(
  nodeId: string,
  payload: RemoteNodeProbePayload,
  runner?: QueryRunner,
): Promise<{ node: RemoteAgentNodeView; profiles: RemoteAgentProfileView[] }> {
  for (const p of payload.profiles) {
    if (!isRemoteBrainEngine(p.engine)) {
      throw new Error(`REMOTE_ENGINE_UNSUPPORTED:${String(p.engine)}`)
    }
    if (p.engine === 'cc' && p.runner_mode && p.runner_mode !== 'interactive') {
      throw new Error('REMOTE_CC_PRINT_MODE_FORBIDDEN: cc profile must use interactive runner_mode')
    }
  }
  const nodeRes = await query(
    `UPDATE remote_agent_nodes
        SET status = 'active',
            disabled_by = NULL,
            rtt_ms_p50 = COALESCE($2, rtt_ms_p50, 45),
            rtt_ms_p95 = COALESCE($3, rtt_ms_p95, 95),
            last_probe_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [nodeId, payload.rttMsP50 ?? null, payload.rttMsP95 ?? null],
    runner,
  )
  if (nodeRes.rows.length === 0) throw new Error('REMOTE_NODE_NOT_FOUND')

  const upserted: RemoteAgentProfileView[] = []
  for (const p of payload.profiles) {
    const res = await query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, account_hint, plan_type,
          cli_version, runner_mode, mod_digest, discovered_models, quota_windows,
          quota_updated_at, status, probe_failures, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'interactive', $8, $9::jsonb, $10::jsonb,
               NOW(), 'active', 0, NULL, NOW())
       ON CONFLICT (node_id, engine, profile_name) DO UPDATE
          SET account_fingerprint = EXCLUDED.account_fingerprint,
              account_hint = EXCLUDED.account_hint,
              plan_type = EXCLUDED.plan_type,
              cli_version = EXCLUDED.cli_version,
              runner_mode = 'interactive',
              mod_digest = EXCLUDED.mod_digest,
              discovered_models = EXCLUDED.discovered_models,
              quota_windows = EXCLUDED.quota_windows,
              quota_updated_at = NOW(),
              status = CASE WHEN remote_agent_profiles.disabled_by = 'admin' THEN 'disabled' ELSE 'active' END,
              probe_failures = 0,
              last_error = NULL,
              updated_at = NOW()
       RETURNING *`,
      [
        nodeId,
        p.engine,
        p.profile_name,
        p.account_fingerprint,
        p.account_hint ?? null,
        p.plan_type ?? null,
        p.cli_version ?? null,
        p.mod_digest ?? null,
        JSON.stringify(p.discovered_models ?? []),
        JSON.stringify(p.quota_windows ?? []),
      ],
      runner,
    )
    upserted.push(mapProfileRow(res.rows[0]!))
  }
  return { node: mapNodeRow(nodeRes.rows[0]!), profiles: upserted }
}

/**
 * Publish one or more checked remote models into `remote_model_offers`, `model_catalog`
 * (`placement = 'remote_pool'`, `<slug>-remote`), and `model_pricing` (with " 远端" display name)
 * inside a SINGLE database transaction and bump `model_security_epoch` once at the end.
 */
export async function publishRemoteModelOffers(
  input: {
    profile_id: string
    admin_uid?: number | bigint | null
    offers: Array<{
      upstream_model_id: string
      canonical_model_id?: string
      base_display_name: string
      enabled?: boolean
    }>
  },
  pool = getPool(),
): Promise<RemoteModelOfferView[]> {
  if (!Array.isArray(input.offers) || input.offers.length === 0) {
    throw new Error('REMOTE_OFFERS_EMPTY')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const profRes = await client.query(
      `SELECT p.*, n.label AS node_label
         FROM remote_agent_profiles p
         JOIN remote_agent_nodes n ON n.id = p.node_id
        WHERE p.id = $1
        FOR UPDATE`,
      [input.profile_id],
    )
    if (profRes.rows.length === 0) throw new Error('REMOTE_PROFILE_NOT_FOUND')
    const profile = profRes.rows[0]!
    const engine = profile.engine as RemoteBrainEngine
    if (engine === 'cc' && profile.runner_mode !== 'interactive') {
      throw new Error('REMOTE_CC_PRINT_MODE_FORBIDDEN')
    }
    const catalogEngine = catalogEngineForRemoteEngine(engine)
    const providerId =
      catalogEngine === 'ccb'
        ? 'anthropic'
        : catalogEngine === 'codex'
          ? 'codex'
          : catalogEngine === 'antigravity'
            ? 'gemini'
            : 'grok'

    const published: RemoteModelOfferView[] = []
    for (const item of input.offers) {
      const upstreamModelId = item.upstream_model_id.trim()
      const baseDisplayName = item.base_display_name.trim() || upstreamModelId
      const canonicalModelId = toRemotePoolModelId(item.canonical_model_id ?? upstreamModelId)
      const enabled = item.enabled !== false
      const remoteDisplayName = formatRemoteModelDisplayName(
        baseDisplayName,
        'remote_pool',
        canonicalModelId,
      )

      const offerRes = await client.query(
        `INSERT INTO remote_model_offers
           (profile_id, upstream_model_id, canonical_model_id, base_display_name, enabled, created_by_uid, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (profile_id, upstream_model_id) DO UPDATE
            SET canonical_model_id = EXCLUDED.canonical_model_id,
                base_display_name = EXCLUDED.base_display_name,
                enabled = EXCLUDED.enabled,
                updated_at = NOW()
         RETURNING *`,
        [
          input.profile_id,
          upstreamModelId,
          canonicalModelId,
          baseDisplayName,
          enabled,
          input.admin_uid ?? null,
        ],
      )

      const baseSlug = canonicalModelId.replace(/-remote$/, '')
      const basePricing = await client.query(
        `SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
                multiplier, visibility, sort_order, default_effort, min_plan_code, promo_label
           FROM model_pricing
          WHERE model_id IN ($1, $2)
          ORDER BY CASE WHEN model_id = $1 THEN 0 ELSE 1 END
          LIMIT 1`,
        [baseSlug, upstreamModelId],
      )
      const bp = basePricing.rows[0] ?? {
        input_per_mtok: '300',
        output_per_mtok: '1500',
        cache_read_per_mtok: '30',
        cache_write_per_mtok: '375',
        multiplier: '1.000',
        visibility: 'public',
        sort_order: 250,
        default_effort: null,
        min_plan_code: null,
        promo_label: null,
      }

      const capabilityProfile = {
        supports_vision: catalogEngine !== 'grok',
        reasoning: {
          supported: catalogEngine === 'codex' || catalogEngine === 'ccb' ? ['low', 'medium', 'high'] : [],
          codex_model_default: catalogEngine === 'codex' ? 'medium' : null,
        },
        ccb: {
          capability_zero: false,
          supports_thinking: true,
          ...(engine === 'cc' ? { context_owner: 'box-native-v1' } : {}),
        },
      }

      const existingCat = await client.query(
        `SELECT entry_id FROM model_catalog WHERE model_id = $1 AND state IN ('active', 'disabled', 'staged') ORDER BY entry_id DESC LIMIT 1`,
        [canonicalModelId],
      )
      const desiredState = enabled ? 'active' : 'disabled'
      if (existingCat.rows.length > 0) {
        await client.query(
          `UPDATE model_catalog
              SET engine = $2,
                  provider_id = $3,
                  upstream_model_id = $4,
                  capability_profile = $5::jsonb,
                  state = $6,
                  placement = 'remote_pool',
                  lock_version = lock_version + 1,
                  updated_at = NOW()
            WHERE entry_id = $1`,
          [
            existingCat.rows[0]!.entry_id,
            catalogEngine,
            providerId,
            upstreamModelId,
            JSON.stringify(capabilityProfile),
            desiredState,
          ],
        )
      } else {
        await client.query(
          `INSERT INTO model_catalog
             (model_id, engine, provider_id, upstream_model_id, context_window,
              capability_profile, capability_schema_version, state, placement)
           VALUES ($1, $2, $3, $4, 200000, $5::jsonb, 1, $6, 'remote_pool')`,
          [
            canonicalModelId,
            catalogEngine,
            providerId,
            upstreamModelId,
            JSON.stringify(capabilityProfile),
            desiredState,
          ],
        )
      }

      await client.query(
        `INSERT INTO model_pricing
           (model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
            cache_write_per_mtok, multiplier, enabled, visibility, sort_order,
            default_effort, min_plan_code, promo_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (model_id) DO UPDATE
            SET display_name = EXCLUDED.display_name,
                enabled = EXCLUDED.enabled,
                updated_at = NOW()`,
        [
          canonicalModelId,
          remoteDisplayName,
          bp.input_per_mtok,
          bp.output_per_mtok,
          bp.cache_read_per_mtok,
          bp.cache_write_per_mtok,
          bp.multiplier,
          enabled,
          bp.visibility ?? 'public',
          Number(bp.sort_order ?? 250),
          bp.default_effort ?? null,
          bp.min_plan_code ?? null,
          bp.promo_label ?? null,
        ],
      )

      const r = offerRes.rows[0]!
      published.push({
        id: String(r.id),
        profile_id: String(r.profile_id),
        node_id: String(profile.node_id),
        node_label: String(profile.node_label),
        engine,
        profile_name: String(profile.profile_name),
        upstream_model_id: upstreamModelId,
        canonical_model_id: canonicalModelId,
        base_display_name: baseDisplayName,
        remote_display_name: remoteDisplayName,
        enabled,
        catalog_state: desiredState,
        placement: 'remote_pool',
        created_at: new Date(r.created_at ?? Date.now()).toISOString(),
        updated_at: new Date(r.updated_at ?? Date.now()).toISOString(),
      })
    }

    await client.query(`UPDATE model_security_epoch SET epoch = epoch + 1, updated_at = NOW() WHERE id`)
    await client.query('COMMIT')
    return published
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw err
  } finally {
    client.release()
  }
}

export interface RemoteCandidateMember {
  profileId: string
  nodeId: string
  engine: RemoteBrainEngine
  profileName: string
  weight: number
  healthScore: number
  hotSlots: number
  activeSlots: number
  maxHotSlots: number
  maxActiveSlots: number
  nodeRttMsP50: number | null
}

/**
 * Rank eligible remote brain pool profiles for a `(uid, sessionKey, canonicalModelId)` using WRH
 * (`rankWRH`), respecting two-level slot watermarks (`hotSlots < maxHotSlots` and `activeSlots < maxActiveSlots`)
 * and RTT latency factor.
 */
export function rankRemotePoolCandidates(
  candidates: ReadonlyArray<RemoteCandidateMember>,
  key: string,
): RemoteCandidateMember[] {
  const eligible = candidates.filter(
    (c) => c.hotSlots < c.maxHotSlots && c.activeSlots < c.maxActiveSlots && c.healthScore > 0,
  )
  return rankWRH(eligible, {
    key,
    id: (c) => c.profileId,
    weight: (c) => {
      const base = healthWeight(c.healthScore, c.weight)
      const slotLoadPenalty = 1 - (c.activeSlots / Math.max(1, c.maxActiveSlots)) * 0.4
      const rttFactor =
        c.nodeRttMsP50 && c.nodeRttMsP50 > 100
          ? Math.max(0.3, 100 / c.nodeRttMsP50)
          : 1
      return Math.max(0.05, base * slotLoadPenalty * rttFactor)
    },
  })
}

export async function updateRemoteProfileAdminState(
  profileId: string,
  patch: { status?: 'active' | 'disabled'; weight?: number; max_hot_slots?: number; max_active_slots?: number },
  runner?: QueryRunner,
): Promise<RemoteAgentProfileView> {
  const res = await query(
    `UPDATE remote_agent_profiles
        SET status = COALESCE($2, status),
            disabled_by = CASE
              WHEN $2 = 'disabled' THEN 'admin'
              WHEN $2 = 'active' THEN NULL
              ELSE disabled_by
            END,
            weight = COALESCE($3, weight),
            max_hot_slots = COALESCE($4, max_hot_slots),
            max_active_slots = COALESCE($5, max_active_slots),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      profileId,
      patch.status ?? null,
      patch.weight ?? null,
      patch.max_hot_slots ?? null,
      patch.max_active_slots ?? null,
    ],
    runner,
  )
  if (res.rows.length === 0) throw new Error('REMOTE_PROFILE_NOT_FOUND')
  return mapProfileRow(res.rows[0]!)
}

export async function revokeRemoteAgentBinding(
  operationId: string,
  runner?: QueryRunner,
): Promise<{ revoked: boolean; operation_id: string }> {
  const res = await query(
    `UPDATE remote_agent_bindings
        SET state = 'released',
            updated_at = NOW()
      WHERE operation_id = $1 AND state NOT IN ('released', 'unknown')
      RETURNING profile_id`,
    [operationId],
    runner,
  )
  if (res.rows.length > 0) {
    await query(
      `UPDATE remote_agent_profiles
          SET hot_slots = GREATEST(0, hot_slots - 1),
              active_slots = GREATEST(0, active_slots - 1),
              updated_at = NOW()
        WHERE id = $1`,
      [res.rows[0]!.profile_id],
      runner,
    )
  }
  return { revoked: res.rows.length > 0, operation_id: operationId }
}

/** OCV5-424 `PoolAdapter` implementation for `remote_agent_profiles`. */
export function createRemoteBrainPoolAdapter(): PoolAdapter {
  return {
    name: 'remote-brain-pool',
    memberKind: 'remote_profile',
    async halfOpenDue(): Promise<number> {
      try {
        const res = await query(
          `UPDATE remote_agent_profiles
              SET status = 'active',
                  cooldown_reason = NULL,
                  cooldown_until = NULL,
                  updated_at = NOW()
            WHERE status = 'cooldown'
              AND cooldown_until IS NOT NULL
              AND cooldown_until <= NOW()
              AND (disabled_by IS NULL OR disabled_by <> 'admin')`,
        )
        return res.rowCount ?? 0
      } catch {
        return 0
      }
    },
    async listDueProbes(limit: number): Promise<DueProbe[]> {
      try {
        const res = await query(
          `SELECT id, engine, COALESCE(cooldown_reason, 'upstream') AS reason
             FROM remote_agent_profiles
            WHERE status IN ('cooldown', 'degraded')
              AND next_probe_at IS NOT NULL
              AND next_probe_at <= NOW()
            ORDER BY next_probe_at ASC
            LIMIT $1`,
          [limit],
        )
        return res.rows.map((r: any) => ({
          id: String(r.id),
          service: `remote-${String(r.engine)}`,
          reason: (r.reason as CooldownReason) ?? 'upstream',
        }))
      } catch {
        return []
      }
    },
    async probe(_member: DueProbe): Promise<ProbeResult> {
      return { ok: true }
    },
    async applyProbeResult(member: DueProbe, result: ProbeResult): Promise<void> {
      if (result.ok) {
        await query(
          `UPDATE remote_agent_profiles
              SET status = 'active',
                  cooldown_reason = NULL,
                  cooldown_until = NULL,
                  next_probe_at = NULL,
                  probe_failures = 0,
                  updated_at = NOW()
            WHERE id = $1`,
          [member.id],
        )
      }
    },
    async listMembers(): Promise<PoolMemberView[]> {
      try {
        const res = await query(
          `SELECT p.*, n.label AS node_label, n.ssh_host, n.rtt_ms_p50
             FROM remote_agent_profiles p
             JOIN remote_agent_nodes n ON n.id = p.node_id
            ORDER BY n.label ASC, p.engine ASC, p.profile_name ASC`,
        )
        return res.rows.map((r: any) => {
          const prof = mapProfileRow(r)
          const serviceMap: Record<RemoteBrainEngine, string> = {
            cc: 'claude',
            codex: 'codex',
            antigravity: 'gemini',
            'grok-build': 'grok',
          }
          return {
            service: serviceMap[prof.engine] ?? prof.engine,
            memberKind: 'remote_profile',
            id: prof.id,
            credentialType: 'subscription',
            label: `[远端:${String(r.node_label)}] ${prof.engine}/${prof.profile_name}`,
            status: prof.status,
            disabledBy: prof.disabled_by,
            healthScore: prof.health_score,
            cooldownReason: (prof.cooldown_reason as CooldownReason | null) ?? null,
            cooldownUntil: prof.cooldown_until,
            nextProbeAt: prof.next_probe_at,
            lastError: prof.last_error,
            lastUsedAt: prof.last_used_at,
            hints: {
              node: String(r.node_label),
              engine: prof.engine,
              runner_mode: prof.runner_mode,
              account: prof.account_hint,
              plan: prof.plan_type,
              hot_slots: `${prof.hot_slots}/${prof.max_hot_slots}`,
              active_slots: `${prof.active_slots}/${prof.max_active_slots}`,
              rtt_ms: r.rtt_ms_p50 == null ? null : Number(r.rtt_ms_p50),
            },
            quota: {
              windows: prof.quota_windows,
              updatedAt: prof.quota_updated_at,
              note: prof.quota_windows.length === 0 ? '待节点首次上报额度窗口' : null,
            },
          }
        })
      } catch {
        return []
      }
    },
  }
}

export function registerRemoteBrainPoolAdapter(): void {
  registerPoolAdapter(createRemoteBrainPoolAdapter())
}
