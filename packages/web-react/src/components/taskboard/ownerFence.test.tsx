import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import {
  type PipelineStage,
  type Project,
  type Ticket,
  taskboardApi,
} from '../../lib/taskboard'
import { ToastProvider, TooltipProvider } from '../ui'
import { TicketDrawer } from './TicketDrawer'
import { TicketListView } from './TicketListView'
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

function mockDrawerApis(byRef: Record<string, Ticket>) {
  vi.spyOn(taskboardApi, 'getTicketDetail').mockImplementation(async (_a, ref) => ({
    ticket: byRef[ref] ?? sampleTicket({ id: ref, identifier: String(ref), title: String(ref) }),
    pipeline: null,
    stage: sampleStage(),
  }))
  vi.spyOn(taskboardApi, 'listRuns').mockResolvedValue({ items: [], total: 0 })
  vi.spyOn(taskboardApi, 'listTimeline').mockResolvedValue([])
}

describe('FQ-01 TicketDrawer owner fence', () => {
  test('A → close → B shows B and requests B, not leftover A', async () => {
    const A = sampleTicket({ id: 'a', identifier: 'A-1', title: 'Ticket A' })
    const B = sampleTicket({ id: 'b', identifier: 'B-1', title: 'Ticket B' })
    const requested: string[] = []
    vi.spyOn(taskboardApi, 'getTicketDetail').mockImplementation(async (_a, ref) => {
      requested.push(String(ref))
      return { ticket: ref === 'B-1' || ref === 'b' ? B : A, pipeline: null, stage: sampleStage() }
    })
    vi.spyOn(taskboardApi, 'listRuns').mockResolvedValue({ items: [], total: 0 })
    vi.spyOn(taskboardApi, 'listTimeline').mockResolvedValue([])

    const view = render(
      <ToastProvider>
        <TooltipProvider>
          <TicketDrawer
            auth={auth}
            ticket={A}
            ticketRef="A-1"
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
      </ToastProvider>,
    )
    expect(await screen.findByText('Ticket A')).toBeInTheDocument()

    await act(async () => {
      view.rerender(
        <ToastProvider>
          <TooltipProvider>
            <TicketDrawer
              auth={auth}
              ticket={null}
              ticketRef={null}
              open={false}
              desktop
              agents={[]}
              stages={[sampleStage()]}
              sessionIds={[]}
              onClose={() => {}}
              onReconcile={() => {}}
              onTicketUpdated={() => {}}
            />
          </TooltipProvider>
        </ToastProvider>,
      )
    })
    await act(async () => {
      view.rerender(
        <ToastProvider>
          <TooltipProvider>
            <TicketDrawer
              auth={auth}
              ticket={B}
              ticketRef="B-1"
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
        </ToastProvider>,
      )
    })

    expect(await screen.findByText('Ticket B')).toBeInTheDocument()
    expect(screen.queryByText('Ticket A')).not.toBeInTheDocument()
    expect(requested).toContain('B-1')
  })

  test('slow A detail cannot overwrite B after switch', async () => {
    const A = sampleTicket({ id: 'a', identifier: 'A-1', title: 'Ticket A' })
    const B = sampleTicket({ id: 'b', identifier: 'B-1', title: 'Ticket B' })
    let finishA: (ticket: Ticket) => void = () => {}
    const aDetail = new Promise<{ ticket: Ticket; pipeline: null; stage: PipelineStage }>((resolve) => {
      finishA = (ticket) => resolve({ ticket, pipeline: null, stage: sampleStage() })
    })
    vi.spyOn(taskboardApi, 'getTicketDetail').mockImplementation(async (_a, ref) => {
      if (ref === 'A-1') return aDetail
      return { ticket: B, pipeline: null, stage: sampleStage() }
    })
    vi.spyOn(taskboardApi, 'listRuns').mockResolvedValue({ items: [], total: 0 })
    vi.spyOn(taskboardApi, 'listTimeline').mockResolvedValue([])

    const view = render(
      <ToastProvider>
        <TooltipProvider>
          <TicketDrawer
            auth={auth}
            ticket={A}
            ticketRef="A-1"
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
      </ToastProvider>,
    )
    await act(async () => {
      view.rerender(
        <ToastProvider>
          <TooltipProvider>
            <TicketDrawer
              auth={auth}
              ticket={B}
              ticketRef="B-1"
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
        </ToastProvider>,
      )
    })
    expect(await screen.findByText('Ticket B')).toBeInTheDocument()
    await act(async () => {
      finishA(A)
    })
    expect(screen.getByText('Ticket B')).toBeInTheDocument()
    expect(screen.queryByText('Ticket A')).not.toBeInTheDocument()
  })

  test('same-ticket poll does not overwrite an in-progress edit', async () => {
    const A = sampleTicket({ id: 'a', identifier: 'A-1', title: 'Ticket A', body: 'orig' })
    mockDrawerApis({ 'A-1': A, a: A })
    const view = render(
      <ToastProvider>
        <TooltipProvider>
          <TicketDrawer
            auth={auth}
            ticket={A}
            ticketRef="A-1"
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
      </ToastProvider>,
    )
    expect(await screen.findByText('Ticket A')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ticket-drawer-edit'))
    const title = screen.getByLabelText('单据标题')
    fireEvent.change(title, { target: { value: 'user edit' } })
    const polled = sampleTicket({ ...A, version: 4, title: 'server title' })
    vi.spyOn(taskboardApi, 'getTicketDetail').mockResolvedValue({
      ticket: polled,
      pipeline: null,
      stage: sampleStage(),
    })
    await act(async () => {
      view.rerender(
        <ToastProvider>
          <TooltipProvider>
            <TicketDrawer
              auth={auth}
              ticket={polled}
              ticketRef="A-1"
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
        </ToastProvider>,
      )
    })
    expect(screen.getByLabelText('单据标题')).toHaveValue('user edit')
  })
})

describe('FQ-02 list queries stay in the locked project', () => {
  test('initial load and reconcile both send the current projectId', async () => {
    const p1 = sampleProject({ id: 'p1' })
    const p2 = sampleProject({ id: 'p2', key: 'OTHER', name: '另一个' })
    const queries: Array<Record<string, unknown> | undefined> = []
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([p1, p2])
    vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([])
    vi.spyOn(taskboardApi, 'getProjectBoard').mockResolvedValue({
      project: p1,
      pipeline: {
        id: 'pipe1',
        projectId: 'p1',
        name: '默认',
        ticketType: 'bug',
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
      ticketType: 'bug',
      columns: [],
      inbox: [],
      backlog: { tickets: [] },
    })
    vi.spyOn(taskboardApi, 'listTickets').mockImplementation(async (_a, q) => {
      queries.push(q as Record<string, unknown>)
      const pid = q?.projectId
      const items =
        pid === 'p1'
          ? [sampleTicket({ id: 'p1-ticket', identifier: 'P1-1', projectId: 'p1', title: 'P1' })]
          : [
              sampleTicket({ id: 'p1-ticket', identifier: 'P1-1', projectId: 'p1', title: 'P1' }),
              sampleTicket({ id: 'p2-ticket', identifier: 'P2-1', projectId: 'p2', title: 'P2' }),
            ]
      return { items, total: items.length }
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
    await waitFor(() => expect(box.current?.tickets?.some((t) => t.id === 'p1-ticket')).toBe(true))
    expect(box.current?.tickets?.some((t) => t.id === 'p2-ticket')).toBe(false)
    await act(async () => {
      await box.current!.reconcile()
    })
    expect(box.current?.tickets?.some((t) => t.id === 'p2-ticket')).toBe(false)
    expect(queries.length).toBeGreaterThanOrEqual(2)
    for (const q of queries.filter((item) => item && item.status !== 'backlog')) {
      expect(q?.projectId).toBe('p1')
    }
  })
})

describe('P3 create single-flight and list pagination', () => {
  test('createTicket ignores a second in-flight submit', async () => {
    const p1 = sampleProject()
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([p1])
    vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([])
    vi.spyOn(taskboardApi, 'getProjectBoard').mockResolvedValue({
      project: p1,
      pipeline: {
        id: 'pipe1',
        projectId: 'p1',
        name: '默认',
        ticketType: 'bug',
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
      ticketType: 'bug',
      columns: [],
      inbox: [],
      backlog: { tickets: [] },
    })
    vi.spyOn(taskboardApi, 'listTickets').mockResolvedValue({ items: [], total: 0 })
    let finish: (ticket: Ticket) => void = () => {}
    const created = sampleTicket({ id: 'new', identifier: 'OCV5-1', status: 'backlog' })
    const createSpy = vi.spyOn(taskboardApi, 'createTicket').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = (ticket) => resolve({ ok: true, ticket })
        }),
    )

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
    await waitFor(() => expect(box.current?.projectId).toBe('p1'))
    let first!: Promise<Ticket | null>
    await act(async () => {
      first = box.current!.createTicket({
        projectId: 'p1',
        type: 'bug',
        title: 'one',
      })
    })
    expect(box.current!.createBusy).toBe(true)
    const second = box.current!.createTicket({
      projectId: 'p1',
      type: 'bug',
      title: 'two',
    })
    expect(createSpy).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish(created)
      await Promise.all([first, second])
    })
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(box.current!.createBusy).toBe(false)
  })

  test('truncated lists expose load-more for total > 200', async () => {
    const onLoadMore = vi.fn()
    const rows = Array.from({ length: 200 }, (_, i) =>
      sampleTicket({ id: `t${i}`, identifier: `OCV5-${i}`, title: `row ${i}` }),
    )
    render(
      <TooltipProvider>
        <TicketListView
          tickets={rows}
          query={{}}
          onQueryChange={() => {}}
          total={201}
          onLoadMore={onLoadMore}
        />
      </TooltipProvider>,
    )
    expect(screen.getByTestId('ticket-list-truncated')).toHaveTextContent('已显示 200 / 201 条')
    fireEvent.click(screen.getByTestId('ticket-list-load-more'))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })
})
