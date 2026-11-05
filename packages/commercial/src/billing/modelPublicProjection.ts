/** Shared public projection; retain the HTTP picker pricing and authorization semantics. */
import { COST_INDEX_BASELINE_MODEL_ID, costXVsBaseline } from '@openclaude/protocol'
import { perKtokCredits, type PublicModel } from './pricing.js'
import type { ModelCatalogSnapshot, ModelPlacement, UserModelScope } from './modelCatalog.js'

/**
 * OCV5-721: Transition-period remote brain pool models automatically display with a " 远端" suffix
 * so users and operators can clearly distinguish remote-pool models from local models in the picker.
 */
export function formatRemoteModelDisplayName(
  displayName: string,
  placement?: ModelPlacement,
  modelId?: string,
): string {
  const isRemote =
    placement === 'remote_pool' || (typeof modelId === 'string' && modelId.endsWith('-remote'))
  if (!isRemote) return displayName
  const trimmed = displayName.trim()
  if (trimmed.endsWith(' 远端') || trimmed.endsWith('（远端）') || trimmed.endsWith('(远端)')) {
    return displayName
  }
  return `${trimmed} 远端`
}

/** `/api/public/models` 的 catalog 投影行:PublicModel + catalog 的 provider 归属(方案 §6)。 */
export interface PublicModelProjection extends PublicModel {
  /** catalog.provider_id(engine='codex' 的虚拟条目也有值;null = 未归属静态 provider)。 */
  provider_id: string | null;
  placement?: ModelPlacement;
}

/**
 * active catalog + pricing join → 公共/用户投影(单一权威;不经 PricingCache)。
 *
 * 价格来自快照里随 catalog 同一个 REPEATABLE READ 事务读进来的 pricing 行 —— 与
 * `snapshot.listForUser` 的行集天然一致(不会出现"catalog 说有、pricing 说无"的半行)。
 */
export function projectPublicModels(
  snapshot: ModelCatalogSnapshot,
  scope: UserModelScope,
  degraded: ReadonlySet<string>,
): PublicModelProjection[] {
  const out: PublicModelProjection[] = [];
  for (const row of snapshot.listForUser(scope)) {
    // listForUser 已保证可路由(有价);这里 get 只是取值,理论不可能 miss。
    const p = snapshot.pricing.get(row.modelId);
    if (!p) continue;
    const baseline = snapshot.pricing.get(COST_INDEX_BASELINE_MODEL_ID);
    const costX = costXVsBaseline(
      {
        inputPerMtok: p.inputPerMtok,
        cacheReadPerMtok: p.cacheReadPerMtok,
        outputPerMtok: p.outputPerMtok,
        multiplier: p.multiplier,
      },
      baseline
        ? {
            inputPerMtok: baseline.inputPerMtok,
            cacheReadPerMtok: baseline.cacheReadPerMtok,
            outputPerMtok: baseline.outputPerMtok,
            multiplier: baseline.multiplier,
          }
        : null,
    );
    out.push({
      id: row.modelId,
      display_name: formatRemoteModelDisplayName(row.displayName, row.placement, row.modelId),
      input_per_ktok_credits: perKtokCredits(p.inputPerMtok, p.multiplier),
      output_per_ktok_credits: perKtokCredits(p.outputPerMtok, p.multiplier),
      cache_read_per_ktok_credits: perKtokCredits(p.cacheReadPerMtok, p.multiplier),
      cache_write_per_ktok_credits: perKtokCredits(p.cacheWritePerMtok, p.multiplier),
      multiplier: p.multiplier,
      supported_efforts: [...row.supportedEfforts],
      engine: row.engine,
      context_window: row.contextWindow,
      supports_vision: row.supportsVision,
      provider_id: row.providerId,
      ...(row.placement === 'remote_pool' ? { placement: 'remote_pool' as const } : {}),
      ...(costX !== undefined ? { cost_x: costX } : {}),
      ...(row.providerId && degraded.has(row.providerId) ? { degraded: true } : {}),
      ...(row.promoLabel ? { promo_label: row.promoLabel } : {}),
    });
  }
  return out;
}

/** Locked picker rows: visible except for the subscription floor. */
export interface LockedPublicModelProjection {
  id: string;
  display_name?: string;
  engine?: string;
  min_plan_code: string;
  min_plan_name?: string;
  cost_x?: number;
  promo_label?: string;
  placement?: ModelPlacement;
}

export function projectLockedModels(
  snapshot: ModelCatalogSnapshot,
  scope: UserModelScope,
): LockedPublicModelProjection[] {
  const out: LockedPublicModelProjection[] = [];
  for (const row of snapshot.listLockedForUser(scope)) {
    const p = snapshot.pricing.get(row.modelId);
    if (!p) continue;
    const baseline = snapshot.pricing.get(COST_INDEX_BASELINE_MODEL_ID);
    const costX = costXVsBaseline(
      {
        inputPerMtok: p.inputPerMtok,
        cacheReadPerMtok: p.cacheReadPerMtok,
        outputPerMtok: p.outputPerMtok,
        multiplier: p.multiplier,
      },
      baseline
        ? {
            inputPerMtok: baseline.inputPerMtok,
            cacheReadPerMtok: baseline.cacheReadPerMtok,
            outputPerMtok: baseline.outputPerMtok,
            multiplier: baseline.multiplier,
          }
        : null,
    );
    out.push({
      id: row.modelId,
      display_name: formatRemoteModelDisplayName(row.displayName, row.placement, row.modelId),
      engine: row.engine,
      min_plan_code: row.minPlanCode,
      ...(row.placement === 'remote_pool' ? { placement: 'remote_pool' as const } : {}),
      ...(row.minPlanName ? { min_plan_name: row.minPlanName } : {}),
      ...(costX !== undefined ? { cost_x: costX } : {}),
      ...(row.promoLabel ? { promo_label: row.promoLabel } : {}),
    });
  }
  return out;
}

