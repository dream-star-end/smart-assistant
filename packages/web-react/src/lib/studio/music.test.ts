import { describe, expect, test } from 'vitest'

import { compactEdit, editProblem, musicSources, soundtrack, tempoForShots } from './music'
import type { StudioProjectView, StudioTake } from './types'

const take = (id: string, version: number, status: StudioTake['status'] = 'succeeded') =>
  ({
    id,
    ownerKind: 'music',
    version,
    status,
    blobSha: status === 'succeeded' ? 'a'.repeat(64) : null,
  }) as StudioTake

describe('music helpers (OCV5-593 FE-5)', () => {
  test('tempo band follows the average shot length', () => {
    expect(tempoForShots([5, 5, 6])).toEqual({ min: 64, max: 96, avgSec: 5.3 })
    expect(tempoForShots([8, 7])).toEqual({ min: 60, max: 84, avgSec: 7.5 })
    expect(tempoForShots([2, 2])).toEqual({ min: 110, max: 140, avgSec: 2 })
    expect(tempoForShots([])).toBeNull()
  })

  test('the server rules, checked before saving', () => {
    expect(editProblem({}, 30)).toBeNull()
    expect(editProblem({ startSec: 5, endSec: 5.5 }, 30)).toMatch(/至少要放 1 秒/)
    expect(editProblem({ inSec: 3, outSec: 3.5 }, 30)).toMatch(/至少 1 秒/)
    expect(editProblem({ loop: {} }, 30)).toMatch(/先截取/)
    expect(editProblem({ outSec: 3, loop: { crossfadeSec: 2 } }, 30)).toMatch(/一半/)
    expect(editProblem({ outSec: 1, loop: {} }, 60)).toMatch(/超过 24 次/)
    expect(editProblem({ outSec: 3, loop: {} }, 60)).toBeNull()
  })

  test('only what the user changed is stored', () => {
    expect(
      compactEdit({ gainDb: -8, duckDb: 6, fadeInSec: 1, inSec: 4, startSec: undefined }),
    ).toEqual({ duckDb: 6, inSec: 4 })
  })

  test('the soundtrack is the take the project points at, else the newest finished one', () => {
    const v = (settings: Record<string, unknown>) =>
      ({
        project: { settings },
        takes: [take('a', 1), take('b', 2), take('c', 3, 'running')],
      }) as unknown as StudioProjectView
    expect(soundtrack(v({ musicTakeId: 'a' }))?.id).toBe('a')
    expect(soundtrack(v({}))?.id).toBe('b')
    expect(soundtrack(v({ musicTakeId: 'gone' }))?.id).toBe('b')
  })

  test('sources come from /providers; an AI generator only when one offers music.generate', () => {
    const view = {
      kinds: [
        {
          kind: 'music' as const,
          state: 'ready' as const,
          providers: [
            {
              id: 'music-catalog',
              label: '',
              state: 'ready' as const,
              models: [{ id: 's', label: '', ops: ['music.fetch'] }],
            },
            {
              id: 'music-mine',
              label: '',
              state: 'disabled' as const,
              models: [{ id: 's', label: '', ops: ['music.fetch'] }],
            },
          ],
        },
      ],
    }
    expect(musicSources(view)).toEqual({
      catalog: { id: 'music-catalog', state: 'ready' },
      mine: { id: 'music-mine', state: 'disabled' },
      ai: null,
    })
  })
})
