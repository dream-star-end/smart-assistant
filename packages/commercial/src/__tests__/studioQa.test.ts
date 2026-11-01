/**
 * OCV5-591 A2-1b-1: visual QA — configuration, parsing, the verdict on every path, the contact
 * sheet, and how decide() gates frames / clips / bible images on it.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import sharp from 'sharp'

import { type DState, type DTake, decide } from '../media-studio/orchestrator/decide.js'
import { withAvoid } from '../media-studio/orchestrator/prompts.js'
import {
  MAX_QA_ATTEMPTS,
  QaParseError,
  type QaVerdict,
  buildQaPrompt,
  contactSheet,
  criteriaFor,
  bibleShotConflict,
  judgeQa,
  parseQa,
  qaAttemptsFor,
  qaConfigFromEnv,
  qaGates,
  qaReasonText,
} from '../media-studio/orchestrator/qa.js'

const verdict = (over: Partial<QaVerdict> = {}): QaVerdict => ({
  character: 0.9,
  scene: 0.9,
  action: 0.9,
  artifacts: 0.95,
  moderation: 'pass',
  confidence: 0.9,
  summary: '',
  issues: [],
  ...over,
})
const SHOT = criteriaFor('frame')

describe('QA configuration (A2-1b-1)', () => {
  it('on with Grok unless switched off; bible candidates 1 unless set to 2', () => {
    assert.deepEqual(qaConfigFromEnv({}, true), { enabled: true, bibleCandidates: 1 })
    assert.deepEqual(qaConfigFromEnv({}, false), { enabled: false, bibleCandidates: 1 })
    assert.equal(qaConfigFromEnv({ OC_STUDIO_QA: 'OFF' }, true).enabled, false)
    assert.equal(qaConfigFromEnv({ OC_STUDIO_BIBLE_CANDIDATES: '2' }, true).bibleCandidates, 2)
    assert.equal(qaConfigFromEnv({ OC_STUDIO_BIBLE_CANDIDATES: '5' }, true).bibleCandidates, 1)
  })

  it('a clip is gated only with the sandbox that takes its frames', () => {
    const on = { enabled: true, bibleCandidates: 1 as const }
    assert.deepEqual(qaGates({ qa: on, compose: { configured: () => false } }), {
      bible: true,
      shot_frame: true,
      shot_video: false,
    })
    assert.equal(qaGates({ qa: on, compose: { configured: () => true } }).shot_video, true)
    assert.deepEqual(qaGates({}), { bible: false, shot_frame: false, shot_video: false })
  })
})

describe('QA answer and verdict (A2-1b-1)', () => {
  it('parses a fenced JSON answer; rejects anything else', () => {
    const v = parseQa(`\`\`\`json\n${JSON.stringify(verdict({ summary: '好' }))}\n\`\`\``)
    assert.equal(v.summary, '好')
    assert.throws(() => parseQa('looks fine'), QaParseError)
    assert.throws(() => parseQa('{"character": 2}'), QaParseError)
    assert.throws(
      () => parseQa(JSON.stringify({ ...verdict(), moderation: 'maybe' })),
      QaParseError,
    )
  })

  it('criteria follow the target; a style image is judged on artifacts only', () => {
    assert.deepEqual(criteriaFor('frame'), ['character', 'scene', 'artifacts'])
    assert.deepEqual(criteriaFor('clip'), ['character', 'scene', 'action', 'artifacts'])
    assert.deepEqual(criteriaFor('bible', 'character'), ['character', 'artifacts'])
    assert.deepEqual(criteriaFor('bible', 'scene'), ['scene', 'artifacts'])
    assert.deepEqual(criteriaFor('bible', 'style'), ['artifacts'])
  })

  it('pass; below a threshold → redo; moderation and doubt → the user', () => {
    const none = { attempts: 0, bestScore: null }
    assert.deepEqual(judgeQa(verdict(), SHOT, none), {
      passed: true,
      score: 0.9,
      next: 'adopt',
      reason: 'passed',
    })
    assert.equal(judgeQa(verdict({ character: 0.7 }), SHOT, none).next, 'redo')
    assert.equal(judgeQa(verdict({ moderation: 'block' }), SHOT, none).reason, 'moderation_block')
    assert.equal(judgeQa(verdict({ moderation: 'review' }), SHOT, none).next, 'handoff')
    assert.equal(judgeQa(verdict({ confidence: 0.5 }), SHOT, none).reason, 'low_confidence')
    // A flagged take is never adopted, even with top scores.
    assert.equal(judgeQa(verdict({ moderation: 'block' }), SHOT, none).passed, false)
  })

  it('the redo cap always hands over, even while scores improve (plan r1 P1)', () => {
    // 0.50 → 0.60 → 0.70: each better, none passing; the third attempt must leave QA.
    assert.equal(
      judgeQa(verdict({ character: 0.5 }), SHOT, { attempts: 0, bestScore: null }).next,
      'redo',
    )
    assert.equal(
      judgeQa(verdict({ character: 0.6 }), SHOT, { attempts: 1, bestScore: 0.5 }).next,
      'redo',
    )
    const last = judgeQa(verdict({ character: 0.7 }), SHOT, {
      attempts: MAX_QA_ATTEMPTS - 1,
      bestScore: 0.6,
    })
    assert.deepEqual([last.next, last.reason], ['handoff', 'retries_exhausted'])
  })

  it('a still frame is not failed on action; a clip still is', () => {
    const none = { attempts: 0, bestScore: null }
    // The prod pattern: character 0.90, action 0.50 on a first frame.
    const still = verdict({ character: 0.9, scene: 0.84, action: 0.5, artifacts: 0.85 })
    assert.deepEqual(judgeQa(still, SHOT, none), {
      passed: true,
      score: 0.84,
      next: 'adopt',
      reason: 'passed',
    })
    assert.equal(judgeQa(still, criteriaFor('clip'), none).next, 'redo')
    // Artifacts still gate a frame.
    assert.equal(judgeQa(verdict({ action: 0.5, artifacts: 0.7 }), SHOT, none).next, 'redo')
  })

  it('a redo that does not beat the best earlier attempt stops early', () => {
    const j = judgeQa(verdict({ character: 0.6 }), SHOT, { attempts: 1, bestScore: 0.65 })
    assert.deepEqual([j.next, j.reason], ['handoff', 'no_improvement'])
  })
})

describe('QA prompt and contact sheet (A2-1b-1)', () => {
  const png = (w: number, h: number, r: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r, g: 80, b: 120 } } })
      .png()
      .toBuffer()

  it('one JPEG under the vision limits, candidates and references labelled', async () => {
    const one = await contactSheet([await png(1920, 1080, 10)], [await png(800, 800, 200)])
    assert.deepEqual([one.candidates, one.references], [['F1'], ['R1']])
    const meta = await sharp(one.jpeg).metadata()
    assert.equal(meta.format, 'jpeg')
    assert.ok(meta.width! < 2048 && one.jpeg.length < 6 * 1024 * 1024)
    const four = await contactSheet(
      await Promise.all([1, 2, 3, 4].map((i) => png(1080, 1920, i * 40))),
      await Promise.all([1, 2, 3, 4].map((i) => png(600, 600, i * 30))),
    )
    assert.deepEqual(four.candidates, ['F1', 'F2', 'F3', 'F4'])
    assert.deepEqual(four.references, ['R1', 'R2', 'R3'], 'at most 3 references')
    await assert.rejects(contactSheet([], []))
  })

  it('the prompt names the tiles and asks for strict JSON with moderation', () => {
    const p = buildQaPrompt({
      target: 'clip',
      shot: { framing: '中景', action: '狐狸穿过雪地' },
      bible: [{ kind: 'character', name: '小狐狸', descriptor: '橙红色毛，尾尖白' }],
      candidates: ['F1', 'F2', 'F3', 'F4'],
      references: ['R1'],
    })
    for (const s of [
      'F1、F2、F3、F4',
      'R1',
      '狐狸穿过雪地',
      '尾尖白',
      '"moderation"',
      '只输出一个 JSON',
    ])
      assert.ok(p.includes(s), s)
  })

  it('a frame is asked for the pose of the moment, a clip for the action across its frames', () => {
    const base = {
      shot: { framing: '中景', action: '狐狸穿过雪地' },
      bible: [],
      candidates: ['F1'],
      references: [],
    }
    const frame = buildQaPrompt({ ...base, target: 'frame' })
    assert.ok(frame.includes('这一瞬间的姿态和构图'))
    assert.ok(!frame.includes('连起来的动作'))
    const clip = buildQaPrompt({ ...base, target: 'clip' })
    assert.ok(clip.includes('这几帧连起来的动作'))
  })

  it('a redo prompt keeps its length limit and ends with what to avoid', () => {
    assert.equal(withAvoid('画面', []), '画面')
    const p = withAvoid('x'.repeat(4000), ['尾巴颜色不对', '手指畸形'])
    assert.ok(p.length <= 4000)
    assert.ok(p.endsWith('避免：尾巴颜色不对；手指畸形'))
  })
})

// ── decide with QA ─────────────────────────────────────────────────────────────────────────────

const take = (over: Partial<DTake>): DTake => ({
  id: 't',
  ownerKind: 'shot_frame',
  ownerId: 's0',
  version: 1,
  provider: 'gpt-image',
  status: 'succeeded',
  blobSha: 'a'.repeat(64),
  qa: null,
  ...over,
})
const judged = (passed: boolean, next: 'adopt' | 'redo' | 'handoff', avoid: string[] = []) => ({
  passed,
  skipped: false,
  next,
  score: passed ? 0.9 : 0.5,
  avoid,
})

function state(over: Partial<DState> = {}): DState {
  return {
    status: 'running',
    hasPlanTask: false,
    inflight: 0,
    shots: [{ id: 's0', ordinal: 0, status: 'generating', activeTakeId: null, frameTakeId: null }],
    lines: [],
    assets: [],
    takes: [],
    narrationVoiceId: 'male-qn-jingying',
    musicSkippedNoted: true,
    canDispatch: { image: true, video: true, voice: true, music: false },
    canCompose: false,
    composeQueued: false,
    qa: { bible: true, shot_frame: true, shot_video: true },
    bibleCandidates: 1,
    qaQueued: [],
    ...over,
  }
}
const kinds = (s: DState) =>
  decide(s).map((a) =>
    a.type === 'dispatch'
      ? `dispatch:${a.dispatch.ownerKind}`
      : a.type === 'dispatch_qa'
        ? `qa:${a.takeId}`
        : a.type === 'shot_status'
          ? `shot:${a.status}`
          : a.type === 'set_status'
            ? `project:${a.status}`
            : a.type,
  )

describe('decide with QA (A2-1b-1)', () => {
  it('a finished frame is judged before its video; the shot shows "qa"', () => {
    assert.deepEqual(kinds(state({ takes: [take({ id: 'f1' })] })), ['qa:f1', 'shot:qa'])
    // Already being judged: nothing new, and nothing built on it yet.
    const judging = state({
      shots: [{ id: 's0', ordinal: 0, status: 'qa', activeTakeId: null, frameTakeId: null }],
      takes: [take({ id: 'f1' })],
      qaQueued: ['f1'],
    })
    assert.deepEqual(kinds(judging), [])
  })

  it('a passed frame starts the video; a failed one is redone with what to avoid', () => {
    assert.deepEqual(kinds(state({ takes: [take({ id: 'f1', qa: judged(true, 'adopt') })] })), [
      'dispatch:shot_video',
    ])
    const redo = decide(
      state({ takes: [take({ id: 'f1', qa: judged(false, 'redo', ['尾巴颜色不对']) })] }),
    )
    const d = redo.find((a) => a.type === 'dispatch')
    assert.ok(d && d.type === 'dispatch')
    assert.equal(d.dispatch.ownerKind, 'shot_frame')
    assert.deepEqual(d.dispatch.avoid, ['尾巴颜色不对'])
  })

  it('a frame handed to the user blocks the project instead of redoing', () => {
    assert.deepEqual(kinds(state({ takes: [take({ id: 'f1', qa: judged(false, 'handoff') })] })), [
      'project:awaiting_user',
    ])
  })

  it("the user's picked frame is never judged, even before it has a verdict (code r1 P1)", () => {
    const s = state({
      shots: [
        { id: 's0', ordinal: 0, status: 'generating', activeTakeId: null, frameTakeId: 'f1' },
      ],
      takes: [take({ id: 'f1', qa: null })],
    })
    assert.deepEqual(kinds(s), ['dispatch:shot_video'])
  })

  it("the user's picked frame skips QA", () => {
    const s = state({
      shots: [
        { id: 's0', ordinal: 0, status: 'generating', activeTakeId: null, frameTakeId: 'f1' },
      ],
      takes: [take({ id: 'f1', qa: judged(false, 'handoff') })],
    })
    assert.deepEqual(kinds(s), ['dispatch:shot_video'])
  })

  it('a video is judged; only a passed one is adopted', () => {
    const frame = take({ id: 'f1', qa: judged(true, 'adopt') })
    const video = (qa: DTake['qa']) =>
      take({ id: 'v1', ownerKind: 'shot_video', provider: 'muse', qa })
    assert.deepEqual(kinds(state({ takes: [frame, video(null)] })), ['qa:v1', 'shot:qa'])
    assert.ok(
      kinds(state({ takes: [frame, video(judged(true, 'adopt'))] })).includes('adopt_video'),
    )
    assert.deepEqual(kinds(state({ takes: [frame, video(judged(false, 'redo'))] })), [
      'dispatch:shot_video',
    ])
  })

  it('takes QA did not run for (switched off / no sandbox) count as usable', () => {
    const frame = take({ id: 'f1', qa: judged(true, 'adopt') })
    const v = take({
      id: 'v1',
      ownerKind: 'shot_video',
      qa: { passed: false, skipped: true, next: null, score: null, avoid: [] },
    })
    assert.ok(kinds(state({ takes: [frame, v] })).includes('adopt_video'))
    // QA off for clips: an unjudged video is adopted as before.
    assert.ok(
      kinds(
        state({
          qa: { bible: true, shot_frame: true, shot_video: false },
          takes: [frame, take({ id: 'v1', ownerKind: 'shot_video' })],
        }),
      ).includes('adopt_video'),
    )
  })

  it('bible: N candidates per round, the best passing one locked, hand-off blocks', () => {
    const asset = { id: 'a1', kind: 'character' as const, locked: false, blobSha: null }
    const one = state({ shots: [], assets: [asset] })
    assert.deepEqual(kinds(one), ['dispatch:bible'])
    assert.deepEqual(kinds({ ...one, bibleCandidates: 2 }), ['dispatch:bible', 'dispatch:bible'])
    const b = (id: string, version: number, qa: DTake['qa']) =>
      take({ id, ownerKind: 'bible', ownerId: 'a1', version, qa })
    assert.deepEqual(kinds({ ...one, takes: [b('b1', 1, null), b('b2', 2, null)] }), [
      'qa:b1',
      'qa:b2',
    ])
    const lock = decide({
      ...one,
      takes: [
        b('b1', 1, { ...judged(true, 'adopt'), score: 0.8 }),
        b('b2', 2, { ...judged(true, 'adopt'), score: 0.95 }),
      ],
    }).find((a) => a.type === 'lock_bible')
    assert.deepEqual(lock, { type: 'lock_bible', assetId: 'a1', takeId: 'b2' })
    assert.deepEqual(kinds({ ...one, takes: [b('b1', 1, judged(false, 'handoff'))] }), [
      'project:awaiting_user',
    ])
  })
})

describe('QA conflicts and autonomy caps', () => {
  it('a dark bible against a bright shot is handed to the user before any redo', () => {
    const msg = bibleShotConflict(
      [{ descriptor: '深色背景，冷调' }],
      { framing: '浅灰墙面', action: '窗边晨光里转身' },
    )
    assert.equal(typeof msg, 'string')
    assert.match(msg!, /矛盾/)
    assert.equal(
      bibleShotConflict([{ descriptor: '深色背景' }], { framing: '夜景街道', action: '昏暗' }),
      null,
    )
    assert.equal(bibleShotConflict([{ descriptor: '深色背景也有晨光' }], { action: '窗边' }), null)
    assert.equal(bibleShotConflict([{ descriptor: '' }], { action: '晨光' }), null)
    assert.equal(
      bibleShotConflict([{ kind: 'character', descriptor: '深色西装的男子' }], { action: '窗边晨光' }),
      null,
    )
    const kept = bibleShotConflict(
      [
        { kind: 'character', descriptor: '浅色衬衫' },
        { kind: 'style', descriptor: '深色背景，冷调' },
      ],
      { framing: '浅灰墙面', action: '窗边晨光里转身' },
    )
    assert.equal(typeof kept, 'string')
    assert.match(kept!, /矛盾/)
  })

  it('attempt caps default to 3 and follow the autonomy env', () => {
    assert.equal(qaAttemptsFor('max', {}), 3)
    assert.equal(qaAttemptsFor('confirm', {}), 3)
    assert.equal(qaAttemptsFor('max', { OC_STUDIO_QA_ATTEMPTS_MAX: '5' }), 5)
    assert.equal(qaAttemptsFor('confirm', { OC_STUDIO_QA_ATTEMPTS_CONFIRM: '1' }), 1)
    assert.equal(qaAttemptsFor('max', { OC_STUDIO_QA_ATTEMPTS: '4' }), 4)
    assert.equal(qaAttemptsFor('confirm', { OC_STUDIO_QA_ATTEMPTS_CONFIRM: '0' }), 3)
    assert.equal(qaReasonText('retries_exhausted', 3), '自动重做了 2 次仍未通过')
    assert.equal(qaReasonText('retries_exhausted', 5), '自动重做了 4 次仍未通过')
    const none = { attempts: 0, bestScore: null }
    assert.equal(judgeQa(verdict({ character: 0.5 }), ['character', 'scene', 'artifacts'], none, 1).reason, 'retries_exhausted')
  })
})
