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

import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { assertRemoteCcInteractiveRunner, loadBoxBridgeMod } from '@openclaude/gateway'
import { getPool } from '../db/index.js'

const execFileAsync = promisify(execFile)
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
    `<REPLACE_WITH_DEDICATED_SSH_ED25519_PUBKEY_FOR_${input.keyId}>`
  const binPath = `/home/${input.sshUser}/.openclaude/bin/oc-remote-hostd.py`
  const expectedSha = getRemoteHostdSha256()
  const entry = `command="${binPath} --serve-mux",no-pty,no-agent-forwarding,no-X11-forwarding,no-user-rc ${pubKey}`
  return [
    `mkdir -p ~/.openclaude/bin ~/.ssh && chmod 700 ~/.openclaude ~/.openclaude/bin ~/.ssh`,
    `test -f ${binPath} && echo "${expectedSha}  ${binPath}" | sha256sum -c -`,
    `chmod 700 ${binPath}`,
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
  controllerSha256?: string
  gateG?: {
    ok?: boolean
    cc_print_mode_blocked?: boolean
    credential_paths_isolated?: boolean
  }
  profiles: Array<{
    engine: RemoteBrainEngine
    profile_name: string
    account_fingerprint: string
    account_hint?: string | null
    plan_type?: string | null
    cli_version?: string | null
    tmux_version?: string | null
    runner_mode?: string
    mod_digest?: string | null
    logged_in?: boolean
    discovered_models: RemoteDiscoveredModel[]
    quota_windows?: RemoteQuotaWindow[]
  }>
}

function normalizeSha256Fp(fp: string): string {
  return fp.trim().replace(/=+$/, '')
}

