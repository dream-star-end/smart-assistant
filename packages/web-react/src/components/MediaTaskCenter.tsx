import type { MediaGenerationJob, VideoProject } from '@openclaude/protocol/mediaGeneration'
import {
  AlertCircle,
  Check,
  Clapperboard,
  Copy,
  Download,
  Film,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  TriangleAlert,
  WandSparkles,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { assertAuthResponseCurrent, bearerHeaders, callWithRefresh } from '../lib/api'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { Alert, Badge, Button, IconButton, Progress as ProgressBar, Sheet, useConfirm } from './ui'
import { claimInlineVideoSlot, releaseInlineVideoSlot, teardownVideoElement } from './chat/inlineVideoSlot'

type JobsPage = { jobs: MediaGenerationJob[]; nextCursor: string | null }
type ProjectsPage = { projects: VideoProject[]; nextCursor: string | null }
type Capability = { available?: boolean; workerReachable?: boolean }
/** useConfirm 的入参形状(原语没单独导出这个类型)。 */
type ConfirmRequest = Parameters<ReturnType<typeof useConfirm>[0]>[0]

const ACTIVE = new Set(['queued', 'dispatching', 'running', 'reconnecting'])

const STATUS: Record<MediaGenerationJob['status'], string> = {
  queued: '排队中',
  dispatching: '正在传输',
  running: '生成中',
  reconnecting: '正在恢复连接',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

/**
 * 算力节点上报的 phase 是自由字符串(protocol 里就是 Type.String()),此前原样拼在状态后面,
 * 用户看到的是 `denoise_step` / `wait_gpu` / `worker_state_unknown` 这种开发者术语(审计 M-05)。
 * 这里把已知值翻成人话;**未知值不显示**(只留 status),原文保留在 title 里方便排障。
 * 与 status 同义的(queued/completed/failed/canceled)也不重复显示。
 */
const PHASE_LABEL: Record<string, string> = {
  staging: '正在准备素材',
  transferring_inputs: '正在传输素材',
  upload: '正在上传素材',
  wait_gpu: '等待算力',
  sampling: '正在生成画面',
  denoise: '正在生成画面',
  denoise_step: '正在生成画面',
  encoding: '正在编码',
  compose: '正在合成',
  composing: '正在合成',
  rendering: '正在合成',
  result_pending: '正在回传结果',
  worker_retry_proof_pending: '正在确认算力节点状态',
  worker_state_unknown: '正在确认算力节点状态',
  worker_cancel_state_unknown: '正在确认取消结果',
  reconnecting: '正在恢复连接',
}
const PHASE_SAME_AS_STATUS = new Set([
  'queued',
  'dispatching',
  'running',
  'completed',
  'done',
  'failed',
  'canceled',
  'cancelled',
])

export function phaseLabel(job: Pick<MediaGenerationJob, 'status' | 'phase'>): string | null {
  const phase = (job.phase ?? '').trim()
  if (!phase || PHASE_SAME_AS_STATUS.has(phase)) return null
  const label = PHASE_LABEL[phase]
  if (!label) return null
  // 与 status 文案完全相同的不重复。
  return label === STATUS[job.status] ? null : label
}

/**
 * 失败原因:errorCode 翻成可行动的人话,服务端原文(常含 CUDA / worker 主机名)收进「技术详情」。
 * 未知 code 走通用兜底 —— 宁可少说,不把内部术语直接塞给用户。
 */
const ERROR_LABEL: Record<string, string> = {
  worker_lost: '算力节点在生成过程中失联，任务已中断。',
  worker_unreachable: '算力节点暂时不可用，请稍后重试。',
  // 服务端 terminalizeJob 会落的三个内部 code(commercial/media-generation/service.ts)。
  invalid_job_contract: '任务参数无法处理，请重新发起。',
  worker_contract_mismatch: '算力节点返回的结果与任务不一致，任务已中断。',
  media_job_execution_failed: '生成过程中出错，请稍后重试。',
  h3_oom: '显存不足：请缩短视频时长或降低分辨率后重试。',
  oom: '显存不足：请缩短视频时长或降低分辨率后重试。',
  out_of_memory: '显存不足：请缩短视频时长或降低分辨率后重试。',
  timeout: '生成超时，请稍后重试。',
  invalid_input: '输入素材无法处理，请检查后重新提交。',
  content_policy: '内容不符合生成规范，请调整描述后重试。',
  canceled: '任务已取消。',
}

export function failureSummary(job: Pick<MediaGenerationJob, 'errorCode' | 'errorMessage'>): {
  summary: string
  detail: string | null
} | null {
  const code = (job.errorCode ?? '').trim()
  const message = (job.errorMessage ?? '').trim()
  if (!code && !message) return null
  const known = code ? ERROR_LABEL[code.toLowerCase()] : undefined
  const summary = known ?? '生成失败，请稍后重试或换个描述再试。'
  const detail = [code, message].filter(Boolean).join(' · ') || null
  return { summary, detail }
}

/** HTTP 状态 → 用户能理解的一句话;服务端给了 message 就优先用它。 */
function httpFailureMessage(status: number, detail?: { message?: string; code?: string }): string {
  if (detail?.message) return detail.message
  if (status === 401 || status === 403) return '没有权限执行这个操作，请重新登录后再试。'
  if (status === 404) return '任务不存在或已被清理，请刷新列表。'
  if (status === 409) return '任务状态刚刚变化，请刷新后再操作。'
  if (status === 429) return '操作太频繁，请稍后再试。'
  if (status >= 500) return `服务暂时不可用，请稍后重试（${status}）。`
  return detail?.code ? `操作失败（${detail.code}）。` : `操作失败（HTTP ${status}）。`
}

const PROJECT_STATUS: Record<VideoProject['status'], string> = {
  draft: '待生成',
  generating: '生成中',
  needs_review: '需确认衔接',
  ready: '可合成',
  rendering: '合成中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

type StatusBadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
type TaskFilter = 'all' | 'active' | 'completed' | 'issue'

const PROJECT_STATUS_TONE: Record<VideoProject['status'], StatusBadgeTone> = {
  draft: 'neutral',
  generating: 'accent',
  needs_review: 'warning',
  ready: 'info',
  rendering: 'accent',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral',
}

const PROJECT_ICON_BADGE: Record<VideoProject['status'], string> = {
  draft: 'oc-icon-badge',
  generating: 'oc-icon-badge oc-icon-badge-accent',
  needs_review: 'oc-icon-badge oc-icon-badge-warning',
  ready: 'oc-icon-badge oc-icon-badge-info',
  rendering: 'oc-icon-badge oc-icon-badge-accent',
  completed: 'oc-icon-badge oc-icon-badge-success',
  failed: 'oc-icon-badge oc-icon-badge-danger',
  canceled: 'oc-icon-badge',
}

const JOB_STATUS_TONE: Record<MediaGenerationJob['status'], StatusBadgeTone> = {
  queued: 'info',
  dispatching: 'accent',
  running: 'accent',
  reconnecting: 'warning',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral',
}

const ACTIVE_PROJECT_STATUSES = new Set<VideoProject['status']>([
  'draft',
  'generating',
  'needs_review',
  'ready',
  'rendering',
])

function matchesJobFilter(job: MediaGenerationJob, filter: TaskFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE.has(job.status)
  if (filter === 'completed') return job.status === 'completed'
  return job.status === 'failed' || job.status === 'canceled'
}

function matchesProjectFilter(project: VideoProject, filter: TaskFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE_PROJECT_STATUSES.has(project.status)
  if (filter === 'completed') return project.status === 'completed'
  return project.status === 'failed' || project.status === 'canceled'
}

async function apiCall<T>(auth: AuthSession, path: string, init?: RequestInit): Promise<T> {
  const response = await callWithRefresh(auth, (token) =>
    fetch(path, {
      ...init,
      credentials: 'include',
      headers: { ...bearerHeaders(token, init?.body !== undefined), ...init?.headers },
    }),
  )
  assertAuthResponseCurrent(response)
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>
  assertAuthResponseCurrent(response)
  if (!response.ok) {
    const detail = value.error as { message?: string; code?: string } | undefined
    throw new Error(httpFailureMessage(response.status, detail))
  }
  return value as T
}

function mergeJobs(
  current: MediaGenerationJob[],
  incoming: MediaGenerationJob[],
): MediaGenerationJob[] {
  const values = new Map(current.map((job) => [job.id, job]))
  for (const job of incoming) values.set(job.id, job)
  return [...values.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function mergeProjects(current: VideoProject[], incoming: VideoProject[]): VideoProject[] {
  const values = new Map(current.map((project) => [project.id, project]))
  for (const project of incoming) values.set(project.id, project)
  return [...values.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function Progress({ job }: { job: MediaGenerationJob }) {
  const determinate = Boolean(job.totalSteps && job.totalSteps > 0)
  const pct = determinate
    ? Math.min(100, Math.round(((job.currentStep ?? 0) / job.totalSteps!) * 100))
    : 0
  const phase = phaseLabel(job)
  const statusText = phase ? `${STATUS[job.status]} · ${phase}` : STATUS[job.status]
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-meta text-muted">
        {/* 原始 phase 留在 title 里给排障,不进正文(审计 M-05)。 */}
        <Badge tone={JOB_STATUS_TONE[job.status]} size="sm" title={job.phase || undefined}>
          {statusText}
        </Badge>
        <span className="text-caption font-medium tabular-nums text-muted">
          {job.queuePosition
            ? `前面 ${Math.max(0, job.queuePosition - 1)} 个`
            : determinate
              ? `${job.currentStep ?? 0}/${job.totalSteps}`
              : ''}
        </span>
      </div>
      {ACTIVE.has(job.status) &&
        (determinate ? (
          // 有步数 → 原语进度条(role=progressbar + aria-valuenow,读屏能读到进度;审计 M-18)。
          <ProgressBar value={pct} size="sm" tone="brand" aria-label={`${statusText} ${pct}%`} />
        ) : (
          // 无步数时只是一条脉动的装饰条:没有可报的数值,状态由上面那行文字承担,对辅助技术隐藏。
          <div aria-hidden className="oc-surface-recessed h-1.5 overflow-hidden rounded-full">
            <div className="oc-indeterminate-bar h-full w-1/3 rounded-full bg-accent" />
          </div>
        ))}
    </div>
  )
}

/** 失败任务的原因区:一句人话 + 可展开的技术详情。只对 failed 渲染 —— 已取消的任务状态里已经说了。 */
function FailureNote({ job }: { job: MediaGenerationJob }) {
  if (job.status !== 'failed') return null
  const failure = failureSummary(job)
  if (!failure) return null
  return (
    <div className="oc-callout oc-callout-danger mt-2.5 rounded-xl px-3 py-2.5 text-meta text-danger">
      <div className="flex items-start gap-2">
        <span
          className="oc-icon-badge oc-icon-badge-danger mt-0.5 size-5 shrink-0 rounded-md"
          aria-hidden="true"
        >
          <AlertCircle size={12} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-relaxed">{failure.summary}</p>
          {failure.detail && (
            <details className="mt-1.5 text-caption text-muted">
              {/* 触屏 44px 命中(a11y-B media#2):summary 原本只有 16px 行高。 */}
              <summary className="cursor-pointer select-none font-medium text-muted hover:text-fg [@media(hover:none)]:py-3.5">
                技术详情
              </summary>
              <p className="oc-surface-recessed mt-1.5 break-all rounded-lg px-2.5 py-2 font-mono text-micro text-muted">
                {failure.detail}
              </p>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 后端没有 jobs/:id/retry。宿主负责验证原会话并预填继续草稿；
 * 独立挂载没有会话接续能力时，仅允许复制提示词。
 */
function CopyPromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_800)
    } catch {
      // 剪贴板不可用(非安全上下文 / 权限被拒)时静默;按钮本身不会误报成功。
    }
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      className="oc-btn-tactile oc-btn-secondary-craft"
      onClick={() => void copy()}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? '已复制' : '复制提示词'}
    </Button>
  )
}

/** Keep the failed job's original session identity through the explicit Continue. */
function ReusePromptButton({ job, onReuse }: { job: MediaGenerationJob; onReuse: (job: MediaGenerationJob) => void }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className="oc-btn-tactile oc-btn-secondary-craft"
      onClick={() => onReuse(job)}
    >
      <RotateCcw size={12} />
      继续
    </Button>
  )
}

function JobResult({ job, auth }: { job: MediaGenerationJob; auth: AuthSession | null }) {
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const slotIdRef = useRef<symbol>(Symbol('media-task-video'))
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const mountedRef = useRef(true)
  const requestEpochRef = useRef(0)

  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    if (!node && videoElRef.current) teardownVideoElement(videoElRef.current)
    videoElRef.current = node
  }, [])

  const collapseResult = useCallback(() => {
    requestEpochRef.current += 1
    teardownVideoElement(videoElRef.current)
    releaseInlineVideoSlot(slotIdRef.current)
    setResultUrl(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestEpochRef.current += 1
      teardownVideoElement(videoElRef.current)
      releaseInlineVideoSlot(slotIdRef.current)
    }
  }, [])

  if (job.status !== 'completed') return null

  const loadResult = async () => {
    if (!auth || loading) return
    const myEpoch = ++requestEpochRef.current
    setLoading(true)
    setError(null)
    try {
      const value = await apiCall<{ url: string }>(
        auth,
        `/api/media-generation/jobs/${job.id}/result-ticket`,
        { method: 'POST' },
      )
      if (!mountedRef.current || requestEpochRef.current !== myEpoch) return
      claimInlineVideoSlot(slotIdRef.current, collapseResult)
      setResultUrl(value.url)
    } catch (cause) {
      if (!mountedRef.current || requestEpochRef.current !== myEpoch) return
      setError(cause instanceof Error ? cause.message : '视频地址获取失败')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }
  return (
    <div className="mt-3 space-y-2.5">
      {resultUrl ? (
        <>
          <div className="overflow-hidden rounded-xl border border-border bg-black shadow-soft">
            <video
              ref={setVideoRef}
              className="max-h-64 w-full bg-black"
              controls
              playsInline
              {...({ 'webkit-playsinline': 'true', 'x5-playsinline': 'true' } as Record<string, string>)}
              preload="metadata"
              src={resultUrl}
              onEnded={collapseResult}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              className="oc-btn-tactile oc-btn-secondary-craft inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-meta font-medium text-accent transition-colors hover:border-border-strong hover:bg-hover"
              href={resultUrl}
              download
            >
              <Download size={13} /> 下载 MP4
            </a>
            <Button size="sm" variant="ghost" className="oc-btn-tactile" onClick={collapseResult}>
              收起预览
            </Button>
          </div>
        </>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="oc-btn-tactile oc-btn-secondary-craft"
          disabled={loading}
          onClick={() => void loadResult()}
        >
          {loading ? <LoaderCircle size={13} className="animate-spin" /> : <Play size={13} />}
          播放或下载结果
        </Button>
      )}
      {error && <p className="text-meta text-danger">{error}</p>}
    </div>
  )
}

export function MediaTaskCenter({
  open,
  auth,
  liveJob,
  onOpenChange,
  onReusePrompt,
}: {
  open: boolean
  auth: AuthSession | null
  liveJob: MediaGenerationJob | null
  onOpenChange: (open: boolean) => void
  /**
   * 宿主验证 job.sessionId 后回原会话，预填继续草稿；不自动发送。
   * 不传则退回「复制提示词」。
   */
  onReusePrompt?: (job: MediaGenerationJob) => void
}) {
  const [jobs, setJobs] = useState<MediaGenerationJob[]>([])
  const [projects, setProjects] = useState<VideoProject[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [nextProjectCursor, setNextProjectCursor] = useState<string | null>(null)
  const [capability, setCapability] = useState<Capability | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 正在飞的那条写操作的 path:对应按钮转圈,其余写按钮禁用(审计 M-06/M-16)。
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const pendingRef = useRef(false)
  const [confirm, confirmEl] = useConfirm()

  const identityEpoch = auth?.snapshot().epoch
  const refresh = useCallback(
    async (mode: 'first' | 'jobs' | 'projects' = 'first', options?: { silent?: boolean }) => {
      if (!auth) return
      // silent = 后台轮询 / 写操作后的回读:不碰 loading,「刷新」「加载更早」不再每 5 秒抖一下(审计 M-16)。
      const silent = options?.silent === true
      if (!silent) setLoading(true)
      setError(null)
      try {
        const caps =
          capability ?? (await apiCall<Capability>(auth, '/api/media-generation/capabilities'))
        setCapability(caps)
        if (caps.available !== true) {
          setJobs([])
          setProjects([])
          setNextCursor(null)
          setNextProjectCursor(null)
          return
        }
        const jobCursor =
          mode === 'jobs' && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''
        const projectCursor =
          mode === 'projects' && nextProjectCursor
            ? `?cursor=${encodeURIComponent(nextProjectCursor)}`
            : ''
        const [page, projectResponse] = await Promise.all([
          apiCall<JobsPage>(auth, `/api/media-generation/jobs${jobCursor}`),
          apiCall<ProjectsPage>(auth, `/api/media-generation/projects${projectCursor}`),
        ])
        setJobs((current) => mergeJobs(current, page.jobs))
        setProjects((current) => mergeProjects(current, projectResponse.projects))
        if (mode !== 'projects') setNextCursor(page.nextCursor)
        if (mode !== 'jobs') setNextProjectCursor(projectResponse.nextCursor)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '加载视频任务失败')
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [auth, capability, nextCursor, nextProjectCursor],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: identity epoch is the intentional reset signal even though the reset body is constant
  useEffect(() => {
    setJobs([])
    setProjects([])
    setNextCursor(null)
    setNextProjectCursor(null)
    setCapability(null)
    setError(null)
    setFilter('all')
  }, [identityEpoch])

  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor/capability changes must not restart the first-page load; identityEpoch tracks auth changes
  useEffect(() => {
    if (!open || identityEpoch === undefined) return
    void refresh('first')
  }, [open, identityEpoch])

  useEffect(() => {
    if (!liveJob) return
    setJobs((current) => mergeJobs(current, [liveJob]))
  }, [liveJob])

  const hasActive = useMemo(
    () =>
      jobs.some((job) => ACTIVE.has(job.status)) ||
      projects.some((project) => ['generating', 'rendering'].includes(project.status)),
    [jobs, projects],
  )
  useEffect(() => {
    if (!open || !hasActive) return
    const timer = window.setInterval(() => void refresh('first', { silent: true }), 5_000)
    return () => window.clearInterval(timer)
  }, [open, hasActive, refresh])

  /**
   * 写操作统一入口。带 confirmation 的先弹确认层(取消项目 / 取消任务 / 重做都不可逆或要花算力,
   * 审计 M-06);进行中用 ref 挡掉重复点击(双击「取消项目」曾发两次、第二次以 expectedRev
   * 不匹配报红,审计 M-16)。
   */
  const mutate = async (path: string, body: object, confirmation?: ConfirmRequest) => {
    if (!auth || pendingRef.current) return
    if (confirmation && (await confirm(confirmation)) !== true) return
    if (pendingRef.current) return
    pendingRef.current = true
    setPendingPath(path)
    setError(null)
    try {
      const value = await apiCall<{ job?: MediaGenerationJob }>(auth, path, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (value.job) setJobs((current) => mergeJobs(current, [value.job!]))
      await refresh('first', { silent: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      pendingRef.current = false
      setPendingPath(null)
    }
  }
  const busy = pendingPath !== null
  /** 写按钮的图标位:自己在飞就转圈。 */
  const actionIcon = (path: string, icon: ReactNode) =>
    pendingPath === path ? <LoaderCircle size={12} className="animate-spin" /> : icon

  const standalone = jobs.filter((job) => !job.projectId)
  const filterCounts = useMemo(
    () => ({
      all: projects.length + standalone.length,
      active:
        projects.filter((project) => matchesProjectFilter(project, 'active')).length +
        standalone.filter((job) => matchesJobFilter(job, 'active')).length,
      completed:
        projects.filter((project) => matchesProjectFilter(project, 'completed')).length +
        standalone.filter((job) => matchesJobFilter(job, 'completed')).length,
      issue:
        projects.filter((project) => matchesProjectFilter(project, 'issue')).length +
        standalone.filter((job) => matchesJobFilter(job, 'issue')).length,
    }),
    [projects, standalone],
  )
  const visibleProjects = useMemo(
    () => (filter === 'all' ? projects : projects.filter((project) => matchesProjectFilter(project, filter))),
    [projects, filter],
  )
  const visibleStandalone = useMemo(
    () => (filter === 'all' ? standalone : standalone.filter((job) => matchesJobFilter(job, filter))),
    [standalone, filter],
  )
  const showFilterBar =
    capability?.available !== false && (projects.length > 0 || standalone.length > 0)
  // 「单段视频」标题只在有内容、或空态卡片要挂在它下面时出现;账号未开放 / 只有项目时不悬空标题(审计 M-17)。
  const showEmpty =
    !loading && standalone.length === 0 && projects.length === 0 && capability?.available !== false
  const showFilteredEmpty =
    filter !== 'all' && visibleProjects.length === 0 && visibleStandalone.length === 0 && !showEmpty
  const showStandaloneHeading = visibleStandalone.length > 0 || showEmpty
  const filterItems: { id: TaskFilter; label: string; count: number }[] = [
    { id: 'all', label: '全部', count: filterCounts.all },
    { id: 'active', label: '进行中', count: filterCounts.active },
    { id: 'completed', label: '已完成', count: filterCounts.completed },
    { id: 'issue', label: '异常', count: filterCounts.issue },
  ]

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      srTitle="视频任务中心"
      className="oc-surface-popover w-[520px] max-w-[94vw]"
    >
      {/* 头部固定、正文滚动(a11y-B media#1):Radix FocusScope 在末尾 Tab 回绕时用 focus({preventScroll})
          落回「刷新」,若 header 随整个抽屉一起滚出视口,焦点就看不见。结构同 Modal:header shrink-0,
          滚动只发生在 body。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="oc-surface-glass shrink-0 border-x-0 border-t-0 border-b border-border/80 px-5 pb-3.5 pt-4 shadow-none">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span
                className="oc-icon-badge oc-icon-badge-accent mt-0.5 size-8 shrink-0 rounded-xl"
                aria-hidden="true"
              >
                <Film size={16} strokeWidth={1.9} />
              </span>
              <div className="min-w-0">
                <h2 className="text-title font-semibold tracking-tight text-fg">视频任务</h2>
                <p className="mt-0.5 text-meta leading-relaxed text-muted">
                  任务在后台持续执行，关闭页面也不会中断；长视频按分镜连续生成后再合成。
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                className="oc-btn-tactile oc-btn-secondary-craft"
                disabled={loading}
                onClick={() => void refresh('first')}
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
              </Button>
              {/* 抽屉原语不带关闭钮;窄屏遮罩只剩 6vw,没有它几乎关不掉(审计 M-04)。 */}
              <IconButton
                aria-label="关闭视频任务"
                size="lg"
                className="oc-btn-tactile"
                onClick={() => onOpenChange(false)}
              >
                <X size={18} />
              </IconButton>
            </div>
          </div>

          {showFilterBar && (
            <div
              role="group"
              aria-label="任务状态筛选"
              className="oc-surface-recessed mt-3 grid grid-cols-4 gap-1 rounded-xl p-1"
            >
              {filterItems.map((item) => {
                const active = filter === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(item.id)}
                    className={cn(
                      'inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-caption font-medium outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11',
                      active
                        ? 'bg-surface text-fg shadow-soft'
                        : 'text-muted hover:text-fg',
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="text-micro tabular-nums text-faint">{item.count}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 正文滚动容器:列表里全是可聚焦的按钮,Tab 即可带动滚动;header 不在这里,回绕时始终可见。 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {error && (
          <Alert
            tone="danger"
            density="compact"
            className="oc-callout mt-4 rounded-xl"
            icon={<AlertCircle size={15} />}
          >
            {error}
          </Alert>
        )}
        {capability?.available === false && (
          <div className="oc-callout mt-6 flex items-start gap-3 rounded-2xl p-5 text-sm text-muted">
            <span className="oc-icon-badge size-9 shrink-0 rounded-xl" aria-hidden="true">
              <Film size={16} strokeWidth={1.8} />
            </span>
            <p className="pt-1 leading-relaxed">本账号暂未开放本地 H3 视频生成。</p>
          </div>
        )}
        {capability?.available && capability.workerReachable === false && (
          // <output> 自带 role=status:算力失联是会自己恢复的状态提示,读屏该被告知但不必打断(审计 M-18)。
          <output className="oc-callout oc-callout-warning mt-4 flex items-start gap-2.5 rounded-xl p-3 text-meta text-warning">
            <span
              className="oc-icon-badge oc-icon-badge-warning mt-0.5 size-6 shrink-0 rounded-md"
              aria-hidden="true"
            >
              <TriangleAlert size={13} strokeWidth={2} />
            </span>
            <span className="leading-relaxed">
              算力节点暂时失联，已提交的任务和素材不会丢失，恢复连接后可继续处理。
            </span>
          </output>
        )}

        {showFilteredEmpty && (
          <div className="oc-surface-card mt-6 flex flex-col items-center gap-3 rounded-2xl p-8 text-center">
            <span className="oc-icon-badge size-10 rounded-xl" aria-hidden="true">
              <Film size={18} strokeWidth={1.8} />
            </span>
            <p className="text-body text-muted">当前筛选下暂无匹配任务。</p>
            <Button
              size="sm"
              variant="secondary"
              className="oc-btn-tactile oc-btn-secondary-craft"
              onClick={() => setFilter('all')}
            >
              查看全部
            </Button>
          </div>
        )}

        {visibleProjects.length > 0 && (
          <section className="mt-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-body font-semibold text-fg">长视频项目</h3>
              <span className="text-caption tabular-nums text-faint">
                {visibleProjects.length} 项
              </span>
            </div>
            {visibleProjects.map((project) => {
              const compose = project.currentComposeJobId
                ? jobs.find((job) => job.id === project.currentComposeJobId)
                : undefined
              return (
                <article
                  key={project.id}
                  className="oc-surface-card oc-surface-card-hover rounded-2xl p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <span
                        className={cn(
                          PROJECT_ICON_BADGE[project.status],
                          'mt-0.5 size-7 shrink-0 rounded-lg',
                        )}
                        aria-hidden="true"
                      >
                        <Clapperboard size={14} strokeWidth={1.9} />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-fg">{project.title}</div>
                        {/* rev 是并发控制用的内部版本号,不进正文;留在 title 里给排障(审计 M-05)。 */}
                        <div
                          className="mt-0.5 text-meta tabular-nums text-muted"
                          title={`第 ${project.rev} 版`}
                        >
                          {
                            project.shots.filter((shot) => shot.activeJob?.status === 'completed')
                              .length
                          }
                          /{project.shots.length} 个分镜
                        </div>
                      </div>
                    </div>
                    <Badge tone={PROJECT_STATUS_TONE[project.status]} size="sm">
                      {PROJECT_STATUS[project.status]}
                    </Badge>
                  </div>
                  <div className="mt-3 space-y-2">
                    {project.shots.map((shot) => (
                      <div key={shot.id} className="oc-surface-recessed rounded-xl px-3.5 py-2.5">
                        <div className="flex items-start gap-2">
                          <span className="oc-kbd shrink-0 font-mono text-micro font-semibold text-muted">
                            #{shot.ordinal + 1}
                          </span>
                          <p className="line-clamp-2 flex-1 text-meta leading-relaxed text-fg">
                            {shot.prompt}
                          </p>
                          {shot.stale && project.status !== 'canceled' && (
                            <Badge tone="warning" size="sm">
                              依赖已变
                            </Badge>
                          )}
                        </div>
                        {shot.activeJob && (
                          <div className="mt-2">
                            <Progress job={shot.activeJob} />
                            <FailureNote job={shot.activeJob} />
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {shot.stale && project.status !== 'canceled' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              className="oc-btn-tactile oc-btn-secondary-craft"
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  `/api/media-generation/projects/${project.id}/shots/${shot.id}/accept`,
                                  { expectedRev: project.rev },
                                )
                              }
                            >
                              {actionIcon(
                                `/api/media-generation/projects/${project.id}/shots/${shot.id}/accept`,
                                null,
                              )}
                              保留旧结果
                            </Button>
                          )}
                          {shot.activeJob && project.status !== 'canceled' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="oc-btn-tactile"
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  `/api/media-generation/projects/${project.id}/shots/${shot.id}/regenerate`,
                                  { expectedRev: project.rev },
                                  {
                                    title: `重新生成第 ${shot.ordinal + 1} 镜？`,
                                    body: '会重新占用算力，并用新结果覆盖这一镜现有的画面；依赖它的后续分镜可能需要重新确认。',
                                    confirmText: '重做这一镜',
                                    cancelText: '再想想',
                                  },
                                )
                              }
                            >
                              {actionIcon(
                                `/api/media-generation/projects/${project.id}/shots/${shot.id}/regenerate`,
                                <RotateCcw size={12} />,
                              )}
                              重做
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {project.status === 'draft' && (
                      <Button
                        size="sm"
                        variant="primary"
                        className="oc-btn-tactile oc-btn-primary-craft"
                        disabled={busy}
                        onClick={() =>
                          void mutate(`/api/media-generation/projects/${project.id}/start`, {
                            expectedRev: project.rev,
                          })
                        }
                      >
                        {actionIcon(
                          `/api/media-generation/projects/${project.id}/start`,
                          <WandSparkles size={13} />,
                        )}
                        确认分镜并开始生成
                      </Button>
                    )}
                    {project.status === 'ready' && (
                      <Button
                        size="sm"
                        variant="primary"
                        className="oc-btn-tactile oc-btn-primary-craft"
                        disabled={busy}
                        onClick={() =>
                          void mutate(`/api/media-generation/projects/${project.id}/render`, {
                            expectedRev: project.rev,
                          })
                        }
                      >
                        {actionIcon(
                          `/api/media-generation/projects/${project.id}/render`,
                          <WandSparkles size={13} />,
                        )}
                        合成完整视频
                      </Button>
                    )}
                    {['draft', 'generating', 'needs_review', 'ready', 'rendering'].includes(
                      project.status,
                    ) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="oc-btn-tactile oc-btn-secondary-craft"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/api/media-generation/projects/${project.id}/cancel`,
                            { expectedRev: project.rev },
                            {
                              title: '取消这个长视频项目？',
                              body: '正在生成的分镜会立即停止，已经生成完的画面会保留；项目取消后不能恢复。',
                              confirmText: '取消项目',
                              cancelText: '再想想',
                              danger: true,
                            },
                          )
                        }
                      >
                        {actionIcon(
                          `/api/media-generation/projects/${project.id}/cancel`,
                          <Square size={12} />,
                        )}
                        取消项目
                      </Button>
                    )}
                  </div>
                  {compose && (
                    <div className="oc-surface-recessed mt-3 rounded-xl px-3.5 py-3">
                      <Progress job={compose} />
                      <FailureNote job={compose} />
                      <JobResult job={compose} auth={auth} />
                    </div>
                  )}
                </article>
              )
            })}
            {nextProjectCursor && (
              <Button
                className="oc-btn-tactile oc-btn-secondary-craft w-full"
                variant="secondary"
                disabled={loading}
                onClick={() => void refresh('projects')}
              >
                加载更早项目
              </Button>
            )}
          </section>
        )}

        <section className="mt-5 space-y-3">
          {showStandaloneHeading && (
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-body font-semibold text-fg">单段视频</h3>
              {visibleStandalone.length > 0 && (
                <span className="text-caption tabular-nums text-faint">
                  {visibleStandalone.length} 项
                </span>
              )}
            </div>
          )}
          {visibleStandalone.map((job) => (
            <article
              key={job.id}
              className="oc-surface-card oc-surface-card-hover rounded-2xl p-4"
            >
              <p className="line-clamp-3 text-body leading-relaxed text-fg">
                {job.prompt || '视频合成'}
              </p>
              <div className="oc-surface-recessed mt-3 rounded-xl px-3 py-2.5">
                <Progress job={job} />
              </div>
              <FailureNote job={job} />
              {job.status === 'failed' && job.prompt && (
                <div className="mt-3">
                  {onReusePrompt ? (
                    <ReusePromptButton job={job} onReuse={onReusePrompt} />
                  ) : (
                    <CopyPromptButton prompt={job.prompt} />
                  )}
                </div>
              )}
              {ACTIVE.has(job.status) && (
                <Button
                  className="oc-btn-tactile oc-btn-secondary-craft mt-3"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `/api/media-generation/jobs/${job.id}/cancel`,
                      {},
                      {
                        title: '取消这个视频任务？',
                        body: '生成会立即停止，取消后不能恢复；需要的话可以回到对话里重新发起。',
                        confirmText: '取消任务',
                        cancelText: '再想想',
                        danger: true,
                      },
                    )
                  }
                >
                  {actionIcon(`/api/media-generation/jobs/${job.id}/cancel`, <Square size={12} />)}
                  取消
                </Button>
              )}
              <JobResult job={job} auth={auth} />
            </article>
          ))}
          {showEmpty && (
            <div className="oc-surface-card rounded-2xl border-dashed p-8 text-center">
              <span
                className="oc-icon-badge oc-icon-badge-accent mx-auto mb-3 size-11 rounded-xl"
                aria-hidden="true"
              >
                <Film size={20} strokeWidth={1.8} />
              </span>
              <p className="text-body leading-relaxed text-muted">
                还没有视频任务。直接告诉 Agent 想制作的内容即可。
              </p>
            </div>
          )}
          {loading && jobs.length === 0 && (
            <output className="flex justify-center py-8 text-muted" aria-label="正在加载视频任务">
              <LoaderCircle className="animate-spin" />
            </output>
          )}
          {nextCursor && (
            <Button
              className="oc-btn-tactile oc-btn-secondary-craft w-full"
              variant="secondary"
              disabled={loading}
              onClick={() => void refresh('jobs')}
            >
              加载更早任务
            </Button>
          )}
        </section>
        </div>
      </div>
      {confirmEl}
    </Sheet>
  )
}
