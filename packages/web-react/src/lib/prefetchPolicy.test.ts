import { describe, expect, test } from 'vitest'
import { readNetworkInformation, shouldPrefetchCenters } from './prefetchPolicy'

describe('shouldPrefetchCenters(S-16 空闲预取的网络判断)', () => {
  test('无 connection 信息(Safari / Firefox)→ 照常预取,行为不退化', () => {
    expect(shouldPrefetchCenters(undefined)).toBe(true)
    expect(shouldPrefetchCenters(null)).toBe(true)
    expect(shouldPrefetchCenters({})).toBe(true)
  })

  test('省流量模式 → 不预取', () => {
    expect(shouldPrefetchCenters({ saveData: true })).toBe(false)
    expect(shouldPrefetchCenters({ saveData: true, effectiveType: '4g' })).toBe(false)
  })

  test('2g / slow-2g → 不预取;3g / 4g 照常', () => {
    expect(shouldPrefetchCenters({ effectiveType: '2g' })).toBe(false)
    expect(shouldPrefetchCenters({ effectiveType: 'slow-2g' })).toBe(false)
    expect(shouldPrefetchCenters({ effectiveType: '3g' })).toBe(true)
    expect(shouldPrefetchCenters({ effectiveType: '4g', saveData: false })).toBe(true)
  })

  test('readNetworkInformation 兼容前缀与缺席', () => {
    expect(readNetworkInformation(undefined)).toBeUndefined()
    expect(readNetworkInformation({} as Navigator)).toBeUndefined()
    const conn = { saveData: true }
    expect(readNetworkInformation({ connection: conn } as unknown as Navigator)).toBe(conn)
    expect(readNetworkInformation({ webkitConnection: conn } as unknown as Navigator)).toBe(conn)
  })
})
