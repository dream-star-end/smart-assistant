/**
 * 时间线低频重卡片(TeamPanel 多智能体协作面板、GeneratingPlaceholderCard 本地生图占位卡、
 * PermissionCard / PermissionPromptHost 权限审批卡与弹窗宿主)
 * 只在对应场景下渲染,移出首屏同步入口闭包(first-screen-budget,见 vite.config.ts)。
 *
 * 同 lazyToolBody.tsx:
 * - 首屏空闲时预取,正常进入会话后早已就绪;
 * - 模块就绪后 lazy 工厂返回同步 thenable,React 当场解析、不挂起、不闪 fallback;
 * - 需要同步断言的测试文件通过 loadBeforeAll(preloadTimelineCards) 预热。
 */
import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from 'react'

type AgentGroupModule = typeof import('./AgentGroupCard')
type AgentGroupCardProps = ComponentProps<AgentGroupModule['AgentGroupCard']>
type DelegateProcessListModule = typeof import('./delegateProcessList')
type DelegateProcessListProps = ComponentProps<DelegateProcessListModule['DelegateProcessList']>
type TeamPanelModule = typeof import('./TeamPanel')
type TeamPanelProps = ComponentProps<TeamPanelModule['TeamPanel']>
type GeneratingPlaceholderModule = typeof import('./GeneratingPlaceholderCard')
type GeneratingPlaceholderProps = ComponentProps<
  GeneratingPlaceholderModule['GeneratingPlaceholderCard']
>
type PermissionCardModule = typeof import('./PermissionCard')
type PermissionCardProps = ComponentProps<PermissionCardModule['PermissionCard']>
type PermissionPromptHostProps = ComponentProps<PermissionCardModule['PermissionPromptHost']>
type SwarmViewsModule = typeof import('./SwarmViews')
type SwarmInlineCardProps = ComponentProps<SwarmViewsModule['SwarmInlineCard']>
type PinnedSwarmDockProps = ComponentProps<SwarmViewsModule['PinnedSwarmDock']>
type SwarmBoardDrawerProps = ComponentProps<SwarmViewsModule['SwarmBoardDrawer']>
type SwarmPlaybookPopoverProps = ComponentProps<SwarmViewsModule['SwarmPlaybookPopover']>
type PinnedDelegateModule = typeof import('./PinnedDelegateTracker')
type PinnedDelegateProps = ComponentProps<PinnedDelegateModule['PinnedDelegateTracker']>
type PinnedTaskModule = typeof import('./PinnedTaskTracker')
type PinnedTaskProps = ComponentProps<PinnedTaskModule['PinnedTaskTracker']>
type PinnedGoalModule = typeof import('./PinnedGoalBar')
type PinnedGoalProps = ComponentProps<PinnedGoalModule['PinnedGoalBar']>
type QueuedSendModule = typeof import('./QueuedSendList')
type QueuedSendProps = ComponentProps<QueuedSendModule['QueuedSendList']>
export type PermissionCardLoader = () => Promise<PermissionCardModule>

const defaultPermissionCardLoader: PermissionCardLoader = () => import('./PermissionCard')
let permissionCardLoader: PermissionCardLoader = defaultPermissionCardLoader

let loadedAgentGroup: AgentGroupModule | null = null
let pendingAgentGroup: Promise<AgentGroupModule> | null = null

let loadedDelegateProcessList: DelegateProcessListModule | null = null
let pendingDelegateProcessList: Promise<DelegateProcessListModule> | null = null

let loadedTeam: TeamPanelModule | null = null
let pendingTeam: Promise<TeamPanelModule> | null = null

let loadedPlaceholder: GeneratingPlaceholderModule | null = null
let pendingPlaceholder: Promise<GeneratingPlaceholderModule> | null = null

let loadedPermission: PermissionCardModule | null = null
let pendingPermission: Promise<PermissionCardModule> | null = null

function makeLazyPermissionCard() {
  return lazy(() => {
    const ready = loadedPermission
    if (ready) {
      const sync = {
        // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
        then(resolve: (value: { default: PermissionCardModule['PermissionCard'] }) => void) {
          resolve({ default: ready.PermissionCard })
        },
      }
      return sync as unknown as Promise<{ default: PermissionCardModule['PermissionCard'] }>
    }
    return preloadPermissionCard().then((module) => ({ default: module.PermissionCard }))
  })
}

function makeLazyPermissionPromptHost() {
  return lazy(() => {
    const ready = loadedPermission
    if (ready) {
      const sync = {
        // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
        then(resolve: (value: { default: PermissionCardModule['PermissionPromptHost'] }) => void) {
          resolve({ default: ready.PermissionPromptHost })
        },
      }
      return sync as unknown as Promise<{ default: PermissionCardModule['PermissionPromptHost'] }>
    }
    return preloadPermissionCard().then((module) => ({ default: module.PermissionPromptHost }))
  })
}

