// Taskboard HTTP 层 —— `/api/board/*` 路由分发与全部端点。
//
// 入口 `handleTaskboardApi` 形状对齐 gateway cron handler:已鉴权之后调用,
// 返回是否已处理。鉴权本身仍由 server.ts 的 /api/* 闸门负责(JWT / accessToken /
// bridge bypass),本层不再验一遍。
//
// 身份:selfhost 单租户,getUserId 恒为 `default`,不做多租户隔离
// (商业 proxy 剥掉 Authorization,容器侧 JWT userId 不可用)。
//
// actor 判定见 `resolveTaskboardActor` —— 不信 body.actor。

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  commitProjectSkillOverlay,
  loadProjectContext,
  parseProjectWorkspace,
  paths,
  readProjectRunContextFile,
  resolveProjectCwd,
  writeProjectInstructions,
} from '@openclaude/storage'
import { filterUserVisibleAgentsForManagement, isHiddenSystemAgentId } from '../agentVisibility.js'
import { verifyJwt } from '../auth.js'
import {
  ModelCatalogUnavailableError,
  getLocalCatalogView,
} from '../modelCatalogClient.js'
import { createActivity, listActivities } from './db/activity.js'
import { createComment, listComments } from './db/comments.js'
import { COST_GROUP_BY, queryCostStats, ymdRangeMs } from './db/costStats.js'
import {
  TaskboardCrossProjectError,
  TaskboardCycleError,
  type TaskboardDb,
  TaskboardDuplicateRelationError,
  TaskboardLeaseHeld,
  TaskboardNotFound,
  TaskboardSingleParentError,
  TaskboardValidationError,
  TaskboardVersionConflict,
  getTaskboardDb,
  isTaskboardError,
} from './db/index.js'
import {
  createPipeline,
  createStage,
  getDefaultPipeline,
  getPipeline,
  getStage,
  listPipelines,
  listStages,
  reorderStages,
  updatePipeline,
  updateStage,
} from './db/pipelines.js'
import {
  archiveProject,
  createProject,
  getProject,
  getProjectByKey,
  listProjects,
  updateProject,
} from './db/projects.js'
import { addRelation, listRelations, removeRelation } from './db/relations.js'
import {
  acquireLease,
  getActiveLease,
  getRun,
  insertRun,
  listRuns,
  releaseLease,
  updateRun,
} from './db/runs.js'
import { seedDefaultPipelines } from './db/seed.js'
import {
  type TaskboardSettings,
  type TaskboardUsage,
  getSettings,
  getUsage,
  updateSettings,
} from './db/settings.js'
import { dispatchProjectMemory } from './projectMemoryHttp.js'
import { previewProjectContext, summarizeProjectContext } from '../projectContextPreview.js'
import {
  applyTemplate,
  applyTemplates,
  createTemplateFromPipeline,
  deleteTemplate,
  getTemplate,
  listTemplates,
} from './db/templates.js'
import {
  countTicketsByTypeForBoardDefault,
  createTicket,
  getTicketByIdOrIdentifier,
  listTickets,
  updateTicket,
} from './db/tickets.js'
import { buildWeeklyReport, currentWeekPeriod, periodFromIsoWeek } from './db/weeklyReport.js'
import {
  type Actor,
  type AuthorKind,
  GUARDRAIL_DEFAULTS,
  type OnFailureAction,
  type OnSuccessAction,
  type PipelineStage,
  RELATION_KINDS,
  type RelationKind,
  type RunStatus,
  STAGE_KINDS,
  type StageKind,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  TICKET_TYPES,
  type Ticket,
  type TicketPriority,
  type TicketSeverity,
  type TicketSource,
  type TicketStatus,
  type TicketType,
  buildPatrolSessionKey,
} from './domain.js'
import { parseEntryCondition } from './entryCondition.js'
import { getSharedPatrolSlots, stageLoopCountOnProgress } from './guardrails.js'
import {
  type AllowedMove,
  type MoveStageRef,
  formatMoveComment,
  interpretMove,
  listAllowedMoves,
  publicStageRef,
} from './moveIntent.js'
import { zonedYmd } from './notify.js'
import { hasOpenBlockers, listOpenBlockers } from './patrol.js'
import { TaskboardTransitionDenied, assertTransition } from './stateMachine.js'

export type { TaskboardSettings, TaskboardUsage }

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 与 commercial `containerApiProxy` body 上限对齐,超限 413 而不是崩。 */
export const TASKBOARD_MAX_BODY_BYTES = 512 * 1024

/** 单次 run 允许配置的最大无活动窗口；活跃 run 没有 45 分钟墙钟上限。 */
const DELEGATE_IDLE_TIMEOUT_MAX_SEC = 45 * 60

const USER_ID = 'default'
const HUMAN_ACTOR_ID = `user:${USER_ID}`

const TICKET_ACTIONS = [
  'ready',
  'claim',
  'advance',
  'block',
  'approve',
  'reject',
  'done',
  'cancel',
  'comment',
  'patrol',
  'move',
] as const
type TicketAction = (typeof TICKET_ACTIONS)[number]

const TICKET_COLLECTIONS = ['runs', 'relations', 'comments', 'activity', 'timeline'] as const
type TicketCollection = (typeof TICKET_COLLECTIONS)[number]

// ── 上下文 / actor ──────────────────────────────────────────────────────────

export interface BoardAgent {
  id: string
  name: string
  model: string
  description: string
}

export interface TaskboardHttpContext {
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
  /**
   * 阶段 model 覆盖是否在当前 catalog 投影里且 available。
   * 测试注入;生产省略则走 getLocalCatalogView().isRoutable。
   */
  isAvailableStageModel?: (modelId: string) => boolean | Promise<boolean>
}

export interface ResolveActorOptions {
  jwtSecret?: string
  isCommercialJwt?: (token: string) => boolean
  /**
   * server.ts `checkBridgeBypass()` 的真实校验结果。**不要**在本层从请求头推导 ——
   * 见 resolveTaskboardActor 的注释,那是可被容器内 agent 伪造的提权路径。
   */
  bridgeVerified?: boolean
}

/**
 * 从已鉴权请求推导状态机 actor。判据(按优先级):
 *
 *   1. `Authorization: Bearer` / `oc_session` 能通过个人 JWT 或商业 JWT 验签
 *      → **human**。浏览器登录走 `/api/auth/login` 签发 JWT。
 *   2. `opts.bridgeVerified === true` → **human**。这是商业 master 代理进容器的
 *      浏览器请求(master 已剥掉 Authorization,auth 在 master 那侧验过)。
 *   3. 其余已鉴权请求(raw gateway accessToken / MCP `OPENCLAUDE_GATEWAY_TOKEN` /
 *      CLI 读 token file)→ **agent**。
 *
 * ⚠ `bridgeVerified` 必须由 server.ts 传入 `checkBridgeBypass()` 的**真实校验结果**,
 * 不能在本层嗅 `X-OpenClaude-Bridge-Nonce` 请求头。该头是纯客户端可控输入:容器内的
 * agent 持有 gateway token,走回环调用时鉴权本就能过,再随手加一行伪造的 nonce 头就会
 * 被判成 human,从而给自己的单据点「完成」或自行批准开工 —— 正好击穿本系统
 * 「done 永远不属于 AI」的红线。真正的校验在 server.ts `checkBridgeBypass()`:
 * 源 IP 必须是 docker 网桥网关、container-id 绑定、nonce 走 timingSafeEqual,
 * 回环调用方无法满足源 IP 这一条。
 *
 * 局限(写清以免后人改坏):
 *   - 人若把 raw accessToken 当 Bearer 用,会被判成 agent,无法与 MCP 区分。
 *     这是有意的保守方向:宁可把人降级成 agent(少给权限),不可把 agent 升成 human。
 *   - agent 若拿到浏览器 JWT,会被判成 human。JWT 泄漏本身是更大的问题,不在本层兜。
 *   - 不能从 JWT 解析 agentId;agent 身份靠 claim.owner 或 OPENCLAUDE_AGENT_ID。
 *   - **绝不**读取 body.actor / body.authorKind 作为权限依据 —— 那等于把
 *     权限表交给客户端,AI 一行 `{"actor":"human"}` 就能自己点完成。
 */
export function resolveTaskboardActor(req: IncomingMessage, opts: ResolveActorOptions = {}): Actor {
  const token = extractRequestToken(req)
  if (token) {
    if (opts.jwtSecret && verifyJwt(token, opts.jwtSecret)) return 'human'
    if (opts.isCommercialJwt?.(token)) return 'human'
  }
  if (opts.bridgeVerified === true) return 'human'
  return 'agent'
}

function extractRequestToken(req: IncomingMessage): string {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
  if (auth) return auth
  const cookies = (req.headers.cookie || '').split(';').reduce(
    (acc, part) => {
      const [k, ...rest] = part.trim().split('=')
      if (k) acc[k] = rest.join('=')
      return acc
    },
    {} as Record<string, string>,
  )
  return cookies.oc_session || ''
}

