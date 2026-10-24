import { describe, expect, test } from 'vitest'
import { parseStudioPath, studioHref } from './path'

const ID = '11111111-2222-4333-8444-555555555555'
const SHOT = '22222222-3333-4444-8555-666666666666'

describe('studio path shot param (OCV5-593 FE-2)', () => {
  test('review links carry the shot and round-trip', () => {
    const r = { kind: 'project' as const, id: ID, page: 'review' as const, shot: SHOT }
    expect(studioHref(r)).toBe(`/studio/p/${ID}/review?shot=${SHOT}`)
    expect(parseStudioPath(`/studio/p/${ID}/review`, `?shot=${SHOT}`)).toEqual(r)
  })
  test('an invalid shot id is dropped', () => {
    expect(parseStudioPath(`/studio/p/${ID}/review`, '?shot=nope')).toEqual({
      kind: 'project',
      id: ID,
      page: 'review',
    })
  })
})
