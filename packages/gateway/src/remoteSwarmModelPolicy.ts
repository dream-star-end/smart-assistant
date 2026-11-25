/**
 * Authoritative model resolution, alias normalization, and fail-closed allowlist
 * enforcement for Remote Antigravity Swarm members (OCV5-893).
 *
 * Security & billing invariants:
 *   - Every remote swarm member model resolves deterministically to a canonical
 *     remote Antigravity model id (`antigravity-*-remote`) plus an optional valid
 *     reasoning effort (`low` | `medium` | `high` | `xhigh`).
 *   - Fail-closed allowlist:
 *       * Non-empty `allowedModels`: resolved `canonicalModel` MUST belong to the
 *         sanitized allowlist (cross-engine / non-remote entries are stripped).
 *       * Empty `allowedModels` (`[]`): rejects switching to any model other than
 *         `defaultModel`.
 *       * Undefined `allowedModels` (legacy compat): allows `defaultModel` (if
 *         remote Antigravity) or known built-in remote Antigravity swarm member
 *         models only — never arbitrary strings, local non-remote ids, or
 *         cross-engine models.
 *   - Unrecognized, unauthorized, non-remote, or cross-engine requests throw
 *     `SWARM_MODEL_NOT_ALLOWED:<raw>` listing the currently permitted models.
 */
import {
  ANTIGRAVITY_ENGINE_MODELS,
  isAntigravitySwarmMemberModel,
} from '@openclaude/protocol'
import type { RosterMemberRecord } from './remoteSwarmLocks.js'

const REMOTE_MODEL_SUFFIX = '-remote'
const MAX_ROUTE_REMOTE_SWARM_ALLOWED_MODELS = 32
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])
const ALLOWED_CATALOG_ENGINES = new Set(['antigravity'])

export interface RemoteAntigravityModelEntry {
  readonly localId: string
  readonly remoteId: string
  readonly displayName: string
  readonly efforts: readonly string[]
  readonly defaultEffort: string
  readonly cliModels: Readonly<Record<string, string>>
  readonly isSwarmMember: boolean
}

export interface RemoteSwarmModelPolicyContext {
  readonly defaultModel: string
  readonly defaultEffort?: string
  readonly allowedModels?: readonly string[]
}

export interface ResolvedRemoteSwarmMemberModel {
  readonly canonicalModel: string
  readonly effort?: string
}

export interface RemoteSwarmAvailableModelInfo {
  readonly id: string
  readonly display_name: string
  readonly efforts: readonly string[]
  readonly default_effort: string
  readonly cli_aliases: readonly string[]
}

const REMOTE_ENTRIES: readonly RemoteAntigravityModelEntry[] = ANTIGRAVITY_ENGINE_MODELS.map(
  (entry) => ({
    localId: entry.id,
    remoteId: `${entry.id}${REMOTE_MODEL_SUFFIX}`,
    displayName: entry.displayName,
    efforts: [...(entry.efforts as readonly string[])],
    defaultEffort: entry.defaultEffort,
    cliModels: entry.cliModels as Readonly<Record<string, string>>,
    isSwarmMember: isAntigravitySwarmMemberModel(entry.id),
  }),
)

const REMOTE_ENTRY_BY_ID: ReadonlyMap<string, RemoteAntigravityModelEntry> = new Map(
  REMOTE_ENTRIES.map((e) => [e.remoteId.toLowerCase(), e]),
)

const ALIAS_TO_REMOTE: ReadonlyMap<
  string,
  { readonly entry: RemoteAntigravityModelEntry; readonly effort?: string }
> = (() => {
  const map = new Map<string, { readonly entry: RemoteAntigravityModelEntry; readonly effort?: string }>()
  for (const entry of REMOTE_ENTRIES) {
    for (const [effortKey, cliId] of Object.entries(entry.cliModels)) {
      const effort = entry.efforts.includes(effortKey) ? effortKey : undefined
      map.set(cliId.toLowerCase(), { entry, ...(effort ? { effort } : {}) })
    }
    for (const effort of entry.efforts) {
      map.set(`${entry.remoteId}-${effort}`.toLowerCase(), { entry, effort })
      map.set(`${entry.localId}-${effort}${REMOTE_MODEL_SUFFIX}`.toLowerCase(), { entry, effort })
    }
  }
  return map
})()