function resolveActor(req: IncomingMessage, ctx: TaskboardHttpContext): Actor {
  if (ctx.actor) return ctx.actor
  if (ctx.resolveActor) return ctx.resolveActor(req)
  return resolveTaskboardActor(req, ctx)
}

function actorIdOf(actor: Actor, owner?: string | null, stageAgentId?: string | null): string {
  if (actor === 'human') return HUMAN_ACTOR_ID
  if (actor === 'system') return 'system'
  const explicit = owner?.trim()
  if (explicit) {
    return explicit.startsWith('agent:') || explicit.startsWith('user:')
      ? explicit
      : `agent:${explicit}`
  }
  const bound = stageAgentId?.trim()
  if (bound) return bound.startsWith('agent:') ? bound : `agent:${bound}`
  const envId = (process.env.OPENCLAUDE_AGENT_ID ?? process.env.OC_AGENT_ID ?? '').trim()
  if (envId) return envId.startsWith('agent:') ? envId : `agent:${envId}`
  return 'agent:unidentified'
}

/** 给测试与调用方解析时间线身份;权限仍只看 resolveTaskboardActor,不信 body.actor。 */
export function resolveTaskboardActorId(
  actor: Actor,
  owner?: string | null,
  stageAgentId?: string | null,
): string {
  return actorIdOf(actor, owner, stageAgentId)
}

// ── T4:手动巡检后台执行(由 patrol.ts 的引擎接手)────────────────────────────

export interface PatrolExecutionJob {
  ticketId: string
  runId: string
  stageId: string
  agentId: string | null
  trigger: 'manual'
  sessionKey: string
}

export type PatrolExecutionHandler = (job: PatrolExecutionJob) => void

let _patrolHandler: PatrolExecutionHandler | null = null

/**
 * 注册真正的 delegate 执行。生产由 server.ts 接到 PatrolEngine.executeJob;
 * 测试可注入 mock。未注册时 enqueue 空转,run 保持 running,前端靠轮询终态。
 */
export function setPatrolExecutionHandler(handler: PatrolExecutionHandler | null): void {
  _patrolHandler = handler
}

/**
 * 把一次已 claim 的手动巡检丢进后台。handler 由 PatrolEngine.executeJob 提供,
 * 同进程直调 delegate,不打 HTTP。
 */
export function enqueuePatrolExecution(job: PatrolExecutionJob): void {
  const handler = _patrolHandler
  if (!handler) return
  queueMicrotask(() => {
    try {
      handler(job)
    } catch {
      /* T4 接上之前桩失败不能砸掉 HTTP 响应 */
    }
  })
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

class BodyTooLargeError extends Error {
  constructor() {
    super('payload too large')
    this.name = 'BodyTooLargeError'
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super('invalid JSON')
    this.name = 'InvalidJsonError'
  }
}

class TaskboardMoveDenied extends Error {
  override readonly name = 'TaskboardMoveDenied'
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendError(
  res: ServerResponse,
  code: number,
  error: string,
  extra?: Record<string, unknown>,
): void {
  sendJson(res, code, extra ? { error, ...extra } : { error })
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        // 不 destroy:掐连接会让客户端 fetch 直接失败,来不及收 413。
        req.resume()
        finish(() => reject(new BodyTooLargeError()))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf-8'))))
    req.on('error', (err) => finish(() => reject(err)))
  })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, TASKBOARD_MAX_BODY_BYTES)
  if (!raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    throw new TaskboardValidationError('request body must be an object')
  } catch (err) {
    if (err instanceof TaskboardValidationError) throw err
    throw new InvalidJsonError()
  }
}

function urlOf(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1')
}

function parseLimit(url: URL, fallback = 50, max = 200): number {
  const raw = url.searchParams.get('limit')
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), 1), max)
}

function parseOffset(url: URL): number {
  const raw = url.searchParams.get('offset')
  if (raw == null || raw === '') return 0
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  return Math.max(Math.trunc(n), 0)
}

function requireExpectedVersion(body: Record<string, unknown>): number {
  const v = body.expectedVersion
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new TaskboardValidationError('expectedVersion is required')
  }
  return v
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string') return value
  throw new TaskboardValidationError('expected string or null')
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TaskboardValidationError('expected number or null')
}

function asBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  throw new TaskboardValidationError('expected boolean')
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TaskboardValidationError('expected string[]')
  }
  return value
}

function asNullableStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return asStringArray(value)
}

function parseCsvEnums<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (!raw) return undefined
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as T[]
  for (const part of parts) {
    if (!allowed.includes(part)) {
      throw new TaskboardValidationError(`invalid ${field}: ${part}`)
    }
  }
  return parts.length ? parts : undefined
}

function isUniqueConstraint(err: unknown, needle?: string): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (!msg.includes('UNIQUE constraint failed')) return false
  return needle ? msg.includes(needle) : true
}

function resolveProject(db: TaskboardDb, idOrKey: string) {
  return getProject(db, idOrKey) ?? getProjectByKey(db, idOrKey)
}

function requireTicket(db: TaskboardDb, idOrIdent: string): Ticket {
  const ticket = getTicketByIdOrIdentifier(db, idOrIdent)
  if (!ticket) throw new TaskboardNotFound('ticket', idOrIdent)
  return ticket
}

function currentStage(db: TaskboardDb, ticket: Ticket): PipelineStage | null {
  if (!ticket.stageId) return null
  return getStage(db, ticket.stageId)
}

function nextStage(db: TaskboardDb, stage: PipelineStage): PipelineStage | null {
  const stages = listStages(db, stage.pipelineId)
  return stages.find((s) => s.ordinal > stage.ordinal) ?? null
}

function previousAiStage(db: TaskboardDb, stage: PipelineStage): PipelineStage | null {
  const stages = listStages(db, stage.pipelineId)
  const earlier = stages.filter((s) => s.ordinal < stage.ordinal && s.kind === 'ai')
  return earlier.length ? earlier[earlier.length - 1] : null
}

function recordActivity(
  db: TaskboardDb,
  ticketId: string,
  actor: Actor,
  actorId: string,
  action: string,
  field?: string | null,
  fromValue?: string | null,
  toValue?: string | null,
): void {
  createActivity(db, { ticketId, actor, actorId, action, field, fromValue, toValue })
}

function mapHttpError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof BodyTooLargeError) {
    sendError(res, 413, 'payload too large')
    return true
  }
  if (err instanceof InvalidJsonError) {
    sendError(res, 400, 'invalid JSON')
    return true
  }
  if (err instanceof TaskboardTransitionDenied) {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return true
  }
  if (err instanceof TaskboardMoveDenied) {
    sendJson(res, err.httpStatus, {
      error: err.message,
      code: err.code,
      detail: err.detail,
    })
    return true
  }
  if (err instanceof TaskboardVersionConflict) {
    sendError(res, 409, err.message, {
      code: 'version_conflict',
      expectedVersion: err.expectedVersion,
      actualVersion: err.actualVersion,
    })
    return true
  }
  if (err instanceof TaskboardLeaseHeld) {
    sendError(res, 423, 'lease held', { code: 'lease_held' })
    return true
  }
  if (err instanceof TaskboardNotFound) {
    sendError(res, 404, err.message, { code: 'not_found' })
    return true
  }
  if (err instanceof TaskboardValidationError) {
    sendError(res, 400, err.message, { code: 'validation' })
    return true
  }
  if (err instanceof ModelCatalogUnavailableError) {
    sendError(res, 503, err.message, { code: 'model_catalog_unavailable' })
    return true
  }
  if (err instanceof TaskboardCrossProjectError) {
    sendError(res, 422, err.message, { code: 'cross_project' })
    return true
  }
  if (err instanceof TaskboardCycleError) {
    sendError(res, 409, err.message, { code: 'cycle' })
    return true
  }
  if (err instanceof TaskboardSingleParentError) {
    sendError(res, 409, err.message, { code: 'single_parent' })
    return true
  }
  if (err instanceof TaskboardDuplicateRelationError) {
    sendError(res, 409, err.message, { code: 'duplicate_relation' })
    return true
  }
  if (isTaskboardError(err)) {
    sendError(res, 400, err.message, { code: err.code })
    return true
  }
  return false
}

