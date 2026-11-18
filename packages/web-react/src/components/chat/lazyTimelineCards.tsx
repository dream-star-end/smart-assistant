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

type TeamPanelModule = typeof import('./TeamPanel')
type TeamPanelProps = ComponentProps<TeamPanelModule['TeamPanel']>
type GeneratingPlaceholderModule = typeof import('./GeneratingPlaceholderCard')
type GeneratingPlaceholderProps = ComponentProps<
  GeneratingPlaceholderModule['GeneratingPlaceholderCard']
>
type PermissionCardModule = typeof import('./PermissionCard')
type PermissionCardProps = ComponentProps<PermissionCardModule['PermissionCard']>
type PermissionPromptHostProps = ComponentProps<PermissionCardModule['PermissionPromptHost']>
export type PermissionCardLoader = () => Promise<PermissionCardModule>

const defaultPermissionCardLoader: PermissionCardLoader = () => import('./PermissionCard')
let permissionCardLoader: PermissionCardLoader = defaultPermissionCardLoader

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
    preloadTeamPanel(),
    preloadGeneratingPlaceholderCard(),
    preloadPermissionCard(),
  ])
}

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
