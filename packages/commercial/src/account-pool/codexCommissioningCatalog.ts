import { ModelCatalogSnapshot, parseCapabilityProfile } from '../billing/modelCatalog.js'
import type { CatalogSource } from '../http/proxy/modelAuthorityGate.js'
import type { UserModelAuthzLoader } from '../auth/userModelAuthz.js'
import { projectCodexRemoteCapabilities } from './codexRemoteProfile.js'
import { COMMISSION_MODEL,COMMISSION_UPSTREAM,requireCommission,type CommissionRun } from './codexCommissioningStore.js'
/** Private derived view, never cached globally or published. Both source and derived denies apply. */
export function commissionCatalog(source:CatalogSource,loadAuthz:UserModelAuthzLoader,run:CommissionRun,fence:()=>Promise<void>):CatalogSource {
  return {async assertFresh(){
    await fence()
    const live=await source.assertFresh(),authz=await loadAuthz(3n,live.securityEpoch)
    requireCommission(authz.role==='admin' && live.canUseModel({...authz,uid:3},COMMISSION_UPSTREAM) && !authz.deniedModelIds?.has(COMMISSION_MODEL),'SOURCE_MODEL_DENIED')
    const entry=live.entries.find(e=>e.modelId===COMMISSION_UPSTREAM && e.state==='active'),price=live.pricing.get(COMMISSION_UPSTREAM)
    requireCommission(entry?.engine==='codex' && price && (entry.upstreamModelId??entry.modelId)===COMMISSION_UPSTREAM,'SOURCE_MODEL_UNAVAILABLE')
    const capabilityProfile=parseCapabilityProfile(COMMISSION_MODEL,projectCodexRemoteCapabilities({probe_snapshot:run.probe},COMMISSION_UPSTREAM))
    return new ModelCatalogSnapshot({entries:[{...entry,modelId:COMMISSION_MODEL,upstreamModelId:COMMISSION_UPSTREAM,placement:'remote_pool',capabilityProfile}],
      aliases:new Map(),pricing:new Map([[COMMISSION_MODEL,{...price,modelId:COMMISSION_MODEL,defaultEffort:'low'}]]),securityEpoch:live.securityEpoch})
  }}
}
