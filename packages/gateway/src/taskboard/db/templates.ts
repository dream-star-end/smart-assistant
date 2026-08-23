// 流水线模板 DAO。内置四条 = seed.ts 的 bug/feature/spike/chore,不是另一套概念。
// 自定义模板快照进 tb_pipeline_template;套用时 createPipeline + createStage,
// 与手工建线走同一条写路径,默认互斥仍由 pipelines.ts 兜住。

import type {
  OnFailureAction,
  OnSuccessAction,
  Pipeline,
  PipelineStage,
  StageKind,
  TicketType,
} from '../domain.js'
import { createPipeline, createStage, getPipeline, listStages } from './pipelines.js'
import {
  type TaskboardDb,
  TaskboardNotFound,
  TaskboardValidationError,
  newId,
  nowMs,
} from './schema.js'
import {
  type BuiltinPipelineTemplate,
  builtinTemplateId,
  getBuiltinPipelineTemplate,
  listBuiltinPipelineTemplates,
  parseBuiltinTemplateId,
  seedDefaultPipelines,
} from './seed.js'

export const TEMPLATE_SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/

export interface TemplateStageSnapshot {
  ordinal: number
  name: string
  kind: StageKind
  agentId: string | null
  model: string | null
  promptTemplate: string | null
  toolsets: string[] | null
  effort: string | null
  patrolCron: string | null
  patrolEnabled: boolean
  patrolTimezone: string
  quietHoursStart: number | null
  quietHoursEnd: number | null
  maxRunsPerDay: number
  timeoutSec: number
  maxRetries: number
  circuitBreakerThreshold: number
  onSuccess: OnSuccessAction
  onFailure: OnFailureAction
  entryCondition: string | null
  exitChecklist: string | null
  requireHumanAck: boolean
  autoClose: boolean
}

export interface PipelineTemplate {
  id: string
  slug: string
  name: string
  ticketType: TicketType | null
  source: 'builtin' | 'custom'
  stages: TemplateStageSnapshot[]
  createdAt: number
  updatedAt: number
}

interface TemplateRow {
  id: string
  slug: string
  name: string
  ticket_type: TicketType | null
  stages_json: string
  created_at: number
  updated_at: number
}

function snapshotFromBuiltin(t: BuiltinPipelineTemplate): PipelineTemplate {
  return {
    id: t.id,
    slug: t.id,
    name: t.name,
    ticketType: t.ticketType,
    source: 'builtin',
    stages: t.stages.map((s, ordinal) => ({
      ordinal,
      name: s.name,
      kind: s.kind,
      agentId: s.agentId,
      model: null,
      promptTemplate: s.promptTemplate,
      toolsets: null,
      effort: s.effort,
      patrolCron: s.kind === 'ai' ? t.patrolCron : null,
      patrolEnabled: s.kind === 'ai',
      patrolTimezone: 'Asia/Shanghai',
      quietHoursStart: t.quietHoursStart,
      quietHoursEnd: t.quietHoursEnd,
      maxRunsPerDay: s.kind === 'ai' ? 8 : 0,
      timeoutSec: t.timeoutSec,
      maxRetries: s.kind === 'ai' ? 2 : 0,
      circuitBreakerThreshold: t.circuitBreakerThreshold,
      onSuccess: s.onSuccess,
      onFailure: s.kind === 'ai' ? 'retry' : 'wait_human',
      entryCondition: s.entryCondition,
      exitChecklist: s.exitChecklist,
      requireHumanAck: s.requireHumanAck,
      autoClose: false,
    })),
    createdAt: 0,
    updatedAt: 0,
  }
}

function snapshotFromStage(stage: PipelineStage): TemplateStageSnapshot {
  return {
    ordinal: stage.ordinal,
    name: stage.name,
    kind: stage.kind,
    agentId: stage.agentId,
    model: stage.model,
    promptTemplate: stage.promptTemplate,
    toolsets: stage.toolsets,
    effort: stage.effort,
    patrolCron: stage.patrolCron,
    patrolEnabled: stage.patrolEnabled,
    patrolTimezone: stage.patrolTimezone,
    quietHoursStart: stage.quietHoursStart,
    quietHoursEnd: stage.quietHoursEnd,
    maxRunsPerDay: stage.maxRunsPerDay,
    timeoutSec: stage.timeoutSec,
    maxRetries: stage.maxRetries,
    circuitBreakerThreshold: stage.circuitBreakerThreshold,
    onSuccess: stage.onSuccess,
    onFailure: stage.onFailure,
    entryCondition: stage.entryCondition,
    exitChecklist: stage.exitChecklist,
    requireHumanAck: stage.requireHumanAck,
    autoClose: stage.autoClose,
  }
}

