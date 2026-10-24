import { describe, expect, test } from 'vitest'

import { composingFilm, creditsText, filmFor, filmKey, finalFilms, variantKey } from './final'
import type { StudioProjectView, StudioTake } from './types'

const t = (over: Partial<StudioTake>): StudioTake => ({
  id: 'x',
  ownerKind: 'final',
  ownerId: 'p',
  version: 1,
  provider: 'compose',
  model: 'ffmpeg',
  op: 'compose',
  status: 'succeeded',
  errorCode: null,
  costCredits: '0',
  qa: null,
  blobSha: 'a'.repeat(64),
  createdAt: '',
  finishedAt: null,
  ...over,
})
const fin = (id: string, version: number, key: string, over: Partial<StudioTake> = {}) =>
  t({
    id,
    version,
    final: { variant: null, variantKey: key, credits: null, srtSha: null },
    ...over,
  })
const view = (takes: StudioTake[]) => ({ takes }) as unknown as StudioProjectView

describe('final films by export format (OCV5-593 FE-6)', () => {
  test('keys match the backend; films from before formats are the default', () => {
    expect(variantKey({ resolution: 'vertical', subtitles: 'srt' })).toBe('vertical-srt')
    expect(filmKey(t({}))).toBe('1080p-burn')
    expect(
      filmKey(
        t({
          final: {
            variant: { resolution: '720p', subtitles: 'none' },
            variantKey: null,
            credits: null,
            srtSha: null,
          },
        }),
      ),
    ).toBe('720p-none')
  })

  test('finalFilms: finished films with a file, newest first', () => {
    const films = finalFilms(
      view([
        fin('a', 1, '1080p-burn'),
        fin('b', 3, '720p-burn'),
        fin('c', 2, '720p-burn', { status: 'running' }),
        fin('d', 4, '720p-burn', { blobSha: null }),
        t({ ownerKind: 'music', id: 'm' }),
      ]),
    )
    expect(films.map((f) => f.id)).toEqual(['b', 'a'])
  })

  test('filmFor: newest for its own format; others only once confirmed or freshly composed', () => {
    const films = [
      fin('v3', 3, 'vertical-burn'),
      fin('v2', 2, '720p-burn'),
      fin('v1', 1, '1080p-burn'),
    ]
    expect(filmFor(films, 'vertical-burn', undefined, undefined)?.id).toBe('v3')
    expect(filmFor(films, '720p-burn', undefined, undefined)).toBeNull()
    expect(filmFor(films, '720p-burn', { takeId: 'v2', latestId: 'v3' }, undefined)?.id).toBe('v2')
    // Confirmed while v2 was newest; v3 has landed since: no longer known current (r1 P1).
    expect(filmFor(films, '720p-burn', { takeId: 'v2', latestId: 'v2' }, undefined)).toBeNull()
    // Asked after v2 existed: v2 is not the answer, a newer 720p film is.
    expect(filmFor(films, '720p-burn', undefined, 2)).toBeNull()
    expect(filmFor([fin('v4', 4, '720p-burn'), ...films], '720p-burn', undefined, 2)?.id).toBe('v4')
  })

  test('composingFilm: a queued / running film of that format', () => {
    const v = view([fin('r', 2, '720p-srt', { status: 'running' }), fin('a', 1, '1080p-burn')])
    expect(composingFilm(v, '720p-srt')?.id).toBe('r')
    expect(composingFilm(v, '1080p-burn')).toBeNull()
  })

  test('creditsText keeps each attribution verbatim', () => {
    const text = creditsText('冬日来客', [
      {
        kind: 'music',
        title: 'Wallpaper',
        attributionText: 'line 1\nline 2',
        license: 'CC BY 4.0',
      },
    ])
    expect(text).toBe(
      '冬日来客 — 署名 / Credits\n\n音乐：Wallpaper\nline 1\nline 2\n协议：CC BY 4.0\n',
    )
  })
})
