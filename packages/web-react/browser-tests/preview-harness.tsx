import { createRoot } from 'react-dom/client'

import { ContainerWebPreview } from '../src/components/ContainerWebPreview'
import { createMemoryAuthSession } from '../src/lib/authSession'

declare global {
  interface Window {
    __mountContainerPreview: () => void
    __unmountContainerPreview: () => void
  }
}

const auth = createMemoryAuthSession(() => {}, 'browser-preview-token')
let root: ReturnType<typeof createRoot> | null = null

window.__mountContainerPreview = () => {
  root?.unmount()
  root = createRoot(document.getElementById('root')!)
  root.render(
    <ContainerWebPreview
      open
      sourceUrl="http://localhost:4173/"
      auth={auth}
      onClose={() => {}}
      onUseComments={() => {}}
    />,
  )
}

window.__unmountContainerPreview = () => {
  root?.unmount()
  root = null
}
