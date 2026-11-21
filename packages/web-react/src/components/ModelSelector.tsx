import {
  type CursorContextTier,
  type ServiceTier,
  DEFAULT_CODEX_ENGINE_MODEL,
  DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME,
  contextFamilyByModelId,
  normalizeServiceTierForModel,
  serviceTierBillingMultiplierNumber,
} from '@openclaude/protocol/browser'
import { AlertTriangle, ChevronDown, Cpu, Loader2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShortViewport, useViewportClass } from '../hooks/useMdViewport'
import {
  GROK_BUILD_MODEL_ID,
  cursorPickerDef,
  grokBuildFastSelected,
  isGrokBuildCatalogId,
  isModelDegraded,
  modelCostLabel,
} from '../lib/cursorModelPicker'
import type { PreferenceEffort } from '../lib/modelPreferences'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import type { LockedPublicModel, PublicModel } from '../lib/types'
import { cn } from '../lib/utils'
import { LazyModelSelectorPanel, preloadModelSelectorPanel } from './lazyModelSelectorPanel'
import { EFFORT_OPTIONS } from './settings/effortOptions'
import { Badge, DropdownMenu, DropdownMenuTrigger } from './ui'

export { preloadModelSelectorPanel }

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

/** 手机紧凑模型胶囊去除末尾括号平台/通道后缀（如 ` (Antigravity)`、`（Codex）`），保留核心型号名。 */
export function compactMobileModelLabel(label: string): string {
  const stripped = label.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/, '').trim()
  return stripped || label
}

