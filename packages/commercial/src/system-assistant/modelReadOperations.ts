/** Same fresh catalog, scope and public projections as the existing model picker. */
import { z } from 'zod'
import type { ModelCatalogCache } from '../billing/modelCatalog.js'
import { scopeFromAuthz, type UserModelAuthzLoader } from '../auth/userModelAuthz.js'
import { projectPublicModels, projectLockedModels } from '../billing/modelPublicProjection.js'
import { SystemOperationRejected, type SystemActor, type SystemOperation } from './operations.js'
export interface SystemModelReadSources {
  catalog?: Pick<ModelCatalogCache, 'assertFresh'>
  loadUserModelAuthz: UserModelAuthzLoader
  getDegradedProviders(): Promise<ReadonlySet<string>>
}
export function modelReadOperations(deps: { authorize(actor: SystemActor): Promise<void>; sources?: SystemModelReadSources }): SystemOperation[] {
  return [{ id: 'models.available.list', version: 1, title: '查看本人可用模型与价格', topic: 'models', effect: 'read', executor: 'master',
    roles: ['user','admin'], schema: z.object({}).strict(), input: {}, authorize: deps.authorize,
    read: async actor => {
      const sources = deps.sources
      if (!sources?.catalog) throw new SystemOperationRejected('UNAVAILABLE')
      const snapshot = await sources.catalog.assertFresh()
      const authz = await sources.loadUserModelAuthz(BigInt(actor.userId), snapshot.securityEpoch)
      if (authz.role !== actor.role) throw new SystemOperationRejected('FORBIDDEN')
      const scope = scopeFromAuthz(actor.userId, authz)
      const degraded = await sources.getDegradedProviders()
      return { models: projectPublicModels(snapshot, scope, degraded), locked_models: projectLockedModels(snapshot, scope) }
    },
  }]
}
