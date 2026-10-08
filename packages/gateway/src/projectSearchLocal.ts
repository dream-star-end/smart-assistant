/**
 * project_search (P5a): the container gateway side.
 *
 * openclaude-memory's `project_search` tool calls this gateway over loopback
 * with the gateway token (`GET /internal/v3/project-search-local`). The route
 * is not an `/api/*` path, so neither the browser proxy allowlist nor the
 * host bridge bypass can reach it, and a non-loopback caller is refused even
 * with a token.
 *
 * With a master (container env OPENCLAUDE_V3_MASTER_BASE_URL + container
 * token) the search is answered by `GET /internal/v3/project-search`, where
 * the tenant is the verified container identity. Without one (personal /
 * local sqlite) the same lookup runs against the local sessions backend.
 * Either way only the run's own project is searched.
 *
 * Results are turned into hits the agent can act on: the readable container
 * path (uploads resolve from their /api/media url like the excerpt extractor)
 * and a short snippet around the first match in the stored excerpt.
 */

import {
  getChatProjectBindByBoardProjectId,
  isProjectSearchEnabled,
  parseBoardProjectId,
  searchChatProjectAssets,
  stripProjectAssetControlChars,
  PROJECT_ASSET_PROJECT_SEARCH_LIMIT_DEFAULT,
  PROJECT_ASSET_PROJECT_SEARCH_LIMIT_MAX,
  PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX,
  type ProjectAsset,
  type ProjectAssetSource,
} from '@openclaude/storage'
import { PROJECT_SEARCH_LOCAL_PATH, PROJECT_SEARCH_PATH } from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'

import { resolveUploadExcerptPath } from './projectAssetCollector.js'
import { isLoopbackRemoteAddress } from './v3CodexRelay.js'

export { PROJECT_SEARCH_LOCAL_PATH, PROJECT_SEARCH_PATH }

const ENV_MASTER_URL = 'OPENCLAUDE_V3_MASTER_BASE_URL'
const ENV_CONTAINER_TOKEN = 'OPENCLAUDE_V3_CONTAINER_TOKEN'
const MASTER_TIMEOUT_MS = 8_000
/** Characters of excerpt kept on each side of the match. */
export const PROJECT_SEARCH_SNIPPET_RADIUS = 120

export interface ProjectSearchHit {
  name: string
  source: ProjectAssetSource
  /** Path the agent can Read in this container, or null when none is known. */
  path: string | null
  mime: string | null
  sizeBytes: number | null
  pinned: boolean
  snippet: string
  createdAt: number
}

export interface ProjectSearchLocalRequest {
  method: string
  url: string
  remoteAddress: string | null | undefined
  /** Gateway token check done by the server (same check as /api/*). */
  authorized: boolean
}

export interface ProjectSearchLocalResult {
  status: number
  body: unknown
}

export interface ProjectSearchLocalDeps {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  /** Local (no master) backend seams. */
  getBindByBoardProjectId?: typeof getChatProjectBindByBoardProjectId
  search?: typeof searchChatProjectAssets
}

function err(status: number, code: string, message: string): ProjectSearchLocalResult {
  return { status, body: { error: { code, message } } }
}

function oneLine(raw: string): string {
  return stripProjectAssetControlChars(raw).replace(/\s+/g, ' ').trim()
}

