import { describe, expect, test } from 'vitest'
import { sessionTitleFromText } from './sessionTitle'

describe('sessionTitleFromText', () => {
  test('与服务端首条消息标题规则一致', () => {
    expect(sessionTitleFromText('')).toBe('新会话')
    expect(sessionTitleFromText('  保留首尾空格  ')).toBe('  保留首尾空格  ')

    const fifty = '甲'.repeat(50)
    expect(sessionTitleFromText(fifty)).toBe(fifty)
    expect(sessionTitleFromText(`${fifty}乙`)).toBe(`${fifty}…`)
  })
})
