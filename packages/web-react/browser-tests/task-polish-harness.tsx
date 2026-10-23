// Isolated real components; no backend or real account data.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TicketListView } from '../src/components/taskboard/TicketListView'
import { TicketDrawer } from '../src/components/taskboard/TicketDrawer'
import { VirtualList } from '../src/components/sidebar/VirtualList'
import { ToastProvider, TooltipProvider } from '../src/components/ui'
import { ApiError } from '../src/lib/api'
import { createMemoryAuthSession } from '../src/lib/authSession'
import { taskboardApi, type Ticket, type PipelineStage, type TicketListQuery, type TicketRun, type TimelineItem } from '../src/lib/taskboard'
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
function ExecutionDrawer() {
  const [row, setRow] = useState(() => ticket(3, 'running'))
  const [open, setOpen] = useState(true)
  const run = (id: string): TicketRun => ({ id, ticketId: row.id, stageId: stage.id, agentId: 'main',
    status: 'running', trigger: 'manual', sessionKey: `exact-${id}`, startedAt: Date.now(), finishedAt: null,
    durationMs: null, tokensIn: null, tokensOut: null, costUsd: null, costImprecise: null,
    summary: null, outputMd: null, error: null, skipReason: null, leaseOwner: 'fixture-owner',
    leaseExpiresAt: Date.now() + 60_000, createdAt: Date.now(), actualModels: [`actual-${id}`],
    preview: { text: `真实执行进度 ${id}`, toolNames: ['Bash'], lastActivityAt: Date.now() } })
  const [server] = useState(() => ({ row: ticket(3, 'running'), run: run('r1'), history: [] as TicketRun[],
    holdReady: false, heldReady: null as null | (() => void), delayStop: true, heldStop: null as null | (() => void), holdTimeline: false,
    heldTimeline: null as null | (() => void), readyVersions: [] as number[], patrolVersions: [] as number[] }))
  const saveRun = (next: TicketRun) => { server.run = next; server.history = [...server.history.filter((r) => r.id !== next.id), next] }
  if (!server.history.length) server.history = [server.run]
  taskboardApi.getTicketDetail = async () => ({ ticket: { ...server.row }, stage, execution: { ...server.run, outputMd: null, summary: null } })
  taskboardApi.listRuns = async () => ({ items: server.history.map((r) => ({ ...r })), total: server.history.length })
  taskboardApi.listTimeline = async () => {
    const items = server.history.map((r) => ({ kind: 'run' as const, createdAt: r.createdAt, run: { ...r } }))
    if (server.holdTimeline) {
      server.holdTimeline = false
      await new Promise<void>((resolve) => { server.heldTimeline = resolve })
    }
    return items
  }
  taskboardApi.stopRun = async (_auth, _ticket, version, runId) => {
    if (version !== server.row.version || runId !== server.run.id) throw new ApiError({ status: 409, code: 'run_changed', message: 'run changed' })
    server.row = { ...server.row, status: 'blocked', blockedReason: '用户停止本次执行', version: version + 1 }
    saveRun({ ...server.run, stopRequested: true })
    const snapshot = { ok: true as const, state: 'stopping' as const, ticket: { ...server.row }, run: { ...server.run } }
    if (server.delayStop) await new Promise<void>((resolve) => { server.heldStop = resolve })
    return snapshot
  }
  taskboardApi.ready = async (_auth, _id, version) => {
    if (version !== server.row.version) throw new ApiError({ status: 409, code: 'version_conflict', message: 'version conflict' })
    server.readyVersions.push(version)
    server.row = { ...server.row, status: 'ready', version: version + 1 }
    const snapshot = { ok: true, ticket: { ...server.row } }
    if (server.holdReady) await new Promise<void>((resolve) => { server.heldReady = resolve })
    return snapshot
  }
  taskboardApi.patrol = async (_auth, _id, version) => {
    if (version !== server.row.version) throw new ApiError({ status: 409, code: 'version_conflict', message: 'version conflict' })
    server.patrolVersions.push(version)
    server.row = { ...server.row, status: 'running', blockedReason: null, version: version + 1 }
    saveRun(run('r2'))
    return { ok: true, ticket: { ...server.row }, run: { ...server.run } }
  }
  control.holdReady = () => { server.holdReady = true }
  control.isReadyHeld = () => !!server.heldReady
  control.releaseReady = () => { const resolve = server.heldReady; server.heldReady = null; resolve?.() }
  control.switchExecutionOwner = () => {
    const next = ticket(4, 'running')
    server.row = next
    server.run = { ...run('other'), ticketId: next.id }
    server.history = [server.run]
    setRow(next)
  }
  control.executionStats = () => ({ runId: server.run.id, readyVersions: server.readyVersions, patrolVersions: server.patrolVersions })
  control.isStopHeld = () => !!server.heldStop
  control.releaseStop = () => { const resolve = server.heldStop; server.heldStop = null; resolve?.() }
  control.immediateStop = () => { server.delayStop = false }
  control.holdTimeline = () => { server.holdTimeline = true }
  control.isTimelineHeld = () => !!server.heldTimeline
  control.releaseTimeline = () => { const resolve = server.heldTimeline; server.heldTimeline = null; resolve?.() }
  control.reapExecution = () => {
    saveRun({ ...server.run, status: 'timeout', settling: true, stopRequested: true, error: 'lease expired', finishedAt: Date.now() })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  control.completeExecution = () => {
    saveRun({ ...server.run, status: server.run.status === 'timeout' ? 'timeout' : 'failed', settling: false, error: server.run.status === 'timeout' ? 'lease expired' : 'USER_CANCELLED: stopped', stopRequested: false,
      finishedAt: Date.now(), outputMd: '完整付费结果 FIRST_PAID_OUTPUT_END', preview: undefined })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  return <TicketDrawer auth={auth} ticket={row} ticketRef={row.identifier} open={open} desktop={matchMedia('(min-width: 768px)').matches}
    agents={[]} stages={[stage]} sessionIds={[]} onClose={() => setOpen(false)} onReconcile={() => {}}
    onDetailLoaded={setRow} onTicketUpdated={setRow} />
}
function ResultHistoryDrawer() {
  const [row, setRow] = useState(() => ticket(5, 'blocked'))
  const [server] = useState(() => ({ newest: 520, reads: 0, earlier: [] as string[], fullReads: 0 }))
  const record = (n: number): TimelineItem => ({ kind: 'activity', createdAt: 10000 + n * 600000, activity: { id: `activity-${n}`, ticketId: row.id, actor: 'system', actorId: 'system', action: `HISTORY_RECORD_${n}`, field: null, fromValue: null, toValue: null, runId: null, createdAt: 10000 + n * 600000 } })
  const current = { id: 'old-created-paid', ticketId: row.id, stageId: stage.id, agentId: 'main', trigger: 'manual', status: 'failed', createdAt: 1, startedAt: 1, finishedAt: 2, outputMd: null, summary: null, settling: false, actualModels: ['actual-paid'], costUsd: null, costImprecise: true } as TicketRun
  const output = `# 完整归档\n\n${'长结果内容。'.repeat(2000)}\n\nPAID_RESULT_END\n\n\`\`\`ui\n${JSON.stringify({ type: 'suggestions', items: ['历史只读操作'] })}\n\`\`\``
  taskboardApi.getTicketDetail = async () => ({ ticket: row, stage, execution: current })
  taskboardApi.listTimelinePage = async (_auth, _id, options = {}) => {
    server.reads += 1
    const head = `rev-${server.newest}`
    const end = options.before ? Number(options.before) - 1 : server.newest
    if (options.before) server.earlier.push(options.before)
    const start = Math.max(1, end - 99)
    return { window: 'latest-v1', items: options.ifHead === head ? [] : Array.from({ length: end - start + 1 }, (_, i) => record(start + i)), hasMore: start > 1, nextBefore: start > 1 ? String(start) : null, head, unchanged: options.ifHead === head }
  }
  taskboardApi.getRun = async () => { server.fullReads += 1; return { ...current, outputMd: output } }
  taskboardApi.listRuns = async () => { throw new Error('Modern window must not load legacy runs') }
  control.historyStats = () => ({ reads: server.reads, earlier: server.earlier, fullReads: server.fullReads })
  control.burstHistory = () => { server.newest = 670; document.dispatchEvent(new Event('visibilitychange')) }
  return <TicketDrawer auth={auth} ticket={row} ticketRef={row.identifier} open desktop={matchMedia('(min-width: 768px)').matches} agents={[]} stages={[stage]} sessionIds={[]} onClose={() => {}} onReconcile={() => {}} onDetailLoaded={setRow} onTicketUpdated={setRow} />
}
const scenario = new URLSearchParams(location.search).get('scenario')
createRoot(document.getElementById('root')!).render(<TooltipProvider><ToastProvider>{scenario === 'list' ? <List /> : scenario === 'hidden' ? <HiddenSidebar /> : scenario === 'execution' ? <ExecutionDrawer /> : scenario === 'history' ? <ResultHistoryDrawer /> : <Drawer />}</ToastProvider></TooltipProvider>)
