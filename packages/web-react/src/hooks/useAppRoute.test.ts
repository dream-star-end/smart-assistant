import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import {
  parseBoardPath,
  parseBoardTicket,
  parseBoardTicketType,
  parseBoardView,
  parsePanelParam,
  parseProjectPath,
  parseTutorialCase,
  parseTutorialCommunity,
  parseTutorialStep,
  parseTutorialTab,
  parseTutorialTopic,
  parseTutorialWork,
  preferredBoardView,
  projectPath,
  tutorialHref,
  type UseAppRouteOptions,
  useAppRoute,
  withBoardParams,
  withPanelParams,
  workspaceWantPath,
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
    expect(settings.has('community')).toBe(false)
  })

  it('help 未给选择时保持案例总览，不再强制跳到功能教程', () => {
    const value = withPanelParams(new URLSearchParams(), 'help')
    expect(value.get('panel')).toBe('help')
    expect(value.has('topic')).toBe(false)
    expect(value.has('case')).toBe(false)
    expect(value.has('community')).toBe(false)
  })

  it('案例深链只接受稳定 id，并与旧 topic 互斥且案例优先', () => {
    const both = new URLSearchParams(
      'campaign=summer&panel=help&topic=chat-basics&case=research-bike-demand',
    )
    expect(parseTutorialCase(both)).toBe('research-bike-demand')
    expect(parseTutorialTopic(both)).toBeNull()
    expect(parseTutorialCase(new URLSearchParams('panel=help&case=unknown-case'))).toBeNull()

    const caseLink = withPanelParams(
      new URLSearchParams('campaign=summer&topic=chat-basics'),
      'help',
      null,
      'coding-swe-bench-fix',
    )
    expect(caseLink.get('campaign')).toBe('summer')
    expect(caseLink.get('case')).toBe('coding-swe-bench-fix')
    expect(caseLink.has('topic')).toBe(false)

    const legacy = withPanelParams(caseLink, 'help', PRODUCT_CAPABILITIES.github.id)
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
    expect(tutorialHref(source, null, null, 'tut-7')).toBe(
      '/s/keep-session?campaign=summer&invite=abc&panel=help&community=tut-7#result',
    )
  })

  it('community 深链只接受安全 id，并与 case/topic 互斥且 community 优先', () => {
    const mixed = new URLSearchParams(
      'campaign=summer&panel=help&topic=chat-basics&case=research-bike-demand&community=tut-7',
    )
    expect(parseTutorialCommunity(mixed)).toBe('tut-7')
    expect(parseTutorialCase(mixed)).toBeNull()
    expect(parseTutorialTopic(mixed)).toBeNull()
    expect(parseTutorialCommunity(new URLSearchParams('panel=help&community=bad/id'))).toBeNull()
    expect(parseTutorialCommunity(new URLSearchParams('panel=settings&community=tut-7'))).toBeNull()

    const communityLink = withPanelParams(
      new URLSearchParams('campaign=summer&topic=chat-basics&case=research-bike-demand'),
      'help',
      null,
      null,
      'tut-7',
    )
    expect(communityLink.get('campaign')).toBe('summer')
    expect(communityLink.get('community')).toBe('tut-7')
    expect(communityLink.has('topic')).toBe(false)
    expect(communityLink.has('case')).toBe(false)

    const closed = withPanelParams(communityLink, null)
    expect(closed.has('panel')).toBe(false)
    expect(closed.has('community')).toBe(false)
    expect(closed.get('campaign')).toBe('summer')
  })

  it('tab= 只认 start / cases 且只在 help 下生效；案例展厅是默认态不写参数（TU-17）', () => {
    expect(parseTutorialTab(new URLSearchParams('panel=help&tab=start'))).toBe('start')
    expect(parseTutorialTab(new URLSearchParams('panel=help&tab=cases'))).toBe('cases')
    expect(parseTutorialTab(new URLSearchParams('panel=help&tab=showcase'))).toBeNull()
    expect(parseTutorialTab(new URLSearchParams('panel=help&tab=nope'))).toBeNull()
    expect(parseTutorialTab(new URLSearchParams('panel=settings&tab=start'))).toBeNull()
    // 有 topic / case / community / work 时页签由它们决定，tab 无效。
    expect(parseTutorialTab(new URLSearchParams('panel=help&tab=start&topic=chat-basics'))).toBeNull()
    expect(parseTutorialTab(new URLSearchParams('panel=help&tab=start&work=planet'))).toBeNull()

    const start = withPanelParams(new URLSearchParams('campaign=summer'), 'help', null, null, null, {
      tab: 'start',
    })
    expect(start.get('tab')).toBe('start')
    expect(start.get('campaign')).toBe('summer')
    const showcase = withPanelParams(start, 'help', null, null, null, { tab: null })
    expect(showcase.has('tab')).toBe(false)
    // 进入某篇功能教程：tab 让位给 topic。
    const topic = withPanelParams(start, 'help', PRODUCT_CAPABILITIES.github.id, null, null, { tab: 'start' })
    expect(topic.get('topic')).toBe('github-repository')
    expect(topic.has('tab')).toBe(false)
    // 离开 help 全清。
    expect(withPanelParams(start, 'settings').has('tab')).toBe(false)
  })

  it('work= 只认精选作品 id，优先于 tab、让位给 topic / case / community（TU-17 / TU-02）', () => {
    expect(parseTutorialWork(new URLSearchParams('panel=help&work=planet'))).toBe('planet')
    expect(parseTutorialWork(new URLSearchParams('panel=help&work=gravity'))).toBe('gravity')
    expect(parseTutorialWork(new URLSearchParams('panel=help&work=moon'))).toBeNull()
    expect(parseTutorialWork(new URLSearchParams('panel=help&work=planet&case=research-bike-demand'))).toBeNull()
    expect(parseTutorialWork(new URLSearchParams('panel=market&work=planet'))).toBeNull()

    const work = withPanelParams(new URLSearchParams('campaign=summer'), 'help', null, null, null, {
      tab: 'cases',
      work: 'planet',
    })
    expect(work.get('work')).toBe('planet')
    expect(work.has('tab')).toBe(false)
    const backToGallery = withPanelParams(work, 'help', null, null, null, { work: null })
    expect(backToGallery.has('work')).toBe(false)
    const caseLink = withPanelParams(work, 'help', null, 'coding-swe-bench-fix', null, { work: 'planet' })
    expect(caseLink.get('case')).toBe('coding-swe-bench-fix')
    expect(caseLink.has('work')).toBe(false)
    expect(tutorialHref({ pathname: '/', search: '', hash: '' }, null, null, null, { work: 'gravity' })).toBe(
      '/?panel=help&work=gravity',
    )
  })

  it('step= 只跟着 topic 走：正整数进 URL，越界 / 非数字 / 无 topic 一律忽略（TU-17）', () => {
    expect(parseTutorialStep(new URLSearchParams('panel=help&topic=chat-basics&step=3'))).toBe(3)
    expect(parseTutorialStep(new URLSearchParams('panel=help&topic=chat-basics&step=0'))).toBeNull()
    expect(parseTutorialStep(new URLSearchParams('panel=help&topic=chat-basics&step=abc'))).toBeNull()
    expect(parseTutorialStep(new URLSearchParams('panel=help&topic=chat-basics&step=100'))).toBeNull()
    expect(parseTutorialStep(new URLSearchParams('panel=help&step=3'))).toBeNull()
    expect(parseTutorialStep(new URLSearchParams('panel=help&case=research-bike-demand&step=3'))).toBeNull()

    const link = tutorialHref(
      { pathname: '/s/keep', search: '?campaign=summer', hash: '' },
      PRODUCT_CAPABILITIES.chatBasics.id,
      null,
      null,
      { step: 3 },
    )
    expect(link).toBe('/s/keep?campaign=summer&panel=help&topic=chat-basics&step=3')
    // 换到案例 / 关闭 help 时 step 跟着 topic 一起清掉；非法 step 不写。
    const sp = new URLSearchParams(link.slice(link.indexOf('?')))
    expect(withPanelParams(sp, 'help', null, 'coding-swe-bench-fix').has('step')).toBe(false)
    expect(withPanelParams(sp, null).has('step')).toBe(false)
    expect(
      withPanelParams(sp, 'help', PRODUCT_CAPABILITIES.chatBasics.id, null, null, { step: 0 }).has('step'),
    ).toBe(false)
  })

  it('教程 tab= 与任务面板 ?view= 互不干扰：board 的清理只动自己的键（TU-17 命名取舍）', () => {
    const both = withBoardParams(
      new URLSearchParams('panel=help&tab=start&view=list'),
      null,
    )
    expect(both.get('tab')).toBe('start')
    expect(both.has('view')).toBe(false)
    expect(parseBoardView(new URLSearchParams('panel=help&tab=start'), 'board')).toBe('board')
  })
})

