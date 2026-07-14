import { createRoot } from 'react-dom/client'
import { TutorialCaptureStudio } from './components/tutorial/TutorialCaptureStudio'
import { ToastProvider, TooltipProvider } from './components/ui'
import './styles.css'

const params = new URLSearchParams(location.search)

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <TooltipProvider>
      <TutorialCaptureStudio
        scene={params.get('scene') ?? 'workspace'}
        step={Number(params.get('step') ?? 0)}
      />
    </TooltipProvider>
  </ToastProvider>,
)
