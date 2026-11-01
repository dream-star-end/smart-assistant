import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const approve = vi.fn(async () => ({}))
const transition = vi.fn(async () => ({}))
vi.mock('../../lib/studio/api', () => ({
  studioApi: {
    approve: (...a: unknown[]) => approve(...(a as [])),
    transition: (...a: unknown[]) => transition(...(a as [])),
  },
  studioErrorText: () => '出错了',
}))

import type { StudioProjectView } from '../../lib/studio/types'
import { StudioContinue } from './StudioContinue'

afterEach(() => {
  cleanup()
  approve.mockClear()
  transition.mockClear()
})

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never

function view(status: 'paused' | 'awaiting_user', reason?: string): StudioProjectView {
  return {
    project: {
      id: 'p',
      title: 't',
      brief: '',
      status,
      autonomy: 'confirm',
      aspect: '16:9',
      fps: 24,
      targetSec: 30,
      budgetCredits: '1',
      spentCredits: '0',
      reservedCredits: '0',
      settings: reason ? { awaitingReason: reason } : { resumeTo: 'running' },
      rev: 1,
      createdAt: '',
      updatedAt: '',
    },
    shots: [],
    lines: [],
    assets: [],
    takes: [],
    events: [
      {
        id: 'e',
        ts: '2026-11-01T02:00:00Z',
        type: status === 'paused' ? 'project.paused' : 'project.awaiting_user',
        payload: { message: status === 'paused' ? '已暂停。' : '视频服务暂时无法接收首帧，制作已暂停，已有结果会保留。' },
      },
    ],
  }
}

describe('StudioContinue', () => {
  test('a provider outage on the shot page approves, same as the brief page', async () => {
    const onReload = vi.fn()
    render(<StudioContinue auth={auth} view={view('awaiting_user', 'provider_failure')} onReload={onReload} />)
    expect(screen.getByTestId('studio-pause-reason')).toHaveTextContent('制作已暂停')
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith(auth, 'p'))
    expect(transition).not.toHaveBeenCalled()
    await waitFor(() => expect(onReload).toHaveBeenCalled())
  })

  test('a paused project resumes', async () => {
    render(<StudioContinue auth={auth} view={view('paused')} />)
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(transition).toHaveBeenCalledWith(auth, 'p', 'resume'))
    expect(approve).not.toHaveBeenCalled()
  })
})
