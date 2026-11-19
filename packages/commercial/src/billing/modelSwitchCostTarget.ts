import { DEFAULT_CODEX_ENGINE_MODEL } from '@openclaude/protocol'
import { peekModelCatalogCache } from './modelCatalogRuntime.js'
import { scopeFromAuthz, type UserModelAuthzLoader } from '../auth/userModelAuthz.js'
import { ModelSwitchCostError, ModelSwitchCostService, type ModelSwitchCostDeps } from './modelSwitchCost.js'
import { LEGACY_TEAM_LEADER_FALLBACK_MODEL } from '../ws/teamModeForwarding.js'
/** Authorization and both prices share the same fenced catalog snapshot. */
export function makeModelSwitchCostTargetResolver(
  loadUserModelAuthz: UserModelAuthzLoader,
  getCatalog: () => ReturnType<typeof peekModelCatalogCache> = peekModelCatalogCache,
): ModelSwitchCostDeps['resolveTarget'] {
  return async (uid, id, _contextTier, opts) => {
    const catalog = getCatalog()
    if (!catalog)
      throw new ModelSwitchCostError('MODEL_SWITCH_UNAVAILABLE', '模型价格暂不可用，请重试')
    const snapshot = await catalog.assertFresh()
    let canonical = snapshot.aliasToCanonical(id)
    const authz = await loadUserModelAuthz(BigInt(uid), snapshot.securityEpoch)
    const scope = scopeFromAuthz(uid, authz)
    if (!snapshot.canUseModel(scope, canonical)) {
      if (
        opts?.allowLegacyTeamLeaderFallback === true &&
        canonical === DEFAULT_CODEX_ENGINE_MODEL &&
        snapshot.billingPricingFor(LEGACY_TEAM_LEADER_FALLBACK_MODEL)?.enabled &&
        snapshot.canUseModel(scope, LEGACY_TEAM_LEADER_FALLBACK_MODEL)
      ) {
        canonical = LEGACY_TEAM_LEADER_FALLBACK_MODEL
      } else {
        throw new ModelSwitchCostError('UNAUTHORIZED_MODEL', '无权使用目标模型')
      }
    }
    const descriptor = snapshot.resolve(canonical)
    const price = snapshot.billingPricingFor(canonical)
    if (!descriptor || !price)
      throw new ModelSwitchCostError('MODEL_NOT_AVAILABLE', '目标模型当前不可用')
    return {
      pricing: price,
      engine: descriptor.engine,
      contextWindow: descriptor.contextWindow ?? 0,
      canonicalize: (model: string) => snapshot.aliasToCanonical(model),
      sourcePricing: (model: string) =>
        snapshot.billingPricingFor(snapshot.aliasToCanonical(model)),
      sourceEngine: (model: string) =>
        snapshot.resolve(snapshot.aliasToCanonical(model))?.engine ?? null,
    }
  }
}

export function makeModelSwitchCostService(
  deps: Pick<ModelSwitchCostDeps, 'pool' | 'pricing' | 'secret'>,
  loadUserModelAuthz: UserModelAuthzLoader,
) {
  return new ModelSwitchCostService({
    ...deps,
    sourceEngine: id => peekModelCatalogCache()?.current().resolve(id)?.engine ?? null,
    resolveTarget: makeModelSwitchCostTargetResolver(loadUserModelAuthz),
  })
}
