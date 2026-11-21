/**
 * Context Governance Control-Plane HTTP API (OCV5-840).
 *
 * Exposes read/write endpoints for:
 *  - GET  /api/agents/:id/context-health
 *  - POST /api/agents/:id/context-hygiene/run
 *  - GET  /api/agents/:id/context-hygiene/history
 *  - GET  /api/agents/:id/memory/archive
 *  - POST /api/agents/:id/memory/archive
 *  - POST /api/agents/:id/memory/archive/restore
 *  - GET  /api/skills/archive
 *  - POST /api/skills/:name/archive
 *  - POST /api/skills/archive/restore
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { withUserError } from '@openclaude/protocol'
import {
  archiveMemoryFiles,
  archiveUserSkill,
  buildContextHealthReport,
  getSessionsDb,
  listArchivedMemories,
  listArchivedSkills,
  listContextHygieneHistory,
  paths,
  restoreArchivedMemories,
  restoreArchivedSkills,
  runContextJanitor,
  type SkillUsageDbLike,
} from '@openclaude/storage'
import { isHiddenSystemAgentId } from './agentVisibility.js'

const MAX_JSON_BODY_BYTES = 256 * 1024

export interface ContextHealthApiDeps {
  agentDir?: (agentId: string) => string
  userProfilePath?: string
  skillsDir?: string
  getSessionsDb?: () => Promise<SkillUsageDbLike | undefined>
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(withUserError(body, code)))
}

function sendError(res: ServerResponse, code: number, error: string): void {
  sendJson(res, code, { error })
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error('PAYLOAD_TOO_LARGE')
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('INVALID_JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INVALID_JSON')
  }
  return parsed as Record<string, unknown>
}

async function resolveOptionalDb(deps?: ContextHealthApiDeps): Promise<SkillUsageDbLike | undefined> {
  try {
    return deps?.getSessionsDb ? await deps.getSessionsDb() : await getSessionsDb()
  } catch {
    return undefined
  }
}

function resolveAgentDir(agentId: string, deps?: ContextHealthApiDeps): string {
  return deps?.agentDir ? deps.agentDir(agentId) : paths.agentDir(agentId)
}

function resolveSkillsDir(deps?: ContextHealthApiDeps): string {
  return deps?.skillsDir ?? paths.sharedSkillsDir
}

function resolveUserProfilePath(deps?: ContextHealthApiDeps): string {
  return deps?.userProfilePath ?? paths.sharedUserMd
}

function clampInt(val: unknown, fallback: number, min: number, max: number): number {
  if (typeof val !== 'number' && typeof val !== 'string') return fallback
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

// GET /api/agents/:id/context-health
export async function handleAgentContextHealth(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  url: URL,
  deps?: ContextHealthApiDeps,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return sendError(res, 404, 'agent not found')
  if (req.method !== 'GET') return sendError(res, 405, 'method not allowed')
  const coldSkillDays = clampInt(url.searchParams.get('coldSkillDays'), 60, 7, 365)
  const sessionsDb = await resolveOptionalDb(deps)
  const report = await buildContextHealthReport({
    agentId,
    agentDir: resolveAgentDir(agentId, deps),
    userProfilePath: resolveUserProfilePath(deps),
    skillsDir: resolveSkillsDir(deps),
    sessionsDb,
    coldSkillDays,
  })
  sendJson(res, 200, report)
}

// POST /api/agents/:id/context-hygiene/run
export async function handleAgentContextHygieneRun(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  deps?: ContextHealthApiDeps,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return sendError(res, 404, 'agent not found')
  if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
  let body: Record<string, unknown>
  try {
    body = await readJsonObject(req)
  } catch (err) {
    const code = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    return sendError(res, code, 'invalid JSON body')
  }
  const pruneSkillHistoryNames = Array.isArray(body.pruneSkillHistoryNames)
    ? body.pruneSkillHistoryNames
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .map((n) => n.trim())
    : undefined
  const pruneArchivalIds = Array.isArray(body.pruneArchivalIds)
    ? body.pruneArchivalIds
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .map((n) => n.trim())
    : undefined
  const mode = body.mode === 'auto' ? 'auto' : 'manual'
  // B2: Never allow a bare manual boolean `pruneSkillHistory: true` without explicit target names
  // (or explicit `pruneAllSkillHistories: true`) to silently wipe unselected skills' history.
  const effectivePruneSkillHistory =
    pruneSkillHistoryNames !== undefined
      ? pruneSkillHistoryNames.length > 0
      : typeof body.pruneSkillHistory === 'boolean'
        ? body.pruneSkillHistory && (mode === 'auto' || body.pruneAllSkillHistories === true)
        : undefined

  const sessionsDb = await resolveOptionalDb(deps)
  const run = await runContextJanitor({
    agentId,
    agentDir: resolveAgentDir(agentId, deps),
    skillsDir: resolveSkillsDir(deps),
    sessionsDb,
    dryRun: body.dryRun === true,
    mode,
    ...(typeof body.archiveExpiredMemories === 'boolean'
      ? { archiveExpiredMemories: body.archiveExpiredMemories }
      : {}),
    ...(typeof body.archiveColdSkills === 'boolean'
      ? { archiveColdSkills: body.archiveColdSkills }
      : {}),
    ...(body.coldSkillDays !== undefined
      ? { coldSkillDays: clampInt(body.coldSkillDays, 60, 7, 365) }
      : {}),
    ...(effectivePruneSkillHistory !== undefined
      ? { pruneSkillHistory: effectivePruneSkillHistory }
      : {}),
    ...(pruneSkillHistoryNames !== undefined ? { pruneSkillHistoryNames } : {}),
    ...(pruneArchivalIds !== undefined ? { pruneArchivalIds } : {}),
    ...(body.maxSkillHistoryVersions !== undefined
      ? { maxSkillHistoryVersions: clampInt(body.maxSkillHistoryVersions, 5, 1, 50) }
      : {}),
    ...(typeof body.decayArchival === 'boolean' ? { decayArchival: body.decayArchival } : {}),
  })
  sendJson(res, 200, { ok: true, run })
}

// GET /api/agents/:id/context-hygiene/history
export async function handleAgentContextHygieneHistory(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  url: URL,
  deps?: ContextHealthApiDeps,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return sendError(res, 404, 'agent not found')
  if (req.method !== 'GET') return sendError(res, 405, 'method not allowed')
  const limit = clampInt(url.searchParams.get('limit'), 10, 1, 50)
  const runs = await listContextHygieneHistory(resolveAgentDir(agentId, deps), limit)
  sendJson(res, 200, { runs })
}

// GET / POST /api/agents/:id/memory/archive
export async function handleAgentMemoryArchive(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  deps?: ContextHealthApiDeps,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return sendError(res, 404, 'agent not found')
  const agentDir = resolveAgentDir(agentId, deps)
  if (req.method === 'GET') {
    const items = await listArchivedMemories(agentDir)
    sendJson(res, 200, { items })
    return
  }
  if (req.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await readJsonObject(req)
    } catch (err) {
      const code = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
      return sendError(res, code, 'invalid JSON body')
    }
    const files = Array.isArray(body.files)
      ? body.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : []
    if (files.length === 0) {
      return sendError(res, 400, 'files array is required')
    }
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 200)
        : 'manual_archive'
    // B1: Always mint a fresh server-owned batchId; never accept caller-supplied batchId
    // that could collide with or overwrite an earlier archived version.
    const result = await archiveMemoryFiles(agentDir, files, {
      reason,
      actor: 'user',
    })
    sendJson(res, 200, { ok: true, ...result })
    return
  }
  sendError(res, 405, 'method not allowed')
}

// POST /api/agents/:id/memory/archive/restore
export async function handleAgentMemoryArchiveRestore(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  deps?: ContextHealthApiDeps,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return sendError(res, 404, 'agent not found')
  if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
  let body: Record<string, unknown>
  try {
    body = await readJsonObject(req)
  } catch (err) {
    const code = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    return sendError(res, code, 'invalid JSON body')
  }
  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined
  const batchId =
    typeof body.batchId === 'string' && body.batchId.trim() ? body.batchId.trim() : undefined
  if (!id && !batchId) {
    return sendError(res, 400, 'id or batchId is required')
  }
  const result = await restoreArchivedMemories(resolveAgentDir(agentId, deps), { id, batchId })
  sendJson(res, 200, { ok: true, ...result })
}

// GET /api/skills/archive
export async function handleSkillsArchiveList(
  req: IncomingMessage,
  res: ServerResponse,
  deps?: ContextHealthApiDeps,
): Promise<void> {
  if (req.method !== 'GET') return sendError(res, 405, 'method not allowed')
  const items = await listArchivedSkills(resolveSkillsDir(deps))
  sendJson(res, 200, { items })
}

// POST /api/skills/:name/archive
export async function handleSkillArchiveItem(
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
  deps?: ContextHealthApiDeps,
): Promise<void> {
  if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
  let body: Record<string, unknown>
  try {
    body = await readJsonObject(req)
  } catch (err) {
    const code = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    return sendError(res, code, 'invalid JSON body')
  }
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 200)
      : 'manual_archive'
  // B1: Always mint a fresh server-owned batchId; never trust caller-supplied batchId.
  const result = await archiveUserSkill(resolveSkillsDir(deps), skillName, {
    reason,
    actor: 'user',
  })
  if (!result.entry) {
    const status = result.skippedReason === 'invalid_skill_name' ? 400 : 404
    return sendError(res, status, result.skippedReason ?? 'skill not found')
  }
  sendJson(res, 200, { ok: true, batchId: result.batchId, entry: result.entry })
}

// POST /api/skills/archive/restore
export async function handleSkillsArchiveRestore(
  req: IncomingMessage,
  res: ServerResponse,
  deps?: ContextHealthApiDeps,
): Promise<void> {
  if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
  let body: Record<string, unknown>
  try {
    body = await readJsonObject(req)
  } catch (err) {
    const code = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    return sendError(res, code, 'invalid JSON body')
  }
  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined
  const batchId =
    typeof body.batchId === 'string' && body.batchId.trim() ? body.batchId.trim() : undefined
  if (!id && !name && !batchId) {
    return sendError(res, 400, 'id, name, or batchId is required')
  }
  const result = await restoreArchivedSkills(resolveSkillsDir(deps), { id, name, batchId })
  sendJson(res, 200, { ok: true, ...result })
}
