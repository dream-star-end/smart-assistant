import { describe, expect, test } from 'vitest'
import { isStudioPath, parseStudioPath, studioHref } from './path'

const ID = '11111111-2222-4333-8444-555555555555'

describe('studio paths (OCV5-593)', () => {
  test('recognises only /studio and below', () => {
    expect(isStudioPath('/studio')).toBe(true)
    expect(isStudioPath('/studio/p/x')).toBe(true)
    expect(isStudioPath('/studios')).toBe(false)
    expect(isStudioPath('/')).toBe(false)
  })

  test('parses home, project default page and named pages', () => {
    expect(parseStudioPath('/studio')).toEqual({ kind: 'home' })
    expect(parseStudioPath('/studio/')).toEqual({ kind: 'home' })
    expect(parseStudioPath(`/studio/p/${ID}`)).toEqual({ kind: 'project', id: ID, page: 'board' })
    expect(parseStudioPath(`/studio/p/${ID}/voice`)).toEqual({
      kind: 'project',
      id: ID,
      page: 'voice',
    })
  })

  test('rejects unknown shapes', () => {
    for (const p of [
      '/studio/x',
      '/studio/p/not-a-uuid',
      `/studio/p/${ID}/nope`,
      `/studio/p/${ID}/voice/x`,
      '/',
    ]) {
      expect(parseStudioPath(p)).toBeNull()
    }
  })

  test('href round-trips', () => {
    for (const page of ['brief', 'board', 'music'] as const) {
      const r = { kind: 'project' as const, id: ID, page }
      expect(parseStudioPath(studioHref(r))).toEqual(r)
    }
    expect(studioHref({ kind: 'home' })).toBe('/studio')
  })
})
