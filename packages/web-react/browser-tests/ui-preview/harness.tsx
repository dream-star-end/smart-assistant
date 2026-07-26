// UI 视觉预览台的浏览器侧入口:注册场景 → 提供挂载/卸载钩子 → 由 shoot.mjs 驱动截图。
//
// 与 browser-tests/run.mjs 的组件冒烟是**两种用途**:那边断言交互契约,这里只求"像真的",
// 所以本文件把真实组件 + 真实 production CSS 原样渲染,只在网络边界(api / fetch)打桩。
//
// 场景来自两个并行产出的模块:./scenes-manage 与 ./scenes-market。
// shoot.mjs 用 esbuild 插件把这两个 specifier 映射到目录里**实际存在**的场景文件
// (按文件名里的 manage / market 归类,允许一组拆多个文件);一个都没有时映射成空模块,
// 于是构建仍然通过、shoot 侧再 fail-loud 报"零场景"。因此这里的导入名是约定而非硬路径。
import { Component, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ApiMockTable, Scene } from './types'
import * as manageSceneModule from './scenes-manage'
import * as marketSceneModule from './scenes-market'

type SceneMeta = Pick<Scene, 'id' | 'label' | 'group' | 'viewports'>

declare global {
  interface Window {
    __ocScenes: SceneMeta[]
    __mountScene: (id: string) => void
    __unmountScene: () => void
    /** 零场景时的诊断:两个场景模块各自导出了什么。 */
    __ocSceneModules: { manage: string[]; market: string[] }
    /** 最近一次挂载中被 ErrorBoundary 捕获的渲染错误(未出错为 null)。 */
    __ocSceneError: string | null
  }
}

// ── 场景收集 ────────────────────────────────────────────────────────────────
// 并行 agent 的导出名无法预先约定(scenes / manageScenes / default …),所以按**结构**
// 认场景:递归浅走模块命名空间,凡是 {id, render} 齐备的对象都收下。深度封顶防环。
function isScene(value: unknown): value is Scene {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Scene>
  return typeof candidate.id === 'string' && typeof candidate.render === 'function'
}

// 深度封顶要留够:shoot.mjs 的虚拟聚合模块又套了一层(命名空间 → modules[] → 子模块命名空间
// → scenes[] → Scene),深度 4 才见到场景对象。封顶只为防环,给够余量即可。
const MAX_SCENE_DEPTH = 8

function collectScenes(value: unknown, out: Scene[], depth = 0): void {
  if (value == null || depth > MAX_SCENE_DEPTH) return
  if (isScene(value)) {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScenes(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectScenes(item, out, depth + 1)
    }
  }
}

const collected: Scene[] = []
collectScenes(manageSceneModule, collected)
collectScenes(marketSceneModule, collected)

const scenes: Scene[] = []
const byId = new Map<string, Scene>()
for (const scene of collected) {
  if (byId.has(scene.id)) {
    console.warn('[duplicate-scene-id]', scene.id)
    continue
  }
  byId.set(scene.id, scene)
  scenes.push(scene)
}

// ── 网络兜底 ────────────────────────────────────────────────────────────────
// api 走 api-stub 的 Proxy;但仍有旁路直发 fetch 的埋点(reportClientFriction 之类)。
// 这类请求在离线 harness 里必然失败并打红控制台,统一兜成 204。
window.fetch = async () => new Response(null, { status: 204, statusText: 'No Content' })
if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
  navigator.sendBeacon = () => true
}

// ── 渲染边界 ────────────────────────────────────────────────────────────────
// 一个场景崩了不能带走整页:边界把错误显式画出来(截图里一眼看见),同时写到
// window.__ocSceneError 供 shoot.mjs 记为失败。
class SceneBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(err: unknown) {
    return { error: String((err as Error)?.message ?? err) }
  }

  componentDidCatch(err: unknown) {
    window.__ocSceneError = String((err as Error)?.stack ?? (err as Error)?.message ?? err)
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: '0',
            zIndex: 2147483647,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            background: '#7f1d1d',
            color: '#fff',
            font: '13px/1.6 ui-monospace, monospace',
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
          }}
        >
          {`场景渲染失败:\n${this.state.error}`}
        </div>
      )
    }
    return this.props.children
  }
}

// ── 挂载 / 卸载 ─────────────────────────────────────────────────────────────
let root: Root | null = null

function host(): HTMLElement {
  let node = document.getElementById('root')
  if (!node) {
    node = document.createElement('div')
    node.id = 'root'
    document.body.appendChild(node)
  }
  return node
}

window.__ocScenes = scenes.map(({ id, label, group, viewports }) => ({ id, label, group, viewports }))
window.__ocSceneError = null
window.__ocSceneModules = {
  manage: Object.keys(manageSceneModule as Record<string, unknown>),
  market: Object.keys(marketSceneModule as Record<string, unknown>),
}

window.__mountScene = (id: string) => {
  window.__unmountScene()
  const scene = byId.get(id)
  if (!scene) throw new Error(`ui-preview: 未注册的场景 ${id}`)
  // 场景表必须在 render() 之前就位 —— 面板通常在 mount effect 里立刻发起请求。
  ;(globalThis as unknown as { __ocApiMocks?: ApiMockTable }).__ocApiMocks = scene.api
  window.__ocSceneError = null
  root = createRoot(host())
  // 面板挂在 Radix Dialog Portal 里(渲染到 document.body),#root 只是宿主容器。
  root.render(<SceneBoundary key={id}>{scene.render()}</SceneBoundary>)
}

window.__unmountScene = () => {
  root?.unmount()
  root = null
  ;(globalThis as unknown as { __ocApiMocks?: ApiMockTable }).__ocApiMocks = undefined
  // Portal 是 React 自己清的;残留只可能来自崩溃场景,这里兜一次防止串场景污染。
  for (const stray of Array.from(document.querySelectorAll('body > [data-radix-portal], body > [data-radix-popper-content-wrapper]'))) {
    stray.remove()
  }
}
