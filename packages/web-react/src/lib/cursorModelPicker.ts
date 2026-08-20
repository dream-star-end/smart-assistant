import {
  type ContextTierFamily,
  type ContextTierFamilyId,
  type CursorEngineFamilyId,
  type CursorEngineModel,
  type PlatformReasoningEffort,
  contextFamilyByModelId,
  contextFamilyDefaultLong,
  cursorFamilyDefaultEffort,
  cursorFamilyDefaultFast,
  cursorFamilyEfforts,
  cursorModelById,
  formatCostX,
} from '@openclaude/protocol'
import type { PublicModel } from './types'

export type CursorPickerRow = {
  family: CursorEngineFamilyId
  label: string
  members: PublicModel[]
}

export type ContextPickerRow = {
  family: ContextTierFamilyId
  label: string
  members: PublicModel[]
  spec: ContextTierFamily
}

export type ModelPickerRow =
  | { kind: 'plain'; model: PublicModel }
  | { kind: 'cursor-family'; row: CursorPickerRow }
  | { kind: 'context-family'; row: ContextPickerRow }

export function cursorDefFor(modelId: string | null | undefined): CursorEngineModel | undefined {
  return cursorModelById(modelId)
}

export function modelCostLabel(model: PublicModel | undefined): string | undefined {
  const raw = model?.cost_x
  return formatCostX(typeof raw === 'number' ? raw : undefined)
}

/** Collapse public Cursor / GPT / Kimi catalog rows into one picker row per family. */
export function modelPickerRows(models: readonly PublicModel[]): ModelPickerRow[] {
  const seenCursor = new Set<CursorEngineFamilyId>()
  const seenContext = new Set<ContextTierFamilyId>()
  const rows: ModelPickerRow[] = []
  for (const model of models) {
    const cursor = cursorModelById(model.id)
    if (cursor) {
      if (seenCursor.has(cursor.family)) continue
      seenCursor.add(cursor.family)
      rows.push({
        kind: 'cursor-family',
        row: {
          family: cursor.family,
          label: cursor.familyLabel,
          members: models.filter((item) => cursorModelById(item.id)?.family === cursor.family),
        },
      })
      continue
    }
    const context = contextFamilyByModelId(model.id)
    if (context) {
      if (seenContext.has(context.family)) continue
      seenContext.add(context.family)
      const ids = new Set<string>([context.standardId, context.longId])
      rows.push({
        kind: 'context-family',
        row: {
          family: context.family,
          label: context.familyLabel,
          spec: context,
          members: models.filter((item) => ids.has(item.id)),
        },
      })
      continue
    }
    rows.push({ kind: 'plain', model })
  }
  return rows
}

export function availableCursorEfforts(members: readonly PublicModel[]): PlatformReasoningEffort[] {
  const family = membersCursorFamily(members)
  if (!family) return []
  const present = new Set(
    members
      .map((model) => cursorModelById(model.id)?.effort)
      .filter((effort): effort is PlatformReasoningEffort => effort != null),
  )
  return cursorFamilyEfforts(family).filter((effort) => present.has(effort))
}

function membersCursorFamily(members: readonly PublicModel[]): CursorEngineFamilyId | undefined {
  return cursorModelById(members[0]?.id)?.family
}

export function cursorFamilyHasFast(
  members: readonly PublicModel[],
  effort: PlatformReasoningEffort | null,
): boolean {
  return members.some((model) => {
    const def = cursorModelById(model.id)
    return (
      def?.fast === true && def.effort === effort && def.family === membersCursorFamily(members)
    )
  })
}

export function cursorFamilyHasStandard(
  members: readonly PublicModel[],
  effort: PlatformReasoningEffort | null,
): boolean {
  return members.some((model) => {
    const def = cursorModelById(model.id)
    return (
      def?.fast === false && def.effort === effort && def.family === membersCursorFamily(members)
    )
  })
}

export function pickCursorPublicModel(
  members: readonly PublicModel[],
  family: CursorEngineFamilyId,
  desiredEffort: PlatformReasoningEffort | null,
  desiredFast: boolean,
): PublicModel | undefined {
  const healthy = (model: PublicModel) => (model as { degraded?: unknown }).degraded !== true
  const match = (effort: PlatformReasoningEffort | null, fast: boolean, requireHealthy: boolean) =>
    members.find((model) => {
      const def = cursorModelById(model.id)
      if (!def || def.family !== family || def.effort !== effort || def.fast !== fast) return false
      return requireHealthy ? healthy(model) : true
    })

  return (
    match(desiredEffort, desiredFast, true) ??
    match(desiredEffort, !desiredFast, true) ??
    match(cursorFamilyDefaultEffort(family), cursorFamilyDefaultFast(family), true) ??
    members.find(healthy) ??
    match(desiredEffort, desiredFast, false) ??
    members[0]
  )
}

export function resolveCursorPickerSelection(
  members: readonly PublicModel[],
  family: CursorEngineFamilyId,
  currentId: string | undefined,
  next?: { effort?: PlatformReasoningEffort | null; fast?: boolean },
): string | undefined {
  const current = cursorModelById(currentId)
  const effort =
    next && 'effort' in next
      ? (next.effort ?? null)
      : current
        ? current.effort
        : cursorFamilyDefaultEffort(family)
  const fast =
    next && 'fast' in next
      ? Boolean(next.fast)
      : current
        ? current.fast
        : cursorFamilyDefaultFast(family)
  return pickCursorPublicModel(members, family, effort, fast)?.id
}

export function longContextCostConfirmationRequired(
  sourceModelId: string | null | undefined,
  targetModelId: string | null | undefined,
): boolean {
  const target = contextFamilyByModelId(targetModelId)
  if (!target || target.longId !== targetModelId) return false
  const source = contextFamilyByModelId(sourceModelId)
  return !source || source.longId !== sourceModelId
}

export function contextFamilyHasLong(
  members: readonly PublicModel[],
  spec: ContextTierFamily,
): boolean {
  return members.some((model) => model.id === spec.longId)
}

export function contextFamilyHasStandard(
  members: readonly PublicModel[],
  spec: ContextTierFamily,
): boolean {
  return members.some((model) => model.id === spec.standardId)
}

export function pickContextPublicModel(
  members: readonly PublicModel[],
  spec: ContextTierFamily,
  longContext: boolean,
): PublicModel | undefined {
  const healthy = (model: PublicModel) => (model as { degraded?: unknown }).degraded !== true
  const desiredId = longContext ? spec.longId : spec.standardId
  const fallbackId = longContext ? spec.standardId : spec.longId
  return (
    members.find((model) => model.id === desiredId && healthy(model)) ??
    members.find((model) => model.id === fallbackId && healthy(model)) ??
    members.find(healthy) ??
    members.find((model) => model.id === desiredId) ??
    members[0]
  )
}

export function resolveContextPickerSelection(
  members: readonly PublicModel[],
  spec: ContextTierFamily,
  currentId: string | undefined,
  next?: { longContext?: boolean },
): string | undefined {
  const current = contextFamilyByModelId(currentId)
  const longContext =
    next && 'longContext' in next
      ? Boolean(next.longContext)
      : current
        ? current.longId === currentId
        : contextFamilyDefaultLong(spec.family)
  return pickContextPublicModel(members, spec, longContext)?.id
}
