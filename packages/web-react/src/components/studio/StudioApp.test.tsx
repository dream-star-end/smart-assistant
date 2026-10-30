import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'

vi.mock('../../lib/api', () => ({
  callWithRefresh: async (_auth: unknown, call: (token: string) => Promise<Response>) =>
    call('token'),
  bearerHeaders: () => ({ Authorization: 'Bearer token' }),
  assertAuthResponseCurrent: () => {},
  AuthEpochStaleError: class AuthEpochStaleError extends Error {},
}))

import { __resetStudioProbeCache } from '../../hooks/useStudioProviders'
import type { ProvidersView, StudioProject } from '../../lib/studio/types'
import { StudioApp } from './StudioApp'

const ID = '11111111-2222-4333-8444-555555555555'

const PROVIDERS: ProvidersView = {
  kinds: [
    {
      kind: 'image',
      state: 'ready',
      providers: [
        {
          id: 'gpt-image',
          label: 'GPT Image',
          state: 'ready',
          models: [
            { id: 'gpt-image-2', label: 'gpt-image-2', ops: ['image.generate'], isDefault: true },
          ],
        },
      ],
    },
    {
      kind: 'video',
      state: 'offline',
      providers: [
        { id: 'muse-video', label: 'Muse', state: 'offline', reason: 'BRIDGE_OFFLINE', models: [] },
      ],
    },
    {
      kind: 'voice',
      state: 'unconfigured',
      providers: [
        {
          id: 'minimax-speech',
          label: 'MiniMax 语音',
          state: 'unconfigured',
          reason: 'MISSING_KEY',
          models: [],
        },
      ],
    },
    { kind: 'music', state: 'unconfigured', reason: 'NO_PROVIDER', providers: [] },
  ],
}

function project(over: Partial<StudioProject> = {}): StudioProject {
  return {
    id: ID,
    title: '冬日来客',
    brief: '拍一条 30 秒的冬日红狐短片',
    status: 'draft',
    autonomy: 'max',
    aspect: '16:9',
    fps: 24,
    targetSec: 30,
    budgetCredits: '2000',
    spentCredits: '0',
    reservedCredits: '0',
    settings: {},
    rev: 1,
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    ...over,
  }
}

type Handler = (init?: RequestInit) => { status: number; body: unknown }
let routes: Record<string, Handler>
let calls: Array<{ method: string; path: string; body?: unknown }>

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  __resetStudioProbeCache()
  calls = []
  routes = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = String(input)
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const h = routes[`${method} ${path.split('?')[0]}`]
      if (!h) return json(404, { error: { code: 'NOT_FOUND' } })
      const r = h(init)
      return json(r.status, r.body)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

const auth = createMemoryAuthSession(() => {}, 'token')

function mount(path: string) {
  history.replaceState(null, '', path)
  return render(<StudioApp auth={auth} theme="light" onCycleTheme={() => {}} />)
}

