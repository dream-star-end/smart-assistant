import {
  type ContextTierFamily,
  type CursorContextTier,
  type CursorEngineFamilyId,
  type PlatformReasoningEffort,
  type ServiceTier,
} from '@openclaude/protocol/browser'
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
import { AtelierIcon } from './ui/AtelierIcons'
import { ModelFamilyIcon, type ModelFamilyKind, detectModelFamily } from './ui/ModelFamilyIcons'

export type ExtrasLayout = 'dock' | 'column' | 'tab'

export type ModelDisplayTag = {
  label: string
  tone: 'info' | 'accent' | 'neutral'
}

export type ParsedModelDisplay = {
  raw: string
  cleanName: string
  tags: ModelDisplayTag[]
}

const TRAILING_PAREN_RE = /\s*(?:\(([^()]+)\)|（([^（）]+)）)\s*$/
const TRAILING_MODE_WORD_RE = /\s+(远端|编排)\s*$/

/**
 * 清洗模型展示名中的高频冗余平台后缀（如 `(Antigravity)`）与末尾渠道/模式字样，
 * 提炼为干净主名 + 轻巧微标签；原始全名保留于 `raw` 供 `title` 与 `sr-only` 兼容检索。
 */
export function parseModelDisplayMeta(
  rawLabel: string,
  modelId?: string,
  familyHint?: ModelFamilyKind,
): ParsedModelDisplay {
  const raw = rawLabel
  let text = rawLabel.trim()
  const tags: ModelDisplayTag[] = []
  const seen = new Set<string>()
  const pushTag = (label: string, tone: ModelDisplayTag['tone']) => {
    if (!label || seen.has(label)) return
    seen.add(label)
    tags.push({ label, tone })
  }

  for (let i = 0; i < 3; i += 1) {
    const paren = TRAILING_PAREN_RE.exec(text)
    if (paren) {
      const inner = (paren[1] ?? paren[2] ?? '').trim()
      const candidate = text.slice(0, paren.index).trim()
      if (!candidate) break
      text = candidate
      const lower = inner.toLowerCase()
      if (lower === 'antigravity') {
        // 平台默认通道刷屏后缀直接静默清洗，不再重复渲染徽章
      } else if (lower === 'remote' || inner === '远端') {
        pushTag('远端', 'info')
      } else if (lower === 'orchestrator' || inner === '编排') {
        pushTag('编排', 'accent')
      } else {
        pushTag(inner, 'neutral')
      }
      continue
    }
    const modeWord = TRAILING_MODE_WORD_RE.exec(text)
    if (modeWord) {
      const candidate = text.slice(0, modeWord.index).trim()
      if (!candidate) break
      text = candidate
      if (modeWord[1] === '远端') pushTag('远端', 'info')
      else if (modeWord[1] === '编排') pushTag('编排', 'accent')
      continue
    }
    break
  }

  const family = familyHint ?? detectModelFamily(`${modelId ?? ''} ${rawLabel}`)
  if (family === 'orchestrator') {
    pushTag('编排', 'accent')
  }

  return {
    raw,
    cleanName: text || rawLabel,
    tags,
  }
}

export function ModelNameWithTags({
  rawLabel,
  modelId,
  family,
  className,
}: {
  rawLabel: string
  modelId?: string
  family?: ModelFamilyKind
  className?: string
}) {
  const { cleanName, tags } = parseModelDisplayMeta(rawLabel, modelId, family)
  const hasCleanedDiff = cleanName !== rawLabel
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)} title={rawLabel}>
      {hasCleanedDiff ? (
        <>
          <span className="sr-only">{rawLabel}</span>
          <span aria-hidden="true" className="truncate">
            {cleanName}
          </span>
        </>
      ) : (
        <span className="truncate">{cleanName}</span>
      )}
      {tags.map((tag) => (
        <span
          key={tag.label}
          aria-hidden="true"
          data-model-tag={tag.label}
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
    </span>
  )
}

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
        'model-picker-cost-pill inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-caption font-medium tabular-nums text-muted',
        className,
      )}
    >
      {label}
    </span>
  )
}

/** 底部参数坞 / 双栏右栏 / 矮屏 Tab 共用的横向分段滑块按钮：雕塑感浮起亮卡 + 弹簧触感，无生硬对勾。 */
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
  'data-swarm-mode'?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'oc-btn-tactile oc-spring-press inline-flex min-h-9 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-sm px-2.5 py-1.5 text-caption font-medium outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [@media(hover:none)]:min-h-11',
        active
          ? 'oc-segmented-thumb font-semibold text-accent ring-1 ring-inset ring-accent/25'
          : 'bg-transparent text-muted hover:bg-hover/70 hover:text-fg',
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

