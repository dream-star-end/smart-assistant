// Pipeline / PipelineStage DAO。
//
// 一个项目可挂多条流水线,按 ticket.type 选默认(is_default + ticket_type)。
// stage.ordinal 从 0 起,同一 pipeline 内 UNIQUE。
// toolsets 存 JSON TEXT,出库还原为 string[] | null,不把 JSON 泄漏上楼。

import type {
  OnFailureAction,
  OnSuccessAction,
  Pipeline,
  PipelineStage,
  StageKind,
  TicketType,
} from '../domain.js'
import { GUARDRAIL_DEFAULTS } from '../domain.js'
import {
  type TaskboardDb,
  TaskboardNotFound,
  boolToInt,
  intToBool,
  newId,
  nowMs,
  parseJsonArrayOrNull,
  stringifyJsonArray,
} from './schema.js'

interface PipelineRow {
  id: string
  project_id: string
  name: string
  ticket_type: TicketType | null
  is_default: number
  created_at: number
  updated_at: number
}

interface StageRow {
  id: string
  pipeline_id: string
  ordinal: number
  name: string
  kind: StageKind
  agent_id: string | null
  prompt_template: string | null
  toolsets: string | null
  effort: string | null
  patrol_cron: string | null
  patrol_enabled: number
  patrol_timezone: string
  quiet_hours_start: number | null
  quiet_hours_end: number | null
  max_runs_per_day: number
  timeout_sec: number
  max_retries: number
  circuit_breaker_threshold: number
  on_success: OnSuccessAction
  on_failure: OnFailureAction
  entry_condition: string | null
  exit_checklist: string | null
  require_human_ack: number
  created_at: number
  updated_at: number
}

const PIPELINE_COLS = `
  id, project_id, name, ticket_type, is_default, created_at, updated_at
`

const STAGE_COLS = `
  id, pipeline_id, ordinal, name, kind, agent_id, prompt_template, toolsets,
  effort, patrol_cron, patrol_enabled, patrol_timezone, quiet_hours_start,
  quiet_hours_end, max_runs_per_day, timeout_sec, max_retries,
  circuit_breaker_threshold, on_success, on_failure, entry_condition,
  exit_checklist, require_human_ack, created_at, updated_at
`

function mapPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    ticketType: row.ticket_type,
    isDefault: intToBool(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapStage(row: StageRow): PipelineStage {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    ordinal: row.ordinal,
    name: row.name,
    kind: row.kind,
    agentId: row.agent_id,
    promptTemplate: row.prompt_template,
    toolsets: parseJsonArrayOrNull(row.toolsets),
    effort: row.effort,
    patrolCron: row.patrol_cron,
    patrolEnabled: intToBool(row.patrol_enabled),
    patrolTimezone: row.patrol_timezone,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    maxRunsPerDay: row.max_runs_per_day,
    timeoutSec: row.timeout_sec,
    maxRetries: row.max_retries,
    circuitBreakerThreshold: row.circuit_breaker_threshold,
    onSuccess: row.on_success,
    onFailure: row.on_failure,
    entryCondition: row.entry_condition,
    exitChecklist: row.exit_checklist,
    requireHumanAck: intToBool(row.require_human_ack),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface CreatePipelineInput {
  id?: string
  projectId: string
  name: string
  ticketType?: TicketType | null
  isDefault?: boolean
}

export interface UpdatePipelineInput {
  name?: string
  ticketType?: TicketType | null
  isDefault?: boolean
}

export interface CreateStageInput {
  id?: string
  pipelineId: string
  ordinal: number
  name: string
  kind: StageKind
  agentId?: string | null
  promptTemplate?: string | null
  toolsets?: string[] | null
  effort?: string | null
  patrolCron?: string | null
  patrolEnabled?: boolean
  patrolTimezone?: string
  quietHoursStart?: number | null
  quietHoursEnd?: number | null
  maxRunsPerDay?: number
  timeoutSec?: number
  maxRetries?: number
  circuitBreakerThreshold?: number
  onSuccess?: OnSuccessAction
  onFailure?: OnFailureAction
  entryCondition?: string | null
  exitChecklist?: string | null
  requireHumanAck?: boolean
}

export interface UpdateStageInput {
  name?: string
  kind?: StageKind
  agentId?: string | null
  promptTemplate?: string | null
  toolsets?: string[] | null
  effort?: string | null
  patrolCron?: string | null
  patrolEnabled?: boolean
  patrolTimezone?: string
  quietHoursStart?: number | null
  quietHoursEnd?: number | null
  maxRunsPerDay?: number
  timeoutSec?: number
  maxRetries?: number
  circuitBreakerThreshold?: number
  onSuccess?: OnSuccessAction
  onFailure?: OnFailureAction
  entryCondition?: string | null
  exitChecklist?: string | null
  requireHumanAck?: boolean
  ordinal?: number
}

export function createPipeline(db: TaskboardDb, input: CreatePipelineInput): Pipeline {
  const now = nowMs()
  const id = input.id ?? newId()
  db.prepare(
    `INSERT INTO tb_pipeline (
       id, project_id, name, ticket_type, is_default, created_at, updated_at
     ) VALUES (@id, @projectId, @name, @ticketType, @isDefault, @now, @now)`,
  ).run({
    id,
    projectId: input.projectId,
    name: input.name,
    ticketType: input.ticketType ?? null,
    isDefault: boolToInt(input.isDefault ?? false),
    now,
  })
  return getPipeline(db, id) as Pipeline
}

export function getPipeline(db: TaskboardDb, id: string): Pipeline | null {
  const row = db.prepare(`SELECT ${PIPELINE_COLS} FROM tb_pipeline WHERE id = ?`).get(id) as
    | PipelineRow
    | undefined
  return row ? mapPipeline(row) : null
}

export function listPipelines(db: TaskboardDb, projectId: string): Pipeline[] {
  const rows = db
    .prepare(
      `SELECT ${PIPELINE_COLS} FROM tb_pipeline
        WHERE project_id = ? ORDER BY ticket_type ASC, created_at ASC`,
    )
    .all(projectId) as PipelineRow[]
  return rows.map(mapPipeline)
}

/** 按单据类型取默认流水线;没有精确匹配再回落 ticket_type IS NULL 的通用线。 */
export function getDefaultPipeline(
  db: TaskboardDb,
  projectId: string,
  ticketType: TicketType,
): Pipeline | null {
  const exact = db
    .prepare(
      `SELECT ${PIPELINE_COLS} FROM tb_pipeline
        WHERE project_id = ? AND ticket_type = ? AND is_default = 1
        LIMIT 1`,
    )
    .get(projectId, ticketType) as PipelineRow | undefined
  if (exact) return mapPipeline(exact)
  const fallback = db
    .prepare(
      `SELECT ${PIPELINE_COLS} FROM tb_pipeline
        WHERE project_id = ? AND ticket_type IS NULL AND is_default = 1
        LIMIT 1`,
    )
    .get(projectId) as PipelineRow | undefined
  return fallback ? mapPipeline(fallback) : null
}

export function updatePipeline(db: TaskboardDb, id: string, input: UpdatePipelineInput): Pipeline {
  const existing = getPipeline(db, id)
  if (!existing) throw new TaskboardNotFound('pipeline', id)
  const now = nowMs()
  db.prepare(
    `UPDATE tb_pipeline SET
       name = @name,
       ticket_type = @ticketType,
       is_default = @isDefault,
       updated_at = @now
     WHERE id = @id`,
  ).run({
    id,
    name: input.name ?? existing.name,
    ticketType: input.ticketType === undefined ? existing.ticketType : input.ticketType,
    isDefault: boolToInt(input.isDefault ?? existing.isDefault),
    now,
  })
  return getPipeline(db, id) as Pipeline
}

export function createStage(db: TaskboardDb, input: CreateStageInput): PipelineStage {
  const now = nowMs()
  const id = input.id ?? newId()
  const isAi = input.kind === 'ai'
  db.prepare(
    `INSERT INTO tb_pipeline_stage (
       id, pipeline_id, ordinal, name, kind, agent_id, prompt_template, toolsets,
       effort, patrol_cron, patrol_enabled, patrol_timezone, quiet_hours_start,
       quiet_hours_end, max_runs_per_day, timeout_sec, max_retries,
       circuit_breaker_threshold, on_success, on_failure, entry_condition,
       exit_checklist, require_human_ack, created_at, updated_at
     ) VALUES (
       @id, @pipelineId, @ordinal, @name, @kind, @agentId, @promptTemplate, @toolsets,
       @effort, @patrolCron, @patrolEnabled, @patrolTimezone, @quietHoursStart,
       @quietHoursEnd, @maxRunsPerDay, @timeoutSec, @maxRetries,
       @circuitBreakerThreshold, @onSuccess, @onFailure, @entryCondition,
       @exitChecklist, @requireHumanAck, @now, @now
     )`,
  ).run({
    id,
    pipelineId: input.pipelineId,
    ordinal: input.ordinal,
    name: input.name,
    kind: input.kind,
    agentId: input.agentId ?? null,
    promptTemplate: input.promptTemplate ?? null,
    toolsets: input.toolsets == null ? null : stringifyJsonArray(input.toolsets),
    effort: input.effort ?? null,
    patrolCron: input.patrolCron ?? null,
    patrolEnabled: boolToInt(input.patrolEnabled ?? isAi),
    patrolTimezone: input.patrolTimezone ?? 'Asia/Shanghai',
    quietHoursStart: input.quietHoursStart ?? GUARDRAIL_DEFAULTS.quietHoursStart,
    quietHoursEnd: input.quietHoursEnd ?? GUARDRAIL_DEFAULTS.quietHoursEnd,
    maxRunsPerDay: input.maxRunsPerDay ?? 8,
    timeoutSec: input.timeoutSec ?? GUARDRAIL_DEFAULTS.defaultTimeoutSec,
    maxRetries: input.maxRetries ?? (isAi ? 2 : 0),
    circuitBreakerThreshold:
      input.circuitBreakerThreshold ?? GUARDRAIL_DEFAULTS.circuitBreakerThreshold,
    onSuccess: input.onSuccess ?? 'advance',
    onFailure: input.onFailure ?? (isAi ? 'retry' : 'wait_human'),
    entryCondition: input.entryCondition ?? null,
    exitChecklist: input.exitChecklist ?? null,
    requireHumanAck: boolToInt(input.requireHumanAck ?? false),
    now,
  })
  return getStage(db, id) as PipelineStage
}

export function getStage(db: TaskboardDb, id: string): PipelineStage | null {
  const row = db.prepare(`SELECT ${STAGE_COLS} FROM tb_pipeline_stage WHERE id = ?`).get(id) as
    | StageRow
    | undefined
  return row ? mapStage(row) : null
}

export function listStages(db: TaskboardDb, pipelineId: string): PipelineStage[] {
  const rows = db
    .prepare(
      `SELECT ${STAGE_COLS} FROM tb_pipeline_stage
        WHERE pipeline_id = ? ORDER BY ordinal ASC`,
    )
    .all(pipelineId) as StageRow[]
  return rows.map(mapStage)
}

export function updateStage(db: TaskboardDb, id: string, input: UpdateStageInput): PipelineStage {
  const existing = getStage(db, id)
  if (!existing) throw new TaskboardNotFound('stage', id)
  const now = nowMs()
  const toolsets =
    input.toolsets === undefined
      ? existing.toolsets == null
        ? null
        : stringifyJsonArray(existing.toolsets)
      : input.toolsets == null
        ? null
        : stringifyJsonArray(input.toolsets)
  db.prepare(
    `UPDATE tb_pipeline_stage SET
       name = @name,
       kind = @kind,
       agent_id = @agentId,
       prompt_template = @promptTemplate,
       toolsets = @toolsets,
       effort = @effort,
       patrol_cron = @patrolCron,
       patrol_enabled = @patrolEnabled,
       patrol_timezone = @patrolTimezone,
       quiet_hours_start = @quietHoursStart,
       quiet_hours_end = @quietHoursEnd,
       max_runs_per_day = @maxRunsPerDay,
       timeout_sec = @timeoutSec,
       max_retries = @maxRetries,
       circuit_breaker_threshold = @circuitBreakerThreshold,
       on_success = @onSuccess,
       on_failure = @onFailure,
       entry_condition = @entryCondition,
       exit_checklist = @exitChecklist,
       require_human_ack = @requireHumanAck,
       ordinal = @ordinal,
       updated_at = @now
     WHERE id = @id`,
  ).run({
    id,
    name: input.name ?? existing.name,
    kind: input.kind ?? existing.kind,
    agentId: input.agentId === undefined ? existing.agentId : input.agentId,
    promptTemplate:
      input.promptTemplate === undefined ? existing.promptTemplate : input.promptTemplate,
    toolsets,
    effort: input.effort === undefined ? existing.effort : input.effort,
    patrolCron: input.patrolCron === undefined ? existing.patrolCron : input.patrolCron,
    patrolEnabled: boolToInt(input.patrolEnabled ?? existing.patrolEnabled),
    patrolTimezone: input.patrolTimezone ?? existing.patrolTimezone,
    quietHoursStart:
      input.quietHoursStart === undefined ? existing.quietHoursStart : input.quietHoursStart,
    quietHoursEnd: input.quietHoursEnd === undefined ? existing.quietHoursEnd : input.quietHoursEnd,
    maxRunsPerDay: input.maxRunsPerDay ?? existing.maxRunsPerDay,
    timeoutSec: input.timeoutSec ?? existing.timeoutSec,
    maxRetries: input.maxRetries ?? existing.maxRetries,
    circuitBreakerThreshold: input.circuitBreakerThreshold ?? existing.circuitBreakerThreshold,
    onSuccess: input.onSuccess ?? existing.onSuccess,
    onFailure: input.onFailure ?? existing.onFailure,
    entryCondition:
      input.entryCondition === undefined ? existing.entryCondition : input.entryCondition,
    exitChecklist: input.exitChecklist === undefined ? existing.exitChecklist : input.exitChecklist,
    requireHumanAck: boolToInt(input.requireHumanAck ?? existing.requireHumanAck),
    ordinal: input.ordinal ?? existing.ordinal,
    now,
  })
  return getStage(db, id) as PipelineStage
}

export function deleteStage(db: TaskboardDb, id: string): void {
  const result = db.prepare('DELETE FROM tb_pipeline_stage WHERE id = ?').run(id)
  if (result.changes === 0) throw new TaskboardNotFound('stage', id)
}
