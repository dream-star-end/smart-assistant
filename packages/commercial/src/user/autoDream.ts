import { getSystemSetting } from '../admin/systemSettings.js'
import { resolveAutoDreamModel } from '../billing/autoDreamModels.js'
import { query } from '../db/queries.js'

export const AUTO_DREAM_MINIMUM_PLAN_CODE = 'max'
export const AUTO_DREAM_MIN_INTERVAL_HOURS = 24
export const AUTO_DREAM_MIN_NEW_SESSIONS = 5

export interface AutoDreamFeature {
  eligible: boolean
  available: boolean
  enabled: boolean
  effective: boolean
  minimum_plan_code: typeof AUTO_DREAM_MINIMUM_PLAN_CODE
  min_interval_hours: number
  min_new_sessions: number
}

async function resolveAutoDreamEntitlement(userId: bigint | number | string) {
  const [eligible, setting] = await Promise.all([
    isAutoDreamEligible(userId),
    getSystemSetting('auto_dream_model'),
  ])
  let model: Awaited<ReturnType<typeof resolveAutoDreamModel>> = null
  try {
    model = await resolveAutoDreamModel(setting.value)
  } catch {
    model = null
  }
  return { eligible, modelId: setting.value, model }
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
): Promise<AutoDreamFeature> {
  const { eligible, model } = await resolveAutoDreamEntitlement(userId)
  const available = model !== null
  return {
    eligible,
    available,
    enabled,
    effective: eligible && available && enabled,
    minimum_plan_code: AUTO_DREAM_MINIMUM_PLAN_CODE,
    min_interval_hours: AUTO_DREAM_MIN_INTERVAL_HOURS,
    min_new_sessions: AUTO_DREAM_MIN_NEW_SESSIONS,
  }
}

export type AutoDreamPolicy =
  | { enabled: false }
  | {
      enabled: true
      modelId: string
      modelName: string
      minIntervalHours: number
      minNewSessions: number
    }

export async function getAutoDreamPolicy(userId: bigint | number | string): Promise<AutoDreamPolicy> {
  const { getPreferences } = await import('./preferences.js')
  const [snap, entitlement] = await Promise.all([
    getPreferences(String(userId)),
    resolveAutoDreamEntitlement(userId),
  ])
  if (
    snap.prefs.auto_dream_enabled !== true ||
    !entitlement.eligible ||
    entitlement.model === null
  )
    return { enabled: false }
  return {
    enabled: true,
    modelId: entitlement.modelId,
    modelName: entitlement.model.label,
    minIntervalHours: AUTO_DREAM_MIN_INTERVAL_HOURS,
    minNewSessions: AUTO_DREAM_MIN_NEW_SESSIONS,
  }
}
