import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  type EdgeMetaEnvelope,
  SITE_EDGE_PREFIX,
  SITE_EDGE_V2_PREFIX,
  type SiteAnalyticsResponse,
  type SiteDbInspectResponse,
  type SiteDbQueryResponse,
  type SiteVisibility,
  SitesError,
  signEdgeHeaders,
} from './types.js'

export interface EdgeSiteStatusMeta {
  siteId?: string | null
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  customDomain: string | null
  hasServerApi: boolean
  envDigest?: string
  fileCount: number
  sizeBytes: number
  contentSha256: string
}

export interface EdgeSiteTombstoneInfo {
  revision: number
  siteId: string | null
  op: 'delete' | 'rename'
  renamedTo: string | null
}

export interface EdgeSiteRetiredInfo {
  siteId: string
  revision: number
  op: 'delete' | 'rename'
  renamedTo: string | null
}

export interface EdgeSiteStatus {
  exists: boolean
  revision: number
  tombstoneRevision: number
  tombstone?: EdgeSiteTombstoneInfo
  retired?: EdgeSiteRetiredInfo
  meta?: EdgeSiteStatusMeta
}

export interface SitesEdgeClient {
  pushBundle(args: {
    slug: string
    revision: number
    gzippedBundle: Buffer
    meta: EdgeMetaEnvelope
    hasServerApi?: boolean
  }): Promise<{ needsEnvSync?: boolean; envDigest?: string }>
  updateMeta(args: {
    slug: string
    revision: number
    meta: EdgeMetaEnvelope
    encryptedEnvB64?: string
  }): Promise<void>
  syncEnv?(args: {
    slug: string
    siteId: string
    revision: number
    expectedBaseRevision: number
    envDigest: string
    encryptedEnvB64: string
  }): Promise<void>
  deleteSite(args: {
    slug: string
    siteId?: string
    revision: number
  }): Promise<void>
  renameSite(args: {
    slug: string
    siteId?: string
    newSlug: string
    revision: number
    expectedBaseRevision: number
  }): Promise<void>
  getAnalytics(args: {
    slug: string
    siteId?: string
    expectedRevision?: number
    days?: number
  }): Promise<SiteAnalyticsResponse>
  inspectDb(args: {
    slug: string
    siteId?: string
    expectedRevision?: number
    table?: string
    limit?: number
  }): Promise<SiteDbInspectResponse>
  executeDbSql(args: {
    slug: string
    siteId?: string
    expectedRevision?: number
    sql: string
    params?: unknown[]
  }): Promise<SiteDbQueryResponse>
  getSiteStatus(args: { slug: string; siteId?: string }): Promise<EdgeSiteStatus>
}

const EDGE_REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024

function makeIdentityMeta(args: { siteId?: string; expectedRevision?: number; envDigest?: string }): EdgeMetaEnvelope | undefined {
  if (!args.siteId && args.expectedRevision === undefined && args.envDigest === undefined) {
    return undefined
  }
  return {
    ...(args.siteId ? { siteId: args.siteId } : {}),
    title: '',
    visibility: 'public',
    passwordSalt: null,
    passwordHash: null,
    spaMode: true,
    ...(args.envDigest !== undefined ? { envDigest: args.envDigest } : {}),
    ...(args.expectedRevision !== undefined ? { expectedBaseRevision: args.expectedRevision } : {}),
  }
}

