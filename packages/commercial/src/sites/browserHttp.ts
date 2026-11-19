import type { IncomingMessage, ServerResponse } from 'node:http'
import { requireAuth } from '../http/auth.js'
import type { RequestContext } from '../http/handlers.js'
import { HttpError, readJsonBody, sendJson } from '../http/util.js'
import type { SitesService } from './service.js'
import { SitesError } from './types.js'

export interface SitesBrowserDeps {
  jwtSecret: string | Uint8Array
  sites?: SitesService
}

function parsePositiveUserId(raw: string): number {
  if (!/^[1-9]\d{0,18}$/.test(raw)) {
    throw new HttpError(401, 'UNAUTHORIZED', 'invalid user id')
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new HttpError(401, 'UNAUTHORIZED', 'invalid user id')
  }
  return n
}

function mapSitesErrorToHttp(err: unknown): never {
  if (err instanceof SitesError) {
    throw new HttpError(err.status, err.code, err.message, {
      ...(err.retryable ? { retrySafe: 'safe' } : {}),
    })
  }
  throw err
}

function decodePathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new SitesError('INVALID_SLUG', 'invalid path segment encoding', 400)
  }
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'BAD_REQUEST', 'request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

export async function dispatchSitesBrowserRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: SitesBrowserDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = parsePositiveUserId(user.id)

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  if (!deps.sites) {
    if (method === 'GET' && pathname === '/api/sites') {
      sendJson(res, 200, {
        enabled: false,
        baseDomain: 'congjianai.com',
        maxPerUser: 20,
        maxSiteBytes: 25 * 1024 * 1024,
        sites: [],
      })
      return
    }
    throw new HttpError(503, 'SITES_DISABLED', '持久化站点托管功能尚未开启')
  }

  try {
    if (method === 'GET' && pathname === '/api/sites') {
      sendJson(res, 200, await deps.sites.listSummary(userId))
      return
    }

    const renameMatch = /^\/api\/sites\/([^/]+)\/rename$/.exec(pathname)
    if (renameMatch) {
      if (method !== 'POST') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method ${method} not allowed`, {
          extraHeaders: { Allow: 'POST' },
        })
      }
      const slug = decodePathSegment(renameMatch[1]!)
      const body = await readJsonObject(req)
      const site = await deps.sites.renameSite(
        userId,
        slug,
        typeof body.newSlug === 'string' ? body.newSlug : '',
      )
      sendJson(res, 200, { site })
      return
    }

    const verifyDomainMatch = /^\/api\/sites\/([^/]+)\/verify-domain$/.exec(pathname)
    if (verifyDomainMatch) {
      if (method !== 'POST') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method ${method} not allowed`, {
          extraHeaders: { Allow: 'POST' },
        })
      }
      const slug = decodePathSegment(verifyDomainMatch[1]!)
      const site = await deps.sites.verifyCustomDomain(userId, slug)
      sendJson(res, 200, { site })
      return
    }

    const envSetMatch = /^\/api\/sites\/([^/]+)\/env$/.exec(pathname)
    if (envSetMatch) {
      if (method !== 'PUT') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method ${method} not allowed`, {
          extraHeaders: { Allow: 'PUT' },
        })
      }
      const slug = decodePathSegment(envSetMatch[1]!)
      const body = await readJsonObject(req)
      if (typeof body.key !== 'string' || typeof body.value !== 'string') {
        throw new HttpError(400, 'INVALID_INPUT', 'key and value must be strings')
      }
      const result = await deps.sites.setEnvVar(userId, slug, {
        key: body.key,
        value: body.value,
        isSecret: body.isSecret === true,
      })
      sendJson(res, 200, result)
      return
    }

    const envDelMatch = /^\/api\/sites\/([^/]+)\/env\/([^/]+)$/.exec(pathname)
    if (envDelMatch) {
      if (method !== 'DELETE') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method ${method} not allowed`, {
          extraHeaders: { Allow: 'DELETE' },
        })
      }
      const slug = decodePathSegment(envDelMatch[1]!)
      const envKey = decodePathSegment(envDelMatch[2]!)
      const envVars = await deps.sites.deleteEnvVar(userId, slug, envKey)
      sendJson(res, 200, { ok: true, envVars })
      return
    }

    const analyticsMatch = /^\/api\/sites\/([^/]+)\/analytics$/.exec(pathname)
    if (analyticsMatch) {
      if (method !== 'GET') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method ${method} not allowed`, {
          extraHeaders: { Allow: 'GET' },
        })
      }
      const slug = decodePathSegment(analyticsMatch[1]!)
      const daysRaw = Number.parseInt(url.searchParams.get('days') ?? '30', 10)
      const analytics = await deps.sites.getAnalytics(
        userId,
        slug,
        Number.isFinite(daysRaw) ? daysRaw : 30,
      )
      sendJson(res, 200, { analytics })
      return
    }

    const dbMatch = /^\/api\/sites\/([^/]+)\/db$/.exec(pathname)
    if (dbMatch) {
      if (method !== 'GET') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method ${method} not allowed`, {
          extraHeaders: { Allow: 'GET' },
        })
      }
      const slug = decodePathSegment(dbMatch[1]!)
      const table = url.searchParams.get('table') ?? undefined
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
      const db = await deps.sites.inspectDb(userId, slug, {
        table,
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
      })
      sendJson(res, 200, { db })
      return
    }

    const match = /^\/api\/sites\/([^/]+)$/.exec(pathname)
    if (!match) {
      throw new HttpError(404, 'NOT_FOUND', 'site route not found')
    }
    const slug = decodePathSegment(match[1]!)

    if (method === 'GET') {
      const site = await deps.sites.getSite(userId, slug)
      const envVars = await deps.sites.listEnvVars(userId, slug)
      sendJson(res, 200, { site, envVars })
      return
    }
    if (method === 'PATCH') {
      const patch = await readJsonObject(req)
      if (
        patch.customDomain !== undefined &&
        patch.customDomain !== null &&
        typeof patch.customDomain !== 'string'
      ) {
        throw new HttpError(400, 'INVALID_INPUT', 'customDomain must be string or null')
      }
      const site = await deps.sites.updateSite(userId, slug, {
        ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
        ...(patch.visibility !== undefined
          ? { visibility: patch.visibility as 'public' | 'password' | 'disabled' }
          : {}),
        ...(patch.password !== undefined ? { password: String(patch.password) } : {}),
        ...(patch.spaMode !== undefined
          ? {
              spaMode:
                typeof patch.spaMode === 'boolean'
                  ? patch.spaMode
                  : (() => {
                      throw new HttpError(400, 'INVALID_INPUT', 'spaMode must be boolean')
                    })(),
            }
          : {}),
        ...(patch.customDomain !== undefined
          ? { customDomain: patch.customDomain as string | null }
          : {}),
      })
      sendJson(res, 200, { site })
      return
    }
    if (method === 'DELETE') {
      sendJson(res, 200, await deps.sites.deleteSite(userId, slug))
      return
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method ${method} not allowed`, {
      extraHeaders: { Allow: 'GET, PATCH, DELETE' },
    })
  } catch (err) {
    if (err instanceof HttpError) throw err
    mapSitesErrorToHttp(err)
  }
}
