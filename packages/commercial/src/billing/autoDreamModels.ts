import { getModelCatalogCache } from './modelCatalogRuntime.js'

export const DEFAULT_AUTO_DREAM_MODEL = 'deepseek-v4-flash'

export interface AutoDreamModelOption {
  value: string
  label: string
}

/** Active, billable, public CCB models are the complete admin selector set. */
export async function listAutoDreamModelOptions(): Promise<AutoDreamModelOption[]> {
  const cache = await getModelCatalogCache()
  const snapshot = await cache.assertFresh()
  const out: AutoDreamModelOption[] = []
  for (const id of snapshot.activeModelIds()) {
    const descriptor = snapshot.resolve(id)
    const pricing = snapshot.billingPricingFor(id)
    if (!descriptor || !pricing) continue
    if (descriptor.engine !== 'ccb' || pricing.visibility !== 'public') continue
    out.push({ value: descriptor.canonicalModel, label: pricing.display_name })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN') || a.value.localeCompare(b.value))
}

export async function resolveAutoDreamModel(
  modelId: string,
): Promise<AutoDreamModelOption | null> {
  const models = await listAutoDreamModelOptions()
  return models.find((row) => row.value === modelId) ?? null
}

export async function assertAutoDreamModelSelectable(modelId: string): Promise<void> {
  if (!(await resolveAutoDreamModel(modelId))) {
    throw new Error(`auto-dream model '${modelId}' is not an active public CCB model`)
  }
}