export const KNOWN_REMOTE_SWARM_MEMBER_MODEL_IDS: readonly string[] = REMOTE_ENTRIES
  .filter((e) => e.isSwarmMember)
  .map((e) => e.remoteId)

export function normalizeRemoteSwarmEffort(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const clean = raw.trim().toLowerCase()
  return VALID_EFFORTS.has(clean) ? clean : undefined
}

export function readMemberEffort(rec: RosterMemberRecord | undefined): string | undefined {
  if (!rec) return undefined
  return normalizeRemoteSwarmEffort((rec as RosterMemberRecord & { effort?: unknown }).effort)
}

export function writeMemberEffort(rec: RosterMemberRecord, effort: string | undefined): void {
  const target = rec as RosterMemberRecord & { effort?: string }
  const normalized = normalizeRemoteSwarmEffort(effort)
  if (normalized) {
    target.effort = normalized
  } else {
    delete target.effort
  }
}

/**
 * Resolve the effective effort to send for a worker's turn:
 *   - Uses the member's persisted `effort` when set;
 *   - Falls back to coordinator `fallbackEffort` ONLY when compatible with the
 *     worker's model (prevents leaking e.g. `xhigh` from Neon to Carbon/GPT-OSS).
 */
export function resolveWorkerTurnEffort(
  rec: RosterMemberRecord | undefined,
  fallbackEffort: string | undefined,
): string | undefined {
  const explicit = readMemberEffort(rec)
  if (explicit) return explicit
  const fallback = normalizeRemoteSwarmEffort(fallbackEffort)
  if (!fallback) return undefined
  const modelKey = rec?.model?.trim().toLowerCase()
  const entry = modelKey ? REMOTE_ENTRY_BY_ID.get(modelKey) : undefined
  if (!entry) return fallback
  if (entry.efforts.length === 0) return undefined
  return entry.efforts.includes(fallback) ? fallback : undefined
}

export function isKnownRemoteAntigravityModel(modelId: string | null | undefined): boolean {
  if (typeof modelId !== 'string') return false
  return REMOTE_ENTRY_BY_ID.has(modelId.trim().toLowerCase())
}

export function isRemoteAntigravitySwarmMemberModel(modelId: string | null | undefined): boolean {
  if (typeof modelId !== 'string') return false
  return REMOTE_ENTRY_BY_ID.get(modelId.trim().toLowerCase())?.isSwarmMember === true
}

/**
 * Parse Master-injected `_antigravitySwarmAllowedModels` for remote Antigravity turns.
 * Returns `undefined` when absent (allowing catalog/legacy fallback), or an authoritative
 * deduplicated list of remote Antigravity swarm member ids (possibly empty -> fail-closed).
 */
export function extractRouteAllowedRemoteSwarmModels(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_ROUTE_REMOTE_SWARM_ALLOWED_MODELS) break
    if (typeof item !== 'string') continue
    const entry = REMOTE_ENTRY_BY_ID.get(item.trim().toLowerCase())
    if (!entry || !entry.isSwarmMember || seen.has(entry.remoteId)) continue
    seen.add(entry.remoteId)
    out.push(entry.remoteId)
  }
  return out
}

export function filterAvailableRemoteSwarmModels(
  models: readonly { modelId: string; engine: string; available: boolean }[],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of models) {
    if (!m.available || !ALLOWED_CATALOG_ENGINES.has(m.engine)) continue
    const entry = REMOTE_ENTRY_BY_ID.get(m.modelId.trim().toLowerCase())
    if (!entry || !entry.isSwarmMember || seen.has(entry.remoteId)) continue
    seen.add(entry.remoteId)
    out.push(entry.remoteId)
  }
  return out
}

