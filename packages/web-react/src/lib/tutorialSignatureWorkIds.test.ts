import { describe, expect, it } from 'vitest'
import { SIGNATURE_WORK_IDS, isSignatureWorkId } from './tutorialSignatureWorkIds'
import { SIGNATURE_WORKS } from './tutorialSignatureWorks'

describe('tutorialSignatureWorkIds（首屏轻量 id 表）', () => {
  it('与 SIGNATURE_WORKS 的 id 集合完全一致（防漂移）', () => {
    const light = [...SIGNATURE_WORK_IDS].sort()
    const heavy = SIGNATURE_WORKS.map((work) => work.id).sort()
    expect(light).toEqual(heavy)
    expect(new Set(heavy).size).toBe(heavy.length)
  })

  it('isSignatureWorkId 只认白名单', () => {
    expect(isSignatureWorkId('planet')).toBe(true)
    expect(isSignatureWorkId('gravity')).toBe(true)
    expect(isSignatureWorkId('moon')).toBe(false)
    expect(isSignatureWorkId('')).toBe(false)
    expect(isSignatureWorkId(null)).toBe(false)
    expect(isSignatureWorkId(undefined)).toBe(false)
  })
})