let LazyPermissionCard = makeLazyPermissionCard()
let LazyPermissionPromptHost = makeLazyPermissionPromptHost()

function rebuildFailedPermissionLazy(): void {
  if (!loadedPermission) {
    LazyPermissionCard = makeLazyPermissionCard()
    LazyPermissionPromptHost = makeLazyPermissionPromptHost()
  }
}

export function _setPermissionCardLoaderForTest(loader?: PermissionCardLoader | null): void {
  permissionCardLoader = loader ?? defaultPermissionCardLoader
  loadedPermission = null
  pendingPermission = null
  LazyPermissionCard = makeLazyPermissionCard()
  LazyPermissionPromptHost = makeLazyPermissionPromptHost()
}

export function preloadAgentGroupCard(): Promise<AgentGroupModule> {
  if (!pendingAgentGroup) {
    pendingAgentGroup = import('./AgentGroupCard').then(
      (module) => {
        loadedAgentGroup = module
        return module
      },
      (error: unknown) => {
        pendingAgentGroup = null
        throw error
      },
    )
  }
  return pendingAgentGroup
}

export function preloadDelegateProcessList(): Promise<DelegateProcessListModule> {
  if (!pendingDelegateProcessList) {
    pendingDelegateProcessList = import('./delegateProcessList').then(
      (module) => {
        loadedDelegateProcessList = module
        return module
      },
      (error: unknown) => {
        pendingDelegateProcessList = null
        throw error
      },
    )
  }
  return pendingDelegateProcessList
}

export function preloadTeamPanel(): Promise<TeamPanelModule> {
  if (!pendingTeam) {
    pendingTeam = import('./TeamPanel').then(
      (module) => {
        loadedTeam = module
        return module
      },
      (error: unknown) => {
        pendingTeam = null
        throw error
      },
    )
  }
  return pendingTeam
}

export function preloadGeneratingPlaceholderCard(): Promise<GeneratingPlaceholderModule> {
  if (!pendingPlaceholder) {
    pendingPlaceholder = import('./GeneratingPlaceholderCard').then(
      (module) => {
        loadedPlaceholder = module
        return module
      },
      (error: unknown) => {
        pendingPlaceholder = null
        throw error
      },
    )
  }
  return pendingPlaceholder
}

export function preloadPermissionCard(): Promise<PermissionCardModule> {
  if (!pendingPermission) {
    pendingPermission = permissionCardLoader().then(
      (module) => {
        loadedPermission = module
        return module
      },
      (error: unknown) => {
        pendingPermission = null
        LazyPermissionCard = makeLazyPermissionCard()
        LazyPermissionPromptHost = makeLazyPermissionPromptHost()
        throw error
      },
    )
  }
  return pendingPermission
}

export function preloadTimelineCards(): Promise<unknown> {
  return Promise.all([
    preloadAgentGroupCard(),
    preloadDelegateProcessList(),
    preloadTeamPanel(),
    preloadGeneratingPlaceholderCard(),
    preloadPermissionCard(),
  ])
}

/** 动态读取模块命名空间上的 AgentGroupCard，确保预热后 vi.spyOn(AgentGroupMod, 'AgentGroupCard') 仍能命中。 */
function AgentGroupCardProxy(props: AgentGroupCardProps) {
  const Comp = loadedAgentGroup!.AgentGroupCard
  return <Comp {...props} />
}

const LazyAgentGroupCard = lazy(() => {
  if (loadedAgentGroup) {
    const sync = {
      // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
      then(resolve: (value: { default: typeof AgentGroupCardProxy }) => void) {
        resolve({ default: AgentGroupCardProxy })
      },
    }
    return sync as unknown as Promise<{ default: typeof AgentGroupCardProxy }>
  }
  return preloadAgentGroupCard().then(() => ({ default: AgentGroupCardProxy }))
})

const LazyDelegateProcessList = lazy(() => {
  const ready = loadedDelegateProcessList
  if (ready) {
    const sync = {
      // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
      then(resolve: (value: { default: DelegateProcessListModule['DelegateProcessList'] }) => void) {
        resolve({ default: ready.DelegateProcessList })
      },
    }
    return sync as unknown as Promise<{ default: DelegateProcessListModule['DelegateProcessList'] }>
  }
  return preloadDelegateProcessList().then((module) => ({ default: module.DelegateProcessList }))
})

const LazyTeamPanel = lazy(() => {
  const ready = loadedTeam
  if (ready) {
    const sync = {
      // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
      then(resolve: (value: { default: TeamPanelModule['TeamPanel'] }) => void) {
        resolve({ default: ready.TeamPanel })
      },
    }
    return sync as unknown as Promise<{ default: TeamPanelModule['TeamPanel'] }>
  }
  return preloadTeamPanel().then((module) => ({ default: module.TeamPanel }))
})

