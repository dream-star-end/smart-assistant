import { afterEach, describe, expect, it } from 'vitest'
import {
  readSessionServiceTier,
  serviceTierSessionKey,
  writeSessionServiceTier,
} from './sessionServiceTier'

describe('OCV5-434 / OCV5-798 sessionServiceTier(会话级、默认关、不继承)', () => {
  afterEach(() => localStorage.clear())

  it('默认标准;fast/ultrafast 只落本会话键,关 = 删键', () => {
    expect(readSessionServiceTier('s1')).toBeNull()
    writeSessionServiceTier('s1', 'fast')
    expect(readSessionServiceTier('s1')).toBe('fast')
    expect(localStorage.getItem(serviceTierSessionKey('s1'))).toBe('fast')
    writeSessionServiceTier('s1', 'ultrafast')
    expect(readSessionServiceTier('s1')).toBe('ultrafast')
    expect(localStorage.getItem(serviceTierSessionKey('s1'))).toBe('ultrafast')
    expect(readSessionServiceTier('s2')).toBeNull()
    writeSessionServiceTier('s1', null)
    expect(localStorage.getItem(serviceTierSessionKey('s1'))).toBeNull()
    expect(readSessionServiceTier('s1')).toBeNull()
  })

  it('空会话不写盘;非法值按标准', () => {
    writeSessionServiceTier(undefined, 'fast')
    writeSessionServiceTier(undefined, 'ultrafast')
    expect(localStorage.length).toBe(0)
    localStorage.setItem(serviceTierSessionKey('s3'), 'priority')
    expect(readSessionServiceTier('s3')).toBeNull()
  })
})
