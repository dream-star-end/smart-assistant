import { describe, expect, it } from 'vitest'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import { parsePanelParam, parseTutorialTopic, withPanelParams } from './useAppRoute'

describe('教程 URL 深链', () => {
  it('只接受稳定的 help topic id，未知值回退由 App 处理', () => {
    const valid = new URLSearchParams('panel=help&topic=github-repository')
    expect(parsePanelParam(valid)).toBe('help')
    expect(parseTutorialTopic(valid)).toBe(PRODUCT_CAPABILITIES.github.id)
    expect(parseTutorialTopic(new URLSearchParams('panel=help&topic=removed-feature'))).toBeNull()
    expect(
      parseTutorialTopic(new URLSearchParams('panel=settings&topic=github-repository')),
    ).toBeNull()
  })

  it('往返保留无关 query，并在离开 help 时清理 topic', () => {
    const source = new URLSearchParams('campaign=summer&panel=settings')
    const help = withPanelParams(source, 'help', PRODUCT_CAPABILITIES.teamMode.id)
    expect(help.toString()).toContain('campaign=summer')
    expect(help.get('panel')).toBe('help')
    expect(help.get('topic')).toBe('team-mode')

    const settings = withPanelParams(help, 'settings')
    expect(settings.get('campaign')).toBe('summer')
    expect(settings.get('panel')).toBe('settings')
    expect(settings.has('topic')).toBe(false)
  })

  it('help 未给 topic 时规范化为默认入门教程', () => {
    const value = withPanelParams(new URLSearchParams(), 'help')
    expect(value.get('topic')).toBe(PRODUCT_CAPABILITIES.chatBasics.id)
  })
})
