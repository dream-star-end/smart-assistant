import type { EnginePreheatPreparation, EnginePreheatRequest } from './enginePreheatClient.js'

export function makeEnginePreheatPreparation(deps: {
  resolveAllowedModel: (uid: bigint, model: string) => Promise<{ canonicalModel: string; engine: string } | null>
  listGroups: (model: string) => Promise<Array<{ id: bigint; kind: string }>>
  hasOfficial: (groupId: bigint) => Promise<boolean>
}): (uid: bigint, args: EnginePreheatRequest) => Promise<EnginePreheatPreparation | null> {
  return async (uid, args) => {
    if (!args.modelId) return null
    try {
      const model = await deps.resolveAllowedModel(uid, args.modelId)
      if (!model) return null
      if (model.engine !== 'codex') return args.codexOnly ? null : { modelId: model.canonicalModel }
      for (const group of await deps.listGroups(model.canonicalModel)) {
        // Never skip a preferred API group or mint a route token for speculation.
        if (group.kind !== 'official_oauth') return null
        if (await deps.hasOfficial(group.id)) {
          return { modelId: model.canonicalModel, codexRouteHint: { kind: 'official_oauth' } }
        }
      }
    } catch { /* An uncertain authorization/route never starts speculative work. */ }
    return null
  }
}
