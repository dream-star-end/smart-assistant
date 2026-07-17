import type { IncomingMessage, ServerResponse } from 'node:http'

import { PluginAccountLeaseError } from '../plugins/accountLease.js'
import { PluginAccountError } from '../plugins/accounts.js'
import type { KnowledgePlanetSetupManager } from '../plugins/knowledgePlanetSetup.js'
import { KnowledgePlanetSetupError } from '../plugins/knowledgePlanetSetup.js'
import type { PluginRuntimeFacade } from '../plugins/runtime.js'
import { PluginRuntimeFacadeError } from '../plugins/runtime.js'
import { requireAuth } from './auth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { HttpError, readJsonBody, sendJson } from './util.js'

export interface PluginHttpDeps {
  pluginRuntime?: PluginRuntimeFacade
  knowledgePlanetSetup?: KnowledgePlanetSetupManager
}

function userIdFrom(value: string): number {
  if (!/^\d{1,16}$/.test(value)) throw new HttpError(401, 'UNAUTHORIZED', 'invalid user')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(401, 'UNAUTHORIZED', 'invalid user')
  return id
}

function setupManager(deps: CommercialHttpDeps & PluginHttpDeps): KnowledgePlanetSetupManager {
  if (!deps.knowledgePlanetSetup)
    throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin runtime unavailable')
  return deps.knowledgePlanetSetup
}

function runtime(deps: CommercialHttpDeps & PluginHttpDeps): PluginRuntimeFacade {
  if (!deps.pluginRuntime)
    throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin runtime unavailable')
  return deps.pluginRuntime
}

function mapSetupError(error: unknown): never {
  if (!(error instanceof KnowledgePlanetSetupError)) throw error
  switch (error.code) {
    case 'NOT_INSTALLED':
      throw new HttpError(403, error.code, 'Knowledge Planet Plugin is not installed')
    case 'SETUP_ACTIVE':
    case 'ACCOUNT_ALREADY_EXISTS':
      throw new HttpError(409, error.code, 'Knowledge Planet account setup conflicts')
    case 'SETUP_NOT_FOUND':
    case 'QR_NOT_READY':
      throw new HttpError(404, error.code, 'Knowledge Planet setup not found')
    case 'TERMS_REQUIRED':
      throw new HttpError(400, error.code, 'terms acceptance is required')
    case 'CAPACITY_EXCEEDED':
      throw new HttpError(429, error.code, 'Plugin setup capacity is full')
    case 'CLOSING':
    case 'UNAVAILABLE':
      throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin runtime unavailable')
    default:
      throw new HttpError(500, 'PLUGIN_SETUP_FAILED', 'Plugin setup failed')
  }
}

function mapRuntimeError(error: unknown): never {
  if (error instanceof PluginRuntimeFacadeError) {
    switch (error.code) {
      case 'BAD_REQUEST':
        throw new HttpError(400, error.code, 'invalid Plugin request')
      case 'TARGET_NOT_FOUND':
        throw new HttpError(404, error.code, 'Plugin account not found')
      case 'TARGET_STALE':
        throw new HttpError(409, error.code, 'Plugin account changed; retry')
      case 'WRITE_DISABLED':
      case 'WRITE_REQUIRES_CONFIRMATION':
        throw new HttpError(409, error.code, 'Plugin writes are not enabled')
      case 'RUNTIME_BUSY':
        throw new HttpError(429, error.code, 'Plugin runtime is busy')
      case 'RELINK_REQUIRED':
        throw new HttpError(401, error.code, 'Plugin account must be authorized again')
      default:
        throw new HttpError(503, error.code, 'Plugin runtime unavailable')
    }
  }
  if (error instanceof PluginAccountLeaseError) {
    if (error.code === 'LEASE_BUSY')
      throw new HttpError(409, error.code, 'Plugin account is currently in use')
    throw new HttpError(503, error.code, 'Plugin account lease unavailable')
  }
  if (error instanceof PluginAccountError) {
    if (error.code === 'ACCOUNT_NOT_FOUND' || error.code === 'ACCOUNT_REVOKED')
      throw new HttpError(404, 'TARGET_NOT_FOUND', 'Plugin account not found')
    if (error.code === 'ACCOUNT_STALE')
      throw new HttpError(409, 'TARGET_STALE', 'Plugin account changed; retry')
    throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin runtime unavailable')
  }
  throw error
}

