/** Per-admission authenticated identity authority. Never a display/sync cache. */
import { IdentityCompatError, parseIdentityCompatProjection, resolveIdentityCompat, assertIdentityCompatReady, type IdentityCompatProjection } from '@openclaude/protocol'
import { readAgentsConfig, type AgentDef, type AgentsConfig } from './config.js'
import { resolveIdentityCompatAssets, type IdentityCompatAssets } from './identityCompatAssets.js'

export interface IdentityCompatRuntimeContext { assets?: IdentityCompatAssets; fingerprint?: string }

export async function fetchIdentityCompatProjection(): Promise<IdentityCompatProjection | undefined> {
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  const uid = process.env.OC_USER_ID?.trim()
  // Only a genuinely local runtime has no container identity at all.
  if (!base && !token && !uid) return undefined
  if (!base || !token || !uid) throw new IdentityCompatError('COMPAT_AUTHORITY_UNAVAILABLE', 'incomplete container identity')
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/internal/v3/marketplace/sync`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { identityCompat?: unknown }
    return parseIdentityCompatProjection(body.identityCompat, uid)
  } catch (error) {
    if (error instanceof IdentityCompatError) throw error
    throw new IdentityCompatError('COMPAT_AUTHORITY_UNAVAILABLE', 'identity compatibility authority unavailable')
  }
}

export async function resolveRuntimeExecutionAgent(
  requested: AgentDef,
  cfg?: AgentsConfig,
  projection?: IdentityCompatProjection,
): Promise<{ agent: AgentDef; context: IdentityCompatRuntimeContext }> {
  const authority = projection ?? await fetchIdentityCompatProjection()
  if (!authority) return { agent: requested, context: {} }
  const resolution = resolveIdentityCompat(requested.id, authority)
  assertIdentityCompatReady(resolution)
  if (!resolution.profile) return { agent: requested, context: {} }
  const config = cfg ?? await readAgentsConfig()
  const canonical = config.agents.find((agent) => agent.id === resolution.executionAgentId)
  if (!canonical || canonical.source !== 'marketplace') throw new IdentityCompatError('COMPAT_CONFIG_CONFLICT', 'registered canonical agent missing from local projection')
  const assets = await resolveIdentityCompatAssets({ profile: resolution.profile })
  const soul = assets.buildSoul()
  return {
    // Preserve a caller's already-capped execution overrides ONLY when it already
    // resolved the canonical definition. Legacy fields are not execution authority.
    agent: requested.id === canonical.id && Array.isArray(requested.toolsets)
      ? { ...canonical, toolsets: requested.toolsets }
      : canonical,
    context: { assets, fingerprint: `${JSON.stringify(resolution.profile)}:${soul.canonicalPersonaSha256}:${soul.localManualSha256}` },
  }
}

/** Explicit empty value clears inherited/stale derived context on every engine. */
export function identityCompatEnvironment(context?: IdentityCompatRuntimeContext): Record<string, string> {
  return { OC_IDENTITY_COMPAT_PROFILE: context?.assets ? JSON.stringify(context.assets.profile) : '', ...(context?.assets && process.env.OC_USER_ID ? { OC_USER_ID: process.env.OC_USER_ID } : {}) }
}
