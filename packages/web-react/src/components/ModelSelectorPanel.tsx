import {
  COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL,
  type ContextTierFamily,
  type CursorContextTier,
  type CursorEngineFamilyId,
  DEFAULT_CURSOR_CONTEXT_TIER,
  type PlatformReasoningEffort,
  type ServiceTier,
  contextFamilyByModelId,
  cursorFamilySupportsContextTier,
  cursorFamilySupportsFast,
  normalizeServiceTierForModel,
  serviceTierBillingMultiplierNumber,
  supportedServiceTiers,
} from '@openclaude/protocol/browser'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Lock } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import {
  GROK_BUILD_FAST_MODEL_ID,
  GROK_BUILD_MODEL_ID,
  availableCursorEfforts,
  contextFamilyHasLong,
  contextFamilyHasStandard,
  cursorFamilyHasFast,
  cursorFamilyHasStandard,
  cursorPickerDef,
  grokBuildFastSelected,
  isGrokBuildCatalogId,
  longContextCostConfirmationRequired,
  modelCostLabel,
  modelPickerRows,
  partitionCollapsedRows,
  resolveContextPickerSelection,
  resolveCursorPickerSelection,
} from '../lib/cursorModelPicker'
import type { PreferenceEffort } from '../lib/modelPreferences'
import { readRecentModels, writeRecentModel } from '../lib/recentModels'
import type { LockedPublicModel, PublicModel } from '../lib/types'
import { cn } from '../lib/utils'
import {
  LONG_CONTEXT_CANCEL_TEXT,
  LONG_CONTEXT_CONFIRM_TEXT,
  LONG_CONTEXT_CONFIRM_TITLE,
  LongContextCostWarning,
} from './LongContextCostWarning'
import { isDegraded, modelLabel, type LockedSelectInfo } from './ModelSelector'
import { EFFORT_OPTIONS } from './settings/effortOptions'
import {
  Badge,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  Sheet,
  useConfirm,
} from './ui'

type PickerMode = 'menu' | 'sheet'

export type ModelSelectorPanelProps = {
  mode: PickerMode
  open: boolean
  onOpenChange: (open: boolean) => void
  models: PublicModel[]
  lockedModels: LockedPublicModel[]
  selectedId?: string
  onSelect: (id: string) => void
  onLockedSelect?: (info: LockedSelectInfo) => void
  teamEngineActive?: boolean
  effortSupported?: readonly string[]
  effortActive?: PreferenceEffort | null
  onSelectEffort?: (value: PreferenceEffort | null) => void
  contextTier?: CursorContextTier | null
  onSelectContextTier?: (tier: CursorContextTier) => void
  serviceTier?: ServiceTier | null
  onSelectServiceTier?: (tier: ServiceTier | null) => void
  label: string
  tierLabel: string | null
}

