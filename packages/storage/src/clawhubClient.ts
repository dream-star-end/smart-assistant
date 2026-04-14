/**
 * ClawHub REST API client — talks to the public ClawHub registry (clawhub.ai).
 *
 * Endpoints:
 *   GET  /api/v1/search?q=...        — vector-powered skill search
 *   GET  /api/v1/resolve?slug=...    — resolve slug to latest version info
 *   GET  /api/v1/skills/:slug        — full skill metadata
 *   GET  /download?slug=...&version= — download skill as zip
 *
 * No authentication required for read-only operations (search/download).
 */

export const CLAWHUB_REGISTRY =
  process.env.CLAWHUB_REGISTRY || 'https://clawhub.ai'

export interface HubSearchResult {
  slug: string
  displayName: string
  version: string
  description?: string
  relevanceScore?: number
}

export interface HubSkillDetail {
  slug: string
  displayName: string
  description: string
  version: string
  tags?: string[]
  downloads?: number
  stars?: number
  license?: string
  createdAt?: string
  updatedAt?: string
}

export interface HubResolveResult {
  slug: string
  version: string
  files: Array<{ path: string; size: number; sha256?: string }>
}

async function hubFetch<T>(path: string, timeout = 15_000): Promise<T> {
  const url = `${CLAWHUB_REGISTRY}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ClawHub API ${res.status}: ${body.slice(0, 200)}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Search ClawHub for skills matching a query.
 */
export async function hubSearch(
  query: string,
  limit = 10,
): Promise<HubSearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  const data = await hubFetch<any>(`/api/v1/search?${params}`)
  // Normalize: API may return { results: [...] } or array directly
  const results: any[] = Array.isArray(data) ? data : data.results ?? data.skills ?? []
  return results.slice(0, limit).map((r: any) => ({
    slug: r.slug ?? r.name,
    displayName: r.displayName ?? r.display_name ?? r.slug ?? r.name,
    version: r.version ?? r.latestVersion ?? 'latest',
    description: r.description ?? r.summary ?? '',
    relevanceScore: r.relevanceScore ?? r.score,
  }))
}

/**
 * Resolve a skill slug to its latest version metadata.
 */
export async function hubResolve(
  slug: string,
  version?: string,
): Promise<HubResolveResult> {
  const params = new URLSearchParams({ slug })
  if (version) params.set('version', version)
  return hubFetch<HubResolveResult>(`/api/v1/resolve?${params}`)
}

/**
 * Get full detail for a skill by slug.
 */
export async function hubDetail(slug: string): Promise<HubSkillDetail> {
  return hubFetch<HubSkillDetail>(`/api/v1/skills/${encodeURIComponent(slug)}`)
}

/**
 * Download a skill zip and return the raw Buffer.
 */
export async function hubDownload(
  slug: string,
  version?: string,
): Promise<Buffer> {
  const params = new URLSearchParams({ slug })
  if (version) params.set('version', version)
  const url = `${CLAWHUB_REGISTRY}/api/v1/download?${params}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000) // 60s for downloads
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ClawHub download ${res.status}: ${body.slice(0, 200)}`)
    }
    const arrayBuf = await res.arrayBuffer()
    return Buffer.from(arrayBuf)
  } finally {
    clearTimeout(timer)
  }
}
