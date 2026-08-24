/**
 * Project memory REST: list / create candidate / promote / reject / deprecate.
 * Promote/reject/deprecate require resolveTaskboardActor === 'human'.
 * Agent bearer / CLI accessToken cannot impersonate a browser JWT.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ProjectMemoryDir,
  ProjectMemoryLedger,
  type CandidateStatus,
} from '@openclaude/storage'
import type { Actor } from './domain.js'
import { TaskboardNotFound, TaskboardValidationError, type TaskboardDb } from './db/index.js'
import { getProject, getProjectByKey } from './db/projects.js'

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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function requireExpectedVersion(body: Record<string, unknown>): number {
  const v = body.expectedVersion
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new TaskboardValidationError('expectedVersion is required')
  }
  return v
}

function resolveProjectOrThrow(db: TaskboardDb, idOrKey: string) {
  const project = getProject(db, idOrKey) ?? getProjectByKey(db, idOrKey)
  if (!project) throw new TaskboardNotFound('project', idOrKey)
  return project
}

function actorLabel(actor: Actor): string {
  return actor === 'human' ? 'user:default' : 'agent:unidentified'
}

function requireHuman(res: ServerResponse, actor: Actor): boolean {
  if (actor === 'human') return true
  sendError(res, 403, 'human approval required', { code: 'human_required' })
  return false
}

export async function handleListProjectMemories(
  res: ServerResponse,
  url: URL,
  db: TaskboardDb,
  idOrKey: string,
): Promise<void> {
  const project = resolveProjectOrThrow(db, idOrKey)
  const ledger = new ProjectMemoryLedger(db)
  const dir = new ProjectMemoryDir(project.id)
  const status = url.searchParams.get('status')
  const official = ledger.listOfficial(project.id, { includeDeprecated: status === 'deprecated' || status === 'all' })
  const candidates = ledger.listCandidates(project.id)
  const officialOut = []
  for (const row of official) {
    if (status === 'candidate') continue
    if (status === 'deprecated' && !row.deprecated) continue
    if (status === 'official' && row.deprecated) continue
    const read = await dir.readOfficial(row.slug, row.contentSha256)
    officialOut.push({
      ...row,
      tampered: !read && !row.deprecated,
      content: read?.content ?? null,
    })
  }
  const candidateOut = []
  for (const row of candidates) {
    if (status === 'official' || status === 'deprecated') continue
    const read = await dir.readCandidate(row.file, row.contentSha256)
    candidateOut.push({
      ...row,
      tampered: !read,
      content: read?.content ?? null,
    })
  }
  sendJson(res, 200, {
    projectId: project.id,
    official: officialOut,
    candidates: candidateOut,
  })
}

export async function handleCreateProjectMemory(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  idOrKey: string,
): Promise<void> {
  const project = resolveProjectOrThrow(db, idOrKey)
  const slug = asString(body.slug) ?? asString(body.file)
  const content = asString(body.content)
  if (!slug || content == null) throw new TaskboardValidationError('slug and content are required')
  const ledger = new ProjectMemoryLedger(db)
  const created = await ledger.createCandidate({
    projectId: project.id,
    slug,
    content,
    actor: actorLabel(actor),
    auto: body.auto === true,
    sourceAgent: asString(body.sourceAgent) ?? null,
    sourceSession: asString(body.sourceSession) ?? null,
    sourceTicket: asString(body.sourceTicket) ?? null,
    supersedes: asString(body.supersedes) ?? null,
    idempotencyKey: asString(body.idempotencyKey) ?? null,
  })
  if (!created.ok) {
    sendError(res, 400, created.error, { detail: created.detail })
    return
  }
  sendJson(res, created.idempotent ? 200 : 201, {
    ok: true,
    candidate: created.candidate,
    idempotent: created.idempotent ?? false,
    alreadyOfficial: created.alreadyOfficial ?? false,
  })
}

export async function handlePromoteProjectMemory(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  idOrKey: string,
  candidateId: string,
): Promise<void> {
  if (!requireHuman(res, actor)) return
  const project = resolveProjectOrThrow(db, idOrKey)
  const expectedVersion = requireExpectedVersion(body)
  const ledger = new ProjectMemoryLedger(db)
  const result = await ledger.promote({
    projectId: project.id,
    candidateId,
    expectedVersion,
    actor: actorLabel(actor),
  })
  if (!result.ok) {
    const code = result.error === 'version_conflict' ? 409 : result.error === 'not_found' ? 404 : 400
    sendError(res, code, result.error, { current: result.current ?? null })
    return
  }
  sendJson(res, 200, { ok: true, official: result.official, idempotent: result.idempotent ?? false })
}

export async function handleRejectProjectMemory(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  idOrKey: string,
  candidateId: string,
): Promise<void> {
  if (!requireHuman(res, actor)) return
  const project = resolveProjectOrThrow(db, idOrKey)
  const expectedVersion = requireExpectedVersion(body)
  const ledger = new ProjectMemoryLedger(db)
  const result = ledger.reject({
    projectId: project.id,
    candidateId,
    expectedVersion,
    actor: actorLabel(actor),
  })
  if (!result.ok) {
    const code = result.error === 'version_conflict' ? 409 : result.error === 'not_found' ? 404 : 400
    sendError(res, code, result.error, { current: result.current ?? null })
    return
  }
  sendJson(res, 200, { ok: true, candidate: result.candidate, idempotent: result.idempotent ?? false })
}

export async function handleDeprecateProjectMemory(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: TaskboardDb,
  actor: Actor,
  idOrKey: string,
  slug: string,
): Promise<void> {
  if (!requireHuman(res, actor)) return
  const project = resolveProjectOrThrow(db, idOrKey)
  const expectedVersion = requireExpectedVersion(body)
  const ledger = new ProjectMemoryLedger(db)
  const result = ledger.deprecate({
    projectId: project.id,
    slug,
    expectedVersion,
    actor: actorLabel(actor),
  })
  if (!result.ok) {
    const code = result.error === 'version_conflict' ? 409 : 404
    sendError(res, code, result.error, { current: result.current ?? null })
    return
  }
  sendJson(res, 200, { ok: true, official: result.official, idempotent: result.idempotent ?? false })
}

export function isProjectMemoryPath(path: string): boolean {
  return /^\/api\/board\/projects\/[^/]+\/memories(\/|$)/.test(path)
}

export async function dispatchProjectMemory(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  db: TaskboardDb,
  actor: Actor,
): Promise<boolean> {
  const path = url.pathname
  const listOrCreate = path.match(/^\/api\/board\/projects\/([^/]+)\/memories$/)
  if (listOrCreate) {
    const id = decodeURIComponent(listOrCreate[1])
    if (method === 'GET') {
      await handleListProjectMemories(res, url, db, id)
      return true
    }
    if (method === 'POST') {
      const raw = await readJson(req)
      await handleCreateProjectMemory(res, raw, db, actor, id)
      return true
    }
    sendError(res, 405, 'method not allowed')
    return true
  }
  const action = path.match(/^\/api\/board\/projects\/([^/]+)\/memories\/([^/]+)\/(promote|reject|deprecate)$/)
  if (action) {
    if (method !== 'POST') {
      sendError(res, 405, 'method not allowed')
      return true
    }
    const id = decodeURIComponent(action[1])
    const file = decodeURIComponent(action[2])
    const verb = action[3]
    const raw = await readJson(req)
    if (verb === 'promote') await handlePromoteProjectMemory(res, raw, db, actor, id, file)
    else if (verb === 'reject') await handleRejectProjectMemory(res, raw, db, actor, id, file)
    else await handleDeprecateProjectMemory(res, raw, db, actor, id, file)
    return true
  }
  return false
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TaskboardValidationError('request body must be an object')
  }
  return parsed as Record<string, unknown>
}

export type { CandidateStatus }