function resolveDb(ctx: TaskboardHttpContext): TaskboardDb | null {
  if (ctx.db === null) return null
  if (ctx.db) return ctx.db
  try {
    return getTaskboardDb()
  } catch {
    return null
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * `/api/board/*` 分发入口。已处理返回 true;非本前缀返回 false。
 * 未初始化库 → 503 `{ error: "taskboard not initialized" }`。
 */
export async function handleTaskboardApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TaskboardHttpContext = {},
): Promise<boolean> {
  const url = urlOf(req)
  if (url.pathname !== '/api/board' && !url.pathname.startsWith('/api/board/')) {
    return false
  }

  const db = resolveDb(ctx)
  if (!db) {
    sendError(res, 503, 'taskboard not initialized')
    return true
  }
  getSettings(db)

  const actor = resolveActor(req, ctx)
  const method = (req.method ?? 'GET').toUpperCase()

  try {
    await dispatch(req, res, url, method, db, actor, ctx)
  } catch (err) {
    if (mapHttpError(res, err)) return true
    throw err
  }
  return true
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  db: TaskboardDb,
  actor: Actor,
  ctx: TaskboardHttpContext,
): Promise<void> {
  const path = url.pathname

  if (path === '/api/board/projects') {
    if (method === 'GET') return handleListProjects(res, url, db)
    if (method === 'POST') return handleCreateProject(res, await readJsonBody(req), db, actor, ctx)
    return sendError(res, 405, 'method not allowed')
  }

  const projectBoard = path.match(/^\/api\/board\/projects\/([^/]+)\/board$/)
  if (projectBoard) {
    if (method === 'GET')
      return handleProjectBoard(res, url, db, decodeURIComponent(projectBoard[1]))
    return sendError(res, 405, 'method not allowed')
  }

  const projectContextPreview = path.match(/^\/api\/board\/projects\/([^/]+)\/context\/preview$/)
  if (projectContextPreview) {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed')
    return handlePreviewProjectContext(res, db, decodeURIComponent(projectContextPreview[1]))
  }

  const projectContext = path.match(/^\/api\/board\/projects\/([^/]+)\/context$/)
  if (projectContext) {
    const id = decodeURIComponent(projectContext[1])
    if (method === 'GET') return handleGetProjectContext(res, db, id)
    if (method === 'PUT') return handlePutProjectContext(res, await readJsonBody(req), db, id)
    return sendError(res, 405, 'method not allowed')
  }

  if (await dispatchProjectMemory(req, res, url, method, db, actor)) return

  const projectItem = path.match(/^\/api\/board\/projects\/([^/]+)$/)
  if (projectItem) {
    const id = decodeURIComponent(projectItem[1])
    if (method === 'GET') return handleGetProject(res, db, id)
    if (method === 'PATCH') return await handlePatchProject(res, await readJsonBody(req), db, id)
    if (method === 'DELETE') return handleDeleteProject(res, db, id)
    return sendError(res, 405, 'method not allowed')
  }

  if (path === '/api/board/tickets') {
    if (method === 'GET') return handleListTickets(res, url, db)
    if (method === 'POST') return handleCreateTicket(res, await readJsonBody(req), db, actor)
    return sendError(res, 405, 'method not allowed')
  }

  const ticketAction = path.match(/^\/api\/board\/tickets\/([^/]+)\/([^/]+)$/)
  if (ticketAction) {
    const idOrIdent = decodeURIComponent(ticketAction[1])
    const sub = ticketAction[2]
    if ((TICKET_COLLECTIONS as readonly string[]).includes(sub)) {
      return handleTicketCollection(
        req,
        res,
        url,
        method,
        db,
        actor,
        idOrIdent,
        sub as TicketCollection,
      )
    }
    if ((TICKET_ACTIONS as readonly string[]).includes(sub)) {
      if (method !== 'POST') return sendError(res, 405, 'method not allowed')
      return handleTicketAction(
        res,
        await readJsonBody(req),
        db,
        actor,
        idOrIdent,
        sub as TicketAction,
      )
    }
    return sendError(res, 404, 'not found', { code: 'not_found' })
  }

  const ticketItem = path.match(/^\/api\/board\/tickets\/([^/]+)$/)
  if (ticketItem) {
    const idOrIdent = decodeURIComponent(ticketItem[1])
    if (method === 'GET') return handleGetTicket(res, url, db, idOrIdent)
    if (method === 'PATCH') {
      return handlePatchTicket(res, await readJsonBody(req), db, actor, idOrIdent)
    }
    return sendError(res, 405, 'method not allowed')
  }

  if (path === '/api/board/pipelines') {
    if (method === 'GET') return handleListPipelines(res, url, db)
    if (method === 'POST') return handleCreatePipeline(res, await readJsonBody(req), db)
    return sendError(res, 405, 'method not allowed')
  }

  const pipelineStageOrder = path.match(/^\/api\/board\/pipelines\/([^/]+)\/reorder$/)
  if (pipelineStageOrder) {
    const id = decodeURIComponent(pipelineStageOrder[1])
    if (method === 'PUT') return handleReorderStages(res, await readJsonBody(req), db, id, actor)
    return sendError(res, 405, 'method not allowed')
  }

  const pipelineStages = path.match(/^\/api\/board\/pipelines\/([^/]+)\/stages$/)
  if (pipelineStages) {
    const id = decodeURIComponent(pipelineStages[1])
    if (method === 'GET') return handleListStages(res, db, id)
    if (method === 'POST') return handleCreateStage(res, await readJsonBody(req), db, id, actor, ctx)
    return sendError(res, 405, 'method not allowed')
  }

  const pipelineItem = path.match(/^\/api\/board\/pipelines\/([^/]+)$/)
  if (pipelineItem) {
    const id = decodeURIComponent(pipelineItem[1])
    if (method === 'GET') return handleGetPipeline(res, db, id)
    if (method === 'PATCH') return handlePatchPipeline(res, await readJsonBody(req), db, id)
    return sendError(res, 405, 'method not allowed')
  }

  const stageItem = path.match(/^\/api\/board\/stages\/([^/]+)$/)
  if (stageItem) {
    const id = decodeURIComponent(stageItem[1])
    if (method === 'GET') return handleGetStage(res, db, id)
    if (method === 'PATCH') return handlePatchStage(res, await readJsonBody(req), db, id, actor, ctx)
    return sendError(res, 405, 'method not allowed')
  }

  const runContext = path.match(/^\/api\/board\/runs\/([^/]+)\/context$/)
  if (runContext) {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed')
    return handleGetRunContext(res, db, decodeURIComponent(runContext[1]))
  }

  const runItem = path.match(/^\/api\/board\/runs\/([^/]+)$/)
  if (runItem) {
    if (method === 'GET') return handleGetRun(res, db, decodeURIComponent(runItem[1]))
    return sendError(res, 405, 'method not allowed')
  }

  const relationItem = path.match(/^\/api\/board\/relations\/([^/]+)$/)
  if (relationItem) {
    if (method === 'DELETE') {
      removeRelation(db, decodeURIComponent(relationItem[1]))
      return sendJson(res, 200, { ok: true })
    }
    return sendError(res, 405, 'method not allowed')
  }

  if (path === '/api/board/agents') {
    if (method === 'GET') return handleListAgents(res, ctx)
    return sendError(res, 405, 'method not allowed')
  }

  if (path === '/api/board/settings') {
    if (method === 'GET') return handleGetSettings(res, db)
    if (method === 'PATCH') return handlePatchSettings(res, await readJsonBody(req), db, actor)
    return sendError(res, 405, 'method not allowed')
  }

  if (path === '/api/board/stats/cost') {
    if (method === 'GET') return handleCostStats(res, url, db)
    return sendError(res, 405, 'method not allowed')
  }

  if (path === '/api/board/reports/weekly') {
    if (method === 'GET') return handleWeeklyReport(res, url, db)
    return sendError(res, 405, 'method not allowed')
  }

  if (path === '/api/board/templates') {
    if (method === 'GET') return handleListTemplates(res, db)
    if (method === 'POST') return handleCreateTemplate(res, await readJsonBody(req), db)
    return sendError(res, 405, 'method not allowed')
  }

  const templateApply = path.match(/^\/api\/board\/templates\/([^/]+)\/apply$/)
  if (templateApply) {
    if (method === 'POST') {
      return handleApplyTemplate(
        res,
        await readJsonBody(req),
        db,
        decodeURIComponent(templateApply[1]),
        actor,
        ctx,
      )
    }
    return sendError(res, 405, 'method not allowed')
  }

  const templateItem = path.match(/^\/api\/board\/templates\/([^/]+)$/)
  if (templateItem) {
    const id = decodeURIComponent(templateItem[1])
    if (method === 'GET') return handleGetTemplate(res, db, id)
    if (method === 'DELETE') return handleDeleteTemplate(res, db, id)
    return sendError(res, 405, 'method not allowed')
  }

  sendError(res, 404, 'not found', { code: 'not_found' })
}

// ── Project ─────────────────────────────────────────────────────────────────

function handleListProjects(res: ServerResponse, url: URL, db: TaskboardDb): void {
  const includeArchived = url.searchParams.get('includeArchived') === 'true'
  sendJson(res, 200, { items: listProjects(db, { includeArchived }) })
}

async function handleCreateProject(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ctx: TaskboardHttpContext,
): Promise<void> {
  const key = asString(body.key)
  const name = asString(body.name)
  if (!key || !name) throw new TaskboardValidationError('key and name are required')
  const templateIds = asStringArray(body.templateIds)
  if (actor !== 'human' && templateIds !== undefined && templateIds.length > 0) {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return
  }
  if (templateIds?.length) await assertTemplatesValidForApply(db, templateIds, ctx)
  try {
    const created = db.transaction(() => {
      const project = createProject(db, {
        key,
        name,
        description: asNullableString(body.description) ?? null,
        workspace: asNullableString(body.workspace) ?? null,
        workspaceSpec: parseProjectWorkspace(body.workspaceSpec),
        labels: asStringArray(body.labels) ?? [],
      })
      if (templateIds === undefined) {
        seedDefaultPipelines(db, project.id)
      } else if (templateIds.length > 0) {
        applyTemplates(db, project.id, templateIds)
      }
      return project
    })()
    sendJson(res, 201, { ok: true, project: created })
  } catch (err) {
    if (isUniqueConstraint(err, 'tb_project.key') || isUniqueConstraint(err, 'key')) {
      sendError(res, 409, 'project key already exists')
      return
    }
    throw err
  }
}

function handleGetProject(res: ServerResponse, db: TaskboardDb, idOrKey: string): void {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  sendJson(res, 200, { project })
}

async function handlePatchProject(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  idOrKey: string,
): Promise<void> {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  const workspaceSpec =
    body.workspaceSpec === undefined ? undefined : parseProjectWorkspace(body.workspaceSpec)
  if (body.workspaceSpec !== undefined && body.workspaceSpec !== null && !workspaceSpec) {
    throw new TaskboardValidationError('invalid workspaceSpec')
  }
  if (workspaceSpec) {
    const cwd = resolveProjectCwd(workspaceSpec, project.id)
    if (!cwd.ok) {
      throw new TaskboardValidationError(
        `workspaceSpec rejected: ${cwd.error} (${cwd.detail}). 项目数据目录 ~/.openclaude/projects 不能当工作区；仅允许 workspace/ 或 repos/ 下的绝对路径。`,
      )
    }
  }
  const updated = updateProject(db, project.id, {
    name: asString(body.name),
    description: asNullableString(body.description),
    workspace: asNullableString(body.workspace),
    workspaceSpec,
    labels: asStringArray(body.labels),
    archivedAt: asNullableNumber(body.archivedAt),
  })
  if (workspaceSpec !== undefined) {
    const { incrementProjectContextVersion } = await import('@openclaude/storage')
    await incrementProjectContextVersion(project.id).catch(() => {})
  }
  sendJson(res, 200, { ok: true, project: updated })
}

async function handleGetProjectContext(
  res: ServerResponse,
  db: TaskboardDb,
  idOrKey: string,
): Promise<void> {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  sendJson(res, 200, await summarizeProjectContext(project.id, db))
}

async function handlePreviewProjectContext(
  res: ServerResponse,
  db: TaskboardDb,
  idOrKey: string,
): Promise<void> {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  sendJson(res, 200, await previewProjectContext({ boardProjectId: project.id }))
}

async function handleGetRunContext(
  res: ServerResponse,
  db: TaskboardDb,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId)
  if (!run) throw new TaskboardNotFound('run', runId)
  const ticket = getTicketByIdOrIdentifier(db, run.ticketId)
  const projectId = ticket?.projectId ?? null
  let snapshot = null
  if (projectId && (run.contextSnapshotId || run.id)) {
    snapshot =
      (run.contextSnapshotId
        ? await readProjectRunContextFile(projectId, run.contextSnapshotId)
        : null) ?? (await readProjectRunContextFile(projectId, run.id))
  }
  let currentVersion: number | null = null
  if (projectId) {
    try {
      currentVersion = (await loadProjectContext(projectId)).version
    } catch {
      currentVersion = null
    }
  }
  sendJson(res, 200, {
    runId: run.id,
    contextSnapshotId: run.contextSnapshotId ?? null,
    contextSha256: run.contextSha256 ?? null,
    contextVersion: run.contextVersion ?? null,
    currentVersion,
    changed: run.contextVersion != null && currentVersion != null && run.contextVersion !== currentVersion,
    snapshot,
    disclaimer: '仅审计、不可逐字重放',
  })
}

