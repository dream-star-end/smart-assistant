import { ChevronDown, ChevronUp, GripVertical, Plus, Workflow } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthEpochStaleError, api } from '../../lib/api'
import { buildSchedule, cronHuman } from '../../lib/cron'
import {
  type BoardAgent,
  DELEGATE_IDLE_TIMEOUT_MAX_SEC,
  ON_FAILURE_ACTIONS,
  ON_FAILURE_LABEL,
  ON_SUCCESS_ACTIONS,
  ON_SUCCESS_LABEL,
  type OnFailureAction,
  type OnSuccessAction,
  type Pipeline,
  type PipelineStage,
  STAGE_EFFORTS,
  STAGE_EFFORT_LABEL,
  STAGE_KINDS,
  STAGE_KIND_LABEL,
  type StageKind,
  type StagePatchInput,
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  type TicketType,
  isVersionConflict,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession, PublicModel } from '../../lib/types'
import { cn } from '../../lib/utils'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  ListSkeleton,
  Select,
  Switch,
  Textarea,
  useConfirm,
  usePrompt,
  useToast,
} from '../ui'
import { PanelSheet } from './PanelSheet'

const HOUR_OPTIONS = [
  { value: '', label: '跟随全局' },
  ...Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
  })),
]

const ENTRY_HINT =
  '空则放行。可用 always、no_open_blockers、has_body_section("章节名")、has_label("标签")、has_comment_from(human|agent|system)、priority_at_least(P0|P1|P2|P3)、last_run_succeeded，以及 && || ! ()。'

function blankToNull(s: string): string | null {
  const t = s.trim()
  return t ? t : null
}

function patrolCronError(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  try {
    buildSchedule('advanced', { cron: s, oneshot: false })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Cron 格式无效'
  }
}

function parseToolsets(raw: string): string[] | null {
  const parts = raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : null
}

interface PipelineBundle {
  pipeline: Pipeline
  stages: PipelineStage[]
}

interface StageDraft {
  name: string
  kind: StageKind
  agentId: string
  model: string
  promptTemplate: string
  toolsets: string
  effort: string
  patrolCron: string
  patrolEnabled: boolean
  patrolTimezone: string
  quietHoursStart: string
  quietHoursEnd: string
  maxRunsPerDay: string
  timeoutSec: string
  maxRetries: string
  circuitBreakerThreshold: string
  onSuccess: OnSuccessAction
  onFailure: OnFailureAction
  entryCondition: string
  exitChecklist: string
  requireHumanAck: boolean
  autoClose: boolean
}

function draftFromStage(stage: PipelineStage): StageDraft {
  return {
    name: stage.name,
    kind: stage.kind,
    agentId: stage.agentId ?? '',
    model: stage.model ?? '',
    promptTemplate: stage.promptTemplate ?? '',
    toolsets: (stage.toolsets ?? []).join(', '),
    effort: stage.effort ?? '',
    patrolCron: stage.patrolCron ?? '',
    patrolEnabled: stage.patrolEnabled,
    patrolTimezone: stage.patrolTimezone || 'Asia/Shanghai',
    quietHoursStart: stage.quietHoursStart == null ? '' : String(stage.quietHoursStart),
    quietHoursEnd: stage.quietHoursEnd == null ? '' : String(stage.quietHoursEnd),
    maxRunsPerDay: String(stage.maxRunsPerDay),
    timeoutSec: String(stage.timeoutSec),
    maxRetries: String(stage.maxRetries),
    circuitBreakerThreshold: String(stage.circuitBreakerThreshold),
    onSuccess: stage.onSuccess,
    onFailure: stage.onFailure,
    entryCondition: stage.entryCondition ?? '',
    exitChecklist: stage.exitChecklist ?? '',
    requireHumanAck: stage.requireHumanAck,
    autoClose: stage.autoClose,
  }
}

function parseHour(raw: string): number | null {
  if (!raw.trim()) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null
}

