import { ChevronDown, ChevronUp, Plus, Workflow } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import { buildSchedule, cronHuman } from '../../lib/cron'
import {
  type BoardAgent,
  DELEGATE_HARD_TIMEOUT_SEC,
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
import type { AuthSession } from '../../lib/types'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  ListSkeleton,
  Select,
  Sheet,
  Switch,
  Textarea,
  useToast,
} from '../ui'

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
  if (timeoutSec > DELEGATE_HARD_TIMEOUT_SEC) {
    return { patch: {}, error: `超时不能超过 ${DELEGATE_HARD_TIMEOUT_SEC} 秒（45 分钟）` }
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

function StageEditor({
  stage,
  agents,
  saving,
  onSave,
}: {
  stage: PipelineStage
  agents: BoardAgent[]
  saving: boolean
  onSave: (patch: StagePatchInput) => Promise<boolean>
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<StageDraft>(() => draftFromStage(stage))

  useEffect(() => {
    setDraft(draftFromStage(stage))
  }, [stage])

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

  const save = async () => {
    const { patch, error } = buildStagePatch(draft)
    if (error) {
      toast(error, 'error')
      return
    }
    await onSave(patch)
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`stage-editor-${stage.id}`}>
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
      <Field
        label="绑定 agent"
        hint={ai ? '数据来自可绑定 agent 列表，不含隐藏 agent' : '仅 AI 阶段需要绑定 agent'}
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
      <Field
        label="提示词模板"
        hint="可用 {{ticket.identifier}} {{ticket.title}} {{ticket.body}} {{last_run.summary}} {{comments}}"
      >
        <Textarea
          aria-label="提示词模板"
          rows={5}
          disabled={!ai}
          value={draft.promptTemplate}
          onChange={(e) => setDraft((d) => ({ ...d, promptTemplate: e.target.value }))}
        />
      </Field>
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
      <div className="flex items-center justify-between gap-3">
        <span className="text-meta font-medium text-muted">启用巡检</span>
        <Switch
          aria-label="启用巡检"
          checked={human ? false : draft.patrolEnabled}
          disabled={human}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, patrolEnabled: v }))}
        />
      </div>
      <Field label="准入条件" hint={ENTRY_HINT}>
        <Textarea
          aria-label="准入条件"
          rows={3}
          value={draft.entryCondition}
          onChange={(e) => setDraft((d) => ({ ...d, entryCondition: e.target.value }))}
        />
      </Field>
      <div className="flex items-center justify-between gap-3">
        <span className="text-meta font-medium text-muted">成功后自动关单</span>
        <Switch
          aria-label="成功后自动关单"
          checked={draft.autoClose}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, autoClose: v }))}
        />
      </div>
      <Field
        label="单次超时（秒）"
        hint={`上限 ${DELEGATE_HARD_TIMEOUT_SEC} 秒（45 分钟，delegate 硬超时）`}
      >
        <Input
          aria-label="单次超时"
          type="number"
          min={1}
          max={DELEGATE_HARD_TIMEOUT_SEC}
          inputSize="sm"
          value={draft.timeoutSec}
          onChange={(e) => setDraft((d) => ({ ...d, timeoutSec: e.target.value }))}
        />
      </Field>
      <Field label="产出要求">
        <Textarea
          aria-label="产出要求"
          rows={3}
          value={draft.exitChecklist}
          onChange={(e) => setDraft((d) => ({ ...d, exitChecklist: e.target.value }))}
        />
      </Field>
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
      <div className="flex items-center justify-between gap-3">
        <span className="text-meta font-medium text-muted">完成后须我确认</span>
        <Switch
          aria-label="完成后须我确认"
          checked={draft.requireHumanAck}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, requireHumanAck: v }))}
        />
      </div>
      <div>
        <Button
          type="button"
          size="sm"
          loading={saving}
          data-testid={`stage-save-${stage.id}`}
          onClick={() => void save()}
        >
          保存阶段
        </Button>
      </div>
    </div>
  )
}