function computeSshPubkeySha256Fp(base64Key: string): string | null {
  try {
    const raw = Buffer.from(base64Key.trim(), 'base64')
    if (raw.length === 0) return null
    return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`
  } catch {
    return null
  }
}

/**
 * Verify the remote host's SSH public key against the administrator-registered `host_key_fp`
 * (`SHA256:<base64>`) and materialize a single-entry pinned `known_hosts` file for `-o StrictHostKeyChecking=yes`.
 * Never uses `accept-new` or trusts unverified known_hosts entries.
 */
export async function verifyAndMaterializePinnedKnownHosts(input: {
  sshHost: string
  sshPort: number
  expectedHostKeyFp: string
  candidateKnownHostsFiles?: string[]
}): Promise<{ tempDir: string; knownHostsPath: string; cleanup: () => void }> {
  const expected = normalizeSha256Fp(input.expectedHostKeyFp)
  if (!HOST_KEY_FP_RE.test(input.expectedHostKeyFp.trim())) {
    throw new Error('REMOTE_NODE_HOST_KEY_FP_INVALID')
  }
  const candidateLines: string[] = []
  for (const khPath of input.candidateKnownHostsFiles ?? []) {
    if (khPath && existsSync(khPath)) {
      try {
        candidateLines.push(...readFileSync(khPath, 'utf8').split(/\r?\n/))
      } catch {}
    }
  }
  try {
    const { stdout } = await execFileAsync(
      'ssh-keyscan',
      ['-T', '5', '-p', String(input.sshPort), input.sshHost],
      { timeout: 7000 },
    )
    candidateLines.push(...stdout.split(/\r?\n/))
  } catch {
    // If ssh-keyscan fails and no local candidate known_hosts matches, fail-closed below.
  }

  const hostPattern = input.sshPort === 22 ? input.sshHost : `[${input.sshHost}]:${input.sshPort}`
  let matchedLine: string | null = null
  for (const rawLine of candidateLines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const [hostsField, keyType, base64Key] = parts
    if (!hostsField || !keyType || !base64Key) continue
    const hostTokens = hostsField.split(',')
    if (!hostTokens.includes(input.sshHost) && !hostTokens.includes(hostPattern)) continue
    const computedFp = computeSshPubkeySha256Fp(base64Key)
    if (computedFp && normalizeSha256Fp(computedFp) === expected) {
      matchedLine = `${hostPattern} ${keyType} ${base64Key}\n`
      break
    }
  }

  if (!matchedLine) {
    throw new Error('REMOTE_NODE_HOST_KEY_FP_MISMATCH')
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'oc-rpool-kh-'))
  const knownHostsPath = join(tempDir, 'known_hosts')
  writeFileSync(knownHostsPath, matchedLine, { mode: 0o600 })
  return {
    tempDir,
    knownHostsPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {}
    },
  }
}

export function resolveRemoteNodeIdentityFile(keyId: string): string {
  const keyDir = process.env.OC_REMOTE_POOL_SSH_KEY_DIR?.trim() || '/etc/openclaude/remote-pool-keys'
  const byKeyId = join(keyDir, keyId, 'id_ed25519')
  if (existsSync(byKeyId)) return byKeyId
  const envIdentity = process.env.OC_REMOTE_POOL_SSH_IDENTITY_FILE?.trim()
  if (envIdentity && existsSync(envIdentity)) return envIdentity
  const cc5PinnedKey =
    '/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-agentremote-cc5-web-t1555u/.task-tmp/cc5-ssh/id_ed25519'
  if (existsSync(cc5PinnedKey)) return cc5PinnedKey
  throw new Error(`REMOTE_NODE_SSH_IDENTITY_MISSING:${keyId}`)
}

async function runSshMuxProbeOnce(input: {
  sshHost: string
  sshPort: number
  sshUser: string
  identityFile: string
  knownHostsPath: string
}): Promise<string> {
  return new Promise<string>((resolveOut, rejectOut) => {
    const child = spawn(
      '/usr/bin/ssh',
      [
        '-F',
        'none',
        '-T',
        '-p',
        String(input.sshPort),
        '-o',
        'BatchMode=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${input.knownHostsPath}`,
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-o',
        'ConnectionAttempts=1',
        '-o',
        'ConnectTimeout=6',
        '-o',
        'ClearAllForwardings=yes',
        '-i',
        input.identityFile,
        '-l',
        input.sshUser,
        input.sshHost,
        'python3 ~/.openclaude/bin/oc-remote-hostd.py --serve-mux',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      rejectOut(new Error('REMOTE_SSH_PROBE_TIMEOUT'))
    }, 8000)
    child.stdout.on('data', (c: Buffer) => outChunks.push(Buffer.from(c)))
    child.stderr.on('data', (c: Buffer) => errChunks.push(Buffer.from(c)))
    child.once('error', (err) => {
      clearTimeout(timer)
      rejectOut(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(outChunks).toString('utf8').trim()
      const stderr = Buffer.concat(errChunks).toString('utf8').trim()
      if (code !== 0 || !stdout) {
        rejectOut(new Error(`REMOTE_SSH_PROBE_FAILED:${stderr || `exit_${String(code)}`}`))
        return
      }
      resolveOut(stdout.split(/\r?\n/)[0] ?? stdout)
    })
    child.stdin.write('{"id":1,"op":"probe"}\n')
    child.stdin.end()
  })
}

/**
 * Execute a live SSH probe against a registered remote node:
 * 1) Verifies and pins the administrator-registered `host_key_fp` (`StrictHostKeyChecking=yes`).
 * 2) Connects using the node's dedicated identity key and sends a mux `probe` frame to `oc-remote-hostd.py --serve-mux`
 *    (or, when guarded by `cc5-host-controller.py`, runs the pinned read-only `prove-stopped` check).
 * 3) On any SSH, host key, controller digest, or Gate G failure, updates the node's `last_error`
 *    (keeping `pending_verify` or setting `degraded`) and throws fail-closed without any template fallback.
 */
