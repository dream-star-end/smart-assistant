import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const transition = vi.fn(async (_auth: unknown, _id: string, action: string) => ({
  id: 'p',
  title: 't',
  brief: '',
  status: action === 'resume' ? 'running' : 'paused',
  autonomy: 'max',
  aspect: '16:9',
  fps: 24,
  targetSec: 30,
  budgetCredits: '2000',
  spentCredits: '742',
  reservedCredits: '0',
  settings: {},
  rev: 2,
  createdAt: '',
  updatedAt: '',
}))

vi.mock('../../lib/studio/api', () => ({
  studioApi: {
    blobTicket: vi.fn(async () => ({ url: '/blob', expiresInSeconds: 900 })),
    transition: (...args: unknown[]) => transition(...(args as [unknown, string, string])),
  },
  studioErrorText: (err: unknown) => String(err),
}))

import type { ProvidersView, StudioProjectView } from '../../lib/studio/types'
import { BoardPage } from './pages/Board'

afterEach(cleanup)

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never
const providers = (music: 'ready' | 'unconfigured'): ProvidersView => ({
  kinds: [{ kind: 'music', state: music, providers: [] }],
})

function view(status: StudioProjectView['project']['status'] = 'awaiting_user'): StudioProjectView {
  return {
    project: {
      id: 'p',
      title: 't',
      brief: '',
      status,
      autonomy: 'max',
      aspect: '16:9',
      fps: 24,
      targetSec: 30,
      budgetCredits: '2000',
      spentCredits: '742',
      reservedCredits: '0',
      settings: {},
      rev: 1,
      createdAt: '',
      updatedAt: '',
    },
    shots: [
      {
        id: 's0',
        ordinal: 0,
        spec: { title: '林间晨雾', framing: '远景', durationSec: 5 },
        status: 'ready',
        activeTakeId: null,
      },
      {
        id: 's1',
        ordinal: 1,
        spec: { title: '起跑', durationSec: 6 },
        status: 'needs_user',
        activeTakeId: null,
      },
    ],
    lines: [],
    assets: [],
    takes: [],
    events: [
      {
        id: 'e1',
        ts: '2026-10-23T02:00:00Z',
        type: 'shot.retry',
        payload: { message: '#2 自动重拍' },
      },
    ],
  }
}

describe('BoardPage (OCV5-593 FE-2a)', () => {
  test('cards, counts, needs-you candidate card and activity', () => {
    const onOpenShot = vi.fn()
    render(
      <BoardPage
        auth={auth}
        view={view()}
        providers={providers('unconfigured')}
        onOpenShot={onOpenShot}
        onOpenBrief={() => {}}
      />,
    )
    expect(screen.getAllByTestId('studio-shot-card')).toHaveLength(2)
    expect(screen.getByText('1 通过')).toBeInTheDocument()
    expect(screen.getAllByText('1 需要你').length).toBeGreaterThan(0)
    expect(screen.getByText('#2 自动重拍')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '去审阅' }))
    expect(onOpenShot).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByRole('button', { name: '镜头 #1' }))
    expect(onOpenShot).toHaveBeenLastCalledWith('s0')
  })

  test('music lane reads "未配置" when no music provider is ready', () => {
    render(
      <BoardPage
        auth={auth}
        view={view()}
        providers={providers('unconfigured')}
        onOpenShot={() => {}}
        onOpenBrief={() => {}}
      />,
    )
    expect(screen.getByTestId('timeline-music-slot')).toHaveTextContent('音乐生成未配置')
    cleanup()
    render(
      <BoardPage
        auth={auth}
        view={view()}
        providers={providers('ready')}
        onOpenShot={() => {}}
        onOpenBrief={() => {}}
      />,
    )
    // FE-5: with music sources ready, the lane asks for a choice instead of waiting for a generator.
    expect(screen.getByTestId('timeline-music-slot')).toHaveTextContent('还没选配乐')
  })

  test('the instruction box stays disabled until the director agent ships', () => {
    render(
      <BoardPage
        auth={auth}
        view={view()}
        providers={providers('unconfigured')}
        onOpenShot={() => {}}
        onOpenBrief={() => {}}
      />,
    )
    expect(screen.getByLabelText('告诉导演哪里不对')).toBeDisabled()
  })

  test('paused project shows 继续 on the agent panel and posts resume', async () => {
    transition.mockClear()
    const onProject = vi.fn()
    render(
      <BoardPage
        auth={auth}
        view={view('paused')}
        providers={providers('unconfigured')}
        onOpenShot={() => {}}
        onOpenBrief={() => {}}
        onProject={onProject}
      />,
    )
    expect(screen.getByTestId('studio-paused-resume')).toBeInTheDocument()
    expect(screen.getAllByText('已暂停').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(transition).toHaveBeenCalledWith(auth, 'p', 'resume'))
    expect(onProject).toHaveBeenCalled()
    expect(onProject.mock.calls[0]![0].status).toBe('running')
  })

  test('paused without onProject does not offer 继续 in the panel', () => {
    render(
      <BoardPage
        auth={auth}
        view={view('paused')}
        providers={providers('unconfigured')}
        onOpenShot={() => {}}
        onOpenBrief={() => {}}
      />,
    )
    expect(screen.queryByTestId('studio-paused-resume')).not.toBeInTheDocument()
    expect(screen.getAllByText('已暂停').length).toBeGreaterThan(0)
  })

})
