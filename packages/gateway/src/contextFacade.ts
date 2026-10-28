/**
 * OpenViking P1 (B1): gateway-only context façade.
 *
 * In-process gateway callers read context sources here, under an authority
 * minted by `contextAuthorities`; nothing is taken from request parameters or
 * env. CLI callers stay `cli_lease_blocked` (P0 contextAccess). The view sent
 * to MemoryPanel carries source metadata only, never source content.
 */
import {
  MemoryDir,
  isIdentityAssetsError,
  memoryCalendarDate,
  readCoreContextSource,
  readFormalProjectContextSources,
  type ContextRejection,
  type ContextSources,
  type GatewayContextAuthority,
  type IdentityCompatAssets,
  type MemoryTurnPolicyDecision,
} from '@openclaude/storage'
import { contextAuthorities, type ContextAuthorityRegistry } from './contextAuthority.js'

/** Gateway config only (the model cannot change the gateway's env). `0`/`off` turns the façade off. */
export function contextFacadeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OC_CONTEXT_FACADE?.trim().toLowerCase()
  return raw !== '0' && raw !== 'off'
}

export interface ContextFacadeDeps {
  enabled?: boolean
  now?: () => number
  today?: string
  reader?: (agentId: string) => Pick<MemoryDir, 'renderForInjectionReadonly'>
}

export async function readGatewayContext(
  authority: GatewayContextAuthority,
  deps: ContextFacadeDeps = {},
  identityCompat?: IdentityCompatAssets,
): Promise<ContextSources> {
  const options = {
    enabled: deps.enabled ?? contextFacadeEnabled(),
    today: deps.today ?? memoryCalendarDate(),
    ...(deps.now ? { now: deps.now } : {}),
  }
  const reader = (deps.reader ?? ((agentId: string) => new MemoryDir(agentId)))(authority.effectiveAgentId)
  let core: ContextSources
  try {
    core = await readCoreContextSource(authority, options, { reader, ...(identityCompat ? { identityCompat } : {}) })
  } catch (err) {
    if (isIdentityAssetsError(err)) return { status: 'unavailable', reason: 'authority_unavailable' }
    throw err
  }
  if (core.status !== 'ready' || authority.mode !== 'formal') return core
  const formal = await readFormalProjectContextSources(authority, options)
  if (formal.status !== 'ready') return formal
  return { status: 'ready', sources: Object.freeze([...core.sources, ...formal.sources]) }
}

/** Read under the session's live turn authority; null when that session has no live turn. */
export async function readTurnContext(
  sessionId: string,
  deps: ContextFacadeDeps & { registry?: ContextAuthorityRegistry } = {},
): Promise<ContextSources | null> {
  const minted = (deps.registry ?? contextAuthorities).mintTurn(sessionId)
  if (!minted) return null
  return readGatewayContext(minted.authority, deps, minted.identityAssets)
}

export type MemoryContextRead =
  | {
      status: 'ready'
      sources: {
        kind: 'core-index' | 'project-memory'
        locator: string
        bytes: number
        sourceVersion: string
        expires: string[]
      }[]
    }
  | { status: 'unavailable'; reason: ContextRejection }

export interface MemoryContextView {
  facade: 'enabled' | 'disabled'
  /** CLI/engine callers have no authenticated lease in B1. */
  cli: 'cli_lease_blocked'
  mode: 'legacy' | 'formal'
  panel: MemoryContextRead
  turns: {
    startedAt: number
    projectBound: boolean
    memoryPolicy: MemoryTurnPolicyDecision
    context: MemoryContextRead
  }[]
}

function toRead(sources: ContextSources): MemoryContextRead {
  if (sources.status !== 'ready') return sources
  return {
    status: 'ready',
    sources: sources.sources.map((source) => ({
      kind: source.kind,
      locator: source.locator,
      bytes: Buffer.byteLength(source.content, 'utf8'),
      sourceVersion: source.sourceVersion.slice(0, 12),
      expires: [...source.expires],
    })),
  }
}

/** GET /api/agents/:id/memory/context: what the façade grants this agent right now. */
export async function buildMemoryContextView(
  agentId: string,
  deps: ContextFacadeDeps & { registry?: ContextAuthorityRegistry } = {},
): Promise<MemoryContextView> {
  const registry = deps.registry ?? contextAuthorities
  const enabled = deps.enabled ?? contextFacadeEnabled()
  const read = { ...deps, enabled }
  const panelAuthority = registry.mintPanel(agentId)
  const panel = toRead(await readGatewayContext(panelAuthority, read))
  const turns: MemoryContextView['turns'] = []
  for (const turn of registry.activeTurns(agentId)) {
    const context = await readTurnContext(turn.sessionId, { ...read, registry })
    // The turn ended while we were reading: it is no longer an active turn.
    if (!context) continue
    turns.push({
      startedAt: turn.startedAt,
      projectBound: turn.chatProjectId !== null,
      memoryPolicy: { ...turn.memoryPolicy },
      context: toRead(context),
    })
  }
  return { facade: enabled ? 'enabled' : 'disabled', cli: 'cli_lease_blocked', mode: panelAuthority.mode, panel, turns }
}
