/**
 * Taskboard HTTP: board agents and settings, cost stats and weekly report, pipeline templates.
 *
 * Moved verbatim out of http.ts — FINDINGS §8 (cc2), OCV5-478. http.ts
 * imports these back and re-exports its former exports, so its import surface is unchanged.
 */
import type { ServerResponse } from 'node:http'
import { filterUserVisibleAgentsForManagement } from '../agentVisibility.js'
import { COST_GROUP_BY, queryCostStats, ymdRangeMs } from './db/costStats.js'
import { type TaskboardDb, TaskboardNotFound, TaskboardValidationError } from './db/index.js'
import {
  type TaskboardSettings,
  getSettings,
  getUsageWithReferenceCosts,
  updateSettings,
} from './db/settings.js'
import {
  applyTemplate,
  createTemplateFromPipeline,
  deleteTemplate,
  getTemplate,
  listTemplates,
} from './db/templates.js'
import { getTicketByIdOrIdentifier } from './db/tickets.js'
import { buildWeeklyReport, currentWeekPeriod, periodFromIsoWeek } from './db/weeklyReport.js'
import type { Actor } from './domain.js'
import { zonedYmd } from './notify.js'
import {
  type BoardAgent,
  type TaskboardHttpContext,
  sendJson,
  sendError,
  asString,
  asNullableString,
  asBoolean,
  resolveProject,
} from './httpShared.js'
import { assertTemplatesValidForApply } from './httpPipelines.js'

// ── Agents / Settings ───────────────────────────────────────────────────────

export async function handleListAgents(
  res: ServerResponse,
  ctx: TaskboardHttpContext,
): Promise<void> {
  let items: BoardAgent[]
  if (ctx.listAgents) {
    items = await ctx.listAgents()
  } else {
    const { readAgentsConfig } = await import('@openclaude/storage')
    const cfg = await readAgentsConfig()
    items = filterUserVisibleAgentsForManagement(cfg.agents).map((a) => ({
      id: a.id,
      name: a.displayName ?? a.id,
      model: a.model ?? '',
      description: a.greeting ?? '',
    }))
  }
  items = filterUserVisibleAgentsForManagement(items)
  sendJson(res, 200, { items })
}

export function handleGetSettings(res: ServerResponse, db: TaskboardDb): void {
  sendJson(res, 200, { ...getSettings(db), usage: getUsageWithReferenceCosts(db) })
}

export function handlePatchSettings(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
): void {
  if (actor !== 'human') {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return
  }
  const patch: Partial<TaskboardSettings> = {}
  if (typeof body.maxConcurrentRuns === 'number') patch.maxConcurrentRuns = body.maxConcurrentRuns
  if (typeof body.maxRunsPerDay === 'number') patch.maxRunsPerDay = body.maxRunsPerDay
  if (body.maxCostPerDayUsd === null || typeof body.maxCostPerDayUsd === 'number') {
    patch.maxCostPerDayUsd = body.maxCostPerDayUsd
  }
  if (typeof body.quietHoursStart === 'number') patch.quietHoursStart = body.quietHoursStart
  if (typeof body.quietHoursEnd === 'number') patch.quietHoursEnd = body.quietHoursEnd
  if (typeof body.circuitBreakerThreshold === 'number') {
    patch.circuitBreakerThreshold = body.circuitBreakerThreshold
  }
  if (typeof body.maxStageLoops === 'number') patch.maxStageLoops = body.maxStageLoops
  if (typeof body.maxRunsPerTick === 'number') patch.maxRunsPerTick = body.maxRunsPerTick
  if (typeof body.patrolPaused === 'boolean') patch.patrolPaused = body.patrolPaused
  const settings = updateSettings(db, patch)
  sendJson(res, 200, { ok: true, ...settings, usage: getUsageWithReferenceCosts(db) })
}

// ── M4:成本统计 / 周报 / 流水线模板 ─────────────────────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

function requireYmd(raw: string | null, field: string): string | undefined {
  if (raw == null || raw === '') return undefined
  if (!YMD_RE.test(raw)) throw new TaskboardValidationError(`invalid ${field}: ${raw}`)
  return raw
}

