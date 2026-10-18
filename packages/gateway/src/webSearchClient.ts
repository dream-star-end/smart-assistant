import { resolveConnectorEndpoint } from './ocConnectorsClient.js'

export type WebSearchHit = { title: string; url: string; snippet: string; date?: string }
export type WebSearchResult = { ok: true; results: WebSearchHit[] } | { ok: false; error: string }

function hitsFrom(body: unknown): WebSearchHit[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { organic?: unknown }).organic)) return []
  const hits: WebSearchHit[] = []
  for (const row of (body as { organic: unknown[] }).organic) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    if (typeof item.title !== 'string' || !item.title.trim() || typeof item.url !== 'string') continue
    try { if (!['http:', 'https:'].includes(new URL(item.url).protocol)) continue } catch { continue }
    hits.push({ title: item.title.slice(0, 512), url: item.url, snippet: typeof item.snippet === 'string' ? item.snippet.slice(0, 4000) : '', ...(typeof item.date === 'string' ? { date: item.date.slice(0, 80) } : {}) })
    if (hits.length === 10) break
  }
  return hits
}

/** Search through the existing authenticated master proxies; provider keys stay on the master. */
export async function searchWeb(query: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<WebSearchResult> {
  let endpoint: ReturnType<typeof resolveConnectorEndpoint>
  try { endpoint = resolveConnectorEndpoint(env) } catch {
    return { ok: false, error: 'Search is unavailable: container identity is not configured.' }
  }
  for (const path of ['/internal/v3/minimax-search', '/internal/v3/grok-search']) {
    try {
      const response = await fetch(`${endpoint.masterBaseUrl}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${endpoint.containerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query }),
      })
      if (!response.ok) { await response.body?.cancel(); continue }
      const results = hitsFrom(await response.json())
      if (results.length) return { ok: true, results }
    } catch { /* Try the next existing search source; never echo credentials or raw upstream errors. */ }
  }
  return { ok: false, error: 'Search returned no usable results. Try another query or retry later.' }
}
