import type { IncomingMessage, ServerResponse } from 'node:http'
import { SITES_AGENT_INTERNAL_PREFIX } from '@openclaude/protocol'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  sendError,
  sendJson,
  setSecurityHeaders,
} from '../http/util.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import type { SitesService } from './service.js'
import { SitesError, type SiteVisibility } from './types.js'

export interface SitesInternalDeps {
  identityRepo: ContainerIdentityRepo
  sites: SitesService
  logger?: Logger
}

export type SitesInternalHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
) => Promise<void>

const JSON_MAX_BYTES = 64 * 1024

async function readBoundedBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new SitesError('INVALID_BUNDLE', `请求体超过 ${maxBytes} 字节上限`, 413)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function parseMetaHeader(headerVal: string | string[] | undefined): Record<string, unknown> {
  const raw = typeof headerVal === 'string' ? headerVal : Array.isArray(headerVal) ? headerVal[0] : ''
  if (!raw) return {}
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new SitesError('INVALID_INPUT', 'x-oc-site-meta 格式不合法', 400)
  }
}

export function makeSitesInternalHandler(deps: SitesInternalDeps): SitesInternalHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'sitesInternal' })
  const prefixNoSlash = SITES_AGENT_INTERNAL_PREFIX.replace(/\/$/, '')

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    const url = new URL(req.url ?? '/', 'http://x.invalid')
    const sub = url.pathname.startsWith(prefixNoSlash)
      ? url.pathname.slice(prefixNoSlash.length) || '/'
      : url.pathname
    const method = req.method ?? 'GET'

    try {
      let userId: number
      try {
        const identity = await verifyContainerIdentity(
          deps.identityRepo,
          ctx,
          req.headers.authorization,
        )
        userId = identity.userId
      } catch (err) {
        if (err instanceof ContainerIdentityError) {
          log.warn('identity_failed', { errcode: err.code })
          throw new HttpError(401, 'UNAUTHORIZED', 'container identity verification failed')
        }
        throw err
      }

      if (method === 'GET' && sub === '/list') {
        sendJson(res, 200, await deps.sites.listSummary(userId))
        return
      }

      if (method === 'GET' && sub === '/detail') {
        const slug = url.searchParams.get('slug') ?? ''
        sendJson(res, 200, { site: await deps.sites.getSite(userId, slug) })
        return
      }

      if (method === 'POST' && sub === '/publish') {
        const meta = parseMetaHeader(req.headers['x-oc-site-meta'])
        const body = await readBoundedBuffer(req, deps.sites.maxSiteBytes + 4 * 1024 * 1024)
        const slug =
          typeof meta.slug === 'string' ? meta.slug : (url.searchParams.get('slug') ?? undefined)
        const title =
          typeof meta.title === 'string' ? meta.title : (url.searchParams.get('title') ?? undefined)
        const visibilityRaw = meta.visibility ?? url.searchParams.get('visibility') ?? undefined
        const password =
          typeof meta.password === 'string'
            ? meta.password
            : (url.searchParams.get('password') ?? undefined)
        const spaMode =
          typeof meta.spaMode === 'boolean'
            ? meta.spaMode
            : url.searchParams.has('spa')
              ? url.searchParams.get('spa') !== '0'
              : undefined

        const site = await deps.sites.publishSite(userId, {
          slug,
          title,
          visibility: visibilityRaw as SiteVisibility | undefined,
          password,
          spaMode,
          gzippedBundle: body,
        })
        sendJson(res, 200, { site })
        return
      }

      if (method === 'PATCH' && sub === '/item') {
        const slug = url.searchParams.get('slug') ?? ''
        const buf = await readBoundedBuffer(req, JSON_MAX_BYTES)
        let raw: unknown
        try {
          raw = JSON.parse(buf.toString('utf8'))
        } catch {
          throw new SitesError('INVALID_INPUT', '请求体必须是合法 JSON', 400)
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new SitesError('INVALID_INPUT', '请求体必须是 JSON 对象', 400)
        }
        const patch = raw as Record<string, unknown>
        if (patch.spaMode !== undefined && typeof patch.spaMode !== 'boolean') {
          throw new SitesError('INVALID_INPUT', 'spaMode 必须是布尔值', 400)
        }
        const site = await deps.sites.updateSite(userId, slug, {
          ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
          ...(patch.visibility !== undefined
            ? { visibility: patch.visibility as SiteVisibility }
            : {}),
          ...(patch.password !== undefined ? { password: String(patch.password) } : {}),
          ...(patch.spaMode !== undefined ? { spaMode: patch.spaMode as boolean } : {}),
        })
        sendJson(res, 200, { site })
        return
      }

      if (method === 'DELETE' && sub === '/item') {
        const slug = url.searchParams.get('slug') ?? ''
        sendJson(res, 200, await deps.sites.deleteSite(userId, slug))
        return
      }

      throw new HttpError(404, 'NOT_FOUND', 'sites internal route not found')
    } catch (err) {
      if (err instanceof SitesError) {
        sendError(
          res,
          err.status,
          err.code,
          err.message,
          requestId,
          undefined,
          undefined,
          err.retryable ? { retrySafe: 'safe' } : undefined,
        )
        return
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId)
        return
      }
      log.error('sites_internal_error', { err: (err as Error)?.message })
      sendError(res, 500, 'INTERNAL', 'internal server error', requestId)
    }
  }
}
