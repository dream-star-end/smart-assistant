import {
  type SessionWorkspaceMode,
  isHiddenSystemAgentId,
  parseSessionWorkspaceMode,
} from '@openclaude/protocol'
import type { AgentDef } from '@openclaude/storage'
import { resolveEngine } from './engine/registry.js'
import { localExecutionOverride, resolveLocalExecutionIfEnforced } from './localExecution.js'
import { _buildSafeCodexRouteOverride } from './routeOverrides.js'
import type { PreheatPreparation } from './speculativePreheat.js'

const ENGINE_PREHEAT_SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,50}$/
const ENGINE_PREHEAT_AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

export type EnginePreheatBody = {
  sessionId: string
  agentId: string
  modelId?: string
  effortLevel?: string | null
  workspaceMode?: SessionWorkspaceMode
  codexRouteHint?: { kind: 'official_oauth' }
}

export type EnginePreheatValidation =
  | { ok: true; payload: EnginePreheatBody }
  | { ok: false; error: string }

export function validateEnginePreheatBody(parsed: unknown): EnginePreheatValidation {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = parsed as Record<string, unknown>
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || !ENGINE_PREHEAT_SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: 'sessionId required' }
  }
  const agentId = body.agentId
  if (typeof agentId !== 'string' || !ENGINE_PREHEAT_AGENT_ID_RE.test(agentId)) {
    return { ok: false, error: 'agentId required' }
  }
  if (isHiddenSystemAgentId(agentId)) {
    return { ok: false, error: 'agentId required' }
  }
  let modelId: string | undefined
  if (body.modelId !== undefined) {
    if (
      typeof body.modelId !== 'string' ||
      body.modelId.length === 0 ||
      body.modelId.length > 128
    ) {
      return { ok: false, error: 'modelId invalid' }
    }
    modelId = body.modelId
  }
  if (
    body.effortLevel !== undefined &&
    body.effortLevel !== null &&
    (typeof body.effortLevel !== 'string' || !/^[a-z]{1,16}$/.test(body.effortLevel))
  ) {
    return { ok: false, error: 'effortLevel invalid' }
  }
  if (body.workspaceMode !== undefined && parseSessionWorkspaceMode(body.workspaceMode) === null) {
    return { ok: false, error: 'workspaceMode invalid' }
  }
  let codexRouteHint: { kind: 'official_oauth' } | undefined
  if (body.codexRouteHint !== undefined) {
    const hint = body.codexRouteHint
    if (
      !hint ||
      typeof hint !== 'object' ||
      Array.isArray(hint) ||
      Object.keys(hint).length !== 1 ||
      (hint as { kind?: unknown }).kind !== 'official_oauth'
    ) {
      return { ok: false, error: 'codexRouteHint invalid' }
    }
    codexRouteHint = { kind: 'official_oauth' }
  }
  return {
    ok: true,
    payload: {
      sessionId,
      agentId,
      ...(modelId ? { modelId } : {}),
      ...(codexRouteHint ? { codexRouteHint } : {}),
      ...(body.effortLevel !== undefined ? { effortLevel: body.effortLevel as string | null } : {}),
      ...(body.workspaceMode !== undefined
        ? { workspaceMode: body.workspaceMode as SessionWorkspaceMode }
        : {}),
    },
  }
}

export type SessionPreheatHost = {
  log: {
    info: (msg: string, fields?: unknown) => void
    warn: (msg: string, fields?: unknown, err?: unknown) => void
  }
  sessions: {
    runtime?: import('./gatewayRuntimeServices.js').GatewayRuntimeServices
    getByKey: (key: string) => unknown
    getOrCreate: (opts: Record<string, unknown>) => Promise<unknown>
    preheatRunner: (session: unknown, preparation?: PreheatPreparation) => Promise<string>
  }
  _getAgentsConfig: () => Promise<{ agents: AgentDef[] }>
  deps: { config: { defaults: { model: string }; gateway?: { port: number } } }
}

/** 容器内真实预热:投影授权 → getOrCreate → preheatRunner。供 internal 口与容器 GET 钩子共用。 */
export async function runSessionPreheat(
  host: SessionPreheatHost,
  sessId: string,
  userId: string,
  row: {
    agentId?: string
    modelId?: string
    effortLevel?: string | null
    workspaceMode?: SessionWorkspaceMode
    codexRouteHint?: { kind: 'official_oauth' }
  },
): Promise<void> {
  const aid = row.agentId || 'main'
  if (isHiddenSystemAgentId(aid)) return
  const sessionKey = `agent:${aid}:webchat:dm:${sessId}`
  const cfg = await host._getAgentsConfig()
  const agent = cfg.agents.find((a) => a.id === aid) ?? ({ id: aid } as AgentDef)
  const preExec = await resolveLocalExecutionIfEnforced({
    catalog: host.sessions.runtime?.catalog,
    agent,
    kind: 'prewarm',
    ...(row.modelId ? { model: row.modelId } : {}),
    defaultModel: host.deps.config.defaults.model,
  })
  const engine =
    preExec?.engine ??
    resolveEngine(row.modelId ?? agent.model ?? host.deps.config.defaults.model, agent)
  let preparation: PreheatPreparation | undefined
  if (engine === 'codex') {
    if (!preExec || !row.codexRouteHint) {
      host.log.info('engine_preheat_skipped', { sessionKey, outcome: 'skipped_route_unknown' })
      return
    }
    const route = _buildSafeCodexRouteOverride({
      agent,
      model: preExec.canonicalModel,
      authority: preExec,
      rawRoute: row.codexRouteHint,
      officialRelayPort: host.deps.config.gateway?.port ?? 0,
    })
    if (!route) return
    preparation = {
      model: preExec.canonicalModel,
      codexRoute: route,
      ...(row.effortLevel !== undefined ? { effortLevel: row.effortLevel ?? undefined } : {}),
    }
  }
  let session = host.sessions.getByKey(sessionKey)
  if (!session) {
    const override = localExecutionOverride(preExec)
    session = await host.sessions.getOrCreate({
      sessionKey,
      agent,
      ...override,
      ...(override.model === undefined && row.modelId ? { model: row.modelId } : {}),
      channel: 'webchat',
      peerId: sessId,
      userId,
      preheatOnly: true,
      ...(row.effortLevel !== undefined ? { effortLevel: row.effortLevel } : {}),
      ...(row.workspaceMode ? { workspaceMode: row.workspaceMode } : {}),
    })
  }
  const outcome = await host.sessions.preheatRunner(session, preparation)
  if (outcome !== 'started' && outcome !== 'already_running') {
    host.log.info('engine_preheat_skipped', { sessionKey, outcome })
  }
}
