/**
 * Taskboard HTTP shared helpers: request context type, JSON/error responses, body field coercion, unique-constraint detection, project resolution.
 *
 * Moved verbatim out of http.ts — FINDINGS §8 (cc2), OCV5-478. http.ts
 * imports these back and re-exports its former exports, so its import surface is unchanged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { taskboardRunControls } from './runControl.js'
import { type TaskboardDb, TaskboardValidationError } from './db/index.js'
import { getProject, getProjectByKey } from './db/projects.js'
import type { TaskboardPreflight } from './stagePreflight.js'
import type { Actor, TicketRun } from './domain.js'

/** 单次 run 允许配置的最大无活动窗口；活跃 run 没有 45 分钟墙钟上限。 */
export const DELEGATE_IDLE_TIMEOUT_MAX_SEC = 45 * 60

// ── 上下文 / actor ──────────────────────────────────────────────────────────

export interface BoardAgent {
  id: string
  name: string
  model: string
  description: string
}

export interface TaskboardHttpContext {
  preflightStages?: TaskboardPreflight
  /** 显式传入的库。测试用临时目录;生产省略则走 getTaskboardDb()。null = 未初始化。 */
  db?: TaskboardDb | null
  /**
   * 测试注入的 actor。生产不要设 —— 必须由 resolveActor / resolveTaskboardActor
   * 从请求凭证推导,禁止调用方在 body 里自称。
   */
  actor?: Actor
  resolveActor?: (req: IncomingMessage) => Actor
  jwtSecret?: string
  isCommercialJwt?: (token: string) => boolean
  listAgents?: () => Promise<BoardAgent[]>
  /** Only database-resolved runs are accepted; no client supplied session keys. */
  getRunSnapshots?: (
    runs: readonly TicketRun[],
  ) => Promise<Record<string, Pick<TicketRun, 'actualModels' | 'preview' | 'stopRequested'>>>
  /**
   * 阶段 model 覆盖是否在当前 catalog 投影里且 available。
   * 测试注入;生产省略则走 getLocalCatalogView().isRoutable。
   */
  isAvailableStageModel?: (modelId: string) => boolean | Promise<boolean>
}

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function sendError(
  res: ServerResponse,
  code: number,
  error: string,
  extra?: Record<string, unknown>,
): void {
  sendJson(res, code, extra ? { error, ...extra } : { error })
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string') return value
  throw new TaskboardValidationError('expected string or null')
}

export function asNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TaskboardValidationError('expected number or null')
}

export function asBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  throw new TaskboardValidationError('expected boolean')
}

export function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TaskboardValidationError('expected string[]')
  }
  return value
}

export function asNullableStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return asStringArray(value)
}

export function isUniqueConstraint(err: unknown, needle?: string): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (!msg.includes('UNIQUE constraint failed')) return false
  return needle ? msg.includes(needle) : true
}

export function resolveProject(db: TaskboardDb, idOrKey: string) {
  return getProject(db, idOrKey) ?? getProjectByKey(db, idOrKey)
}

/** Enrich only the response window, with one batch lookup and no stored mutation. */
export async function enrichTaskboardRuns(
  ctx: TaskboardHttpContext,
  runs: readonly TicketRun[],
): Promise<TicketRun[]> {
  const activeControl = (run: TicketRun) => {
    const control = taskboardRunControls.getActiveForTicket(run.ticketId)
    return control?.runId === run.id && control.rootSessionKey === run.sessionKey
      ? control
      : undefined
  }
  // Capture all rows before the first asynchronous projection. A control may
  // archive output and finish during that await; old payload must stay pending.
  const pendingAtRead = new Map(
    runs.map((run) => {
      const control = activeControl(run)
      return [run.id, { settling: !!control, stopped: control?.signal.aborted === true }] as const
    }),
  )
  const projected: TicketRun[] = []
  for (let index = 0; index < runs.length; index += 200) {
    const batch = runs.slice(index, index + 200)
    if (!ctx.getRunSnapshots) {
      projected.push(...batch)
      continue
    }
    try {
      const snapshots = await ctx.getRunSnapshots(batch)
      projected.push(...batch.map((run) => ({ ...run, ...snapshots[run.id] })))
    } catch {
      projected.push(...batch.map((run) => ({ ...run, actualModels: [] })))
    }
  }
  return projected.map((run) => {
    const control = activeControl(run)
    const captured = pendingAtRead.get(run.id)
    const settling = captured?.settling === true || !!control
    return {
      ...run,
      settling,
      stopRequested:
        captured?.stopped === true ||
        control?.signal.aborted === true ||
        run.stopRequested === true,
    }
  })
}
