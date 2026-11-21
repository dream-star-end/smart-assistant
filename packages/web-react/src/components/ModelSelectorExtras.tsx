import {
  type ContextTierFamily,
  type CursorContextTier,
  type CursorEngineFamilyId,
  type PlatformReasoningEffort,
  type ServiceTier,
} from '@openclaude/protocol/browser'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  GROK_BUILD_FAST_MODEL_ID,
  GROK_BUILD_MODEL_ID,
  contextFamilyHasLong,
  contextFamilyHasStandard,
  cursorFamilyHasFast,
  cursorFamilyHasStandard,
  cursorPickerDef,
  grokBuildFastSelected,
  modelCostLabel,
} from '../lib/cursorModelPicker'
import type { PreferenceEffort } from '../lib/modelPreferences'
import type { PublicModel } from '../lib/types'
import { cn } from '../lib/utils'
import { EFFORT_OPTIONS } from './settings/effortOptions'

export type ExtrasLayout = 'dock' | 'column' | 'tab'

export function CostMark({
  model,
  multiplier = 1,
  className,
}: {
  model?: { cost_x?: number }
  multiplier?: number
  className?: string
}) {
  const label = modelCostLabel(model, multiplier)
  if (!label) return null
  return (
    <span
      className={cn(
        'rounded-xs bg-hover/70 px-1.5 py-px text-caption font-normal tabular-nums text-faint',
        className,
      )}
    >
      {label}
    </span>
  )
}

/** 底部参数坞 / 双栏右栏 / 矮屏 Tab 共用的横向分段滑块按钮：置于 .oc-surface-recessed 轨道内，触屏维持 ≥44px。 */
export function SegmentPill({
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
        'oc-btn-tactile inline-flex min-h-8 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-sm px-2.5 py-1 text-caption font-medium outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [@media(hover:none)]:min-h-11',
        active
          ? 'oc-segmented-thumb font-semibold text-accent ring-1 ring-inset ring-accent/30'
          : 'bg-transparent text-muted hover:bg-hover/70 hover:text-fg',
      )}
      {...rest}
    >
      {active && <Check size={12} strokeWidth={2.25} className="shrink-0 text-accent" aria-hidden />}
      {children}
    </button>
  )
}

function SectionHeading({
  title,
  summary,
  compact,
}: {
  title: string
  summary: ReactNode
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-1 text-caption font-semibold tracking-wide text-faint',
        compact ? 'pb-1' : 'pb-1.5',
      )}
    >
      <span>{title}</span>
      <span className="shrink-0 whitespace-nowrap rounded-xs bg-hover/65 px-1.5 py-px text-caption font-medium tabular-nums text-muted">
        {summary}
      </span>
    </div>
  )
}

export type ModelSelectorExtrasProps = {
  layout: ExtrasLayout
  models: PublicModel[]
  selected?: PublicModel
  selectedId?: string
  label: string
  tierLabel: string | null
  effectiveMultiplier: number
  selectedCursor: ReturnType<typeof cursorPickerDef>
  cursorMembers: PublicModel[]
  cursorEfforts: readonly PlatformReasoningEffort[]
  showCursorEffort: boolean
  showCursorFast: boolean
  showGrokFast: boolean
  showServiceTiers: boolean
  availableServiceTiers: readonly ServiceTier[]
  effectiveServiceTier: ServiceTier | null
  fastTierMult: number
  ultraTierMult: number
  showCursorContextTier: boolean
  activeCursorContextTier: CursorContextTier
  showContextTier: boolean
  selectedContext: ContextTierFamily | null | undefined
  contextMembers: PublicModel[]
  showPlatformEffort: boolean
  effortSupported?: readonly string[]
  effortActive?: PreferenceEffort | null
  onOpenChange: (open: boolean) => void
  onRememberAndSelect: (id: string) => void
  onSelectCursor: (
    family: CursorEngineFamilyId,
    members: PublicModel[],
    next?: { effort?: PlatformReasoningEffort | null; fast?: boolean },
  ) => void
  onSelectContext: (
    spec: ContextTierFamily,
    members: PublicModel[],
    next?: { longContext?: boolean },
  ) => Promise<void>
  onSelectEffort?: (value: PreferenceEffort | null) => void
  onSelectContextTier?: (tier: CursorContextTier) => void
  onSelectServiceTier?: (tier: ServiceTier | null) => void
}