export function StageSettings({
  auth,
  projectId,
  onChanged,
}: {
  auth: AuthSession
  projectId: string | null
  onChanged?: () => void
}) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [bundles, setBundles] = useState<PipelineBundle[]>([])
  const [agents, setAgents] = useState<BoardAgent[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editingStageId, setEditingStageId] = useState<string | null>(null)
  const [newPipeName, setNewPipeName] = useState('')
  const [newPipeType, setNewPipeType] = useState<TicketType>('bug')
  const [newPipeDefault, setNewPipeDefault] = useState(false)
  const [newStageName, setNewStageName] = useState('')
  const [newStageKind, setNewStageKind] = useState<StageKind>('human')
  const [rename, setRename] = useState<Record<string, string>>({})
  const [dataGen, setDataGen] = useState(0)
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
      return
    }
    const gate = (epoch.current += 1)
    setLoading(true)
    try {
      const [pipes, agentList] = await Promise.all([
        taskboardApi.listPipelines(auth, projectId),
        taskboardApi.listAgents(auth),
      ])
      const details = await Promise.all(pipes.map((p) => taskboardApi.getPipeline(auth, p.id)))
      if (!mounted.current || epoch.current !== gate) return
      setBundles(details.map((d) => ({ pipeline: d.pipeline, stages: d.stages.slice() })))
      setAgents(agentList)
      setRename(Object.fromEntries(details.map((d) => [d.pipeline.id, d.pipeline.name])))
      setExpanded((cur) => cur ?? details[0]?.pipeline.id ?? null)
      setDataGen((n) => n + 1)
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

  const moveStage = async (pipelineId: string, stageId: string, dir: -1 | 1) => {
    const bundle = bundles.find((b) => b.pipeline.id === pipelineId)
    if (!bundle) return
    const ordered = [...bundle.stages].sort((a, b) => a.ordinal - b.ordinal)
    const i = ordered.findIndex((s) => s.id === stageId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ordered.length) return
    const a = ordered[i]
    const b = ordered[j]
    const temp = Math.max(...ordered.map((s) => s.ordinal), 0) + 1
    await runWrite(async () => {
      await taskboardApi.patchStage(auth, a.id, { ordinal: temp })
      await taskboardApi.patchStage(auth, b.id, { ordinal: a.ordinal })
      await taskboardApi.patchStage(auth, a.id, { ordinal: b.ordinal })
      toast('已调整阶段顺序', 'success')
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
    if (newStageKind === 'ai') {
      toast('请先建成人工或闸门阶段，再在编辑里改成 AI 并绑定 agent', 'error')
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
      setEditingStageId(out.stage.id)
      toast('已新增阶段', 'success')
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
    return (
      <Card
        key={p.id}
        padding="sm"
        className="flex flex-col gap-2"
        data-testid={`pipeline-${p.id}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`流水线名称 ${p.name}`}
            inputSize="sm"
            className="min-w-[8rem] flex-1"
            value={rename[p.id] ?? p.name}
            onChange={(e) => setRename((cur) => ({ ...cur, [p.id]: e.target.value }))}
          />
          {p.isDefault ? (
            <Badge tone="accent" size="sm">
              默认
            </Badge>
          ) : (
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
          <Button type="button" size="sm" variant="secondary" onClick={() => void renamePipe(p.id)}>
            改名
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid={`pipeline-toggle-${p.id}`}
            aria-expanded={openPipe}
            onClick={() => setExpanded((cur) => (cur === p.id ? null : p.id))}
          >
            {openPipe ? '收起' : '展开'}
          </Button>
        </div>
        {openPipe && (
          <div className="flex flex-col gap-2 border-t border-border pt-2">
            {stages.length === 0 ? (
              <p className="text-caption text-muted">这条流水线还没有阶段。</p>
            ) : (
              stages.map((stage, idx) => {
                const editing = editingStageId === stage.id
                return (
                  <div
                    key={stage.id}
                    className="rounded-lg bg-hover px-3 py-2"
                    data-testid={`stage-row-${stage.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="w-6 text-caption text-faint">{idx + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-body text-fg">
                        {stage.name}
                      </span>
                      <Badge size="sm" tone={stage.kind === 'ai' ? 'info' : 'neutral'}>
                        {STAGE_KIND_LABEL[stage.kind]}
                      </Badge>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`上移 ${stage.name}`}
                        data-testid={`stage-up-${stage.id}`}
                        disabled={idx === 0 || saving}
                        onClick={() => void moveStage(p.id, stage.id, -1)}
                      >
                        <ChevronUp size={14} />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`下移 ${stage.name}`}
                        data-testid={`stage-down-${stage.id}`}
                        disabled={idx === stages.length - 1 || saving}
                        onClick={() => void moveStage(p.id, stage.id, 1)}
                      >
                        <ChevronDown size={14} />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        data-testid={`stage-edit-${stage.id}`}
                        onClick={() =>
                          setEditingStageId((cur) => (cur === stage.id ? null : stage.id))
                        }
                      >
                        {editing ? '收起编辑' : '编辑'}
                      </Button>
                    </div>
                    {editing && (
                      <div className="mt-3">
                        <StageEditor
                          key={`${stage.id}:${dataGen}`}
                          stage={stage}
                          agents={agents}
                          saving={saving}
                          onSave={(patch) => saveStage(stage.id, patch)}
                        />
                      </div>
                    )}
                  </div>
                )
              })
            )}
            <div className="flex flex-wrap items-end gap-2 pt-1">
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
          </div>
        )}
      </Card>
    )
  }

  return (
    <>
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
      <Sheet
        open={open}
        onOpenChange={setOpen}
        side="right"
        srTitle="流水线配置"
        className="w-[36rem] max-w-[96vw]"
      >
        <div
          data-testid="stage-settings"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        >
          <div>
            <h2 className="text-title font-semibold text-fg">流水线配置</h2>
            <p className="mt-1 text-caption text-muted">
              按单据类型分组。默认线决定新建该类型单据时走哪条。阶段顺序用上/下移调整。
            </p>
          </div>
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
        </div>
      </Sheet>
    </>
  )
}
