import { type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import {
  type BoardAgent,
  type BoardSnapshot,
  type Project,
  type ProjectCreateInput,
  type ProjectPatchInput,
  type Ticket,
  type TicketCreateInput,
  type TicketListQuery,
  type TicketMoveInput,
  type TicketMoveResult,
  type TicketType,
  ACTIVE_LIST_STATUSES,
  boardErrorCode,
  boardErrorDetail,
  isVersionConflict,
  pickInitialProject,
  readLastProjectId,
  taskboardApi,
  taskboardErrorMessage,
  writeLastProjectId,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import { useToast } from '../ui'

const POLL_MS = 60_000
const LIST_PAGE_SIZE = 200

export type TicketAction =
  | { kind: 'ready' }
  | { kind: 'approve'; close?: boolean }
  | { kind: 'reject'; reason: string; targetStageId?: string | null }
  | { kind: 'block'; reason: string }
  | { kind: 'done' }
  | { kind: 'cancel'; reason?: string | null }

function optimisticStatus(action: TicketAction): Ticket['status'] | undefined {
  switch (action.kind) {
    case 'ready':
      return 'ready'
    case 'approve':
      return action.close ? 'done' : 'ready'
    case 'reject':
      return 'ready'
    case 'block':
      return 'blocked'
    case 'done':
      return 'done'
    case 'cancel':
      return 'canceled'
  }
}

export function useTaskboard(
  auth: AuthSession | null,
  enabled: boolean,
  ticketTypeFromUrl?: TicketType | null,
  lockedProjectId?: string | null,
) {
  const toast = useToast()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [board, setBoard] = useState<BoardSnapshot | null>(null)
  const [agents, setAgents] = useState<BoardAgent[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [ticketType, setTicketType] = useState<TicketType | ''>(ticketTypeFromUrl ?? '')
  const [listQuery, setListQuery] = useState<TicketListQuery>({ status: ACTIVE_LIST_STATUSES })
  const [backlogTickets, setBacklogTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [listLoadingMore, setListLoadingMore] = useState(false)
  const [backlogTotal, setBacklogTotal] = useState(0)
  const [backlogLoadingMore, setBacklogLoadingMore] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)

  const authRef = useRef(auth)
  authRef.current = auth
  const listQueryRef = useRef(listQuery)
  listQueryRef.current = listQuery
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const lockedProjectIdRef = useRef(lockedProjectId)
  lockedProjectIdRef.current = lockedProjectId
  const ticketsRef = useRef(tickets)
  ticketsRef.current = tickets
  const backlogRef = useRef(backlogTickets)
  backlogRef.current = backlogTickets
  const ticketTypeRef = useRef(ticketType)
  ticketTypeRef.current = ticketType
  const explicitType = useRef(!!ticketTypeFromUrl)
  const mounted = useRef(true)
  const epoch = useRef(0)
  const initialLoadGeneration = useRef(0)
  const createInFlight = useRef(false)
  const loadMoreInFlight = useRef(false)
  const backlogMoreInFlight = useRef(false)

  const scopedQuery = useCallback((extra?: Partial<TicketListQuery>): TicketListQuery => {
    // Locked project is the owner. Filters must not override it; selectProject
    // passes the id only when the lock is absent or already equal to that id.
    const pid = lockedProjectIdRef.current || extra?.projectId || projectIdRef.current || undefined
    return {
      ...listQueryRef.current,
      ...extra,
      limit: extra?.limit ?? LIST_PAGE_SIZE,
      offset: extra?.offset ?? 0,
      ...(pid ? { projectId: pid } : {}),
    }
  }, [])

  const applyListPage = useCallback((items: Ticket[], total: number, append: boolean) => {
    setListTotal(total)
    if (append) {
      setTickets((cur) => {
        const have = new Set((cur ?? []).map((t) => t.id))
        return [...(cur ?? []), ...items.filter((t) => !have.has(t.id))]
      })
    } else {
      setTickets(items)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const commitTickets = useCallback((next: SetStateAction<Ticket[] | null>) => {
    epoch.current += 1
    setTickets(next)
  }, [])

  const commitBoard = useCallback((next: SetStateAction<BoardSnapshot | null>) => {
    epoch.current += 1
    setBoard(next)
  }, [])

  const markPending = useCallback((id: string, on: boolean) => {
    setPending((cur) =>
      on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id),
    )
  }, [])

  const patchTicket = useCallback(
    (id: string, patch: Partial<Ticket>) => {
      commitTickets((cur) => cur?.map((t) => (t.id === id ? { ...t, ...patch } : t)) ?? cur)
      setBacklogTickets((cur) => cur.map((t) => (t.id === id ? { ...t, ...patch } : t)))
      commitBoard((cur) => {
        if (!cur) return cur
        const mapCol = (tickets: Ticket[]) =>
          tickets.map((t) => (t.id === id ? { ...t, ...patch } : t))
        return {
          ...cur,
          columns: cur.columns.map((c) => ({ ...c, tickets: mapCol(c.tickets) })),
          inbox: mapCol(cur.inbox),
          backlog: { tickets: mapCol(cur.backlog?.tickets ?? []) },
        }
      })
    },
    [commitBoard, commitTickets],
  )

  const replaceTicket = useCallback(
    (fresh: Ticket) => {
      commitTickets((cur) => {
        if (!cur) return [fresh]
        if (cur.some((t) => t.id === fresh.id)) {
          return cur.map((t) => (t.id === fresh.id ? fresh : t))
        }
        return [fresh, ...cur]
      })
      setBacklogTickets((cur) => {
        const without = cur.filter((t) => t.id !== fresh.id)
        return fresh.status === 'backlog' ? [fresh, ...without] : without
      })
      commitBoard((cur) => {
        if (!cur) return cur
        const swap = (list: Ticket[]) => list.map((t) => (t.id === fresh.id ? fresh : t))
        const without = (list: Ticket[]) => list.filter((t) => t.id !== fresh.id)
        const has = (list: Ticket[]) => list.some((t) => t.id === fresh.id)
        const backlogList = cur.backlog?.tickets ?? []
        return {
          ...cur,
          columns: cur.columns.map((c) => ({
            ...c,
            tickets:
              fresh.status !== 'backlog' && c.stage.id === fresh.stageId
                ? has(swap(c.tickets))
                  ? swap(c.tickets)
                  : [...without(c.tickets), fresh]
                : without(c.tickets),
          })),
          inbox:
            fresh.status === 'waiting_human'
              ? has(swap(cur.inbox))
                ? swap(cur.inbox)
                : [...without(cur.inbox), fresh]
              : without(cur.inbox),
          backlog: {
            tickets:
              fresh.status === 'backlog'
                ? has(swap(backlogList))
                  ? swap(backlogList)
                  : [fresh, ...without(backlogList)]
                : without(backlogList),
          },
        }
      })
    },
    [commitBoard, commitTickets],
  )

  const boardQueryType = useCallback((): TicketType | undefined => {
    return explicitType.current ? ticketTypeRef.current || undefined : undefined
  }, [])

  const applyBoardSnap = useCallback((snap: BoardSnapshot) => {
    const columns = Array.isArray(snap.columns)
      ? snap.columns
          .filter((col): col is NonNullable<typeof col> => !!col && !!col.stage)
          .map((col) => ({
            ...col,
            tickets: Array.isArray(col.tickets) ? col.tickets : [],
          }))
      : []
    setBoard({
      ...snap,
      columns,
      inbox: Array.isArray(snap.inbox) ? snap.inbox : [],
      backlog: { tickets: Array.isArray(snap.backlog?.tickets) ? snap.backlog.tickets : [] },
    })
    if (!explicitType.current && snap.ticketType) {
      setTicketType(snap.ticketType)
      ticketTypeRef.current = snap.ticketType
    }
  }, [])

  const fetchBacklog = useCallback(
    async (
      a: NonNullable<AuthSession>,
      pid: string,
      window?: { offset?: number; limit?: number },
    ) => {
      return taskboardApi.listTickets(a, {
        projectId: pid,
        status: 'backlog',
        limit: window?.limit ?? LIST_PAGE_SIZE,
        offset: window?.offset ?? 0,
      })
    },
    [],
  )

  // HTTP and the database both cap pages at 200. Refresh the loaded window with
  // bounded real pages, not an oversized limit that an API fake might accept.
  const fetchTicketWindow = useCallback(async (
    a: NonNullable<AuthSession>, query: TicketListQuery, loadedCount: number,
  ) => {
    const wanted = Math.max(LIST_PAGE_SIZE, loadedCount)
    const items: Ticket[] = []
    const seen = new Set<string>()
    let offset = 0
    let total = 0
    do {
      const page = await taskboardApi.listTickets(a, {
        ...query, offset, limit: Math.min(LIST_PAGE_SIZE, wanted - offset),
      })
      total = page.total
      for (const item of page.items) {
        if (!seen.has(item.id)) { seen.add(item.id); items.push(item) }
      }
      offset += page.items.length
      if (page.items.length === 0) break
    } while (offset < wanted && offset < total)
    return { items, total }
  }, [])

  const reconcile = useCallback(async () => {
    const a = authRef.current
    if (!a) return
    const ticket = (epoch.current += 1)
    const scope = lockedProjectIdRef.current || projectIdRef.current
    const query = scopedQuery({ offset: 0 })
    try {
      const [freshProjects, freshList, freshAgents] = await Promise.all([
        taskboardApi.listProjects(a),
        fetchTicketWindow(a, query, ticketsRef.current?.length ?? 0),
        taskboardApi.listAgents(a).catch(() => [] as BoardAgent[]),
      ])
      if (!mounted.current || epoch.current !== ticket) return
      if ((lockedProjectIdRef.current || projectIdRef.current) !== scope) return
      setProjects(freshProjects)
      applyListPage(freshList.items, freshList.total, false)
      setAgents(freshAgents)
      if (freshProjects.length && !projectIdRef.current) {
        setProjectId(freshProjects[0].id)
      }
      const pid = lockedProjectIdRef.current || projectIdRef.current || freshProjects[0]?.id
      if (pid) {
        const [snap, backlog] = await Promise.all([
          taskboardApi.getProjectBoard(a, pid, boardQueryType()),
          fetchTicketWindow(a, { projectId: pid, status: 'backlog' }, backlogRef.current.length),
        ])
        if (mounted.current && epoch.current === ticket && (lockedProjectIdRef.current || projectIdRef.current) === scope) {
          applyBoardSnap(snap)
          setBacklogTickets(backlog.items)
          setBacklogTotal(backlog.total)
        }
      }
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      /* 后台对账失败静默，保留乐观值 */
    }
  }, [applyBoardSnap, applyListPage, boardQueryType, fetchTicketWindow, scopedQuery])

  const loadInitial = useCallback(async () => {
    const a = authRef.current
    if (!a) return
    const initialEpoch = (epoch.current += 1)
    const initialGeneration = (initialLoadGeneration.current += 1)
    const initialOwner = lockedProjectIdRef.current
    const ownsLoading = () => mounted.current && initialLoadGeneration.current === initialGeneration &&
      lockedProjectIdRef.current === initialOwner && authRef.current === a
    const isCurrent = () => ownsLoading() && epoch.current === initialEpoch
    setLoading(true)
    setError(null)
    try {
      const [freshProjects, freshAgents] = await Promise.all([
        taskboardApi.listProjects(a),
        taskboardApi.listAgents(a).catch(() => [] as BoardAgent[]),
      ])
      if (!isCurrent()) return
      setProjects(freshProjects)
      setAgents(freshAgents)
      const first = initialOwner
        ? freshProjects.find((p) => p.id === initialOwner) ?? null
        : null
      if (!first) {
        setTickets([])
        setListTotal(0)
        setBacklogTickets([])
        setBacklogTotal(0)
        setProjectId(null)
        setBoard(null)
        return
      }
      setProjectId(first.id)
      projectIdRef.current = first.id
      writeLastProjectId(first.id)
      try {
        const queryType = boardQueryType()
        const scope = first.id
        const [snap, backlog, freshList] = await Promise.all([
          taskboardApi.getProjectBoard(a, first.id, queryType),
          fetchBacklog(a, first.id).catch(() => ({ items: [] as Ticket[], total: 0 })),
          taskboardApi.listTickets(a, scopedQuery({ projectId: first.id, offset: 0 })),
        ])
        if (isCurrent() && (lockedProjectIdRef.current || projectIdRef.current) === scope) {
          applyListPage(freshList.items, freshList.total, false)
          applyBoardSnap(snap)
          setBacklogTickets(backlog.items)
          setBacklogTotal(backlog.total)
        }
      } catch (e) {
        if (!(e instanceof AuthEpochStaleError) && isCurrent()) {
          setBoard(null)
          setTickets([])
        }
      }
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      if (isCurrent()) setError(taskboardErrorMessage(e, '加载任务面板失败'))
    } finally {
      if (ownsLoading()) setLoading(false)
    }
  }, [applyBoardSnap, applyListPage, boardQueryType, fetchBacklog, lockedProjectId, scopedQuery])

  useEffect(() => {
    if (!enabled || !auth) {
      epoch.current += 1
      setTickets(null)
      setListTotal(0)
      setProjects(null)
      setBoard(null)
      setBacklogTickets([])
      setBacklogTotal(0)
      setProjectId(null)
      projectIdRef.current = null
      setLoading(false)
      setError(null)
      return
    }
    void loadInitial()
    const tick = () => {
      if (document.visibilityState === 'visible') void reconcile()
    }
    const timer = window.setInterval(tick, POLL_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible') void reconcile()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      epoch.current += 1
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [enabled, auth, loadInitial, reconcile])

  const selectProject = useCallback(
    async (id: string, type?: TicketType | '') => {
      setProjectId(id)
      projectIdRef.current = id
      if (!id) return
      writeLastProjectId(id)
      if (type !== undefined) {
        setTicketType(type)
        ticketTypeRef.current = type
        explicitType.current = !!type
      }
      const a = authRef.current
      if (!a) return
      const gate = (epoch.current += 1)
      const scope = id
      try {
        const queryType = type !== undefined ? type || undefined : boardQueryType()
        const [snap, backlog, freshList] = await Promise.all([
          taskboardApi.getProjectBoard(a, id, queryType),
          fetchBacklog(a, id).catch(() => ({ items: [] as Ticket[], total: 0 })),
          taskboardApi.listTickets(a, scopedQuery({ projectId: id, offset: 0 })),
        ])
        if (
          mounted.current &&
          epoch.current === gate &&
          projectIdRef.current === scope &&
          (lockedProjectIdRef.current == null || lockedProjectIdRef.current === scope)
        ) {
          applyBoardSnap(snap)
          setBacklogTickets(backlog.items)
          setBacklogTotal(backlog.total)
          applyListPage(freshList.items, freshList.total, false)
        }
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return
        toast(taskboardErrorMessage(e, '加载看板失败'), 'error')
      }
    },
    [applyBoardSnap, applyListPage, boardQueryType, fetchBacklog, scopedQuery, toast],
  )

  const selectTicketType = useCallback(
    async (type: TicketType) => {
      explicitType.current = true
      setTicketType(type)
      ticketTypeRef.current = type
      const a = authRef.current
      const pid = projectIdRef.current
      if (!a || !pid) return
      const gate = (epoch.current += 1)
      try {
        const snap = await taskboardApi.getProjectBoard(a, pid, type)
        if (mounted.current && epoch.current === gate) applyBoardSnap(snap)
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return
        toast(taskboardErrorMessage(e, '加载看板失败'), 'error')
      }
    },
    [applyBoardSnap, toast],
  )

  const applyListQuery = useCallback(
    async (next: TicketListQuery) => {
      const stored: TicketListQuery = lockedProjectIdRef.current
        ? { ...next, projectId: undefined }
        : next
      setListQuery(stored)
      listQueryRef.current = stored
      const a = authRef.current
      if (!a) return
      const gate = (epoch.current += 1)
      const scope = lockedProjectIdRef.current || projectIdRef.current
      try {
        const fresh = await taskboardApi.listTickets(a, scopedQuery({ ...stored, offset: 0 }))
        if (!mounted.current || epoch.current !== gate) return
        if ((lockedProjectIdRef.current || projectIdRef.current) !== scope) return
        applyListPage(fresh.items, fresh.total, false)
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return
        toast(taskboardErrorMessage(e, '筛选单据失败'), 'error')
      }
    },
    [applyListPage, scopedQuery, toast],
  )

  const loadMoreTickets = useCallback(async () => {
    const a = authRef.current
    if (!a || loadMoreInFlight.current) return
    const scope = lockedProjectIdRef.current || projectIdRef.current
    const offset = ticketsRef.current?.length ?? 0
    if (offset === 0) return
    loadMoreInFlight.current = true
    setListLoadingMore(true)
    const gate = (epoch.current += 1)
    try {
      const fresh = await taskboardApi.listTickets(a, scopedQuery({ offset }))
      if (!mounted.current || epoch.current !== gate) return
      if ((lockedProjectIdRef.current || projectIdRef.current) !== scope) return
      applyListPage(fresh.items, fresh.total, true)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      toast(taskboardErrorMessage(e, '加载更多单据失败'), 'error')
    } finally {
      loadMoreInFlight.current = false
      if (mounted.current) setListLoadingMore(false)
    }
  }, [applyListPage, scopedQuery, toast])

  const loadMoreBacklog = useCallback(async () => {
    const a = authRef.current
    const pid = lockedProjectIdRef.current || projectIdRef.current
    if (!a || !pid || backlogMoreInFlight.current) return
    const offset = backlogRef.current.length
    if (offset === 0) return
    backlogMoreInFlight.current = true
    setBacklogLoadingMore(true)
    const scope = pid
    const gate = (epoch.current += 1)
    try {
      const page = await fetchBacklog(a, pid, { offset, limit: LIST_PAGE_SIZE })
      if (!mounted.current || epoch.current !== gate) return
      if ((lockedProjectIdRef.current || projectIdRef.current) !== scope) return
      setBacklogTotal(page.total)
      setBacklogTickets((cur) => {
        const have = new Set(cur.map((t) => t.id))
        return [...cur, ...page.items.filter((t) => !have.has(t.id))]
      })
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      toast(taskboardErrorMessage(e, '加载更多积压失败'), 'error')
    } finally {
      backlogMoreInFlight.current = false
      if (mounted.current) setBacklogLoadingMore(false)
    }
  }, [fetchBacklog, toast])

  const upsertProject = useCallback((fresh: Project) => {
    setProjects((cur) => {
      const list = cur ?? []
      const idx = list.findIndex((p) => p.id === fresh.id)
      if (idx < 0) return [...list, fresh]
      const next = list.slice()
      next[idx] = fresh
      return next
    })
  }, [])

  const createProject = useCallback(
    async (input: ProjectCreateInput) => {
      const a = authRef.current
      if (!a) return null
      try {
        const out = await taskboardApi.createProject(a, input)
        upsertProject(out.project)
        toast(`已创建项目 ${out.project.key}`, 'success')
        await selectProject(out.project.id)
        void reconcile()
        return out.project
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return null
        toast(taskboardErrorMessage(e, '创建项目失败'), 'error')
        return null
      }
    },
    [reconcile, selectProject, toast, upsertProject],
  )

  const patchProject = useCallback(
    async (id: string, input: ProjectPatchInput) => {
      const a = authRef.current
      if (!a) return null
      try {
        const out = await taskboardApi.patchProject(a, id, input)
        upsertProject(out.project)
        toast('已更新项目', 'success')
        void reconcile()
        return out.project
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return null
        toast(taskboardErrorMessage(e, '更新项目失败'), 'error')
        return null
      }
    },
    [reconcile, toast, upsertProject],
  )

  const archiveProject = useCallback(
    async (id: string) => {
      const a = authRef.current
      if (!a) return false
      try {
        const out = await taskboardApi.archiveProject(a, id)
        const remaining = await taskboardApi.listProjects(a)
        if (!mounted.current) return true
        setProjects(remaining)
        if (projectIdRef.current === id) {
          if (remaining[0]) {
            await selectProject(remaining[0].id)
          } else {
            setProjectId(null)
            setBoard(null)
          }
        }
        toast(`已归档 ${out.project.key}`, 'success')
        void reconcile()
        return true
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return false
        toast(taskboardErrorMessage(e, '归档项目失败'), 'error')
        return false
      }
    },
    [reconcile, selectProject, toast],
  )

  const unarchiveProject = useCallback(
    async (id: string) => {
      const a = authRef.current
      if (!a) return null
      try {
        const out = await taskboardApi.patchProject(a, id, { archivedAt: null })
        upsertProject(out.project)
        toast(`已取消归档 ${out.project.key}`, 'success')
        void reconcile()
        return out.project
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return null
        toast(taskboardErrorMessage(e, '取消归档失败'), 'error')
        return null
      }
    },
    [reconcile, toast, upsertProject],
  )

  const createTicket = useCallback(
    async (input: TicketCreateInput) => {
      const a = authRef.current
      if (!a || createInFlight.current) return null
      createInFlight.current = true
      setCreateBusy(true)
      try {
        const out = await taskboardApi.createTicket(a, input)
        commitTickets((cur) => (cur ? [out.ticket, ...cur] : [out.ticket]))
        if (out.ticket.status === 'backlog') {
          setBacklogTickets((cur) => [out.ticket, ...cur.filter((t) => t.id !== out.ticket.id)])
        }
        toast(`已创建 ${out.ticket.identifier}`, 'success')
        void reconcile()
        return out.ticket
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return null
        toast(taskboardErrorMessage(e, '创建单据失败'), 'error')
        return null
      } finally {
        createInFlight.current = false
        if (mounted.current) setCreateBusy(false)
      }
    },
    [commitTickets, reconcile, toast],
  )

  const runAction = useCallback(
    async (ticket: Ticket, action: TicketAction) => {
      const a = authRef.current
      if (!a) return false
      const nextStatus = optimisticStatus(action)
      markPending(ticket.id, true)
      if (nextStatus) {
        patchTicket(ticket.id, {
          status: nextStatus,
          blockedReason: action.kind === 'block' ? action.reason : ticket.blockedReason,
        })
      }
      try {
        let out: { ticket: Ticket }
        switch (action.kind) {
          case 'ready':
            out = await taskboardApi.ready(a, ticket.id, ticket.version)
            break
          case 'approve':
            out = await taskboardApi.approve(a, ticket.id, ticket.version, action.close)
            break
          case 'reject':
            out = await taskboardApi.reject(
              a,
              ticket.id,
              ticket.version,
              action.reason,
              action.targetStageId,
            )
            break
          case 'block':
            out = await taskboardApi.block(a, ticket.id, ticket.version, action.reason)
            break
          case 'done':
            out = await taskboardApi.done(a, ticket.id, ticket.version)
            break
          case 'cancel':
            out = await taskboardApi.cancel(a, ticket.id, ticket.version, action.reason)
            break
        }
        replaceTicket(out.ticket)
        toast('已更新单据', 'success')
        void reconcile()
        return true
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return false
        if (isVersionConflict(e)) {
          toast(taskboardErrorMessage(e, '单据已被更新，已刷新'), 'error')
          void reconcile()
          return false
        }
        patchTicket(ticket.id, {
          status: ticket.status,
          blockedReason: ticket.blockedReason,
          version: ticket.version,
        })
        toast(taskboardErrorMessage(e, '更新单据失败'), 'error')
        return false
      } finally {
        if (mounted.current) markPending(ticket.id, false)
      }
    },
    [markPending, patchTicket, reconcile, replaceTicket, toast],
  )

  const moveTicket = useCallback(
    async (
      ticket: Ticket,
      input: Omit<TicketMoveInput, 'expectedVersion'>,
    ): Promise<
      | { ok: true; result: TicketMoveResult }
      | { ok: false; code: string; error: unknown; detail?: Record<string, unknown> }
    > => {
      const a = authRef.current
      if (!a) return { ok: false, code: 'unavailable', error: new Error('unauthenticated') }
      markPending(ticket.id, true)
      try {
        const out = await taskboardApi.moveTicket(a, ticket.id, {
          ...input,
          expectedVersion: ticket.version,
        })
        replaceTicket(out.ticket)
        void reconcile()
        return { ok: true, result: out }
      } catch (e) {
        if (e instanceof AuthEpochStaleError) {
          return { ok: false, code: 'stale', error: e }
        }
        const code = boardErrorCode(e) ?? 'unknown'
        if (code === 'version_conflict') {
          void reconcile()
          return { ok: false, code: 'version_conflict', error: e, detail: boardErrorDetail(e) }
        }
        return { ok: false, code, error: e, detail: boardErrorDetail(e) }
      } finally {
        if (mounted.current) markPending(ticket.id, false)
      }
    },
    [markPending, reconcile, replaceTicket],
  )

  useEffect(() => {
    if (!enabled || !ticketTypeFromUrl) return
    if (explicitType.current && ticketTypeRef.current === ticketTypeFromUrl) return
    void selectTicketType(ticketTypeFromUrl)
  }, [enabled, selectTicketType, ticketTypeFromUrl])

  const inboxTickets = (tickets ?? []).filter((t) => t.status === 'waiting_human')

  return {
    projects,
    tickets,
    board,
    agents,
    projectId,
    ticketType,
    listQuery,
    listTotal,
    listLoadingMore,
    backlogTotal,
    backlogLoadingMore,
    createBusy,
    loading,
    error,
    pending,
    inboxTickets,
    backlogTickets,
    selectProject,
    selectTicketType,
    setTicketType,
    applyListQuery,
    loadMoreTickets,
    loadMoreBacklog,
    createProject,
    patchProject,
    archiveProject,
    unarchiveProject,
    createTicket,
    runAction,
    moveTicket,
    replaceTicket,
    reconcile,
    refresh: loadInitial,
    isPending: (id: string) => pending.includes(id),
  }
}
