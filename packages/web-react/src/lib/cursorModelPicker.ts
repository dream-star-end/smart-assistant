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
import type { LockedPublicModel, PublicModel } from './types'

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

export type LockedCursorFamilyRow = {
  family: CursorEngineFamilyId
  label: string
  minPlanCode: string
  minPlanName?: string
  representative: LockedPublicModel
}

export type ModelPickerRow =
  | { kind: 'plain'; model: PublicModel }
  | { kind: 'cursor-family'; row: CursorPickerRow }
  | { kind: 'context-family'; row: ContextPickerRow }
  | { kind: 'locked-cursor-family'; row: LockedCursorFamilyRow }
  | { kind: 'locked-plain'; model: LockedPublicModel }

export function cursorDefFor(modelId: string | null | undefined): CursorEngineModel | undefined {
  return cursorModelById(modelId)
}

export function modelCostLabel(model: { cost_x?: number } | undefined): string | undefined {
  const raw = model?.cost_x
  return formatCostX(typeof raw === 'number' ? raw : undefined)
}

/**
 * 模型是否被后端标注为降级(0108 provider 健康度)。前端类型宽松透传,运行时 narrowing。
 * ModelSelector 与 picker 排序共用同一判定,避免两套语义漂移。
 */
export function isModelDegraded(m: PublicModel): boolean {
  return (m as { degraded?: unknown }).degraded === true
}

/** 整行(plain 模型或家族全员)是否降级——降级行在 picker 里沉底。 */
function rowDegraded(row: ModelPickerRow): boolean {
  if (row.kind === 'plain') return isModelDegraded(row.model)
  if (row.kind === 'locked-plain' || row.kind === 'locked-cursor-family') return false
  return row.row.members.length > 0 && row.row.members.every(isModelDegraded)
}

function pickLockedCursorRepresentative(members: readonly LockedPublicModel[]): LockedPublicModel {
  const family = cursorModelById(members[0]?.id)?.family
  const desiredEffort = family ? cursorFamilyDefaultEffort(family) : null
  const desiredFast = family ? cursorFamilyDefaultFast(family) : false
  const match = (effort: ReturnType<typeof cursorFamilyDefaultEffort>, fast: boolean) =>
    members.find((model) => {
      const def = cursorModelById(model.id)
      return Boolean(def && def.effort === effort && def.fast === fast)
    })
  return (
    match(desiredEffort, desiredFast) ??
    members.find((model) => cursorModelById(model.id)?.fast === false) ??
    members[0]!
  )
}

function lockedPickerRows(
  models: readonly PublicModel[],
  lockedModels: readonly LockedPublicModel[],
  usableCursorFamilies: ReadonlySet<CursorEngineFamilyId>,
): ModelPickerRow[] {
  const usableIds = new Set(models.map((model) => model.id))
  const rows: ModelPickerRow[] = []
  const seenLockedCursor = new Set<CursorEngineFamilyId>()
  const seenLockedPlain = new Set<string>()
  for (const locked of lockedModels) {
    const cursor = cursorModelById(locked.id)
    if (cursor) {
      if (usableCursorFamilies.has(cursor.family) || seenLockedCursor.has(cursor.family)) continue
      seenLockedCursor.add(cursor.family)
      const members = lockedModels.filter(
        (item) => cursorModelById(item.id)?.family === cursor.family,
      )
      const representative = pickLockedCursorRepresentative(members)
      rows.push({
        kind: 'locked-cursor-family',
        row: {
          family: cursor.family,
          label: cursor.familyLabel,
          minPlanCode: representative.min_plan_code,
          minPlanName: representative.min_plan_name,
          representative,
        },
      })
      continue
    }
    if (usableIds.has(locked.id) || seenLockedPlain.has(locked.id)) continue
    seenLockedPlain.add(locked.id)
    rows.push({ kind: 'locked-plain', model: locked })
  }
  return rows
}

/** Collapse public Cursor / GPT / Kimi catalog rows into one picker row per family. */
export function modelPickerRows(
  models: readonly PublicModel[],
  lockedModels: readonly LockedPublicModel[] = [],
): ModelPickerRow[] {
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
  // 可用 → 订阅锁定 → 降级沉底。家族只要 models 里有任一成员就不渲染锁定行。
  const usable = rows.filter((row) => !rowDegraded(row))
  const degraded = rows.filter(rowDegraded)
  return [...usable, ...lockedPickerRows(models, lockedModels, seenCursor), ...degraded]
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

/** 订阅门槛最低档:任何付费档都能解锁时,说明文案强调「任意订阅」。 */
export const LOWEST_PAID_PLAN_CODE = 'lite'

export type LockedModelUnlockNotice = {
  title: string
  /** 说明段落,按顺序渲染。 */
  paragraphs: string[]
  confirmText: string
  cancelText: string
}

/**
 * 点击锁定模型行时的说明文案(OCV5-86)。之前只 toast 一句就直接跳订阅面板,用户不知道为什么
 * 被锁、也不知道任意一档订阅都够。min_plan_code=lite(最低付费档)→ 明说「开通任意订阅套餐即可
 * 解锁」;更高门槛 → 「需 {plan} 及以上套餐」。纯函数,方便单测锁死措辞。
 */
export function lockedModelUnlockNotice(info: {
  label: string
  minPlanCode: string
  minPlanName?: string
}): LockedModelUnlockNotice {
  const label = info.label.trim() || '该模型'
  const planName = info.minPlanName?.trim() || info.minPlanCode
  const anyPaid = info.minPlanCode.trim().toLowerCase() === LOWEST_PAID_PLAN_CODE
  const gate = anyPaid
    ? `开通任意订阅套餐(${planName} 及以上任一档)即可解锁,无需选择特定档位。`
    : `需订阅 ${planName} 及以上套餐后解锁。`
  return {
    title: `「${label}」为订阅专享模型`,
    paragraphs: [
      `${label} 当前对免费账户锁定。${gate}`,
      '订阅后立即生效:模型选择器中的锁标消失,可直接切换使用;已有会话与积分余额不受影响。',
    ],
    confirmText: '前往订阅',
    cancelText: '暂不',
  }
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