function computeEffectiveAllowedRemoteModels(ctx: RemoteSwarmModelPolicyContext): string[] {
  const defaultEntry = REMOTE_ENTRY_BY_ID.get(ctx.defaultModel.trim().toLowerCase())
  const defaultCanonical = defaultEntry?.remoteId ?? ctx.defaultModel.trim()

  if (ctx.allowedModels === undefined) {
    const out: string[] = []
    const seen = new Set<string>()
    if (defaultEntry) {
      seen.add(defaultEntry.remoteId)
      out.push(defaultEntry.remoteId)
    }
    for (const id of KNOWN_REMOTE_SWARM_MEMBER_MODEL_IDS) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }

  if (ctx.allowedModels.length === 0) {
    return defaultEntry ? [defaultEntry.remoteId] : []
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of ctx.allowedModels) {
    if (typeof item !== 'string') continue
    const entry = REMOTE_ENTRY_BY_ID.get(item.trim().toLowerCase())
    if (!entry) continue
    if (!entry.isSwarmMember && entry.remoteId !== defaultCanonical) continue
    if (seen.has(entry.remoteId)) continue
    seen.add(entry.remoteId)
    out.push(entry.remoteId)
  }
  return out
}

function formatNotAllowedError(raw: string, allowedList: readonly string[], defaultModel: string): Error {
  const detail =
    allowedList.length > 0
      ? `allowed: ${allowedList.join(', ')}`
      : `allowed: none (omit model to inherit ${defaultModel || 'session default'})`
  return new Error(`SWARM_MODEL_NOT_ALLOWED:${raw} (${detail})`)
}

/**
 * Deterministically resolve and authorize a requested remote swarm member model.
 * Accepts:
 *   - omitted / empty string -> inherits coordinator default model + effort
 *   - remote canonical id (`antigravity-gemini-4-carbon-remote`) or `<id>-<effort>`
 *   - Antigravity CLI slug (`gemini-4-carbon-high`, `gemini-4-neon-medium`, `claude-opus-5-5-high`)
 *
 * Strictly fail-closed against unauthorized, non-remote, unknown, or cross-engine models.
 */
export function resolveRemoteSwarmMemberModel(
  requestedRaw: unknown,
  ctx: RemoteSwarmModelPolicyContext,
): ResolvedRemoteSwarmMemberModel {
  const defaultModel = ctx.defaultModel.trim()
  const defaultEffort = normalizeRemoteSwarmEffort(ctx.defaultEffort)

  if (requestedRaw === undefined || requestedRaw === null) {
    return {
      canonicalModel: defaultModel,
      ...(defaultEffort ? { effort: defaultEffort } : {}),
    }
  }
  const allowedList = computeEffectiveAllowedRemoteModels(ctx)
  if (typeof requestedRaw !== 'string') {
    throw formatNotAllowedError(String(requestedRaw), allowedList, defaultModel)
  }
  const raw = requestedRaw.trim()
  if (!raw) {
    return {
      canonicalModel: defaultModel,
      ...(defaultEffort ? { effort: defaultEffort } : {}),
    }
  }

  const lower = raw.toLowerCase()
  const defaultEntry = REMOTE_ENTRY_BY_ID.get(defaultModel.toLowerCase())
  const defaultCanonical = defaultEntry?.remoteId ?? defaultModel
  let canonicalModel: string | null = null
  let resolvedEffort: string | undefined

  const directEntry = REMOTE_ENTRY_BY_ID.get(lower)
  if (directEntry) {
    canonicalModel = directEntry.remoteId
    if (directEntry.efforts.length > 0 && defaultEffort && directEntry.efforts.includes(defaultEffort)) {
      resolvedEffort = defaultEffort
    }
  } else {
    const aliasMatch = ALIAS_TO_REMOTE.get(lower)
    if (aliasMatch) {
      canonicalModel = aliasMatch.entry.remoteId
      resolvedEffort = aliasMatch.effort
    } else if (defaultModel && lower === defaultCanonical.toLowerCase()) {
      canonicalModel = defaultCanonical
      resolvedEffort = defaultEffort
    }
  }

  if (!canonicalModel) {
    throw formatNotAllowedError(raw, allowedList, defaultModel)
  }

  // OCV5-893 W1: Creation (`add` with omitted model) and pre-dispatch execution re-check
  // share the exact same rule: the currently authorized session primary (`defaultCanonical`,
  // e.g. an orchestrator primary not listed in extra swarm member offers) is always valid
  // for inheritance, while any non-default model must be explicitly authorized in `allowedSet`
  // (preventing revoked historical explicit member models from passing via inheritance).
  const isAuthorizedSessionPrimary =
    defaultCanonical.length > 0 && canonicalModel.toLowerCase() === defaultCanonical.toLowerCase()
  const allowedSet = new Set(allowedList)
  if (!isAuthorizedSessionPrimary && !allowedSet.has(canonicalModel)) {
    throw formatNotAllowedError(raw, allowedList, defaultModel)
  }

  return {
    canonicalModel,
    ...(resolvedEffort ? { effort: resolvedEffort } : {}),
  }
}