function buildStagePatch(draft: StageDraft): { patch: StagePatchInput; error: string | null } {
  const name = draft.name.trim()
  if (!name) return { patch: {}, error: '请填写阶段名称' }
  const timeoutSec = Number(draft.timeoutSec)
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1) {
    return { patch: {}, error: '超时须为正整数秒' }
  }
  if (timeoutSec > DELEGATE_IDLE_TIMEOUT_MAX_SEC) {
    return { patch: {}, error: `无活动超时不能超过 ${DELEGATE_IDLE_TIMEOUT_MAX_SEC} 秒（45 分钟）` }
  }
  const maxRunsPerDay = Number(draft.maxRunsPerDay)
  if (!Number.isInteger(maxRunsPerDay) || maxRunsPerDay < 1) {
    return { patch: {}, error: '每日执行上限至少为 1' }
  }
  const maxRetries = Number(draft.maxRetries)
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    return { patch: {}, error: '重试次数须为非负整数' }
  }
  const circuitBreakerThreshold = Number(draft.circuitBreakerThreshold)
  if (!Number.isInteger(circuitBreakerThreshold) || circuitBreakerThreshold < 1) {
    return { patch: {}, error: '熔断阈值至少为 1' }
  }
  const kind = draft.kind
  if (kind === 'ai') {
    if (!draft.agentId) return { patch: {}, error: 'AI 阶段必须绑定 agent' }
    if (!draft.promptTemplate.trim()) return { patch: {}, error: 'AI 阶段必须填写提示词模板' }
  }
  const human = kind === 'human'
  if (!human) {
    const cronErr = patrolCronError(draft.patrolCron)
    if (cronErr) return { patch: {}, error: cronErr }
    if (draft.patrolEnabled && !draft.patrolCron.trim()) {
      return { patch: {}, error: '开启巡检时必须填写 5 段 Cron 表达式' }
    }
  }
  const patch: StagePatchInput = {
    name,
    kind,
    agentId: kind === 'ai' ? draft.agentId : null,
    model: kind === 'ai' ? blankToNull(draft.model) : null,
    promptTemplate:
      kind === 'ai' ? blankToNull(draft.promptTemplate) : draft.promptTemplate.trim() || null,
    toolsets: parseToolsets(draft.toolsets),
    effort: blankToNull(draft.effort),
    patrolCron: human ? null : blankToNull(draft.patrolCron),
    patrolEnabled: human ? false : draft.patrolEnabled,
    patrolTimezone: draft.patrolTimezone.trim() || 'Asia/Shanghai',
    quietHoursStart: parseHour(draft.quietHoursStart),
    quietHoursEnd: parseHour(draft.quietHoursEnd),
    maxRunsPerDay,
    timeoutSec,
    maxRetries,
    circuitBreakerThreshold,
    onSuccess: draft.onSuccess,
    onFailure: draft.onFailure,
    entryCondition: blankToNull(draft.entryCondition),
    exitChecklist: blankToNull(draft.exitChecklist),
    requireHumanAck: draft.requireHumanAck,
    autoClose: draft.autoClose,
  }
  return { patch, error: null }
}

function modelLabel(m: PublicModel): string {
  return typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name : m.id
}

function sameDraft(a: StageDraft, b: StageDraft): boolean {
  return (Object.keys(a) as Array<keyof StageDraft>).every((k) => a[k] === b[k])
}

/** 编辑表单里的一个分组:标题可折叠,默认展开由调用方决定(审计 T-28)。 */
function EditorSection({
  title,
  hint,
  defaultOpen = true,
  children,
}: {
  title: string
  hint?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details className="group rounded-lg border border-border" open={defaultOpen}>
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2 text-body font-medium text-fg [&::-webkit-details-marker]:hidden">
        <span>
          {title}
          {hint ? <span className="ml-2 text-caption font-normal text-muted">{hint}</span> : null}
        </span>
        <ChevronDown size={14} className="shrink-0 text-faint transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">{children}</div>
    </details>
  )
}

/**
 * 单个阶段的编辑表单。
 *
 * 草稿保护(审计 T-12):以前任何一次写操作(改名 / 上下移 / 新增阶段)都会 reload → 所有展开的
 * 编辑器整体 remount,20 个字段的草稿归零。现在:
 * - 自己维护 `dirty`,父级用 `stage.id` 当 key,不再随重载 remount;
 * - 外部数据变化时只在**没有未保存修改**的情况下才同步草稿;有修改则给出「载入最新」的提示,
 *   由用户决定放弃本地修改还是继续;
 * - 通过 `onDirtyChange` 把脏状态报给父级,关闭抽屉时可以拦截。
 */