async function handlePutProjectContext(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  idOrKey: string,
): Promise<void> {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  const expectedVersion = asNullableNumber(body.expectedVersion)
  if (expectedVersion == null || !Number.isFinite(expectedVersion)) {
    throw new TaskboardValidationError('expectedVersion is required')
  }
  if (body.instructions !== undefined) {
    const text = body.instructions === null ? null : asString(body.instructions) ?? ''
    const written = await writeProjectInstructions(project.id, text, expectedVersion, {
      key: project.key,
    })
    if (!written.ok) {
      sendError(res, written.error === 'version_conflict' ? 409 : 400, written.error, {
        current: written.current ?? null,
      })
      return
    }
    sendJson(res, 200, { ok: true, context: written.snapshot })
    return
  }
  if (Array.isArray(body.skillNames)) {
    const names = body.skillNames.filter((n): n is string => typeof n === 'string')
    const written = await commitProjectSkillOverlay(project.id, names, expectedVersion, {
      sourceFor: (name) => `${paths.sharedSkillsDir}/${name}`,
    })
    if (!written.ok) {
      sendError(res, written.error === 'version_conflict' ? 409 : 400, written.error, {
        current: written.current ?? null,
      })
      return
    }
    sendJson(res, 200, { ok: true, context: written.snapshot })
    return
  }
  throw new TaskboardValidationError('instructions or skillNames required')
}

function handleDeleteProject(res: ServerResponse, db: TaskboardDb, idOrKey: string): void {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  const archived = archiveProject(db, project.id)
  sendJson(res, 200, { ok: true, project: archived })
}

function handleProjectBoard(res: ServerResponse, url: URL, db: TaskboardDb, idOrKey: string): void {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  const requested = url.searchParams.get('ticketType')
  let ticketType: TicketType
  if (requested) {
    if (!(TICKET_TYPES as readonly string[]).includes(requested)) {
      throw new TaskboardValidationError(`invalid ticketType: ${requested}`)
    }
    ticketType = requested as TicketType
  } else {
    ticketType = pickDefaultTicketType(db, project.id)
  }
  const pipeline = getDefaultPipeline(db, project.id, ticketType)
  if (!pipeline) throw new TaskboardNotFound('pipeline', `${project.id}:${ticketType}`)
  const stages = listStages(db, pipeline.id)
  const listed = listTickets(db, { projectId: project.id, type: ticketType, limit: 200, offset: 0 })
  const ofType = listed.items
  const stageRefs = stages.map(toMoveStageRef)
  const decorate = (ticket: Ticket) => decorateTicketMoves(db, ticket, stageRefs)
  const inbox = ofType.filter((t) => t.status === 'waiting_human').map(decorate)
  const backlogTickets = ofType.filter((t) => t.status === 'backlog').map(decorate)
  sendJson(res, 200, {
    project,
    pipeline,
    ticketType,
    columns: stages.map((stage) => ({
      stage,
      tickets: ofType
        .filter(
          (t) =>
            t.stageId === stage.id &&
            t.status !== 'backlog' &&
            t.status !== 'waiting_human' &&
            t.status !== 'done' &&
            t.status !== 'canceled',
        )
        .map(decorate),
    })),
    inbox,
    backlog: { tickets: backlogTickets },
  })
}

/**
 * 未指定 type 时的选线优先级:
 * 1. 流水线内非终态且非 backlog 票最多的 type（真正在跑的票）
 * 2. 若该项全为 0 → backlog 票最多的 type
 * 3. 仍并列或全为 0 → listPipelines 第一条带 type 的流水线
 * 并列时保留流水线遍历顺序（与旧实现一样用 n > bestN，先出现的赢）。
 */
function pickDefaultTicketType(db: TaskboardDb, projectId: string): TicketType {
  const { inPipeline, backlog } = countTicketsByTypeForBoardDefault(db, projectId)
  const pipes = listPipelines(db, projectId)
  const pickMax = (counts: Record<TicketType, number>): TicketType | null => {
    let best: TicketType | null = null
    let bestN = 0
    for (const pipe of pipes) {
      if (!pipe.ticketType) continue
      const n = counts[pipe.ticketType] ?? 0
      if (n > bestN) {
        best = pipe.ticketType
        bestN = n
      }
    }
    return bestN > 0 ? best : null
  }
  return (
    pickMax(inPipeline) ?? pickMax(backlog) ?? pipes.find((p) => p.ticketType)?.ticketType ?? 'bug'
  )
}

function toMoveStageRef(stage: PipelineStage): MoveStageRef {
  return { id: stage.id, name: stage.name, kind: stage.kind, ordinal: stage.ordinal }
}

