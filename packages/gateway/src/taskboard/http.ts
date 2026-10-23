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
  parseBoardProjectId,
  parseProjectWorkspace,
  paths,
  readProjectRunContextFile,
  resolveProjectCwd,
  writeProjectInstructions,
} from '@openclaude/storage'
import { verifyJwt } from '../auth.js'
import { ModelCatalogUnavailableError } from '../modelCatalogClient.js'
import { previewProjectContext, summarizeProjectContext } from '../projectContextPreview.js'
import { createActivity, listActivities } from './db/activity.js'
import { createComment, listComments } from './db/comments.js'
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
  getDefaultPipeline,
  getPipeline,
  getStage,
  listPipelines,
  listStages,
} from './db/pipelines.js'
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  updateProject,
} from './db/projects.js'
import { addRelation, listRelations, removeRelation } from './db/relations.js'
import {
  acquireLease,
  getActiveLease,
  getLatestRunMetadata,
  getRun,
  insertRun,
  listRuns,
  updateRun,
} from './db/runs.js'
import { assertTaskboardStagesRunnable, TaskboardPreflightError } from './stagePreflight.js'
import { hasPendingTaskboardExecution } from './executionState.js'
import { listBuiltinPipelineTemplates, seedDefaultPipelines } from './db/seed.js'
import {
  type TaskboardSettings,
  type TaskboardUsage,
  getSettings,
  getUsage,
} from './db/settings.js'
import {
  applyTemplates,
} from './db/templates.js'
import {
  countTicketsByTypeForBoardDefault,
  createTicket,
  getTicketByIdOrIdentifier,
  listTickets,
  updateTicket,
} from './db/tickets.js'
import {
  TICKET_STATUS_LABEL,
  type Actor,
  type AuthorKind,
  alignedLeaseTtlMs,
  type PipelineStage,
  RELATION_KINDS,
  type RelationKind,
  type RunStatus,
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
import {
  listProjectWorkspaceDir,
  openProjectWorkspaceFile,
  resolveProjectWorkspaceRoot,
} from './projectWorkspaceFiles.js'
import { getSharedPatrolSlots, stageLoopCountOnProgress } from './guardrails.js'
import {
  type AllowedMove,
  type MoveStageRef,
  formatMoveComment,
  interpretMove,
  listAllowedMoves,
  publicStageRef,
} from './moveIntent.js'
import { hasOpenBlockers, listOpenBlockers } from './patrol.js'
import { taskboardRunControls } from './runControl.js'
import { dispatchProjectMemory } from './projectMemoryHttp.js'
import { TaskboardTransitionDenied, assertTransition } from './stateMachine.js'
import {
  type BoardAgent,
  type TaskboardHttpContext,
  enrichTaskboardRuns,
  sendJson,
  sendError,
  asString,
  asNullableString,
  asNullableNumber,
  asBoolean,
  asStringArray,
  isUniqueConstraint,
  resolveProject,
} from './httpShared.js'
import {
  handleListPipelines,
  handleCreatePipeline,
  handleGetPipeline,
  handlePatchPipeline,
  handleListStages,
  assertTemplatesValidForApply,
  TaskboardTemplateChangedError,
  handleCreateStage,
  handleGetStage,
  handleReorderStages,
  handlePatchStage,
  handleGetRun,
} from './httpPipelines.js'
import {
  handleListAgents,
  handleGetSettings,
  handlePatchSettings,
  handleCostStats,
  handleWeeklyReport,
  handleListTemplates,
  handleGetTemplate,
  handleCreateTemplate,
  handleDeleteTemplate,
  handleApplyTemplate,
} from './httpBoardAdmin.js'
export type { BoardAgent, TaskboardHttpContext } from './httpShared.js'

export type { TaskboardSettings, TaskboardUsage }

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 与 commercial `containerApiProxy` body 上限对齐,超限 413 而不是崩。 */
export const TASKBOARD_MAX_BODY_BYTES = 512 * 1024

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
  'stop',
  'move',
] as const
type TicketAction = (typeof TICKET_ACTIONS)[number]