export function formatRemoteSwarmModelsResponse(
  ctx: RemoteSwarmModelPolicyContext,
): Record<string, unknown> {
  const effectiveAllowed = computeEffectiveAllowedRemoteModels(ctx)
  const defaultEffort = normalizeRemoteSwarmEffort(ctx.defaultEffort)
  const availableModels: RemoteSwarmAvailableModelInfo[] = effectiveAllowed.map((remoteId) => {
    const entry = REMOTE_ENTRY_BY_ID.get(remoteId.toLowerCase())
    if (!entry) {
      return {
        id: remoteId,
        display_name: remoteId,
        efforts: [],
        default_effort: 'default',
        cli_aliases: [],
      }
    }
    return {
      id: entry.remoteId,
      display_name: entry.displayName,
      efforts: [...entry.efforts],
      default_effort: entry.defaultEffort,
      cli_aliases: Object.values(entry.cliModels),
    }
  })

  const restrictedToDefault =
    ctx.allowedModels !== undefined && ctx.allowedModels.length === 0
  const note = restrictedToDefault
    ? 'No additional remote swarm models are authorized for this session; omit model on add to inherit the active session model.'
    : availableModels.length > 0
      ? 'Omit model on add to inherit the active session model, or pick one of available_models (canonical *-remote id, <id>-<effort>, or matching Antigravity CLI alias). Each worker is billed independently according to its actual model.'
      : 'Leave model omitted on add so workers inherit the active session model.'

  return {
    ok: true,
    current_model: ctx.defaultModel,
    ...(defaultEffort ? { current_effort: defaultEffort } : {}),
    available_models: availableModels,
    note,
  }
}

function formatRemoteSwarmCliGroup(entry: RemoteAntigravityModelEntry): string | null {
  if (entry.efforts.length === 0) {
    return entry.cliModels[entry.defaultEffort] ?? Object.values(entry.cliModels)[0] ?? null
  }
  const values = entry.efforts
    .map((e) => entry.cliModels[e])
    .filter((v): v is string => Boolean(v))
  if (values.length === 0) return null
  if (values.length === 1) return values[0]!
  const first = values[0]!
  const suffix = `-${entry.efforts[0]}`
  if (first.endsWith(suffix)) {
    const prefix = first.slice(0, -suffix.length)
    const allMatch = entry.efforts.every((e, i) => values[i] === `${prefix}-${e}`)
    if (allMatch) return `${prefix}-{${entry.efforts.join(',')}}`
  }
  return values.join(' / ')
}

export function formatAvailableRemoteSwarmModelsHint(
  modelIds?: readonly string[] | null,
): string | null {
  if (!modelIds || modelIds.length === 0) return null
  const items: string[] = []
  const seen = new Set<string>()
  for (const raw of modelIds) {
    if (typeof raw !== 'string') continue
    const entry = REMOTE_ENTRY_BY_ID.get(raw.trim().toLowerCase())
    if (!entry || !entry.isSwarmMember || seen.has(entry.remoteId)) continue
    seen.add(entry.remoteId)
    const cliGroup = formatRemoteSwarmCliGroup(entry)
    items.push(cliGroup ? `\`${entry.remoteId}\`（或 \`${cliGroup}\`）` : `\`${entry.remoteId}\``)
  }
  return items.length > 0 ? items.join('、') : null
}
