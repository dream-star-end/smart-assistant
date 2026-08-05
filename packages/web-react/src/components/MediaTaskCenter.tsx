import type { MediaGenerationJob, VideoProject } from '@openclaude/protocol/mediaGeneration'
import {
  Download,
  Film,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
  WandSparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { assertAuthResponseCurrent, bearerHeaders, callWithRefresh } from '../lib/api'
import type { AuthSession } from '../lib/types'
import { Button, Sheet } from './ui'

type JobsPage = { jobs: MediaGenerationJob[]; nextCursor: string | null }
type ProjectsPage = { projects: VideoProject[]; nextCursor: string | null }
type Capability = { available?: boolean; workerReachable?: boolean }

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
    throw new Error(detail?.message || detail?.code || `HTTP ${response.status}`)
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
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>
          {STATUS[job.status]} · {job.phase}
        </span>
        <span className="tabular-nums">
          {job.queuePosition
            ? `前面 ${Math.max(0, job.queuePosition - 1)} 个`
            : determinate
              ? `${job.currentStep ?? 0}/${job.totalSteps}`
              : ''}
        </span>
      </div>
      {ACTIVE.has(job.status) && (
        <div className="h-1.5 overflow-hidden rounded-full bg-hover">
          <div
            className={`h-full rounded-full bg-accent transition-[width] ${determinate ? '' : 'w-1/3 animate-pulse'}`}
            style={determinate ? { width: `${pct}%` } : undefined}
          />
        </div>
      )}
    </div>
  )
}