function parseStagesJson(raw: string): TemplateStageSnapshot[] {
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is TemplateStageSnapshot =>
        item != null &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string',
    )
  } catch {
    return []
  }
}

function mapCustom(row: TemplateRow): PipelineTemplate {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ticketType: row.ticket_type,
    source: 'custom',
    stages: parseStagesJson(row.stages_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getCustomTemplate(db: TaskboardDb, idOrSlug: string): PipelineTemplate | null {
  const row = db
    .prepare(
      `SELECT id, slug, name, ticket_type, stages_json, created_at, updated_at
         FROM tb_pipeline_template WHERE id = ? OR slug = ?`,
    )
    .get(idOrSlug, idOrSlug) as TemplateRow | undefined
  return row ? mapCustom(row) : null
}

export function getTemplate(db: TaskboardDb, idOrSlug: string): PipelineTemplate | null {
  const builtin = getBuiltinPipelineTemplate(idOrSlug)
  if (builtin) return snapshotFromBuiltin(builtin)
  return getCustomTemplate(db, idOrSlug)
}

export function listTemplates(db: TaskboardDb): PipelineTemplate[] {
  const builtins = listBuiltinPipelineTemplates().map(snapshotFromBuiltin)
  const rows = db
    .prepare(
      `SELECT id, slug, name, ticket_type, stages_json, created_at, updated_at
         FROM tb_pipeline_template ORDER BY created_at ASC`,
    )
    .all() as TemplateRow[]
  return [...builtins, ...rows.map(mapCustom)]
}

export interface CreateTemplateFromPipelineInput {
  pipelineId: string
  name?: string
  slug?: string
}

function normalizeSlug(raw: string): string {
  const slug = raw.trim().toLowerCase()
  if (!TEMPLATE_SLUG_RE.test(slug)) {
    throw new TaskboardValidationError(
      `invalid template slug '${raw}': must match ${TEMPLATE_SLUG_RE}`,
    )
  }
  if (slug.startsWith('builtin')) {
    throw new TaskboardValidationError('slug must not start with builtin')
  }
  return slug
}

function slugFromName(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (TEMPLATE_SLUG_RE.test(ascii) && !ascii.startsWith('builtin')) return ascii
  return `custom-${newId().slice(0, 8)}`
}

/** 从已有项目流水线拍快照,存成自定义模板。不改原流水线。 */
export function createTemplateFromPipeline(
  db: TaskboardDb,
  input: CreateTemplateFromPipelineInput,
): PipelineTemplate {
  const pipeline = getPipeline(db, input.pipelineId)
  if (!pipeline) throw new TaskboardNotFound('pipeline', input.pipelineId)
  const stages = listStages(db, pipeline.id)
  if (stages.length === 0) {
    throw new TaskboardValidationError('pipeline has no stages to snapshot')
  }
  const name = (input.name ?? pipeline.name).trim()
  if (!name) throw new TaskboardValidationError('name is required')
  const slug = input.slug ? normalizeSlug(input.slug) : slugFromName(name)
  const id = newId()
  const now = nowMs()
  try {
    db.prepare(
      `INSERT INTO tb_pipeline_template (
         id, slug, name, ticket_type, stages_json, created_at, updated_at
       ) VALUES (@id, @slug, @name, @ticketType, @stagesJson, @now, @now)`,
    ).run({
      id,
      slug,
      name,
      ticketType: pipeline.ticketType,
      stagesJson: JSON.stringify(stages.map(snapshotFromStage)),
      now,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE constraint failed')) {
      throw new TaskboardValidationError(`template slug '${slug}' already exists`)
    }
    throw err
  }
  return getCustomTemplate(db, id) as PipelineTemplate
}

export function deleteTemplate(db: TaskboardDb, idOrSlug: string): void {
  if (parseBuiltinTemplateId(idOrSlug) || getBuiltinPipelineTemplate(idOrSlug)) {
    throw new TaskboardValidationError('cannot delete builtin template')
  }
  const existing = getCustomTemplate(db, idOrSlug)
  if (!existing) throw new TaskboardNotFound('template', idOrSlug)
  db.prepare('DELETE FROM tb_pipeline_template WHERE id = ?').run(existing.id)
}

export interface ApplyTemplateResult {
  template: PipelineTemplate
  pipeline: Pipeline | null
  createdPipelines: number
  createdStages: number
  skippedPipelines: number
  skippedStages: number
}

export interface ApplyTemplateOptions {
  asDefault?: boolean
}

function applyCustomTemplate(
  db: TaskboardDb,
  template: PipelineTemplate,
  projectId: string,
  opts: ApplyTemplateOptions,
): ApplyTemplateResult {
  const project = db.prepare('SELECT id FROM tb_project WHERE id = ?').get(projectId) as
    | { id: string }
    | undefined
  if (!project) throw new TaskboardNotFound('project', projectId)
  if (template.stages.length === 0) {
    throw new TaskboardValidationError('template has no stages')
  }
  const asDefault = opts.asDefault ?? true
  const write = db.transaction(() => {
    const pipeline = createPipeline(db, {
      projectId,
      name: template.name,
      ticketType: template.ticketType,
      isDefault: asDefault,
    })
    let createdStages = 0
    for (const stage of template.stages) {
      createStage(db, {
        pipelineId: pipeline.id,
        ordinal: stage.ordinal,
        name: stage.name,
        kind: stage.kind,
        agentId: stage.agentId,
        model: stage.model,
        promptTemplate: stage.promptTemplate,
        toolsets: stage.toolsets,
        effort: stage.effort,
        patrolCron: stage.patrolCron,
        patrolEnabled: stage.patrolEnabled,
        patrolTimezone: stage.patrolTimezone,
        quietHoursStart: stage.quietHoursStart,
        quietHoursEnd: stage.quietHoursEnd,
        maxRunsPerDay: stage.maxRunsPerDay,
        timeoutSec: stage.timeoutSec,
        maxRetries: stage.maxRetries,
        circuitBreakerThreshold: stage.circuitBreakerThreshold,
        onSuccess: stage.onSuccess,
        onFailure: stage.onFailure,
        entryCondition: stage.entryCondition,
        exitChecklist: stage.exitChecklist,
        requireHumanAck: stage.requireHumanAck,
        autoClose: stage.autoClose,
      })
      createdStages += 1
    }
    return {
      template,
      pipeline,
      createdPipelines: 1,
      createdStages,
      skippedPipelines: 0,
      skippedStages: 0,
    }
  })
  return write()
}

/**
 * 把模板套到项目上。内置模板走 seed 同款确定性 id,已存在则跳过(不覆盖用户改过的提示词)。
 * 自定义模板每次新建一条流水线。
 */
export function applyTemplate(
  db: TaskboardDb,
  templateId: string,
  projectId: string,
  opts: ApplyTemplateOptions = {},
): ApplyTemplateResult {
  const builtinType = parseBuiltinTemplateId(templateId)
  if (builtinType) {
    const template = snapshotFromBuiltin(getBuiltinPipelineTemplate(builtinType)!)
    const seeded = seedDefaultPipelines(db, projectId, [builtinType])
    const pid = `${projectId}.pipeline.${builtinType}`
    return {
      template,
      pipeline: getPipeline(db, pid),
      createdPipelines: seeded.createdPipelines,
      createdStages: seeded.createdStages,
      skippedPipelines: seeded.skippedPipelines,
      skippedStages: seeded.skippedStages,
    }
  }
  const template = getTemplate(db, templateId)
  if (!template) throw new TaskboardNotFound('template', templateId)
  if (template.source === 'builtin') {
    return applyTemplate(db, builtinTemplateId(template.ticketType as TicketType), projectId, opts)
  }
  return applyCustomTemplate(db, template, projectId, opts)
}

export function applyTemplates(
  db: TaskboardDb,
  projectId: string,
  templateIds: string[],
): ApplyTemplateResult[] {
  return templateIds.map((id) => applyTemplate(db, id, projectId))
}
