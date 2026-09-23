import {
  COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL,
  type ContextTierFamily,
  type CursorContextTier,
  type CursorEngineFamilyId,
  DEFAULT_CODEX_ENGINE_MODEL,
  DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME,
  DEFAULT_CURSOR_CONTEXT_TIER,
  type PlatformReasoningEffort,
  contextFamilyByModelId,
  cursorFamilySupportsContextTier,
  cursorFamilySupportsFast,
  cursorModelById,
} from '@openclaude/protocol'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Cpu, Loader2, Lock, Users } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNarrowViewport } from '../hooks/useMdViewport'
import {
  availableCursorEfforts,
  contextFamilyHasLong,
  contextFamilyHasStandard,
  GROK_BUILD_FAST_MODEL_ID,
  GROK_BUILD_MODEL_ID,
  cursorFamilyHasFast,
  cursorFamilyHasStandard,
  grokBuildFastSelected,
  isGrokBuildCatalogId,
  isModelDegraded,
  longContextCostConfirmationRequired,
  modelCostLabel,
  modelPickerRows,
  partitionCollapsedRows,
  resolveContextPickerSelection,
  resolveCursorPickerSelection,
} from '../lib/cursorModelPicker'
import type { PreferenceEffort } from '../lib/modelPreferences'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import { readRecentModels, writeRecentModel } from '../lib/recentModels'
import type { LockedPublicModel, PublicModel } from '../lib/types'
import { cn } from '../lib/utils'
import {
  LONG_CONTEXT_CANCEL_TEXT,
  LONG_CONTEXT_CONFIRM_TEXT,
  LONG_CONTEXT_CONFIRM_TITLE,
  LongContextCostWarning,
} from './LongContextCostWarning'
import { EFFORT_OPTIONS } from './settings/labels'
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sheet,
  useConfirm,
} from './ui'

type PickerMode = 'menu' | 'sheet'

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

/**
 * 模型是否被后端标注为降级(0108 provider 健康度)。判定权威在 cursorModelPicker
 * (picker 排序与此共用),这里保留导出以稳定既有调用方/测试的 import 路径。
 */
export function isDegraded(m: PublicModel): boolean {
  return isModelDegraded(m)
}

/**
 * 模型展示名。后端 PublicModel.display_name 是权威标签（pricing.ts），但前端类型
 * 宽松透传（`{ id: string; [k]: unknown }`），故运行时做一次 string narrowing，
 * 缺失/非串时退回 model id —— 绝不臆造映射，避免与后端两套权威源漂移。
 */
export function modelLabel(m: PublicModel): string {
  const dn = (m as { display_name?: unknown }).display_name
  return typeof dn === 'string' && dn.trim() ? dn : m.id
}

function CostMark({ model }: { model?: { cost_x?: number } }) {
  const label = modelCostLabel(model)
  if (!label) return null
  return <span className="text-caption font-normal text-faint">{label}</span>
}

function promoLabelOf(model: { promo_label?: unknown } | undefined): string | undefined {
  const value = model?.promo_label
  return typeof value === 'string' && value.trim() ? value : undefined
}

function PromoBadge({ label, className }: { label?: string; className?: string }) {
  if (!label) return null
  return <Badge tone="warning" className={className}>{label}</Badge>
}

export type LockedSelectInfo = {
  label: string
  minPlanCode: string
  minPlanName?: string
  modelId: string
}

function lockedPlainLabel(model: LockedPublicModel): string {
  return typeof model.display_name === 'string' && model.display_name.trim()
    ? model.display_name
    : model.id
}

/**
 * 团队模式队长引擎的展示名。引擎 id 权威 = @openclaude/protocol 的
 * DEFAULT_CODEX_ENGINE_MODEL（与 master bridge teamMode 强制覆盖的常量同源，
 * 见 commercial ws/userChatBridge.ts「teamMode.main」分支）；展示名优先取
 * /api/public/models 里同 id 模型的 display_name，列表未含该模型时退回固定标签。
 */
export function teamEngineLabel(models: PublicModel[]): string {
  const m = models.find((x) => x.id === DEFAULT_CODEX_ENGINE_MODEL)
  return m ? modelLabel(m) : DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME
}

