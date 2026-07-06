import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, prefetchLazyCentersOnIdle } from './App'
import { ToastProvider, TooltipProvider } from './components/ui'
import { registerServiceWorker } from './registerSW'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ToastProvider>
  </StrictMode>,
)

// PWA:仅生产 + 安全上下文注册(见 registerSW)。放渲染之后,不阻塞首屏。
registerServiceWorker()

// UX 体验对冲:空闲期预取四大中心懒块(见 App.tsx 注释),首开零延迟。
prefetchLazyCentersOnIdle()