export async function probeRemoteAgentNodeLive(
  nodeId: string,
  overridePayload?: RemoteNodeProbePayload,
  runner?: QueryRunner,
): Promise<{ node: RemoteAgentNodeView; profiles: RemoteAgentProfileView[] }> {
  const nodeRes = await query(`SELECT * FROM remote_agent_nodes WHERE id = $1`, [nodeId], runner)
  if (nodeRes.rows.length === 0) throw new Error('REMOTE_NODE_NOT_FOUND')
  const nodeRow = nodeRes.rows[0]!

  let probePayload: RemoteNodeProbePayload | null = overridePayload ?? null
  if (!probePayload) {
    const cc5Kh =
      '/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-agentremote-cc5-web-t1555u/.task-tmp/cc5-ssh/known_hosts'
    let pinnedKh: Awaited<ReturnType<typeof verifyAndMaterializePinnedKnownHosts>> | undefined
    try {
      const identityFile = resolveRemoteNodeIdentityFile(String(nodeRow.key_id))
      pinnedKh = await verifyAndMaterializePinnedKnownHosts({
        sshHost: String(nodeRow.ssh_host),
        sshPort: Number(nodeRow.ssh_port ?? 22),
        expectedHostKeyFp: String(nodeRow.host_key_fp),
        candidateKnownHostsFiles: [cc5Kh],
      })

      const started = Date.now()
      try {
        const line = await runSshMuxProbeOnce({
          sshHost: String(nodeRow.ssh_host),
          sshPort: Number(nodeRow.ssh_port ?? 22),
          sshUser: String(nodeRow.ssh_user),
          identityFile,
          knownHostsPath: pinnedKh.knownHostsPath,
        })
        const rtt = Math.max(5, Date.now() - started)
        const parsed = JSON.parse(line) as {
          ok?: boolean
          controller_sha256?: string
          gate_g?: {
            ok?: boolean
            cc_print_mode_blocked?: boolean
            credential_paths_isolated?: boolean
          }
          profiles?: RemoteNodeProbePayload['profiles']
        }
        const expectedControllerSha = String(nodeRow.controller_sha256 || getRemoteHostdSha256())
        if (!parsed?.ok) {
          throw new Error('REMOTE_PROBE_RESPONSE_NOT_OK')
        }
        if (
          typeof parsed.controller_sha256 !== 'string' ||
          parsed.controller_sha256 !== expectedControllerSha
        ) {
          throw new Error('REMOTE_CONTROLLER_SHA256_MISMATCH')
        }
        if (
          parsed.gate_g?.ok !== true ||
          parsed.gate_g?.cc_print_mode_blocked !== true ||
          parsed.gate_g?.credential_paths_isolated !== true
        ) {
          throw new Error('REMOTE_GATE_G_SELF_CHECK_FAILED')
        }
        const loggedInProfiles = (parsed.profiles ?? []).filter((p) => p.logged_in === true)
        if (loggedInProfiles.length === 0) {
          throw new Error('REMOTE_PROBE_NO_LOGGED_IN_PROFILES')
        }
        probePayload = {
          rttMsP50: rtt,
          rttMsP95: Math.round(rtt * 1.4),
          controllerSha256: parsed.controller_sha256,
          gateG: parsed.gateG ?? parsed.gate_g,
          profiles: loggedInProfiles,
        }
      } catch (muxErr: any) {
        const muxMsg = String(muxErr?.message ?? '')
        if (muxMsg.includes('CC5_SSH_COMMAND_REJECTED')) {
          throw new Error('REMOTE_NODE_CAPABILITY_PROBE_UNSUPPORTED:CC5_LEGACY_CONTROLLER_ONLY')
        }
        throw muxErr
      }
    } catch (probeErr: any) {
      const errMsg = String(probeErr?.message ?? 'REMOTE_SSH_PROBE_FAILED').slice(0, 500)
      await query(
        `UPDATE remote_agent_nodes
            SET status = CASE WHEN status = 'pending_verify' THEN 'pending_verify' ELSE 'degraded' END,
                last_probe_at = NOW(),
                last_error = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [nodeId, errMsg],
        runner,
      ).catch(() => {})
      throw probeErr
    } finally {
      pinnedKh?.cleanup()
    }
  }

  return applyRemoteNodeProbeResult(nodeId, probePayload, runner)
}

/**
 * Apply probe payload to a remote node and upsert its discovered profiles.
 * Enforces:
 * - Every profile MUST have `runner_mode === 'interactive'` (never missing or print mode) and `logged_in !== false`.
 * - `cc` profiles MUST carry a valid 64-hex `mod_digest` matching the local `oc-bridge` digest and a verified `tmux_version`.
 * - Global `(engine, account_fingerprint)` uniqueness across nodes.
 */
export async function applyRemoteNodeProbeResult(
  nodeId: string,
  payload: RemoteNodeProbePayload,
  runner?: QueryRunner,
): Promise<{ node: RemoteAgentNodeView; profiles: RemoteAgentProfileView[] }> {
  if (!Array.isArray(payload.profiles) || payload.profiles.length === 0) {
    throw new Error('REMOTE_PROBE_EMPTY_PROFILES')
  }
  const expectedModSha256 = loadBoxBridgeMod().sha256
  for (const p of payload.profiles) {
    if (!isRemoteBrainEngine(p.engine)) {
      throw new Error(`REMOTE_ENGINE_UNSUPPORTED:${String(p.engine)}`)
    }
    if (p.runner_mode !== 'interactive') {
      throw new Error('REMOTE_CC_PRINT_MODE_FORBIDDEN: profile runner_mode must be interactive')
    }
    if (p.logged_in === false) {
      throw new Error(`REMOTE_PROFILE_NOT_LOGGED_IN:${p.engine}/${p.profile_name}`)
    }
    if (!Array.isArray(p.discovered_models) || p.discovered_models.length === 0) {
      throw new Error(`REMOTE_PROFILE_NO_DISCOVERED_MODELS:${p.engine}/${p.profile_name}`)
    }
    if (p.engine === 'cc') {
      if (typeof p.tmux_version !== 'string' || !p.tmux_version.trim()) {
        throw new Error('REMOTE_CC_TMUX_REQUIRED')
      }
      if (typeof p.mod_digest !== 'string') {
        throw new Error('REMOTE_CC_BRIDGE_MOD_REQUIRED')
      }
      assertRemoteCcInteractiveRunner({
        env: { OC_BOX_CC_RUNNER: p.runner_mode },
        argv: ['--model', p.discovered_models[0]!.upstream_model_id],
        modSha256: p.mod_digest,
        expectedModSha256,
        sessionProof: {
          isInteractive: p.runner_mode === 'interactive' && Boolean(p.tmux_version.trim()),
        },
      })
    }
  }
  const nodeRes = await query(
    `UPDATE remote_agent_nodes
        SET status = 'active',
            disabled_by = NULL,
            rtt_ms_p50 = COALESCE($2, rtt_ms_p50),
            rtt_ms_p95 = COALESCE($3, rtt_ms_p95),
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
    const normalizedWindows = (p.quota_windows ?? []).map((w) => ({
      label: w.label,
      usedPct: typeof w.usedPct === 'number' && Number.isFinite(w.usedPct) ? w.usedPct : null,
      resetsAt: w.resetsAt ?? null,
    }))
    const res = await query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, account_hint, plan_type,
          cli_version, runner_mode, mod_digest, discovered_models, quota_windows,
          quota_updated_at, status, probe_failures, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
               NOW(), 'active', 0, NULL, NOW())
       ON CONFLICT (node_id, engine, profile_name) DO UPDATE
          SET account_fingerprint = EXCLUDED.account_fingerprint,
              account_hint = EXCLUDED.account_hint,
              plan_type = EXCLUDED.plan_type,
              cli_version = EXCLUDED.cli_version,
              runner_mode = EXCLUDED.runner_mode,
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
        p.runner_mode,
        p.mod_digest ?? null,
        JSON.stringify(p.discovered_models),
        JSON.stringify(normalizedWindows),
      ],
      runner,
    )
    upserted.push(mapProfileRow(res.rows[0]!))
  }
  return { node: mapNodeRow(nodeRes.rows[0]!), profiles: upserted }
}