function JobResult({ job, auth }: { job: MediaGenerationJob; auth: AuthSession | null }) {
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (job.status !== 'completed') return null

  const loadResult = async () => {
    if (!auth || loading) return
    setLoading(true)
    setError(null)
    try {
      const value = await apiCall<{ url: string }>(
        auth,
        `/api/media-generation/jobs/${job.id}/result-ticket`,
        { method: 'POST' },
      )
      setResultUrl(value.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '视频地址获取失败')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="mt-3 space-y-2">
      {resultUrl ? (
        <>
          {/* biome-ignore lint/a11y/useMediaCaption: generated H3 clips do not include a transcript or caption artifact */}
          <video
            className="max-h-64 w-full rounded-xl bg-black"
            controls
            preload="metadata"
            src={resultUrl}
          />
          <a
            className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
            href={resultUrl}
            download
          >
            <Download size={13} /> 下载 MP4
          </a>
        </>
      ) : (
        <Button size="sm" variant="secondary" disabled={loading} onClick={() => void loadResult()}>
          {loading ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}
          播放或下载结果
        </Button>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

export function MediaTaskCenter({
  open,
  auth,
  liveJob,
  onOpenChange,
}: {
  open: boolean
  auth: AuthSession | null
  liveJob: MediaGenerationJob | null
  onOpenChange: (open: boolean) => void
}) {
  const [jobs, setJobs] = useState<MediaGenerationJob[]>([])
  const [projects, setProjects] = useState<VideoProject[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [nextProjectCursor, setNextProjectCursor] = useState<string | null>(null)
  const [capability, setCapability] = useState<Capability | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const identityEpoch = auth?.snapshot().epoch
  const refresh = useCallback(
    async (mode: 'first' | 'jobs' | 'projects' = 'first') => {
      if (!auth) return
      setLoading(true)
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
        setLoading(false)
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
    const timer = window.setInterval(() => void refresh('first'), 5_000)
    return () => window.clearInterval(timer)
  }, [open, hasActive, refresh])

  const mutate = async (path: string, body: object) => {
    if (!auth) return
    setError(null)
    try {
      const value = await apiCall<{ job?: MediaGenerationJob }>(auth, path, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (value.job) setJobs((current) => mergeJobs(current, [value.job!]))
      await refresh('first')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败')
    }
  }

  const standalone = jobs.filter((job) => !job.projectId)
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      srTitle="视频任务中心"
      className="w-[520px] max-w-[94vw] overflow-y-auto"
    >
      <div className="flex min-h-full flex-col p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
              <Film size={19} />
              视频任务
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              任务在后台持续执行，关闭页面也不会中断；长视频按分镜连续生成后再合成。
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={() => void refresh('first')}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
          </Button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-danger/30 bg-danger-soft p-3 text-[12.5px] text-danger">
            {error}
          </div>
        )}
        {capability?.available === false && (
          <div className="mt-6 rounded-2xl border border-border bg-surface p-5 text-sm text-muted">
            本账号暂未开放本地 H3 视频生成。
          </div>
        )}
        {capability?.available && capability.workerReachable === false && (
          <div className="mt-4 rounded-xl border border-warning/30 bg-warning-soft p-3 text-[12.5px] text-warning">
            算力节点暂时失联，已提交的任务和素材不会丢失，恢复连接后可继续处理。
          </div>
        )}

        {projects.length > 0 && (
          <section className="mt-6 space-y-3">
            <h3 className="text-[13px] font-semibold text-fg">长视频项目</h3>
            {projects.map((project) => {
              const compose = project.currentComposeJobId
                ? jobs.find((job) => job.id === project.currentComposeJobId)
                : undefined
              return (
                <article
                  key={project.id}
                  className="rounded-2xl border border-border bg-surface p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-fg">{project.title}</div>
                      <div className="mt-1 text-[12px] text-muted">
                        {
                          project.shots.filter((shot) => shot.activeJob?.status === 'completed')
                            .length
                        }
                        /{project.shots.length} 个分镜 · rev {project.rev}
                      </div>
                    </div>
                    <span className="rounded-full bg-hover px-2 py-1 text-[11px] text-muted">
                      {PROJECT_STATUS[project.status]}
                    </span>
                  </div>
                  <div className="mt-3 space-y-2">
                    {project.shots.map((shot) => (
                      <div key={shot.id} className="rounded-xl bg-bg px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <span className="shrink-0 text-[11px] font-semibold text-faint">
                            #{shot.ordinal + 1}
                          </span>
                          <p className="line-clamp-2 flex-1 text-[12px] leading-relaxed text-fg">
                            {shot.prompt}
                          </p>
                          {shot.stale && project.status !== 'canceled' && (
                            <span className="shrink-0 rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] text-warning">
                              依赖已变
                            </span>
                          )}
                        </div>
                        {shot.activeJob && (
                          <div className="mt-2">
                            <Progress job={shot.activeJob} />
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {shot.stale && project.status !== 'canceled' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                void mutate(
                                  `/api/media-generation/projects/${project.id}/shots/${shot.id}/accept`,
                                  { expectedRev: project.rev },
                                )
                              }
                            >
                              保留旧结果
                            </Button>
                          )}
                          {shot.activeJob && project.status !== 'canceled' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void mutate(
                                  `/api/media-generation/projects/${project.id}/shots/${shot.id}/regenerate`,
                                  { expectedRev: project.rev },
                                )
                              }
                            >
                              <RotateCcw size={12} />
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
                        onClick={() =>
                          void mutate(`/api/media-generation/projects/${project.id}/start`, {
                            expectedRev: project.rev,
                          })
                        }
                      >
                        <WandSparkles size={13} />
                        确认分镜并开始生成
                      </Button>
                    )}
                    {project.status === 'ready' && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void mutate(`/api/media-generation/projects/${project.id}/render`, {
                            expectedRev: project.rev,
                          })
                        }
                      >
                        <WandSparkles size={13} />
                        合成完整视频
                      </Button>
                    )}
                    {['draft', 'generating', 'needs_review', 'ready', 'rendering'].includes(
                      project.status,
                    ) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void mutate(`/api/media-generation/projects/${project.id}/cancel`, {
                            expectedRev: project.rev,
                          })
                        }
                      >
                        <Square size={12} />
                        取消项目
                      </Button>
                    )}
                  </div>
                  {compose && (
                    <div className="mt-3">
                      <Progress job={compose} />
                      <JobResult job={compose} auth={auth} />
                    </div>
                  )}
                </article>
              )
            })}
            {nextProjectCursor && (
              <Button
                className="w-full"
                variant="secondary"
                disabled={loading}
                onClick={() => void refresh('projects')}
              >
                加载更早项目
              </Button>
            )}
          </section>
        )}

        <section className="mt-6 space-y-3">
          <h3 className="text-[13px] font-semibold text-fg">单段视频</h3>
          {standalone.map((job) => (
            <article
              key={job.id}
              className="rounded-2xl border border-border bg-surface p-4 shadow-sm"
            >
              <p className="line-clamp-3 text-[13px] leading-relaxed text-fg">
                {job.prompt || '视频合成'}
              </p>
              <div className="mt-3">
                <Progress job={job} />
              </div>
              {job.errorMessage && (
                <p className="mt-2 text-[12px] text-danger">{job.errorMessage}</p>
              )}
              {ACTIVE.has(job.status) && (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="secondary"
                  onClick={() => void mutate(`/api/media-generation/jobs/${job.id}/cancel`, {})}
                >
                  <Square size={12} />
                  取消
                </Button>
              )}
              <JobResult job={job} auth={auth} />
            </article>
          ))}
          {!loading &&
            standalone.length === 0 &&
            projects.length === 0 &&
            capability?.available !== false && (
              <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted">
                还没有视频任务。直接告诉 Agent 想制作的内容即可。
              </div>
            )}
          {loading && jobs.length === 0 && (
            <div className="flex justify-center py-8 text-muted">
              <LoaderCircle className="animate-spin" />
            </div>
          )}
          {nextCursor && (
            <Button
              className="w-full"
              variant="secondary"
              disabled={loading}
              onClick={() => void refresh('jobs')}
            >
              加载更早任务
            </Button>
          )}
        </section>
      </div>
    </Sheet>
  )
}
