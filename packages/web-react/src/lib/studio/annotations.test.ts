import { afterEach, describe, expect, test } from 'vitest'
import { annotationLabel, boxFromDrag, loadDrafts, rangeFromDrag, saveDrafts } from './annotations'

afterEach(() => sessionStorage.clear())

describe('annotation drafts (OCV5-593 FE-2b)', () => {
  test('boxes normalise any drag direction, clamp to the media and ignore tiny drags', () => {
    expect(boxFromDrag({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 })).toEqual({
      x: 0.2,
      y: 0.3,
      w: 0.39999999999999997,
      h: 0.39999999999999997,
    })
    expect(boxFromDrag({ x: -0.2, y: 0.5 }, { x: 0.3, y: 1.4 })).toEqual({
      x: 0,
      y: 0.5,
      w: 0.3,
      h: 0.5,
    })
    expect(boxFromDrag({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.6 })).toBeNull()
  })

  test('time ranges clamp to the clip and need at least 0.2 s', () => {
    expect(rangeFromDrag(3.2, 1.8, 6)).toEqual({ tStart: 1.8, tEnd: 3.2 })
    expect(rangeFromDrag(-1, 9, 6)).toEqual({ tStart: 0, tEnd: 6 })
    expect(rangeFromDrag(2, 2.1, 6)).toBeNull()
    expect(rangeFromDrag(1, 2, 0)).toBeNull()
  })

  test('labels', () => {
    const base = { id: 'a', takeId: 't', text: '', createdAt: 0 }
    expect(annotationLabel({ ...base, kind: 'point', tStart: 4.6 })).toBe('点 · 00:04.6')
    expect(annotationLabel({ ...base, kind: 'range', tStart: 1.8, tEnd: 3.2 })).toBe(
      '时间段 · 00:01.8–00:03.2',
    )
  })

  test('drafts persist per project in this tab and survive junk', () => {
    const d = {
      id: 'a',
      takeId: 't',
      kind: 'box' as const,
      x: 0,
      y: 0,
      w: 0.5,
      h: 0.5,
      tStart: 0,
      text: 'x',
      createdAt: 1,
    }
    saveDrafts('p1', [d])
    expect(loadDrafts('p1')).toEqual([d])
    expect(loadDrafts('p2')).toEqual([])
    sessionStorage.setItem('oc.studio.annotationDrafts.p3', '{bad json')
    expect(loadDrafts('p3')).toEqual([])
    sessionStorage.setItem('oc.studio.annotationDrafts.p4', JSON.stringify([{ id: 1 }, d]))
    expect(loadDrafts('p4')).toEqual([d])
    saveDrafts('p1', [])
    expect(sessionStorage.getItem('oc.studio.annotationDrafts.p1')).toBeNull()
  })
})