function decorateTicketMoves(
  db: TaskboardDb,
  ticket: Ticket,
  stages: readonly MoveStageRef[],
): Ticket & { allowedMoves: AllowedMove[] } {
  return {
    ...ticket,
    allowedMoves: listAllowedMoves({
      status: ticket.status,
      stageId: ticket.stageId,
      pipelineId: ticket.pipelineId,
      stages,
      hasOpenBlockers: hasOpenBlockers(db, ticket.id),
    }),
  }
}

// ── Ticket ──────────────────────────────────────────────────────────────────

function handleListTickets(res: ServerResponse, url: URL, db: TaskboardDb): void {
  let projectId = url.searchParams.get('projectId') ?? undefined
  if (projectId) {
    const project = resolveProject(db, projectId)
    if (!project) throw new TaskboardNotFound('project', projectId)
    projectId = project.id
  }
  const status = parseCsvEnums(url.searchParams.get('status'), TICKET_STATUSES, 'status')
  const type = parseCsvEnums(url.searchParams.get('type'), TICKET_TYPES, 'type')
  const priorityRaw = url.searchParams.get('priority')
  let priority: TicketPriority | undefined
  if (priorityRaw) {
    if (!(TICKET_PRIORITIES as readonly string[]).includes(priorityRaw)) {
      throw new TaskboardValidationError(`invalid priority: ${priorityRaw}`)
    }
    priority = priorityRaw as TicketPriority
  }
  const result = listTickets(db, {
    projectId,
    status,
    type,
    priority,
    assignee: url.searchParams.get('assignee') ?? undefined,
    stageId: url.searchParams.get('stageId') ?? undefined,
    label: url.searchParams.get('label') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    limit: parseLimit(url),
    offset: parseOffset(url),
  })
  sendJson(res, 200, result)
}

function handleCreateTicket(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
): void {
  if ('identifier' in body || 'version' in body || 'id' in body) {
    throw new TaskboardValidationError('identifier / version / id must not be sent')
  }
  const projectRef = asString(body.projectId)
  const title = asString(body.title)
  const typeRaw = asString(body.type)
  if (!projectRef || !title || !typeRaw) {
    throw new TaskboardValidationError('projectId, type and title are required')
  }
  if (!(TICKET_TYPES as readonly string[]).includes(typeRaw)) {
    throw new TaskboardValidationError(`invalid type: ${typeRaw}`)
  }
  const type = typeRaw as TicketType
  const project = resolveProject(db, projectRef)
  if (!project) throw new TaskboardNotFound('project', projectRef)

  let pipelineId = asNullableString(body.pipelineId) ?? null
  let stageId = asNullableString(body.stageId) ?? null
  if (!pipelineId) {
    const pipeline = getDefaultPipeline(db, project.id, type)
    if (pipeline) {
      pipelineId = pipeline.id
      if (!stageId) {
        const first = listStages(db, pipeline.id)[0]
        stageId = first?.id ?? null
      }
    }
  }

  const priorityRaw = asString(body.priority)
  if (priorityRaw && !(TICKET_PRIORITIES as readonly string[]).includes(priorityRaw)) {
    throw new TaskboardValidationError(`invalid priority: ${priorityRaw}`)
  }
  const severityRaw = asNullableString(body.severity)
  if (severityRaw && !(TICKET_SEVERITIES as readonly string[]).includes(severityRaw)) {
    throw new TaskboardValidationError(`invalid severity: ${severityRaw}`)
  }
  const sourceRaw = asString(body.source)
  if (sourceRaw && !(TICKET_SOURCES as readonly string[]).includes(sourceRaw)) {
    throw new TaskboardValidationError(`invalid source: ${sourceRaw}`)
  }

  // 默认 backlog:人没批准 AI 不许碰。显式 status=ready 仅 human 可「直接开工」。
  const statusRaw = asString(body.status)
  let status: TicketStatus | undefined
  if (statusRaw) {
    if (statusRaw !== 'backlog' && statusRaw !== 'ready') {
      throw new TaskboardValidationError('status must be backlog or ready')
    }
    if (statusRaw === 'ready' && actor !== 'human') {
      throw new TaskboardTransitionDenied(
        'actor_denied',
        '直接开工只有人能做，AI 不能把新建单据标为待执行。',
      )
    }
    status = statusRaw
  }

  const ticket = createTicket(db, {
    projectId: project.id,
    type,
    title,
    body: asString(body.body) ?? '',
    status,
    priority: (priorityRaw as TicketPriority | undefined) ?? 'P2',
    severity: (severityRaw as TicketSeverity | null | undefined) ?? null,
    labels: asStringArray(body.labels) ?? [],
    assignee: asNullableString(body.assignee) ?? null,
    reporter: asString(body.reporter) ?? HUMAN_ACTOR_ID,
    source: (sourceRaw as TicketSource | undefined) ?? 'manual',
    originSessionKey: asNullableString(body.originSessionKey) ?? null,
    dueDate: asNullableNumber(body.dueDate) ?? null,
    startDate: asNullableNumber(body.startDate) ?? null,
    pipelineId,
    stageId,
  })
  recordActivity(
    db,
    ticket.id,
    actor,
    actorIdOf(actor),
    'ticket_created',
    'status',
    null,
    ticket.status,
  )
  sendJson(res, 201, { ok: true, ticket })
}

function handleGetTicket(res: ServerResponse, url: URL, db: TaskboardDb, idOrIdent: string): void {
  const ticket = requireTicket(db, idOrIdent)
  const expand = (url.searchParams.get('expand') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const extra: { pipeline?: ReturnType<typeof getPipeline>; stage?: ReturnType<typeof getStage> } =
    {}
  if (expand.includes('pipeline')) {
    extra.pipeline = ticket.pipelineId ? getPipeline(db, ticket.pipelineId) : null
  }
  if (expand.includes('stage')) {
    extra.stage = ticket.stageId ? getStage(db, ticket.stageId) : null
  }
  sendJson(res, 200, { ticket, ...extra })
}

function handlePatchTicket(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  idOrIdent: string,
): void {
  const ticket = requireTicket(db, idOrIdent)
  const expectedVersion = requireExpectedVersion(body)
  const updated = updateTicket(db, ticket.id, expectedVersion, {
    title: asString(body.title),
    body: asString(body.body),
    priority: asString(body.priority) as TicketPriority | undefined,
    severity: asNullableString(body.severity) as TicketSeverity | null | undefined,
    labels: asStringArray(body.labels),
    assignee: asNullableString(body.assignee),
    dueDate: asNullableNumber(body.dueDate),
    startDate: asNullableNumber(body.startDate),
    blockedReason: asNullableString(body.blockedReason),
  })
  recordActivity(db, ticket.id, actor, actorIdOf(actor), 'field_updated')
  sendJson(res, 200, { ok: true, ticket: updated })
}

async function handleTicketCollection(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  db: TaskboardDb,
  actor: Actor,
  idOrIdent: string,
  collection: TicketCollection,
): Promise<void> {
  const ticket = requireTicket(db, idOrIdent)
  if (collection === 'runs') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed')
    const status = parseCsvEnums(
      url.searchParams.get('status'),
      ['queued', 'running', 'succeeded', 'failed', 'timeout', 'skipped'] as const,
      'status',
    )
    const result = listRuns(db, {
      ticketId: ticket.id,
      stageId: url.searchParams.get('stageId') ?? undefined,
      status: status as RunStatus[] | undefined,
      limit: parseLimit(url),
      offset: parseOffset(url),
    })
    return sendJson(res, 200, result)
  }
  if (collection === 'relations') {
    if (method === 'GET') return sendJson(res, 200, { items: listRelations(db, ticket.id) })
    if (method === 'POST') {
      const body = await readJsonBody(req)
      return handleAddRelation(res, body, db, actor, ticket)
    }
    return sendError(res, 405, 'method not allowed')
  }
  if (collection === 'comments') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed')
    return sendJson(res, 200, {
      items: listComments(db, ticket.id, {
        limit: parseLimit(url, 100, 500),
        offset: parseOffset(url),
      }),
    })
  }
  if (collection === 'activity') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed')
    return sendJson(res, 200, {
      items: listActivities(db, ticket.id, {
        limit: parseLimit(url, 100, 500),
        offset: parseOffset(url),
      }),
    })
  }
  if (method !== 'GET') return sendError(res, 405, 'method not allowed')
  return handleTimeline(res, url, db, ticket)
}

function handleAddRelation(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const toRef = asString(body.toTicketId)
  const kindRaw = asString(body.kind)
  if (!toRef || !kindRaw) throw new TaskboardValidationError('toTicketId and kind are required')
  if (!(RELATION_KINDS as readonly string[]).includes(kindRaw)) {
    throw new TaskboardValidationError(`invalid relation kind: ${kindRaw}`)
  }
  const to = requireTicket(db, toRef)
  const relation = addRelation(db, {
    fromTicketId: ticket.id,
    toTicketId: to.id,
    kind: kindRaw as RelationKind,
  })
  recordActivity(
    db,
    ticket.id,
    actor,
    actorIdOf(actor),
    'relation_added',
    'relation',
    null,
    `${kindRaw}:${to.identifier}`,
  )
  sendJson(res, 201, { ok: true, relation })
}

