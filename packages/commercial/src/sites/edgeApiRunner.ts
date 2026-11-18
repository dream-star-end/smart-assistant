import { basename, dirname, join } from 'node:path'
import {
  SANDBOX_DEFAULT_API_TIMEOUT_MS,
  SANDBOX_MAX_OUTPUT_BYTES,
  runInSiteSandbox,
} from './edgeSandbox.js'
import { SitesError } from './types.js'

export interface SiteApiInvocationRequest {
  slug?: string
  siteDir: string
  entryFilePath: string
  revision: number
  method: string
  url: string
  pathname: string
  query: Record<string, string>
  headers: Record<string, string>
  body: Buffer
  env: Record<string, string>
  timeoutMs?: number
  maxResponseBytes?: number
  allowPrivateFetchForTest?: boolean
  signal?: AbortSignal
  preAdmitted?: boolean
}

export interface SiteApiInvocationResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export async function runSiteApiWorker(
  req: SiteApiInvocationRequest,
): Promise<SiteApiInvocationResponse> {
  const timeoutMs = req.timeoutMs ?? SANDBOX_DEFAULT_API_TIMEOUT_MS
  const maxResponseBytes = req.maxResponseBytes ?? SANDBOX_MAX_OUTPUT_BYTES
  const slug = req.slug?.trim() || 'site'
  const serverDir = dirname(req.entryFilePath)
  const entryBasename = basename(req.entryFilePath)
  const siteDataDir = join(req.siteDir, 'data')

  try {
    const out = (await runInSiteSandbox({
      slug,
      mode: 'api',
      serverDir,
      siteDataDir,
      timeoutMs,
      maxResponseBytes,
      allowPrivateFetch: Boolean(req.allowPrivateFetchForTest),
      signal: req.signal,
      preAdmitted: Boolean(req.preAdmitted),
      initPayload: {
        slug,
        entryBasename,
        revision: req.revision,
        method: req.method,
        url: req.url,
        pathname: req.pathname,
        query: req.query,
        headers: req.headers,
        bodyBase64: req.body.toString('base64'),
        env: req.env,
        maxResponseBytes,
      },
    })) as SiteApiInvocationResponse
    return out
  } catch (err) {
    if (err instanceof SitesError) {
      return {
        status: err.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ error: { code: err.code, message: err.message } }), 'utf8'),
      }
    }
    const msg = (err as Error)?.message || 'Site API execution failed'
    if (msg === 'API_TIMEOUT') {
      return {
        status: 504,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ error: 'Site API execution timed out' }), 'utf8'),
      }
    }
    if (msg === 'API_ABORTED') {
      return {
        status: 499,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ error: 'Client closed connection' }), 'utf8'),
      }
    }
    if (msg === 'SANDBOX_OOM') {
      return {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ error: 'Site API memory limit exceeded' }), 'utf8'),
      }
    }
    return {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(JSON.stringify({ error: msg }), 'utf8'),
    }
  }
}