/** A short window of the excerpt around the first case-insensitive match. */
export function projectSearchSnippet(
  excerpt: string | null,
  query: string,
  radius = PROJECT_SEARCH_SNIPPET_RADIUS,
): string {
  const text = excerpt ? oneLine(excerpt) : ''
  if (!text) return ''
  const q = oneLine(query).toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (at < 0) {
    // Name-only hit: show the opening of the excerpt.
    const head = text.slice(0, radius * 2)
    return head.length < text.length ? `${head}…` : head
  }
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + q.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function projectSearchAssetPath(asset: Pick<ProjectAsset, 'source' | 'url' | 'containerPath'>): string | null {
  if (asset.source === 'upload') return resolveUploadExcerptPath(asset.url, asset.containerPath)
  return asset.containerPath ? oneLine(asset.containerPath) || null : null
}

export function buildProjectSearchHits(assets: readonly ProjectAsset[], query: string): ProjectSearchHit[] {
  return assets.map((a) => ({
    name: oneLine(a.name) || '未命名',
    source: a.source,
    path: projectSearchAssetPath(a),
    mime: a.mime ?? null,
    sizeBytes: a.sizeBytes ?? null,
    pinned: a.pinned === true,
    snippet: projectSearchSnippet(a.excerpt, query),
    createdAt: a.createdAt,
  }))
}

async function searchViaMaster(
  baseUrl: string,
  bearer: string,
  params: URLSearchParams,
  fetcher: typeof undiciRequest,
): Promise<{ ok: true; assets: ProjectAsset[] } | { ok: false; result: ProjectSearchLocalResult }> {
  const url = `${baseUrl.replace(/\/+$/, '')}${PROJECT_SEARCH_PATH}?${params.toString()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MASTER_TIMEOUT_MS)
  try {
    const res = await fetcher(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    })
    const text = await res.body.text().catch(() => '')
    if (res.statusCode === 404) {
      return { ok: false, result: err(404, 'PROJECT_NOT_FOUND', 'this run’s project was not found') }
    }
    if (res.statusCode !== 200) {
      return { ok: false, result: err(502, 'MASTER_ERROR', `project search failed upstream (${res.statusCode})`) }
    }
    const body = JSON.parse(text) as { assets?: unknown }
    if (!body || !Array.isArray(body.assets)) {
      return { ok: false, result: err(502, 'MASTER_ERROR', 'project search returned a bad response') }
    }
    return { ok: true, assets: body.assets as ProjectAsset[] }
  } catch {
    return {
      ok: false,
      result: err(502, 'MASTER_UNAVAILABLE', controller.signal.aborted ? 'project search timed out' : 'project search unavailable'),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function handleProjectSearchLocal(
  req: ProjectSearchLocalRequest,
  deps: ProjectSearchLocalDeps = {},
): Promise<ProjectSearchLocalResult> {
  const env = deps.env ?? process.env
  if (!isLoopbackRemoteAddress(req.remoteAddress)) return err(403, 'FORBIDDEN', 'project search is loopback-only')
  if (!req.authorized) return err(401, 'UNAUTHORIZED', 'gateway token required')
  if (!isProjectSearchEnabled(env)) return err(404, 'NOT_FOUND', 'project search is not enabled')
  if (req.method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'GET required')

  const url = new URL(req.url, 'http://127.0.0.1')
  const projectRaw = (url.searchParams.get('projectId') ?? '').trim()
  if (!projectRaw) return err(400, 'NO_PROJECT', 'this conversation is not in a project')
  const parsed = parseBoardProjectId(projectRaw)
  if (!('present' in parsed) || !parsed.present || !parsed.value) {
    return err(400, 'INVALID_PROJECT_ID', 'projectId must be a uuid')
  }
  const query = (url.searchParams.get('q') ?? '').trim()
  if (!query) return err(400, 'INVALID_QUERY', 'query must not be empty')
  if (query.length > PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX) {
    return err(400, 'INVALID_QUERY', `query is longer than ${PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX} chars`)
  }
  const sourceRaw = url.searchParams.get('source')
  let source: ProjectAssetSource | undefined
  if (sourceRaw === 'upload' || sourceRaw === 'output') source = sourceRaw
  else if (sourceRaw !== null && sourceRaw !== '') return err(400, 'INVALID_SOURCE', 'source must be upload or output')
  const limitRaw = Number(url.searchParams.get('limit') ?? '')
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1
    ? Math.min(PROJECT_ASSET_PROJECT_SEARCH_LIMIT_MAX, Math.floor(limitRaw))
    : PROJECT_ASSET_PROJECT_SEARCH_LIMIT_DEFAULT

  const baseUrl = env[ENV_MASTER_URL]
  const bearer = env[ENV_CONTAINER_TOKEN]
  let assets: ProjectAsset[]
  if (baseUrl && bearer) {
    const params = new URLSearchParams({ boardProjectId: parsed.value, q: query, limit: String(limit) })
    if (source) params.set('source', source)
    const read = await searchViaMaster(baseUrl, bearer, params, deps.fetcher ?? undiciRequest)
    if (!read.ok) return read.result
    assets = read.assets
  } else {
    // Personal / local sqlite: same owner fallback as projectContextRuntime.
    const getByBoard = deps.getBindByBoardProjectId ?? getChatProjectBindByBoardProjectId
    const search = deps.search ?? searchChatProjectAssets
    const userId = env.OC_USER_ID?.trim() || 'default'
    const bind =
      (await getByBoard(userId, parsed.value)) ??
      (userId !== 'default' ? await getByBoard('default', parsed.value) : null)
    if (!bind) return err(404, 'PROJECT_NOT_FOUND', 'this run’s project was not found')
    assets = await search(bind.userId, bind.chatProjectId, { q: query, limit, ...(source ? { source } : {}) })
  }
  return { status: 200, body: { hits: buildProjectSearchHits(assets.slice(0, limit), query) } }
}