const TICKET_COLLECTIONS = ['runs', 'relations', 'comments', 'activity', 'timeline'] as const
type TicketCollection = (typeof TICKET_COLLECTIONS)[number]

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
 * 被判成 human,从而给自己的单据点「完成」—— 正好击穿本系统
 * 「done 永远不属于 AI」的红线。积压批准(backlog→ready)对 agent 是合法的显式动作。
 * 真正的校验在 server.ts `checkBridgeBypass()`:
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

// OCV5-414:agent 关单 / 受阻的审计。一条 activity(action=close_audit|block_audit,
// to_value 为 JSON:谁、从哪个状态、理由、证据)+ 一条同作者的可见评论,与状态变更同一事务。
const AUDIT_REASON_MAX = 2000
const AUDIT_EVIDENCE_MAX = 4000

function auditText(v: unknown, field: string, max: number): string | null {
  const text = asString(v)?.trim()
  if (!text) return null
  if (text.length > max) throw new TaskboardValidationError(`${field} 超过 ${max} 字符`)
  return text
}

// 审计身份:actor(human/agent/system)由服务端鉴权决定,可信;agent 的具体 id 服务端拿不到
// 可信来源(token 不带 agentId),只能记「自报」并标明来源。agent 自报 user:* 一律拒绝,
// 不能在审计里冒充人(OCV5-414 review r1)。
type AuditIdentitySource = 'server_human' | 'client_owner' | 'stage_agent' | 'process_env' | 'unidentified' | 'system'
interface AuditIdentity {
  actorId: string
  source: AuditIdentitySource
  claimedOwner: string | null
}

function auditIdentity(actor: Actor, body: Record<string, unknown>, stageAgentId?: string | null): AuditIdentity {
  const claimed = asString(body.owner)?.trim() || null
  if (actor === 'human') return { actorId: HUMAN_ACTOR_ID, source: 'server_human', claimedOwner: claimed }
  if (actor === 'system') return { actorId: 'system', source: 'system', claimedOwner: claimed }
  if (claimed && !claimed.startsWith('agent:') && claimed.includes(':')) {
    throw new TaskboardValidationError('agent 只能以 agent:<id> 署名,不能用 user:* 等其他身份')
  }
  const actorId = actorIdOf(actor, claimed, stageAgentId)
  const source: AuditIdentitySource = claimed
    ? 'client_owner'
    : stageAgentId?.trim()
      ? 'stage_agent'
      : actorId === 'agent:unidentified'
        ? 'unidentified'
        : 'process_env'
  return { actorId, source, claimedOwner: claimed }
}

function recordAudit(
  db: TaskboardDb,
  ticket: Ticket,
  actor: Actor,
  who: AuditIdentity,
  action: 'close_audit' | 'block_audit',
  to: 'done' | 'blocked',
  reason: string | null,
  evidence: string | null,
): void {
  const actorId = who.actorId
  const payload = {
    actor,
    actorId,
    identitySource: who.source,
    from: ticket.status,
    to,
    reason,
    evidence,
  }
  createActivity(db, {
    ticketId: ticket.id,
    actor,
    actorId,
    action,
    field: 'audit',
    fromValue: ticket.status,
    toValue: JSON.stringify(payload),
  })
  const title = to === 'done' ? '关单' : '标记受阻'
  createComment(db, {
    ticketId: ticket.id,
    authorKind: actor,
    author: actorId,
    body: [
      `**${title}（${actor}${actor === 'agent' ? `，${who.source === 'client_owner' ? '自报身份' : '身份'} ${actorId}` : ` ${actorId}`}）**：${TICKET_STATUS_LABEL[ticket.status]} → ${TICKET_STATUS_LABEL[to]}`,
      `- 理由：${reason ?? '（未填）'}`,
      `- 证据：${evidence ?? '（未填）'}`,
    ].join('\n'),
  })
}

