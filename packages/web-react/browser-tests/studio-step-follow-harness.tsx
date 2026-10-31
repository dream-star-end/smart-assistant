import { createRoot } from 'react-dom/client'
import { StudioApp } from '../src/components/studio/StudioApp'
import { ToastProvider, TooltipProvider } from '../src/components/ui'
import { createMemoryAuthSession } from '../src/lib/authSession'
import { emitStudioPush } from '../src/lib/studio/push'

const ID = '11111111-2222-4333-8444-555555555555'
const firstPage = new URLSearchParams(location.search).get('page') === 'voice' ? 'voice' : 'brief'
history.replaceState(null, '', `/studio/p/${ID}/${firstPage}`)
const auth = createMemoryAuthSession(() => {
  throw new Error('Unexpected fixture auth expiration')
}, 'studio-step-browser-fixture-token')

declare global {
  interface Window {
    studioStepFollow: { push: () => void }
  }
}
// Only the real socket-to-hook refresh signal is exposed. HTTP aggregates remain at the
// network boundary; product state, route navigation, form input and dirty latch are real.
window.studioStepFollow = { push: () => emitStudioPush(ID) }

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <TooltipProvider>
      <StudioApp auth={auth} theme="light" onCycleTheme={() => {}} />
    </TooltipProvider>
  </ToastProvider>,
)
