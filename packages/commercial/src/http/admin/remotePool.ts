/**
 * OCV5-721 — Admin HTTP handlers for the Remote Agent Brain Pool (`/api/admin/remote-pool/*`)
 * and session preheat endpoint (`POST /api/sessions/preheat`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeAdminAuditBestEffort } from '../../admin/audit.js'
import { requireAdmin, requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import {
  createRemoteAgentNode,
  getRemoteHostdSha256,
  listRemotePoolOverview,
  preheatRemotePoolSession,
  probeRemoteAgentNodeLive,
  publishRemoteModelOffers,
  revokeRemoteAgentBinding,
  updateRemoteProfileAdminState,
  type RemoteBrainEngine,
} from '../../account-pool/remoteBrainPool.js'
import { peekModelCatalogCache } from '../../billing/modelCatalogRuntime.js'
import { query } from '../../db/queries.js'
import { requireAuth } from '../auth.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, readJsonBody, sendJson } from '../util.js'

export async function handleAdminRemotePoolGet(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret)
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
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const body = (await readJsonBody(req)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'VALIDATION', 'invalid json body')
  }
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
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      'remote_pool.node.create',
      `remote_agent_node:${node.id}`,
      null,
      { label: node.label, ssh_host: node.ssh_host, ssh_port: node.ssh_port, ssh_user: node.ssh_user },
    )
    sendJson(res, 201, { node })
  } catch (err) {
    throw new HttpError(400, 'BAD_REQUEST', (err as Error)?.message ?? 'failed to create remote node')
  }
}

export async function handleAdminRemotePoolNodeAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const probeMatch = /^\/api\/admin\/remote-pool\/nodes\/([0-9a-f-]{36})\/probe$/.exec(url.pathname)
  if (req.method === 'POST' && probeMatch) {
    const nodeId = probeMatch[1]!
    try {
      const updated = await probeRemoteAgentNodeLive(nodeId)
      await writeAdminAuditBestEffort(
        { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
        'remote_pool.node.probe',
        `remote_agent_node:${nodeId}`,
        null,
        { profile_count: updated.profiles.length },
      )
      sendJson(res, 200, updated)
      return
    } catch (err) {
      const msg = (err as Error)?.message ?? 'probe failed'
      throw new HttpError(
        msg === 'REMOTE_NODE_NOT_FOUND' ? 404 : 400,
        msg === 'REMOTE_NODE_NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
        msg,
      )
    }
  }

  const idMatch = /^\/api\/admin\/remote-pool\/nodes\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (req.method === 'DELETE' && idMatch) {
    const nodeId = idMatch[1]!
    await query(`DELETE FROM remote_agent_nodes WHERE id = $1`, [nodeId])
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      'remote_pool.node.delete',
      `remote_agent_node:${nodeId}`,
      null,
      null,
    )
    sendJson(res, 200, { ok: true, id: nodeId })
    return
  }

  throw new HttpError(404, 'NOT_FOUND', 'not found')
}

export async function handleAdminRemotePoolOffersPublish(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const body = (await readJsonBody(req)) as Record<string, unknown> | null
  if (!body || typeof body.profile_id !== 'string' || !Array.isArray(body.offers)) {
    throw new HttpError(400, 'VALIDATION', 'profile_id and offers[] are required')
  }
  try {
    const published = await publishRemoteModelOffers({
      profile_id: body.profile_id,
      admin_uid: BigInt(admin.id),
      offers: body.offers.map((o: any) => ({
        upstream_model_id: String(o?.upstream_model_id ?? ''),
        canonical_model_id:
          typeof o?.canonical_model_id === 'string' ? o.canonical_model_id : undefined,
        base_display_name: String(o?.base_display_name ?? o?.upstream_model_id ?? ''),
        enabled: o?.enabled !== false,
      })),
    })
    await peekModelCatalogCache()?.rebuild().catch(() => {})
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      'remote_pool.offers.publish',
      `remote_agent_profile:${body.profile_id}`,
      null,
      { models: published.map((p) => p.canonical_model_id) },
    )
    sendJson(res, 200, { offers: published })
  } catch (err) {
    throw new HttpError(400, 'BAD_REQUEST', (err as Error)?.message ?? 'failed to publish remote model offers')
  }
}

export async function handleAdminRemotePoolProfilePatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = /^\/api\/admin\/remote-pool\/profiles\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'not found')
  const profileId = m[1]!
  const body = (await readJsonBody(req)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'VALIDATION', 'invalid json body')
  }
  try {
    const profile = await updateRemoteProfileAdminState(profileId, {
      status:
        body.status === 'active' || body.status === 'disabled' ? body.status : undefined,
      weight: typeof body.weight === 'number' ? body.weight : undefined,
      max_hot_slots: typeof body.max_hot_slots === 'number' ? body.max_hot_slots : undefined,
      max_active_slots:
        typeof body.max_active_slots === 'number' ? body.max_active_slots : undefined,
    })
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      'remote_pool.profile.patch',
      `remote_agent_profile:${profileId}`,
      null,
      body,
    )
    sendJson(res, 200, { profile })
  } catch (err) {
    throw new HttpError(400, 'BAD_REQUEST', (err as Error)?.message ?? 'failed to update profile')
  }
}

export async function handleAdminRemotePoolBindingRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = /^\/api\/admin\/remote-pool\/bindings\/([0-9a-f-]{36})\/revoke$/.exec(url.pathname)
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'not found')
  const operationId = m[1]!
  const result = await revokeRemoteAgentBinding(operationId)
  await writeAdminAuditBestEffort(
    { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
    'remote_pool.binding.revoke',
    `remote_agent_binding:${operationId}`,
    null,
    result,
  )
  sendJson(res, 200, result)
}

/**
 * Fast preheat endpoint (`POST /api/sessions/preheat`) so picking a `remote_pool` model
 * or focusing the composer pre-establishes the hot_idle binding before the user hits Enter.
 */
export async function handleSessionPreheat(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const body = ((await readJsonBody(req).catch(() => ({}))) ?? {}) as {
    sessionKey?: string
    model?: string
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
  const isRemote = model.endsWith('-remote') || model === 'box-claude-sonnet-5'
  if (!isRemote) {
    sendJson(res, 200, {
      ok: true,
      sessionKey,
      model,
      placement: 'local' as const,
      preheated: false,
      reason: 'LOCAL_PLACEMENT',
    })
    return
  }
  const outcome = await preheatRemotePoolSession({
    uid: String(user.id),
    sessionKey,
    canonicalModelId: model,
  })
  sendJson(res, 200, {
    ok: true,
    sessionKey,
    model,
    placement: 'remote_pool' as const,
    preheated: outcome.preheated,
    reason: outcome.reason ?? null,
    selectedProfileId: outcome.selectedProfileId ?? null,
    selectedNodeId: outcome.selectedNodeId ?? null,
    ttftTargetMs: { p50OverNative: 150, p95OverNative: 400 },
  })
}

export type { RemoteBrainEngine }
