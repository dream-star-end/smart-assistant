import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const createAnnotation = vi.fn(async () => ({ id: 'srv1' }))
const annotationAction = vi.fn(async () => ({ ok: true }))
const updateAnnotation = vi.fn(async () => ({ ok: true }))
const selectTake = vi.fn(async () => ({ projectId: 'p' }))
vi.mock('../../lib/studio/api', () => ({
  studioApi: {
    blobTicket: vi.fn(async (_a: unknown, sha: string) => ({
      url: `/blob/${sha}`,
      expiresInSeconds: 900,
    })),
    createAnnotation: (...a: unknown[]) => createAnnotation(...(a as [])),
    annotationAction: (...a: unknown[]) => annotationAction(...(a as [])),
    updateAnnotation: (...a: unknown[]) => updateAnnotation(...(a as [])),
    selectTake: (...a: unknown[]) => selectTake(...(a as [])),
  },
  studioErrorText: () => '出错了',
  StudioApiError: class StudioApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code)
    }
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

  test('a point drops a draft with normalised coordinates; text is kept; it can be handed over', async () => {
    render(<ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '点' }))
    fireEvent.pointerDown(box(), { clientX: 250, clientY: 125, pointerId: 1 })
    const dialog = await screen.findByRole('dialog', { name: '批注 1' })
    fireEvent.change(screen.getByLabelText('批注说明'), { target: { value: '眼睛别看镜头' } })
    expect(dialog).toBeInTheDocument()
    for (const b of screen.getAllByRole('button', { name: /交给 agent/ })) expect(b).toBeEnabled()
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

describe('ReviewPage adopts the take on the stage', () => {
  test('a frame on a needs-you shot re-shoots the video from it; the strip only previews', async () => {
    selectTake.mockClear()
    const onReload = vi.fn()
    render(
      <ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} onReload={onReload} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^v1/ }))
    expect(selectTake).not.toHaveBeenCalled()
    const adopt = screen.getByTestId('adopt-take')
    expect(adopt).toHaveTextContent('用 v1 这一帧重拍视频')
    expect(adopt).toHaveClass('st-btn-primary')
    expect(screen.getByText('会按这一帧重新生成视频，视频按正常价格扣积分。')).toBeInTheDocument()
    fireEvent.click(adopt)
    await waitFor(() => expect(selectTake).toHaveBeenCalledWith(auth, 't1'))
    await waitFor(() => expect(onReload).toHaveBeenCalled())
  })

  test('a video is adopted and continues; the adopted one reads 已采用', async () => {
    selectTake.mockClear()
    const v = view()
    const vid = (n: number): StudioTake => ({
      ...take(n, 0.8),
      id: `v${n}`,
      ownerKind: 'shot_video',
    })
    v.takes = [vid(1), vid(2)]
    render(<ReviewPage auth={auth} view={v} shotId="s1" onBack={() => {}} />)
    expect(screen.getByTestId('adopt-take')).toHaveTextContent('采用 v2 并继续')
    fireEvent.click(screen.getByTestId('adopt-take'))
    await waitFor(() => expect(selectTake).toHaveBeenCalledWith(auth, 'v2'))
    cleanup()
    v.shots[1] = { ...v.shots[1]!, status: 'ready', activeTakeId: 'v2' }
    render(<ReviewPage auth={auth} view={v} shotId="s1" onBack={() => {}} />)
    expect(screen.getByTestId('adopt-take')).toHaveTextContent('已采用 v2')
    expect(screen.getByTestId('adopt-take')).toBeDisabled()
  })

  test('nothing to adopt while the shot is generating or the project is over', () => {
    const v = view()
    v.shots[1] = { ...v.shots[1]!, status: 'generating' }
    render(<ReviewPage auth={auth} view={v} shotId="s1" onBack={() => {}} />)
    expect(screen.getByTestId('adopt-take')).toBeDisabled()
    expect(screen.getByText('这一镜还在生成，生成完再选版本。')).toBeInTheDocument()
    cleanup()
    const done = view()
    done.project = { ...done.project, status: 'done' }
    render(<ReviewPage auth={auth} view={done} shotId="s1" onBack={() => {}} />)
    expect(screen.getByTestId('adopt-take')).toBeDisabled()
  })

  test('with notes written, 交给 agent is the primary action', async () => {
    render(<ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '点' }))
    fireEvent.pointerDown(box(), { clientX: 250, clientY: 125, pointerId: 1 })
    fireEvent.change(await screen.findByLabelText('批注说明'), {
      target: { value: '眼睛别看镜头' },
    })
    expect(screen.getByTestId('hand-over')).toHaveClass('st-btn-primary')
    expect(screen.getByTestId('adopt-take')).not.toHaveClass('st-btn-primary')
  })
})

