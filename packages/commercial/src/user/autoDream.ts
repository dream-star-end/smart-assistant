import { getSystemSetting } from '../admin/systemSettings.js'
import {
  LEGACY_AUTO_DREAM_MODEL,
  resolveAutoDreamModel,
  resolveLegacyAutoDreamModel,
} from '../billing/autoDreamModels.js'
import { query } from '../db/queries.js'

export const AUTO_DREAM_MINIMUM_PLAN_CODE = 'max'
export const AUTO_DREAM_LEGACY_MIN_INTERVAL_HOURS = 24
export const AUTO_DREAM_OPTIMIZER_MIN_INTERVAL_HOURS = 24 * 7
export const AUTO_DREAM_MIN_NEW_SESSIONS = 5

/** Mutual exclusion is the rollback safety boundary: an old runtime only
 * understands auto_dream_enabled, so V2 consent must persist it as false. */
export function normalizeAutoDreamPreferencePatch(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const patch = { ...raw }
  if (patch.auto_optimizer_enabled === true) {
    patch.auto_dream_enabled = false
  } else if (patch.auto_dream_enabled === true) {
    patch.auto_optimizer_enabled = false
  } else if (patch.auto_optimizer_enabled === false) {
    patch.auto_dream_enabled = false
  }
  return patch
}

export interface AutoDreamFeature {
  eligible: boolean
  available: boolean
  enabled: boolean
  optimizer_enabled: boolean
  legacy_enabled: boolean
  effective: boolean
  telemetry_ready: boolean | null
  telemetry_blockers: string[]
  minimum_plan_code: typeof AUTO_DREAM_MINIMUM_PLAN_CODE
  min_interval_hours: number
  min_new_sessions: number
}

export type AutoDreamMode = 'legacy_memory_v1' | 'optimizer_v2'

async function resolveConfiguredAutoDreamModel() {
  const setting = await getSystemSetting('auto_dream_model')
  let model: Awaited<ReturnType<typeof resolveAutoDreamModel>> = null
  try {
    model = await resolveAutoDreamModel(setting.value)
  } catch {
    model = null
  }
  return { modelId: setting.value, model }
}

export async function resolveAutoDreamModelForMode(mode: AutoDreamMode) {
  if (mode === 'legacy_memory_v1') {
    let model: Awaited<ReturnType<typeof resolveLegacyAutoDreamModel>> = null
    try {
      model = await resolveLegacyAutoDreamModel()
    } catch {
      model = null
    }
    return { modelId: LEGACY_AUTO_DREAM_MODEL, model }
  }
  return resolveConfiguredAutoDreamModel()
}

async function resolveAutoDreamEntitlement(
  userId: bigint | number | string,
  mode: AutoDreamMode,
) {
  const [eligible, resolved] = await Promise.all([
    isAutoDreamEligible(userId),
    resolveAutoDreamModelForMode(mode),
  ])
  return { eligible, modelId: resolved.modelId, model: resolved.model }
}

