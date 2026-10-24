import { describe, expect, test } from 'vitest'
import { eventText, rulerTicks, shotCard, timeline } from './model'
import type { StudioProjectView, StudioShot, StudioTake } from './types'

const shot = (i: number, over: Partial<StudioShot> = {}): StudioShot => ({
  id: `s${i}`,
  ordinal: i,
  spec: { title: `T${i}`, durationSec: 5 },
  status: 'planned',
  activeTakeId: null,
  ...over,
})
const take = (over: Partial<StudioTake>): StudioTake => ({
  id: 't',
  ownerKind: 'shot_video',
  ownerId: 's0',
  version: 1,
  provider: 'muse-video',
  model: 'muse-video',
  op: 'video.from_image',
  status: 'succeeded',
  errorCode: null,
  costCredits: '50',
  qa: null,
  blobSha: 'a'.repeat(64),
  createdAt: '',
  finishedAt: null,
  ...over,
})
const view = (over: Partial<StudioProjectView>): StudioProjectView => ({
  project: {} as never,
  shots: [],
  lines: [],
  assets: [],
  takes: [],
  events: [],
  ...over,
})

describe('shotCard (OCV5-593)', () => {
  test('ready shot shows its QA score and the newest media', () => {
    const v = view({
      shots: [shot(0, { status: 'ready' })],
      takes: [take({ id: 'a', version: 1 }), take({ id: 'b', version: 2, qa: { score: 0.91 } })],
    })
    const m = shotCard(v, v.shots[0]!)
    expect(m.tone).toBe('ok')
    expect(m.chip).toBe('通过 0.91')
    expect(m.shown?.id).toBe('b')
    expect(m.versions).toBe(2)
    expect(m.costCredits).toBe(100)
  })

  test('the adopted take wins over a newer one; needs_user / queued / running tones', () => {
    const v = view({
      shots: [
        shot(0, { status: 'needs_user', activeTakeId: 'a' }),
        shot(1),
        shot(2, { status: 'generating' }),
      ],
      takes: [
        take({ id: 'a', version: 1 }),
        take({ id: 'b', version: 2 }),
        take({ id: 'q', ownerId: 's1', status: 'queued', blobSha: null }),
      ],
    })
    expect(shotCard(v, v.shots[0]!).shown?.id).toBe('a')
    expect(shotCard(v, v.shots[0]!).tone).toBe('needs')
    expect(shotCard(v, v.shots[1]!).tone).toBe('queued')
    expect(shotCard(v, v.shots[2]!).tone).toBe('gen')
  })
})

describe('timeline (OCV5-593)', () => {
  test('clips follow shot durations; lines sit inside their shot; music is the newest music take', () => {
    const v = view({
      shots: [shot(1, { spec: { durationSec: 4 } }), shot(0, { spec: { durationSec: 6 } })],
      lines: [
        {
          id: 'l1',
          shotId: 's0',
          ordinal: 0,
          speakerAssetId: null,
          text: 'a',
          emotion: null,
          speed: null,
          status: 'ready',
          activeTakeId: null,
        },
        {
          id: 'l2',
          shotId: 's0',
          ordinal: 1,
          speakerAssetId: null,
          text: 'b',
          emotion: null,
          speed: null,
          status: 'ready',
          activeTakeId: null,
        },
        {
          id: 'l3',
          shotId: null,
          ordinal: 2,
          speakerAssetId: null,
          text: 'c',
          emotion: null,
          speed: null,
          status: 'ready',
          activeTakeId: null,
        },
      ],
      takes: [
        take({ id: 'm1', ownerKind: 'music', ownerId: 'p', version: 1 }),
        take({ id: 'm2', ownerKind: 'music', ownerId: 'p', version: 2 }),
      ],
    })
    const tl = timeline(v)
    expect(tl.total).toBe(10)
    expect(tl.clips.map((c) => [c.shot.id, c.start, c.end])).toEqual([
      ['s0', 0, 6],
      ['s1', 6, 10],
    ])
    expect(tl.lines.map((l) => l.line.id)).toEqual(['l1', 'l2'])
    expect(tl.lines[0]!.start).toBeCloseTo(0.15)
    expect(tl.lines[1]!.end).toBeCloseTo(5.85)
    expect(tl.music?.id).toBe('m2')
  })

  test('a shot without a duration counts as 5 s; ruler steps scale with length', () => {
    expect(timeline(view({ shots: [shot(0, { spec: {} })] })).total).toBe(5)
    expect(rulerTicks(10)).toEqual([0, 2, 4, 6, 8, 10])
    expect(rulerTicks(37)).toEqual([0, 5, 10, 15, 20, 25, 30, 35])
    expect(rulerTicks(0)).toEqual([0])
  })
})

describe('eventText', () => {
  test('payload message first, then known types, then the raw type', () => {
    expect(
      eventText({ id: '1', ts: '', type: 'shot.ready', payload: { message: '#2 通过' } }),
    ).toBe('#2 通过')
    expect(eventText({ id: '1', ts: '', type: 'project.created', payload: null })).toBe(
      '项目已创建',
    )
    expect(eventText({ id: '1', ts: '', type: 'x.y', payload: null })).toBe('x.y')
  })
})
