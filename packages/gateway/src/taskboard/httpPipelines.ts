/**
 * Taskboard HTTP: pipelines and stages (create / get / reorder / patch, stage model and template validation) and run lookup.
 *
 * Moved verbatim out of http.ts — FINDINGS §8 (cc2), OCV5-478. http.ts
 * imports these back and re-exports its former exports, so its import surface is unchanged.
 */
import type { ServerResponse } from 'node:http'
import { isHiddenSystemAgentId } from '../agentVisibility.js'
import { getLocalCatalogView } from '../modelCatalogClient.js'
import { type TaskboardDb, TaskboardNotFound, TaskboardValidationError } from './db/index.js'
import {
  createPipeline,
  createStage,
  getPipeline,
  getStage,
  listPipelines,
  listStages,
  reorderStages,
  updatePipeline,
  updateStage,
} from './db/pipelines.js'
import { getRun } from './db/runs.js'
import { getTemplate } from './db/templates.js'
import {
  type Actor,
  type OnFailureAction,
  type OnSuccessAction,
  type PipelineStage,
  STAGE_KINDS,
  type StageKind,
  TICKET_TYPES,
  type TicketType,
} from './domain.js'
import { parseEntryCondition } from './entryCondition.js'
import {
  DELEGATE_IDLE_TIMEOUT_MAX_SEC,
  type TaskboardHttpContext,
  enrichTaskboardRuns,
  sendJson,
  sendError,
  asString,
  asNullableString,
  asNullableNumber,
  asBoolean,
  asNullableStringArray,
  isUniqueConstraint,
  resolveProject,
} from './httpShared.js'

// ── Pipeline / Stage ────────────────────────────────────────────────────────

export function handleListPipelines(res: ServerResponse, url: URL, db: TaskboardDb): void {
  const projectRef = url.searchParams.get('projectId')
  if (!projectRef) throw new TaskboardValidationError('projectId is required')
  const project = resolveProject(db, projectRef)
  if (!project) throw new TaskboardNotFound('project', projectRef)
  sendJson(res, 200, { items: listPipelines(db, project.id) })
}

export function handleCreatePipeline(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
): void {
  const projectRef = asString(body.projectId)
  const name = asString(body.name)
  if (!projectRef || !name) throw new TaskboardValidationError('projectId and name are required')
  const project = resolveProject(db, projectRef)
  if (!project) throw new TaskboardNotFound('project', projectRef)
  const typeRaw = asNullableString(body.ticketType)
  if (typeRaw && !(TICKET_TYPES as readonly string[]).includes(typeRaw)) {
    throw new TaskboardValidationError(`invalid ticketType: ${typeRaw}`)
  }
  const pipeline = createPipeline(db, {
    projectId: project.id,
    name,
    ticketType: (typeRaw as TicketType | null | undefined) ?? null,
    isDefault: asBoolean(body.isDefault) ?? false,
  })
  sendJson(res, 201, { ok: true, pipeline })
}

export function handleGetPipeline(res: ServerResponse, db: TaskboardDb, id: string): void {
  const pipeline = getPipeline(db, id)
  if (!pipeline) throw new TaskboardNotFound('pipeline', id)
  sendJson(res, 200, { pipeline, stages: listStages(db, pipeline.id) })
}

export function handlePatchPipeline(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  id: string,
): void {
  const typeRaw = asNullableString(body.ticketType)
  if (typeRaw && !(TICKET_TYPES as readonly string[]).includes(typeRaw)) {
    throw new TaskboardValidationError(`invalid ticketType: ${typeRaw}`)
  }
  const pipeline = updatePipeline(db, id, {
    name: asString(body.name),
    ticketType: typeRaw as TicketType | null | undefined,
    isDefault: asBoolean(body.isDefault),
  })
  sendJson(res, 200, { ok: true, pipeline })
}

export function handleListStages(res: ServerResponse, db: TaskboardDb, pipelineId: string): void {
  if (!getPipeline(db, pipelineId)) throw new TaskboardNotFound('pipeline', pipelineId)
  sendJson(res, 200, { items: listStages(db, pipelineId) })
}

function hasPatrolCron(cron: string | null | undefined): boolean {
  return typeof cron === 'string' && cron.trim() !== ''
}

/** 巡检/熔断/超时等运维字段,以及会改写后续审查约束的内容字段:只许人改,agent 走 PATCH 带这些 key 一律 403。 */
const STAGE_OPS_FIELDS = [
  'patrolCron',
  'patrolEnabled',
  'patrolTimezone',
  'quietHoursStart',
  'quietHoursEnd',
  'maxRunsPerDay',
  'timeoutSec',
  'maxRetries',
  'circuitBreakerThreshold',
  'autoClose',
  'promptTemplate',
  'toolsets',
  'model',
] as const

function stagePatchTouchesOps(body: Record<string, unknown>): boolean {
  return STAGE_OPS_FIELDS.some((key) => Object.hasOwn(body, key))
}

