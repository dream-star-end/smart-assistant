import '@testing-library/jest-dom/vitest'
import type { MediaGenerationJob, VideoProject } from '@openclaude/protocol/mediaGeneration'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../lib/authSession'

vi.mock('../lib/api', () => ({
  callWithRefresh: async (_auth: unknown, call: (token: string) => Promise<Response>) =>
    call('token'),
  bearerHeaders: () => ({ Authorization: 'Bearer token' }),
  assertAuthResponseCurrent: () => {},
}))

import { MediaTaskCenter, failureSummary, phaseLabel } from './MediaTaskCenter'

/** 危险操作先弹确认层(M-06):在指定标题的对话框里点某个按钮。 */
async function confirmIn(dialogName: string, action: string | RegExp) {
  const dialog = await screen.findByRole('dialog', { name: dialogName })
  fireEvent.click(within(dialog).getByRole('button', { name: action }))
}

const auth = createMemoryAuthSession(() => {}, 'token')

function job(id: string, over: Partial<MediaGenerationJob> = {}): MediaGenerationJob {
  return {
    id,
    requestId: `request-${id}`,
    kind: 'h3_generate',
    resourceClass: 'gpu-h3',
    status: 'queued',
    phase: 'queued',
    prompt: `任务 ${id}`,
    sessionId: null,
    projectId: null,
    projectShotId: null,
    currentStep: null,
    totalSteps: 20,
    queuePosition: 2,
    resultUrl: null,
    resultSha256: null,
    resultSize: null,
    errorCode: null,
    errorMessage: null,
    createdAt: `2026-08-05T00:00:0${id}.000Z`,
    updatedAt: `2026-08-05T00:00:0${id}.000Z`,
    ...over,
  }
}