function triggerLabel(
  models: PublicModel[],
  selectedId: string | undefined,
  loading?: boolean,
): string {
  const selected = models.find((m) => m.id === selectedId)
  if (selected) {
    const cursor = cursorModelById(selected.id)
    if (cursor) return cursor.familyLabel
    const context = contextFamilyByModelId(selected.id)
    if (context) return context.familyLabel
    if (isGrokBuildCatalogId(selected.id)) {
      const standard = models.find((m) => m.id === GROK_BUILD_MODEL_ID)
      return standard ? modelLabel(standard) : 'Grok 4.7'
    }
    return modelLabel(selected)
  }
  if (loading) return '加载模型…'
  return models[0] ? modelLabel(models[0]) : '暂无可用模型'
}

/**
 * 对话模型选择器（Aurora 顶栏）。完全由 GET /api/public/models 的结果驱动，
 * 不持有任何硬编码/demo 模型列表（demo 预览的 fixture 由调用方注入）。选中的 model id
 * 上抛给 App 顶层状态，P4 的 WS inbound.message 据此发送（前端只发 agentId + model，
 * agent→model 的最终权威在后端）。
 *
 * Cursor 公开家族在菜单里收成一行，思考档与 Fast 作为独立控件映射回 canonical id。
 * 官方 Grok 4.7 同样收成一行：Fast 是速度开关，对应 grok-build / grok-build-fast，不另占模型名。
 * GPT / Kimi 收成一行，上下文标准/1M 作为独立控件。
 */