/** 空串 / 空白 = 清除覆盖。undefined = 请求没带这个字段。 */
function normalizeStageModelInput(value: unknown): string | null | undefined {
  const raw = asNullableString(value)
  if (raw === undefined) return undefined
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

async function defaultIsAvailableStageModel(modelId: string): Promise<boolean> {
  const view = await getLocalCatalogView()
  return view.isRoutable(view.canonicalize(modelId))
}

async function assertStageModelAvailable(
  modelId: string,
  ctx: TaskboardHttpContext,
): Promise<void> {
  const ok = ctx.isAvailableStageModel
    ? await ctx.isAvailableStageModel(modelId)
    : await defaultIsAvailableStageModel(modelId)
  if (!ok) throw new TaskboardValidationError(`model not available: ${modelId}`)
}

function validateStageWrite(input: {
  kind?: StageKind
  agentId?: string | null
  promptTemplate?: string | null
  patrolEnabled?: boolean
  patrolCron?: string | null
  entryCondition?: string | null
  timeoutSec?: number
}): void {
  if (input.kind === 'ai') {
    if (!input.agentId) throw new TaskboardValidationError('agentId is required for ai stages')
    if (!input.promptTemplate) {
      throw new TaskboardValidationError('promptTemplate is required for ai stages')
    }
  }
  if (input.agentId && isHiddenSystemAgentId(input.agentId)) {
    throw new TaskboardValidationError('hidden-reviewer cannot be bound to a stage')
  }
  if (input.kind === 'human' && (input.patrolEnabled || hasPatrolCron(input.patrolCron))) {
    throw new TaskboardValidationError('human 阶段不能启用巡检或设置巡检 cron')
  }
  if (input.entryCondition != null && input.entryCondition.trim() !== '') {
    const parsed = parseEntryCondition(input.entryCondition)
    if (!parsed.ok) throw new TaskboardValidationError(parsed.error)
  }
  if (input.timeoutSec != null && input.timeoutSec > DELEGATE_IDLE_TIMEOUT_MAX_SEC) {
    throw new TaskboardValidationError(`timeoutSec must be <= ${DELEGATE_IDLE_TIMEOUT_MAX_SEC}`)
  }
}

export async function assertTemplatesValidForApply(
  db: TaskboardDb,
  templateIds: string[],
  ctx: TaskboardHttpContext,
): Promise<void> {
  for (const templateId of templateIds) {
    const template = getTemplate(db, templateId)
    if (!template) throw new TaskboardNotFound('template', templateId)
    for (const stage of template.stages) {
      validateStageWrite({
        kind: stage.kind,
        agentId: stage.agentId,
        promptTemplate: stage.promptTemplate,
        patrolEnabled: stage.patrolEnabled,
        patrolCron: stage.patrolCron,
        entryCondition: stage.entryCondition,
        timeoutSec: stage.timeoutSec,
      })
      if (stage.model) await assertStageModelAvailable(stage.model, ctx)
    }
  }
}

function throwIfStageOrdinalConflict(err: unknown): void {
  if (isUniqueConstraint(err, 'ordinal')) {
    throw new TaskboardValidationError('同一流水线内阶段序号(ordinal)不能重复')
  }
}

export async function handleCreateStage(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  pipelineId: string,
  actor: Actor,
  ctx: TaskboardHttpContext,
): Promise<void> {
  if (actor !== 'human') {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return
  }
  if (!getPipeline(db, pipelineId)) throw new TaskboardNotFound('pipeline', pipelineId)
  const name = asString(body.name)
  const kindRaw = asString(body.kind)
  if (!name || !kindRaw) throw new TaskboardValidationError('name and kind are required')
  if (!(STAGE_KINDS as readonly string[]).includes(kindRaw)) {
    throw new TaskboardValidationError(`invalid kind: ${kindRaw}`)
  }
  const kind = kindRaw as StageKind
  const existing = listStages(db, pipelineId)
  const ordinal = typeof body.ordinal === 'number' ? body.ordinal : existing.length
  const agentId = asNullableString(body.agentId) ?? null
  const promptTemplate = asNullableString(body.promptTemplate) ?? null
  const patrolEnabled = asBoolean(body.patrolEnabled)
  const patrolCron = asNullableString(body.patrolCron) ?? null
  const entryCondition = asNullableString(body.entryCondition)
  const timeoutSec = typeof body.timeoutSec === 'number' ? body.timeoutSec : undefined
  const model = normalizeStageModelInput(body.model) ?? null
  if (model) await assertStageModelAvailable(model, ctx)
  validateStageWrite({
    kind,
    agentId,
    promptTemplate,
    patrolEnabled,
    patrolCron,
    entryCondition,
    timeoutSec,
  })
  let stage: PipelineStage
  try {
    stage = createStage(db, {
      pipelineId,
      ordinal,
      name,
      kind,
      agentId,
      model,
      promptTemplate,
      toolsets: asNullableStringArray(body.toolsets) ?? null,
      effort: asNullableString(body.effort) ?? null,
      patrolCron,
      patrolEnabled,
      patrolTimezone: asString(body.patrolTimezone),
      quietHoursStart: asNullableNumber(body.quietHoursStart),
      quietHoursEnd: asNullableNumber(body.quietHoursEnd),
      maxRunsPerDay: typeof body.maxRunsPerDay === 'number' ? body.maxRunsPerDay : undefined,
      timeoutSec,
      maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined,
      circuitBreakerThreshold:
        typeof body.circuitBreakerThreshold === 'number' ? body.circuitBreakerThreshold : undefined,
      onSuccess: asString(body.onSuccess) as OnSuccessAction | undefined,
      onFailure: asString(body.onFailure) as OnFailureAction | undefined,
      entryCondition,
      exitChecklist: asNullableString(body.exitChecklist),
      requireHumanAck: asBoolean(body.requireHumanAck),
      autoClose: asBoolean(body.autoClose),
    })
  } catch (err) {
    throwIfStageOrdinalConflict(err)
    throw err
  }
  sendJson(res, 201, { ok: true, stage })
}

export function handleGetStage(res: ServerResponse, db: TaskboardDb, id: string): void {
  const stage = getStage(db, id)
  if (!stage) throw new TaskboardNotFound('stage', id)
  sendJson(res, 200, { stage })
}

export function handleReorderStages(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  pipelineId: string,
  actor: Actor,
): void {
  if (actor !== 'human') {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return
  }
  const raw = body.orderedIds
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new TaskboardValidationError('orderedIds must be a non-empty string array')
  }
  const orderedIds = raw.map((id) => String(id))
  try {
    const items = reorderStages(db, pipelineId, orderedIds)
    sendJson(res, 200, { ok: true, items })
  } catch (err) {
    throwIfStageOrdinalConflict(err)
    throw err
  }
}

