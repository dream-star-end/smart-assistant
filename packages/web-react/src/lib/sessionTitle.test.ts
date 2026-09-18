import { describe, expect, test } from 'vitest'
import { EMPTY_SESSION_TITLE, sessionTitleFromText } from './sessionTitle'

describe('sessionTitleFromText', () => {
  test('与服务端首条消息标题规则一致', () => {
    // ST-01：空标题回退与侧栏 / 列表 / 建行统一为「新对话」，不再独自叫「新会话」。
    expect(EMPTY_SESSION_TITLE).toBe('新对话')
    expect(sessionTitleFromText('')).toBe('新对话')
    expect(sessionTitleFromText('  保留首尾空格  ')).toBe('  保留首尾空格  ')

    const fifty = '甲'.repeat(50)
    expect(sessionTitleFromText(fifty)).toBe(fifty)
    expect(sessionTitleFromText(`${fifty}乙`)).toBe(`${fifty}…`)
  })
})