function handleTimeline(res: ServerResponse, url: URL, db: TaskboardDb, ticket: Ticket): void {
  const limit = parseLimit(url, 100, 500)
  const comments = listComments(db, ticket.id, { limit: 500, offset: 0 })
  const activities = listActivities(db, ticket.id, { limit: 500, offset: 0 })
  const runs = listRuns(db, { ticketId: ticket.id, limit: 200, offset: 0 }).items
  type Item =
    | { kind: 'activity'; createdAt: number; activity: (typeof activities)[number] }
    | { kind: 'run'; createdAt: number; run: (typeof runs)[number] }
    | { kind: 'comment'; createdAt: number; comment: (typeof comments)[number] }
  const items: Item[] = [
    ...activities.map((activity) => ({
      kind: 'activity' as const,
      createdAt: activity.createdAt,
      activity,
    })),
    ...runs.map((run) => ({ kind: 'run' as const, createdAt: run.createdAt, run })),
    ...comments.map((comment) => ({
      kind: 'comment' as const,
      createdAt: comment.createdAt,
      comment,
    })),
  ]
  items.sort((a, b) => a.createdAt - b.createdAt || a.kind.localeCompare(b.kind))
  sendJson(res, 200, { items: items.slice(0, limit) })
}

function handleTicketAction(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  idOrIdent: string,
  action: TicketAction,
): void {
  const ticket = requireTicket(db, idOrIdent)
  if (action === 'comment') handleComment(res, body, db, actor, ticket)
  else if (action === 'patrol') handlePatrol(res, body, db, actor, ticket)
  else if (action === 'claim') handleClaim(res, body, db, actor, ticket)
  else if (action === 'ready') handleReady(res, body, db, actor, ticket)
  else if (action === 'advance') handleAdvance(res, body, db, actor, ticket)
  else if (action === 'block') handleBlock(res, body, db, actor, ticket)
  else if (action === 'approve') handleApprove(res, body, db, actor, ticket)
  else if (action === 'reject') handleReject(res, body, db, actor, ticket)
  else if (action === 'done') handleDone(res, body, db, actor, ticket)
  else if (action === 'move') handleMove(res, body, db, actor, ticket)
  else handleCancel(res, body, db, actor, ticket)
}

/**
 * 拖动落库。actor 必须是人;动作由 interpretMove 命名,解析不出就拒。
 * 意图落两处:评论(进 {{comments}}) + tb_ticket_activity。
 */
function handleMove(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  if (actor !== 'human') {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return
  }
  const expectedVersion = requireExpectedVersion(body)
  if (expectedVersion !== ticket.version) {
    throw new TaskboardVersionConflict(ticket.id, expectedVersion, ticket.version)
  }

  const toStageRaw = body.toStageId
  if (toStageRaw !== null && toStageRaw !== undefined && typeof toStageRaw !== 'string') {
    throw new TaskboardValidationError('toStageId must be a string or null')
  }
  const toStageId = toStageRaw === undefined ? null : (toStageRaw as string | null)
  const reason = asString(body.reason) ?? null
  const confirmSkippedStages = asBoolean(body.confirmSkippedStages) ?? false
  const cancelRunningRun = asBoolean(body.cancelRunningRun) ?? false

  if (toStageId) {
    const target = getStage(db, toStageId)
    if (!target) throw new TaskboardNotFound('stage', toStageId)
    if (ticket.pipelineId && target.pipelineId !== ticket.pipelineId) {
      throw new TaskboardMoveDenied(
        422,
        'stage_pipeline_mismatch',
        '目标阶段不属于该单据当前流水线。',
        { toStageId, pipelineId: ticket.pipelineId, stagePipelineId: target.pipelineId },
      )
    }
  }

  if (!ticket.pipelineId) {
    throw new TaskboardMoveDenied(422, 'no_interpretable_intent', '单据未挂流水线,无法解析拖动。', {
      why: 'no_pipeline',
    })
  }
  const stages = listStages(db, ticket.pipelineId).map(toMoveStageRef)
  const parsed = interpretMove({
    status: ticket.status,
    stageId: ticket.stageId,
    pipelineId: ticket.pipelineId,
    toStageId,
    stages,
  })
  if (!parsed.ok) {
    throw new TaskboardMoveDenied(
      422,
      parsed.code,
      parsed.why,
      parsed.detail ?? { why: parsed.why },
    )
  }
  const intent = parsed.intent

  if (intent.action === 'noop') {
    sendJson(res, 200, {
      ticket,
      move: {
        action: 'noop',
        label: intent.label,
        fromStageId: intent.fromStageId,
        toStageId: intent.toStageId,
        skippedStages: [],
        abandonedStage: null,
        commentId: null,
      },
    })
    return
  }

  const activeRun = getActiveLease(db, ticket.id)
  if (ticket.status === 'running' && !cancelRunningRun) {
    throw new TaskboardMoveDenied(
      409,
      'running_run_active',
      '单据正在执行,移动前必须取消当前 run。',
      {
        runId: activeRun?.id ?? null,
      },
    )
  }

  const blockers = listOpenBlockers(db, ticket.id)
  const movingForward = intent.action === 'skip_forward' || intent.action === 'ack_advance'
  if (ticket.status === 'blocked' && blockers.length > 0 && movingForward) {
    throw new TaskboardMoveDenied(
      422,
      'blocked_dependency',
      '存在未解除的阻塞依赖,不能往后续站移动。',
      {
        blockers: blockers.map((b) => ({
          id: b.id,
          identifier: b.identifier,
          title: b.title,
          status: b.status,
        })),
      },
    )
  }

  if (intent.requiresConfirm && !confirmSkippedStages) {
    throw new TaskboardMoveDenied(
      422,
      'confirm_required',
      intent.abandonedStage
        ? '这次拖动会放弃当前站的工作，需要 confirmSkippedStages=true 确认。'
        : '这次拖动会跳过中间站,需要 confirmSkippedStages=true 确认。',
      {
        action: intent.action,
        skippedStages: intent.skippedStages.map((s) => publicStageRef(s)),
        abandonedStage: publicStageRef(intent.abandonedStage),
      },
    )
  }
  if (intent.requiresReason && !reason?.trim()) {
    throw new TaskboardMoveDenied(
      422,
      'reason_required',
      '打回必须填写理由,目标站 agent 要能读到要改什么。',
      {
        action: intent.action,
      },
    )
  }

  const actorId = actorIdOf(actor)
  const fromStage = currentStage(db, ticket)
  const toStage = intent.toStageId ? getStage(db, intent.toStageId) : null
  const result = db.transaction(() => {
    if (ticket.status === 'running' && cancelRunningRun) {
      cancelActiveRunForMove(db, ticket)
    }

    let updated: Ticket
    if (intent.action === 'ack_advance') {
      updated = applyHumanAckAdvance(db, ticket, expectedVersion, actor, actorId)
    } else {
      if (intent.toStatus !== ticket.status) {
        assertTransition({
          from: ticket.status,
          to: intent.toStatus,
          actor,
          autoClose: fromStage?.autoClose,
          stageOnSuccess: fromStage?.onSuccess,
        })
      }
      const nextStageId = intent.action === 'return_to_backlog' ? ticket.stageId : intent.toStageId
      const stageLoopCount = stageLoopCountOnProgress(
        ticket.stageLoopCount,
        ticket.stageId,
        nextStageId,
        intent.toStatus,
      )
      updated = updateTicket(db, ticket.id, expectedVersion, {
        status: intent.toStatus,
        stageId: nextStageId,
        stageLoopCount,
        closedAt:
          ticket.status === 'done' || ticket.status === 'canceled' || intent.toStatus === 'backlog'
            ? null
            : undefined,
        blockedReason: intent.action === 'return_to_backlog' ? null : undefined,
      })
    }

    const comment = createComment(db, {
      ticketId: ticket.id,
      authorKind: 'human',
      author: actorId,
      body: formatMoveComment({
        action: intent.action,
        label: intent.label,
        fromStageName: fromStage?.name ?? null,
        toStageName: toStage?.name ?? null,
        toBacklog: intent.action === 'return_to_backlog',
        reason,
        skippedStages: intent.skippedStages,
        abandonedStage: intent.abandonedStage,
      }),
    })
    createActivity(db, {
      ticketId: ticket.id,
      actor: 'human',
      actorId,
      action: `move:${intent.action}`,
      field: 'stage',
      fromValue: ticket.stageId,
      toValue: intent.toStageId,
    })
    if (intent.action !== 'ack_advance' && updated.status !== ticket.status) {
      recordActivity(
        db,
        ticket.id,
        'human',
        actorId,
        'status_changed',
        'status',
        ticket.status,
        updated.status,
      )
    }
    return { ticket: updated, commentId: comment.id }
  })()

  sendJson(res, 200, {
    ticket: result.ticket,
    move: {
      action: intent.action,
      label: intent.label,
      fromStageId: intent.fromStageId,
      toStageId: intent.toStageId,
      skippedStages: intent.skippedStages.map((s) => publicStageRef(s)),
      abandonedStage: publicStageRef(intent.abandonedStage),
      commentId: result.commentId,
    },
  })
}

