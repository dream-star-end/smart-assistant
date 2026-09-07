import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TutorialCenter } from '../src/components/TutorialCenter'
import { TooltipProvider, ToastProvider } from '../src/components/ui'
import { parseTutorialCaseId, type TutorialCaseId } from '../src/lib/tutorialCaseId'
import type { ProductFeatureId } from '../src/lib/productCapabilities'
import '../src/styles.css'
function Preview() {
  const [open, setOpen] = useState(true)
  const [caseId, setCase] = useState<TutorialCaseId | null>(() => parseTutorialCaseId(new URLSearchParams(location.search).get('case')))
  const [topic, setTopic] = useState<ProductFeatureId | null>(null)
  const [draft, setDraft] = useState('')
  return <ToastProvider><TooltipProvider><main className="mx-auto max-w-3xl p-8">
    <h1 className="text-title">案例展厅交互预览</h1><p className="my-4 text-muted">这是实际产品组件的隔离预览，不会发送任务或产生模型费用。</p>
    <button onClick={() => { setOpen(true); setCase(null); setTopic(null) }}>打开案例展厅</button>
    {draft && <><h2 className="mt-6">任务已带入草稿（未发送）</h2><textarea aria-label="任务草稿" className="mt-4 h-64 w-full border p-3" value={draft} onChange={(e) => setDraft(e.target.value)} /></>}
    <TutorialCenter open={open} topicId={topic} caseId={caseId}
      onTopicChange={(id) => { setTopic(id); setCase(null) }}
      onCaseChange={(id) => { setCase(id); setTopic(null) }}
      onShowCaseGallery={() => { setCase(null); setTopic(null) }}
      onClose={() => setOpen(false)}
      actionState={() => ({ enabled: false, label: '仅供预览', disabledReason: '隔离预览不打开真实工作区。' })}
      onRunAction={() => {}}
      onRunCase={(item) => { setDraft(item.starterPrompt); setOpen(false) }}
    />
  </main></TooltipProvider></ToastProvider>
}
createRoot(document.getElementById('root')!).render(<Preview />)