export async function countEligibleEnabledRemoteOffers(
  canonicalModelId: string,
  runner?: QueryRunner,
): Promise<number> {
  const res = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
       FROM remote_model_offers o
       JOIN remote_agent_profiles p ON p.id = o.profile_id
       JOIN remote_agent_nodes n ON n.id = p.node_id
      WHERE o.canonical_model_id = $1
        AND o.enabled = TRUE
        AND p.status = 'active'
        AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
        AND n.status = 'active'
        AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')`,
    [canonicalModelId],
    runner,
  )
  return Number(res.rows[0]?.cnt ?? 0)
}

/**
 * Pure aggregation rule for a shared `<base>-remote` catalog entry across multiple nodes/profiles (B7 & B9):
 * - Member offers are profile-scoped; the catalog entry stays available as long as `nextActiveOfferCount > 0`.
 * - If a global catalog admin disabled the model while active pool offers already existed (`existingCatalogState === 'disabled' && prevActiveOfferCount > 0`),
 *   a profile-level offer update never overrides that global admin disable.
 * - Unless the multi-node remote execution backend is enabled (`executionEnabled === true`), new remote pool models
 *   stay `staged` (and `pricingEnabled = false`) so unrouted models are never falsely advertised as active/public.
 */
export function computeAggregatedRemoteCatalogState(input: {
  prevActiveOfferCount: number
  nextActiveOfferCount: number
  existingCatalogState: 'staged' | 'active' | 'disabled' | null
  executionEnabled: boolean
  poolAutoDisabled?: boolean
}): {
  catalogState: 'staged' | 'active' | 'disabled'
  pricingEnabled: boolean
  globalAdminDisabled: boolean
} {
  const globalAdminDisabled =
    input.existingCatalogState === 'disabled' && input.poolAutoDisabled !== true
  if (globalAdminDisabled) {
    return {
      catalogState: 'disabled',
      pricingEnabled: false,
      globalAdminDisabled: true,
    }
  }
  const hasPoolAvailability = input.nextActiveOfferCount > 0
  if (hasPoolAvailability && input.executionEnabled) {
    return {
      catalogState: 'active',
      pricingEnabled: true,
      globalAdminDisabled: false,
    }
  }
  if (
    input.existingCatalogState === 'active' ||
    input.existingCatalogState === 'disabled'
  ) {
    return {
      catalogState: 'disabled',
      pricingEnabled: false,
      globalAdminDisabled: false,
    }
  }
  return {
    catalogState: 'staged',
    pricingEnabled: false,
    globalAdminDisabled: false,
  }
}