describe('任务面板 /board 深链', () => {
  it('只认精确 /board，会话路径与根路径仍走旧语义', () => {
    expect(parseBoardPath('/board')).toBe(true)
    expect(parseBoardPath('/board/')).toBe(false)
    expect(parseBoardPath('/s/abc')).toBe(false)
    expect(parseBoardPath('/')).toBe(false)
    expect(workspaceWantPath('board', 'abc', false)).toBe('/board')
    expect(workspaceWantPath('chat', 'abc', false)).toBe('/s/abc')
  })

  it('view / ticket 与 ?panel= 共存，离开 board 时清掉自己的键', () => {
    const source = new URLSearchParams('campaign=summer&panel=settings')
    const onBoard = withBoardParams(source, 'list', 'OCV5-42')
    expect(onBoard.get('campaign')).toBe('summer')
    expect(onBoard.get('panel')).toBe('settings')
    expect(onBoard.get('view')).toBe('list')
    expect(onBoard.get('ticket')).toBe('OCV5-42')

    const left = withBoardParams(onBoard, null, null)
    expect(left.get('campaign')).toBe('summer')
    expect(left.get('panel')).toBe('settings')
    expect(left.has('view')).toBe(false)
    expect(left.has('ticket')).toBe(false)
  })

  it('默认看板省略 view=board；移动/桌面默认值由设备偏好决定', () => {
    const clean = withBoardParams(new URLSearchParams('panel=help'), 'board', null)
    expect(clean.has('view')).toBe(false)
    expect(clean.get('panel')).toBe('help')
    expect(preferredBoardView(false)).toBe('list')
    expect(preferredBoardView(true)).toBe('board')
    expect(parseBoardView(new URLSearchParams(), preferredBoardView(false))).toBe('list')
    expect(parseBoardView(new URLSearchParams(), preferredBoardView(true))).toBe('board')
    expect(parseBoardView(new URLSearchParams('view=inbox'))).toBe('list')
    expect(parseBoardView(new URLSearchParams('view=cost'))).toBe('cost')
    expect(parseBoardView(new URLSearchParams('view=weekly'))).toBe('weekly')
    expect(parseBoardView(new URLSearchParams('view=backlog'))).toBe('list')
    expect(parseBoardView(new URLSearchParams('view=kanban'))).toBe('board')
    expect(withBoardParams(new URLSearchParams(), 'inbox').get('view')).toBe('list')
    expect(withBoardParams(new URLSearchParams(), 'backlog').get('view')).toBe('list')
    expect(parseBoardTicket(new URLSearchParams('ticket=OCV5-42'))).toBe('OCV5-42')
    expect(parseBoardTicket(new URLSearchParams('ticket='))).toBeNull()
  })

  it('ticketType 只接受四类单据；未选则省略，离开 board 时清掉', () => {
    const source = new URLSearchParams('campaign=summer&panel=help')
    const withType = withBoardParams(source, 'board', null, 'feature')
    expect(withType.get('campaign')).toBe('summer')
    expect(withType.get('panel')).toBe('help')
    expect(withType.has('view')).toBe(false)
    expect(withType.get('ticketType')).toBe('feature')

    const left = withBoardParams(withType, null, null, 'feature')
    expect(left.get('campaign')).toBe('summer')
    expect(left.has('ticketType')).toBe(false)

    expect(parseBoardTicketType(new URLSearchParams('ticketType=feature'))).toBe('feature')
    expect(parseBoardTicketType(new URLSearchParams('ticketType=kanban'))).toBeNull()
    expect(parseBoardTicketType(new URLSearchParams())).toBeNull()
  })
})

