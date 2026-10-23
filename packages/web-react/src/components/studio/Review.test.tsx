import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../lib/studio/api', () => ({
  studioApi: {
    blobTicket: vi.fn(async (_a: unknown, sha: string) => ({
      url: `/blob/${sha}`,
      expiresInSeconds: 900,
    })),
  },
}))

import type { StudioProjectView, StudioTake } from '../../lib/studio/types'
import { ReviewPage } from './pages/Review'

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never
const take = (v: number, score: number): StudioTake => ({
  id: `t${v}`,
  ownerKind: 'shot_frame',
  ownerId: 's1',
  version: v,
  provider: 'GPT Image',
  model: 'gpt-image-2',
  op: 'image.generate',
  status: 'succeeded',
  errorCode: null,
  costCredits: '50',
  qa: { score, character: 0.62, scene: 0.9, summary: '尾巴颜色和设定不符' },
  blobSha: `${v}`.repeat(64),
  createdAt: '',
  finishedAt: null,
})

function view(): StudioProjectView {
  return {
    project: { id: 'p', aspect: '16:9' } as never,
    shots: [
      { id: 's0', ordinal: 0, spec: { title: '晨雾' }, status: 'ready', activeTakeId: null },
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
    takes: [take(1, 0.68), take(2, 0.62)],
    events: [],
  }
}

function box() {
  const el = screen.getByTestId('review-media')
  el.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1000,
    height: 500,
    right: 1000,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON() {},
  })
  return el
}

describe('ReviewPage (OCV5-593 FE-2b)', () => {
  test('opens the needs-you shot by default; QA report shows the scores', async () => {
    render(<ReviewPage auth={auth} view={view()} onBack={() => {}} />)
    expect(screen.getByText('#2 起跑')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'QA 报告' }))
    expect(screen.getByText('角色一致')).toBeInTheDocument()
    expect(screen.getByText('尾巴颜色和设定不符')).toBeInTheDocument()
  })

  test('a point drops a draft with normalised coordinates; text is kept; submit stays disabled', async () => {
    render(<ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '点' }))
    fireEvent.pointerDown(box(), { clientX: 250, clientY: 125, pointerId: 1 })
    const dialog = await screen.findByRole('dialog', { name: '批注 1' })
    fireEvent.change(screen.getByLabelText('批注说明'), { target: { value: '眼睛别看镜头' } })
    expect(dialog).toBeInTheDocument()
    for (const b of screen.getAllByRole('button', { name: /交给 agent/ })) expect(b).toBeDisabled()
    const saved = JSON.parse(sessionStorage.getItem('oc.studio.annotationDrafts.p')!)
    expect(saved).toEqual([
      expect.objectContaining({
        kind: 'point',
        x: 0.25,
        y: 0.25,
        text: '眼睛别看镜头',
        takeId: 't2',
      }),
    ])
  })

  test('a box drag creates a box draft; tiny drags are ignored', async () => {
    render(<ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '框选' }))
    const el = box()
    el.setPointerCapture = () => {}
    fireEvent.pointerDown(el, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 102, clientY: 101, pointerId: 1 })
    fireEvent.pointerUp(el, { pointerId: 1 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.pointerDown(el, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 400, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(el, { pointerId: 1 })
    expect(await screen.findByRole('dialog', { name: '批注 1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '批注 1' })).toBeInTheDocument()
  })

  test('the version strip switches takes; drafts belong to their take', async () => {
    render(<ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '点' }))
    fireEvent.pointerDown(box(), { clientX: 500, clientY: 250, pointerId: 1 })
    expect(screen.getByRole('tab', { name: '批注 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^v1/ }))
    expect(screen.getByRole('tab', { name: '批注 0' })).toBeInTheDocument()
  })
})
