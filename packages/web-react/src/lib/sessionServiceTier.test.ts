import { afterEach, describe, expect, it } from 'vitest'
import {
  readSessionServiceTier,
  serviceTierSessionKey,
  writeSessionServiceTier,
} from './sessionServiceTier'

describe('OCV5-434 sessionServiceTier(会话级、默认关、不继承)', () => {
  afterEach(() => localStorage.clear())

  it('默认标准;fast 只落本会话键,关 = 删键', () => {
    expect(readSessionServiceTier('s1')).toBeNull()
    writeSessionServiceTier('s1', 'fast')
    expect(readSessionServiceTier('s1')).toBe('fast')
    expect(localStorage.getItem(serviceTierSessionKey('s1'))).toBe('fast')
    expect(readSessionServiceTier('s2')).toBeNull()
    writeSessionServiceTier('s1', null)
    expect(localStorage.getItem(serviceTierSessionKey('s1'))).toBeNull()
    expect(readSessionServiceTier('s1')).toBeNull()
  })

  it('空会话不写盘;非法值按标准', () => {
    writeSessionServiceTier(undefined, 'fast')
    expect(localStorage.length).toBe(0)
    localStorage.setItem(serviceTierSessionKey('s3'), 'priority')
    expect(readSessionServiceTier('s3')).toBeNull()
  })
})
