/**
 * 时间线低频重卡片(TeamPanel 多智能体协作面板、GeneratingPlaceholderCard 本地生图占位卡)
 * 只在对应场景下渲染,移出首屏同步入口闭包(first-screen-budget,见 vite.config.ts)。
 *
 * 同 lazyToolBody.tsx:
 * - 首屏空闲时预取,正常进入会话后早已就绪;
 * - 模块就绪后 lazy 工厂返回同步 thenable,React 当场解析、不挂起、不闪 fallback;
 * - 需要同步断言的测试文件通过 loadBeforeAll(preloadTimelineCards) 预热。
 */
import { lazy, Suspense, type ComponentProps } from 'react'

type TeamPanelModule = typeof import('./TeamPanel')
type TeamPanelProps = ComponentProps<TeamPanelModule['TeamPanel']>
type GeneratingPlaceholderModule = typeof import('./GeneratingPlaceholderCard')
type GeneratingPlaceholderProps = ComponentProps<
  GeneratingPlaceholderModule['GeneratingPlaceholderCard']
>

let loadedTeam: TeamPanelModule | null = null
let pendingTeam: Promise<TeamPanelModule> | null = null

let loadedPlaceholder: GeneratingPlaceholderModule | null = null
let pendingPlaceholder: Promise<GeneratingPlaceholderModule> | null = null

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

export function preloadTimelineCards(): Promise<unknown> {
  return Promise.all([preloadTeamPanel(), preloadGeneratingPlaceholderCard()])
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