/** 与 POST …/approve 非关单路径同一套:下一站 + status=ready。 */
function applyHumanAckAdvance(
  db: TaskboardDb,
  ticket: Ticket,
  expectedVersion: number,
  actor: Actor,
  actorId: string,
): Ticket {
  const stage = currentStage(db, ticket)
  const nxt = stage ? nextStage(db, stage) : null
  assertTransition({
    from: ticket.status,
    to: 'ready',
    actor,
    autoClose: stage?.autoClose,
  })
  const nextStageId = nxt?.id ?? ticket.stageId
  const stageLoopCount = stageLoopCountOnProgress(
    ticket.stageLoopCount,
    ticket.stageId,
    nextStageId,
    'ready',
  )
  const updated = updateTicket(db, ticket.id, expectedVersion, {
    status: 'ready',
    stageId: nextStageId,
    stageLoopCount,
  })
  recordActivity(
    db,
    ticket.id,
    actor,
    actorId,
    nextStageId && nextStageId !== ticket.stageId ? 'stage_advanced' : 'status_changed',
    'status',
    ticket.status,
    'ready',
  )
  return updated
}

function cancelActiveRunForMove(db: TaskboardDb, ticket: Ticket): void {
  const run = getActiveLease(db, ticket.id)
  if (!run) return
  releaseLease(db, run.id)
  const now = Date.now()
  updateRun(db, run.id, {
    status: 'failed',
    error: 'canceled_by_human_move',
    finishedAt: now,
    durationMs: run.startedAt != null ? now - run.startedAt : null,
  })
}

function handleComment(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const text = asString(body.body)
  if (!text || !text.trim()) throw new TaskboardValidationError('comment body is required')
  const authorKind: AuthorKind = actor
  const comment = createComment(db, {
    ticketId: ticket.id,
    authorKind,
    author:
      asString(body.author) ??
      actorIdOf(actor, asString(body.owner), currentStage(db, ticket)?.agentId),
    body: text,
    runId: asNullableString(body.runId) ?? null,
  })
  sendJson(res, 200, { ok: true, comment })
}

function handleReady(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  const stage = currentStage(db, ticket)
  assertTransition({
    from: ticket.status,
    to: 'ready',
    actor,
    autoClose: stage?.autoClose,
    stageOnSuccess: stage?.onSuccess,
  })
  const updated = updateTicket(db, ticket.id, expectedVersion, { status: 'ready' })
  recordActivity(
    db,
    ticket.id,
    actor,
    actorIdOf(actor),
    'status_changed',
    'status',
    ticket.status,
    'ready',
  )
  sendJson(res, 200, { ok: true, ticket: updated })
}

function handleClaim(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  const stage = currentStage(db, ticket)
  if (!stage) throw new TaskboardValidationError('ticket has no stage')
  const owner = asString(body.owner) ?? actorIdOf(actor, null, stage.agentId)
  const held = getActiveLease(db, ticket.id)
  if (held) {
    throw new TaskboardLeaseHeld(ticket.id, held.leaseOwner ?? 'unknown', held.leaseExpiresAt ?? 0)
  }
  assertTransition({
    from: ticket.status,
    to: 'running',
    actor,
    hasLease: true,
    autoClose: stage.autoClose,
  })
  const result = db.transaction(() => {
    const run = acquireLease(db, ticket.id, stage.id, owner, GUARDRAIL_DEFAULTS.leaseTtlMs, {
      agentId: stage.agentId,
      trigger: 'transition',
    })
    const updated = updateTicket(db, ticket.id, expectedVersion, { status: 'running' })
    recordActivity(
      db,
      ticket.id,
      actor,
      owner,
      'status_changed',
      'status',
      ticket.status,
      'running',
    )
    return { run, ticket: updated }
  })()
  sendJson(res, 200, { ok: true, ticket: result.ticket })
}

function finishActiveRun(
  db: TaskboardDb,
  ticket: Ticket,
  body: Record<string, unknown>,
  status: 'succeeded' | 'failed' = 'succeeded',
): void {
  const runId = asString(body.runId)
  const run = runId ? getRun(db, runId) : getActiveLease(db, ticket.id)
  if (!run) return
  const now = Date.now()
  updateRun(db, run.id, {
    status,
    summary: asNullableString(body.summary) ?? run.summary,
    outputMd: asNullableString(body.outputMd) ?? run.outputMd,
    finishedAt: now,
    durationMs: run.startedAt != null ? now - run.startedAt : null,
    leaseOwner: null,
    leaseExpiresAt: null,
  })
}

function handleAdvance(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  const stage = currentStage(db, ticket)
  if (!stage) throw new TaskboardValidationError('ticket has no stage')
  const nxt = stage.onSuccess === 'advance' ? nextStage(db, stage) : null
  let to: TicketStatus
  let nextStageId = ticket.stageId
  if (stage.onSuccess === 'wait_human') {
    to = 'waiting_human'
  } else if (stage.onSuccess === 'stay') {
    to = 'ready'
  } else if (!nxt) {
    to = stage.autoClose ? 'done' : 'waiting_human'
  } else if (nxt.kind !== 'ai') {
    to = 'waiting_human'
    nextStageId = nxt.id
  } else {
    to = 'ready'
    nextStageId = nxt.id
  }
  const stageLoopCount = stageLoopCountOnProgress(
    ticket.stageLoopCount,
    ticket.stageId,
    nextStageId,
    to,
  )
  assertTransition({
    from: ticket.status,
    to,
    actor,
    stageOnSuccess: stage.onSuccess,
    autoClose: stage.autoClose,
  })
  const actorId = actorIdOf(actor, asString(body.owner) ?? asString(body.author), stage.agentId)
  const updated = db.transaction(() => {
    const active = getActiveLease(db, ticket.id)
    const runId = asString(body.runId) ?? active?.id ?? null
    finishActiveRun(db, ticket, body)
    const summary = asString(body.summary) ?? asString(body.outputMd)
    if (summary) {
      createComment(db, {
        ticketId: ticket.id,
        authorKind: actor,
        author: actorId,
        body: summary,
        runId,
      })
    }
    const next = updateTicket(db, ticket.id, expectedVersion, {
      status: to,
      stageId: nextStageId,
      stageLoopCount,
      closedAt: to === 'done' ? Date.now() : undefined,
    })
    recordActivity(
      db,
      ticket.id,
      actor,
      actorId,
      nextStageId && nextStageId !== ticket.stageId ? 'stage_advanced' : 'status_changed',
      'status',
      ticket.status,
      to,
    )
    return next
  })()
  sendJson(res, 200, { ok: true, ticket: updated })
}

function handleBlock(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  const reason = asString(body.reason)
  if (!reason || !reason.trim()) throw new TaskboardValidationError('reason is required')
  const stage = currentStage(db, ticket)
  assertTransition({
    from: ticket.status,
    to: 'blocked',
    actor,
    autoClose: stage?.autoClose,
    stageOnSuccess: stage?.onSuccess,
  })
  const updated = updateTicket(db, ticket.id, expectedVersion, {
    status: 'blocked',
    blockedReason: reason,
  })
  recordActivity(
    db,
    ticket.id,
    actor,
    actorIdOf(actor, asString(body.owner), stage?.agentId),
    'status_changed',
    'status',
    ticket.status,
    'blocked',
  )
  sendJson(res, 200, { ok: true, ticket: updated })
}

function handleApprove(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  const close = asBoolean(body.close) ?? false
  const stage = currentStage(db, ticket)
  const nxt = stage ? nextStage(db, stage) : null
  const isLast = !nxt
  if (close && isLast) {
    assertTransition({
      from: ticket.status,
      to: 'done',
      actor,
      autoClose: stage?.autoClose,
    })
    const updated = updateTicket(db, ticket.id, expectedVersion, {
      status: 'done',
      closedAt: Date.now(),
    })
    recordActivity(
      db,
      ticket.id,
      actor,
      actorIdOf(actor),
      'status_changed',
      'status',
      ticket.status,
      'done',
    )
    sendJson(res, 200, { ok: true, ticket: updated })
    return
  }
  assertTransition({
    from: ticket.status,
    to: 'ready',
    actor,
    autoClose: stage?.autoClose,
  })
  const updated = applyHumanAckAdvance(db, ticket, expectedVersion, actor, actorIdOf(actor))
  sendJson(res, 200, { ok: true, ticket: updated })
}