function mapHttpError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof TaskboardTemplateChangedError) { sendError(res, 409, err.message, { code: 'template_configuration_changed' }); return true }
  if (err instanceof TaskboardPreflightError) { sendError(res, err.issue.status, err.message, { code: err.issue.code }); return true }
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

  // Any project-scoped call on a reserved-but-not-yet-created board (settings,
  // context, memory, board view) creates it first, the same way a turn does.
  // Only a board the master knows as a chat project's is created.
  const projectScoped = path.match(/^\/api\/board\/projects\/([^/]+)(?:\/|$)/)
  if (projectScoped) {
    const scopedId = parseBoardProjectId(decodeURIComponent(projectScoped[1]))
    if ('present' in scopedId && scopedId.present && scopedId.value && !getProject(db, scopedId.value)) {
      const { resolveTurnProjectContext } = await import('../projectContextRuntime.js')
      await resolveTurnProjectContext({ boardProjectId: scopedId.value }).catch(() => null)
    }
  }

  const projectBoard = path.match(/^\/api\/board\/projects\/([^/]+)\/board$/)
  if (projectBoard) {
    if (method === 'GET')
      return handleProjectBoard(res, url, db, decodeURIComponent(projectBoard[1]))
    return sendError(res, 405, 'method not allowed')
  }

  // A chat project reserved this work-project id on the master; create the board
  // here on first use. Name and template come from the master, never the client.
  const projectEnsure = path.match(/^\/api\/board\/projects\/([^/]+)\/ensure$/)
  if (projectEnsure) {
    if (method !== 'POST') return sendError(res, 405, 'method not allowed')
    const id = parseBoardProjectId(decodeURIComponent(projectEnsure[1]))
    if (!('present' in id) || !id.present || !id.value) return sendError(res, 400, 'invalid project id')
    const { resolveTurnProjectContext } = await import('../projectContextRuntime.js')
    await resolveTurnProjectContext({ boardProjectId: id.value })
    const project = getProject(db, id.value)
    if (!project) throw new TaskboardNotFound('project', id.value)
    return sendJson(res, 200, { project })
  }

  // Read-only view of the project's folder (项目主页 → 文件 → 项目文件夹).
  // Two literal routes (not one optional group) so serverRouteWiring.test.ts can match each against server.ts.
  const projectWorkspaceFile = path.match(/^\/api\/board\/projects\/([^/]+)\/workspace\/file$/)
  const projectWorkspace = projectWorkspaceFile ?? path.match(/^\/api\/board\/projects\/([^/]+)\/workspace$/)
  if (projectWorkspace) {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed')
    return handleProjectWorkspace(res, url, db, decodeURIComponent(projectWorkspace[1]), projectWorkspaceFile !== null)
  }

  const projectContextPreview = path.match(/^\/api\/board\/projects\/([^/]+)\/context\/preview$/)
  if (projectContextPreview) {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed')
    return handlePreviewProjectContext(
      res,
      db,
      decodeURIComponent(projectContextPreview[1]),
      url.searchParams.get('agentId'),
    )
  }

  const projectContext = path.match(/^\/api\/board\/projects\/([^/]+)\/context$/)
  if (projectContext) {
    const id = decodeURIComponent(projectContext[1])
    if (method === 'GET') return handleGetProjectContext(res, db, id)
    if (method === 'PUT')
      return handlePutProjectContext(res, await readJsonBody(req), db, actor, id)
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
        ctx,
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
        ctx,
      )
    }
    return sendError(res, 404, 'not found', { code: 'not_found' })
  }

  const ticketItem = path.match(/^\/api\/board\/tickets\/([^/]+)$/)
  if (ticketItem) {
    const idOrIdent = decodeURIComponent(ticketItem[1])
    if (method === 'GET') return handleGetTicket(res, url, db, idOrIdent, ctx)
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
    if (method === 'POST')
      return handleCreateStage(res, await readJsonBody(req), db, id, actor, ctx)
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
    if (method === 'PATCH')
      return handlePatchStage(res, await readJsonBody(req), db, id, actor, ctx)
    return sendError(res, 405, 'method not allowed')
  }

  const runContext = path.match(/^\/api\/board\/runs\/([^/]+)\/context$/)
  if (runContext) {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed')
    return handleGetRunContext(res, db, decodeURIComponent(runContext[1]))
  }

  const runItem = path.match(/^\/api\/board\/runs\/([^/]+)$/)
  if (runItem) {
    if (method === 'GET') return handleGetRun(res, db, decodeURIComponent(runItem[1]), ctx)
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
  const executionAgentId = asNullableString(body.executionAgentId)?.trim() || null
  if (actor !== 'human' && (Object.hasOwn(body, 'executionAgentId') || (templateIds !== undefined && templateIds.length > 0))) {
    sendError(res, 403, 'forbidden', { code: 'forbidden' })
    return
  }
  const options = { executionAgentId }
  const selectedTemplates = templateIds ?? listBuiltinPipelineTemplates().map((template) => template.id)
  const validated = actor === 'human' && selectedTemplates.length > 0
    ? await assertTemplatesValidForApply(db, selectedTemplates, ctx, options) : null
  try {
    const created = db.transaction(() => {
      validated?.assertUnchanged()
      const project = createProject(db, {
        key,
        name,
        description: asNullableString(body.description) ?? null,
        workspace: asNullableString(body.workspace) ?? null,
        workspaceSpec: parseProjectWorkspace(body.workspaceSpec),
        labels: asStringArray(body.labels) ?? [],
      })
      if (templateIds === undefined) {
        seedDefaultPipelines(db, project.id, undefined, options)
      } else if (templateIds.length > 0) {
        applyTemplates(db, project.id, validated?.templateIds ?? templateIds, options)
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

const WORKSPACE_ERROR_STATUS: Record<string, number> = {
  no_workspace: 404,
  invalid_path: 400,
  not_found: 404,
  not_directory: 400,
  not_file: 400,
  too_large: 413,
}

async function handleProjectWorkspace(
  res: ServerResponse,
  url: URL,
  db: TaskboardDb,
  idOrKey: string,
  file: boolean,
): Promise<void> {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  const root = resolveProjectWorkspaceRoot(project)
  if (!root.ok) return sendError(res, 404, root.error)
  const rel = url.searchParams.get('path') ?? ''
  if (!file) {
    const listed = await listProjectWorkspaceDir(root.root, rel)
    if (!listed.ok) return sendError(res, WORKSPACE_ERROR_STATUS[listed.error] ?? 400, listed.error)
    return sendJson(res, 200, { kind: root.kind, shared: root.kind === 'default', ...listed })
  }
  const opened = await openProjectWorkspaceFile(root.root, rel)
  if (!opened.ok) return sendError(res, WORKSPACE_ERROR_STATUS[opened.error] ?? 400, opened.error)
  // Always a download, never rendered in the app origin.
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(opened.size),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  if (opened.size === 0) {
    await opened.handle.close().catch(() => {})
    res.end()
    return
  }
  // Stream from the descriptor that was checked, not from the path again.
  const stream = opened.handle.createReadStream({ end: opened.size - 1 })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
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
  agentId?: string | null,
): Promise<void> {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  sendJson(
    res,
    200,
    await previewProjectContext({
      boardProjectId: project.id,
      agentId: agentId && /^[A-Za-z0-9_-]{1,64}$/.test(agentId) ? agentId : undefined,
    }),
  )
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
    changed:
      run.contextVersion != null && currentVersion != null && run.contextVersion !== currentVersion,
    snapshot,
    disclaimer: '仅审计、不可逐字重放',
  })
}

async function handlePutProjectContext(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  idOrKey: string,
): Promise<void> {
  const project = resolveProject(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  const expectedVersion = asNullableNumber(body.expectedVersion)
  if (expectedVersion == null || !Number.isFinite(expectedVersion)) {
    throw new TaskboardValidationError('expectedVersion is required')
  }
  if (body.instructions !== undefined) {
    const text = body.instructions === null ? null : (asString(body.instructions) ?? '')
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
    if (actor !== 'human') {
      sendError(res, 403, 'human approval required', { code: 'human_required' })
      return
    }
    const names = body.skillNames.filter((n): n is string => typeof n === 'string')
    const written = await commitProjectSkillOverlay(project.id, names, expectedVersion, {
      sourceFor: (name) => `${paths.sharedSkillsDir}/${name}`,
      db,
      actor: 'user:default',
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

async function handleGetTicket(res: ServerResponse, url: URL, db: TaskboardDb, idOrIdent: string, ctx: TaskboardHttpContext): Promise<void> {
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
  if (expand.includes('execution')) {
    const run = getActiveLease(db, ticket.id) ?? getLatestRunMetadata(db, ticket.id)
    const execution = run ? { ...(await enrichTaskboardRuns(ctx, [run]))[0], outputMd: null, summary: null } : null
    sendJson(res, 200, { ticket, ...extra, execution })
    return
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
  ctx: TaskboardHttpContext,
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
    return sendJson(res, 200, { ...result, items: await enrichTaskboardRuns(ctx, result.items) })
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
  return handleTimeline(res, url, db, ticket, ctx)
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

async function handleTimeline(res: ServerResponse, url: URL, db: TaskboardDb, ticket: Ticket, ctx: TaskboardHttpContext): Promise<void> {
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
  const window = items.slice(0, limit)
  const enriched = await enrichTaskboardRuns(ctx, window.flatMap((item) => item.kind === 'run' ? [item.run] : []))
  const byId = new Map(enriched.map((run) => [run.id, run]))
  sendJson(res, 200, { items: window.map((item) => item.kind === 'run' ? { ...item, run: byId.get(item.run.id) ?? item.run } : item) })
}

async function handleTicketAction(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  idOrIdent: string,
  action: TicketAction,
  ctx: TaskboardHttpContext,
): Promise<void> {
  const ticket = requireTicket(db, idOrIdent)
  const activeExecution = getActiveLease(db, ticket.id)
  const control = activeExecution?.leaseOwner ? taskboardRunControls.get(activeExecution.id, ticket.id, activeExecution.leaseOwner) : undefined
  const runningControl = control ?? taskboardRunControls.getActiveForTicket(ticket.id)
  if (actor !== 'human' && action !== 'comment' && runningControl?.signal.aborted) return sendError(res, 409, '本次执行已停止', { code: 'USER_CANCELLED' })
  if (actor === 'human' && !['comment', 'patrol', 'stop', 'move'].includes(action) && hasPendingTaskboardExecution(db, ticket.id)) {
    return sendError(res, 409, '请先停止本次执行，收尾完成后再操作', { code: 'active_execution' })
  }
  if (action === 'comment') handleComment(res, body, db, actor, ticket)
  else if (action === 'patrol') await handlePatrol(res, body, db, actor, ticket, ctx)
  else if (action === 'stop') handleStop(res, body, db, actor, ticket)
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
  if (!getActiveLease(db, ticket.id) && hasPendingTaskboardExecution(db, ticket.id)) {
    sendError(res, 409, '上一轮执行仍在收尾，请稍后重试', { code: 'active_execution' })
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
  if (activeRun && !cancelRunningRun) {
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

  if (activeRun && cancelRunningRun) {
    const stopped = requestHumanRunStop(db, ticket.id, expectedVersion, activeRun.id)
    if (stopped.kind === 'conflict') throw new TaskboardMoveDenied(409, stopped.code, stopped.message)
    if (stopped.kind === 'requested') stopped.control.requestStop()
    if (stopped.kind !== 'terminal') throw new TaskboardMoveDenied(409, 'stop_pending', '已请求停止本次执行，收尾完成后请再次移动任务。', { ticket: stopped.ticket, runId: activeRun.id })
  }
  const actorId = actorIdOf(actor)
  const fromStage = currentStage(db, ticket)
  const toStage = intent.toStageId ? getStage(db, intent.toStageId) : null
  const result = db.transaction(() => {

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
      const approving = ticket.status === 'backlog' && intent.toStatus === 'ready'
      const returning = intent.toStatus === 'backlog'
      updated = updateTicket(db, ticket.id, expectedVersion, {
        status: intent.toStatus,
        stageId: nextStageId,
        stageLoopCount,
        closedAt:
          ticket.status === 'done' || ticket.status === 'canceled' || intent.toStatus === 'backlog'
            ? null
            : undefined,
        blockedReason: intent.action === 'return_to_backlog' ? null : undefined,
        approvedBy: approving ? actorId : returning ? null : undefined,
        approvedAt: approving ? Date.now() : returning ? null : undefined,
      })
      if (approving) {
        recordActivity(
          db,
          ticket.id,
          actor,
          actorId,
          'ticket_approved',
          'status',
          ticket.status,
          'ready',
        )
      }
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

/**
 * 积压批准:backlog→ready,留在当前站(缺 stage 则补流水线第一站)。
 * 人与 agent 都可走;system 被状态机拦住。必须带 expectedVersion。
 */
function applyBacklogApproval(
  db: TaskboardDb,
  ticket: Ticket,
  expectedVersion: number,
  actor: Actor,
  actorId: string,
): Ticket {
  assertTransition({
    from: ticket.status,
    to: 'ready',
    actor,
  })
  let nextStageId = ticket.stageId
  if (!nextStageId && ticket.pipelineId) {
    nextStageId = listStages(db, ticket.pipelineId)[0]?.id ?? null
  }
  const now = Date.now()
  return db.transaction(() => {
    const updated = updateTicket(db, ticket.id, expectedVersion, {
      status: 'ready',
      stageId: nextStageId,
      approvedBy: actorId,
      approvedAt: now,
    })
    recordActivity(
      db,
      ticket.id,
      actor,
      actorId,
      'ticket_approved',
      'status',
      ticket.status,
      'ready',
    )
    return updated
  })()
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
  const actorId = actorIdOf(actor, asString(body.owner) ?? asString(body.author))
  const updated = db.transaction(() => {
    const current = requireTicket(db, ticket.id)
    if (current.version !== expectedVersion) throw new TaskboardVersionConflict(ticket.id, expectedVersion, current.version)
    if (hasPendingTaskboardExecution(db, ticket.id)) return null
    if (current.status === 'backlog') return applyBacklogApproval(db, current, expectedVersion, actor, actorId)
    const stage = currentStage(db, current)
    assertTransition({ from: current.status, to: 'ready', actor, autoClose: stage?.autoClose, stageOnSuccess: stage?.onSuccess })
    const result = updateTicket(db, current.id, expectedVersion, { status: 'ready' })
    recordActivity(db, current.id, actor, actorId, 'status_changed', 'status', current.status, 'ready')
    return result
  }).immediate()
  if (!updated) {
    sendError(res, 409, '上一轮执行仍在收尾，请稍后重试', { code: 'active_execution' })
    return
  }
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
    const run = acquireLease(db, ticket.id, stage.id, owner, alignedLeaseTtlMs(stage.timeoutSec), {
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
  const reason = auditText(body.reason, 'reason', AUDIT_REASON_MAX)
  if (!reason) throw new TaskboardValidationError('reason is required')
  const evidence = auditText(body.evidence, 'evidence', AUDIT_EVIDENCE_MAX)
  const stage = currentStage(db, ticket)
  assertTransition({
    from: ticket.status,
    to: 'blocked',
    actor,
    autoClose: stage?.autoClose,
    stageOnSuccess: stage?.onSuccess,
    audit: { reason, evidence },
  })
  const who = auditIdentity(actor, body, stage?.agentId)
  const actorId = who.actorId
  const updated = db.transaction(() => {
    const next = updateTicket(db, ticket.id, expectedVersion, {
      status: 'blocked',
      blockedReason: reason,
    })
    recordActivity(db, ticket.id, actor, actorId, 'status_changed', 'status', ticket.status, 'blocked')
    if (actor !== 'human') {
      recordAudit(db, ticket, actor, who, 'block_audit', 'blocked', reason, evidence)
    }
    return next
  })()
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
  const actorId = actorIdOf(
    actor,
    asString(body.owner) ?? asString(body.author),
    currentStage(db, ticket)?.agentId,
  )
  if (ticket.status === 'backlog') {
    const updated = applyBacklogApproval(db, ticket, expectedVersion, actor, actorId)
    sendJson(res, 200, { ok: true, ticket: updated })
    return
  }
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
    recordActivity(db, ticket.id, actor, actorId, 'status_changed', 'status', ticket.status, 'done')
    sendJson(res, 200, { ok: true, ticket: updated })
    return
  }
  assertTransition({
    from: ticket.status,
    to: 'ready',
    actor,
    autoClose: stage?.autoClose,
  })
  const updated = applyHumanAckAdvance(db, ticket, expectedVersion, actor, actorId)
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
  const reason = auditText(body.reason, 'reason', AUDIT_REASON_MAX)
  const evidence = auditText(body.evidence, 'evidence', AUDIT_EVIDENCE_MAX)
  if (actor === 'agent' && !stage?.autoClose && (!reason || !evidence)) {
    throw new TaskboardValidationError(
      'agent 关单必须同时提供 reason（关单理由）与 evidence（证据链接），会写入审计记录',
    )
  }
  assertTransition({
    from: ticket.status,
    to: 'done',
    actor,
    autoClose: stage?.autoClose ?? false,
    audit: { reason, evidence },
  })
  const who = auditIdentity(actor, body, stage?.agentId)
  const actorId = who.actorId
  const updated = db.transaction(() => {
    const next = updateTicket(db, ticket.id, expectedVersion, {
      status: 'done',
      closedAt: Date.now(),
    })
    recordActivity(db, ticket.id, actor, actorId, 'status_changed', 'status', ticket.status, 'done')
    if (actor !== 'human' || reason || evidence) {
      recordAudit(db, ticket, actor, who, 'close_audit', 'done', reason, evidence)
    }
    return next
  })()
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

/** A stop controls execution; already closed business tickets remain closed. */
function recordHumanRunStop(db: TaskboardDb, current: Ticket, runId: string, expectedVersion: number): Ticket {
  const closed = current.status === 'done' || current.status === 'canceled'
  if (!closed && current.status !== 'blocked') assertTransition({ from: current.status, to: 'blocked', actor: 'human' })
  const updated = closed ? current : updateTicket(db, current.id, expectedVersion, { status: 'blocked', blockedReason: '用户停止本次执行' })
  if (closed) recordActivity(db, current.id, 'human', HUMAN_ACTOR_ID, 'run_stop_requested', null, null, runId)
  else recordActivity(db, current.id, 'human', HUMAN_ACTOR_ID, 'status_changed', 'status', current.status, 'blocked')
  createComment(db, { ticketId: current.id, authorKind: 'human', author: HUMAN_ACTOR_ID, runId, body: closed
    ? '已请求停止仍在运行的本次执行，保留单据关闭状态与已有输出。'
    : '已请求停止本次执行，正在保留输出并收尾。结束后可重试。' })
  return updated
}

function requestHumanRunStop(db: TaskboardDb, ticketId: string, expectedVersion: number, runId: string) {
  return db.transaction(() => {
    const current = requireTicket(db, ticketId)
    const run = getRun(db, runId)
    if (!run || run.ticketId !== current.id) throw new TaskboardNotFound('run', runId)
    if (run.status !== 'running' && run.status !== 'queued') {
      const latest = getLatestRunMetadata(db, current.id)
      const active = getActiveLease(db, current.id)
      if (latest?.id !== run.id || (active && active.id !== run.id)) return { kind: 'terminal' as const, ticket: current, run }
      const closing = taskboardRunControls.getActiveForTicket(current.id)
      if (!closing || closing.runId !== run.id || closing.rootSessionKey !== run.sessionKey) return { kind: 'terminal' as const, ticket: current, run }
      if (closing.signal.aborted) return { kind: 'pending' as const, ticket: current, run }
      if (current.version !== expectedVersion) throw new TaskboardVersionConflict(current.id, expectedVersion, current.version)
      const updated = recordHumanRunStop(db, current, run.id, expectedVersion)
      return { kind: 'requested' as const, ticket: updated, run, control: closing }
    }
    const now = Date.now()
    const active = getActiveLease(db, current.id, now)
    if (!active || active.id !== run.id || !run.leaseOwner) return { kind: 'conflict' as const, code: 'run_changed', message: '当前执行已变化，请刷新后操作' }
    const control = taskboardRunControls.get(run.id, current.id, run.leaseOwner)
    if (!control) return { kind: 'conflict' as const, code: 'run_control_unavailable', message: '当前执行控制不可用，请等待执行收尾后重试' }
    if (control.signal.aborted) return { kind: 'pending' as const, ticket: current, run }
    if (current.version !== expectedVersion) throw new TaskboardVersionConflict(current.id, expectedVersion, current.version)
    const updated = recordHumanRunStop(db, current, run.id, expectedVersion)
    return { kind: 'requested' as const, ticket: updated, run, control }
  }).immediate()
}

/** Human stop is an exact-run request, never a lease release or terminal claim. */
function handleStop(
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
  const runId = asString(body.runId)
  if (!runId) throw new TaskboardValidationError('runId is required')
  const outcome = requestHumanRunStop(db, ticket.id, expectedVersion, runId)
  if (outcome.kind === 'conflict') {
    sendError(res, 409, outcome.message, { code: outcome.code })
    return
  }
  if (outcome.kind === 'requested') outcome.control.requestStop()
  sendJson(res, outcome.kind === 'terminal' ? 200 : 202, { ok: true, state: outcome.kind === 'terminal' ? 'terminal' : 'stopping', ticket: outcome.ticket, run: outcome.run })
}

async function handlePatrol(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  ticket: Ticket,
  ctx: TaskboardHttpContext,
): Promise<void> {
  const expectedVersion = requireExpectedVersion(body)
  if (ticket.version !== expectedVersion) {
    throw new TaskboardVersionConflict(ticket.id, expectedVersion, ticket.version)
  }
  if (hasPendingTaskboardExecution(db, ticket.id)) return sendError(res, 409, '上一轮执行仍在收尾，请稍后重试', { code: 'active_execution' })
  let settings = getSettings(db)
  if (settings.patrolPaused) {
    throw new TaskboardValidationError('patrol is paused')
  }
  const stageRef = asNullableString(body.stageId) ?? ticket.stageId
  if (!stageRef) throw new TaskboardValidationError('ticket has no stage')
  const stage = getStage(db, stageRef)
  if (!stage) throw new TaskboardNotFound('stage', stageRef)
  if (stage.kind !== 'ai') throw new TaskboardValidationError('stage is not an ai stage')
  await assertTaskboardStagesRunnable(ctx.preflightStages, [stage])
  settings = getSettings(db)
  if (settings.patrolPaused) return sendError(res, 409, '巡检已暂停，请先恢复巡检', { code: 'patrol_paused' })

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
    const fresh = requireTicket(db, ticket.id)
    if (fresh.version !== expectedVersion) throw new TaskboardVersionConflict(ticket.id, expectedVersion, fresh.version)
    if (hasPendingTaskboardExecution(db, ticket.id)) return { kind: 'busy' } as const
    const freshStage = getStage(db, stage.id)
    if (!freshStage || JSON.stringify(freshStage) !== JSON.stringify(stage)) return { kind: 'stage_changed' } as const
    const liveSettings = getSettings(db)
    if (liveSettings.patrolPaused) return { kind: 'paused' } as const
    if (getUsage(db).activeRuns >= liveSettings.maxConcurrentRuns || slots.getActive() >= liveSettings.maxConcurrentRuns) return { kind: 'full' } as const
    const run = acquireLease(db, ticket.id, stage.id, owner, alignedLeaseTtlMs(stage.timeoutSec), {
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
    return { kind: 'claimed', run: withKey, ticket: updated } as const
  }).immediate()
  if (result.kind === 'busy') return sendError(res, 409, '上一轮执行仍在收尾，请稍后重试', { code: 'active_execution' })
  if (result.kind === 'stage_changed') return sendError(res, 409, '阶段配置已更新，请刷新后重试', { code: 'stage_configuration_changed' })
  if (result.kind === 'paused') return sendError(res, 409, '巡检已暂停，请先恢复巡检', { code: 'patrol_paused' })
  if (result.kind === 'full') return sendError(res, 429, 'taskboard concurrency full', { code: 'concurrency_full' })

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