function CostMark({ model, multiplier = 1 }: { model?: { cost_x?: number }; multiplier?: number }) {
  const label = modelCostLabel(model, multiplier)
  if (!label) return null
  return <span className="shrink-0 text-caption font-normal tabular-nums text-faint">{label}</span>
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
export function resolveTeamLeaderModel(
  models: PublicModel[],
  teamLeaderModelId?: string | null,
  lockedModels: LockedPublicModel[] = [],
): PublicModel | LockedPublicModel | undefined {
  const serverId =
    typeof teamLeaderModelId === 'string' && teamLeaderModelId.trim()
      ? teamLeaderModelId.trim()
      : undefined
  const targetId = serverId ?? DEFAULT_CODEX_ENGINE_MODEL
  return models.find((x) => x.id === targetId) ?? lockedModels.find((x) => x.id === targetId)
}

export function teamEngineLabel(
  models: PublicModel[],
  teamLeaderModelId?: string | null,
  lockedModels: LockedPublicModel[] = [],
): string {
  const serverId =
    typeof teamLeaderModelId === 'string' && teamLeaderModelId.trim()
      ? teamLeaderModelId.trim()
      : undefined
  const targetId = serverId ?? DEFAULT_CODEX_ENGINE_MODEL
  const usable = models.find((x) => x.id === targetId)
  if (usable) return modelLabel(usable)
  const locked = lockedModels.find((x) => x.id === targetId)
  if (locked) return lockedPlainLabel(locked)
  if (serverId && serverId !== DEFAULT_CODEX_ENGINE_MODEL) return serverId
  return DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME
}

function triggerLabel(
  models: PublicModel[],
  selectedId: string | undefined,
  loading?: boolean,
): string {
  const selected = models.find((m) => m.id === selectedId)
  if (selected) {
    const cursor = cursorPickerDef(selected)
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
 * 不持有任何硬编码/demo 模型列表。下拉/Sheet 主体已拆至懒块 ModelSelectorPanel.tsx，
 * 首屏仅承载轻量触发按钮与计费/速度徽标。
 */
export function ModelSelector({
  models,
  lockedModels = [],
  selectedId,
  onSelect,
  onLockedSelect,
  loading,
  teamEngineActive,
  teamLeaderModelId,
  effortSupported,
  effortActive,
  onSelectEffort,
  contextTier,
  onSelectContextTier,
  serviceTier,
  onSelectServiceTier,
  open,
  onOpenChange,
  onCancelSwitch,
}: {
  models: PublicModel[]
  lockedModels?: LockedPublicModel[]
  selectedId?: string
  onSelect: (id: string) => void
  onLockedSelect?: (info: LockedSelectInfo) => void
  loading?: boolean
  teamEngineActive?: boolean
  teamLeaderModelId?: string
  effortSupported?: readonly string[]
  effortActive?: PreferenceEffort | null
  onSelectEffort?: (value: PreferenceEffort | null) => void
  /**
   * Cursor Opus/Fable 上下文档位(300k 默认 / 1M)。
   */
  contextTier?: CursorContextTier | null
  onSelectContextTier?: (tier: CursorContextTier) => void
  /**
   * OCV5-434 / OCV5-798 速度档位（Fast 2× / Ultrafast 6×），默认标准。
   */
  serviceTier?: ServiceTier | null
  onSelectServiceTier?: (tier: ServiceTier | null) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 压缩切换进行中时给出：trigger 此时禁用，这是放弃等待、保留原模型的唯一入口。 */
  onCancelSwitch?: () => void
}) {
  const selected = models.find((m) => m.id === selectedId)
  const selectedCursor = cursorPickerDef(
    selected ?? (selectedId ? { id: selectedId } : null),
  )
  const selectedDegraded = selected ? isDegraded(selected) : false
  const leaderModel = resolveTeamLeaderModel(models, teamLeaderModelId, lockedModels)
  const engineLabel = teamEngineLabel(models, teamLeaderModelId, lockedModels)
  const effectiveServiceTier = normalizeServiceTierForModel(selectedId, serviceTier)
  const triggerCostMultiplier = teamEngineActive
    ? 1
    : serviceTierBillingMultiplierNumber(selectedId, effectiveServiceTier)
  const baseLabel = triggerLabel(models, selectedId, loading)
  const label = teamEngineActive ? engineLabel : baseLabel
  const mobileLabel = compactMobileModelLabel(label)
  const hasCompactLabel = mobileLabel !== label
  const fastTierMult = serviceTierBillingMultiplierNumber(selectedId, 'fast')
  const ultraTierMult = serviceTierBillingMultiplierNumber(selectedId, 'ultrafast')
  const mobileSpeedBadge = (() => {
    if (teamEngineActive) return null
    if (selectedCursor?.fast) return 'Fast'
    if (grokBuildFastSelected(selectedId)) return 'Fast'
    if (effectiveServiceTier === 'ultrafast') return `Ultra ${ultraTierMult}×`
    if (effectiveServiceTier === 'fast') return `Fast ${fastTierMult}×`
    return null
  })()
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
      else if (effectiveServiceTier === 'ultrafast') parts.push('Ultrafast')
      else if (effectiveServiceTier === 'fast') parts.push('Fast')
    }
    return parts.length > 0 ? parts.join(' · ') : null
  })()
  const disabled = Boolean(loading || teamEngineActive || (models.length === 0 && lockedModels.length === 0))
  const viewportClass = useViewportClass()
  const shortViewport = useShortViewport()
  const useSheet = viewportClass === 'compact' || shortViewport
  const [uncontrolledSheetOpen, setUncontrolledSheetOpen] = useState(false)
  const sheetOpen = teamEngineActive ? false : (open ?? uncontrolledSheetOpen)
  const [everOpened, setEverOpened] = useState(Boolean(open))
  useEffect(() => {
    if (sheetOpen) setEverOpened(true)
  }, [sheetOpen])
  const setSheetOpen = (next: boolean) => {
    if (teamEngineActive && next) return
    if (next) setEverOpened(true)
    onOpenChange?.(next)
    if (open === undefined) setUncontrolledSheetOpen(next)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: 进入团队态即收起既有模型弹层,避免悬挂菜单仍可点选。
  useEffect(() => {
    if (!teamEngineActive) return
    onOpenChange?.(false)
    setUncontrolledSheetOpen(false)
  }, [teamEngineActive])

  const selectedPromo = promoLabelOf(selected)

  const triggerButton = (
    <button
      type="button"
      data-product-feature={PRODUCT_CAPABILITIES.models.id}
      disabled={disabled}
      aria-label="选择对话模型"
      aria-haspopup="menu"
      aria-expanded={useSheet ? sheetOpen : undefined}
      onPointerEnter={() => {
        void preloadModelSelectorPanel().catch(() => {})
      }}
      onFocus={() => {
        void preloadModelSelectorPanel().catch(() => {})
      }}
      onClick={useSheet && !disabled ? () => setSheetOpen(true) : undefined}
      title={
        loading && selected
          ? '正在切换模型，请稍候'
          : teamEngineActive
            ? `团队模式固定由队长模型 ${engineLabel} 执行与计费，关闭团队模式后可切换模型`
            : selectedDegraded
              ? '当前模型暂不可用，点击更换'
              : hasCompactLabel
                ? label
                : undefined
      }
      aria-busy={loading || undefined}
      data-degraded={selectedDegraded && !teamEngineActive ? 'true' : undefined}
      className={cn(
        'oc-btn-tactile flex min-h-10 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/80 bg-surface/85 px-3 py-1 text-section font-medium text-fg shadow-xs outline-none sm:min-h-10 sm:rounded-lg sm:border-border/60 sm:bg-surface/65 sm:px-2.5 sm:py-1.5',
        'hover:border-border-strong hover:bg-surface hover:text-fg hover:shadow-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:pointer-events-none disabled:opacity-50',
        sheetOpen && 'border-accent/45 bg-surface shadow-soft',
        teamEngineActive && 'border-accent/25 bg-accent-soft/70 text-accent hover:text-accent disabled:opacity-100',
      )}
    >
      {loading ? (
        <Loader2
          size={14}
          strokeWidth={1.75}
          className="shrink-0 animate-spin text-accent"
          aria-hidden
          data-testid="model-trigger-spinner"
        />
      ) : teamEngineActive ? (
        <Users size={14} strokeWidth={1.75} className="shrink-0 text-accent" />
      ) : (
        <Cpu size={14} strokeWidth={1.75} className="hidden shrink-0 text-muted sm:block" />
      )}
      {teamEngineActive && <span className="hidden sm:inline">{'队长引擎 · '}</span>}
      {selectedDegraded && !teamEngineActive && (
        <AlertTriangle
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-danger"
          aria-label="当前模型暂不可用"
          data-testid="model-trigger-degraded"
        />
      )}
      {hasCompactLabel ? (
        <>
          <span
            data-testid="model-trigger-label-mobile"
            className="min-w-0 truncate font-medium sm:hidden"
          >
            {mobileLabel}
          </span>
          <span className="hidden min-w-0 truncate font-medium sm:inline sm:max-w-[220px] lg:max-w-[260px]">
            {label}
          </span>
        </>
      ) : (
        <span className="min-w-0 truncate font-medium sm:max-w-[220px] lg:max-w-[260px]">{label}</span>
      )}
      {loading && selected && !teamEngineActive ? (
        <span className="shrink-0 text-faint" data-testid="model-trigger-loading">
          · 切换中…
        </span>
      ) : (
        <>
          {tierLabel && (
            <span className="hidden shrink-0 text-meta font-normal text-muted sm:inline" data-testid="model-trigger-tier">
              · {tierLabel}
            </span>
          )}
          {mobileSpeedBadge && (
            <span
              data-testid="model-trigger-speed-mobile"
              className="oc-badge-craft inline-flex shrink-0 items-center rounded-full bg-accent-soft px-1.5 py-0.5 text-micro font-semibold tabular-nums text-accent sm:hidden"
            >
              {mobileSpeedBadge}
            </span>
          )}
        </>
      )}
      <CostMark model={teamEngineActive ? leaderModel : selected} multiplier={triggerCostMultiplier} />
      {!teamEngineActive && <PromoBadge label={selectedPromo} className="hidden sm:inline-flex" />}
      {!teamEngineActive && (
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={cn(
            'shrink-0 text-faint transition-transform duration-200 ease-spring',
            sheetOpen && 'rotate-180 text-accent',
          )}
        />
      )}
    </button>
  )

  const panelProps = {
    open: sheetOpen,
    onOpenChange: setSheetOpen,
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
    shortViewport,
    effectiveMultiplier: triggerCostMultiplier,
  }

  return (
    <>
      {useSheet ? (
        <>
          {triggerButton}
          {everOpened && <LazyModelSelectorPanel mode="sheet" {...panelProps} />}
        </>
      ) : (
        <DropdownMenu open={sheetOpen} onOpenChange={setSheetOpen}>
          <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
          {everOpened && <LazyModelSelectorPanel mode="menu" {...panelProps} />}
        </DropdownMenu>
      )}
      {onCancelSwitch && (
        <button
          type="button"
          data-testid="model-switch-cancel"
          onClick={onCancelSwitch}
          className="min-h-11 shrink-0 rounded-xl px-2 text-meta text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          取消
        </button>
      )}
    </>
  )
}
