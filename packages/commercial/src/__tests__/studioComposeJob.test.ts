/**
 * OCV5-591 A2-1c: one compose run's inputs — timeline, narration placement, subtitles, canvas per
 * aspect / export format, music with its edit and credits — and the final QA.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCommand } from '../media-studio/compose/spec.js'
import {
  buildComposeJob,
  canvasFor,
  finalQa,
  parseVariant,
  variantKey,
} from '../media-studio/orchestrator/composeJob.js'

const sha = (c: string) => c.repeat(64)
const shots = [
  { id: 's0', ordinal: 0, durationSec: 5, videoSha: sha('a'), videoSec: 10 },
  { id: 's1', ordinal: 1, durationSec: 6, videoSha: sha('b'), videoSec: 4 },
]
const lines = [
  {
    id: 'l0',
    shotId: 's0',
    ordinal: 0,
    text: '清晨，雪松林醒来。',
    audioSha: sha('c'),
    audioMime: 'audio/mpeg',
    audioSec: 2,
  },
  {
    id: 'l1',
    shotId: 's0',
    ordinal: 1,
    text: '一只红狐停下脚步。',
    audioSha: sha('d'),
    audioMime: 'audio/mpeg',
    audioSec: 1.5,
  },
  {
    id: 'l2',
    shotId: 's1',
    ordinal: 2,
    text: '它冲进了雪里。',
    audioSha: sha('e'),
    audioMime: 'audio/mpeg',
    audioSec: 3,
  },
]

describe('compose job (OCV5-591 A2-1c)', () => {
  it('lays shots end to end (never past the video), narration back to back by its real length', () => {
    const job = buildComposeJob({
      aspect: '16:9',
      variant: { resolution: '1080p', subtitles: 'burn' },
      shots,
      lines,
      music: null,
    })
    assert.deepEqual(job.spec.clips, [
      { file: 'v0.mp4', inSec: 0, outSec: 5 },
      { file: 'v1.mp4', inSec: 0, outSec: 4 },
    ])
    assert.equal(job.expectedSec, 9)
    assert.deepEqual(job.spec.voice, [
      { file: 'l0.mp3', startSec: 0.15 },
      { file: 'l1.mp3', startSec: 2.45 },
      { file: 'l2.mp3', startSec: 5.15 },
    ])
    assert.deepEqual(job.files, {
      'v0.mp4': sha('a'),
      'v1.mp4': sha('b'),
      'l0.mp3': sha('c'),
      'l1.mp3': sha('d'),
      'l2.mp3': sha('e'),
    })
    assert.deepEqual(job.spec.subtitles, { file: 'subs.ass', burn: true })
    assert.match(
      job.texts['subs.ass']!,
      /Dialogue: 0,0:00:00\.15,0:00:02\.15,Default,,0,0,0,,清晨，雪松林醒来。/,
    )
    assert.equal(job.srt, null)
    assert.deepEqual(job.spec.loudness, { targetLufs: -16 })
    // The sandbox accepts it as is.
    assert.equal(buildCommand({ op: 'compose', spec: job.spec }).argv[0], 'ffmpeg')
  })

  it('narration that does not fit its shot, or has no known length, is refused — never overlapped (plan r1 P1)', () => {
    const long = [
      {
        id: 'x0',
        shotId: 's1',
        ordinal: 0,
        text: 'a',
        audioSha: sha('c'),
        audioMime: 'audio/mpeg',
        audioSec: 2.5,
      },
      {
        id: 'x1',
        shotId: 's1',
        ordinal: 1,
        text: 'b',
        audioSha: sha('d'),
        audioMime: 'audio/mpeg',
        audioSec: 1.5,
      },
    ]
    assert.throws(
      () =>
        buildComposeJob({
          aspect: '16:9',
          variant: { resolution: '1080p', subtitles: 'burn' },
          shots,
          lines: long,
          music: null,
        }),
      (e: Error & { shotId?: string }) =>
        e.shotId === 's1' && /#2 的台词总长 4\.45 秒，超过镜头 4 秒/.test(e.message),
    )
    const unknown = [{ ...lines[0]!, audioSec: null }]
    assert.throws(
      () =>
        buildComposeJob({
          aspect: '16:9',
          variant: { resolution: '1080p', subtitles: 'burn' },
          shots,
          lines: unknown,
          music: null,
        }),
      /时长未知/,
    )
  })

  it('subtitle choices: .srt next to the film, or none', () => {
    const srt = buildComposeJob({
      aspect: '16:9',
      variant: { resolution: '720p', subtitles: 'srt' },
      shots,
      lines,
      music: null,
    })
    assert.equal(srt.spec.subtitles, undefined)
    assert.match(srt.srt!, /^1\n00:00:00,150 --> 00:00:02,150\n清晨，雪松林醒来。/)
    const none = buildComposeJob({
      aspect: '16:9',
      variant: { resolution: '720p', subtitles: 'none' },
      shots,
      lines,
      music: null,
    })
    assert.equal(none.spec.subtitles, undefined)
    assert.equal(none.srt, null)
    assert.ok(none.spec.voice?.length, 'narration stays; only the captions go')
  })

  it('canvas per aspect and export format; 竖屏 is always 9:16; the sandbox takes all of them', () => {
    assert.deepEqual(canvasFor('16:9', '1080p'), { width: 1920, height: 1080 })
    assert.deepEqual(canvasFor('16:9', '720p'), { width: 1280, height: 720 })
    assert.deepEqual(canvasFor('16:9', 'vertical'), { width: 1080, height: 1920 })
    assert.deepEqual(canvasFor('9:16', '720p'), { width: 720, height: 1280 })
    assert.deepEqual(canvasFor('1:1', '1080p'), { width: 1080, height: 1080 })
    assert.deepEqual(canvasFor('1:1', '720p'), { width: 720, height: 720 })
    for (const aspect of ['16:9', '9:16', '1:1'] as const)
      for (const resolution of ['1080p', '720p', 'vertical'] as const) {
        const job = buildComposeJob({
          aspect,
          variant: { resolution, subtitles: 'burn' },
          shots,
          lines,
          music: null,
        })
        assert.doesNotThrow(
          () => buildCommand({ op: 'compose', spec: job.spec }),
          `${aspect} ${resolution}`,
        )
      }
  })

  it('music comes with its edit; CC BY music is listed for the credits', () => {
    const job = buildComposeJob({
      aspect: '16:9',
      variant: { resolution: '1080p', subtitles: 'burn' },
      shots,
      lines,
      music: {
        sha: sha('f'),
        mime: 'audio/mpeg',
        edit: { inSec: 8, outSec: 14, loop: { crossfadeSec: 1 } },
        license: {
          license: 'CC-BY-4.0',
          title: 'Easy Lemon',
          attributionRequired: true,
          attributionText: '"Easy Lemon" Kevin MacLeod (incompetech.com)',
        },
      },
    })
    assert.deepEqual(job.spec.music, {
      file: 'm.mp3',
      inSec: 8,
      outSec: 14,
      loop: { crossfadeSec: 1 },
    })
    assert.equal(job.files['m.mp3'], sha('f'))
    assert.deepEqual(job.credits, [
      {
        kind: 'music',
        title: 'Easy Lemon',
        attributionText: '"Easy Lemon" Kevin MacLeod (incompetech.com)',
        license: 'CC-BY-4.0',
      },
    ])
    const cc0 = buildComposeJob({
      aspect: '16:9',
      variant: { resolution: '1080p', subtitles: 'burn' },
      shots,
      lines,
      music: {
        sha: sha('f'),
        mime: 'audio/mpeg',
        edit: {},
        license: { license: 'CC0-1.0', attributionRequired: false },
      },
    })
    assert.deepEqual(cc0.credits, [])
  })

  it('export variants parse strictly; final QA checks streams and length', () => {
    assert.deepEqual(parseVariant({ resolution: 'vertical', subtitles: 'srt' }), {
      resolution: 'vertical',
      subtitles: 'srt',
    })
    assert.equal(parseVariant({ resolution: '4k', subtitles: 'burn' }), null)
    assert.equal(parseVariant(null), null)
    assert.equal(variantKey({ resolution: '720p', subtitles: 'none' }), '720p-none')
    const ok = finalQa(
      { format: { duration: '9.04' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] },
      9,
    )
    assert.deepEqual(ok, {
      durationSec: 9.04,
      expectedSec: 9,
      hasVideo: true,
      hasAudio: true,
      passed: true,
    })
    assert.equal(
      finalQa({ format: { duration: '7' }, streams: [{ codec_type: 'video' }] }, 9).passed,
      false,
    )
    assert.equal(finalQa({}, 9).passed, false)
  })
})