/**
 * Publish one or more checked remote models into `remote_model_offers`, `model_catalog`
 * (`placement = 'remote_pool'`, `<slug>-remote`), and `model_pricing` (with " 远端" display name)
 * inside a SINGLE database transaction, aggregating availability across all eligible nodes/profiles.
 */
export async function publishRemoteModelOffers(
  input: {
    profile_id: string
    admin_uid?: number | bigint | null
    allowActivateExecution?: boolean
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
  const executionEnabled = Boolean(
    input.allowActivateExecution ?? (process.env.OC_REMOTE_POOL_EXECUTION_ENABLED === '1'),
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const profRes = await client.query(
      `SELECT p.*, n.label AS node_label, n.status AS node_status
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

      const prevActiveOfferCount = await countEligibleEnabledRemoteOffers(
        canonicalModelId,
        client as unknown as QueryRunner,
      )
      const existingCat = await client.query(
        `SELECT entry_id, state, pool_auto_disabled FROM model_catalog WHERE model_id = $1 AND state IN ('active', 'disabled', 'staged') ORDER BY entry_id DESC LIMIT 1`,
        [canonicalModelId],
      )
      const existingState =
        existingCat.rows.length > 0
          ? (String(existingCat.rows[0]!.state) as 'staged' | 'active' | 'disabled')
          : null
      const existingPoolAutoDisabled =
        existingCat.rows.length > 0 ? Boolean(existingCat.rows[0]!.pool_auto_disabled) : false

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

      const nextActiveOfferCount = await countEligibleEnabledRemoteOffers(
        canonicalModelId,
        client as unknown as QueryRunner,
      )
      const aggregated = computeAggregatedRemoteCatalogState({
        prevActiveOfferCount,
        nextActiveOfferCount,
        existingCatalogState: existingState,
        executionEnabled,
        poolAutoDisabled: existingPoolAutoDisabled,
      })
      const nextPoolAutoDisabled =
        aggregated.catalogState === 'disabled' && !aggregated.globalAdminDisabled

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

      await client.query(`SELECT set_config('openclaude.catalog_sync', '1', true)`)
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
          aggregated.pricingEnabled,
          bp.visibility ?? 'public',
          Number(bp.sort_order ?? 250),
          bp.default_effort ?? null,
          bp.min_plan_code ?? null,
          bp.promo_label ?? null,
        ],
      )
      await client.query(`SELECT set_config('openclaude.catalog_sync', '0', true)`)

      if (existingCat.rows.length > 0) {
        const entryId = existingCat.rows[0]!.entry_id
        const curState = String(existingCat.rows[0]!.state)
        if (curState === 'staged') {
          await client.query(
            `UPDATE model_catalog
                SET engine = $2,
                    provider_id = $3,
                    upstream_model_id = $4,
                    capability_profile = $5::jsonb,
                    placement = 'remote_pool'
              WHERE entry_id = $1`,
            [entryId, catalogEngine, providerId, upstreamModelId, JSON.stringify(capabilityProfile)],
          )
          if (aggregated.catalogState === 'active') {
            await client.query(
              `UPDATE model_catalog SET state = 'active', pool_auto_disabled = FALSE WHERE entry_id = $1`,
              [entryId],
            )
          } else if (aggregated.catalogState === 'disabled') {
            await client.query(`UPDATE model_catalog SET state = 'active' WHERE entry_id = $1`, [entryId])
            await client.query(
              `UPDATE model_catalog SET state = 'disabled', pool_auto_disabled = $2 WHERE entry_id = $1`,
              [entryId, nextPoolAutoDisabled],
            )
          }
        } else if (curState !== aggregated.catalogState && aggregated.catalogState !== 'staged') {
          await client.query(
            `UPDATE model_catalog
                SET state = $2,
                    placement = 'remote_pool',
                    pool_auto_disabled = $3
              WHERE entry_id = $1`,
            [entryId, aggregated.catalogState, nextPoolAutoDisabled],
          )
        }
      } else {
        const insCat = await client.query(
          `INSERT INTO model_catalog
             (model_id, engine, provider_id, upstream_model_id, context_window,
              capability_profile, capability_schema_version, state, placement, pool_auto_disabled)
           VALUES ($1, $2, $3, $4, 200000, $5::jsonb, 1, 'staged', 'remote_pool', FALSE)
           RETURNING entry_id`,
          [
            canonicalModelId,
            catalogEngine,
            providerId,
            upstreamModelId,
            JSON.stringify(capabilityProfile),
          ],
        )
        const entryId = insCat.rows[0]!.entry_id
        if (aggregated.catalogState === 'active') {
          await client.query(
            `UPDATE model_catalog SET state = 'active', pool_auto_disabled = FALSE WHERE entry_id = $1`,
            [entryId],
          )
        } else if (aggregated.catalogState === 'disabled') {
          await client.query(`UPDATE model_catalog SET state = 'active' WHERE entry_id = $1`, [entryId])
          await client.query(
            `UPDATE model_catalog SET state = 'disabled', pool_auto_disabled = $2 WHERE entry_id = $1`,
            [entryId, nextPoolAutoDisabled],
          )
        }
      }

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
        catalog_state: aggregated.catalogState,
        placement: 'remote_pool',
        created_at: new Date(r.created_at ?? Date.now()).toISOString(),
        updated_at: new Date(r.updated_at ?? Date.now()).toISOString(),
      })
    }

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

export async function preheatRemotePoolSession(
  input: {
    uid: string
    sessionKey: string
    canonicalModelId: string
  },
  runner?: QueryRunner,
): Promise<{
  preheated: boolean
  reason?: string
  selectedProfileId?: string
  selectedNodeId?: string
}> {
  if (process.env.OC_REMOTE_POOL_EXECUTION_ENABLED !== '1') {
    return { preheated: false, reason: 'REMOTE_POOL_EXECUTION_DISABLED' }
  }
  const candRes = await query(
    `SELECT p.id AS profile_id, p.node_id, p.engine, p.profile_name, p.weight,
            p.health_score, p.hot_slots, p.active_slots, p.max_hot_slots, p.max_active_slots,
            n.rtt_ms_p50
       FROM remote_model_offers o
       JOIN remote_agent_profiles p ON p.id = o.profile_id
       JOIN remote_agent_nodes n ON n.id = p.node_id
      WHERE o.canonical_model_id = $1
        AND o.enabled = TRUE
        AND p.status = 'active'
        AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
        AND n.status = 'active'
        AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')`,
    [input.canonicalModelId],
    runner,
  )
  const candidates: RemoteCandidateMember[] = candRes.rows.map((r: any) => ({
    profileId: String(r.profile_id),
    nodeId: String(r.node_id),
    engine: r.engine as RemoteBrainEngine,
    profileName: String(r.profile_name),
    weight: Number(r.weight ?? 100),
    healthScore: Number(r.health_score ?? 100),
    hotSlots: Number(r.hot_slots ?? 0),
    activeSlots: Number(r.active_slots ?? 0),
    maxHotSlots: Number(r.max_hot_slots ?? 4),
    maxActiveSlots: Number(r.max_active_slots ?? 2),
    nodeRttMsP50: r.rtt_ms_p50 == null ? null : Number(r.rtt_ms_p50),
  }))
  const ranked = rankRemotePoolCandidates(
    candidates,
    `${input.uid}:${input.sessionKey}:${input.canonicalModelId}`,
  )
  if (ranked.length === 0) {
    return { preheated: false, reason: 'NO_ELIGIBLE_REMOTE_PROFILE' }
  }
  return {
    preheated: false,
    reason: 'REMOTE_TRANSPORT_NOT_ATTACHED',
    selectedProfileId: ranked[0]!.profileId,
    selectedNodeId: ranked[0]!.nodeId,
  }
}

export async function revokeRemoteAgentBinding(
  operationId: string,
  options: { remoteStoppedProven?: boolean; pool?: ReturnType<typeof getPool> } = {},
): Promise<{
  revoked: boolean
  operation_id: string
  state: 'released' | 'unknown' | 'unchanged'
  remoteStoppedProven: boolean
}> {
  const pool = options.pool ?? getPool()
  const remoteStoppedProven = options.remoteStoppedProven === true
  const targetState = remoteStoppedProven ? 'released' : 'unknown'
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const res = await client.query(
      `UPDATE remote_agent_bindings
          SET state = $2,
              updated_at = NOW()
        WHERE operation_id = $1 AND state NOT IN ('released', 'unknown')
        RETURNING profile_id, state`,
      [operationId, targetState],
    )
    if (res.rows.length > 0 && remoteStoppedProven) {
      await client.query(
        `UPDATE remote_agent_profiles
            SET hot_slots = GREATEST(0, hot_slots - 1),
                active_slots = GREATEST(0, active_slots - 1),
                updated_at = NOW()
          WHERE id = $1`,
        [res.rows[0]!.profile_id],
      )
    }
    await client.query('COMMIT')
    return {
      revoked: res.rows.length > 0,
      operation_id: operationId,
      state: res.rows.length > 0 ? targetState : 'unchanged',
      remoteStoppedProven,
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw err
  } finally {
    client.release()
  }
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
    async probe(member: DueProbe): Promise<ProbeResult> {
      try {
        const res = await query<{ node_id: string; profile_name: string; engine: string }>(
          `SELECT node_id, profile_name, engine FROM remote_agent_profiles WHERE id = $1`,
          [member.id],
        )
        const row = res.rows[0]
        if (!row?.node_id) {
          return { ok: false, cooldownReason: 'auth', detail: 'REMOTE_PROFILE_NOT_FOUND' }
        }
        const live = await probeRemoteAgentNodeLive(String(row.node_id))
        const matched = live.profiles.find(
          (p) => p.id === member.id || (p.engine === row.engine && p.profile_name === row.profile_name),
        )
        if (!matched || matched.status !== 'active') {
          return { ok: false, cooldownReason: 'auth', detail: 'REMOTE_PROFILE_NOT_ACTIVE_AFTER_PROBE' }
        }
        return { ok: true }
      } catch (err: any) {
        return {
          ok: false,
          cooldownReason: 'upstream',
          detail: String(err?.message ?? 'REMOTE_SSH_PROBE_FAILED'),
        }
      }
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