const LazyGeneratingPlaceholderCard = lazy(() => {
  const ready = loadedPlaceholder
  if (ready) {
    const sync = {
      // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
      then(
        resolve: (value: {
          default: GeneratingPlaceholderModule['GeneratingPlaceholderCard']
        }) => void,
      ) {
        resolve({ default: ready.GeneratingPlaceholderCard })
      },
    }
    return sync as unknown as Promise<{
      default: GeneratingPlaceholderModule['GeneratingPlaceholderCard']
    }>
  }
  return preloadGeneratingPlaceholderCard().then((module) => ({
    default: module.GeneratingPlaceholderCard,
  }))
})

class PermissionLazyErrorBoundary extends Component<
  { renderChildren: () => ReactNode; compact?: boolean; resetKey?: string },
  { error: unknown }
> {
  state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }

  componentDidUpdate(prevProps: {
    renderChildren: () => ReactNode
    compact?: boolean
    resetKey?: string
  }): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      rebuildFailedPermissionLazy()
      this.setState({ error: null })
    }
  }

  private handleRetry = () => {
    rebuildFailedPermissionLazy()
    this.setState({ error: null })
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div
          role="alert"
          data-testid="permission-lazy-error"
          className={
            this.props.compact
              ? 'mx-auto flex max-w-3xl items-center justify-between gap-2 px-5 py-1.5 text-caption text-muted'
              : 'flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-meta text-muted'
          }
        >
          <span>{this.props.compact ? '审批弹窗加载失败' : '权限卡片加载失败'}</span>
          <button
            type="button"
            onClick={this.handleRetry}
            className="shrink-0 rounded-full bg-hover px-2.5 py-1 text-caption text-fg hover:bg-border/60 [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.renderChildren()
  }
}

function prefetchWhenIdle(): void {
  preloadTimelineCards().catch(() => {})
}

if (typeof window !== 'undefined') {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback
  if (idle) idle(prefetchWhenIdle)
  else window.setTimeout(prefetchWhenIdle, 1500)
}

export function AgentGroupCard(props: AgentGroupCardProps) {
  return (
    <Suspense fallback={<div className="py-1 text-caption text-faint">加载中…</div>}>
      <LazyAgentGroupCard {...props} />
    </Suspense>
  )
}

export function DelegateProcessListLazy(props: DelegateProcessListProps) {
  return (
    <Suspense fallback={<div className="px-3.5 py-2 text-caption text-faint">加载中…</div>}>
      <LazyDelegateProcessList {...props} />
    </Suspense>
  )
}

export function TeamPanel(props: TeamPanelProps) {
  return (
    <Suspense fallback={<div className="py-1 text-caption text-faint">加载中…</div>}>
      <LazyTeamPanel {...props} />
    </Suspense>
  )
}

export function GeneratingPlaceholderCard(props: GeneratingPlaceholderProps) {
  return (
    <Suspense fallback={null}>
      <LazyGeneratingPlaceholderCard {...props} />
    </Suspense>
  )
}

export function PermissionCard(props: PermissionCardProps) {
  return (
    <PermissionLazyErrorBoundary
      resetKey={props.msg.requestId ?? props.msg.id}
      renderChildren={() => (
        <Suspense fallback={<div className="py-1 text-caption text-faint">加载中…</div>}>
          <LazyPermissionCard {...props} />
        </Suspense>
      )}
    />
  )
}

export function PermissionPromptHost(props: PermissionPromptHostProps) {
  return (
    <PermissionLazyErrorBoundary
      compact
      resetKey={props.sessionId}
      renderChildren={() => (
        <Suspense fallback={null}>
          <LazyPermissionPromptHost {...props} />
        </Suspense>
      )}
    />
  )
}

