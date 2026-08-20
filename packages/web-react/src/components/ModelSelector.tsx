import {
  type ContextTierFamily,
  type CursorEngineFamilyId,
  DEFAULT_CODEX_ENGINE_MODEL,
  DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME,
  type PlatformReasoningEffort,
  contextFamilyByModelId,
  cursorFamilySupportsFast,
  cursorModelById,
} from '@openclaude/protocol'
import { AlertTriangle, Check, ChevronDown, Cpu, Users } from 'lucide-react'
import {
  availableCursorEfforts,
  contextFamilyHasLong,
  contextFamilyHasStandard,
  cursorFamilyHasFast,
  cursorFamilyHasStandard,
  longContextCostConfirmationRequired,
  modelCostLabel,
  modelPickerRows,
  resolveContextPickerSelection,
  resolveCursorPickerSelection,
} from '../lib/cursorModelPicker'
import type { PreferenceEffort } from '../lib/modelPreferences'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import type { PublicModel } from '../lib/types'
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
  useConfirm,
} from './ui'

/**
 * 模型是否被后端标注为降级(0108 provider 健康度)。前端类型宽松透传,运行时 narrowing。
 */
export function isDegraded(m: PublicModel): boolean {
  return (m as { degraded?: unknown }).degraded === true
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

function CostMark({ model }: { model?: PublicModel }) {
  const label = modelCostLabel(model)
  if (!label) return null
  return <span className="text-[11px] font-normal text-faint">{label}</span>
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
 * GPT / Kimi 收成一行，上下文标准/1M 作为独立控件。
 */
export function ModelSelector({
  models,
  selectedId,
  onSelect,
  loading,
  teamEngineActive,
  effortSupported,
  effortActive,
  onSelectEffort,
}: {
  models: PublicModel[]
  selectedId?: string
  onSelect: (id: string) => void
  loading?: boolean
  teamEngineActive?: boolean
  effortSupported?: readonly string[]
  effortActive?: PreferenceEffort | null
  onSelectEffort?: (value: PreferenceEffort | null) => void
}) {
  const selected = models.find((m) => m.id === selectedId)
  const selectedCursor = cursorModelById(selectedId)
  const selectedContext = contextFamilyByModelId(selectedId)
  const selectedDegraded = selected ? isDegraded(selected) : false
  const hasAlternatives = models.some((m) => !isDegraded(m) && m.id !== selectedId)
  const engineLabel = teamEngineLabel(models)
  const baseLabel = triggerLabel(models, selectedId, loading)
  const label = teamEngineActive ? engineLabel : baseLabel
  const disabled = loading || models.length === 0
  const rows = modelPickerRows(models)
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
  const showPlatformEffort =
    !selectedCursor && Boolean(effortSupported && effortSupported.length > 0 && onSelectEffort)
  const [confirmLongContext, confirmLongContextEl] = useConfirm()

  const selectCursor = (
    family: CursorEngineFamilyId,
    members: PublicModel[],
    next?: { effort?: PlatformReasoningEffort | null; fast?: boolean },
  ) => {
    const id = resolveCursorPickerSelection(members, family, selectedId, next)
    if (id) onSelect(id)
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
    onSelect(id)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-product-feature={PRODUCT_CAPABILITIES.models.id}
            disabled={disabled}
            aria-label="选择对话模型"
            className={cn(
              'flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[13.5px] font-medium text-muted outline-none transition-colors',
              'hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]',
              'disabled:pointer-events-none disabled:opacity-50',
              teamEngineActive && 'text-accent hover:text-accent',
            )}
          >
            {teamEngineActive ? (
              <Users size={14} className="text-accent" />
            ) : (
              <Cpu size={14} className="text-faint" />
            )}
            {teamEngineActive && <span className="hidden sm:inline">{'团队模式 · '}</span>}
            <span className="max-w-[6.5rem] truncate sm:max-w-[180px]">{label}</span>
            {!teamEngineActive && <CostMark model={selected} />}
            <ChevronDown size={14} className="text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          data-product-feature={PRODUCT_CAPABILITIES.models.id}
          className="flex max-h-[80vh] min-w-[15rem] flex-col"
        >
          <DropdownMenuLabel className="shrink-0">对话模型</DropdownMenuLabel>
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((row) => {
              if (row.kind === 'plain') {
                const m = row.model
                const active = m.id === selectedId
                const degraded = isDegraded(m)
                return (
                  <DropdownMenuItem
                    key={m.id}
                    data-model-id={m.id}
                    disabled={degraded}
                    onSelect={degraded ? undefined : () => onSelect(m.id)}
                    className="justify-between"
                  >
                    <span className="truncate">{modelLabel(m)}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <CostMark model={m} />
                      {degraded && <Badge tone="danger">暂不可用</Badge>}
                      {active && !degraded && (
                        <>
                          {teamEngineActive && (
                            <span className="text-[11px] text-faint">团队模式关闭后生效</span>
                          )}
                          <Check size={14} className="shrink-0 text-accent" />
                        </>
                      )}
                    </span>
                  </DropdownMenuItem>
                )
              }
              if (row.kind === 'context-family') {
                const familyActive = selectedContext?.family === row.row.family
                const representative =
                  resolveContextPickerSelection(row.row.members, row.row.spec, selectedId) ??
                  row.row.members[0]?.id
                const representativeModel = row.row.members.find(
                  (item) => item.id === representative,
                )
                const degraded = row.row.members.every(isDegraded)
                return (
                  <DropdownMenuItem
                    key={row.row.family}
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
                      {degraded && <Badge tone="danger">暂不可用</Badge>}
                      {familyActive && !degraded && (
                        <>
                          {teamEngineActive && (
                            <span className="text-[11px] text-faint">团队模式关闭后生效</span>
                          )}
                          <Check size={14} className="shrink-0 text-accent" />
                        </>
                      )}
                    </span>
                  </DropdownMenuItem>
                )
              }
              const familyActive = selectedCursor?.family === row.row.family
              const representative =
                resolveCursorPickerSelection(row.row.members, row.row.family, selectedId) ??
                row.row.members[0]?.id
              const representativeModel = row.row.members.find((item) => item.id === representative)
              const degraded = row.row.members.every(isDegraded)
              return (
                <DropdownMenuItem
                  key={row.row.family}
                  data-model-id={representative}
                  data-cursor-family={row.row.family}
                  disabled={degraded}
                  onSelect={
                    degraded ? undefined : () => selectCursor(row.row.family, row.row.members)
                  }
                  className="justify-between"
                >
                  <span className="truncate">{row.row.label}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <CostMark model={representativeModel} />
                    {degraded && <Badge tone="danger">暂不可用</Badge>}
                    {familyActive && !degraded && (
                      <>
                        {teamEngineActive && (
                          <span className="text-[11px] text-faint">团队模式关闭后生效</span>
                        )}
                        <Check size={14} className="shrink-0 text-accent" />
                      </>
                    )}
                  </span>
                </DropdownMenuItem>
              )
            })}
          </div>
          {showCursorEffort && selectedCursor && (
            <div className="shrink-0">
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center justify-between">
                思考档位
                <span className="text-[11px] font-normal text-faint">
                  {EFFORT_OPTIONS.find((o) => o.value === selectedCursor.effort)?.label ??
                    selectedCursor.effort ??
                    '—'}
                </span>
              </DropdownMenuLabel>
              {EFFORT_OPTIONS.filter((o) => cursorEfforts.includes(o.value)).map((o) => (
                <DropdownMenuItem
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
                </DropdownMenuItem>
              ))}
            </div>
          )}
          {showCursorFast && selectedCursor && (
            <div className="shrink-0">
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center justify-between">
                速度
                <span className="text-[11px] font-normal text-faint">
                  {selectedCursor.fast ? 'Fast' : '标准'}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem
                data-fast="false"
                disabled={!cursorFamilyHasStandard(cursorMembers, selectedCursor.effort)}
                onSelect={() => selectCursor(selectedCursor.family, cursorMembers, { fast: false })}
                className="justify-between"
              >
                <span>标准</span>
                {!selectedCursor.fast && <Check size={14} className="shrink-0 text-accent" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-fast="true"
                disabled={!cursorFamilyHasFast(cursorMembers, selectedCursor.effort)}
                onSelect={() => selectCursor(selectedCursor.family, cursorMembers, { fast: true })}
                className="justify-between"
              >
                <span>Fast</span>
                {selectedCursor.fast && <Check size={14} className="shrink-0 text-accent" />}
              </DropdownMenuItem>
            </div>
          )}
          {showContextTier && selectedContext && selectedContextRow?.kind === 'context-family' && (
            <div className="shrink-0">
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center justify-between">
                上下文
                <span className="text-[11px] font-normal text-faint">
                  {selectedId === selectedContext.longId ? '1M' : '标准'}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem
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
              </DropdownMenuItem>
              <DropdownMenuItem
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
              </DropdownMenuItem>
            </div>
          )}
          {showPlatformEffort && effortSupported && onSelectEffort && (
            <div className="shrink-0">
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center justify-between">
                思考档位
                <span className="text-[11px] font-normal text-faint">
                  {effortActive == null
                    ? '跟随模型默认'
                    : (EFFORT_OPTIONS.find((o) => o.value === effortActive)?.label ?? effortActive)}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem
                data-effort="follow"
                onSelect={() => onSelectEffort(null)}
                className="justify-between"
              >
                <span>跟随模型默认</span>
                {effortActive == null && <Check size={14} className="shrink-0 text-accent" />}
              </DropdownMenuItem>
              {EFFORT_OPTIONS.filter((o) => effortSupported.includes(o.value)).map((o) => (
                <DropdownMenuItem
                  key={o.value}
                  data-effort={o.value}
                  onSelect={() => onSelectEffort(o.value)}
                  className="justify-between"
                >
                  <span>{o.label}</span>
                  {effortActive === o.value && <Check size={14} className="shrink-0 text-accent" />}
                </DropdownMenuItem>
              ))}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmLongContextEl}
    </>
  )
}
