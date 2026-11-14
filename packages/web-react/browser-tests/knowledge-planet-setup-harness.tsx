import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ManagedBrowserSetupDialog } from '../src/components/settings/plugins/ManagedBrowserSetupDialog'
import { api, ApiError } from '../src/lib/api'
import { createMemoryAuthSession } from '../src/lib/authSession'
import type { KnowledgePlanetSetupView, RuntimePluginCatalogEntry } from '../src/lib/connectors'

const mode = new URLSearchParams(location.search).get('mode') ?? 'failure'
const fixture = { starts: 0, polls: 0, qrLoads: 0, cancels: 0, bound: 0, finishQr: () => {}, finishStart: () => {} }
Object.assign(window, { kpFixture: fixture })
const auth = createMemoryAuthSession(() => {}, 'fixture')
const plugin = { slug: 'knowledge-planet', label: '知识星球', versionId: '41' } as RuntimePluginCatalogEntry
const waiting = (): KnowledgePlanetSetupView => ({
  sessionId: `fixture-${fixture.starts}`, status: 'waiting_for_scan', phase: 'generating_qr', qrReady: false,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240000).toISOString(),
})
const waitingWithQr = (): KnowledgePlanetSetupView => ({
  ...waiting(), qrReady: true, qrRevision: 1, phase: 'waiting_for_scan',
})
api.startKnowledgePlanetSetup = async () => {
  fixture.starts++
  if (mode === 'capacity' && fixture.starts === 1) throw new ApiError({ message: 'capacity', code: 'CAPACITY_EXCEEDED', status: 429 })
  if (mode === 'pending') return new Promise((resolve) => { fixture.finishStart = () => resolve(waiting()) })
  if (mode === 'scan-success') return waitingWithQr()
  return { ...waiting(), ...(mode === 'late-qr' ? { qrReady: true, qrRevision: 1, phase: 'waiting_for_scan' as const } : {}) }
}
api.getKnowledgePlanetSetup = async () => {
  fixture.polls++
  if (mode === 'scan-success') {
    if (fixture.polls < 2) return waitingWithQr()
    return { ...waiting(), status: 'active', phase: 'active', accountId: '42', agentReady: true }
  }
  if (fixture.starts === 1 && mode !== 'capacity') return {
    ...waiting(), status: 'failed', phase: 'failed', qrReady: false,
    errorCode: mode === 'timeout' ? 'QR_GENERATION_TIMEOUT' : 'QR_GENERATION_FAILED',
  }
  return { ...waiting(), status: 'active', phase: 'active', accountId: '42', agentReady: true }
}
api.getKnowledgePlanetSetupQr = async () => {
  fixture.qrLoads++
  if (mode === 'scan-success') return new Blob(['fixture png'], { type: 'image/png' })
  return new Promise((resolve) => { fixture.finishQr = () => resolve(new Blob(['fixture png'], { type: 'image/png' })) })
}
api.cancelKnowledgePlanetSetup = async () => { fixture.cancels++; return { ...waiting(), status: 'cancelled', phase: 'cancelled' } }
function Harness() {
  const [open, setOpen] = useState(true)
  return open ? <ManagedBrowserSetupDialog auth={auth} plugin={plugin} relinkAccountId={null}
    onClose={() => setOpen(false)} onBound={() => { fixture.bound++ }} /> : <p>已关闭</p>
}
createRoot(document.getElementById('root')!).render(<Harness />)
