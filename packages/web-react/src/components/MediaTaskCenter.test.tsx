import '@testing-library/jest-dom/vitest'
import type { MediaGenerationJob, VideoProject } from '@openclaude/protocol/mediaGeneration'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../lib/authSession'

vi.mock('../lib/api', () => ({
  callWithRefresh: async (_auth: unknown, call: (token: string) => Promise<Response>) =>
    call('token'),
  bearerHeaders: () => ({ Authorization: 'Bearer token' }),
  assertAuthResponseCurrent: () => {},
}))

import { MediaTaskCenter } from './MediaTaskCenter'

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
    fireEvent.click(screen.getByRole('button', { name: /重做/ }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/media-generation/projects/2/shots/2-shot/regenerate',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRev: 2 }) }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: /取消项目/ }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/media-generation/projects/2/cancel',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRev: 2 }) }),
      ),
    )
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
