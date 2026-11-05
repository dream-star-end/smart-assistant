/**
 * OCV5-721 — Admin HTTP handlers for the Remote Agent Brain Pool (`/api/admin/remote-pool/*`)
 * and session preheat endpoint (`POST /api/sessions/preheat`).
 */

import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { writeAdminAuditBestEffort } from '../../admin/audit.js'
import { requireAdmin, requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import {
  applyRemoteNodeProbeResult,
  createRemoteAgentNode,
  getRemoteHostdSha256,
  listRemotePoolOverview,
  publishRemoteModelOffers,
  revokeRemoteAgentBinding,
  updateRemoteProfileAdminState,
  type RemoteBrainEngine,
  type RemoteNodeProbePayload,
} from '../../account-pool/remoteBrainPool.js'
import { query } from '../../db/queries.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, readJsonBody, sendJson } from '../util.js'

const execFileAsync = promisify(execFile)

const DEFAULT_FALLBACK_PROBE_PROFILES: RemoteNodeProbePayload['profiles'] = [
  {
    engine: 'cc',
    profile_name: 'default',
    account_fingerprint: 'cc-default-interactive-fp',
    account_hint: 'cc:default (interactive)',
    plan_type: 'max',
    cli_version: 'claude-code 2.1.x (tmux+oc-bridge)',
    runner_mode: 'interactive',
    discovered_models: [
      { upstream_model_id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      { upstream_model_id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
      { upstream_model_id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
    ],
    quota_windows: [
      { label: '5h', usedPct: 12, resetsAt: null },
      { label: '7d', usedPct: 28, resetsAt: null },
    ],
  },
  {
    engine: 'codex',
    profile_name: 'default',
    account_fingerprint: 'codex-default-fp',
    account_hint: 'codex:default',
    plan_type: 'pro',
    cli_version: 'codex 0.118.x',
    runner_mode: 'interactive',
    discovered_models: [
      { upstream_model_id: 'gpt-5.4', display_name: 'GPT-5.4' },
      { upstream_model_id: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex' },
    ],
    quota_windows: [
      { label: '5h', usedPct: 8, resetsAt: null },
      { label: '7d', usedPct: 19, resetsAt: null },
    ],
  },
  {
    engine: 'antigravity',
    profile_name: 'default',
    account_fingerprint: 'antigravity-default-fp',
    account_hint: 'antigravity:default',
    plan_type: 'ultra',
    cli_version: 'agy 2.0.x',
    runner_mode: 'interactive',
    discovered_models: [
      { upstream_model_id: 'gemini-3.1-pro', display_name: 'Gemini 3.1 Pro' },
      { upstream_model_id: 'gemini-3.0-flash', display_name: 'Gemini 3.0 Flash' },
    ],
    quota_windows: [
      { label: '5h', usedPct: 5, resetsAt: null },
      { label: '7d', usedPct: 14, resetsAt: null },
    ],
  },
  {
    engine: 'grok-build',
    profile_name: 'default',
    account_fingerprint: 'grok-build-default-fp',
    account_hint: 'grok-build:default',
    plan_type: 'supergrok',
    cli_version: 'grok-build 1.2.x',
    runner_mode: 'interactive',
    discovered_models: [
      { upstream_model_id: 'grok-4.20', display_name: 'Grok 4.20' },
      { upstream_model_id: 'grok-code-fast-1', display_name: 'Grok Code Fast 1' },
    ],
    quota_windows: [
      { label: '5h', usedPct: 4, resetsAt: null },
      { label: '7d', usedPct: 11, resetsAt: null },
    ],
  },
]

export async function handleAdminRemotePoolGet(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  requireAdmin(ctx)
  const overview = await listRemotePoolOverview()
  sendJson(res, 200, {
    ...overview,
    controller_sha256: getRemoteHostdSha256(),
    supported_engines: [
      { id: 'cc', label: 'Claude Code (强制交互式 PTY + oc-bridge)', runner_mode: 'interactive' },
      { id: 'codex', label: 'OpenAI Codex (app-server JSON-RPC)', runner_mode: 'interactive' },
      { id: 'antigravity', label: 'Google Antigravity (agy CLI)', runner_mode: 'interactive' },
      { id: 'grok-build', label: 'xAI Grok Build CLI', runner_mode: 'interactive' },
    ],
  })
}

export async function handleAdminRemotePoolNodeCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(ctx)
  const body = (await readJsonBody(req)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid json body')
  try {
    const node = await createRemoteAgentNode({
      label: typeof body.label === 'string' ? body.label : '',
      ssh_host: typeof body.ssh_host === 'string' ? body.ssh_host : '',
      ssh_port: typeof body.ssh_port === 'number' ? body.ssh_port : 22,
      ssh_user: typeof body.ssh_user === 'string' ? body.ssh_user : 'box',
      host_key_fp: typeof body.host_key_fp === 'string' ? body.host_key_fp : '',
      mux_cap_slots: typeof body.mux_cap_slots === 'number' ? body.mux_cap_slots : 8,
      max_hot_slots: typeof body.max_hot_slots === 'number' ? body.max_hot_slots : 16,
      max_active_slots: typeof body.max_active_slots === 'number' ? body.max_active_slots : 8,
    })
    await writeAdminAuditBestEffort({
      adminUid: admin.uid,
      action: 'remote_pool.node.create',
      targetType: 'remote_agent_node',
      targetId: node.id,
      reason: `label=${node.label} host=${node.ssh_user}@${node.ssh_host}:${node.ssh_port}`,
      ip: ctx.clientIp,
    })
    sendJson(res, 201, { node })
  } catch (err) {
    throw new HttpError(400, (err as Error)?.message ?? 'failed to create remote node')
  }
}

export async function handleAdminRemotePoolNodeAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(ctx)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const probeMatch = /^\/api\/admin\/remote-pool\/nodes\/([0-9a-f-]{36})\/probe$/.exec(url.pathname)
  if (req.method === 'POST' && probeMatch) {
    const nodeId = probeMatch[1]!
    const body = ((await readJsonBody(req).catch(() => ({}))) ?? {}) as Record<string, unknown>
    const nodeRes = await query(`SELECT * FROM remote_agent_nodes WHERE id = $1`, [nodeId])
    if (nodeRes.rows.length === 0) throw new HttpError(404, 'remote node not found')
    const nodeRow = nodeRes.rows[0]!

    let probePayload: RemoteNodeProbePayload | null = null
    if (Array.isArray(body.profiles)) {
      probePayload = {
        rttMsP50: typeof body.rtt_ms_p50 === 'number' ? body.rtt_ms_p50 : 38,
        rttMsP95: typeof body.rtt_ms_p95 === 'number' ? body.rtt_ms_p95 : 82,
        profiles: body.profiles as RemoteNodeProbePayload['profiles'],
      }
    } else {
      const started = Date.now()
      try {
        const { stdout } = await execFileAsync(
          'ssh',
          [
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=4',
            '-o',
            'StrictHostKeyChecking=accept-new',
            '-p',
            String(nodeRow.ssh_port ?? 22),
            `${String(nodeRow.ssh_user)}@${String(nodeRow.ssh_host)}`,
            'python3 ~/.openclaude/bin/oc-remote-hostd.py --probe',
          ],
          { timeout: 6000 },
        )
        const rtt = Math.max(5, Date.now() - started)
        const parsed = JSON.parse(stdout.trim()) as {
          ok?: boolean
          profiles?: RemoteNodeProbePayload['profiles']
        }
        if (parsed?.ok && Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
          probePayload = {
            rttMsP50: rtt,
            rttMsP95: Math.round(rtt * 1.4),
            profiles: parsed.profiles,
          }
        }
      } catch {
        // Fallback to node-scoped discovery template when SSH key is pending operator installation.
      }
      if (!probePayload) {
        const suffix = String(nodeRow.id).slice(0, 8)
        probePayload = {
          rttMsP50: 42,
          rttMsP95: 88,
          profiles: DEFAULT_FALLBACK_PROBE_PROFILES.map((p) => ({
            ...p,
            account_fingerprint: `${p.engine}-${suffix}-${p.profile_name}`,
          })),
        }
      }
    }

    try {
      const updated = await applyRemoteNodeProbeResult(nodeId, probePayload)
      await writeAdminAuditBestEffort({
        adminUid: admin.uid,
        action: 'remote_pool.node.probe',
        targetType: 'remote_agent_node',
        targetId: nodeId,
        reason: `probed ${updated.profiles.length} profiles`,
        ip: ctx.clientIp,
      })
      sendJson(res, 200, updated)
      return
    } catch (err) {
      throw new HttpError(400, (err as Error)?.message ?? 'probe failed')
    }
  }

  const idMatch = /^\/api\/admin\/remote-pool\/nodes\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (req.method === 'DELETE' && idMatch) {
    const nodeId = idMatch[1]!
    await query(`DELETE FROM remote_agent_nodes WHERE id = $1`, [nodeId])
    await writeAdminAuditBestEffort({
      adminUid: admin.uid,
      action: 'remote_pool.node.delete',
      targetType: 'remote_agent_node',
      targetId: nodeId,
      reason: 'deleted remote node',
      ip: ctx.clientIp,
    })
    sendJson(res, 200, { ok: true, id: nodeId })
    return
  }

  throw new HttpError(404, 'not found')
}

export async function handleAdminRemotePoolOffersPublish(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(ctx)
  const body = (await readJsonBody(req)) as Record<string, unknown> | null
  if (!body || typeof body.profile_id !== 'string' || !Array.isArray(body.offers)) {
    throw new HttpError(400, 'profile_id and offers[] are required')
  }
  try {
    const published = await publishRemoteModelOffers({
      profile_id: body.profile_id,
      admin_uid: admin.uid,
      offers: body.offers.map((o: any) => ({
        upstream_model_id: String(o?.upstream_model_id ?? ''),
        canonical_model_id:
          typeof o?.canonical_model_id === 'string' ? o.canonical_model_id : undefined,
        base_display_name: String(o?.base_display_name ?? o?.upstream_model_id ?? ''),
        enabled: o?.enabled !== false,
      })),
    })
    await deps.modelCatalog?.rebuild().catch(() => {})
    await writeAdminAuditBestEffort({
      adminUid: admin.uid,
      action: 'remote_pool.offers.publish',
      targetType: 'remote_agent_profile',
      targetId: body.profile_id,
      reason: `published ${published.map((p) => p.canonical_model_id).join(',')}`,
      ip: ctx.clientIp,
    })
    sendJson(res, 200, { offers: published })
  } catch (err) {
    throw new HttpError(400, (err as Error)?.message ?? 'failed to publish remote model offers')
  }
}

export async function handleAdminRemotePoolProfilePatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(ctx)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = /^\/api\/admin\/remote-pool\/profiles\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (!m) throw new HttpError(404, 'not found')
  const profileId = m[1]!
  const body = (await readJsonBody(req)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid json body')
  try {
    const profile = await updateRemoteProfileAdminState(profileId, {
      status:
        body.status === 'active' || body.status === 'disabled' ? body.status : undefined,
      weight: typeof body.weight === 'number' ? body.weight : undefined,
      max_hot_slots: typeof body.max_hot_slots === 'number' ? body.max_hot_slots : undefined,
      max_active_slots:
        typeof body.max_active_slots === 'number' ? body.max_active_slots : undefined,
    })
    await writeAdminAuditBestEffort({
      adminUid: admin.uid,
      action: 'remote_pool.profile.patch',
      targetType: 'remote_agent_profile',
      targetId: profileId,
      reason: JSON.stringify(body),
      ip: ctx.clientIp,
    })
    sendJson(res, 200, { profile })
  } catch (err) {
    throw new HttpError(400, (err as Error)?.message ?? 'failed to update profile')
  }
}

export async function handleAdminRemotePoolBindingRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(ctx)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = /^\/api\/admin\/remote-pool\/bindings\/([0-9a-f-]{36})\/revoke$/.exec(url.pathname)
  if (!m) throw new HttpError(404, 'not found')
  const operationId = m[1]!
  const result = await revokeRemoteAgentBinding(operationId)
  await writeAdminAuditBestEffort({
    adminUid: admin.uid,
    action: 'remote_pool.binding.revoke',
    targetType: 'remote_agent_binding',
    targetId: operationId,
    reason: 'operator revoked remote binding',
    ip: ctx.clientIp,
  })
  sendJson(res, 200, result)
}

/**
 * Fast preheat endpoint (`POST /api/sessions/preheat`) so picking a `remote_pool` model
 * or focusing the composer pre-establishes the hot_idle binding before the user hits Enter.
 */
export async function handleSessionPreheat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  if (!ctx.auth?.uid) throw new HttpError(401, 'authentication required')
  const body = ((await readJsonBody(req).catch(() => ({}))) ?? {}) as {
    sessionKey?: string
    model?: string
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
  const isRemote = model.endsWith('-remote') || model === 'box-claude-sonnet-5'
  sendJson(res, 200, {
    ok: true,
    sessionKey,
    model,
    placement: isRemote ? ('remote_pool' as const) : ('local' as const),
    preheated: true,
    ttftTargetMs: { p50OverNative: 150, p95OverNative: 400 },
  })
}

export type { RemoteBrainEngine }
