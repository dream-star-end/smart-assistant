import { describe, expect, it } from 'vitest'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import {
  parsePanelParam,
  parseTutorialCase,
  parseTutorialTopic,
  tutorialHref,
  withPanelParams,
} from './useAppRoute'

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

  it('help 未给选择时保持案例总览，不再强制跳到功能教程', () => {
    const value = withPanelParams(new URLSearchParams(), 'help')
    expect(value.get('panel')).toBe('help')
    expect(value.has('topic')).toBe(false)
    expect(value.has('case')).toBe(false)
  })

  it('案例深链只接受稳定 id，并与旧 topic 互斥且案例优先', () => {
    const both = new URLSearchParams(
      'campaign=summer&panel=help&topic=chat-basics&case=research-bike-demand',
    )
    expect(parseTutorialCase(both)).toBe('research-bike-demand')
    expect(parseTutorialTopic(both)).toBeNull()
    expect(
      parseTutorialCase(new URLSearchParams('panel=help&case=unknown-case')),
    ).toBeNull()

    const caseLink = withPanelParams(
      new URLSearchParams('campaign=summer&topic=chat-basics'),
      'help',
      null,
      'coding-swe-bench-fix',
    )
    expect(caseLink.get('campaign')).toBe('summer')
    expect(caseLink.get('case')).toBe('coding-swe-bench-fix')
    expect(caseLink.has('topic')).toBe(false)

    const legacy = withPanelParams(
      caseLink,
      'help',
      PRODUCT_CAPABILITIES.github.id,
    )
    expect(legacy.get('topic')).toBe('github-repository')
    expect(legacy.has('case')).toBe(false)
  })

  it('案例和功能链接保留 pathname、hash 与所有无关 query', () => {
    const source = {
      pathname: '/s/keep-session',
      search: '?campaign=summer&invite=abc&panel=settings&topic=chat-basics',
      hash: '#result',
    }
    expect(tutorialHref(source, null, 'coding-swe-bench-fix')).toBe(
      '/s/keep-session?campaign=summer&invite=abc&panel=help&case=coding-swe-bench-fix#result',
    )
    expect(tutorialHref(source, PRODUCT_CAPABILITIES.github.id)).toBe(
      '/s/keep-session?campaign=summer&invite=abc&panel=help&topic=github-repository#result',
    )
  })
})
