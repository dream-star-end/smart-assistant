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

    const match = /^\/api\/sites\/([^/]+)$/.exec(pathname)
    if (!match) {
      throw new HttpError(404, 'NOT_FOUND', 'site route not found')
    }
    let slug: string
    try {
      slug = decodeURIComponent(match[1]!)
    } catch {
      throw new SitesError('INVALID_SLUG', 'invalid slug encoding', 400)
    }

    if (method === 'GET') {
      sendJson(res, 200, { site: await deps.sites.getSite(userId, slug) })
      return
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'BAD_REQUEST', 'request body must be a JSON object')
      }
      const patch = body as Record<string, unknown>
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
