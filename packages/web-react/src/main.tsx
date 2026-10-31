import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, prefetchLazyCentersOnIdle } from './App'
import { prefetchTapePayloadOnIdle } from './lib/chat/loadTapePayload'
import { LegalPage } from './components/LegalPage'
import { ToastProvider, TooltipProvider } from './components/ui'
import { registerServiceWorker } from './registerSW'
import { installGlobalClientFrictionHandlers } from './lib/clientFriction'
import { waitForEntryStyles } from './lib/nonBlockingCss'
import './styles.css'

// 法律文本静态页(/terms /privacy):纯静态、无任何 App 状态,在入口层短路,
// 不走 App 的路由/鉴权/WS 体系(App 内的 /reset-password 特判需要 AuthGate,故留在 App)。
// 依赖 gateway SPA fallback 对无扩展名路径回退 index.html。
const legalKind =
  location.pathname === '/terms' ? 'terms' : location.pathname === '/privacy' ? 'privacy' : null

installGlobalClientFrictionHandlers()

// OCV5-422:生产构建的入口样式表不再阻塞首次绘制(见 lib/nonBlockingCss)。样式到位前 #root 里是
// index.html 的内联占位;等样式就绪再挂载,React 的第一帧就带样式,不闪无样式界面。
void waitForEntryStyles().then(() => {
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
  if (!legalKind) {
    prefetchLazyCentersOnIdle()
    prefetchTapePayloadOnIdle()
  }
})