function PickerItem({
  mode,
  disabled,
  onSelect,
  className,
  children,
  ...rest
}: {
  mode: PickerMode
  disabled?: boolean
  onSelect?: (event: { preventDefault: () => void }) => void
  className?: string
  children: ReactNode
  'data-model-id'?: string
  'data-locked'?: string
  'data-cursor-family'?: string
  'data-context-family'?: string
  'data-grok-family'?: string
  'data-collapsed-group'?: string
  'data-effort'?: string
  'data-fast'?: string
  'data-cursor-context'?: string
  'data-context'?: string
  'aria-expanded'?: boolean
}) {
  if (mode === 'menu') {
    return (
      <DropdownMenuItem disabled={disabled} onSelect={onSelect} className={className} {...rest}>
        {children}
      </DropdownMenuItem>
    )
  }
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.({ preventDefault() {} })}
      className={cn(
        'flex min-h-11 w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors',
        'hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

function PickerLabel({
  mode,
  className,
  children,
  ...rest
}: {
  mode: PickerMode
  className?: string
  children: ReactNode
  'data-recent-group'?: string
}) {
  if (mode === 'menu') {
    return (
      <DropdownMenuLabel className={className} {...rest}>
        {children}
      </DropdownMenuLabel>
    )
  }
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs font-medium text-faint',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

function PickerSeparator({ mode }: { mode: PickerMode }) {
  if (mode === 'menu') return <DropdownMenuSeparator />
  return <div role="separator" className="my-1 h-px bg-border" />
}

function PickerSectionSummary({ mode, children }: { mode: PickerMode; children: ReactNode }) {
  return (
    <span
      className={cn(
        'text-caption font-normal text-faint',
        mode === 'sheet' && 'shrink-0 whitespace-nowrap',
      )}
    >
      {children}
    </span>
  )
}

function CostMark({ model, multiplier = 1 }: { model?: { cost_x?: number }; multiplier?: number }) {
  const label = modelCostLabel(model, multiplier)
  if (!label) return null
  return <span className="text-caption font-normal tabular-nums text-faint">{label}</span>
}

/** 底部配置区（思考档/速度/上下文）横向分段胶囊按钮：紧凑单行释放模型列表空间，触屏维持 ≥44px。 */
function SegmentPill({
  active,
  disabled,
  onClick,
  title,
  children,
  ...rest
}: {
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  title?: string
  children: ReactNode
  'data-effort'?: string
  'data-fast'?: string
  'data-gpt-fast'?: string
  'data-gpt-ultrafast'?: string
  'data-service-tier'?: string
  'data-cursor-context'?: string
  'data-context'?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-8 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-2 py-1 text-caption font-medium outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [@media(hover:none)]:min-h-11',
        active
          ? 'border-accent/45 bg-accent-soft text-accent'
          : 'border-transparent bg-hover/60 text-muted hover:bg-hover hover:text-fg',
      )}
      {...rest}
    >
      {active && <Check size={12} className="shrink-0 text-accent" aria-hidden />}
      {children}
    </button>
  )
}

function promoLabelOf(model: { promo_label?: unknown } | undefined): string | undefined {
  const value = model?.promo_label
  return typeof value === 'string' && value.trim() ? value : undefined
}

function PromoBadge({ label, className }: { label?: string; className?: string }) {
  if (!label) return null
  return <Badge tone="warning" className={className}>{label}</Badge>
}

function lockedPlainLabel(model: LockedPublicModel): string {
  return typeof model.display_name === 'string' && model.display_name.trim()
    ? model.display_name
    : model.id
}

/**
 * ModelSelector 下拉菜单 / 移动端贴底 Sheet 主体（懒加载块，见 lazyModelSelectorPanel.tsx）：
 * 仅在打开模型选择器后挂载，将选单列表、分段胶囊与 1M 长上下文确认弹窗移出首屏同步入口闭包。
 */
export function ModelSelectorPanel({
  mode,
  open,
  onOpenChange,
  models,
  lockedModels,
  selectedId,
  onSelect,
  onLockedSelect,
  teamEngineActive,
  effortSupported,
  effortActive,
  onSelectEffort,
  contextTier,
  onSelectContextTier,
  serviceTier,
  onSelectServiceTier,
  label,
  tierLabel,
}: ModelSelectorPanelProps) {
  const selected = models.find((m) => m.id === selectedId)
  const selectedCursor = cursorPickerDef(
    selected ?? (selectedId ? { id: selectedId } : null),
  )
  const selectedContext = contextFamilyByModelId(selectedId)
  const selectedDegraded = selected ? isDegraded(selected) : false
  const hasAlternatives = models.some((m) => !isDegraded(m) && m.id !== selectedId)
  const availableServiceTiers = supportedServiceTiers(selectedId)
  const showServiceTiers = availableServiceTiers.length > 0 && onSelectServiceTier != null
  const effectiveServiceTier = normalizeServiceTierForModel(selectedId, serviceTier)
  const fastTierMult = serviceTierBillingMultiplierNumber(selectedId, 'fast')
  const ultraTierMult = serviceTierBillingMultiplierNumber(selectedId, 'ultrafast')

  const rows = modelPickerRows(models, lockedModels)
  const {
    visible: visibleRows,
    collapsed: collapsedRows,
    selectedInCollapsed,
  } = partitionCollapsedRows(rows, selectedId)
  const [collapsedOpen, setCollapsedOpen] = useState(selectedInCollapsed)
  useEffect(() => {
    if (selectedInCollapsed) setCollapsedOpen(true)
  }, [selectedInCollapsed])
  const showCollapsedGroup = collapsedRows.length > 0
  const [, setRecentTick] = useState(0)

  const recentRows = (() => {
    const seen = new Set<string>()
    const out: typeof rows = []
    for (const id of readRecentModels()) {
      if (id === selectedId) continue
      if (!models.some((m) => m.id === id)) continue
      if (lockedModels.some((m) => m.id === id)) continue
      const row = rows.find((item) => {
        if (item.kind === 'plain') return item.model.id === id
        if (
          item.kind === 'cursor-family' ||
          item.kind === 'context-family' ||
          item.kind === 'grok-build-family'
        ) {
          return item.row.members.some((m) => m.id === id)
        }
        return false
      })
      if (!row) continue
      if (row.kind === 'cursor-family' && selectedCursor && row.row.family === selectedCursor.family) continue
      if (row.kind === 'context-family' && selectedContext && row.row.family === selectedContext.family) continue
      if (row.kind === 'grok-build-family' && isGrokBuildCatalogId(selectedId)) continue
      const ident =
        row.kind === 'plain'
          ? `plain:${row.model.id}`
          : row.kind === 'cursor-family' ||
              row.kind === 'context-family' ||
              row.kind === 'grok-build-family'
            ? `${row.kind}:${row.row.family}`
            : `other:${id}`
      if (seen.has(ident)) continue
      seen.add(ident)
      out.push(row)
    }
    return out
  })()

  const selectedFamilyRow = rows.find(
    (row) => row.kind === 'cursor-family' && row.row.family === selectedCursor?.family,
  )
  const cursorMembers =
    selectedFamilyRow && selectedFamilyRow.kind === 'cursor-family'
      ? selectedFamilyRow.row.members
      : []
  const cursorEfforts = availableCursorEfforts(cursorMembers)
  const showCursorEffort = selectedCursor != null && cursorEfforts.length > 0
  const showCursorFast =
    selectedCursor != null &&
    selectedCursor.family !== 'auto' &&
    cursorFamilySupportsFast(selectedCursor.family) &&
    cursorMembers.some((member) => cursorPickerDef(member)?.fast)
  const showGrokFast =
    isGrokBuildCatalogId(selectedId) &&
    models.some((model) => model.id === GROK_BUILD_MODEL_ID) &&
    models.some((model) => model.id === GROK_BUILD_FAST_MODEL_ID)
  const selectedContextRow = rows.find(
    (row) => row.kind === 'context-family' && row.row.family === selectedContext?.family,
  )
  const contextMembers =
    selectedContextRow && selectedContextRow.kind === 'context-family'
      ? selectedContextRow.row.members
      : []
  const showContextTier =
    selectedContext != null &&
    contextFamilyHasStandard(contextMembers, selectedContext) &&
    contextFamilyHasLong(contextMembers, selectedContext)
  const showCursorContextTier =
    selectedCursor != null &&
    cursorFamilySupportsContextTier(selectedCursor.family) &&
    onSelectContextTier != null
  const activeCursorContextTier: CursorContextTier = contextTier ?? DEFAULT_CURSOR_CONTEXT_TIER
  const showPlatformEffort =
    !selectedCursor && Boolean(effortSupported && effortSupported.length > 0 && onSelectEffort)
  const [confirmLongContext, confirmLongContextEl] = useConfirm()

  const rememberAndSelect = (id: string) => {
    writeRecentModel(id)
    setRecentTick((n) => n + 1)
    onSelect(id)
    onOpenChange(false)
  }

  const selectCursor = (
    family: CursorEngineFamilyId,
    members: PublicModel[],
    next?: { effort?: PlatformReasoningEffort | null; fast?: boolean },
  ) => {
    const id = resolveCursorPickerSelection(members, family, selectedId, next)
    if (id) rememberAndSelect(id)
  }

  const selectContext = async (
    spec: ContextTierFamily,
    members: PublicModel[],
    next?: { longContext?: boolean },
  ) => {
    const id = resolveContextPickerSelection(members, spec, selectedId, next)
    if (!id || id === selectedId) return
    if (longContextCostConfirmationRequired(selectedId, id)) {
      const confirmed = await confirmLongContext({
        title: LONG_CONTEXT_CONFIRM_TITLE,
        body: <LongContextCostWarning />,
        confirmText: LONG_CONTEXT_CONFIRM_TEXT,
        cancelText: LONG_CONTEXT_CANCEL_TEXT,
      })
      if (!confirmed) return
    }
    rememberAndSelect(id)
  }

  const renderRow = (row: (typeof rows)[number], keyPrefix = '') => {
    if (row.kind === 'plain') {
      const m = row.model
      const active = m.id === selectedId
      const degraded = isDegraded(m)
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}${m.id}`}
          data-model-id={m.id}
          disabled={degraded}
          onSelect={degraded ? undefined : () => rememberAndSelect(m.id)}
          className="justify-between"
        >
          <span className="truncate">{modelLabel(m)}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <CostMark model={m} />
            <PromoBadge label={promoLabelOf(m)} />
            {degraded && <Badge tone="danger">暂不可用</Badge>}
            {active && !degraded && <Check size={14} className="shrink-0 text-accent" />}
          </span>
        </PickerItem>
      )
    }
    if (row.kind === 'context-family') {
      const familyActive = selectedContext?.family === row.row.family
      const representative =
        resolveContextPickerSelection(row.row.members, row.row.spec, selectedId) ??
        row.row.members[0]?.id
      const representativeModel = row.row.members.find((item) => item.id === representative)
      const degraded = row.row.members.every(isDegraded)
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}${row.row.family}`}
          data-model-id={representative}
          data-context-family={row.row.family}
          disabled={degraded}
          onSelect={
            degraded
              ? undefined
              : () => {
                  void selectContext(row.row.spec, row.row.members)
                }
          }
          className="justify-between"
        >
          <span className="truncate">{row.row.label}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <CostMark model={representativeModel} />
            <PromoBadge label={promoLabelOf(representativeModel)} />
            {degraded && <Badge tone="danger">暂不可用</Badge>}
            {familyActive && !degraded && <Check size={14} className="shrink-0 text-accent" />}
          </span>
        </PickerItem>
      )
    }
    if (row.kind === 'locked-plain') {
      const locked = row.model
      const labelText = lockedPlainLabel(locked)
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}locked-${locked.id}`}
          data-model-id={locked.id}
          data-locked="true"
          onSelect={() => {
            onLockedSelect?.({
              label: labelText,
              minPlanCode: locked.min_plan_code,
              minPlanName: locked.min_plan_name,
              modelId: locked.id,
            })
            onOpenChange(false)
          }}
          className="justify-between text-muted"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Lock size={14} className="shrink-0" aria-hidden />
            <span className="truncate">{labelText}</span>
            <span className="sr-only">（需升级解锁）</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <CostMark model={locked} />
            <PromoBadge label={promoLabelOf(locked)} />
          </span>
        </PickerItem>
      )
    }
    if (row.kind === 'grok-build-family') {
      const familyActive = isGrokBuildCatalogId(selectedId)
      const representative = familyActive
        ? selectedId
        : (row.row.members.find((member) => member.id === GROK_BUILD_MODEL_ID)?.id ??
          row.row.members[0]?.id)
      const representativeModel = row.row.members.find((item) => item.id === representative)
      const degraded = row.row.members.every(isDegraded)
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}${row.row.family}`}
          data-model-id={representative}
          data-grok-family={row.row.family}
          disabled={degraded}
          onSelect={
            degraded
              ? undefined
              : () => {
                  if (representative) rememberAndSelect(representative)
                }
          }
          className="justify-between"
        >
          <span className="truncate">{row.row.label}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <CostMark model={representativeModel} />
            <PromoBadge label={promoLabelOf(representativeModel)} />
            {degraded && <Badge tone="danger">暂不可用</Badge>}
            {familyActive && !degraded && <Check size={14} className="shrink-0 text-accent" />}
          </span>
        </PickerItem>
      )
    }
    if (row.kind === 'locked-cursor-family') {
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}locked-family-${row.row.family}`}
          data-model-id={row.row.representative.id}
          data-cursor-family={row.row.family}
          data-locked="true"
          onSelect={() => {
            onLockedSelect?.({
              label: row.row.label,
              minPlanCode: row.row.minPlanCode,
              minPlanName: row.row.minPlanName,
              modelId: row.row.representative.id,
            })
            onOpenChange(false)
          }}
          className="justify-between text-muted"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Lock size={14} className="shrink-0" aria-hidden />
            <span className="truncate">{row.row.label}</span>
            <span className="sr-only">（需升级解锁）</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <CostMark model={row.row.representative} />
            <PromoBadge label={promoLabelOf(row.row.representative)} />
          </span>
        </PickerItem>
      )
    }
    const familyActive = selectedCursor?.family === row.row.family
    const representative =
      resolveCursorPickerSelection(row.row.members, row.row.family, selectedId) ??
      row.row.members[0]?.id
    const representativeModel = row.row.members.find((item) => item.id === representative)
    const degraded = row.row.members.every(isDegraded)
    return (
      <PickerItem
        mode={mode}
        key={`${keyPrefix}${row.row.family}`}
        data-model-id={representative}
        data-cursor-family={row.row.family}
        disabled={degraded}
        onSelect={degraded ? undefined : () => selectCursor(row.row.family, row.row.members)}
        className="justify-between"
      >
        <span className="truncate">{row.row.label}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <CostMark model={representativeModel} />
          <PromoBadge label={promoLabelOf(representativeModel)} />
          {degraded && <Badge tone="danger">暂不可用</Badge>}
          {familyActive && !degraded && <Check size={14} className="shrink-0 text-accent" />}
        </span>
      </PickerItem>
    )
  }

  const notes = (
    <>
      {selectedDegraded && !teamEngineActive && (
        <div
          role="note"
          className="mx-1 mb-1 shrink-0 rounded-md bg-danger-soft px-2.5 py-2 text-xs leading-relaxed"
        >
          <span className="flex items-center gap-1.5 font-medium text-danger">
            <AlertTriangle size={12} className="shrink-0" /> 当前模型暂不可用
          </span>
          <span className="mt-0.5 block text-muted">
            {hasAlternatives
              ? '该服务商暂时降级,建议改用下方可用模型。'
              : '该服务商暂时降级,暂无同类可用模型,请稍后重试。'}
          </span>
        </div>
      )}
    </>
  )

  const list = (
    <>
      {recentRows.length > 0 && (
        <>
          <PickerLabel mode={mode} data-recent-group="true">
            最近
          </PickerLabel>
          {recentRows.map((row) => renderRow(row, 'recent-'))}
          <PickerSeparator mode={mode} />
        </>
      )}
      {visibleRows.map((row) => renderRow(row, ''))}
      {showCollapsedGroup && (
        <>
          <PickerSeparator mode={mode} />
          <PickerItem
            mode={mode}
            data-collapsed-group={collapsedOpen ? 'open' : 'closed'}
            aria-expanded={collapsedOpen}
            onSelect={(event) => {
              event.preventDefault()
              setCollapsedOpen((cur) => !cur)
            }}
            className="justify-between text-muted"
          >
            <span className="flex items-center gap-1.5">
              {collapsedOpen ? (
                <ChevronDown size={14} className="shrink-0" aria-hidden />
              ) : (
                <ChevronRight size={14} className="shrink-0" aria-hidden />
              )}
              <span>{COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL}</span>
            </span>
            <span className="text-caption font-normal text-faint">{collapsedRows.length} 个</span>
          </PickerItem>
          {collapsedOpen && collapsedRows.map((row) => renderRow(row, ''))}
        </>
      )}
    </>
  )

  const cursorStdMember = selectedCursor
    ? cursorMembers.find((m) => {
        const def = cursorPickerDef(m)
        return def && def.effort === selectedCursor.effort && !def.fast
      })
    : undefined
  const cursorFastMember = selectedCursor
    ? cursorMembers.find((m) => {
        const def = cursorPickerDef(m)
        return def && def.effort === selectedCursor.effort && def.fast
      })
    : undefined

  const extras = (
    <>
      {showCursorEffort && selectedCursor && (
        <div className={mode === 'menu' ? 'shrink-0' : undefined}>
          <PickerSeparator mode={mode} />
          <PickerLabel mode={mode} className="flex items-center justify-between">
            思考档位
            <PickerSectionSummary mode={mode}>
              {EFFORT_OPTIONS.find((o) => o.value === selectedCursor.effort)?.label ??
                selectedCursor.effort ??
                '—'}
            </PickerSectionSummary>
          </PickerLabel>
          <div role="group" aria-label="思考档位" className="flex flex-wrap gap-1 px-2 pb-1.5">
            {EFFORT_OPTIONS.filter((o) => cursorEfforts.includes(o.value)).map((o) => (
              <SegmentPill
                key={o.value}
                data-effort={o.value}
                active={selectedCursor.effort === o.value}
                onClick={() =>
                  selectCursor(selectedCursor.family, cursorMembers, { effort: o.value })
                }
              >
                <span>{o.label}</span>
              </SegmentPill>
            ))}
          </div>
        </div>
      )}
      {showCursorFast && selectedCursor && (
        <div className={mode === 'menu' ? 'shrink-0' : undefined}>
          <PickerSeparator mode={mode} />
          <PickerLabel mode={mode} className="flex items-center justify-between">
            速度
            <PickerSectionSummary mode={mode}>
              {selectedCursor.fast ? 'Fast' : '标准'}
            </PickerSectionSummary>
          </PickerLabel>
          <div role="group" aria-label="速度档位" className="flex flex-wrap gap-1 px-2 pb-1.5">
            <SegmentPill
              data-fast="false"
              active={!selectedCursor.fast}
              disabled={!cursorFamilyHasStandard(cursorMembers, selectedCursor.effort)}
              onClick={() => selectCursor(selectedCursor.family, cursorMembers, { fast: false })}
            >
              <span>标准</span>
              <CostMark model={cursorStdMember} />
            </SegmentPill>
            <SegmentPill
              data-fast="true"
              active={selectedCursor.fast}
              disabled={!cursorFamilyHasFast(cursorMembers, selectedCursor.effort)}
              onClick={() => selectCursor(selectedCursor.family, cursorMembers, { fast: true })}
            >
              <span>Fast</span>
              <CostMark model={cursorFastMember} />
            </SegmentPill>
          </div>
        </div>
      )}
      {showGrokFast && (
        <div className={mode === 'menu' ? 'shrink-0' : undefined}>
          <PickerSeparator mode={mode} />
          <PickerLabel mode={mode} className="flex items-center justify-between">
            速度
            <PickerSectionSummary mode={mode}>
              {grokBuildFastSelected(selectedId) ? 'Fast' : '标准'}
            </PickerSectionSummary>
          </PickerLabel>
          <div role="group" aria-label="速度档位" className="flex flex-wrap gap-1 px-2 pb-1.5">
            <SegmentPill
              data-fast="false"
              active={!grokBuildFastSelected(selectedId)}
              onClick={() => rememberAndSelect(GROK_BUILD_MODEL_ID)}
            >
              <span>标准</span>
              <CostMark model={models.find((model) => model.id === GROK_BUILD_MODEL_ID)} />
            </SegmentPill>
            <SegmentPill
              data-fast="true"
              active={grokBuildFastSelected(selectedId)}
              onClick={() => rememberAndSelect(GROK_BUILD_FAST_MODEL_ID)}
            >
              <span>Fast</span>
              <CostMark model={models.find((model) => model.id === GROK_BUILD_FAST_MODEL_ID)} />
            </SegmentPill>
          </div>
        </div>
      )}
      {showServiceTiers && onSelectServiceTier && (
        <div className={mode === 'menu' ? 'shrink-0' : undefined}>
          <PickerSeparator mode={mode} />
          <PickerLabel mode={mode} className="flex items-center justify-between">
            速度
            <PickerSectionSummary mode={mode}>
              {effectiveServiceTier === 'ultrafast'
                ? `Ultrafast (${ultraTierMult}×)`
                : effectiveServiceTier === 'fast'
                  ? `Fast (${fastTierMult}×)`
                  : '标准'}
            </PickerSectionSummary>
          </PickerLabel>
          <div role="group" aria-label="速度档位" className="flex flex-wrap gap-1 px-2 pb-1.5">
            <SegmentPill
              data-gpt-fast="false"
              data-service-tier="standard"
              active={effectiveServiceTier === null}
              onClick={() => {
                onSelectServiceTier(null)
                onOpenChange(false)
              }}
            >
              <span>标准</span>
              <CostMark model={selected} multiplier={1} />
            </SegmentPill>
            <SegmentPill
              data-gpt-fast="true"
              data-service-tier="fast"
              active={effectiveServiceTier === 'fast'}
              title={`Fast（更快，按 ${fastTierMult}× 计费）`}
              onClick={() => {
                onSelectServiceTier('fast')
                onOpenChange(false)
              }}
            >
              <span>Fast</span>
              <span className="text-micro opacity-80">按 {fastTierMult}× 计费</span>
              <CostMark model={selected} multiplier={fastTierMult} />
            </SegmentPill>
            {availableServiceTiers.includes('ultrafast') && (
              <SegmentPill
                data-gpt-ultrafast="true"
                data-service-tier="ultrafast"
                active={effectiveServiceTier === 'ultrafast'}
                title={`Ultrafast（超快，按 ${ultraTierMult}× 计费）`}
                onClick={() => {
                  onSelectServiceTier('ultrafast')
                  onOpenChange(false)
                }}
              >
                <span>Ultrafast</span>
                <span className="text-micro opacity-80">按 {ultraTierMult}× 计费</span>
                <CostMark model={selected} multiplier={ultraTierMult} />
              </SegmentPill>
            )}
          </div>
        </div>
      )}
      {showCursorContextTier && onSelectContextTier && (
        <div className={mode === 'menu' ? 'shrink-0' : undefined}>
          <PickerSeparator mode={mode} />
          <PickerLabel mode={mode} className="flex items-center justify-between">
            上下文
            <PickerSectionSummary mode={mode}>
              {activeCursorContextTier === '1m' ? '1M' : '300k'}
            </PickerSectionSummary>
          </PickerLabel>
          <div role="group" aria-label="上下文长度" className="flex flex-wrap gap-1 px-2 pb-1.5">
            <SegmentPill
              data-cursor-context="300k"
              active={activeCursorContextTier === '300k'}
              onClick={() => {
                onSelectContextTier('300k')
                onOpenChange(false)
              }}
            >
              <span>300k 默认</span>
            </SegmentPill>
            <SegmentPill
              data-cursor-context="1m"
              active={activeCursorContextTier === '1m'}
              title="1M（更少压缩，单轮消耗更高）"
              onClick={() => {
                onSelectContextTier('1m')
                onOpenChange(false)
              }}
            >
              <span>1M 长上下文</span>
            </SegmentPill>
          </div>
        </div>
      )}
      {showContextTier && selectedContext && selectedContextRow?.kind === 'context-family' && (
        <div className={mode === 'menu' ? 'shrink-0' : undefined}>
          <PickerSeparator mode={mode} />
          <PickerLabel mode={mode} className="flex items-center justify-between">
            上下文
            <PickerSectionSummary mode={mode}>
              {selectedId === selectedContext.longId ? '1M' : '标准'}
            </PickerSectionSummary>
          </PickerLabel>
          <div role="group" aria-label="上下文长度" className="flex flex-wrap gap-1 px-2 pb-1.5">
            <SegmentPill
              data-context="standard"
              active={selectedId === selectedContext.standardId}
              disabled={!contextFamilyHasStandard(contextMembers, selectedContext)}
              onClick={() => {
                void selectContext(selectedContextRow.row.spec, contextMembers, {
                  longContext: false,
                })
              }}
            >
              <span>标准</span>
            </SegmentPill>
            <SegmentPill
              data-context="1m"
              active={selectedId === selectedContext.longId}
              disabled={!contextFamilyHasLong(contextMembers, selectedContext)}
              title="1M（1.5 倍基础单价）"
              onClick={() => {
                void selectContext(selectedContextRow.row.spec, contextMembers, {
                  longContext: true,
                })
              }}
            >
              <span>1M</span>
              <span className="text-micro opacity-80">1.5 倍基础单价</span>
            </SegmentPill>
          </div>
        </div>
      )}
      {showPlatformEffort && effortSupported && onSelectEffort && (
        <div className={mode === 'menu' ? 'shrink-0' : undefined}>
          <PickerSeparator mode={mode} />
          <PickerLabel mode={mode} className="flex items-center justify-between">
            思考档位
            <PickerSectionSummary mode={mode}>
              {effortActive == null
                ? '跟随模型默认'
                : (EFFORT_OPTIONS.find((o) => o.value === effortActive)?.label ?? effortActive)}
            </PickerSectionSummary>
          </PickerLabel>
          <p className="px-2.5 pb-1 text-caption text-muted">较低档偏重响应速度，较高档偏重复杂任务。</p>
          <div role="group" aria-label="思考档位" className="flex flex-wrap gap-1 px-2 pb-1.5">
            <SegmentPill
              data-effort="follow"
              active={effortActive == null}
              onClick={() => {
                onSelectEffort(null)
                onOpenChange(false)
              }}
            >
              <span>默认</span>
            </SegmentPill>
            {EFFORT_OPTIONS.filter((o) => effortSupported.includes(o.value)).map((o) => (
              <SegmentPill
                key={o.value}
                data-effort={o.value}
                active={effortActive === o.value}
                onClick={() => {
                  onSelectEffort(o.value)
                  onOpenChange(false)
                }}
              >
                <span>{o.label}</span>
              </SegmentPill>
            ))}
          </div>
        </div>
      )}
    </>
  )

  const body = (
    <>
      {mode === 'menu' && <PickerLabel mode={mode} className="shrink-0">对话模型</PickerLabel>}
      {notes}
      {mode === 'menu' ? <div className="min-h-0 flex-1 overflow-y-auto">{list}</div> : list}
      {extras}
    </>
  )

  if (mode === 'sheet') {
    return (
      <>
        <Sheet
          open={open}
          onOpenChange={onOpenChange}
          side="bottom"
          srTitle="选择对话模型"
          closeButton
          closeLabel="关闭"
          className="model-picker-sheet overflow-hidden sm:hidden"
          overlayClassName="sm:hidden"
        >
          <div className="flex min-h-0 flex-1 flex-col" data-testid="model-picker-sheet">
            <div className="shrink-0 border-b border-border px-4 pb-3 pt-1">
              <p className="text-title font-semibold text-fg">选择对话模型</p>
              <p className="mt-0.5 truncate text-meta text-muted">
                {label}
                {tierLabel ? ` · ${tierLabel}` : ''}
              </p>
            </div>
            <div
              role="menu"
              data-testid="model-picker-sheet-scroll"
              className="model-picker-sheet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
            >
              {body}
            </div>
          </div>
        </Sheet>
        {confirmLongContextEl}
      </>
    )
  }

  return (
    <>
      <DropdownMenuContent
        align="start"
        className="flex max-h-[80vh] min-w-[15rem] flex-col"
      >
        {body}
      </DropdownMenuContent>
      {confirmLongContextEl}
    </>
  )
}