describe('StudioApp (OCV5-593)', () => {
  test('a 404 from /providers shows the quiet "not open" page, never an error', async () => {
    mount('/studio')
    expect(await screen.findByText('媒体工作台暂未开放')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到对话' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('home: empty project list, music marked not configured, create goes to the brief page', async () => {
    routes['GET /api/studio/providers'] = () => ({ status: 200, body: PROVIDERS })
    routes['GET /api/studio/projects'] = () => ({ status: 200, body: { projects: [], next: null } })
    routes['POST /api/studio/projects'] = () => ({ status: 201, body: { project: project() } })
    routes[`GET /api/studio/projects/${ID}`] = () => ({
      status: 200,
      body: { project: project(), shots: [], lines: [], assets: [], takes: [], events: [] },
    })
    mount('/studio')
    expect(await screen.findByText('一句话，拍一支片。')).toBeInTheDocument()
    expect(await screen.findByText('还没有项目')).toBeInTheDocument()
    expect(screen.getByText('配乐（未配置）')).toBeInTheDocument()
    // 全自动 runs plan → generation without a stop; the estimate comes with the storyboard.
    expect(screen.getByText(/导演写好分镜后先算出预估，超出预算会暂停问你/)).toBeInTheDocument()
    expect(screen.queryByText(/开拍前会先给出预估/)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('影片需求'), {
      target: { value: '拍一条 30 秒的冬日红狐短片。纪录片质感' },
    })
    fireEvent.click(screen.getByRole('button', { name: /全自动开拍/ }))
    await waitFor(() => expect(location.pathname).toBe(`/studio/p/${ID}/brief`))
    const create = calls.find((c) => c.method === 'POST')
    expect(create?.body).toEqual({
      title: '拍一条 30 秒的冬日红狐短片',
      brief: '拍一条 30 秒的冬日红狐短片。纪录片质感',
      aspect: '16:9',
      targetSec: 30,
    })
    expect(await screen.findByText('分镜还没写')).toBeInTheDocument()
  })

  test('brief page: model plan follows /providers and start is enabled for a draft with a brief', async () => {
    routes['GET /api/studio/providers'] = () => ({ status: 200, body: PROVIDERS })
    routes[`GET /api/studio/projects/${ID}`] = () => ({
      status: 200,
      body: { project: project(), shots: [], lines: [], assets: [], takes: [], events: [] },
    })
    mount(`/studio/p/${ID}/brief`)
    expect(await screen.findByTestId('plan-music')).toHaveTextContent('未配置')
    expect(screen.getByTestId('plan-voice')).toHaveTextContent('未配置')
    expect(screen.getByTestId('plan-video')).toHaveTextContent('Muse 暂时不可用')
    expect(screen.getByTestId('plan-image')).toHaveTextContent('GPT Image')
    expect(screen.getByRole('button', { name: /全自动开始/ })).toBeEnabled()
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  test('brief page: 全自动开始 posts /start and reloads the project view', async () => {
    let status: StudioProject['status'] = 'draft'
    routes['GET /api/studio/providers'] = () => ({ status: 200, body: PROVIDERS })
    routes[`GET /api/studio/projects/${ID}`] = () => ({
      status: 200,
      body: {
        project: project({ status }),
        shots: [],
        lines: [],
        assets: [],
        takes: [],
        events: [],
      },
    })
    routes[`POST /api/studio/projects/${ID}/start`] = () => {
      status = 'planning'
      return {
        status: 200,
        body: {
          project: project({ status: 'planning' }),
          shots: [],
          lines: [],
          assets: [],
          takes: [],
          events: [],
        },
      }
    }
    mount(`/studio/p/${ID}/brief`)
    fireEvent.click(await screen.findByRole('button', { name: /全自动开始/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/start'))).toBe(true),
    )
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /全自动开始/ })).not.toBeInTheDocument(),
    )
    expect(screen.getByTestId('studio-progress-note')).toHaveTextContent(
      '导演 agent 正在写分镜（通常一分钟内），写好后会显示镜头和预估费用。',
    )
  })

  test('brief page: the storyboard estimate is shown while running and when asking to approve', async () => {
    let view: Partial<StudioProject> = {
      status: 'running',
      settings: { estimateCredits: '456' },
    }
    routes['GET /api/studio/providers'] = () => ({ status: 200, body: PROVIDERS })
    routes[`GET /api/studio/projects/${ID}`] = () => ({
      status: 200,
      body: { project: project(view), shots: [], lines: [], assets: [], takes: [], events: [] },
    })
    mount(`/studio/p/${ID}/brief`)
    expect(await screen.findByTestId('studio-progress-note')).toHaveTextContent(
      '分镜预估 456 积分，导演 agent 正在生成。',
    )
    cleanup()
    view = {
      status: 'awaiting_user',
      settings: { estimateCredits: '456', awaitingReason: 'approve_plan' },
    }
    mount(`/studio/p/${ID}/brief`)
    expect(
      await screen.findByText('分镜已写好，预估 456 积分；确认后导演 agent 开始生成镜头。'),
    ).toBeInTheDocument()
    cleanup()
    view = {
      status: 'awaiting_user',
      settings: { estimateCredits: '2400', awaitingReason: 'budget' },
    }
    mount(`/studio/p/${ID}/brief`)
    expect(
      await screen.findByText('预估 2,400 积分，超过了当前预算，调高预算后再继续。'),
    ).toBeInTheDocument()
  })

  test('brief page: provider suspension can continue even before a take succeeds', async () => {
    let waiting = true
    routes['GET /api/studio/providers'] = () => ({ status: 200, body: PROVIDERS })
    const view = () => ({ project: project({ status: waiting ? 'awaiting_user' : 'running', settings: waiting ? { awaitingReason: 'provider_failure' } : {} }), shots: [], lines: [], assets: [], takes: [], events: [] })
    routes[`GET /api/studio/projects/${ID}`] = () => ({ status: 200, body: view() })
    routes[`POST /api/studio/projects/${ID}/approve`] = () => { waiting = false; return { status: 200, body: view() } }
    mount(`/studio/p/${ID}/brief`)
    fireEvent.click(await screen.findByRole('button', { name: '继续' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/approve'))).toBe(true))
    await waitFor(() => expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument())
  })

  test('brief page: empty brief keeps start disabled', async () => {
    routes['GET /api/studio/providers'] = () => ({ status: 200, body: PROVIDERS })
    routes[`GET /api/studio/projects/${ID}`] = () => ({
      status: 200,
      body: {
        project: project({ brief: '   ' }),
        shots: [],
        lines: [],
        assets: [],
        takes: [],
        events: [],
      },
    })
    mount(`/studio/p/${ID}/brief`)
    expect(await screen.findByRole('button', { name: /全自动开始/ })).toBeDisabled()
  })

  test('a 409 is explained by its code and a rev conflict reloads the project', async () => {
    let rev = 1
    routes['GET /api/studio/providers'] = () => ({ status: 200, body: PROVIDERS })
    routes[`GET /api/studio/projects/${ID}`] = () => ({
      status: 200,
      body: { project: project({ rev }), shots: [], lines: [], assets: [], takes: [], events: [] },
    })
    routes[`PATCH /api/studio/projects/${ID}`] = () => {
      rev = 2
      return { status: 409, body: { error: { code: 'STUDIO_REV_CONFLICT', message: 'stale' } } }
    }
    mount(`/studio/p/${ID}/brief`)
    fireEvent.click(await screen.findByRole('button', { name: '9:16' }))
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith(ID)).length).toBe(2),
    )
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ aspect: '9:16', expectedRev: 1 })
  })

  test('unknown studio URL shows not-found inside the studio', async () => {
    routes['GET /api/studio/providers'] = () => ({ status: 200, body: PROVIDERS })
    mount('/studio/nope')
    expect(await screen.findByText('页面不存在')).toBeInTheDocument()
  })
})