/** Active, unexpired personal subscription at or above the Max tier. */
export async function isAutoDreamEligible(userId: bigint | number | string): Promise<boolean> {
  const r = await query<{ eligible: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM user_subscriptions s
         JOIN subscription_plans current_plan
           ON current_plan.code = s.plan_code AND current_plan.scope = 'user'
         JOIN subscription_plans max_plan
           ON max_plan.code = $2 AND max_plan.scope = 'user'
        WHERE s.user_id = $1
          AND s.status = 'active'
          AND s.period_end > NOW()
          AND current_plan.tier >= max_plan.tier
     ) AS eligible`,
    [String(userId), AUTO_DREAM_MINIMUM_PLAN_CODE],
  )
  return r.rows[0]?.eligible === true
}

/** GET/preferences projection. Catalog failures degrade to available=false. */
export async function getAutoDreamFeature(
  userId: bigint | number | string,
  enabled: boolean,
  optimizerEnabled = false,
): Promise<AutoDreamFeature> {
  // The UI switch driven by `features.auto_dream.available` (MemoryContextHealthCard)
  // exclusively toggles `auto_dream_enabled` (`legacy_memory_v1`), while optimizer V2
  // uses its own endpoint and `auto_optimizer_enabled` flag. Thus `available` checks
  // `optimizer_v2` ONLY when optimizer is active/requested, and `legacy_memory_v1`
  // otherwise — keeping display and PATCH validation 100% symmetric in both directions.
  const mode: AutoDreamMode = optimizerEnabled ? 'optimizer_v2' : 'legacy_memory_v1'
  const { eligible, model } = await resolveAutoDreamEntitlement(userId, mode)
  const available = model !== null
  const readiness = optimizerEnabled
    ? await import('../analytics/telemetryReadiness.js')
        .then((mod) => mod.evaluateTelemetryReadiness(userId))
        .catch(() => null)
    : null
  return {
    eligible,
    available,
    enabled: enabled || optimizerEnabled,
    optimizer_enabled: optimizerEnabled,
    legacy_enabled: enabled,
    effective:
      eligible && available && (enabled || optimizerEnabled)
      && (!optimizerEnabled || readiness?.ready === true),
    telemetry_ready: optimizerEnabled ? readiness?.ready ?? false : null,
    telemetry_blockers: optimizerEnabled ? readiness?.blockers ?? ['telemetry_unavailable'] : [],
    minimum_plan_code: AUTO_DREAM_MINIMUM_PLAN_CODE,
    // Report the cadence of the mode that would actually run.
    min_interval_hours: optimizerEnabled
      ? AUTO_DREAM_OPTIMIZER_MIN_INTERVAL_HOURS
      : AUTO_DREAM_LEGACY_MIN_INTERVAL_HOURS,
    min_new_sessions: AUTO_DREAM_MIN_NEW_SESSIONS,
  }
}

export type AutoDreamPolicy =
  | { enabled: false }
  | {
      enabled: true
      mode: AutoDreamMode
      modelId: string
      modelName: string
      minIntervalHours: number
      minNewSessions: number
      auditContext?: {
        preferences: Record<string, unknown>
        installedPlugins: Array<{ slug: string; kind: string }>
      }
    }

export async function getAutoDreamPolicy(userId: bigint | number | string): Promise<AutoDreamPolicy> {
  const { getPreferences } = await import('./preferences.js')
  const snap = await getPreferences(String(userId))
  const optimizerEnabled = snap.prefs.auto_optimizer_enabled === true
  const legacyEnabled = snap.prefs.auto_dream_enabled === true
  if (!optimizerEnabled && !legacyEnabled) return { enabled: false }
  if (optimizerEnabled) {
    const readiness = await import('../analytics/telemetryReadiness.js')
      .then((mod) => mod.evaluateTelemetryReadiness(userId))
      .catch(() => null)
    if (!readiness?.ready) return { enabled: false }
  }
  const eligible = await isAutoDreamEligible(userId)
  if (!eligible) return { enabled: false }
  const mode: AutoDreamMode = optimizerEnabled ? 'optimizer_v2' : 'legacy_memory_v1'
  const entitlement = await resolveAutoDreamModelForMode(mode)
  if (entitlement.model === null) return { enabled: false }
  let auditContext:
    | {
        preferences: Record<string, unknown>
        installedPlugins: Array<{ slug: string; kind: string }>
      }
    | undefined
  if (optimizerEnabled) {
    const { listInstalled } = await import('../marketplace/marketplaceDb.js')
    const installed = await listInstalled(Number(userId))
    const { auto_dream_enabled: _legacy, auto_optimizer_enabled: _optimizer, ...preferences } =
      snap.prefs
    auditContext = {
      preferences,
      installedPlugins: installed.map((row) => ({ slug: row.slug, kind: row.kind })),
    }
  }
  return {
    enabled: true,
    mode: optimizerEnabled ? 'optimizer_v2' : 'legacy_memory_v1',
    modelId: entitlement.modelId,
    modelName: entitlement.model.label,
    minIntervalHours: optimizerEnabled
      ? AUTO_DREAM_OPTIMIZER_MIN_INTERVAL_HOURS
      : AUTO_DREAM_LEGACY_MIN_INTERVAL_HOURS,
    minNewSessions: AUTO_DREAM_MIN_NEW_SESSIONS,
    ...(auditContext ? { auditContext } : {}),
  }
}
