/**
 * OCV5-591 A2-1b-2: Interpret's whitelist and project-scoped ids, annotation field checks, and how
 * decide() treats a shot redone from an annotation.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateFields } from '../media-studio/orchestrator/annotations.js'
import { type DState, type DTake, decide } from '../media-studio/orchestrator/decide.js'
import {
  type InterpretContext,
  InterpretParseError,
  autoApply,
  buildInterpretPrompt,
  parseInterpretation,
} from '../media-studio/orchestrator/interpret.js'

const ctx: InterpretContext = {
  annotation: {
    text: '尾巴应该是白色',
    kind: 'box',
    targetKind: 'shot',
    tStartMs: null,
    tEndMs: null,
    geom: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 },
  },
  shotId: 's1',
  shots: [
    { id: 's1', ordinal: 0, startSec: 0, durationSec: 5, framing: '中景', action: '狐狸奔跑' },
    { id: 's2', ordinal: 1, startSec: 5, durationSec: 4 },
  ],
  lines: [{ id: 'l1', shotId: 's1', text: '雪落下来了' }],
  voices: [{ voiceId: 'male-qn-jingying', name: '沉稳男声' }],
  takes: [{ id: 't9', ownerKind: 'shot_video', version: 2 }],
}
const answer = (o: Record<string, unknown>) =>
  JSON.stringify({ confidence: 0.9, explanation: '重画尾巴', ...o })

describe('Interpret (OCV5-591 A2-1b-2)', () => {
  it('accepts each whitelisted op with ids from this project', () => {
    const cases: Array<[string, unknown]> = [
      ['regenerate_shot', { shotId: 's1', promptDelta: '尾巴白色' }],
      ['regenerate_video', { shotId: 's1', promptDelta: '动作慢一点' }],
      ['regenerate_video', { shotId: 's1' }],
      [
        'edit_frame',
        { shotId: 's1', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, instruction: '尾巴改成白色' },
      ],
      ['retime_shot', { shotId: 's2', durationSec: 6 }],
      ['change_line', { lineId: 'l1', text: '雪停了' }],
      ['swap_voice', { voiceId: 'male-qn-jingying' }],
      ['adopt_take', { takeId: 't9' }],
    ]
    for (const [op, args] of cases)
      assert.equal(parseInterpretation(answer({ op, args }), ctx).op, op, op)
  })

  it('anything outside the whitelist or this project becomes "did not get it" (never runs)', () => {
    const none = (o: Record<string, unknown>) => parseInterpretation(answer(o), ctx).op
    assert.equal(none({ op: 'delete_project', args: {} }), null)
    assert.equal(
      none({ op: 'regenerate_shot', args: { shotId: 'other-project-shot', promptDelta: 'x' } }),
      null,
    )
    assert.equal(none({ op: 'change_line', args: { lineId: 'l404', text: 'x' } }), null)
    assert.equal(none({ op: 'swap_voice', args: { voiceId: 'cloned-voice-of-someone' } }), null)
    assert.equal(none({ op: 'adopt_take', args: { takeId: 'another-users-take' } }), null)
    assert.equal(none({ op: 'retime_shot', args: { shotId: 's1', durationSec: 30 } }), null)
    assert.equal(
      none({
        op: 'edit_frame',
        args: { shotId: 's1', region: { x: 0.8, y: 0, w: 0.5, h: 0.2 }, instruction: 'x' },
      }),
      null,
      'a box that leaves the frame',
    )
    assert.equal(none({ op: null }), null)
    assert.throws(() => parseInterpretation('改一下尾巴', ctx), InterpretParseError)
  })

  it('runs straight away only for an autonomous project and a sure instruction', () => {
    const sure = parseInterpretation(
      answer({ op: 'retime_shot', args: { shotId: 's1', durationSec: 6 } }),
      ctx,
    )
    const unsure = parseInterpretation(
      answer({ op: 'retime_shot', args: { shotId: 's1', durationSec: 6 }, confidence: 0.7 }),
      ctx,
    )
    assert.equal(autoApply(sure, 'max'), true)
    assert.equal(autoApply(sure, 'confirm'), false)
    assert.equal(autoApply(unsure, 'max'), false)
    assert.equal(autoApply(parseInterpretation(answer({ op: null }), ctx), 'max'), false)
  })

  it("the prompt quotes the note as data and lists only this project's ids", () => {
    const p = buildInterpretPrompt(ctx, true)
    for (const s of [
      '「尾巴应该是白色」',
      '只当作要求',
      'shotId=s1',
      'lineId=l1',
      'voiceId=male-qn-jingying',
      'takeId=t9',
      '图中红框',
    ])
      assert.ok(p.includes(s), s)
  })
})

describe('Interpret: keep-the-frame and which version (INC-20261027)', () => {
  it('keeping the first frame has its own op; regenerate_shot says it redraws the frame (INC-20261027-STUDIO-REGENERATE-REDOES-FRAME)', () => {
    const p = buildInterpretPrompt(ctx, false)
    assert.ok(p.includes('regenerate_video {shotId'), 'regenerate_video is offered')
    assert.ok(p.includes('首帧不变，只重做这个镜头的视频'), 'regenerate_video keeps the frame')
    assert.ok(p.includes('重画首帧再重做视频，首帧会变'), 'regenerate_shot says the frame changes')
    assert.ok(p.includes('不改首帧、只重做视频或动作时用 regenerate_video'), 'the rule is spelled out')
    const i = parseInterpretation(answer({ op: 'regenerate_video', args: { shotId: 's1', promptDelta: '' } }), ctx)
    assert.equal(i.op, 'regenerate_video', 'an empty change is no change, not a refusal')
  })

})

describe('annotation fields (OCV5-591 A2-1b-2)', () => {
  it('kind, geometry and time ranges are checked', () => {
    assert.deepEqual(
      validateFields({ kind: 'box', geom: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, text: ' 改 ' }),
      {
        kind: 'box',
        tStartMs: null,
        tEndMs: null,
        geom: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        text: '改',
      },
    )
    assert.throws(() => validateFields({ kind: 'circle' }), /kind/)
    assert.throws(() => validateFields({ kind: 'point', geom: { x: 2, y: 0 } }), /geom/)
    assert.throws(
      () => validateFields({ kind: 'box', geom: { x: 0.8, y: 0, w: 0.5, h: 0.1 } }),
      /leaves/,
    )
    assert.throws(() => validateFields({ kind: 'range', tStartMs: 500 }), /range/)
    assert.throws(() => validateFields({ kind: 'range', tStartMs: 500, tEndMs: 100 }), /before/)
    assert.throws(() => validateFields({ kind: 'text', text: 'x'.repeat(1001) }), /1000/)
  })
})

describe('decide after an annotation redo (OCV5-591 A2-1b-2)', () => {
  const take = (over: Partial<DTake>): DTake => ({
    id: 't',
    ownerKind: 'shot_frame',
    ownerId: 's0',
    version: 1,
    provider: 'gpt-image',
    status: 'succeeded',
    blobSha: 'a'.repeat(64),
    qa: { passed: true, skipped: false, next: 'adopt', score: 0.9, avoid: [] },
    ...over,
  })
  const state = (over: Partial<DState> = {}): DState => ({
    status: 'running',
    hasPlanTask: false,
    inflight: 0,
    shots: [
      {
        id: 's0',
        ordinal: 0,
        status: 'generating',
        activeTakeId: null,
        frameTakeId: null,
        redo: { frame: 3, video: 2 },
      },
    ],
    lines: [],
    assets: [],
    takes: [],
    narrationVoiceId: 'v',
    musicSkippedNoted: true,
    canDispatch: { image: true, video: true, voice: true, music: false },
    canCompose: false,
    composeQueued: false,
    qa: { bible: true, shot_frame: true, shot_video: true },
    bibleCandidates: 1,
    qaQueued: [],
    ...over,
  })

  it('older frames and videos no longer count: an old passed video is not adopted', () => {
    const old = [
      take({ id: 'f1', version: 1 }),
      take({ id: 'v1', ownerKind: 'shot_video', version: 1 }),
    ]
    const acts = decide(state({ takes: old }))
    assert.ok(!acts.some((a) => a.type === 'adopt_video'))
    // No new frame yet (the annotation dispatched it and it is still live in practice): a frame
    // is dispatched only when none is on its way.
    assert.ok(acts.some((a) => a.type === 'dispatch' && a.dispatch.ownerKind === 'shot_frame'))
  })

  it('the new frame is judged, then its video; only a new video is adopted', () => {
    const takes = [take({ id: 'f1', version: 1 }), take({ id: 'f3', version: 3, qa: null })]
    assert.ok(decide(state({ takes })).some((a) => a.type === 'dispatch_qa' && a.takeId === 'f3'))
    const ready = [
      take({ id: 'f3', version: 3 }),
      take({ id: 'v1', ownerKind: 'shot_video', version: 1 }),
      take({ id: 'v2', ownerKind: 'shot_video', version: 2 }),
    ]
    const adopt = decide(state({ takes: ready })).find((a) => a.type === 'adopt_video')
    assert.deepEqual(adopt, { type: 'adopt_video', shotId: 's0', takeId: 'v2' })
  })
})