function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const utc = Date.UTC(y, m - 1, d) + delta * 86_400_000
  const dt = new Date(utc)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function handleCostStats(res: ServerResponse, url: URL, db: TaskboardDb): void {
  const timeZone = asString(url.searchParams.get('timeZone') ?? undefined) ?? 'Asia/Shanghai'
  const today = zonedYmd(new Date(), timeZone)
  const fromYmd = requireYmd(url.searchParams.get('from'), 'from') ?? addDaysYmd(today, -6)
  const toYmd = requireYmd(url.searchParams.get('to'), 'to') ?? today
  if (fromYmd > toYmd) throw new TaskboardValidationError('from must be <= to')
  const groupRaw = url.searchParams.get('groupBy')
  const groupBy =
    groupRaw == null || groupRaw === ''
      ? undefined
      : (COST_GROUP_BY as readonly string[]).includes(groupRaw)
        ? (groupRaw as (typeof COST_GROUP_BY)[number])
        : (() => {
            throw new TaskboardValidationError(`invalid groupBy: ${groupRaw}`)
          })()
  const projectRef = url.searchParams.get('projectId')
  const project = projectRef ? resolveProject(db, projectRef) : null
  if (projectRef && !project) throw new TaskboardNotFound('project', projectRef)
  const ticketRef = url.searchParams.get('ticketId')
  const ticket = ticketRef ? getTicketByIdOrIdentifier(db, ticketRef) : null
  if (ticketRef && !ticket) throw new TaskboardNotFound('ticket', ticketRef)
  const stageId = url.searchParams.get('stageId') || undefined
  const { fromMs, toMs } = ymdRangeMs(fromYmd, toYmd, timeZone)
  const stats = queryCostStats(db, {
    fromMs,
    toMs,
    projectId: project?.id,
    ticketId: ticket?.id,
    stageId,
    groupBy,
    timeZone,
  })
  sendJson(res, 200, {
    from: fromYmd,
    to: toYmd,
    timeZone,
    groupBy: groupBy ?? null,
    totals: stats.totals,
    buckets: stats.buckets,
  })
}

export function handleWeeklyReport(res: ServerResponse, url: URL, db: TaskboardDb): void {
  const timeZone = asString(url.searchParams.get('timeZone') ?? undefined) ?? 'Asia/Shanghai'
  const weekRaw = url.searchParams.get('week')
  const fromRaw = requireYmd(url.searchParams.get('from'), 'from')
  const toRaw = requireYmd(url.searchParams.get('to'), 'to')
  let period = currentWeekPeriod(new Date(), timeZone)
  if (weekRaw) {
    const parsed = periodFromIsoWeek(weekRaw, timeZone)
    if (!parsed) throw new TaskboardValidationError(`invalid week: ${weekRaw}`)
    period = parsed
  } else if (fromRaw && toRaw) {
    if (fromRaw > toRaw) throw new TaskboardValidationError('from must be <= to')
    const range = ymdRangeMs(fromRaw, toRaw, timeZone)
    period = {
      week: `${fromRaw}/${toRaw}`,
      fromYmd: fromRaw,
      toYmd: toRaw,
      fromMs: range.fromMs,
      toMs: range.toMs,
      timeZone,
    }
  }
  const projectRef = url.searchParams.get('projectId')
  const project = projectRef ? resolveProject(db, projectRef) : null
  if (projectRef && !project) throw new TaskboardNotFound('project', projectRef)
  const report = buildWeeklyReport(db, {
    fromMs: period.fromMs,
    toMs: period.toMs,
    fromYmd: period.fromYmd,
    toYmd: period.toYmd,
    week: period.week,
    projectId: project?.id,
    timeZone,
  })
  sendJson(res, 200, { report })
}

export function handleListTemplates(res: ServerResponse, db: TaskboardDb): void {
  sendJson(res, 200, { items: listTemplates(db) })
}

export function handleGetTemplate(res: ServerResponse, db: TaskboardDb, id: string): void {
  const template = getTemplate(db, id)
  if (!template) throw new TaskboardNotFound('template', id)
  sendJson(res, 200, { template })
}

export function handleCreateTemplate(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
): void {
  const pipelineId = asString(body.pipelineId)
  if (!pipelineId) throw new TaskboardValidationError('pipelineId is required')
  const template = createTemplateFromPipeline(db, {
    pipelineId,
    name: asString(body.name),
    slug: asString(body.slug),
  })
  sendJson(res, 201, { ok: true, template })
}

export function handleDeleteTemplate(res: ServerResponse, db: TaskboardDb, id: string): void {
  deleteTemplate(db, id)
  sendJson(res, 200, { ok: true })
}

export async function handleApplyTemplate(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  templateId: string,
  actor: Actor,
  ctx: TaskboardHttpContext,
): Promise<void> {
  if (actor !== 'human') {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return
  }
  const executionAgentId = asNullableString(body.executionAgentId)?.trim() || null
  const validated = await assertTemplatesValidForApply(db, [templateId], ctx, { executionAgentId })
  const projectRef = asString(body.projectId)
  if (!projectRef) throw new TaskboardValidationError('projectId is required')
  const project = resolveProject(db, projectRef)
  if (!project) throw new TaskboardNotFound('project', projectRef)
  const asDefault = asBoolean(body.asDefault)
  const result = db.transaction(() => {
    validated.assertUnchanged()
    return applyTemplate(db, validated.templateIds[0]!, project.id, { asDefault, executionAgentId })
  })()
  sendJson(res, 200, {
    ok: true,
    template: result.template,
    pipeline: result.pipeline,
    createdPipelines: result.createdPipelines,
    createdStages: result.createdStages,
    skippedPipelines: result.skippedPipelines,
    skippedStages: result.skippedStages,
  })
}
