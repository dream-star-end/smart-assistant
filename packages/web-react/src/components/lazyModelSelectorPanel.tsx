/**
 * ModelSelector 弹层/Sheet 懒加载壳（OCV5-817 首屏体积预算优化）：
 * - 默认移出首屏同步入口闭包（仅在打开或空闲预热时加载）；
 * - 一旦模块就绪，lazy 工厂返回同步 thenable，React 当场解析不挂起、不闪白；
 * - 供 appLazyViews.tsx 与单测按需调用 preloadModelSelectorPanel() 预热。
 */
import { lazy, Suspense, type ComponentProps } from 'react'

type PanelModule = typeof import('./ModelSelectorPanel')
export type ModelSelectorPanelProps = ComponentProps<PanelModule['ModelSelectorPanel']>

let loadedPanel: PanelModule | null = null
let pendingPanel: Promise<PanelModule> | null = null

export function preloadModelSelectorPanel(): Promise<PanelModule> {
  if (!pendingPanel) {
    pendingPanel = import('./ModelSelectorPanel').then(
      (mod) => {
        loadedPanel = mod
        return mod
      },
      (err: unknown) => {
        pendingPanel = null
        throw err
      },
    )
  }
  return pendingPanel
}

const LazyPanel = lazy(() => {
  const ready = loadedPanel
  if (ready) {
    const sync = {
      // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
      then(resolve: (value: { default: PanelModule['ModelSelectorPanel'] }) => void) {
        resolve({ default: ready.ModelSelectorPanel })
      },
    }
    return sync as unknown as Promise<{ default: PanelModule['ModelSelectorPanel'] }>
  }
  return preloadModelSelectorPanel().then((mod) => ({ default: mod.ModelSelectorPanel }))
})

if (typeof window !== 'undefined') {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback
  if (idle) idle(() => { void preloadModelSelectorPanel().catch(() => {}) })
  else window.setTimeout(() => { void preloadModelSelectorPanel().catch(() => {}) }, 10)
}

export function LazyModelSelectorPanel(props: ModelSelectorPanelProps) {
  return (
    <Suspense fallback={null}>
      <LazyPanel {...props} />
    </Suspense>
  )
}
