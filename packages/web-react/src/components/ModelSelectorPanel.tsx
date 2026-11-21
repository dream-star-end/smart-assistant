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
import { AlertTriangle, Check, ChevronDown, ChevronRight, Cpu, Lock, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import {
  GROK_BUILD_FAST_MODEL_ID,
  GROK_BUILD_MODEL_ID,
  availableCursorEfforts,
  contextFamilyHasLong,
  contextFamilyHasStandard,
  cursorPickerDef,
  isGrokBuildCatalogId,
  longContextCostConfirmationRequired,
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
import { CostMark, ModelSelectorExtras } from './ModelSelectorExtras'
import './modelSelector.css'
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
type ShortViewportTab = 'models' | 'extras'

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
  shortViewport?: boolean
  effectiveMultiplier?: number
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
 * ModelSelector 弹层 / BottomSheet 主体（懒加载块，见 lazyModelSelectorPanel.tsx）：
 * - 手机 `<640px`：固定双区 BottomSheet（82vh / 82dvh），中区独立滚动模型列表 + 底部紧凑参数坞；
 * - 矮屏 `≤560px`（横屏手机/矮分屏）：自动切入 BottomSheet 顶部 2-Tab `[模型 | 执行参数]`（无 `sm:hidden`）；
 * - 平板/折叠屏/桌面 `≥640px && >560px`：左右双栏 Popover（左 56% 列表 `min-h-[14rem]` + 右 44% 参数），无参数回退单栏。
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
  shortViewport = false,
  effectiveMultiplier = 1,
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

  const hasExtras =
    showCursorEffort ||
    showCursorFast ||
    showGrokFast ||
    showServiceTiers ||
    showCursorContextTier ||
    showContextTier ||
    showPlatformEffort

  const [shortTab, setShortTab] = useState<ShortViewportTab>('models')
  useEffect(() => {
    if (open || !hasExtras) setShortTab('models')
  }, [open, hasExtras])

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
    const rowBadge = (active: boolean, locked = false) => (
      <span
        aria-hidden
        className={cn(
          'oc-icon-badge size-6 rounded-xs',
          active && !locked && 'oc-icon-badge-accent',
          locked && 'opacity-75',
        )}
      >
        {locked ? (
          <Lock size={12} strokeWidth={1.75} />
        ) : active ? (
          <Sparkles size={12} strokeWidth={1.75} />
        ) : (
          <Cpu size={12} strokeWidth={1.75} />
        )}
      </span>
    )
    const activeRowCls =
      'bg-accent-soft/75 font-medium text-fg ring-1 ring-inset ring-accent/25'
    const checkMark = (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent ring-1 ring-inset ring-accent/25"
      >
        <Check size={12} strokeWidth={2.25} />
      </span>
    )

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
          className={cn('justify-between gap-2 rounded-sm', active && !degraded && activeRowCls)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {rowBadge(active && !degraded)}
            <span className="truncate">{modelLabel(m)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <CostMark model={m} />
            <PromoBadge label={promoLabelOf(m)} />
            {degraded && <Badge tone="danger">暂不可用</Badge>}
            {active && !degraded && checkMark}
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
          className={cn('justify-between gap-2 rounded-sm', familyActive && !degraded && activeRowCls)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {rowBadge(familyActive && !degraded)}
            <span className="truncate">{row.row.label}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <CostMark model={representativeModel} />
            <PromoBadge label={promoLabelOf(representativeModel)} />
            {degraded && <Badge tone="danger">暂不可用</Badge>}
            {familyActive && !degraded && checkMark}
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
          className="justify-between gap-2 rounded-sm text-muted"
        >
          <span className="flex min-w-0 items-center gap-2">
            {rowBadge(false, true)}
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
          className={cn('justify-between gap-2 rounded-sm', familyActive && !degraded && activeRowCls)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {rowBadge(familyActive && !degraded)}
            <span className="truncate">{row.row.label}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <CostMark model={representativeModel} />
            <PromoBadge label={promoLabelOf(representativeModel)} />
            {degraded && <Badge tone="danger">暂不可用</Badge>}
            {familyActive && !degraded && checkMark}
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
          className="justify-between gap-2 rounded-sm text-muted"
        >
          <span className="flex min-w-0 items-center gap-2">
            {rowBadge(false, true)}
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
        className={cn('justify-between gap-2 rounded-sm', familyActive && !degraded && activeRowCls)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {rowBadge(familyActive && !degraded)}
          <span className="truncate">{row.row.label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <CostMark model={representativeModel} />
          <PromoBadge label={promoLabelOf(representativeModel)} />
          {degraded && <Badge tone="danger">暂不可用</Badge>}
          {familyActive && !degraded && checkMark}
        </span>
      </PickerItem>
    )
  }

  const notes = selectedDegraded && !teamEngineActive ? (
    <div
      role="note"
      className="oc-callout oc-callout-danger mx-2 my-1.5 shrink-0 rounded-md px-3 py-2 text-xs leading-relaxed"
    >
      <span className="flex items-center gap-1.5 font-semibold text-danger">
        <AlertTriangle size={13} strokeWidth={1.75} className="shrink-0" /> 当前模型暂不可用
      </span>
      <span className="mt-0.5 block text-muted">
        {hasAlternatives
          ? '该服务商暂时降级,建议改用下方可用模型。'
          : '该服务商暂时降级,暂无同类可用模型,请稍后重试。'}
      </span>
    </div>
  ) : null

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
                <ChevronDown size={14} strokeWidth={1.75} className="shrink-0" aria-hidden />
              ) : (
                <ChevronRight size={14} strokeWidth={1.75} className="shrink-0" aria-hidden />
              )}
              <span>{COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL}</span>
            </span>
            <span className="text-caption font-normal tabular-nums text-faint">
              {collapsedRows.length} 个
            </span>
          </PickerItem>
          {collapsedOpen && collapsedRows.map((row) => renderRow(row, ''))}
        </>
      )}
    </>
  )

  const sharedExtrasProps = {
    models,
    selected,
    selectedId,
    label,
    tierLabel,
    effectiveMultiplier,
    selectedCursor,
    cursorMembers,
    cursorEfforts,
    showCursorEffort,
    showCursorFast,
    showGrokFast,
    showServiceTiers,
    availableServiceTiers,
    effectiveServiceTier,
    fastTierMult,
    ultraTierMult,
    showCursorContextTier,
    activeCursorContextTier,
    showContextTier,
    selectedContext: selectedContextRow?.kind === 'context-family' ? selectedContextRow.row.spec : null,
    contextMembers,
    showPlatformEffort,
    effortSupported,
    effortActive,
    onOpenChange,
    onRememberAndSelect: rememberAndSelect,
    onSelectCursor: selectCursor,
    onSelectContext: selectContext,
    onSelectEffort,
    onSelectContextTier,
    onSelectServiceTier,
  }

  if (mode === 'sheet') {
    const useShortTabs = shortViewport && hasExtras
    return (
      <>
        <Sheet
          open={open}
          onOpenChange={onOpenChange}
          side="bottom"
          srTitle="选择对话模型"
          closeButton
          closeLabel="关闭"
          className={cn(
            'model-picker-sheet overflow-hidden',
            shortViewport && 'model-picker-sheet-short',
          )}
        >
          <div className="flex min-h-0 flex-1 flex-col" data-testid="model-picker-sheet">
            <div className="flex shrink-0 items-center gap-2.5 border-b border-border/80 px-4 pb-3 pt-1.5 pr-12">
              <span aria-hidden className="oc-icon-badge oc-icon-badge-accent size-8 rounded-sm">
                <Cpu size={15} strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-title font-semibold tracking-tight text-fg">选择对话模型</p>
                <p className="mt-0.5 flex items-center gap-1.5 truncate text-meta text-muted">
                  <span className="truncate">
                    {label}
                    {tierLabel ? ` · ${tierLabel}` : ''}
                  </span>
                  <CostMark model={selected} multiplier={effectiveMultiplier} />
                </p>
              </div>
            </div>

            {useShortTabs ? (
              <>
                <div className="shrink-0 border-b border-border/70 px-3 py-2">
                  <div
                    role="tablist"
                    aria-label="模型选择器分区"
                    data-testid="model-picker-short-tabs"
                    className="oc-surface-recessed flex gap-1 rounded-md p-1"
                  >
                    <button
                      type="button"
                      role="tab"
                      data-testid="model-picker-tab-models"
                      aria-selected={shortTab === 'models'}
                      onClick={() => setShortTab('models')}
                      className={cn(
                        'oc-btn-tactile min-h-9 flex-1 rounded-sm px-3 py-1 text-meta font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        shortTab === 'models'
                          ? 'oc-segmented-thumb text-fg'
                          : 'text-muted hover:text-fg',
                      )}
                    >
                      模型
                    </button>
                    <button
                      type="button"
                      role="tab"
                      data-testid="model-picker-tab-extras"
                      aria-selected={shortTab === 'extras'}
                      onClick={() => setShortTab('extras')}
                      className={cn(
                        'oc-btn-tactile min-h-9 flex-1 rounded-sm px-3 py-1 text-meta font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        shortTab === 'extras'
                          ? 'oc-segmented-thumb text-fg'
                          : 'text-muted hover:text-fg',
                      )}
                    >
                      执行参数
                    </button>
                  </div>
                </div>
                {shortTab === 'models' ? (
                  <div
                    role="menu"
                    data-testid="model-picker-sheet-scroll"
                    className="model-picker-sheet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
                  >
                    {notes}
                    {list}
                  </div>
                ) : (
                  <div
                    role="tabpanel"
                    data-testid="model-picker-extras-panel"
                    className="model-picker-sheet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5"
                  >
                    <ModelSelectorExtras layout="tab" {...sharedExtrasProps} />
                  </div>
                )}
              </>
            ) : (
              <>
                <div
                  role="menu"
                  data-testid="model-picker-sheet-scroll"
                  className="model-picker-sheet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
                >
                  {notes}
                  {list}
                </div>
                {hasExtras && (
                  <div
                    role="region"
                    aria-label="执行参数"
                    data-testid="model-picker-extras-dock"
                    className="max-h-[42%] shrink-0 overflow-y-auto overscroll-contain border-t border-border/80 bg-bg/70 px-3 py-2.5"
                  >
                    <ModelSelectorExtras layout="dock" {...sharedExtrasProps} />
                  </div>
                )}
              </>
            )}
          </div>
        </Sheet>
        {confirmLongContextEl}
      </>
    )
  }

  if (hasExtras) {
    return (
      <>
        <DropdownMenuContent
          align="start"
          data-testid="model-picker-two-col"
          className="model-picker-popover oc-surface-popover flex w-[min(620px,calc(100vw-24px))] flex-col overflow-hidden p-0"
        >
          <div className="flex min-h-0 flex-1 flex-row divide-x divide-border/80">
            <div
              data-testid="model-picker-list-col"
              className="flex min-h-[14rem] min-w-0 flex-[56_1_0%] flex-col"
            >
              <PickerLabel mode="menu" className="shrink-0 border-b border-border/70 px-3 py-2 text-caption font-semibold tracking-wider text-faint">
                对话模型
              </PickerLabel>
              {notes}
              <div
                data-testid="model-picker-list-scroll"
                className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5"
              >
                {list}
              </div>
            </div>
            <div
              data-testid="model-picker-extras-col"
              className="flex min-h-[14rem] min-w-0 flex-[44_1_0%] flex-col bg-bg/45"
            >
              <ModelSelectorExtras layout="column" {...sharedExtrasProps} />
            </div>
          </div>
        </DropdownMenuContent>
        {confirmLongContextEl}
      </>
    )
  }

  return (
    <>
      <DropdownMenuContent
        align="start"
        data-testid="model-picker-single-col"
        className="model-picker-popover oc-surface-popover flex w-[min(320px,calc(100vw-24px))] min-w-[15rem] flex-col overflow-hidden p-1.5"
      >
        <PickerLabel mode="menu" className="shrink-0 text-caption font-semibold tracking-wider text-faint">
          对话模型
        </PickerLabel>
        {notes}
        <div
          data-testid="model-picker-list-scroll"
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain"
        >
          {list}
        </div>
      </DropdownMenuContent>
      {confirmLongContextEl}
    </>
  )
}