function project(id: string, over: Partial<VideoProject> = {}): VideoProject {
  const active = job(`${id}-job`, {
    projectId: id,
    projectShotId: `${id}-shot`,
    status: 'completed',
    phase: 'completed',
    queuePosition: null,
  })
  return {
    id,
    title: `项目 ${id}`,
    rev: 2,
    status: 'needs_review',
    currentComposeJobId: null,
    shots: [
      {
        id: `${id}-shot`,
        ordinal: 0,
        prompt: `分镜 ${id}`,
        durationSeconds: 10,
        activeJobId: active.id,
        activeJob: active,
        stale: true,
      },
    ],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: `2026-08-05T00:00:0${id}.000Z`,
    ...over,
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: true })
      if (url.includes('/jobs?cursor=jobs-next'))
        return response({ jobs: [job('1')], nextCursor: null })
      if (url.endsWith('/jobs')) return response({ jobs: [job('2')], nextCursor: 'jobs-next' })
      if (url.includes('/projects?cursor=projects-next')) {
        return response({
          projects: [project('1', { status: 'ready', shots: [] })],
          nextCursor: null,
        })
      }
      if (url.endsWith('/projects'))
        return response({ projects: [project('2')], nextCursor: 'projects-next' })
      if (init?.method === 'POST') return response({ ok: true })
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('MediaTaskCenter', () => {
  test('keeps durable jobs visible, merges live updates, and paginates jobs and projects independently', async () => {
    const view = render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    expect(await screen.findByText('任务 2')).toBeInTheDocument()
    expect(screen.getByText('需确认衔接')).toBeInTheDocument()
    expect(screen.getByText('依赖已变')).toBeInTheDocument()
    expect(screen.getByText('前面 1 个')).toBeInTheDocument()

    view.rerender(
      <MediaTaskCenter
        open
        auth={auth}
        liveJob={job('3', {
          status: 'running',
          phase: 'sampling',
          currentStep: 6,
          queuePosition: null,
        })}
        onOpenChange={() => {}}
      />,
    )
    expect(screen.getByText('任务 3')).toBeInTheDocument()
    expect(screen.getByText('6/20')).toBeInTheDocument()
    // phase 翻成人话并拼在状态后(M-05);有步数的进度条走原语,读屏能读到百分比(M-18)。
    expect(screen.getByText('生成中 · 正在生成画面')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '生成中 · 正在生成画面 30%' })).toHaveAttribute(
      'aria-valuenow',
      '30',
    )

    fireEvent.click(screen.getByRole('button', { name: '加载更早任务' }))
    expect(await screen.findByText('任务 1')).toBeInTheDocument()
    expect(screen.getByText('任务 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '加载更早项目' }))
    expect(await screen.findByText('项目 1')).toBeInTheDocument()
    expect(screen.getByText('项目 2')).toBeInTheDocument()
  })

  test('stale acceptance, regeneration, cancellation and render send revision-CAS mutations', async () => {
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    await screen.findByText('项目 2')
    fireEvent.click(screen.getByRole('button', { name: '保留旧结果' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/media-generation/projects/2/shots/2-shot/accept',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRev: 2 }) }),
      ),
    )
    // 写操作在飞时其余写按钮禁用(M-16),等它落地再点下一个。
    await waitFor(() => expect(screen.getByRole('button', { name: /重做/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /重做/ }))
    await confirmIn('重新生成第 1 镜？', '重做这一镜')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/media-generation/projects/2/shots/2-shot/regenerate',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRev: 2 }) }),
      ),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /取消项目/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /取消项目/ }))
    await confirmIn('取消这个长视频项目？', '取消项目')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/media-generation/projects/2/cancel',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRev: 2 }) }),
      ),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '加载更早项目' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '加载更早项目' }))
    const renderButton = await screen.findByRole('button', { name: /合成完整视频/ })
    fireEvent.click(renderButton)
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/media-generation/projects/1/render',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRev: 2 }) }),
      ),
    )
  })

  test('a draft stays idle until the user explicitly confirms the storyboard', async () => {
    const draft = project('draft', {
      rev: 1,
      status: 'draft',
      shots: [
        {
          id: 'draft-shot',
          ordinal: 0,
          prompt: '等待确认的分镜',
          durationSeconds: 10,
          activeJobId: null,
          activeJob: null,
          stale: false,
        },
      ],
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: true })
      if (url.endsWith('/jobs')) return response({ jobs: [], nextCursor: null })
      if (url.endsWith('/projects')) return response({ projects: [draft], nextCursor: null })
      if (init?.method === 'POST') return response({ project: draft })
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    await screen.findByText('等待确认的分镜')
    fireEvent.click(screen.getByRole('button', { name: '确认分镜并开始生成' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/media-generation/projects/draft/start',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRev: 1 }) }),
      ),
    )
  })

  test('an unavailable account stops after capabilities and shows a friendly rollout message', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: false })
      throw new Error(`allowlist-denied UI must not fetch protected history: ${url}`)
    })
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    expect(await screen.findByText('本账号暂未开放本地 H3 视频生成。')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
    // 未开放时不再悬着一个空的「单段视频」标题(M-17)。
    expect(screen.queryByText('单段视频')).not.toBeInTheDocument()
  })

  test('the drawer has its own close button (mobile overlay is too thin to rely on)', async () => {
    const onOpenChange = vi.fn()
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={onOpenChange} />)
    await screen.findByText('任务 2')
    fireEvent.click(screen.getByRole('button', { name: '关闭视频任务' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('phase / error copy is translated for users and raw values stay in tooling slots', async () => {
    const unknownPhase = job('u', {
      status: 'running',
      phase: 'worker_state_flux',
      queuePosition: null,
    })
    const failed = job('f', {
      status: 'failed',
      phase: 'upload',
      queuePosition: null,
      errorCode: 'H3_OOM',
      errorMessage: 'CUDA out of memory while allocating 2.1 GiB (worker gpu-h3-02)',
      prompt: '一只在雪地里奔跑的柴犬',
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: true })
      if (url.endsWith('/jobs')) return response({ jobs: [unknownPhase, failed], nextCursor: null })
      if (url.endsWith('/projects')) return response({ projects: [project('p')], nextCursor: null })
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    await screen.findByText('一只在雪地里奔跑的柴犬')
    // 未知 phase 不进正文,只留在 title 里。
    expect(screen.getByTitle('worker_state_flux')).toHaveTextContent(/^生成中$/)
    // 失败原因先给人话,服务端原文收进「技术详情」。
    expect(screen.getByText('显存不足：请缩短视频时长或降低分辨率后重试。')).toBeInTheDocument()
    expect(screen.getByText('技术详情')).toBeInTheDocument()
    expect(
      screen.getByText('H3_OOM · CUDA out of memory while allocating 2.1 GiB (worker gpu-h3-02)'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /复制提示词/ })).toBeInTheDocument()
    // 项目行不再展示 rev,只留 title。
    expect(screen.queryByText(/rev 2/)).not.toBeInTheDocument()
    expect(screen.getByTitle('第 2 版')).toHaveTextContent('1/1 个分镜')
  })

  test('failed job offers 重新发起 when the host wires onReusePrompt (M-17 / X-M4), copy fallback disappears', async () => {
    const failed = job('f', {
      status: 'failed',
      phase: 'upload',
      queuePosition: null,
      errorCode: 'H3_OOM',
      errorMessage: 'CUDA out of memory',
      prompt: '一只在雪地里奔跑的柴犬',
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: true })
      if (url.endsWith('/jobs')) return response({ jobs: [failed], nextCursor: null })
      if (url.endsWith('/projects')) return response({ projects: [], nextCursor: null })
      throw new Error(`unexpected fetch ${url}`)
    })
    const onReusePrompt = vi.fn()
    render(
      <MediaTaskCenter
        open
        auth={auth}
        liveJob={null}
        onOpenChange={() => {}}
        onReusePrompt={onReusePrompt}
      />,
    )
    await screen.findByText('一只在雪地里奔跑的柴犬')
    expect(screen.queryByRole('button', { name: /复制提示词/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新发起' }))
    expect(onReusePrompt).toHaveBeenCalledTimes(1)
    expect(onReusePrompt).toHaveBeenCalledWith('一只在雪地里奔跑的柴犬')
  })

  test('the standalone heading is hidden when only projects exist', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: true })
      if (url.endsWith('/jobs')) return response({ jobs: [], nextCursor: null })
      if (url.endsWith('/projects')) return response({ projects: [project('p')], nextCursor: null })
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    await screen.findByText('项目 p')
    expect(screen.queryByText('单段视频')).not.toBeInTheDocument()
    expect(screen.queryByText(/还没有视频任务/)).not.toBeInTheDocument()
  })

  test('cancelling a job asks first, "再想想" sends nothing, and a confirmed action is sent once', async () => {
    const running = job('r', { status: 'running', phase: 'sampling', queuePosition: null })
    let releasePost: (() => void) | null = null
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: true })
      if (url.endsWith('/jobs')) return response({ jobs: [running], nextCursor: null })
      if (url.endsWith('/projects')) return response({ projects: [], nextCursor: null })
      if (init?.method === 'POST') {
        await new Promise<void>((resolve) => {
          releasePost = resolve
        })
        return response({ ok: true })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    const cancel = await screen.findByRole('button', { name: /取消/ })
    fireEvent.click(cancel)
    await confirmIn('取消这个视频任务？', '再想想')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '取消这个视频任务？' })).not.toBeInTheDocument(),
    )
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/media-generation/jobs/r/cancel',
      expect.objectContaining({ method: 'POST' }),
    )

    fireEvent.click(screen.getByRole('button', { name: /取消/ }))
    await confirmIn('取消这个视频任务？', '取消任务')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/media-generation/jobs/r/cancel',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    // 请求在飞:按钮禁用、再点不会重复发(M-16)。
    const inflight = screen.getByRole('button', { name: /取消/ })
    expect(inflight).toBeDisabled()
    fireEvent.click(inflight)
    const cancelCalls = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url) === '/api/media-generation/jobs/r/cancel').length
    expect(cancelCalls()).toBe(1)
    await act(async () => {
      releasePost?.()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /取消/ })).toBeEnabled())
    expect(cancelCalls()).toBe(1)
  })

  test('background polling does not toggle the refresh button into its loading state', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    await screen.findByText('任务 2') // queued → 有活跃任务 → 挂上 5s 轮询
    // testing-library 的 waitFor 自己也用 setInterval 轮询,按 5s 这个间隔认出组件挂的那一个。
    const polls = () => setIntervalSpy.mock.calls.filter(([, ms]) => ms === 5_000)
    await waitFor(() => expect(polls().length).toBeGreaterThan(0))
    const tick = polls().at(-1)?.[0] as () => void
    const releases: Array<() => void> = []
    vi.mocked(fetch).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
      return response({ jobs: [], nextCursor: null, projects: [] })
    })
    act(() => {
      tick()
    })
    await waitFor(() => expect(releases.length).toBeGreaterThan(0))
    // 轮询请求在飞,「刷新」不进 loading 态。
    expect(screen.getByRole('button', { name: /刷新/ })).toBeEnabled()
    await act(async () => {
      for (const release of releases) release()
    })
    setIntervalSpy.mockRestore()
  })

  test('phaseLabel hides phases that duplicate the status or are unknown', () => {
    expect(phaseLabel({ status: 'running', phase: 'denoise_step' })).toBe('正在生成画面')
    expect(phaseLabel({ status: 'queued', phase: 'wait_gpu' })).toBe('等待算力')
    expect(phaseLabel({ status: 'queued', phase: 'queued' })).toBeNull()
    expect(phaseLabel({ status: 'completed', phase: 'done' })).toBeNull()
    expect(phaseLabel({ status: 'running', phase: 'some_internal_state' })).toBeNull()
    expect(phaseLabel({ status: 'reconnecting', phase: 'reconnecting' })).toBeNull()
  })

  test('failureSummary maps known codes case-insensitively and falls back to a generic line', () => {
    expect(failureSummary({ errorCode: 'H3_OOM', errorMessage: 'CUDA OOM' })).toEqual({
      summary: '显存不足：请缩短视频时长或降低分辨率后重试。',
      detail: 'H3_OOM · CUDA OOM',
    })
    expect(failureSummary({ errorCode: 'weird_code', errorMessage: null })).toEqual({
      summary: '生成失败，请稍后重试或换个描述再试。',
      detail: 'weird_code',
    })
    expect(failureSummary({ errorCode: null, errorMessage: null })).toBeNull()
  })

  test('completed results request a short-lived ticket before rendering media or download links', async () => {
    const completed = job('done', {
      status: 'completed',
      phase: 'completed',
      queuePosition: null,
      resultSha256: 'a'.repeat(64),
      resultSize: 123,
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: true })
      if (url.endsWith('/jobs')) return response({ jobs: [completed], nextCursor: null })
      if (url.endsWith('/projects')) return response({ projects: [], nextCursor: null })
      if (url.endsWith('/jobs/done/result-ticket') && init?.method === 'POST') {
        return response({ url: '/api/media-generation/jobs/done/result?ticket=signed' })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    const reveal = await screen.findByRole('button', { name: '播放或下载结果' })
    expect(screen.queryByRole('link', { name: /下载 MP4/ })).not.toBeInTheDocument()
    fireEvent.click(reveal)
    const download = await screen.findByRole('link', { name: /下载 MP4/ })
    expect(download).toHaveAttribute('href', '/api/media-generation/jobs/done/result?ticket=signed')
    expect(screen.getByText('下载 MP4').closest('a')).toBe(download)
    expect(fetch).toHaveBeenCalledWith(
      '/api/media-generation/jobs/done/result-ticket',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  test('canceled projects never offer stale acceptance or regeneration actions', async () => {
    const canceled = project('canceled', { status: 'canceled' })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/capabilities')) return response({ available: true })
      if (url.endsWith('/jobs')) return response({ jobs: [], nextCursor: null })
      if (url.endsWith('/projects')) return response({ projects: [canceled], nextCursor: null })
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={() => {}} />)
    expect(await screen.findByText('项目 canceled')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保留旧结果' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重做/ })).not.toBeInTheDocument()
  })
})
