import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import {
  type BoardSnapshot,
  type Pipeline,
  type PipelineStage,
  type Project,
  type Ticket,
  type TicketListQuery,
  type TicketRun,
  taskboardApi,
} from '../../lib/taskboard'
import { ToastProvider, TooltipProvider } from '../ui'
import { TicketDrawer } from './TicketDrawer'
import { useTaskboard } from './useTaskboard'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeAll(async () => {
  await import('../MarkdownImpl')
})

const auth = createMemoryAuthSession(() => {}, 'tok-owner')

function sampleTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    identifier: 'OCV5-42',
    projectId: 'p1',
    type: 'bug',
    title: '登录 500',
    body: '复现步骤',
    status: 'waiting_human',
    stageId: 's1',
    pipelineId: 'pipe1',
    priority: 'P0',
    severity: 'major',
    labels: ['auth'],
    assignee: 'agent:coding-assistant',
    reporter: 'user:default',
    source: 'manual',
    originSessionKey: null,
    dueDate: null,
    startDate: null,
    version: 3,
    blockedReason: null,
    stageLoopCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    closedAt: null,
    approvedBy: null,
    approvedAt: null,
    ...over,
  }
}

function sampleStage(over: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: 's1',
    pipelineId: 'pipe1',
    ordinal: 0,
    name: '实现',
    kind: 'ai',
    agentId: 'coding-assistant',
    model: null,
    promptTemplate: null,
    toolsets: null,
    effort: null,
    patrolCron: null,
    patrolEnabled: true,
    patrolTimezone: 'Asia/Shanghai',
    quietHoursStart: null,
    quietHoursEnd: null,
    maxRunsPerDay: 20,
    timeoutSec: 2400,
    maxRetries: 1,
    circuitBreakerThreshold: 3,
    onSuccess: 'wait_human',
    onFailure: 'block',
    autoClose: false,
    entryCondition: null,
    exitChecklist: null,
    requireHumanAck: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function sampleProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    key: 'OCV5',
    name: 'V5 自用',
    description: null,
    workspace: null,
    labels: [],
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function samplePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'pipe1',
    projectId: 'p1',
    name: '问题单默认线',
    ticketType: 'bug',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function emptyBoard(project: Project): BoardSnapshot {
  return {
    project,
    pipeline: samplePipeline({ projectId: project.id }),
    ticketType: 'bug',
    columns: [],
    inbox: [],
    backlog: { tickets: [] },
  }
}

function mockDrawerApis(byRef: Record<string, Ticket>) {
  vi.spyOn(taskboardApi, 'getTicketDetail').mockImplementation(async (_a, ref) => ({
    ticket: byRef[ref] ?? sampleTicket({ id: String(ref), identifier: String(ref), title: String(ref) }),
    pipeline: null,
    stage: sampleStage(),
  }))
  vi.spyOn(taskboardApi, 'listRuns').mockResolvedValue({ items: [], total: 0 })
  vi.spyOn(taskboardApi, 'listTimeline').mockResolvedValue([])
}

function boardMocks(projects: Project[] = [sampleProject()]) {
  vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue(projects)
  vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([])
  vi.spyOn(taskboardApi, 'getProjectBoard').mockImplementation(async (_a, pid) => {
    const project = projects.find((p) => p.id === pid) ?? projects[0]!
    return emptyBoard(project)
  })
}

describe('OCV5-180 leader regressions', () => {
  test('owner switch clears old pending patrol without letting old completion touch B', async () => {
    const A = sampleTicket({ id: 'a', identifier: 'A-1', title: 'A' })
    const B = sampleTicket({ id: 'b', identifier: 'B-1', title: 'B' })
    mockDrawerApis({ 'A-1': A, 'B-1': B })
    let finish!: (v: { ok: true; run: TicketRun; ticket: Ticket }) => void
    vi.spyOn(taskboardApi, 'patrol').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const ui = (t: Ticket) => (
      <ToastProvider>
        <TooltipProvider>
          <TicketDrawer
            auth={auth}
            ticket={t}
            ticketRef={t.identifier}
            open
            desktop
            agents={[]}
            stages={[sampleStage()]}
            sessionIds={[]}
            onClose={() => {}}
            onReconcile={() => {}}
            onTicketUpdated={() => {}}
          />
        </TooltipProvider>
      </ToastProvider>
    )
    const v = render(ui(A))
    await screen.findByText('A')
    fireEvent.click(screen.getByTestId('ticket-drawer-patrol'))
    expect(screen.getByTestId('ticket-drawer-patrol')).toBeDisabled()
    v.rerender(ui(B))
    await screen.findByText('B')
    await act(async () => {
      finish({
        ok: true,
        ticket: A,
        run: {
          id: 'r-a',
          ticketId: A.id,
          stageId: A.stageId ?? 's1',
          agentId: 'coding-assistant',
          trigger: 'manual',
          sessionKey: 'agent:coding-assistant:taskboard:a:s1:r-a',
          status: 'running',
          skipReason: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          startedAt: Date.now(),
          finishedAt: null,
          durationMs: null,
          tokensIn: null,
          tokensOut: null,
          costUsd: null,
          summary: null,
          outputMd: null,
          error: null,
          createdAt: Date.now(),
        },
      })
    })
    expect(screen.getByTestId('ticket-drawer-patrol')).not.toBeDisabled()
  })

  test('filter object cannot override locked project', async () => {
    boardMocks()
    const list = vi.spyOn(taskboardApi, 'listTickets').mockResolvedValue({ items: [], total: 0 })
    const box: { current: ReturnType<typeof useTaskboard> | null } = { current: null }
    function Harness() {
      box.current = useTaskboard(auth, true, null, 'p1')
      return null
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    )
    await waitFor(() => expect(box.current?.loading).toBe(false))
    await act(async () => {
      await box.current!.applyListQuery({ projectId: 'p2', q: 'term' })
    })
    const last = list.mock.calls.at(-1)?.[1] as TicketListQuery | undefined
    expect(last?.projectId).toBe('p1')
    expect(last?.q).toBe('term')
  })

  test('reconcile keeps already loaded second page reachable without disappearing', async () => {
    boardMocks()
    const rows = Array.from({ length: 201 }, (_, i) =>
      sampleTicket({ id: `row-${i}`, identifier: `R-${i}` }),
    )
    vi.spyOn(taskboardApi, 'listTickets').mockImplementation(async (_a, q) => {
      if (q?.status === 'backlog') return { items: [], total: 0 }
      const offset = q?.offset ?? 0
      // Match production http.ts + db/tickets.ts cap, not an unconstrained fake.
      const limit = Math.min(Math.max(q?.limit ?? 50, 1), 200)
      return { items: rows.slice(offset, offset + limit), total: 201 }
    })
    const box: { current: ReturnType<typeof useTaskboard> | null } = { current: null }
    function Harness() {
      box.current = useTaskboard(auth, true, null, 'p1')
      return null
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    )
    await waitFor(() => expect(box.current?.tickets?.length).toBe(200))
    await act(async () => {
      await box.current!.loadMoreTickets()
    })
    expect(box.current?.tickets?.length).toBe(201)
    await act(async () => {
      await box.current!.reconcile()
    })
    expect(box.current?.tickets?.length).toBe(201)
  })

  test('stale loadInitial for the previous lock cannot write after the lock switches', async () => {
    const p1 = sampleProject({ id: 'p1' })
    const p2 = sampleProject({ id: 'p2', key: 'OTHER', name: '另一个' })
    boardMocks([p1, p2])
    let releaseP1!: () => void
    const p1Gate = new Promise<void>((resolve) => {
      releaseP1 = resolve
    })
    vi.spyOn(taskboardApi, 'listTickets').mockImplementation(async (_a, q) => {
      if (q?.status === 'backlog') return { items: [], total: 0 }
      if (q?.projectId === 'p1') {
        await p1Gate
        return {
          items: [sampleTicket({ id: 'p1-late', identifier: 'P1-LATE', projectId: 'p1', title: 'late p1' })],
          total: 1,
        }
      }
      return {
        items: [sampleTicket({ id: 'p2-now', identifier: 'P2-NOW', projectId: 'p2', title: 'p2 now' })],
        total: 1,
      }
    })
    const box: { current: ReturnType<typeof useTaskboard> | null } = { current: null }
    function Harness({ locked }: { locked: string }) {
      box.current = useTaskboard(auth, true, null, locked)
      return null
    }
    const view = render(
      <ToastProvider>
        <Harness locked="p1" />
      </ToastProvider>,
    )
    await act(async () => {
      view.rerender(
        <ToastProvider>
          <Harness locked="p2" />
        </ToastProvider>,
      )
    })
    await waitFor(() => expect(box.current?.tickets?.some((t) => t.id === 'p2-now')).toBe(true))
    await act(async () => {
      releaseP1()
    })
    expect(box.current?.tickets?.some((t) => t.id === 'p1-late')).toBe(false)
    expect(box.current?.tickets?.some((t) => t.id === 'p2-now')).toBe(true)
  })

  test('backlog tab can reach item 201 via load more', async () => {
    boardMocks()
    const rows = Array.from({ length: 201 }, (_, i) =>
      sampleTicket({ id: `b-${i}`, identifier: `B-${i}`, status: 'backlog' }),
    )
    vi.spyOn(taskboardApi, 'listTickets').mockImplementation(async (_a, q) => {
      if (q?.status !== 'backlog') return { items: [], total: 0 }
      const offset = q.offset ?? 0
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
      return { items: rows.slice(offset, offset + limit), total: 201 }
    })
    const box: { current: ReturnType<typeof useTaskboard> | null } = { current: null }
    function Harness() {
      box.current = useTaskboard(auth, true, null, 'p1')
      return null
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    )
    await waitFor(() => expect(box.current?.backlogTickets.length).toBe(200))
    expect(box.current?.backlogTotal).toBe(201)
    await act(async () => {
      await box.current!.loadMoreBacklog()
    })
    expect(box.current?.backlogTickets.length).toBe(201)
  })
})

test('slow initial projects response cannot roll the chosen project back', async () => {
 const p1=sampleProject({id:'p1'}), p2=sampleProject({id:'p2',key:'OTHER'})
 boardMocks([p1,p2])
 let release!: (projects:Project[])=>void
 vi.spyOn(taskboardApi,'listProjects').mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
 vi.spyOn(taskboardApi,'listTickets').mockResolvedValue({items:[],total:0})
 const box:{current:ReturnType<typeof useTaskboard>|null}={current:null}
 function Harness({locked}:{locked:string}) {box.current=useTaskboard(auth,true,null,locked);return null}
 const view=render(<ToastProvider><Harness locked="p1"/></ToastProvider>)
 view.rerender(<ToastProvider><Harness locked="p2"/></ToastProvider>)
 await waitFor(()=>expect(box.current?.projectId).toBe('p2'))
 await act(async()=>{release([p1,p2])})
 expect(box.current?.projectId).toBe('p2')
})

test('reconcile invalidating initial data does not leave initial loading stuck', async () => {
 const projects=[sampleProject()]
 boardMocks(projects)
 let release!:(projects:Project[])=>void
 vi.spyOn(taskboardApi,'listProjects').mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
 vi.spyOn(taskboardApi,'listTickets').mockResolvedValue({items:[],total:0})
 const box:{current:ReturnType<typeof useTaskboard>|null}={current:null}
 function Harness(){box.current=useTaskboard(auth,true,null,'p1');return null}
 render(<ToastProvider><Harness/></ToastProvider>)
 await act(async()=>{await box.current!.reconcile()})
 await act(async()=>{release(projects)})
 expect(box.current?.loading).toBe(false)
})
