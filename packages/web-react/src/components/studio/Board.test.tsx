import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../lib/studio/api', () => ({
  studioApi: { blobTicket: vi.fn(async () => ({ url: '/blob', expiresInSeconds: 900 })) },
}))

import type { ProvidersView, StudioProjectView } from '../../lib/studio/types'
import { BoardPage } from './pages/Board'

afterEach(cleanup)

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never
const providers = (music: 'ready' | 'unconfigured'): ProvidersView => ({
  kinds: [{ kind: 'music', state: music, providers: [] }],
})

function view(): StudioProjectView {
  return {
    project: {
      id: 'p',
      title: 't',
      brief: '',
      status: 'awaiting_user',
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
    expect(screen.getByTestId('timeline-music-slot')).toHaveTextContent('配乐待生成')
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
})