describe('项目主页 /p/<id> 深链', () => {
  afterEach(() => {
    cleanup()
    history.replaceState({}, '', '/')
  })

  it('解析 /p/<id> 与 /p/<id>/<tab>；概览不写页签段，未知页签与尾斜杠不认', () => {
    expect(parseProjectPath('/p/abc-123')).toEqual({ projectId: 'abc-123', tab: 'overview' })
    expect(parseProjectPath('/p/abc/chats')).toEqual({ projectId: 'abc', tab: 'chats' })
    expect(parseProjectPath('/p/abc/files')).toEqual({ projectId: 'abc', tab: 'files' })
    expect(parseProjectPath('/p/abc/outputs')).toEqual({ projectId: 'abc', tab: 'outputs' })
    expect(parseProjectPath('/p/abc/overview')).toBeNull()
    expect(parseProjectPath('/p/abc/settings')).toBeNull()
    expect(parseProjectPath('/p/abc/')).toBeNull()
    expect(parseProjectPath('/p/')).toBeNull()
    expect(parseProjectPath('/p/a.b')).toBeNull()
    expect(parseProjectPath('/s/abc')).toBeNull()
    expect(parseBoardPath('/p/abc')).toBe(false)
  })

  it('project 工作区的 wantPath 是项目路径；缺位置时按对话处理', () => {
    expect(projectPath({ projectId: 'p1', tab: 'overview' })).toBe('/p/p1')
    expect(projectPath({ projectId: 'p1', tab: 'outputs' })).toBe('/p/p1/outputs')
    expect(workspaceWantPath('project', 's1', false, { projectId: 'p1', tab: 'overview' })).toBe(
      '/p/p1',
    )
    expect(workspaceWantPath('project', 's1', false, { projectId: 'p1', tab: 'files' })).toBe(
      '/p/p1/files',
    )
    expect(workspaceWantPath('project', 's1', false, null)).toBe('/s/s1')
    expect(workspaceWantPath('chat', 's1', false, { projectId: 'p1', tab: 'files' })).toBe('/s/s1')
  })

  const base = (over: Partial<UseAppRouteOptions> = {}): UseAppRouteOptions => ({
    enabled: true,
    inWorkspace: true,
    activeId: undefined,
    sessions: [],
    serverListSettled: true,
    pendingSessionId: null,
    clearPendingSession: () => {},
    selectSession: () => {},
    onPopToRoot: () => {},
    activePanel: null,
    ...over,
  })

  it('进入项目主页 push，换页签 replace，换项目 push，回对话 push', () => {
    const push = vi.spyOn(history, 'pushState')
    const replace = vi.spyOn(history, 'replaceState')
    const { rerender } = renderHook((o: UseAppRouteOptions) => useAppRoute(o), {
      initialProps: base(),
    })
    push.mockClear()
    replace.mockClear()

    rerender(base({ workspace: 'project', projectRoute: { projectId: 'p1', tab: 'overview' } }))
    expect(location.pathname).toBe('/p/p1')
    expect(push).toHaveBeenCalledTimes(1)

    rerender(base({ workspace: 'project', projectRoute: { projectId: 'p1', tab: 'outputs' } }))
    expect(location.pathname).toBe('/p/p1/outputs')
    expect(push).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalled()

    rerender(base({ workspace: 'project', projectRoute: { projectId: 'p2', tab: 'overview' } }))
    expect(location.pathname).toBe('/p/p2')
    expect(push).toHaveBeenCalledTimes(2)

    rerender(base({ workspace: 'chat' }))
    expect(location.pathname).toBe('/')
    expect(push).toHaveBeenCalledTimes(3)
    push.mockRestore()
    replace.mockRestore()
  })

  it('启动深链：等项目列表；存在则打开主页，列表落定仍不存在则放弃并回 /', () => {
    history.replaceState({}, '', '/p/p1/files')
    const onOpenProject = vi.fn()
    const clearPendingProject = vi.fn()
    const pending = { projectId: 'p1', tab: 'files' as const }
    const { rerender } = renderHook((o: UseAppRouteOptions) => useAppRoute(o), {
      initialProps: base({
        pendingProject: pending,
        clearPendingProject,
        onOpenProject,
        projectIds: [],
        projectListSettled: false,
      }),
    })
    // 列表未到：不打开、不放弃、不改 URL。
    expect(onOpenProject).not.toHaveBeenCalled()
    expect(clearPendingProject).not.toHaveBeenCalled()
    expect(location.pathname).toBe('/p/p1/files')

    rerender(
      base({
        pendingProject: pending,
        clearPendingProject,
        onOpenProject,
        projectIds: ['p1'],
        projectListSettled: true,
      }),
    )
    expect(clearPendingProject).toHaveBeenCalledTimes(1)
    expect(onOpenProject).toHaveBeenCalledWith(pending)
  })

  it('启动深链到不存在的项目：放弃后 URL 回 /（replace，不压栈）', () => {
    history.replaceState({}, '', '/p/gone')
    const push = vi.spyOn(history, 'pushState')
    const clearPendingProject = vi.fn()
    const onOpenProject = vi.fn()
    const pending = { projectId: 'gone', tab: 'overview' as const }
    const { rerender } = renderHook((o: UseAppRouteOptions) => useAppRoute(o), {
      initialProps: base({
        pendingProject: pending,
        clearPendingProject,
        onOpenProject,
        projectIds: ['other'],
        projectListSettled: true,
      }),
    })
    expect(clearPendingProject).toHaveBeenCalledTimes(1)
    expect(onOpenProject).not.toHaveBeenCalled()
    rerender(base({ pendingProject: null, projectIds: ['other'], projectListSettled: true }))
    expect(location.pathname).toBe('/')
    expect(push).not.toHaveBeenCalled()
    push.mockRestore()
  })

  it('popstate 到 /p/<id>：项目存在 → 切到项目工作区并打开；不存在 → 回空态并 replace 成 /', () => {
    const onPopWorkspace = vi.fn()
    const onOpenProject = vi.fn()
    const onPopToRoot = vi.fn()
    renderHook((o: UseAppRouteOptions) => useAppRoute(o), {
      initialProps: base({ onPopWorkspace, onOpenProject, onPopToRoot, projectIds: ['p1'] }),
    })
    act(() => {
      history.pushState({}, '', '/p/p1/chats')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(onPopWorkspace).toHaveBeenLastCalledWith('project')
    expect(onOpenProject).toHaveBeenLastCalledWith({ projectId: 'p1', tab: 'chats' })

    act(() => {
      history.pushState({}, '', '/p/deleted')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(onPopWorkspace).toHaveBeenLastCalledWith('chat')
    expect(onPopToRoot).toHaveBeenCalledTimes(1)
    expect(onOpenProject).toHaveBeenCalledTimes(1)
    expect(location.pathname).toBe('/')
  })
})