function setupMatch(path: string): { sessionId: string; qr: boolean } | null {
  const match = /^\/api\/plugins\/knowledge-planet\/setup\/([0-9a-f-]{36})(\/qr)?$/.exec(path)
  return match ? { sessionId: match[1]!, qr: match[2] === '/qr' } : null
}

export async function dispatchPluginsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps & PluginHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = userIdFrom(user.id)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && (path === '/api/plugins' || path === '/api/plugins/management')) {
    sendJson(res, 200, await runtime(deps).management(userId))
    return
  }

  if (method === 'POST' && path === '/api/plugins/knowledge-planet/setup') {
    const body = await readJsonBody(req, 1024)
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'acceptTerms')
    )
      throw new HttpError(400, 'BAD_REQUEST', 'body must contain only acceptTerms')
    try {
      const setup = await setupManager(deps).start(
        userId,
        (body as Record<string, unknown>).acceptTerms === true,
      )
      sendJson(res, 201, setup)
      return
    } catch (error) {
      mapSetupError(error)
    }
  }

  const account = /^\/api\/plugins\/accounts\/(\d{1,16})$/.exec(path)
  if (account && method === 'DELETE') {
    try {
      sendJson(res, 200, {
        ...(await runtime(deps).revokeManagedAccount(userId, account[1]!)),
        status: 'revoked',
      })
      return
    } catch (error) {
      mapRuntimeError(error)
    }
  }

  const writeAccess = /^\/api\/plugins\/accounts\/(\d{1,16})\/write-access$/.exec(path)
  if (writeAccess && method === 'PATCH') {
    const body = await readJsonBody(req, 2048)
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new HttpError(400, 'BAD_REQUEST', 'write access body must be an object')
    const value = body as Record<string, unknown>
    const keys = Object.keys(value).sort()
    const enabled = value.enabled
    const validDisable = enabled === false && keys.join('\0') === 'enabled'
    const validEnable =
      enabled === true &&
      value.accepted === true &&
      Number.isInteger(value.disclaimerVersion) &&
      keys.join('\0') === ['accepted', 'disclaimerVersion', 'enabled'].join('\0')
    if (!validDisable && !validEnable)
      throw new HttpError(400, 'BAD_REQUEST', 'write access body is invalid')
    try {
      const writeControl = await runtime(deps).setManagedAccountWriteAccess({
        userId,
        targetId: writeAccess[1]!,
        enabled: enabled as boolean,
        ...(validEnable
          ? {
              accepted: true as const,
              disclaimerVersion: Number(value.disclaimerVersion),
            }
          : {}),
      })
      sendJson(res, 200, { writeControl })
      return
    } catch (error) {
      mapRuntimeError(error)
    }
  }

  const match = setupMatch(path)
  if (match && method === 'GET' && match.qr) {
    try {
      const png = await setupManager(deps).qr(userId, match.sessionId)
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Content-Length', String(png.length))
      res.setHeader('Cache-Control', 'no-store, private')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.end(png)
      return
    } catch (error) {
      mapSetupError(error)
    }
  }
  if (match && method === 'GET' && !match.qr) {
    try {
      sendJson(res, 200, await setupManager(deps).status(userId, match.sessionId))
      return
    } catch (error) {
      mapSetupError(error)
    }
  }
  if (match && method === 'DELETE' && !match.qr) {
    try {
      sendJson(res, 200, await setupManager(deps).cancel(userId, match.sessionId))
      return
    } catch (error) {
      mapSetupError(error)
    }
  }

  throw new HttpError(404, 'NOT_FOUND', 'Plugin endpoint not found')
}
