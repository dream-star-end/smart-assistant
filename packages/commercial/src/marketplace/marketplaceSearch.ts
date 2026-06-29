/**
 * GET /api/marketplace/search?q=…  — semantic search over the approved catalog.
 *
 * Reuses the live skill-embed infrastructure (same DashScope provider + the
 * shared skill_embedding_cache PG table + the storage ranking helpers). Runs
 * master-side (where the key + direct egress live). Fail-soft: any embedding
 * problem falls back to a deterministic keyword match so search never breaks.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  cleanSkillQuery,
  cosineSim,
  getSkillEmbeddingProvider,
  isSkillEmbeddingAvailable,
  skillEmbedText,
  skillEmbeddingBackendId,
  skillEmbeddingConfigFromEnv,
} from '@openclaude/storage'

import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'
import { requireAuth } from '../http/auth.js'
import { makePgSkillEmbedCache } from '../http/skillEmbedCachePg.js'
import { sendJson } from '../http/util.js'
import { type ApprovedSearchRow, type ArtifactKind, listApprovedForSearch } from './marketplaceDb.js'

const cache = makePgSkillEmbedCache()

function toCard(c: ApprovedSearchRow): {
  slug: string
  kind: string
  name: string
  description: string
  tags: string[]
} {
  return { slug: c.slug, kind: c.kind, name: c.name, description: c.description, tags: c.tags }
}

export async function handleMarketplaceSearch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  await requireAuth(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', 'http://internal')
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 4000)
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1),
    50,
  )
  const kindParam = url.searchParams.get('kind')
  // An explicit but unknown kind returns empty (not a silent fall-through to all).
  if (kindParam !== null && kindParam !== 'skill' && kindParam !== 'agent') {
    sendJson(res, 200, { results: [], method: 'all' })
    return
  }
  // 无 kind 参数 → 默认 'skill'(而非"全部")。市场起家是技能市场(0087),agent 是
  // 0092 才加的二级品类;v3 vanilla 的技能市场 UI 调 search 不带 kind,若 fall-through 到
  // "全部"会把 v5 专属 agent(如平台科研 agent)混进 v3 技能市场——而 v3 容器没有对应能力,
  // 装了即坏。v5 web-react BrowsePanel 每个分页都显式传 kind('skill'/'agent'),不受影响。
  // 共享 DB 下,这是"v5 专属 agent 不泄漏给 v3"收敛到单一权威的最小改。
  const kind: ArtifactKind = kindParam === 'agent' ? 'agent' : 'skill'

  const catalog = await listApprovedForSearch(kind)
  if (catalog.length === 0 || !q) {
    sendJson(res, 200, { results: catalog.slice(0, limit).map(toCard), method: 'all' })
    return
  }

  const keyword = (): unknown[] => {
    const ql = q.toLowerCase()
    return catalog
      .filter(
        (s) =>
          s.name.toLowerCase().includes(ql) ||
          s.description.toLowerCase().includes(ql) ||
          s.tags.some((t) => t.toLowerCase().includes(ql)),
      )
      .slice(0, limit)
      .map(toCard)
  }

  if (!isSkillEmbeddingAvailable()) {
    sendJson(res, 200, { results: keyword(), method: 'keyword' })
    return
  }

  try {
    const provider = getSkillEmbeddingProvider({
      ...skillEmbeddingConfigFromEnv(),
      dispatcher: directEgressDispatcher(),
    })
    const backendId = `${skillEmbeddingBackendId()}/${provider.modelId}`
    const dim = provider.dimensions

    const [qv] = await provider.embed([cleanSkillQuery(q)], 'query')
    if (!qv) throw new Error('empty query embedding')

    const hashes = [...new Set(catalog.map((c) => c.embeddingHash))]
    const cached = await cache.getMany(hashes, backendId, dim)
    const missing = catalog.filter((c) => !cached.has(c.embeddingHash))
    if (missing.length > 0) {
      const textByHash = new Map<string, string>()
      for (const c of missing)
        if (!textByHash.has(c.embeddingHash))
          textByHash.set(
            c.embeddingHash,
            skillEmbedText({ name: c.name, description: c.description, tags: c.tags }),
          )
      const missHashes = [...textByHash.keys()]
      const vecs = await provider.embed(
        missHashes.map((h) => textByHash.get(h) ?? ''),
        'document',
      )
      const toCache: Array<{ contentHash: string; vec: Float32Array }> = []
      for (let i = 0; i < missHashes.length; i++) {
        const v = vecs[i]
        if (!v) throw new Error('embed count mismatch')
        cached.set(missHashes[i], v)
        toCache.push({ contentHash: missHashes[i], vec: v })
      }
      await cache.putMany(toCache, backendId, dim).catch(() => {})
    }

    const ranked = catalog
      .map((c) => ({ c, score: cosineSim(qv, cached.get(c.embeddingHash) as Float32Array) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    sendJson(res, 200, {
      results: ranked.map((x) => ({ ...toCard(x.c), score: x.score })),
      method: 'embed',
    })
  } catch {
    // fail-soft → keyword (never break search on an embedding hiccup)
    sendJson(res, 200, { results: keyword(), method: 'keyword' })
  }
}