function SectionHeading({
  title,
  summary,
  summaryAccent,
  compact,
}: {
  title: string
  summary: ReactNode
  summaryAccent?: boolean
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-1 text-caption font-semibold tracking-wide text-faint',
        compact ? 'pb-1.5' : 'pb-2',
      )}
    >
      <span>{title}</span>
      <span
        className={cn(
          'shrink-0 whitespace-nowrap rounded-full px-2 py-px text-caption font-medium tabular-nums',
          summaryAccent
            ? 'bg-accent-soft text-accent ring-1 ring-inset ring-accent/25'
            : 'model-picker-cost-pill text-muted',
        )}
      >
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
  showSwarmMode?: boolean
  showSwarmUnsupportedHint?: boolean
  swarmMode?: boolean
  swarmRunning?: boolean
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
  onSelectSwarmMode?: (enabled: boolean) => void
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
  showSwarmMode = false,
  showSwarmUnsupportedHint = false,
  swarmMode = false,
  swarmRunning = false,
  onOpenChange,
  onRememberAndSelect,
  onSelectCursor,
  onSelectContext,
  onSelectEffort,
  onSelectContextTier,
  onSelectServiceTier,
  onSelectSwarmMode,
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
  const selectedFamily = detectModelFamily(`${selectedId ?? ''} ${label}`)
  const summaryDisplay = parseModelDisplayMeta(label, selectedId, selectedFamily)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {layout === 'column' && (
        <div
          data-testid="model-picker-extras-summary"
          className="shrink-0 border-b border-border/70 px-3.5 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-caption font-semibold uppercase tracking-wider text-faint">
              执行参数
            </span>
            {activeCostLabel && (
              <span
                data-testid="model-picker-active-cost"
                className="oc-badge-craft rounded-full bg-accent-soft px-2 py-0.5 text-caption font-semibold tabular-nums text-accent"
              >
                {activeCostLabel}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2.5" title={label}>
            <span
              aria-hidden
              className="oc-icon-badge oc-icon-badge-accent oc-breathe-aura size-8 rounded-sm"
            >
              <ModelFamilyIcon family={selectedFamily} size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-meta font-semibold text-fg">
                <span className="truncate">{summaryDisplay.cleanName}</span>
                {summaryDisplay.tags.map((tag) => (
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
                {swarmMode && (
                  <span
                    data-testid="model-picker-extras-swarm-tag"
                    className="model-picker-tag-accent inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-micro font-medium leading-tight"
                  >
                    <AtelierIcon name="swarm" size={10} className="shrink-0" />
                    <span>蜂群</span>
                  </span>
                )}
              </div>
              {tierLabel && (
                <p className="mt-0.5 truncate text-caption text-muted">{tierLabel}</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        className={cn(
          layout === 'column'
            ? 'min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3.5'
            : compact
              ? 'space-y-2.5'
              : 'space-y-3.5',
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
                <span className="text-caption tabular-nums opacity-80">按 {fastTierMult}× 计费</span>
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
                  <span className="text-caption tabular-nums opacity-80">按 {ultraTierMult}× 计费</span>
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
                <span className="text-caption tabular-nums opacity-80">1.5 倍基础单价</span>
              </SegmentPill>
            </div>
          </div>
        )}

        {showSwarmMode && onSelectSwarmMode ? (
          <div data-testid="model-picker-swarm-section">
            <SectionHeading
              title="协作模式"
              summary={swarmMode ? '蜂群' : '单兵'}
              summaryAccent={swarmMode}
              compact={compact}
            />
            {layout === 'column' && (
              <p className="px-1 pb-1.5 text-caption text-muted">
                多智能体并行拆解与讨论板，按各成员实际用量计费。
              </p>
            )}
            <div
              role="group"
              aria-label="协作模式"
              className="oc-surface-recessed flex flex-wrap gap-1 rounded-md p-1"
            >
              <SegmentPill
                data-swarm-mode="solo"
                active={!swarmMode}
                onClick={() => onSelectSwarmMode(false)}
              >
                <span>单兵</span>
              </SegmentPill>
              <SegmentPill
                data-swarm-mode="swarm"
                active={swarmMode}
                onClick={() => onSelectSwarmMode(true)}
              >
                <AtelierIcon name="swarm" size={13} className="shrink-0" />
                <span>蜂群</span>
              </SegmentPill>
            </div>
            {swarmRunning && (
              <p
                data-testid="model-picker-swarm-running-hint"
                className="mt-1.5 px-1 text-caption leading-relaxed text-muted"
              >
                当前蜂群运行中；切回单兵将在下一条消息生效，不影响看板查看。
              </p>
            )}
          </div>
        ) : showSwarmUnsupportedHint ? (
          <div
            data-testid="model-picker-swarm-hint"
            className="flex items-start gap-2 rounded-lg border border-border/70 bg-surface/70 px-2.5 py-2 text-caption text-muted"
          >
            <AtelierIcon name="swarm" size={13} className="mt-0.5 shrink-0 text-accent/80" />
            <span className="leading-relaxed">
              当前模型不支持蜂群；切至带蜂群星轨徽标的模型即可启用蜂群协作。
            </span>
          </div>
        ) : null}

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
