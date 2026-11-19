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

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
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
  return raw as Record<string, unknown>
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

      if (method === 'GET' && sub === '/pull') {
        const slug = url.searchParams.get('slug') ?? ''
        const { site, gzippedBundle } = await deps.sites.pullSiteBundle(userId, slug)
        const metaB64 = Buffer.from(
          JSON.stringify({
            siteId: site.id,
            slug: site.slug,
            title: site.title,
            edgeRevision: site.edgeRevision,
            contentSha256: site.contentSha256,
            hasServerApi: site.hasServerApi,
            accessRole: site.accessRole,
          }),
          'utf8',
        ).toString('base64url')
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/x-oc-site-bundle')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('x-oc-site-meta', metaB64)
        res.setHeader('Content-Length', String(gzippedBundle.length))
        res.end(gzippedBundle)
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
        const originSessionId =
          typeof meta.originSessionId === 'string' && meta.originSessionId.trim()
            ? meta.originSessionId.trim().slice(0, 200)
            : null

        let expectedSiteId: string | undefined
        if (meta.expectedSiteId !== undefined && meta.expectedSiteId !== null) {
          if (
            typeof meta.expectedSiteId !== 'string' ||
            meta.expectedSiteId.trim().length < 8 ||
            meta.expectedSiteId.trim().length > 64
          ) {
            throw new SitesError('INVALID_INPUT', 'expectedSiteId 格式不合法', 400)
          }
          expectedSiteId = meta.expectedSiteId.trim()
        }
        let expectedBaseRevision: number | undefined
        if (meta.expectedBaseRevision !== undefined && meta.expectedBaseRevision !== null) {
          const parsedRev = Number(meta.expectedBaseRevision)
          if (!Number.isSafeInteger(parsedRev) || parsedRev < 1) {
            throw new SitesError('INVALID_INPUT', 'expectedBaseRevision 必须是正整数', 400)
          }
          expectedBaseRevision = parsedRev
        }
        let expectedBaseContentSha256: string | undefined
        if (
          meta.expectedBaseContentSha256 !== undefined &&
          meta.expectedBaseContentSha256 !== null
        ) {
          if (
            typeof meta.expectedBaseContentSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(meta.expectedBaseContentSha256)
          ) {
            throw new SitesError(
              'INVALID_INPUT',
              'expectedBaseContentSha256 必须是 64 位小写十六进制 SHA-256',
              400,
            )
          }
          expectedBaseContentSha256 = meta.expectedBaseContentSha256
        }

        const site = await deps.sites.publishSite(userId, {
          slug,
          title,
          visibility: visibilityRaw as SiteVisibility | undefined,
          password,
          spaMode,
          originSessionId,
          ...(expectedSiteId !== undefined ? { expectedSiteId } : {}),
          ...(expectedBaseRevision !== undefined ? { expectedBaseRevision } : {}),
          ...(expectedBaseContentSha256 !== undefined ? { expectedBaseContentSha256 } : {}),
          gzippedBundle: body,
        })
        sendJson(res, 200, { site })
        return
      }

      if (method === 'PATCH' && sub === '/item') {
        const slug = url.searchParams.get('slug') ?? ''
        const patch = await readJsonObject(req)
        if (patch.spaMode !== undefined && typeof patch.spaMode !== 'boolean') {
          throw new SitesError('INVALID_INPUT', 'spaMode 必须是布尔值', 400)
        }
        if (
          patch.customDomain !== undefined &&
          patch.customDomain !== null &&
          typeof patch.customDomain !== 'string'
        ) {
          throw new SitesError('INVALID_INPUT', 'customDomain 必须是字符串或 null', 400)
        }
        const site = await deps.sites.updateSite(userId, slug, {
          ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
          ...(patch.visibility !== undefined
            ? { visibility: patch.visibility as SiteVisibility }
            : {}),
          ...(patch.password !== undefined ? { password: String(patch.password) } : {}),
          ...(patch.spaMode !== undefined ? { spaMode: patch.spaMode as boolean } : {}),
          ...(patch.customDomain !== undefined
            ? { customDomain: patch.customDomain as string | null }
            : {}),
        })
        sendJson(res, 200, { site })
        return
      }

      if (method === 'POST' && sub === '/rename') {
        const slug = url.searchParams.get('slug') ?? ''
        const body = await readJsonObject(req)
        const site = await deps.sites.renameSite(
          userId,
          slug,
          typeof body.newSlug === 'string' ? body.newSlug : '',
        )
        sendJson(res, 200, { site })
        return
      }

      if (method === 'POST' && sub === '/verify-domain') {
        const slug = url.searchParams.get('slug') ?? ''
        const site = await deps.sites.verifyCustomDomain(userId, slug)
        sendJson(res, 200, { site })
        return
      }

      if (method === 'GET' && sub === '/env/list') {
        const slug = url.searchParams.get('slug') ?? ''
        sendJson(res, 200, { envVars: await deps.sites.listEnvVars(userId, slug) })
        return
      }

      if (method === 'PUT' && sub === '/env/set') {
        const slug = url.searchParams.get('slug') ?? ''
        const body = await readJsonObject(req)
        if (typeof body.key !== 'string' || typeof body.value !== 'string') {
          throw new SitesError('INVALID_INPUT', 'key 和 value 必须是字符串', 400)
        }
        const result = await deps.sites.setEnvVar(userId, slug, {
          key: body.key,
          value: body.value,
          isSecret: body.isSecret === true,
        })
        sendJson(res, 200, result)
        return
      }

      if (method === 'DELETE' && sub === '/env/unset') {
        const slug = url.searchParams.get('slug') ?? ''
        const key = url.searchParams.get('key') ?? ''
        const envVars = await deps.sites.deleteEnvVar(userId, slug, key)
        sendJson(res, 200, { ok: true, envVars })
        return
      }

      if (method === 'GET' && sub === '/analytics') {
        const slug = url.searchParams.get('slug') ?? ''
        const days = Number.parseInt(url.searchParams.get('days') ?? '30', 10)
        sendJson(res, 200, {
          analytics: await deps.sites.getAnalytics(userId, slug, Number.isFinite(days) ? days : 30),
        })
        return
      }

      if (method === 'GET' && sub === '/db/inspect') {
        const slug = url.searchParams.get('slug') ?? ''
        const table = url.searchParams.get('table') ?? undefined
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
        sendJson(res, 200, {
          db: await deps.sites.inspectDb(userId, slug, {
            table,
            limit: Number.isFinite(limit) ? limit : 100,
          }),
        })
        return
      }

      if (method === 'POST' && sub === '/db/sql') {
        const slug = url.searchParams.get('slug') ?? ''
        const body = await readJsonObject(req)
        if (typeof body.sql !== 'string') {
          throw new SitesError('INVALID_INPUT', 'sql 必须是字符串', 400)
        }
        const params = Array.isArray(body.params) ? body.params : []
        const result = await deps.sites.executeDbSql(userId, slug, {
          sql: body.sql,
          params,
        })
        sendJson(res, 200, { result })
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
