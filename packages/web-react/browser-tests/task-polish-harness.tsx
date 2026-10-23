// Isolated real components; no backend or real account data.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TicketListView } from '../src/components/taskboard/TicketListView'
import { TicketDrawer } from '../src/components/taskboard/TicketDrawer'
import { VirtualList } from '../src/components/sidebar/VirtualList'
import { ToastProvider, TooltipProvider } from '../src/components/ui'
import { ApiError } from '../src/lib/api'
import { createMemoryAuthSession } from '../src/lib/authSession'
import { taskboardApi, type Ticket, type PipelineStage, type TicketListQuery } from '../src/lib/taskboard'
import type { FlatItem } from '../src/components/sidebar/flattenItems'

const control = window as unknown as Record<string, unknown>
const auth = createMemoryAuthSession(() => {})
function ticket(n: number, status: Ticket['status'] = 'ready'): Ticket {
  return { id: `ticket-${n}`, identifier: `FIX-${n}`, projectId: 'fixture', type: 'spike', title: `任务 ${n}`, body: '保留任务说明和用户草稿。', status, stageId: 'ai-stage', pipelineId: 'fixture-line', priority: 'P2', severity: null, labels: [], assignee: null, reporter: 'human', source: 'manual', originSessionKey: null, dueDate: null, startDate: null, version: 1, blockedReason: null, stageLoopCount: 0, createdAt: Date.now(), updatedAt: Date.now(), closedAt: null, approvedBy: 'human', approvedAt: Date.now() }
}
const stage = { id: 'ai-stage', name: '整理', kind: 'ai', agentId: 'main' } as PipelineStage

function List() {
  const [size, setSize] = useState(1000)
  const [query, setQuery] = useState<TicketListQuery>({ status: 'ready,running' })
  const [opened, setOpened] = useState('')
  control.shrink = () => setSize(7)
  control.grow = () => setSize(1000)
  control.unfilter = () => setQuery({ status: 'ready,running' })
  control.update = () => setQuery((q) => ({ ...q }))
  control.filter = () => setQuery((q) => ({ ...q, type: 'spike' }))
  return <><output data-testid="opened">{opened}</output><TicketListView tickets={Array.from({ length: size }, (_, i) => ticket(i + 1))} query={query} onQueryChange={setQuery} onOpenTicket={(t) => setOpened(t.identifier)} total={size} /></>
}
function HiddenSidebar() {
  const [shown, setShown] = useState(false)
  control.reveal = () => setShown(true)
  const items = Array.from({ length: 1000 }, (_, i) => ({ key: `item-${i}`, height: 32, kind: 'session' })) as unknown as FlatItem[]
  return <div style={{ display: shown ? 'block' : 'none' }}><VirtualList className="virtual-fixture" items={items} renderItem={(item) => <span>{item.key}</span>} /></div>
}
function Drawer() {
  const initial = new URLSearchParams(location.search).get('status') === 'backlog' ? 'backlog' : 'running'
  const [row, setRow] = useState(() => ticket(1, initial))
  const [open, setOpen] = useState(true)
  let server = row
  // Keep the server-side fixture independent of React's displayed row.
  const serverRef = useState(() => ({ row: ticket(1, initial), hold: false, held: null as null | (() => void), calls: 0, active: 0, maxActive: 0, patchVersion: 0 }))[0]
  const [writes, setWrites] = useState(0)
  taskboardApi.patchTicket = async (_a, _id, body) => {
    serverRef.patchVersion = body.expectedVersion
    if (body.expectedVersion !== serverRef.row.version) throw new ApiError({ status: 409, message: 'version conflict', code: 'version_conflict' })
    serverRef.row = { ...serverRef.row, title: body.title ?? serverRef.row.title, version: serverRef.row.version + 1 }
    return { ok: true, ticket: serverRef.row }
  }
  taskboardApi.getTicketDetail = async () => {
    const snapshot = serverRef.row
    serverRef.calls += 1
    serverRef.active += 1
    serverRef.maxActive = Math.max(serverRef.maxActive, serverRef.active)
    try {
    if (serverRef.hold) {
      serverRef.hold = false
      await new Promise<void>((resolve) => { serverRef.held = resolve })
    }
    return { ticket: snapshot, stage }
    } finally { serverRef.active -= 1 }
  }
  taskboardApi.listRuns = async () => ({ items: [], total: 0 })
  taskboardApi.listTimeline = async () => []
  control.finish = () => { serverRef.row = { ...serverRef.row, version: serverRef.row.version + 1, status: 'waiting_human' } }
  control.clientStatus = () => serverRef.calls
  control.stats = () => ({ maxActive: serverRef.maxActive, patchVersion: serverRef.patchVersion, body: serverRef.row.body })
  control.externalEdit = () => { serverRef.row = { ...serverRef.row, body: '另一客户端保存的最新正文', version: serverRef.row.version + 1 }; document.dispatchEvent(new Event('visibilitychange')) }
  control.delayPoll = () => { serverRef.hold = true; document.dispatchEvent(new Event('visibilitychange')) }
  control.isHeld = () => !!serverRef.held
  control.switchOwner = () => { server = ticket(2); serverRef.row = server; setRow(server) }
  control.releasePoll = () => { const done = serverRef.held; serverRef.held = null; done?.() }
  return <><output data-testid="client-status">{row.status}</output><output data-testid="client-version">{row.version}</output><output data-testid="writes">{writes}</output><TicketDrawer auth={auth} ticket={row} ticketRef={row.identifier} open={open} desktop={matchMedia('(min-width: 768px)').matches} agents={[]} stages={[stage]} sessionIds={[]} onClose={() => setOpen(false)} onReconcile={() => {}} onDetailLoaded={setRow} onTicketUpdated={(next) => { setWrites((n) => n + 1); setRow(next) }} /></>
}
const scenario = new URLSearchParams(location.search).get('scenario')
createRoot(document.getElementById('root')!).render(<TooltipProvider><ToastProvider>{scenario === 'list' ? <List /> : scenario === 'hidden' ? <HiddenSidebar /> : <Drawer />}</ToastProvider></TooltipProvider>)