export function ModelSelector({
  models,
  lockedModels = [],
  selectedId,
  onSelect,
  onLockedSelect,
  loading,
  teamEngineActive,
  effortSupported,
  effortActive,
  onSelectEffort,
  contextTier,
  onSelectContextTier,
  open,
  onOpenChange,
}: {
  models: PublicModel[]
  lockedModels?: LockedPublicModel[]
  selectedId?: string
  onSelect: (id: string) => void
  onLockedSelect?: (info: LockedSelectInfo) => void
  loading?: boolean
  teamEngineActive?: boolean
  effortSupported?: readonly string[]
  effortActive?: PreferenceEffort | null
  onSelectEffort?: (value: PreferenceEffort | null) => void
  /**
   * Cursor Opus/Fable 上下文档位(300k 默认 / 1M)。不是 model id 的一部分:master 按
   * InboundMessage.contextTier 逐 turn 收窄签名 descriptor.contextWindow(protocol
   * projectContextWindowForCursorTier),目录只带 1M 上限。undefined = 300k 默认。
   */
  contextTier?: CursorContextTier | null
  onSelectContextTier?: (tier: CursorContextTier) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const selected = models.find((m) => m.id === selectedId)
  const selectedCursor = cursorModelById(selectedId)
  const selectedContext = contextFamilyByModelId(selectedId)
  const selectedDegraded = selected ? isDegraded(selected) : false
  const hasAlternatives = models.some((m) => !isDegraded(m) && m.id !== selectedId)
  const engineLabel = teamEngineLabel(models)
  const baseLabel = triggerLabel(models, selectedId, loading)
  const label = teamEngineActive ? engineLabel : baseLabel
  // 思考档位是计费相关状态(同家族 medium/high 单价不同),此前只有点开菜单才知道(C-07):
  // trigger 在 sm+ 追加「· 高」「· Fast」。Cursor 家族读 canonical id 上的档位,其它模型读会话偏好。
  const tierLabel = (() => {
    if (teamEngineActive) return null
    const parts: string[] = []
    if (selectedCursor) {
      const effort = EFFORT_OPTIONS.find((o) => o.value === selectedCursor.effort)?.label
      if (effort) parts.push(effort)
      if (selectedCursor.fast) parts.push('Fast')
    } else {
      if (effortSupported && effortSupported.length > 0 && effortActive) {
        const effort = EFFORT_OPTIONS.find((o) => o.value === effortActive)?.label
        if (effort) parts.push(effort)
      }
      if (grokBuildFastSelected(selectedId)) parts.push('Fast')
    }
    return parts.length > 0 ? parts.join(' · ') : null
  })()
  const disabled = loading || (models.length === 0 && lockedModels.length === 0)
  const rows = modelPickerRows(models, lockedModels)
  const {
    visible: visibleRows,
    collapsed: collapsedRows,
    selectedInCollapsed,
  } = partitionCollapsedRows(rows, selectedId)
  // 折叠组默认收起;当前选中项落在组内时自动展开,保证选中项永远可见。
  const [collapsedOpen, setCollapsedOpen] = useState(selectedInCollapsed)
  useEffect(() => {
    if (selectedInCollapsed) setCollapsedOpen(true)
  }, [selectedInCollapsed])
  const narrow = useNarrowViewport()
  const [uncontrolledSheetOpen, setUncontrolledSheetOpen] = useState(false)
  const sheetOpen = open ?? uncontrolledSheetOpen
  const setSheetOpen = (next: boolean) => {
    onOpenChange?.(next)
    if (open === undefined) setUncontrolledSheetOpen(next)
  }
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
      // 与当前选中同一家族的行不进「最近」(C-27):切过同家族不同档位后,主列表里那一行已带 ✓,
      // 「最近」再出现一次同名同 ✓ 的行只会让人以为是两个模型。
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
  const selectedPromo = promoLabelOf(selected)
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
    cursorMembers.some((member) => cursorModelById(member.id)?.fast)
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
    setSheetOpen(false)
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

  const renderRow = (row: (typeof rows)[number], keyPrefix = '', mode: PickerMode = 'menu') => {
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
            {active && !degraded && (
              <>
                {teamEngineActive && (
                  <span className="text-caption text-faint">团队模式关闭后生效</span>
                )}
                <Check size={14} className="shrink-0 text-accent" />
              </>
            )}
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
            {familyActive && !degraded && (
              <>
                {teamEngineActive && (
                  <span className="text-caption text-faint">团队模式关闭后生效</span>
                )}
                <Check size={14} className="shrink-0 text-accent" />
              </>
            )}
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
            setSheetOpen(false)
          }}
          // 锁定态靠锁图标 + 读屏文案表达,不再靠 faint+opacity 降色(a11y-B composer#2:浅色 3.34 / 深色 3.66)。
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
            {familyActive && !degraded && (
              <>
                {teamEngineActive && (
                  <span className="text-caption text-faint">团队模式关闭后生效</span>
                )}
                <Check size={14} className="shrink-0 text-accent" />
              </>
            )}
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
            setSheetOpen(false)
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
          {familyActive && !degraded && (
            <>
              {teamEngineActive && (
                <span className="text-caption text-faint">团队模式关闭后生效</span>
              )}
              <Check size={14} className="shrink-0 text-accent" />
            </>
          )}
        </span>
      </PickerItem>
    )
  }

  const renderPickerBody = (mode: PickerMode) => {
    const notes = (
      <>
        {teamEngineActive && (
          <div
            role="note"
            className="mx-1 mb-1 shrink-0 rounded-md bg-accent-soft px-2.5 py-2 text-xs leading-relaxed"
          >
            <span className="flex items-center gap-1.5 font-medium text-accent">
              <Users size={12} className="shrink-0" /> 团队模式 · 队长引擎 {engineLabel}
            </span>
            <span className="mt-0.5 block text-muted">
              当前会话按 {engineLabel} 执行与计费；下方自选模型将在团队模式关闭后生效。
            </span>
          </div>
        )}
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
            {recentRows.map((row) => renderRow(row, 'recent-', mode))}
            <PickerSeparator mode={mode} />
          </>
        )}
        {visibleRows.map((row) => renderRow(row, '', mode))}
        {showCollapsedGroup && (
          <>
            <PickerSeparator mode={mode} />
            <PickerItem
              mode={mode}
              data-collapsed-group={collapsedOpen ? 'open' : 'closed'}
              aria-expanded={collapsedOpen}
              onSelect={(event) => {
                event.preventDefault()
                setCollapsedOpen((open) => !open)
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
            {collapsedOpen && collapsedRows.map((row) => renderRow(row, '', mode))}
          </>
        )}
      </>
    )
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
            {EFFORT_OPTIONS.filter((o) => cursorEfforts.includes(o.value)).map((o) => (
              <PickerItem
                mode={mode}
                key={o.value}
                data-effort={o.value}
                onSelect={() =>
                  selectCursor(selectedCursor.family, cursorMembers, { effort: o.value })
                }
                className="justify-between"
              >
                <span>{o.label}</span>
                {selectedCursor.effort === o.value && (
                  <Check size={14} className="shrink-0 text-accent" />
                )}
              </PickerItem>
            ))}
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
            <PickerItem
              mode={mode}
              data-fast="false"
              disabled={!cursorFamilyHasStandard(cursorMembers, selectedCursor.effort)}
              onSelect={() => selectCursor(selectedCursor.family, cursorMembers, { fast: false })}
              className="justify-between"
            >
              <span>标准</span>
              {!selectedCursor.fast && <Check size={14} className="shrink-0 text-accent" />}
            </PickerItem>
            <PickerItem
              mode={mode}
              data-fast="true"
              disabled={!cursorFamilyHasFast(cursorMembers, selectedCursor.effort)}
              onSelect={() => selectCursor(selectedCursor.family, cursorMembers, { fast: true })}
              className="justify-between"
            >
              <span>Fast</span>
              {selectedCursor.fast && <Check size={14} className="shrink-0 text-accent" />}
            </PickerItem>
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
            <PickerItem
              mode={mode}
              data-fast="false"
              onSelect={() => rememberAndSelect(GROK_BUILD_MODEL_ID)}
              className="justify-between"
            >
              <span>标准</span>
              {!grokBuildFastSelected(selectedId) && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </PickerItem>
            <PickerItem
              mode={mode}
              data-fast="true"
              onSelect={() => rememberAndSelect(GROK_BUILD_FAST_MODEL_ID)}
              className="justify-between"
            >
              <span>Fast</span>
              {grokBuildFastSelected(selectedId) && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </PickerItem>
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
            <PickerItem
              mode={mode}
              data-cursor-context="300k"
              onSelect={() => {
                onSelectContextTier('300k')
                setSheetOpen(false)
              }}
              className="justify-between"
            >
              <span>300k（默认）</span>
              {activeCursorContextTier === '300k' && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </PickerItem>
            <PickerItem
              mode={mode}
              data-cursor-context="1m"
              onSelect={() => {
                onSelectContextTier('1m')
                setSheetOpen(false)
              }}
              className="justify-between"
            >
              <span>1M（更少压缩，单轮消耗更高）</span>
              {activeCursorContextTier === '1m' && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </PickerItem>
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
            <PickerItem
              mode={mode}
              data-context="standard"
              disabled={!contextFamilyHasStandard(contextMembers, selectedContext)}
              onSelect={() => {
                void selectContext(selectedContextRow.row.spec, contextMembers, {
                  longContext: false,
                })
              }}
              className="justify-between"
            >
              <span>标准</span>
              {selectedId === selectedContext.standardId && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </PickerItem>
            <PickerItem
              mode={mode}
              data-context="1m"
              disabled={!contextFamilyHasLong(contextMembers, selectedContext)}
              onSelect={() => {
                void selectContext(selectedContextRow.row.spec, contextMembers, {
                  longContext: true,
                })
              }}
              className="justify-between"
            >
              <span>1M（1.5 倍基础单价）</span>
              {selectedId === selectedContext.longId && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </PickerItem>
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
            <PickerItem
              mode={mode}
              data-effort="follow"
              onSelect={() => {
                onSelectEffort(null)
                setSheetOpen(false)
              }}
              className="justify-between"
            >
              <span>跟随模型默认</span>
              {effortActive == null && <Check size={14} className="shrink-0 text-accent" />}
            </PickerItem>
            {EFFORT_OPTIONS.filter((o) => effortSupported.includes(o.value)).map((o) => (
              <PickerItem
                mode={mode}
                key={o.value}
                data-effort={o.value}
                onSelect={() => {
                  onSelectEffort(o.value)
                  setSheetOpen(false)
                }}
                className="justify-between"
              >
                <span>{o.label}</span>
                {effortActive === o.value && <Check size={14} className="shrink-0 text-accent" />}
              </PickerItem>
            ))}
          </div>
        )}
      </>
    )
    return (
      <>
        {mode === 'menu' && <PickerLabel mode={mode} className="shrink-0">对话模型</PickerLabel>}
        {notes}
        {mode === 'menu' ? <div className="min-h-0 flex-1 overflow-y-auto">{list}</div> : list}
        {extras}
      </>
    )
  }

  const triggerButton = (
    <button
      type="button"
      data-product-feature={PRODUCT_CAPABILITIES.models.id}
      disabled={disabled}
      aria-label="选择对话模型"
      aria-haspopup="menu"
      aria-expanded={narrow ? sheetOpen : undefined}
      onClick={narrow && !disabled ? () => setSheetOpen(true) : undefined}
      // 当前模型被标降级时 trigger 自身要有标识(C-08),不能只在点开菜单后才看到。
      title={
        loading && selected
          ? '正在切换模型，请稍候'
          : selectedDegraded && !teamEngineActive
            ? '当前模型暂不可用，点击更换'
            : undefined
      }
      aria-busy={loading || undefined}
      data-degraded={selectedDegraded && !teamEngineActive ? 'true' : undefined}
      className={cn(
        'flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-section font-medium text-muted outline-none transition-colors',
        'hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]',
        'disabled:pointer-events-none disabled:opacity-50',
        teamEngineActive && 'text-accent hover:text-accent',
      )}
    >
      {/* 切换中(压缩上下文等)此前只是把 trigger 禁用,用户不知道在等什么(C-28):图标换 spinner + 文案。 */}
      {loading ? (
        <Loader2
          size={14}
          className="shrink-0 animate-spin text-faint"
          aria-hidden
          data-testid="model-trigger-spinner"
        />
      ) : teamEngineActive ? (
        <Users size={14} className="shrink-0 text-accent" />
      ) : (
        <Cpu size={14} className="shrink-0 text-faint" />
      )}
      {/* 顶栏已有「团队模式」chip,trigger 再写一遍「团队模式」是同词两次(C-25);这里改说明
          实际生效的是什么 —— 「队长引擎 · GPT-6-Astra」,「顶栏所见 = 实际所发」的语义不丢。 */}
      {teamEngineActive && <span className="hidden sm:inline">{'队长引擎 · '}</span>}
      {selectedDegraded && !teamEngineActive && (
        <AlertTriangle
          size={13}
          className="shrink-0 text-danger"
          aria-label="当前模型暂不可用"
          data-testid="model-trigger-degraded"
        />
      )}
      <span className="min-w-0 truncate sm:max-w-[180px]">{label}</span>
      {loading && selected && !teamEngineActive ? (
        <span className="shrink-0 text-faint" data-testid="model-trigger-loading">
          · 切换中…
        </span>
      ) : (
        tierLabel && (
          <span className="hidden shrink-0 text-faint sm:inline" data-testid="model-trigger-tier">
            · {tierLabel}
          </span>
        )
      )}
      {!teamEngineActive && <CostMark model={selected} />}
      {!teamEngineActive && <PromoBadge label={selectedPromo} className="hidden sm:inline-flex" />}
      <ChevronDown size={14} className="shrink-0 text-faint" />
    </button>
  )

  return (
    <>
      {narrow ? (
        <>
          {triggerButton}
          <Sheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
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
                data-product-feature={PRODUCT_CAPABILITIES.models.id}
                className="model-picker-sheet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
              >
                {renderPickerBody('sheet')}
              </div>
            </div>
          </Sheet>
        </>
      ) : (
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
          <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            data-product-feature={PRODUCT_CAPABILITIES.models.id}
            className="flex max-h-[80vh] min-w-[15rem] flex-col"
          >
            {renderPickerBody('menu')}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {confirmLongContextEl}
    </>
  )
}
