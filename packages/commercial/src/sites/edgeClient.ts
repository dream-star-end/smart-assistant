import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  type EdgeMetaEnvelope,
  SITE_EDGE_PREFIX,
  SitesError,
  signEdgeHeaders,
} from './types.js'

export interface SitesEdgeClient {
  pushBundle(args: {
    slug: string
    revision: number
    gzippedBundle: Buffer
    meta: EdgeMetaEnvelope
  }): Promise<void>
  updateMeta(args: {
    slug: string
    revision: number
    meta: EdgeMetaEnvelope
  }): Promise<void>
  deleteSite(args: {
    slug: string
    revision: number
  }): Promise<void>
}

const EDGE_REQUEST_TIMEOUT_MS = 30_000
const MAX_ERROR_BODY_BYTES = 16 * 1024

export function createHttpSitesEdgeClient(opts: {
  baseUrl: string
  secret: string
  timeoutMs?: number
}): SitesEdgeClient {
  const baseUrl = new URL(opts.baseUrl)
  const basePath = baseUrl.pathname.replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? EDGE_REQUEST_TIMEOUT_MS

  async function sendSigned(args: {
    method: 'PUT' | 'PATCH' | 'DELETE'
    subPath: string
    revision: number
    body: Buffer
    contentType?: string
    meta?: EdgeMetaEnvelope
  }): Promise<void> {
    const pathname = `${basePath}${SITE_EDGE_PREFIX}${args.subPath}`
    const target = new URL(pathname, baseUrl)
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
              if (total < MAX_ERROR_BODY_BYTES) {
                const slice = chunk.subarray(0, MAX_ERROR_BODY_BYTES - total)
                chunks.push(slice)
                total += slice.length
              }
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

    if (status >= 200 && status < 300) return

    let parsedCode = ''
    let parsedMsg = ''
    try {
      const parsed = JSON.parse(rawBody) as { error?: { code?: string; message?: string } }
      parsedCode = parsed.error?.code ?? ''
      parsedMsg = parsed.error?.message ?? ''
    } catch {
      /* ignore non-JSON body */
    }
    if (status === 409 || parsedCode === 'STALE_REVISION') {
      throw new SitesError(
        'STALE_REVISION',
        parsedMsg || '站点存在更晚的发布版本，请刷新后重试',
        409,
        false,
      )
    }
    if (status >= 400 && status < 500) {
      throw new SitesError(
        'INVALID_INPUT',
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
    pushBundle({ slug, revision, gzippedBundle, meta }) {
      return sendSigned({
        method: 'PUT',
        subPath: `/sites/${encodeURIComponent(slug)}`,
        revision,
        body: gzippedBundle,
        contentType: 'application/x-oc-site-bundle',
        meta,
      })
    },
    updateMeta({ slug, revision, meta }) {
      const body = Buffer.from(JSON.stringify(meta), 'utf8')
      return sendSigned({
        method: 'PATCH',
        subPath: `/sites/${encodeURIComponent(slug)}/meta`,
        revision,
        body,
        contentType: 'application/json; charset=utf-8',
        meta,
      })
    },
    deleteSite({ slug, revision }) {
      return sendSigned({
        method: 'DELETE',
        subPath: `/sites/${encodeURIComponent(slug)}`,
        revision,
        body: Buffer.alloc(0),
      })
    },
  }
}