/**
 * 模型执行参数区块（速度档位 / 上下文 / 思考档位 + 当前档位倍率摘要）。
 * 统一承载手机 BottomSheet 底部参数坞、平板/桌面双栏右栏与矮屏 2-Tab 参数页，
 * 严守 V5 显式可控红线（永不黑盒折叠或隐藏倍率）。
 */
export function ModelSelectorExtras({
  layout,
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
  selectedContext,
  contextMembers,
  showPlatformEffort,
  effortSupported,
  effortActive,
  onOpenChange,
  onRememberAndSelect,
  onSelectCursor,
  onSelectContext,
  onSelectEffort,
  onSelectContextTier,
  onSelectServiceTier,
}: ModelSelectorExtrasProps) {
  const compact = layout === 'dock'
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

  const speedSummary = (() => {
    if (showCursorFast && selectedCursor) return selectedCursor.fast ? 'Fast' : '标准'
    if (showGrokFast) return grokBuildFastSelected(selectedId) ? 'Fast' : '标准'
    if (showServiceTiers) {
      if (effectiveServiceTier === 'ultrafast') return `Ultrafast (${ultraTierMult}×)`
      if (effectiveServiceTier === 'fast') return `Fast (${fastTierMult}×)`
      return '标准'
    }
    return null
  })()

  const activeCostLabel = modelCostLabel(selected, effectiveMultiplier)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {layout === 'column' && (
        <div
          data-testid="model-picker-extras-summary"
          className="shrink-0 border-b border-border/70 px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-caption font-semibold tracking-wider text-faint">执行参数</span>
            {activeCostLabel && (
              <span
                data-testid="model-picker-active-cost"
                className="oc-badge-craft rounded-full bg-accent-soft px-2 py-0.5 text-caption font-semibold tabular-nums text-accent"
              >
                {activeCostLabel}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-meta font-semibold text-fg">
            {label}
            {tierLabel ? <span className="font-normal text-muted"> · {tierLabel}</span> : null}
          </p>
        </div>
      )}

      <div
        className={cn(
          layout === 'column'
            ? 'min-h-0 flex-1 space-y-3.5 overflow-y-auto overscroll-contain p-3'
            : compact
              ? 'space-y-2'
              : 'space-y-3',
        )}
      >
        {showCursorFast && selectedCursor && (
          <div>
            <SectionHeading title="速度" summary={speedSummary} compact={compact} />
            <div role="group" aria-label="速度档位" className="oc-surface-recessed flex flex-wrap gap-1 rounded-md p-1">
              <SegmentPill
                data-fast="false"
                active={!selectedCursor.fast}
                disabled={!cursorFamilyHasStandard(cursorMembers, selectedCursor.effort)}
                onClick={() => onSelectCursor(selectedCursor.family, cursorMembers, { fast: false })}
              >
                <span>标准</span>
                <CostMark model={cursorStdMember} />
              </SegmentPill>
              <SegmentPill
                data-fast="true"
                active={selectedCursor.fast}
                disabled={!cursorFamilyHasFast(cursorMembers, selectedCursor.effort)}
                onClick={() => onSelectCursor(selectedCursor.family, cursorMembers, { fast: true })}
              >
                <span>Fast</span>
                <CostMark model={cursorFastMember} />
              </SegmentPill>
            </div>
          </div>
        )}

        {showGrokFast && (
          <div>
            <SectionHeading title="速度" summary={speedSummary} compact={compact} />
            <div role="group" aria-label="速度档位" className="oc-surface-recessed flex flex-wrap gap-1 rounded-md p-1">
              <SegmentPill
                data-fast="false"
                active={!grokBuildFastSelected(selectedId)}
                onClick={() => onRememberAndSelect(GROK_BUILD_MODEL_ID)}
              >
                <span>标准</span>
                <CostMark model={models.find((model) => model.id === GROK_BUILD_MODEL_ID)} />
              </SegmentPill>
              <SegmentPill
                data-fast="true"
                active={grokBuildFastSelected(selectedId)}
                onClick={() => onRememberAndSelect(GROK_BUILD_FAST_MODEL_ID)}
              >
                <span>Fast</span>
                <CostMark model={models.find((model) => model.id === GROK_BUILD_FAST_MODEL_ID)} />
              </SegmentPill>
            </div>
          </div>
        )}

        {showServiceTiers && onSelectServiceTier && (
          <div>
            <SectionHeading title="速度" summary={speedSummary} compact={compact} />
            <div role="group" aria-label="速度档位" className="oc-surface-recessed flex flex-wrap gap-1 rounded-md p-1">
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
                <span className="text-micro tabular-nums opacity-80">按 {fastTierMult}× 计费</span>
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
                  <span className="text-micro tabular-nums opacity-80">按 {ultraTierMult}× 计费</span>
                  <CostMark model={selected} multiplier={ultraTierMult} />
                </SegmentPill>
              )}
            </div>
          </div>
        )}

        {showCursorContextTier && onSelectContextTier && (
          <div>
            <SectionHeading
              title="上下文"
              summary={activeCursorContextTier === '1m' ? '1M' : '300k'}
              compact={compact}
            />
            <div role="group" aria-label="上下文长度" className="oc-surface-recessed flex flex-wrap gap-1 rounded-md p-1">
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

        {showContextTier && selectedContext && (
          <div>
            <SectionHeading
              title="上下文"
              summary={selectedId === selectedContext.longId ? '1M' : '标准'}
              compact={compact}
            />
            <div role="group" aria-label="上下文长度" className="oc-surface-recessed flex flex-wrap gap-1 rounded-md p-1">
              <SegmentPill
                data-context="standard"
                active={selectedId === selectedContext.standardId}
                disabled={!contextFamilyHasStandard(contextMembers, selectedContext)}
                onClick={() => {
                  void onSelectContext(selectedContext, contextMembers, { longContext: false })
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
                  void onSelectContext(selectedContext, contextMembers, { longContext: true })
                }}
              >
                <span>1M</span>
                <span className="text-micro tabular-nums opacity-80">1.5 倍基础单价</span>
              </SegmentPill>
            </div>
          </div>
        )}

        {showCursorEffort && selectedCursor && (
          <div>
            <SectionHeading
              title="思考档位"
              summary={
                EFFORT_OPTIONS.find((o) => o.value === selectedCursor.effort)?.label ??
                selectedCursor.effort ??
                '—'
              }
              compact={compact}
            />
            <div role="group" aria-label="思考档位" className="oc-surface-recessed flex flex-wrap gap-1 rounded-md p-1">
              {EFFORT_OPTIONS.filter((o) => cursorEfforts.includes(o.value)).map((o) => (
                <SegmentPill
                  key={o.value}
                  data-effort={o.value}
                  active={selectedCursor.effort === o.value}
                  onClick={() =>
                    onSelectCursor(selectedCursor.family, cursorMembers, { effort: o.value })
                  }
                >
                  <span>{o.label}</span>
                </SegmentPill>
              ))}
            </div>
          </div>
        )}

        {showPlatformEffort && effortSupported && onSelectEffort && (
          <div>
            <SectionHeading
              title="思考档位"
              summary={
                effortActive == null
                  ? '跟随模型默认'
                  : (EFFORT_OPTIONS.find((o) => o.value === effortActive)?.label ?? effortActive)
              }
              compact={compact}
            />
            {!compact && (
              <p className="px-1 pb-1.5 text-caption text-muted">
                较低档偏重响应速度，较高档偏重复杂任务。
              </p>
            )}
            <div role="group" aria-label="思考档位" className="oc-surface-recessed flex flex-wrap gap-1 rounded-md p-1">
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
      </div>
    </div>
  )
}
