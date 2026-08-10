import { getModelCatalogCache } from './modelCatalogRuntime.js'

export const TERRA_AUTO_DREAM_MODEL = 'gpt-5.6-terra'
export const DEEPSEEK_AUTO_DREAM_MODEL = 'deepseek-v4-flash'
export const MINIMAX_AUTO_DREAM_MODEL = 'MiniMax-M3'
export const DEFAULT_AUTO_DREAM_MODEL = DEEPSEEK_AUTO_DREAM_MODEL
export const LEGACY_AUTO_DREAM_MODEL = DEEPSEEK_AUTO_DREAM_MODEL
const AUTO_DREAM_OPTIMIZER_ENGINES = new Map<string, 'codex' | 'ccb'>([
  [TERRA_AUTO_DREAM_MODEL, 'codex'],
  [DEEPSEEK_AUTO_DREAM_MODEL, 'ccb'],
  [MINIMAX_AUTO_DREAM_MODEL, 'ccb'],
])

export interface AutoDreamModelOption {
  value: string
  label: string
}

export function isAutoDreamOptimizerModel(
  modelId: string,
  canonicalModel: string,
  engine: string,
): boolean {
  return canonicalModel === modelId && AUTO_DREAM_OPTIMIZER_ENGINES.get(modelId) === engine
}

/** Auto-Dream V2 defaults to DeepSeek while retaining Terra rollback compatibility. */
export async function listAutoDreamModelOptions(): Promise<AutoDreamModelOption[]> {
  const cache = await getModelCatalogCache()
  const snapshot = await cache.assertFresh()
  const out: AutoDreamModelOption[] = []
  for (const id of snapshot.activeModelIds()) {
    const descriptor = snapshot.resolve(id)
    const pricing = snapshot.billingPricingFor(id)
    if (!descriptor || !pricing) continue
    if (
      !isAutoDreamOptimizerModel(id, descriptor.canonicalModel, descriptor.engine) ||
      pricing.visibility !== 'public'
    )
      continue
    out.push({ value: descriptor.canonicalModel, label: pricing.display_name })
  }
  return out.sort(
    (a, b) => a.label.localeCompare(b.label, 'zh-CN') || a.value.localeCompare(b.value),
  )
}

export async function resolveAutoDreamModel(modelId: string): Promise<AutoDreamModelOption | null> {
  const models = await listAutoDreamModelOptions()
  return models.find((row) => row.value === modelId) ?? null
}

/** Existing V1 users stay on the former CCB path until they explicitly consent to V2. */
export async function resolveLegacyAutoDreamModel(): Promise<AutoDreamModelOption | null> {
  const cache = await getModelCatalogCache()
  const snapshot = await cache.assertFresh()
  const descriptor = snapshot.resolve(LEGACY_AUTO_DREAM_MODEL)
  const pricing = snapshot.billingPricingFor(LEGACY_AUTO_DREAM_MODEL)
  if (
    !descriptor ||
    !pricing ||
    descriptor.engine !== 'ccb' ||
    descriptor.canonicalModel !== LEGACY_AUTO_DREAM_MODEL ||
    pricing.visibility !== 'public' ||
    !snapshot.activeModelIds().includes(LEGACY_AUTO_DREAM_MODEL)
  ) {
    return null
  }
  return { value: descriptor.canonicalModel, label: pricing.display_name }
}

export async function assertAutoDreamModelSelectable(modelId: string): Promise<void> {
  if (!(await resolveAutoDreamModel(modelId))) {
    throw new Error(`auto-dream model '${modelId}' is not an active public optimizer model`)
  }
}