function StageEditor({
  stage,
  agents,
  models,
  saving,
  onSave,
  onDirtyChange,
}: {
  stage: PipelineStage
  agents: BoardAgent[]
  models: PublicModel[]
  saving: boolean
  onSave: (patch: StagePatchInput) => Promise<boolean>
  onDirtyChange?: (stageId: string, dirty: boolean) => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<StageDraft>(() => draftFromStage(stage))
  // baseline = 当前草稿所依据的服务端版本;draft 与它不同即为「有未保存修改」。
  const baselineRef = useRef<StageDraft>(draftFromStage(stage))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const adoptNextRef = useRef(false)
  const incoming = useMemo(() => draftFromStage(stage), [stage])
  const dirty = !sameDraft(draft, baselineRef.current)
  const stale = dirty && !sameDraft(incoming, baselineRef.current)

  useEffect(() => {
    // 没有本地修改(或刚保存成功)才跟着服务端走;有修改时保留草稿,交给「载入最新」提示。
    if (adoptNextRef.current || sameDraft(draftRef.current, baselineRef.current)) {
      adoptNextRef.current = false
      baselineRef.current = incoming
      setDraft(incoming)
    }
  }, [incoming])

  const stageId = stage.id
  useEffect(() => {
    onDirtyChange?.(stageId, dirty)
  }, [dirty, onDirtyChange, stageId])
  useEffect(() => () => onDirtyChange?.(stageId, false), [onDirtyChange, stageId])

  const adoptIncoming = () => {
    baselineRef.current = incoming
    setDraft(incoming)
  }

  const human = draft.kind === 'human'
  const ai = draft.kind === 'ai'
  const cronErr = human ? null : patrolCronError(draft.patrolCron)
  const cronPreview =
    !human && draft.patrolCron.trim() && !cronErr ? cronHuman(draft.patrolCron.trim()) : ''

  const agentOptions = useMemo(() => {
    const opts = [
      { value: '', label: ai ? '请选择 agent' : '无需绑定' },
      ...agents.map((a) => ({ value: a.id, label: a.name || a.id })),
    ]
    if (draft.agentId && !opts.some((o) => o.value === draft.agentId)) {
      opts.push({ value: draft.agentId, label: `${draft.agentId}（当前绑定，不在可选列表）` })
    }
    return opts
  }, [agents, ai, draft.agentId])

  const modelOptions = useMemo(() => {
    const available = models.filter((m) => m.degraded !== true)
    const opts = [
      { value: '', label: '留空=用 agent 默认' },
      ...available.map((m) => ({ value: m.id, label: modelLabel(m) })),
    ]
    if (draft.model && !opts.some((o) => o.value === draft.model)) {
      opts.push({ value: draft.model, label: `${draft.model}（当前覆盖，不在可选列表）` })
    }
    return opts
  }, [models, draft.model])

  const save = async () => {
    const { patch, error } = buildStagePatch(draft)
    if (error) {
      toast(error, 'error')
      return
    }
    const ok = await onSave(patch)
    if (ok) {
      // 保存成功:当前草稿就是新的基线;父级随后 reload,下一份服务端数据无条件采纳。
      baselineRef.current = draft
      adoptNextRef.current = true
    }
  }

  const toggleRow = (label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-meta font-medium text-muted">{label}</span>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )

  return (
    <div className="flex flex-col gap-3" data-testid={`stage-editor-${stage.id}`} data-dirty={dirty ? 'true' : undefined}>
      {stale && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-soft px-3 py-2 text-caption text-warning"
          data-testid={`stage-stale-${stage.id}`}
        >
          <span>这个阶段刚被别处更新过；你有未保存的修改，保存会覆盖对方的改动。</span>
          <Button type="button" size="sm" variant="ghost" onClick={adoptIncoming}>
            放弃我的修改，载入最新
          </Button>
        </div>
      )}
      <EditorSection title="基础">
        <Field label="阶段名称" required>
          <Input
            aria-label="阶段名称"
            inputSize="sm"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
        <Field label="阶段类型">
          <Select
            aria-label="阶段类型"
            inputSize="sm"
            value={draft.kind}
            onValueChange={(v) => setDraft((d) => ({ ...d, kind: v as StageKind }))}
            options={STAGE_KINDS.map((k) => ({ value: k, label: STAGE_KIND_LABEL[k] }))}
          />
        </Field>
        <Field label="准入条件" hint={ENTRY_HINT}>
          <Textarea
            aria-label="准入条件"
            rows={3}
            value={draft.entryCondition}
            onChange={(e) => setDraft((d) => ({ ...d, entryCondition: e.target.value }))}
          />
        </Field>
        <Field label="产出要求" hint="这一站做完要交出什么，agent 会据此自检。">
          <Textarea
            aria-label="产出要求"
            rows={3}
            value={draft.exitChecklist}
            onChange={(e) => setDraft((d) => ({ ...d, exitChecklist: e.target.value }))}
          />
        </Field>
      </EditorSection>
      <EditorSection title="执行" hint={ai ? undefined : '仅 AI 阶段需要'} defaultOpen={ai}>
        <Field
          label="绑定 agent"
          hint={ai ? '只列出可绑定的 agent，隐藏 agent 不在其中。' : '仅 AI 阶段需要绑定 agent'}
        >
          <Select
            aria-label="绑定 agent"
            inputSize="sm"
            value={draft.agentId}
            disabled={!ai}
            onValueChange={(v) => setDraft((d) => ({ ...d, agentId: v }))}
            options={agentOptions}
          />
        </Field>
        <Field label="模型" hint={ai ? '留空则沿用该 agent 的默认模型。' : '仅 AI 阶段可覆盖模型'}>
          <Select
            aria-label="模型覆盖"
            inputSize="sm"
            value={draft.model}
            disabled={!ai}
            onValueChange={(v) => setDraft((d) => ({ ...d, model: v }))}
            options={modelOptions}
          />
        </Field>
        <Field
          label="提示词模板"
          hint="可用 {{ticket.identifier}} {{ticket.title}} {{ticket.body}} {{last_run.summary}} {{last_run.output}} {{comments}}"
        >
          <Textarea
            aria-label="提示词模板"
            rows={5}
            disabled={!ai}
            value={draft.promptTemplate}
            onChange={(e) => setDraft((d) => ({ ...d, promptTemplate: e.target.value }))}
          />
        </Field>
        <Field label="工具集" hint="逗号分隔；留空则用 agent 默认">
          <Input
            aria-label="工具集"
            inputSize="sm"
            value={draft.toolsets}
            onChange={(e) => setDraft((d) => ({ ...d, toolsets: e.target.value }))}
          />
        </Field>
        <Field label="推理档位">
          <Select
            aria-label="推理档位"
            inputSize="sm"
            value={draft.effort}
            onValueChange={(v) => setDraft((d) => ({ ...d, effort: v }))}
            options={[
              { value: '', label: '跟随 agent 默认' },
              ...STAGE_EFFORTS.map((k) => ({ value: k, label: STAGE_EFFORT_LABEL[k] })),
            ]}
          />
        </Field>
        <Field
          label="无活动超时（秒）"
          hint={`连续无输出达到该值才中断；活跃任务不受 45 分钟总时长限制。上限 ${DELEGATE_IDLE_TIMEOUT_MAX_SEC} 秒`}
        >
          <Input
            aria-label="单次超时"
            type="number"
            min={1}
            max={DELEGATE_IDLE_TIMEOUT_MAX_SEC}
            inputSize="sm"
            value={draft.timeoutSec}
            onChange={(e) => setDraft((d) => ({ ...d, timeoutSec: e.target.value }))}
          />
        </Field>
      </EditorSection>
      <EditorSection
        title="巡检"
        hint={human ? '人工阶段无需配置' : undefined}
        defaultOpen={!human && draft.patrolEnabled}
      >
        {toggleRow(
          '启用巡检',
          human ? false : draft.patrolEnabled,
          (v) => setDraft((d) => ({ ...d, patrolEnabled: v })),
          human,
        )}
        <Field
          label="巡检表达式"
          hint={
            human
              ? '人工阶段不参与巡检，不能填写巡检表达式。'
              : cronPreview
                ? `预览：${cronPreview}`
                : '5 段 Cron：分 时 日 月 周，例如 */30 9-19 * * 1-5'
          }
          error={cronErr ?? undefined}
        >
          <Input
            aria-label="巡检表达式"
            inputSize="sm"
            disabled={human}
            placeholder="*/30 9-19 * * 1-5"
            value={human ? '' : draft.patrolCron}
            onChange={(e) => setDraft((d) => ({ ...d, patrolCron: e.target.value }))}
          />
        </Field>
        <Field label="巡检时区">
          <Input
            aria-label="巡检时区"
            inputSize="sm"
            disabled={human}
            value={draft.patrolTimezone}
            onChange={(e) => setDraft((d) => ({ ...d, patrolTimezone: e.target.value }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="静默开始">
            <Select
              aria-label="阶段静默开始"
              inputSize="sm"
              value={draft.quietHoursStart}
              disabled={human}
              onValueChange={(v) => setDraft((d) => ({ ...d, quietHoursStart: v }))}
              options={HOUR_OPTIONS}
            />
          </Field>
          <Field label="静默结束">
            <Select
              aria-label="阶段静默结束"
              inputSize="sm"
              value={draft.quietHoursEnd}
              disabled={human}
              onValueChange={(v) => setDraft((d) => ({ ...d, quietHoursEnd: v }))}
              options={HOUR_OPTIONS}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="每日上限">
            <Input
              aria-label="每日执行上限"
              type="number"
              min={1}
              inputSize="sm"
              value={draft.maxRunsPerDay}
              onChange={(e) => setDraft((d) => ({ ...d, maxRunsPerDay: e.target.value }))}
            />
          </Field>
          <Field label="重试次数">
            <Input
              aria-label="重试次数"
              type="number"
              min={0}
              inputSize="sm"
              value={draft.maxRetries}
              onChange={(e) => setDraft((d) => ({ ...d, maxRetries: e.target.value }))}
            />
          </Field>
          <Field label="熔断阈值">
            <Input
              aria-label="熔断阈值"
              type="number"
              min={1}
              inputSize="sm"
              value={draft.circuitBreakerThreshold}
              onChange={(e) => setDraft((d) => ({ ...d, circuitBreakerThreshold: e.target.value }))}
            />
          </Field>
        </div>
      </EditorSection>
      <EditorSection title="流转">
        <div className="grid grid-cols-2 gap-2">
          <Field label="成功后">
            <Select
              aria-label="成功后"
              inputSize="sm"
              value={draft.onSuccess}
              onValueChange={(v) => setDraft((d) => ({ ...d, onSuccess: v as OnSuccessAction }))}
              options={ON_SUCCESS_ACTIONS.map((k) => ({ value: k, label: ON_SUCCESS_LABEL[k] }))}
            />
          </Field>
          <Field label="失败后">
            <Select
              aria-label="失败后"
              inputSize="sm"
              value={draft.onFailure}
              onValueChange={(v) => setDraft((d) => ({ ...d, onFailure: v as OnFailureAction }))}
              options={ON_FAILURE_ACTIONS.map((k) => ({ value: k, label: ON_FAILURE_LABEL[k] }))}
            />
          </Field>
        </div>
        {toggleRow('成功后自动关单', draft.autoClose, (v) => setDraft((d) => ({ ...d, autoClose: v })))}
        {toggleRow('完成后须我确认', draft.requireHumanAck, (v) =>
          setDraft((d) => ({ ...d, requireHumanAck: v })),
        )}
      </EditorSection>
      <div className="sticky bottom-0 -mx-1 flex items-center gap-2 bg-hover/95 px-1 py-2 backdrop-blur">
        <Button
          type="button"
          size="sm"
          variant="primary"
          loading={saving}
          data-testid={`stage-save-${stage.id}`}
          onClick={() => void save()}
        >
          保存阶段
        </Button>
        {dirty ? (
          <span className="text-caption text-muted">有未保存的修改</span>
        ) : (
          <span className="text-caption text-faint">没有改动</span>
        )}
      </div>
    </div>
  )
}

export function StageSettings({
  auth,
  projectId,
  onChanged,
  compact = false,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  auth: AuthSession
  projectId: string | null
  onChanged?: () => void
  compact?: boolean
  /** 受控打开(TaskboardView 的移动端「配置」菜单 / 看板空态从外部打开)。不传则自管。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 由外部提供入口时隐藏自带按钮。 */
  hideTrigger?: boolean
}) {
  const toast = useToast()
  const [promptText, promptEl] = usePrompt()
  const [confirm, confirmEl] = useConfirm()
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (next: boolean) => {
    setOpenState(next)
    onOpenChange?.(next)
  }
  const [dirtyStages, setDirtyStages] = useState<ReadonlySet<string>>(() => new Set())
  const handleDirty = useCallback((stageId: string, dirty: boolean) => {
    setDirtyStages((cur) => {
      if (cur.has(stageId) === dirty) return cur
      const next = new Set(cur)
      if (dirty) next.add(stageId)
      else next.delete(stageId)
      return next
    })
  }, [])
  // 关闭抽屉前拦一下:有未保存的阶段修改时先问(审计 T-12 ④)。
  const requestClose = async (next: boolean) => {
    if (next) {
      setOpen(true)
      return
    }
    if (dirtyStages.size > 0) {
      const ok = await confirm({
        title: '有未保存的阶段修改',
        body: '关闭后这些修改会丢失。要放弃吗？',
        confirmText: '放弃修改并关闭',
        cancelText: '继续编辑',
        danger: true,
      })
      if (!ok) return
    }
    setOpen(false)
  }
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [bundles, setBundles] = useState<PipelineBundle[]>([])
  const [agents, setAgents] = useState<BoardAgent[]>([])
  const [models, setModels] = useState<PublicModel[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editingStageId, setEditingStageId] = useState<string | null>(null)
  const [newPipeName, setNewPipeName] = useState('')
  const [newPipeType, setNewPipeType] = useState<TicketType>('bug')
  const [newPipeDefault, setNewPipeDefault] = useState(false)
  const [newStageName, setNewStageName] = useState('')
  const [newStageKind, setNewStageKind] = useState<StageKind>('human')
  const [rename, setRename] = useState<Record<string, string>>({})
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const epoch = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const reload = useCallback(async () => {
    if (!projectId) {
      setBundles([])
      setAgents([])
      setModels([])
      return
    }
    const gate = (epoch.current += 1)
    setLoading(true)
    try {
      const [pipes, agentList, modelList] = await Promise.all([
        taskboardApi.listPipelines(auth, projectId),
        taskboardApi.listAgents(auth),
        api.getPublicModels(auth).then((r) => r.models).catch(() => [] as PublicModel[]),
      ])
      const details = await Promise.all(pipes.map((p) => taskboardApi.getPipeline(auth, p.id)))
      if (!mounted.current || epoch.current !== gate) return
      setBundles(details.map((d) => ({ pipeline: d.pipeline, stages: d.stages.slice() })))
      setAgents(agentList)
      setModels(modelList)
      setRename(Object.fromEntries(details.map((d) => [d.pipeline.id, d.pipeline.name])))
      setExpanded((cur) => cur ?? details[0]?.pipeline.id ?? null)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      if (mounted.current && epoch.current === gate) {
        toast(taskboardErrorMessage(e, '加载流水线失败'), 'error')
      }
    } finally {
      if (mounted.current && epoch.current === gate) setLoading(false)
    }
  }, [auth, projectId, toast])

  useEffect(() => {
    if (!open) return
    void reload()
  }, [open, reload])

  const handleConflict = async () => {
    toast('配置已被其他人更新，已重新加载', 'error')
    await reload()
    onChanged?.()
  }

  const runWrite = async (work: () => Promise<void>) => {
    setSaving(true)
    try {
      await work()
      await reload()
      onChanged?.()
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      if (isVersionConflict(e)) {
        await handleConflict()
        return
      }
      toast(taskboardErrorMessage(e, '保存失败'), 'error')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const saveStage = async (stageId: string, patch: StagePatchInput) => {
    setSaving(true)
    try {
      await taskboardApi.patchStage(auth, stageId, patch)
      toast('已保存阶段', 'success')
      await reload()
      onChanged?.()
      return true
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return false
      if (isVersionConflict(e)) {
        await handleConflict()
        return false
      }
      toast(taskboardErrorMessage(e, '保存阶段失败'), 'error')
      return false
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const persistStageOrder = async (ordered: PipelineStage[]) => {
    if (ordered.length === 0) return
    const pipelineId = ordered[0]?.pipelineId
    if (!pipelineId) return
    await runWrite(async () => {
      await taskboardApi.reorderStages(
        auth,
        pipelineId,
        ordered.map((s) => s.id),
      )
      toast('已调整阶段顺序', 'success')
    })
  }

  const moveStage = async (pipelineId: string, stageId: string, dir: -1 | 1) => {
    const bundle = bundles.find((b) => b.pipeline.id === pipelineId)
    if (!bundle) return
    const ordered = [...bundle.stages].sort((a, b) => a.ordinal - b.ordinal)
    const i = ordered.findIndex((s) => s.id === stageId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ordered.length) return
    const next = ordered.slice()
    const [moved] = next.splice(i, 1)
    next.splice(j, 0, moved)
    await persistStageOrder(next)
  }

  const dropStage = async (pipelineId: string, targetId: string) => {
    const fromId = draggingId
    setDropTargetId(null)
    setDraggingId(null)
    if (!fromId || fromId === targetId) return
    const bundle = bundles.find((b) => b.pipeline.id === pipelineId)
    if (!bundle) return
    const ordered = [...bundle.stages].sort((a, b) => a.ordinal - b.ordinal)
    const from = ordered.findIndex((s) => s.id === fromId)
    const to = ordered.findIndex((s) => s.id === targetId)
    if (from < 0 || to < 0) return
    const next = ordered.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await persistStageOrder(next)
  }

  const saveAsTemplate = async (pipelineId: string, fallbackName: string) => {
    const name = await promptText({
      title: '存为自定义模板',
      confirmText: '保存',
      initial: fallbackName,
      placeholder: '模板名称',
      maxLength: 80,
    })
    if (!name?.trim()) return
    const trimmed = name.trim()
    await runWrite(async () => {
      await taskboardApi.createTemplate(auth, { pipelineId, name: trimmed })
      toast(`已保存模板「${trimmed}」`, 'success')
    })
  }

  const createPipe = async () => {
    if (!projectId) return
    const name = newPipeName.trim()
    if (!name) {
      toast('请填写流水线名称', 'error')
      return
    }
    await runWrite(async () => {
      await taskboardApi.createPipeline(auth, {
        projectId,
        name,
        ticketType: newPipeType,
        isDefault: newPipeDefault,
      })
      setNewPipeName('')
      setNewPipeDefault(false)
      toast('已创建流水线', 'success')
    })
  }

  const renamePipe = async (id: string) => {
    const name = (rename[id] ?? '').trim()
    if (!name) {
      toast('请填写流水线名称', 'error')
      return
    }
    await runWrite(async () => {
      await taskboardApi.patchPipeline(auth, id, { name })
      toast('已更新流水线名称', 'success')
    })
  }

  const setDefaultPipe = async (id: string) => {
    await runWrite(async () => {
      await taskboardApi.patchPipeline(auth, id, { isDefault: true })
      toast('已设为该类型的默认流水线', 'success')
    })
  }

  const addStage = async (pipelineId: string) => {
    const name = newStageName.trim()
    if (!name) {
      toast('请填写阶段名称', 'error')
      return
    }
    const bundle = bundles.find((b) => b.pipeline.id === pipelineId)
    const ordinal = bundle ? bundle.stages.length : 0
    await runWrite(async () => {
      const out = await taskboardApi.createStage(auth, pipelineId, {
        name,
        kind: newStageKind,
        ordinal,
      })
      setNewStageName('')
      // 建好直接展开编辑器:要改成 AI 阶段的,在这里改类型并绑定 agent 即可。
      setEditingStageId(out.stage.id)
      toast('已新增阶段，可以继续在下方完善配置', 'success')
    })
  }

  const grouped = useMemo(() => {
    const byType = TICKET_TYPES.map((type) => ({
      type,
      label: TICKET_TYPE_LABEL[type],
      items: bundles.filter((b) => b.pipeline.ticketType === type),
    }))
    const untyped = bundles.filter((b) => b.pipeline.ticketType == null)
    return { byType, untyped }
  }, [bundles])

  const renderPipeline = (bundle: PipelineBundle) => {
    const p = bundle.pipeline
    const stages = [...bundle.stages].sort((a, b) => a.ordinal - b.ordinal)
    const openPipe = expanded === p.id
    const renamed = (rename[p.id] ?? p.name).trim() !== p.name
    return (
      <Card
        key={p.id}
        padding="sm"
        className="flex flex-col gap-2"
        data-testid={`pipeline-${p.id}`}
      >
        {/* 头行拆成两行:名字 + 徽章 / 按钮组。以前六个控件挤一行,窄屏下「收起」孤零零掉到第二行(审计 T-28)。 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`流水线名称 ${p.name}`}
              inputSize="sm"
              className="min-w-0 flex-1"
              value={rename[p.id] ?? p.name}
              onChange={(e) => setRename((cur) => ({ ...cur, [p.id]: e.target.value }))}
            />
            {p.isDefault && (
              <Badge tone="accent" size="sm" className="shrink-0">
                默认
              </Badge>
            )}
            <Badge tone="neutral" size="sm" className="shrink-0">
              {stages.length} 站
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={renamed ? 'primary' : 'secondary'}
              disabled={!renamed || saving}
              onClick={() => void renamePipe(p.id)}
            >
              {renamed ? '保存名称' : '改名'}
            </Button>
            {!p.isDefault && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid={`pipeline-default-${p.id}`}
                onClick={() => void setDefaultPipe(p.id)}
              >
                设为默认
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`pipeline-save-template-${p.id}`}
              disabled={stages.length === 0 || saving}
              onClick={() => void saveAsTemplate(p.id, p.name)}
            >
              存为模板
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              data-testid={`pipeline-toggle-${p.id}`}
              aria-expanded={openPipe}
              onClick={() => setExpanded((cur) => (cur === p.id ? null : p.id))}
            >
              {openPipe ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {openPipe ? '收起阶段' : '展开阶段'}
            </Button>
          </div>
        </div>
        {openPipe && (
          <div className="flex flex-col gap-2 border-t border-border pt-2">
            {stages.length === 0 ? (
              <p className="text-caption text-muted">这条流水线还没有阶段。</p>
            ) : (
              stages.map((stage, idx) => {
                const editing = editingStageId === stage.id
                const dragging = draggingId === stage.id
                const dropTarget = dropTargetId === stage.id && draggingId !== stage.id
                return (
                  <div
                    key={stage.id}
                    className={cn(
                      'rounded-lg bg-hover px-3 py-2',
                      dragging && 'opacity-50',
                      dropTarget && 'ring-2 ring-accent',
                      editing && 'ring-1 ring-border-strong',
                    )}
                    data-testid={`stage-row-${stage.id}`}
                    data-dragging={dragging ? 'true' : undefined}
                    data-drop-target={dropTarget ? 'true' : undefined}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', stage.id)
                      setDraggingId(stage.id)
                    }}
                    onDragEnd={() => {
                      setDraggingId(null)
                      setDropTargetId(null)
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dropTargetId !== stage.id) setDropTargetId(stage.id)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      void dropStage(p.id, stage.id)
                    }}
                  >
                    {/* 名字给足最小宽度,按钮组放不下时整体换到下一行右对齐,不再把名字挤成「需求…」(审计 T-28)。 */}
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="inline-flex text-faint" aria-hidden title="拖拽调整顺序">
                        <GripVertical size={14} />
                      </span>
                      <span className="w-5 text-caption text-faint">{idx + 1}</span>
                      <span className="min-w-[8rem] flex-1 truncate text-body text-fg" title={stage.name}>
                        {stage.name}
                      </span>
                      <Badge size="sm" tone={stage.kind === 'ai' ? 'info' : 'neutral'} className="shrink-0">
                        {STAGE_KIND_LABEL[stage.kind]}
                      </Badge>
                      <div className="ml-auto flex items-center gap-1">
                        <IconButton
                          type="button"
                          size="sm"
                          shape="square"
                          variant="ghost"
                          aria-label={`上移 ${stage.name}`}
                          data-testid={`stage-up-${stage.id}`}
                          disabled={idx === 0 || saving}
                          onClick={() => void moveStage(p.id, stage.id, -1)}
                        >
                          <ChevronUp size={14} />
                        </IconButton>
                        <IconButton
                          type="button"
                          size="sm"
                          shape="square"
                          variant="ghost"
                          aria-label={`下移 ${stage.name}`}
                          data-testid={`stage-down-${stage.id}`}
                          disabled={idx === stages.length - 1 || saving}
                          onClick={() => void moveStage(p.id, stage.id, 1)}
                        >
                          <ChevronDown size={14} />
                        </IconButton>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          data-testid={`stage-edit-${stage.id}`}
                          aria-expanded={editing}
                          onClick={() =>
                            setEditingStageId((cur) => (cur === stage.id ? null : stage.id))
                          }
                        >
                          {editing ? '收起编辑' : '编辑'}
                        </Button>
                      </div>
                    </div>
                    {editing && (
                      <div className="mt-3">
                        {/* key 只用 stage.id:重载不再 remount 编辑器,草稿由 StageEditor 自己守(审计 T-12)。 */}
                        <StageEditor
                          key={stage.id}
                          stage={stage}
                          agents={agents}
                          models={models}
                          saving={saving}
                          onSave={(patch) => saveStage(stage.id, patch)}
                          onDirtyChange={handleDirty}
                        />
                      </div>
                    )}
                  </div>
                )
              })
            )}
            <div className="flex flex-col gap-1 pt-1">
              <div className="flex flex-wrap items-end gap-2">
                <Input
                  aria-label="新阶段名称"
                  inputSize="sm"
                  className="min-w-[8rem] flex-1"
                  placeholder="新阶段名称"
                  value={expanded === p.id ? newStageName : ''}
                  onChange={(e) => setNewStageName(e.target.value)}
                />
                <Select
                  aria-label="新阶段类型"
                  className="w-28"
                  inputSize="sm"
                  value={newStageKind}
                  onValueChange={(v) => setNewStageKind(v as StageKind)}
                  options={STAGE_KINDS.filter((k) => k !== 'ai').map((k) => ({
                    value: k,
                    label: STAGE_KIND_LABEL[k],
                  }))}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid={`stage-add-${p.id}`}
                  loading={saving}
                  onClick={() => void addStage(p.id)}
                >
                  <Plus size={14} />
                  新增阶段
                </Button>
              </div>
              <p className="text-caption text-muted">
                要加 AI 阶段：先建成人工或闸门，建好会自动展开编辑，把类型改成 AI 并绑定 agent 即可。
              </p>
            </div>
          </div>
        )}
      </Card>
    )
  }

  return (
    <>
      {hideTrigger ? null : compact ? (
        <IconButton
          type="button"
          shape="square"
          data-testid="stage-settings-open"
          aria-label="流水线配置"
          title="流水线配置"
          disabled={!projectId}
          onClick={() => setOpen(true)}
        >
          <Workflow size={16} />
        </IconButton>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="stage-settings-open"
          disabled={!projectId}
          onClick={() => setOpen(true)}
        >
          <Workflow size={14} />
          流水线配置
        </Button>
      )}
      <PanelSheet
        open={open}
        onOpenChange={(next) => void requestClose(next)}
        title="流水线配置"
        hint="按单据类型分组。默认线决定新建该类型单据时走哪条。阶段顺序可拖拽，也可用上/下移按钮调整。"
        testId="stage-settings"
      >
        {!projectId ? (
            <EmptyState
              icon={Workflow}
              title="请先选择或新建项目"
              hint="有项目之后才能配置流水线。"
            />
          ) : loading && bundles.length === 0 ? (
            <ListSkeleton rows={6} variant="row" />
          ) : (
            <>
              {grouped.byType.map((g) => (
                <section key={g.type} className="flex flex-col gap-2">
                  <h3 className="text-section font-semibold text-fg">{g.label}</h3>
                  {g.items.length === 0 ? (
                    <p className="text-caption text-muted">还没有 {g.label} 流水线。</p>
                  ) : (
                    g.items.map(renderPipeline)
                  )}
                </section>
              ))}
              {grouped.untyped.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-section font-semibold text-fg">通用</h3>
                  {grouped.untyped.map(renderPipeline)}
                </section>
              )}
              <Card padding="sm" className="flex flex-col gap-2">
                <h3 className="text-section font-semibold text-fg">新建流水线</h3>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="名称" className="min-w-[8rem] flex-1">
                    <Input
                      aria-label="新流水线名称"
                      data-testid="pipeline-create-name"
                      inputSize="sm"
                      value={newPipeName}
                      onChange={(e) => setNewPipeName(e.target.value)}
                    />
                  </Field>
                  <Field label="单据类型" className="w-32">
                    <Select
                      aria-label="新流水线类型"
                      inputSize="sm"
                      value={newPipeType}
                      onValueChange={(v) => setNewPipeType(v as TicketType)}
                      options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }))}
                    />
                  </Field>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-meta font-medium text-muted">设为该类型默认线</span>
                  <Switch
                    aria-label="设为该类型默认线"
                    checked={newPipeDefault}
                    onCheckedChange={setNewPipeDefault}
                  />
                </div>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    data-testid="pipeline-create-submit"
                    loading={saving}
                    onClick={() => void createPipe()}
                  >
                    创建流水线
                  </Button>
                </div>
              </Card>
            </>
          )}
      </PanelSheet>
      {promptEl}
      {confirmEl}
    </>
  )
}
