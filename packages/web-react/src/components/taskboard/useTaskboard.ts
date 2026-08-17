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
  type TicketType,
  isVersionConflict,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import { useToast } from '../ui'

const POLL_MS = 60_000

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

export function useTaskboard(auth: AuthSession | null, enabled: boolean) {
  const toast = useToast()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [board, setBoard] = useState<BoardSnapshot | null>(null)
  const [agents, setAgents] = useState<BoardAgent[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [ticketType, setTicketType] = useState<TicketType | ''>('')
  const [listQuery, setListQuery] = useState<TicketListQuery>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string[]>([])

  const authRef = useRef(auth)
  authRef.current = auth
  const listQueryRef = useRef(listQuery)
  listQueryRef.current = listQuery
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const ticketTypeRef = useRef(ticketType)
  ticketTypeRef.current = ticketType
  const mounted = useRef(true)
  const epoch = useRef(0)

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
      commitBoard((cur) => {
        if (!cur) return cur
        const mapCol = (tickets: Ticket[]) =>
          tickets.map((t) => (t.id === id ? { ...t, ...patch } : t))
        return {
          ...cur,
          columns: cur.columns.map((c) => ({ ...c, tickets: mapCol(c.tickets) })),
          inbox: mapCol(cur.inbox),
        }
      })
    },
    [commitBoard, commitTickets],
  )

  const replaceTicket = useCallback(
    (fresh: Ticket) => {
      commitTickets((cur) => cur?.map((t) => (t.id === fresh.id ? fresh : t)) ?? cur)
      commitBoard((cur) => {
        if (!cur) return cur
        const swap = (list: Ticket[]) => list.map((t) => (t.id === fresh.id ? fresh : t))
        return {
          ...cur,
          columns: cur.columns.map((c) => ({
            ...c,
            tickets:
              c.stage.id === fresh.stageId
                ? swap(c.tickets).some((t) => t.id === fresh.id)
                  ? swap(c.tickets)
                  : [...c.tickets.filter((t) => t.id !== fresh.id), fresh]
                : c.tickets.filter((t) => t.id !== fresh.id),
          })),
          inbox:
            fresh.status === 'waiting_human'
              ? swap(cur.inbox).some((t) => t.id === fresh.id)
                ? swap(cur.inbox)
                : [...cur.inbox.filter((t) => t.id !== fresh.id), fresh]
              : cur.inbox.filter((t) => t.id !== fresh.id),
        }
      })
    },
    [commitBoard, commitTickets],
  )

  const reconcile = useCallback(async () => {
    const a = authRef.current
    if (!a) return
    const ticket = (epoch.current += 1)
    try {
      const [freshProjects, freshList, freshAgents] = await Promise.all([
        taskboardApi.listProjects(a),
        taskboardApi.listTickets(a, { ...listQueryRef.current, limit: 200 }),
        taskboardApi.listAgents(a).catch(() => [] as BoardAgent[]),
      ])
      if (!mounted.current || epoch.current !== ticket) return
      setProjects(freshProjects)
      setTickets(freshList.items)
      setAgents(freshAgents)
      if (freshProjects.length && !projectIdRef.current) {
        setProjectId(freshProjects[0].id)
      }
      const pid = projectIdRef.current || freshProjects[0]?.id
      if (pid) {
        const snap = await taskboardApi.getProjectBoard(a, pid, ticketTypeRef.current || undefined)
        if (mounted.current && epoch.current === ticket) setBoard(snap)
      }
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      /* 后台对账失败静默，保留乐观值 */
    }
  }, [])

  const loadInitial = useCallback(async () => {
    const a = authRef.current
    if (!a) return
    setLoading(true)
    setError(null)
    try {
      const [freshProjects, freshList, freshAgents] = await Promise.all([
        taskboardApi.listProjects(a),
        taskboardApi.listTickets(a, { limit: 200 }),
        taskboardApi.listAgents(a).catch(() => [] as BoardAgent[]),
      ])
      if (!mounted.current) return
      epoch.current += 1
      setProjects(freshProjects)
      setTickets(freshList.items)
      setAgents(freshAgents)
      const first = freshProjects[0]
      if (first) {
        setProjectId(first.id)
        try {
          const snap = await taskboardApi.getProjectBoard(a, first.id)
          if (mounted.current) setBoard(snap)
        } catch (e) {
          if (!(e instanceof AuthEpochStaleError) && mounted.current) {
            setBoard(null)
          }
        }
      }
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      if (mounted.current) setError(taskboardErrorMessage(e, '加载任务面板失败'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled || !auth) {
      epoch.current += 1
      setTickets(null)
      setProjects(null)
      setBoard(null)
      setLoading(false)
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
      if (type !== undefined) {
        setTicketType(type)
        ticketTypeRef.current = type
      }
      const a = authRef.current
      if (!a) return
      const gate = (epoch.current += 1)
      try {
        const snap = await taskboardApi.getProjectBoard(a, id, type || undefined)
        if (mounted.current && epoch.current === gate) setBoard(snap)
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return
        toast(taskboardErrorMessage(e, '加载看板失败'), 'error')
      }
    },
    [toast],
  )

  const applyListQuery = useCallback(
    async (next: TicketListQuery) => {
      setListQuery(next)
      const a = authRef.current
      if (!a) return
      const gate = (epoch.current += 1)
      try {
        const fresh = await taskboardApi.listTickets(a, { ...next, limit: 200 })
        if (mounted.current && epoch.current === gate) setTickets(fresh.items)
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return
        toast(taskboardErrorMessage(e, '筛选单据失败'), 'error')
      }
    },
    [toast],
  )

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
      if (!a) return null
      try {
        const out = await taskboardApi.createTicket(a, input)
        commitTickets((cur) => (cur ? [out.ticket, ...cur] : [out.ticket]))
        toast(`已创建 ${out.ticket.identifier}`, 'success')
        void reconcile()
        return out.ticket
      } catch (e) {
        if (e instanceof AuthEpochStaleError) return null
        toast(taskboardErrorMessage(e, '创建单据失败'), 'error')
        return null
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

  const inboxTickets = (tickets ?? []).filter((t) => t.status === 'waiting_human')

  return {
    projects,
    tickets,
    board,
    agents,
    projectId,
    ticketType,
    listQuery,
    loading,
    error,
    pending,
    inboxTickets,
    selectProject,
    setTicketType,
    applyListQuery,
    createProject,
    patchProject,
    archiveProject,
    unarchiveProject,
    createTicket,
    runAction,
    replaceTicket,
    reconcile,
    refresh: loadInitial,
    isPending: (id: string) => pending.includes(id),
  }
}