// ── Antigravity Native Swarm UI (OCV5-809) & PinnedDelegateTracker: single shared lazy chunks ──
let loadedSwarm: SwarmViewsModule | null = null
let pendingSwarm: Promise<SwarmViewsModule> | null = null
export function preloadSwarmViews(): Promise<SwarmViewsModule> {
  if (!pendingSwarm) {
    pendingSwarm = import('./SwarmViews').then(
      (m) => { loadedSwarm = m; return m },
      (err: unknown) => { pendingSwarm = null; throw err },
    )
  }
  return pendingSwarm
}
function lazySwarm<K extends keyof SwarmViewsModule>(key: K) {
  return lazy(() =>
    loadedSwarm
      ? ({ then(r: (v: { default: SwarmViewsModule[K] }) => void) { r({ default: loadedSwarm![key] }) } } as unknown as Promise<{ default: SwarmViewsModule[K] }>)
      : preloadSwarmViews().then((m) => ({ default: m[key] })),
  )
}
let LazySwarmInlineCard = lazySwarm('SwarmInlineCard')
let LazyPinnedSwarmDock = lazySwarm('PinnedSwarmDock')
let LazySwarmBoardDrawer = lazySwarm('SwarmBoardDrawer')
let LazySwarmPlaybookPopover = lazySwarm('SwarmPlaybookPopover')
const LazyPinnedDelegateTracker = lazy(() =>
  import('./PinnedDelegateTracker').then((m) => ({ default: m.PinnedDelegateTracker })),
)
const LazyPinnedTaskTracker = lazy(() =>
  import('./PinnedTaskTracker').then((m) => ({ default: m.PinnedTaskTracker })),
)
const LazyPinnedGoalBar = lazy(() =>
  import('./PinnedGoalBar').then((m) => ({ default: m.PinnedGoalBar })),
)
const LazyQueuedSendList = lazy(() =>
  import('./QueuedSendList').then((m) => ({ default: m.QueuedSendList })),
)

class SwarmLazyErrorBoundary extends Component<
  { onRebuild: () => void; renderChildren: () => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error !== null) {
      return (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-meta text-muted">
          <span>蜂群看板加载失败</span>
          <button
            type="button"
            onClick={() => { this.props.onRebuild(); this.setState({ error: null }) }}
            className="shrink-0 rounded-full bg-hover px-2.5 py-1 text-caption text-fg hover:bg-border/60"
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.renderChildren()
  }
}

export function SwarmInlineCard(props: SwarmInlineCardProps) {
  return (
    <SwarmLazyErrorBoundary
      onRebuild={() => { if (!loadedSwarm) LazySwarmInlineCard = lazySwarm('SwarmInlineCard') }}
      renderChildren={() => (
        <Suspense fallback={<div className="py-1 text-caption text-faint">蜂群看板加载中…</div>}>
          <LazySwarmInlineCard {...props} />
        </Suspense>
      )}
    />
  )
}

export function PinnedSwarmDock(props: PinnedSwarmDockProps) {
  if (!props.snapshot) return null
  return (
    <SwarmLazyErrorBoundary
      onRebuild={() => { if (!loadedSwarm) LazyPinnedSwarmDock = lazySwarm('PinnedSwarmDock') }}
      renderChildren={() => (
        <Suspense fallback={null}>
          <LazyPinnedSwarmDock {...props} />
        </Suspense>
      )}
    />
  )
}

export function SwarmBoardDrawer(props: SwarmBoardDrawerProps) {
  if (!props.open || !props.snapshot) return null
  return (
    <SwarmLazyErrorBoundary
      onRebuild={() => { if (!loadedSwarm) LazySwarmBoardDrawer = lazySwarm('SwarmBoardDrawer') }}
      renderChildren={() => (
        <Suspense fallback={null}>
          <LazySwarmBoardDrawer {...props} />
        </Suspense>
      )}
    />
  )
}

export function SwarmPlaybookPopoverLazy(props: SwarmPlaybookPopoverProps) {
  return (
    <SwarmLazyErrorBoundary
      onRebuild={() => { if (!loadedSwarm) LazySwarmPlaybookPopover = lazySwarm('SwarmPlaybookPopover') }}
      renderChildren={() => (
        <Suspense
          fallback={
            props.open ? (
                <span
                  role="status"
                  data-testid="swarm-playbook-loading"
                  className="ml-1.5 inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-1 text-caption text-muted shadow-soft"
                >
                  剧本加载中…
                </span>
            ) : null
          }
        >
          <LazySwarmPlaybookPopover {...props} />
        </Suspense>
      )}
    />
  )
}

export function PinnedDelegateTrackerLazy(props: PinnedDelegateProps) {
  if (props.items.length === 0) return null
  return (
    <Suspense fallback={null}>
      <LazyPinnedDelegateTracker {...props} />
    </Suspense>
  )
}

export function PinnedTaskTrackerLazy(props: PinnedTaskProps) {
  if (props.todos.length === 0) return null
  return (
    <Suspense fallback={null}>
      <LazyPinnedTaskTracker {...props} />
    </Suspense>
  )
}

export function PinnedGoalBarLazy(props: PinnedGoalProps) {
  if (!props.messages.some((m) => m?.role === 'goal' && m.cleared !== true)) return null
  return (
    <Suspense fallback={null}>
      <LazyPinnedGoalBar {...props} />
    </Suspense>
  )
}

export function QueuedSendListLazy(props: QueuedSendProps) {
  if (props.messages.length === 0) return null
  return (
    <Suspense fallback={null}>
      <LazyQueuedSendList {...props} />
    </Suspense>
  )
}
