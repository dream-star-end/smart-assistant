import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, prefetchLazyCentersOnIdle } from './App'
import { LegalPage } from './components/LegalPage'
import { ToastProvider, TooltipProvider } from './components/ui'
import { registerServiceWorker } from './registerSW'
import './styles.css'

// 法律文本静态页(/terms /privacy):纯静态、无任何 App 状态,在入口层短路,
// 不走 App 的路由/鉴权/WS 体系(App 内的 /reset-password 特判需要 AuthGate,故留在 App)。
// 依赖 gateway SPA fallback 对无扩展名路径回退 index.html。
const legalKind =
  location.pathname === '/terms' ? 'terms' : location.pathname === '/privacy' ? 'privacy' : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <TooltipProvider>
        {legalKind ? <LegalPage kind={legalKind} /> : <App />}
      </TooltipProvider>
    </ToastProvider>
  </StrictMode>,
)

// PWA:仅生产 + 安全上下文注册(见 registerSW)。放渲染之后,不阻塞首屏。
registerServiceWorker()

// UX 体验对冲:空闲期预取四大中心懒块(见 App.tsx 注释),首开零延迟。
// 法务静态页不承载工作区,跳过预取,省流量。
if (!legalKind) prefetchLazyCentersOnIdle()