export async function handlePatchStage(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  id: string,
  actor: Actor,
  ctx: TaskboardHttpContext,
): Promise<void> {
  const existing = getStage(db, id)
  if (!existing) throw new TaskboardNotFound('stage', id)
  if (actor !== 'human' && stagePatchTouchesOps(body)) {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return
  }
  const kind = (asString(body.kind) as StageKind | undefined) ?? existing.kind
  const agentId =
    body.agentId === undefined ? existing.agentId : (asNullableString(body.agentId) ?? null)
  const promptTemplate =
    body.promptTemplate === undefined
      ? existing.promptTemplate
      : (asNullableString(body.promptTemplate) ?? null)
  const patrolEnabled = asBoolean(body.patrolEnabled) ?? existing.patrolEnabled
  const patrolCron =
    body.patrolCron === undefined ? existing.patrolCron : asNullableString(body.patrolCron)
  const entryCondition = asNullableString(body.entryCondition)
  const timeoutSec = typeof body.timeoutSec === 'number' ? body.timeoutSec : existing.timeoutSec
  const model = Object.hasOwn(body, 'model') ? normalizeStageModelInput(body.model) : undefined
  if (model && model !== existing.model) await assertStageModelAvailable(model, ctx)
  validateStageWrite({
    kind,
    agentId,
    promptTemplate,
    patrolEnabled,
    patrolCron,
    entryCondition,
    timeoutSec,
  })
  let stage: PipelineStage
  try {
    stage = updateStage(db, id, {
      name: asString(body.name),
      kind: asString(body.kind) as StageKind | undefined,
      agentId: asNullableString(body.agentId),
      model,
      promptTemplate: asNullableString(body.promptTemplate),
      toolsets: asNullableStringArray(body.toolsets),
      effort: asNullableString(body.effort),
      patrolCron: asNullableString(body.patrolCron),
      patrolEnabled: asBoolean(body.patrolEnabled),
      patrolTimezone: asString(body.patrolTimezone),
      quietHoursStart: asNullableNumber(body.quietHoursStart),
      quietHoursEnd: asNullableNumber(body.quietHoursEnd),
      maxRunsPerDay: typeof body.maxRunsPerDay === 'number' ? body.maxRunsPerDay : undefined,
      timeoutSec: typeof body.timeoutSec === 'number' ? body.timeoutSec : undefined,
      maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined,
      circuitBreakerThreshold:
        typeof body.circuitBreakerThreshold === 'number' ? body.circuitBreakerThreshold : undefined,
      onSuccess: asString(body.onSuccess) as OnSuccessAction | undefined,
      onFailure: asString(body.onFailure) as OnFailureAction | undefined,
      entryCondition,
      exitChecklist: asNullableString(body.exitChecklist),
      requireHumanAck: asBoolean(body.requireHumanAck),
      autoClose: asBoolean(body.autoClose),
      ordinal: typeof body.ordinal === 'number' ? body.ordinal : undefined,
    })
  } catch (err) {
    throwIfStageOrdinalConflict(err)
    throw err
  }
  sendJson(res, 200, { ok: true, stage })
}

export async function handleGetRun(res: ServerResponse, db: TaskboardDb, id: string, ctx: TaskboardHttpContext = {}): Promise<void> {
  const run = getRun(db, id)
  if (!run) throw new TaskboardNotFound('run', id)
  sendJson(res, 200, { run: (await enrichTaskboardRuns(ctx, [run]))[0] })
}
