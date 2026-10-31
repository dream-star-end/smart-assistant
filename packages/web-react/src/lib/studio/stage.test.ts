import { describe, expect, test } from 'vitest'

import { followStage, workStage } from './stage'
import type { StudioAsset, StudioProjectView, StudioShot } from './types'

function view(over: {
  status?: StudioProjectView['project']['status']
  settings?: Record<string, unknown>
  shots?: Array<Partial<StudioShot>>
  assets?: Array<Partial<StudioAsset>>
  lines?: Array<{ status: string; activeTakeId: string | null }>
}): StudioProjectView {
  return {
    project: { status: over.status ?? 'running', settings: over.settings ?? {} } as never,
    shots: (over.shots ?? []).map((s, i) => ({
      id: `s${i}`,
      ordinal: i,
      spec: {},
      status: 'planned',
      activeTakeId: null,
      ...s,
    })),
    assets: (over.assets ?? []).map((a, i) => ({
      id: `a${i}`,
      kind: 'character',
      locked: false,
      blobSha: null,
      ...a,
    })) as never,
    lines: (over.lines ?? []).map((l, i) => ({ id: `l${i}`, ...l })) as never,
    takes: [],
    events: [],
  }
}

describe('workStage', () => {
  test('plan, approval and budget stops are the brief', () => {
    expect(workStage(view({ status: 'draft' }))).toBe('brief')
    expect(workStage(view({ status: 'planning' }))).toBe('brief')
    expect(
      workStage(
        view({
          status: 'awaiting_user',
          settings: { awaitingReason: 'approve_plan' },
          shots: [{}],
        }),
      ),
    ).toBe('brief')
    expect(
      workStage(
        view({ status: 'awaiting_user', settings: { awaitingReason: 'budget' }, shots: [{}] }),
      ),
    ).toBe('brief')
  })

  test('an unlocked character / scene / style image is the 设定 step; uploads do not count', () => {
    expect(workStage(view({ shots: [{}], assets: [{ kind: 'character' }] }))).toBe('image')
    expect(
      workStage(
        view({
          shots: [{}],
          assets: [{ kind: 'upload' }, { kind: 'scene', locked: true, blobSha: 'x' }],
        }),
      ),
    ).toBe('board')
  })

  test('shots until every one is ready (a needs-you shot keeps it on 镜头), then narration', () => {
    expect(workStage(view({ shots: [{ status: 'ready' }, { status: 'needs_user' }] }))).toBe(
      'board',
    )
    expect(
      workStage(
        view({
          status: 'awaiting_user',
          settings: { awaitingReason: 'needs_user' },
          shots: [{ status: 'qa' }],
        }),
      ),
    ).toBe('board')
    expect(
      workStage(
        view({
          shots: [{ status: 'ready' }],
          lines: [{ status: 'generating', activeTakeId: null }],
        }),
      ),
    ).toBe('voice')
    expect(
      workStage(
        view({ shots: [{ status: 'ready' }], lines: [{ status: 'ready', activeTakeId: 't' }] }),
      ),
    ).toBe('final')
  })

  test('compose, its failure or a missing sandbox, and done are the 成片 step', () => {
    expect(workStage(view({ status: 'composing', shots: [{}] }))).toBe('final')
    expect(workStage(view({ status: 'done', shots: [{}] }))).toBe('final')
    for (const awaitingReason of ['compose_failed', 'compose_pending'])
      expect(
        workStage(view({ status: 'awaiting_user', settings: { awaitingReason }, shots: [{}] })),
      ).toBe('final')
  })
})

describe('followStage', () => {
  test('moves along only from the page of the step that just finished', () => {
    expect(followStage('brief', 'image', 'brief')).toBe('image')
    expect(followStage('image', 'board', 'image')).toBe('board')
    expect(followStage('voice', 'final', 'voice')).toBe('final')
  })

  test('never on first load, never when nothing moved, never from a page the user picked', () => {
    expect(followStage(null, 'board', 'brief')).toBeNull()
    expect(followStage('board', 'board', 'board')).toBeNull()
    expect(followStage('brief', 'image', 'music')).toBeNull()
    expect(followStage('board', 'voice', 'review')).toBeNull()
  })
})
