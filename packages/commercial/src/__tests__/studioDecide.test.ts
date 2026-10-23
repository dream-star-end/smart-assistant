/**
 * OCV5-591 A2-1a: the orchestrator's pure decision function on every path of the state machine.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type DState,
  type DTake,
  MAX_INFLIGHT_PER_PROJECT,
  decide,
  shotDone,
} from '../media-studio/orchestrator/decide.js'

const take = (over: Partial<DTake>): DTake => ({
  id: 't',
  ownerKind: 'shot_frame',
  ownerId: 's0',
  version: 1,
  provider: 'gpt-image',
  status: 'succeeded',
  blobSha: 'a'.repeat(64),
  ...over,
})

function state(over: Partial<DState> = {}): DState {
  return {
    status: 'running',
    hasPlanTask: false,
    inflight: 0,
    shots: [{ id: 's0', ordinal: 0, status: 'planned', activeTakeId: null, frameTakeId: null }],
    lines: [],
    assets: [],
    takes: [],
    narrationVoiceId: 'male-qn-jingying',
    musicSkippedNoted: true,
    canDispatch: { image: true, video: true, voice: true, music: false },
    ...over,
  }
}

const dispatches = (s: DState) =>
  decide(s).flatMap((a) =>
    a.type === 'dispatch' ? [`${a.dispatch.ownerKind}:${a.dispatch.ownerId}`] : [],
  )

describe('decide (OCV5-591 A2-1a)', () => {
  it('planning enqueues the plan once; other states do nothing', () => {
    assert.deepEqual(decide(state({ status: 'planning' })), [{ type: 'enqueue_plan' }])
    assert.deepEqual(decide(state({ status: 'planning', hasPlanTask: true })), [])
    for (const status of [
      'draft',
      'paused',
      'awaiting_user',
      'done',
      'canceled',
      'failed',
    ] as const) {
      assert.deepEqual(decide(state({ status })), [], status)
    }
  })

  it('the bible is generated first; frames wait until it is locked', () => {
    const s = state({ assets: [{ id: 'a1', kind: 'character', locked: false, blobSha: null }] })
    assert.deepEqual(dispatches(s), ['bible:a1'])
    const locked = state({
      assets: [{ id: 'a1', kind: 'character', locked: true, blobSha: 'b'.repeat(64) }],
    })
    const acts = decide(locked)
    const d = acts.find((a) => a.type === 'dispatch')
    assert.ok(d && d.type === 'dispatch')
    assert.equal(d.dispatch.ownerKind, 'shot_frame')
    assert.deepEqual(d.dispatch.inputs, [{ role: 'reference', blobSha: 'b'.repeat(64) }])
    assert.ok(acts.some((a) => a.type === 'shot_status' && a.status === 'generating'))
  })

  it('a succeeded frame starts the video from it; a live take blocks a second dispatch', () => {
    const s = state({ takes: [take({ id: 'f1' })] })
    const d = decide(s).find((a) => a.type === 'dispatch')
    assert.ok(d && d.type === 'dispatch')
    assert.equal(d.dispatch.op, 'video.from_image')
    assert.deepEqual(d.dispatch.inputs, [{ role: 'first_frame', blobSha: 'a'.repeat(64) }])
    assert.deepEqual(
      dispatches(
        state({
          takes: [
            take({ id: 'f1' }),
            take({ id: 'v1', ownerKind: 'shot_video', status: 'running', blobSha: null }),
          ],
        }),
      ),
      [],
    )
  })

  it('never more than three generations in flight per project', () => {
    const shots = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      ordinal: i,
      status: 'planned' as const,
      activeTakeId: null,
      frameTakeId: null,
    }))
    assert.equal(dispatches(state({ shots })).length, MAX_INFLIGHT_PER_PROJECT)
    assert.equal(dispatches(state({ shots, inflight: 2 })).length, 1)
    assert.equal(dispatches(state({ shots, inflight: 3 })).length, 0)
  })

  it('failed providers are excluded from the next attempt', () => {
    const s = state({
      takes: [take({ id: 'f1', status: 'failed', blobSha: null, provider: 'gpt-image' })],
    })
    const d = decide(s).find((a) => a.type === 'dispatch')
    assert.ok(d && d.type === 'dispatch')
    assert.deepEqual(d.dispatch.exclude, ['gpt-image'])
  })

  it('a shot is done only with an adopted succeeded video (a frame never counts)', () => {
    const frameOnly = state({
      shots: [{ id: 's0', ordinal: 0, status: 'ready', activeTakeId: 'f1', frameTakeId: null }],
      takes: [take({ id: 'f1' })],
    })
    assert.equal(shotDone(frameOnly, frameOnly.shots[0]!), false)
    const video = state({
      shots: [{ id: 's0', ordinal: 0, status: 'ready', activeTakeId: 'v1', frameTakeId: null }],
      takes: [take({ id: 'f1' }), take({ id: 'v1', ownerKind: 'shot_video' })],
    })
    assert.equal(shotDone(video, video.shots[0]!), true)
  })

  it('a finished video nobody adopted is adopted (newest first) and counts as done', () => {
    const s = state({
      shots: [
        { id: 's0', ordinal: 0, status: 'generating', activeTakeId: null, frameTakeId: null },
      ],
      takes: [
        take({ id: 'f1' }),
        take({ id: 'v1', ownerKind: 'shot_video' }),
        take({ id: 'v2', ownerKind: 'shot_video', version: 2 }),
      ],
    })
    assert.deepEqual(decide(s), [
      { type: 'adopt_video', shotId: 's0', takeId: 'v2' },
      { type: 'set_status', status: 'awaiting_user', reason: 'compose_pending' },
    ])
    // A shot sent to the user is left alone even with a finished video.
    const held = { ...s, shots: [{ ...s.shots[0]!, status: 'needs_user' as const }] }
    assert.ok(!decide(held).some((a) => a.type === 'adopt_video'))
  })

  it('a chosen frame re-runs the video even when an older video exists', () => {
    const s = state({
      shots: [
        { id: 's0', ordinal: 0, status: 'generating', activeTakeId: null, frameTakeId: 'f2' },
      ],
      takes: [
        take({ id: 'f1' }),
        take({ id: 'f2', version: 2, blobSha: 'c'.repeat(64) }),
        take({ id: 'v1', ownerKind: 'shot_video' }),
      ],
    })
    const d = decide(s).find((a) => a.type === 'dispatch')
    assert.ok(d && d.type === 'dispatch')
    assert.deepEqual(d.dispatch.inputs, [{ role: 'first_frame', blobSha: 'c'.repeat(64) }])
  })

  it('lines are voiced with the plan voice; without voice the project waits for the user', () => {
    const s = state({
      shots: [{ id: 's0', ordinal: 0, status: 'ready', activeTakeId: 'v1', frameTakeId: null }],
      takes: [take({ id: 'v1', ownerKind: 'shot_video' })],
      lines: [{ id: 'l0', status: 'planned', activeTakeId: null }],
    })
    assert.deepEqual(dispatches(s), ['line:l0'])
    const noVoice = { ...s, canDispatch: { ...s.canDispatch, voice: false } }
    assert.deepEqual(decide(noVoice), [
      { type: 'set_status', status: 'awaiting_user', reason: 'needs_user' },
    ])
  })

  it('music without a provider is noted once and never blocks', () => {
    const s = state({ musicSkippedNoted: false })
    assert.ok(decide(s).some((a) => a.type === 'note_music_skipped'))
    assert.ok(!decide(state()).some((a) => a.type === 'note_music_skipped'))
  })

  it('everything ready → waits for compose; needs_user with nothing in flight → awaiting the user', () => {
    const done = state({
      shots: [{ id: 's0', ordinal: 0, status: 'ready', activeTakeId: 'v1', frameTakeId: null }],
      takes: [take({ id: 'v1', ownerKind: 'shot_video' })],
      lines: [{ id: 'l0', status: 'ready', activeTakeId: 'lt' }],
    })
    assert.deepEqual(decide(done), [
      { type: 'set_status', status: 'awaiting_user', reason: 'compose_pending' },
    ])
    const stuck = state({
      shots: [
        { id: 's0', ordinal: 0, status: 'needs_user', activeTakeId: null, frameTakeId: null },
      ],
    })
    assert.deepEqual(decide(stuck), [
      { type: 'set_status', status: 'awaiting_user', reason: 'needs_user' },
    ])
    assert.deepEqual(decide({ ...stuck, inflight: 1 }), [])
  })
})