function handleReject(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  const reason = asString(body.reason)
  if (!reason || !reason.trim()) throw new TaskboardValidationError('reason is required')
  const stage = currentStage(db, ticket)
  assertTransition({
    from: ticket.status,
    to: 'ready',
    actor,
    autoClose: stage?.autoClose,
  })
  let targetStageId = asNullableString(body.targetStageId) ?? null
  if (!targetStageId && stage) {
    targetStageId = previousAiStage(db, stage)?.id ?? ticket.stageId
  }
  if (targetStageId) {
    const target = getStage(db, targetStageId)
    if (!target) throw new TaskboardNotFound('stage', targetStageId)
    if (stage && target.pipelineId !== stage.pipelineId) {
      throw new TaskboardValidationError('targetStageId is not on the current pipeline')
    }
  }
  const updated = updateTicket(db, ticket.id, expectedVersion, {
    status: 'ready',
    stageId: targetStageId,
    blockedReason: null,
  })
  createComment(db, {
    ticketId: ticket.id,
    authorKind: actor,
    author: actorIdOf(actor),
    body: reason,
  })
  recordActivity(
    db,
    ticket.id,
    actor,
    actorIdOf(actor),
    'status_changed',
    'status',
    ticket.status,
    'ready',
  )
  sendJson(res, 200, { ok: true, ticket: updated })
}

function handleDone(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  const stage = currentStage(db, ticket)
  assertTransition({
    from: ticket.status,
    to: 'done',
    actor,
    autoClose: stage?.autoClose ?? false,
  })
  const updated = updateTicket(db, ticket.id, expectedVersion, {
    status: 'done',
    closedAt: Date.now(),
  })
  recordActivity(
    db,
    ticket.id,
    actor,
    actorIdOf(actor),
    'status_changed',
    'status',
    ticket.status,
    'done',
  )
  sendJson(res, 200, { ok: true, ticket: updated })
}

function handleCancel(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  const stage = currentStage(db, ticket)
  assertTransition({
    from: ticket.status,
    to: 'canceled',
    actor,
    autoClose: stage?.autoClose,
  })
  const reason = asNullableString(body.reason)
  const updated = updateTicket(db, ticket.id, expectedVersion, {
    status: 'canceled',
    closedAt: Date.now(),
    blockedReason: reason === undefined ? ticket.blockedReason : reason,
  })
  recordActivity(
    db,
    ticket.id,
    actor,
    actorIdOf(actor),
    'status_changed',
    'status',
    ticket.status,
    'canceled',
  )
  sendJson(res, 200, { ok: true, ticket: updated })
}

function handlePatrol(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
): void {
  const expectedVersion = requireExpectedVersion(body)
  if (ticket.version !== expectedVersion) {
    throw new TaskboardVersionConflict(ticket.id, expectedVersion, ticket.version)
  }
  const settings = getSettings(db)
  if (settings.patrolPaused) {
    throw new TaskboardValidationError('patrol is paused')
  }
  const stageRef = asNullableString(body.stageId) ?? ticket.stageId
  if (!stageRef) throw new TaskboardValidationError('ticket has no stage')
  const stage = getStage(db, stageRef)
  if (!stage) throw new TaskboardNotFound('stage', stageRef)
  if (stage.kind !== 'ai') throw new TaskboardValidationError('stage is not an ai stage')

  const usage = getUsage(db)
  const slots = getSharedPatrolSlots()
  slots.setLimit(settings.maxConcurrentRuns)
  if (
    usage.activeRuns >= settings.maxConcurrentRuns ||
    slots.getActive() >= settings.maxConcurrentRuns
  ) {
    insertRun(db, {
      ticketId: ticket.id,
      stageId: stage.id,
      agentId: stage.agentId,
      trigger: 'manual',
      status: 'skipped',
      skipReason: 'concurrency_full',
    })
    sendError(res, 429, 'taskboard concurrency full', { code: 'concurrency_full' })
    return
  }

  // 从 ready 认领;已经 running 则只会被 lease 挡住(423)。
  if (ticket.status !== 'running') {
    assertTransition({
      from: ticket.status,
      to: 'running',
      actor,
      hasLease: true,
      autoClose: stage.autoClose,
    })
  }

  const owner = actorIdOf(actor, asString(body.owner), stage.agentId)
  const result = db.transaction(() => {
    const run = acquireLease(db, ticket.id, stage.id, owner, GUARDRAIL_DEFAULTS.leaseTtlMs, {
      agentId: stage.agentId,
      trigger: 'manual',
    })
    const agentId = run.agentId ?? stage.agentId ?? 'unknown'
    const sessionKey = buildPatrolSessionKey(agentId, ticket.id, stage.id, run.id)
    const withKey = updateRun(db, run.id, { sessionKey })
    const updated =
      ticket.status === 'running'
        ? ticket
        : updateTicket(db, ticket.id, expectedVersion, { status: 'running' })
    if (updated.status === 'running' && ticket.status !== 'running') {
      recordActivity(
        db,
        ticket.id,
        actor,
        owner,
        'status_changed',
        'status',
        ticket.status,
        'running',
      )
    }
    return { run: withKey, ticket: updated }
  })()

  enqueuePatrolExecution({
    ticketId: result.ticket.id,
    runId: result.run.id,
    stageId: stage.id,
    agentId: result.run.agentId,
    trigger: 'manual',
    sessionKey: result.run.sessionKey ?? '',
  })
  sendJson(res, 202, { ok: true, run: result.run, ticket: result.ticket })
}

// ── Pipeline / Stage ────────────────────────────────────────────────────────

function handleListPipelines(res: ServerResponse, url: URL, db: TaskboardDb): void {
  const projectRef = url.searchParams.get('projectId')
  if (!projectRef) throw new TaskboardValidationError('projectId is required')
  const project = resolveProject(db, projectRef)
  if (!project) throw new TaskboardNotFound('project', projectRef)
  sendJson(res, 200, { items: listPipelines(db, project.id) })
}

function handleCreatePipeline(
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

function handleGetPipeline(res: ServerResponse, db: TaskboardDb, id: string): void {
  const pipeline = getPipeline(db, id)
  if (!pipeline) throw new TaskboardNotFound('pipeline', id)
  sendJson(res, 200, { pipeline, stages: listStages(db, pipeline.id) })
}

function handlePatchPipeline(
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

function handleListStages(res: ServerResponse, db: TaskboardDb, pipelineId: string): void {
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

async function assertTemplatesValidForApply(
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

async function handleCreateStage(
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

function handleGetStage(res: ServerResponse, db: TaskboardDb, id: string): void {
  const stage = getStage(db, id)
  if (!stage) throw new TaskboardNotFound('stage', id)
  sendJson(res, 200, { stage })
}

function handleReorderStages(
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

async function handlePatchStage(
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

function handleGetRun(res: ServerResponse, db: TaskboardDb, id: string): void {
  const run = getRun(db, id)
  if (!run) throw new TaskboardNotFound('run', id)
  sendJson(res, 200, { run })
}

// ── Agents / Settings ───────────────────────────────────────────────────────

async function handleListAgents(res: ServerResponse, ctx: TaskboardHttpContext): Promise<void> {
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

function handleGetSettings(res: ServerResponse, db: TaskboardDb): void {
  sendJson(res, 200, { ...getSettings(db), usage: getUsage(db) })
}

function handlePatchSettings(
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
  sendJson(res, 200, { ok: true, ...settings, usage: getUsage(db) })
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

function handleCostStats(res: ServerResponse, url: URL, db: TaskboardDb): void {
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

function handleWeeklyReport(res: ServerResponse, url: URL, db: TaskboardDb): void {
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

function handleListTemplates(res: ServerResponse, db: TaskboardDb): void {
  sendJson(res, 200, { items: listTemplates(db) })
}

function handleGetTemplate(res: ServerResponse, db: TaskboardDb, id: string): void {
  const template = getTemplate(db, id)
  if (!template) throw new TaskboardNotFound('template', id)
  sendJson(res, 200, { template })
}

function handleCreateTemplate(
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

function handleDeleteTemplate(res: ServerResponse, db: TaskboardDb, id: string): void {
  deleteTemplate(db, id)
  sendJson(res, 200, { ok: true })
}

async function handleApplyTemplate(
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
  await assertTemplatesValidForApply(db, [templateId], ctx)
  const projectRef = asString(body.projectId)
  if (!projectRef) throw new TaskboardValidationError('projectId is required')
  const project = resolveProject(db, projectRef)
  if (!project) throw new TaskboardNotFound('project', projectRef)
  const asDefault = asBoolean(body.asDefault)
  const result = applyTemplate(db, templateId, project.id, {
    asDefault,
  })
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