export function createHttpSitesEdgeClient(opts: {
  baseUrl: string
  secret: string
  timeoutMs?: number
}): SitesEdgeClient {
  const baseUrl = new URL(opts.baseUrl)
  const basePath = baseUrl.pathname.replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? EDGE_REQUEST_TIMEOUT_MS

  async function sendSigned(args: {
    prefix?: string
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    subPath: string
    query?: string
    revision: number
    body: Buffer
    contentType?: string
    meta?: EdgeMetaEnvelope
  }): Promise<string> {
    const prefix = args.prefix ?? SITE_EDGE_PREFIX
    const pathname = `${basePath}${prefix}${args.subPath}`
    const target = new URL(`${pathname}${args.query ? `?${args.query}` : ''}`, baseUrl)
    const signedHeaders = signEdgeHeaders({
      secret: opts.secret,
      method: args.method,
      pathname: target.pathname,
      revision: args.revision,
      body: args.body,
      meta: args.meta,
    })

    const headers: Record<string, string> = {
      ...signedHeaders,
      'content-length': String(args.body.length),
    }
    if (args.contentType) {
      headers['content-type'] = args.contentType
    }

    const doReq = target.protocol === 'https:' ? httpsRequest : httpRequest

    const { status, rawBody } = await new Promise<{ status: number; rawBody: string }>(
      (resolve, reject) => {
        const req = doReq(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            method: args.method,
            path: target.pathname + target.search,
            headers,
          },
          (res) => {
            const chunks: Buffer[] = []
            let total = 0
            res.on('data', (chunk: Buffer) => {
              total += chunk.length
              if (total > MAX_RESPONSE_BODY_BYTES) {
                req.destroy(new Error('edge response exceeded size limit'))
                return
              }
              chunks.push(chunk)
            })
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 502,
                rawBody: Buffer.concat(chunks).toString('utf8'),
              })
            })
            res.on('error', (err) => reject(err))
          },
        )
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error('edge request timed out'))
        })
        req.on('error', (err) => reject(err))
        if (args.body.length > 0) {
          req.write(args.body)
        }
        req.end()
      },
    ).catch((err) => {
      throw new SitesError(
        'EDGE_UNAVAILABLE',
        `站点边缘服务不可达: ${(err as Error).message}`,
        502,
        true,
      )
    })

    if (status >= 200 && status < 300) return rawBody

    let parsedCode = ''
    let parsedMsg = ''
    try {
      const parsed = JSON.parse(rawBody) as { error?: { code?: string; message?: string } }
      parsedCode = parsed.error?.code ?? ''
      parsedMsg = parsed.error?.message ?? ''
    } catch {
      /* ignore non-JSON body */
    }
    if (status === 409) {
      if (parsedCode === 'DOMAIN_TAKEN') {
        throw new SitesError('DOMAIN_TAKEN', parsedMsg || '该自定义域名已被占用', 409, false)
      }
      if (parsedCode === 'SLUG_TAKEN') {
        throw new SitesError('SLUG_TAKEN', parsedMsg || '该子域名已被占用', 409, false)
      }
      if (parsedCode === 'SLUG_BUSY') {
        throw new SitesError('SLUG_BUSY', parsedMsg || '站点请求繁忙', 409, true)
      }
      throw new SitesError(
        'STALE_REVISION',
        parsedMsg || '站点存在更晚的发布版本，请刷新后重试',
        409,
        false,
      )
    }
    if (status === 429) {
      throw new SitesError('SLUG_BUSY', parsedMsg || '站点请求繁忙，请稍后重试', 429, true)
    }
    if (status >= 400 && status < 500) {
      throw new SitesError(
        parsedCode === 'SITE_NOT_FOUND' ? 'SITE_NOT_FOUND' : 'INVALID_INPUT',
        parsedMsg || `边缘节点拒绝请求 (HTTP ${status})`,
        status,
        false,
      )
    }
    throw new SitesError(
      'EDGE_UNAVAILABLE',
      parsedMsg || `站点边缘节点异常 (HTTP ${status})`,
      502,
      true,
    )
  }

  return {
    async pushBundle({ slug, revision, gzippedBundle, meta, hasServerApi }) {
      const useV2 = Boolean(hasServerApi ?? meta.hasServerApi)
      const raw = await sendSigned({
        prefix: useV2 ? SITE_EDGE_V2_PREFIX : SITE_EDGE_PREFIX,
        method: 'PUT',
        subPath: `/sites/${encodeURIComponent(slug)}`,
        revision,
        body: gzippedBundle,
        contentType: 'application/x-oc-site-bundle',
        meta,
      })
      try {
        const parsed = JSON.parse(raw) as { needsEnvSync?: boolean; envDigest?: string }
        return {
          ...(parsed.needsEnvSync ? { needsEnvSync: true } : {}),
          ...(typeof parsed.envDigest === 'string' ? { envDigest: parsed.envDigest } : {}),
        }
      } catch {
        return {}
      }
    },
    async updateMeta({ slug, revision, meta, encryptedEnvB64 }) {
      const bodyPayload =
        encryptedEnvB64 !== undefined ? { ...meta, encryptedEnvB64 } : meta
      const body = Buffer.from(JSON.stringify(bodyPayload), 'utf8')
      await sendSigned({
        method: 'PATCH',
        subPath: `/sites/${encodeURIComponent(slug)}/meta`,
        revision,
        body,
        contentType: 'application/json; charset=utf-8',
        meta,
      })
    },
    async syncEnv({ slug, siteId, revision, expectedBaseRevision, envDigest, encryptedEnvB64 }) {
      const body = Buffer.from(
        JSON.stringify({ siteId, expectedBaseRevision, envDigest, encryptedEnvB64 }),
        'utf8',
      )
      await sendSigned({
        method: 'PUT',
        subPath: `/sites/${encodeURIComponent(slug)}/env`,
        revision,
        body,
        contentType: 'application/json; charset=utf-8',
        meta: makeIdentityMeta({ siteId, expectedRevision: expectedBaseRevision, envDigest }),
      })
    },
    async deleteSite({ slug, siteId, revision }) {
      await sendSigned({
        method: 'DELETE',
        subPath: `/sites/${encodeURIComponent(slug)}`,
        revision,
        body: Buffer.alloc(0),
        meta: makeIdentityMeta({ siteId }),
      })
    },
    async renameSite({ slug, siteId, newSlug, revision, expectedBaseRevision }) {
      const body = Buffer.from(
        JSON.stringify({ siteId, newSlug, expectedBaseRevision }),
        'utf8',
      )
      await sendSigned({
        method: 'POST',
        subPath: `/sites/${encodeURIComponent(slug)}/rename`,
        revision,
        body,
        contentType: 'application/json; charset=utf-8',
        meta: makeIdentityMeta({ siteId, expectedRevision: expectedBaseRevision }),
      })
    },
    async getAnalytics({ slug, siteId, expectedRevision, days = 30 }) {
      const raw = await sendSigned({
        method: 'GET',
        subPath: `/sites/${encodeURIComponent(slug)}/analytics`,
        query: `days=${Math.max(1, Math.min(90, Math.trunc(days || 30)))}`,
        revision: 1,
        body: Buffer.alloc(0),
        meta: makeIdentityMeta({ siteId, expectedRevision }),
      })
      return JSON.parse(raw) as SiteAnalyticsResponse
    },
    async inspectDb({ slug, siteId, expectedRevision, table, limit = 100 }) {
      const params = new URLSearchParams()
      if (table) params.set('table', table)
      params.set('limit', String(limit))
      const raw = await sendSigned({
        method: 'GET',
        subPath: `/sites/${encodeURIComponent(slug)}/db`,
        query: params.toString(),
        revision: 1,
        body: Buffer.alloc(0),
        meta: makeIdentityMeta({ siteId, expectedRevision }),
      })
      return JSON.parse(raw) as SiteDbInspectResponse
    },
    async executeDbSql({ slug, siteId, expectedRevision, sql, params = [] }) {
      const body = Buffer.from(JSON.stringify({ siteId, expectedRevision, sql, params }), 'utf8')
      const raw = await sendSigned({
        method: 'POST',
        subPath: `/sites/${encodeURIComponent(slug)}/db/sql`,
        revision: 1,
        body,
        contentType: 'application/json; charset=utf-8',
        meta: makeIdentityMeta({ siteId, expectedRevision }),
      })
      return JSON.parse(raw) as SiteDbQueryResponse
    },
    async getSiteStatus({ slug, siteId }) {
      const raw = await sendSigned({
        method: 'GET',
        subPath: `/sites/${encodeURIComponent(slug)}`,
        ...(siteId ? { query: `siteId=${encodeURIComponent(siteId)}` } : {}),
        revision: 1,
        body: Buffer.alloc(0),
        meta: makeIdentityMeta({ siteId }),
      })
      const parsed = JSON.parse(raw) as EdgeSiteStatus
      return {
        exists: Boolean(parsed.exists),
        revision: Number(parsed.revision || 0),
        tombstoneRevision: Number(parsed.tombstoneRevision || 0),
        ...(parsed.tombstone && typeof parsed.tombstone === 'object'
          ? { tombstone: parsed.tombstone }
          : {}),
        ...(parsed.retired && typeof parsed.retired === 'object' ? { retired: parsed.retired } : {}),
        ...(parsed.meta && typeof parsed.meta === 'object' ? { meta: parsed.meta } : {}),
      }
    },
  }
}