describe('ReviewPage hand over to the agent (OCV5-593 FE-7b)', () => {
  test('a draft becomes a server annotation, is sent, and leaves the tab', async () => {
    createAnnotation.mockClear()
    annotationAction.mockClear()
    const onReload = vi.fn()
    render(
      <ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} onReload={onReload} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '点' }))
    fireEvent.pointerDown(box(), { clientX: 250, clientY: 125, pointerId: 1 })
    await screen.findByRole('dialog', { name: '批注 1' })
    fireEvent.change(screen.getByLabelText('批注说明'), { target: { value: '眼睛别看镜头' } })
    fireEvent.click(screen.getByTestId('hand-over'))
    await waitFor(() => expect(onReload).toHaveBeenCalled())
    expect(createAnnotation).toHaveBeenCalledWith(auth, 'p', {
      takeId: 't2',
      kind: 'point',
      tStartMs: 0,
      geom: { x: 0.25, y: 0.25 },
      text: '眼睛别看镜头',
    })
    expect(annotationAction).toHaveBeenCalledWith(auth, 'srv1', 'send')
    expect(sessionStorage.getItem('oc.studio.annotationDrafts.p')).toBeNull()
  })

  test('a send that fails keeps the draft with its server id; the retry only sends (FE-7b r1)', async () => {
    createAnnotation.mockClear()
    annotationAction.mockClear()
    annotationAction.mockRejectedValueOnce(new Error('503'))
    render(
      <ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} onReload={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '点' }))
    fireEvent.pointerDown(box(), { clientX: 250, clientY: 125, pointerId: 1 })
    await screen.findByRole('dialog', { name: '批注 1' })
    fireEvent.change(screen.getByLabelText('批注说明'), { target: { value: '眼睛别看镜头' } })
    fireEvent.click(screen.getByTestId('hand-over'))
    await waitFor(() => expect(annotationAction).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('hand-over')).toBeEnabled())
    const kept = JSON.parse(sessionStorage.getItem('oc.studio.annotationDrafts.p')!)
    expect(kept[0].serverId).toBe('srv1')
    // Edited before the retry: the server copy is updated first, then sent (FE-7b r2).
    fireEvent.click(screen.getByRole('button', { name: /^1/ }))
    fireEvent.change(await screen.findByLabelText('批注说明'), {
      target: { value: '眼睛看向左边' },
    })
    fireEvent.click(screen.getByTestId('hand-over'))
    await waitFor(() => expect(annotationAction).toHaveBeenCalledTimes(2))
    expect(createAnnotation).toHaveBeenCalledTimes(1)
    expect(updateAnnotation).toHaveBeenCalledWith(auth, 'srv1', {
      kind: 'point',
      tStartMs: 0,
      geom: { x: 0.25, y: 0.25 },
      text: '眼睛看向左边',
    })
    await waitFor(() => expect(sessionStorage.getItem('oc.studio.annotationDrafts.p')).toBeNull())
  })

  test('what the agent understood is shown; 确认执行 applies it, 不采用 rejects it', async () => {
    annotationAction.mockClear()
    const v = view()
    v.annotations = [
      {
        id: 'a1',
        targetKind: 'shot',
        targetId: 's1',
        takeId: 't2',
        kind: 'text',
        tStartMs: null,
        tEndMs: null,
        geom: null,
        text: '尾巴改成白色',
        status: 'sent',
        interpretation: {
          op: 'regenerate_shot',
          explanation: '重画首帧，尾巴改白',
          confidence: 0.7,
          state: null,
          error: null,
        },
        appliedTakeId: null,
        createdAt: '',
      },
    ]
    render(<ReviewPage auth={auth} view={v} shotId="s1" onBack={() => {}} onReload={() => {}} />)
    const note = screen.getByTestId('sent-note')
    expect(note).toHaveTextContent('等你确认')
    expect(note).toHaveTextContent('agent 理解为：重画首帧，尾巴改白')
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }))
    await waitFor(() => expect(annotationAction).toHaveBeenCalledWith(auth, 'a1', 'apply'))
    fireEvent.click(screen.getByRole('button', { name: '不采用' }))
    await waitFor(() => expect(annotationAction).toHaveBeenCalledWith(auth, 'a1', 'reject'))
  })
})

describe('ReviewPage QA outcome (OCV5-593 FE-7a)', () => {
  test('moderation, issues and the hand-off reason; the offered versions are marked', () => {
    const v = view()
    v.takes = [
      take(1, 0.68),
      {
        ...take(2, 0.62),
        qa: {
          score: 0.62,
          character: 0.62,
          moderation: 'pass',
          summary: '尾巴颜色和设定不符',
          issues: [{ frame: 'F1', what: '尾巴颜色不对' }],
          next: 'handoff',
          reason: 'retries_exhausted',
        },
      },
    ]
    v.events = [
      {
        id: '5',
        ts: '',
        type: 'shot.needs_user',
        payload: { shotId: 's1', takeIds: ['t1', 't2'] },
      } as never,
    ]
    render(<ReviewPage auth={auth} view={v} shotId="s1" onBack={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'QA 报告' }))
    expect(screen.getByTestId('qa-moderation')).toHaveTextContent('通过')
    expect(screen.getByTestId('qa-issues')).toHaveTextContent('尾巴颜色不对')
    expect(screen.getByTestId('qa-outcome')).toHaveTextContent('自动重做了 2 次仍未通过，交给你选')
    fireEvent.click(screen.getByRole('tab', { name: /历史/ }))
    expect(screen.getAllByTestId('qa-recommended')).toHaveLength(2)
  })
})

describe('ReviewPage pointer robustness (OCV5-593 FE-2b code r1)', () => {
  test('box mode prevents the native drag and a cancelled pointer leaves no half box', async () => {
    render(<ReviewPage auth={auth} view={view()} shotId="s1" onBack={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '框选' }))
    const el = box()
    el.setPointerCapture = () => {}
    const down = fireEvent.pointerDown(el, {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      cancelable: true,
    })
    expect(down).toBe(false) // default prevented
    fireEvent.pointerMove(el, { clientX: 400, clientY: 300, pointerId: 1 })
    fireEvent.pointerCancel(el, { pointerId: 1 })
    fireEvent.pointerUp(el, { pointerId: 1 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('oc.studio.annotationDrafts.p')).toBeNull()
  })
})
