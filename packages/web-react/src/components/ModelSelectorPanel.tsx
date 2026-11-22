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
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react'
import {
  GROK_BUILD_FAST_MODEL_ID,
  GROK_BUILD_MODEL_ID,
  type ModelPickerRow,
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
import {
  CostMark,
  ModelNameWithTags,
  ModelSelectorExtras,
  parseModelDisplayMeta,
} from './ModelSelectorExtras'
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
import { AtelierIcon } from './ui/AtelierIcons'
import { ModelFamilyIcon, type ModelFamilyKind, detectModelFamily } from './ui/ModelFamilyIcons'
import { isAntigravityModelForUi } from './chat/swarmDetect'

type PickerMode = 'menu' | 'sheet'
type ShortViewportTab = 'models' | 'extras'

const MODEL_FAMILY_GROUP_LABELS: Record<ModelFamilyKind, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  gpt: 'GPT',
  orchestrator: 'Orchestrator',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  qwen: 'Qwen',
  glm: 'GLM',
  minimax: 'MiniMax',
  default: '其他模型',
}

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
  swarmSupported?: boolean
  swarmMode?: boolean
  swarmRunning?: boolean
  onSelectSwarmMode?: (enabled: boolean) => void
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
  style,
  children,
  ...rest
}: {
  mode: PickerMode
  disabled?: boolean
  onSelect?: (event: { preventDefault: () => void }) => void
  className?: string
  style?: CSSProperties
  children: ReactNode
  title?: string
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
      <DropdownMenuItem
        disabled={disabled}
        onSelect={onSelect}
        className={className}
        style={style}
        {...rest}
      >
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
      style={style}
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
  'data-family-group'?: string
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
  return <div role="separator" className="my-1.5 h-px bg-border/80" />
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

function isLockedRow(row: ModelPickerRow): boolean {
  return row.kind === 'locked-plain' || row.kind === 'locked-cursor-family'
}

function isDegradedRow(row: ModelPickerRow): boolean {
  if (row.kind === 'plain') return isDegraded(row.model)
  if (row.kind === 'locked-plain' || row.kind === 'locked-cursor-family') return false
  return row.row.members.length > 0 && row.row.members.every(isDegraded)
}

function rowFamily(row: ModelPickerRow): ModelFamilyKind {
  if (row.kind === 'plain') return detectModelFamily(`${row.model.id} ${modelLabel(row.model)}`)
  if (row.kind === 'context-family') return detectModelFamily(`${row.row.family} ${row.row.label}`)
  if (row.kind === 'locked-plain') {
    return detectModelFamily(`${row.model.id} ${lockedPlainLabel(row.model)}`)
  }
  if (row.kind === 'grok-build-family') return 'grok'
  if (row.kind === 'locked-cursor-family') {
    return detectModelFamily(`${row.row.representative.id} ${row.row.label}`)
  }
  return detectModelFamily(`${row.row.family} ${row.row.label}`)
}

function groupUsableByFamily(rows: readonly ModelPickerRow[]) {
  const groups: Array<{ family: ModelFamilyKind; rows: ModelPickerRow[] }> = []
  const byFamily = new Map<ModelFamilyKind, ModelPickerRow[]>()
  for (const row of rows) {
    const family = rowFamily(row)
    let list = byFamily.get(family)
    if (!list) {
      list = []
      byFamily.set(family, list)
      groups.push({ family, rows: list })
    }
    list.push(row)
  }
  return groups
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
  swarmSupported,
  swarmMode,
  swarmRunning,
  onSelectSwarmMode,
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
  const showSwarmMode = Boolean(swarmSupported && onSelectSwarmMode && !teamEngineActive)

  const hasExtras =
    showCursorEffort ||
    showCursorFast ||
    showGrokFast ||
    showServiceTiers ||
    showCursorContextTier ||
    showContextTier ||
    showPlatformEffort ||
    showSwarmMode

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

  let staggerSeq = 0
  const nextStaggerStyle = (): CSSProperties => {
    const idx = Math.min(staggerSeq, 10)
    staggerSeq += 1
    return { '--stagger-i': idx } as CSSProperties
  }

  const renderRow = (row: ModelPickerRow, keyPrefix = '') => {
    const family = rowFamily(row)
    const rowBadge = (active: boolean, locked = false) => (
      <span
        aria-hidden
        className={cn(
          'oc-icon-badge size-7 rounded-sm',
          active && !locked && 'oc-icon-badge-accent oc-breathe-aura',
          locked && 'opacity-70',
        )}
      >
        <ModelFamilyIcon family={family} size={15} />
      </span>
    )
    const baseRowCls =
      'model-picker-row oc-spring-press oc-stagger-in justify-between gap-2.5 rounded-md'
    const activeRowCls = 'model-picker-row-active font-medium text-fg'
    const checkMark = (
      <span
        aria-hidden
        className="model-picker-check flex size-5 shrink-0 items-center justify-center rounded-full"
      >
        <Check size={12} strokeWidth={2.4} />
      </span>
    )
    const rowStyle = nextStaggerStyle()

    if (row.kind === 'plain') {
      const m = row.model
      const active = m.id === selectedId
      const degraded = isDegraded(m)
      const raw = modelLabel(m)
      const supportsSwarm = isAntigravityModelForUi(m.id, models)
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}${m.id}`}
          data-model-id={m.id}
          disabled={degraded}
          title={raw}
          style={rowStyle}
          onSelect={degraded ? undefined : () => rememberAndSelect(m.id)}
          className={cn(baseRowCls, active && !degraded && activeRowCls)}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {rowBadge(active && !degraded)}
            <ModelNameWithTags rawLabel={raw} modelId={m.id} family={family} />
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {supportsSwarm && !degraded && (
              <span
                data-testid="model-row-swarm-capable"
                title="支持蜂群模式"
                aria-label="支持蜂群模式"
                className={cn(
                  'inline-flex shrink-0 items-center justify-center',
                  active && swarmMode ? 'text-accent' : 'text-accent/75',
                )}
              >
                <AtelierIcon name="swarm" size={12} className="shrink-0" />
              </span>
            )}
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
      const raw = row.row.label
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}${row.row.family}`}
          data-model-id={representative}
          data-context-family={row.row.family}
          disabled={degraded}
          title={raw}
          style={rowStyle}
          onSelect={
            degraded
              ? undefined
              : () => {
                  void selectContext(row.row.spec, row.row.members)
                }
          }
          className={cn(baseRowCls, familyActive && !degraded && activeRowCls)}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {rowBadge(familyActive && !degraded)}
            <ModelNameWithTags rawLabel={raw} modelId={representative} family={family} />
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
          title={labelText}
          style={rowStyle}
          onSelect={() => {
            onLockedSelect?.({
              label: labelText,
              minPlanCode: locked.min_plan_code,
              minPlanName: locked.min_plan_name,
              modelId: locked.id,
            })
            onOpenChange(false)
          }}
          className={cn(baseRowCls, 'text-muted')}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {rowBadge(false, true)}
            <ModelNameWithTags rawLabel={labelText} modelId={locked.id} family={family} />
            <span className="sr-only">（需升级解锁）</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Lock size={12} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
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
      const raw = row.row.label
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}${row.row.family}`}
          data-model-id={representative}
          data-grok-family={row.row.family}
          disabled={degraded}
          title={raw}
          style={rowStyle}
          onSelect={
            degraded
              ? undefined
              : () => {
                  if (representative) rememberAndSelect(representative)
                }
          }
          className={cn(baseRowCls, familyActive && !degraded && activeRowCls)}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {rowBadge(familyActive && !degraded)}
            <ModelNameWithTags rawLabel={raw} modelId={representative} family={family} />
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
      const raw = row.row.label
      return (
        <PickerItem
          mode={mode}
          key={`${keyPrefix}locked-family-${row.row.family}`}
          data-model-id={row.row.representative.id}
          data-cursor-family={row.row.family}
          data-locked="true"
          title={raw}
          style={rowStyle}
          onSelect={() => {
            onLockedSelect?.({
              label: raw,
              minPlanCode: row.row.minPlanCode,
              minPlanName: row.row.minPlanName,
              modelId: row.row.representative.id,
            })
            onOpenChange(false)
          }}
          className={cn(baseRowCls, 'text-muted')}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {rowBadge(false, true)}
            <ModelNameWithTags
              rawLabel={raw}
              modelId={row.row.representative.id}
              family={family}
            />
            <span className="sr-only">（需升级解锁）</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Lock size={12} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
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
    const raw = row.row.label
    return (
      <PickerItem
        mode={mode}
        key={`${keyPrefix}${row.row.family}`}
        data-model-id={representative}
        data-cursor-family={row.row.family}
        disabled={degraded}
        title={raw}
        style={rowStyle}
        onSelect={degraded ? undefined : () => selectCursor(row.row.family, row.row.members)}
        className={cn(baseRowCls, familyActive && !degraded && activeRowCls)}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {rowBadge(familyActive && !degraded)}
          <ModelNameWithTags rawLabel={raw} modelId={representative} family={family} />
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

  const usableVisibleRows = visibleRows.filter((r) => !isLockedRow(r) && !isDegradedRow(r))
  const lockedVisibleRows = visibleRows.filter(isLockedRow)
  const degradedVisibleRows = visibleRows.filter(isDegradedRow)
  const familyGroups = groupUsableByFamily(usableVisibleRows)
  const showFamilyGroups = familyGroups.length >= 2 && usableVisibleRows.length >= 3

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
          <PickerLabel
            mode={mode}
            data-recent-group="true"
            className="model-picker-group-label text-caption font-semibold uppercase tracking-wider text-faint"
          >
            最近
          </PickerLabel>
          {recentRows.map((row) => renderRow(row, 'recent-'))}
          <PickerSeparator mode={mode} />
        </>
      )}
      {showFamilyGroups ? (
        <>
          {familyGroups.map((group) => (
            <div key={`family-group-${group.family}`} className="space-y-0.5">
              <PickerLabel
                mode={mode}
                data-family-group={group.family}
                className="model-picker-group-label px-2.5 pb-0.5 pt-1.5 text-caption font-semibold uppercase tracking-wider text-faint"
              >
                {MODEL_FAMILY_GROUP_LABELS[group.family]}
              </PickerLabel>
              {group.rows.map((row) => renderRow(row, ''))}
            </div>
          ))}
          {(lockedVisibleRows.length > 0 || degradedVisibleRows.length > 0) && (
            <>
              <PickerSeparator mode={mode} />
              {lockedVisibleRows.map((row) => renderRow(row, ''))}
              {degradedVisibleRows.map((row) => renderRow(row, ''))}
            </>
          )}
        </>
      ) : (
        visibleRows.map((row) => renderRow(row, ''))
      )}
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
            className="oc-spring-press justify-between rounded-md text-muted"
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
    showSwarmMode,
    swarmMode: Boolean(swarmMode && !teamEngineActive),
    swarmRunning: Boolean(swarmRunning && !teamEngineActive),
    onOpenChange,
    onRememberAndSelect: rememberAndSelect,
    onSelectCursor: selectCursor,
    onSelectContext: selectContext,
    onSelectEffort,
    onSelectContextTier,
    onSelectServiceTier,
    onSelectSwarmMode,
  }

  const selectedFamily = detectModelFamily(`${selectedId ?? ''} ${label}`)
  const headerDisplay = parseModelDisplayMeta(label, selectedId, selectedFamily)

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
            <div className="model-picker-sheet-header flex shrink-0 items-center gap-3 border-b border-border/80 px-4 pb-3 pt-2 pr-12">
              <span
                aria-hidden
                data-testid="model-picker-sheet-icon"
                className="oc-icon-badge oc-icon-badge-accent oc-breathe-aura size-9 rounded-md"
              >
                <ModelFamilyIcon family={selectedFamily} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-title font-semibold tracking-tight text-fg">选择对话模型</p>
                <div
                  className="mt-0.5 flex items-center gap-1.5 truncate text-meta text-muted"
                  title={label}
                  data-testid="model-picker-sheet-subtitle"
                >
                  <span className="truncate">
                    {headerDisplay.cleanName}
                    {tierLabel ? ` · ${tierLabel}` : ''}
                  </span>
                  {headerDisplay.tags.map((tag) => (
                    <span
                      key={tag.label}
                      aria-hidden="true"
                      className={cn(
                        'inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-micro font-medium leading-tight',
                        tag.tone === 'info' && 'model-picker-tag-info',
                        tag.tone === 'accent' && 'model-picker-tag-accent',
                        tag.tone === 'neutral' && 'model-picker-tag-neutral',
                      )}
                    >
                      {tag.label}
                    </span>
                  ))}
                  {swarmMode && !teamEngineActive && (
                    <span
                      data-testid="model-picker-sheet-swarm-tag"
                      className="model-picker-tag-accent inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-micro font-medium leading-tight"
                    >
                      <AtelierIcon name="swarm" size={10} className="shrink-0" />
                      <span>蜂群</span>
                    </span>
                  )}
                  <CostMark model={selected} multiplier={effectiveMultiplier} />
                </div>
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
                        'oc-btn-tactile oc-spring-press min-h-9 flex-1 rounded-sm px-3 py-1 text-meta font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
                        'oc-btn-tactile oc-spring-press min-h-9 flex-1 rounded-sm px-3 py-1 text-meta font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
                    className="model-picker-sheet-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2.5 py-2.5"
                  >
                    {notes}
                    {list}
                  </div>
                ) : (
                  <div
                    role="tabpanel"
                    data-testid="model-picker-extras-panel"
                    className="model-picker-sheet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 py-3"
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
                  className="model-picker-sheet-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2.5 py-2.5"
                >
                  {notes}
                  {list}
                </div>
                {hasExtras && (
                  <div
                    role="region"
                    aria-label="执行参数"
                    data-testid="model-picker-extras-dock"
                    className="max-h-[44%] shrink-0 overflow-y-auto overscroll-contain border-t border-border/80 bg-bg/75 px-3.5 py-3"
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
              <PickerLabel
                mode="menu"
                className="shrink-0 border-b border-border/70 px-3 py-2 text-caption font-semibold uppercase tracking-wider text-faint"
              >
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
        className="model-picker-popover oc-surface-popover flex w-[min(340px,calc(100vw-24px))] min-w-[15.5rem] flex-col overflow-hidden p-1.5"
      >
        <PickerLabel
          mode="menu"
          className="shrink-0 text-caption font-semibold uppercase tracking-wider text-faint"
        >
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
