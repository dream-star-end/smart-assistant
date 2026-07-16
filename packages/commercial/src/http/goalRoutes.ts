import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GoalStateService } from '../goal/goalStateService.js'
import { GoalStateError } from '../goal/goalStateService.js'
import { requireAuth } from './auth.js'
import { HttpError, readJsonBody, sendJson } from './util.js'

export interface GoalRouteDeps {
  jwtSecret: string | Uint8Array
  goalStateService?: GoalStateService
}

function parseRoute(req: IncomingMessage): { sessionId: string; action: string | null } {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const match = /^\/api\/session-goals\/([^/]+)(?:\/(pause|resume|complete|clear))?$/.exec(path)
  if (!match) throw new HttpError(404, 'NOT_FOUND', 'goal route not found')
  try {
    return { sessionId: decodeURIComponent(match[1]!), action: match[2] ?? null }
  } catch {
    throw new HttpError(400, 'INVALID_GOAL', 'invalid session id encoding')
  }
}

function expectedRevision(raw: Record<string, unknown>): number {
  if (!Object.prototype.hasOwnProperty.call(raw, 'expectedStateRevision')) {
    throw new GoalStateError('INVALID', 'expectedStateRevision is required (use 0 when no goal exists)')
  }
  const value = raw.expectedStateRevision
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GoalStateError('INVALID', 'expectedStateRevision must be a non-negative safe integer')
  }
  return value
}

function nullableField<T extends 'number' | 'string'>(
  raw: Record<string, unknown>,
  field: 'tokenBudget' | 'creditBudget',
  type: T,
): (T extends 'number' ? number : string) | null {
  const value = raw[field]
  if (value === undefined || value === null) return null
  if (typeof value !== type) throw new GoalStateError('INVALID', `${field} must be ${type} or null`)
  return value as (T extends 'number' ? number : string)
}

function mapError(err: unknown): never {
  if (err instanceof GoalStateError) {
    if (err.code === 'NOT_FOUND') throw new HttpError(404, 'NOT_FOUND', err.message)
    if (err.code === 'CONFLICT') throw new HttpError(409, 'GOAL_CONFLICT', err.message)
    throw new HttpError(400, 'INVALID_GOAL', err.message)
  }
  throw err
}

export async function dispatchGoalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GoalRouteDeps,
): Promise<void> {
  if (!deps.goalStateService) throw new HttpError(503, 'GOAL_UNAVAILABLE', 'goal service unavailable')
  const user = await requireAuth(req, deps.jwtSecret)
  const uid = BigInt(user.id)
  const { sessionId, action } = parseRoute(req)
  try {
    if (req.method === 'GET' && action === null) {
      sendJson(res, 200, { goal: await deps.goalStateService.get(uid, sessionId) })
      return
    }
    const raw = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>
    const expectedStateRevision = expectedRevision(raw)
    if (req.method === 'PUT' && action === null) {
      const goal = await deps.goalStateService.set(uid, sessionId, {
        objective: typeof raw.objective === 'string' ? raw.objective : '',
        tokenBudget: nullableField(raw, 'tokenBudget', 'number'),
        creditBudget: nullableField(raw, 'creditBudget', 'string'),
        expectedStateRevision,
      })
      sendJson(res, 200, { goal })
      return
    }
    if (req.method === 'POST' && action) {
      const goal = action === 'pause'
        ? await deps.goalStateService.pause(uid, sessionId, expectedStateRevision)
        : action === 'resume'
          ? await deps.goalStateService.resume(uid, sessionId, expectedStateRevision)
          : action === 'complete'
            ? await deps.goalStateService.complete(uid, sessionId, expectedStateRevision)
            : await deps.goalStateService.clear(uid, sessionId, expectedStateRevision)
      sendJson(res, 200, { goal })
      return
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed')
  } catch (err) {
    mapError(err)
  }
}
