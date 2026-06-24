/**
 * Semantic skill retrieval core (storage layer).
 *
 * Shared, side-effect-free building blocks for embedding-based skill_search.
 * Used in-process by the gateway (host) and, via the gateway embedding bridge,
 * by per-container mcp-memory. Deliberately holds NO API key logic beyond the
 * provider factory and NO cache/DB coupling — the cache store and the bridge
 * endpoint are separate units that compose these helpers.
 *
 * Dedicated `SKILL_EMBEDDING_*` config namespace (NOT the generic `EMBEDDING_*`)
 * so enabling skill semantic search never flips on archival/session hybrid search.
 *
 * Default backend: DashScope `text-embedding-v4` via its OpenAI-compatible
 * endpoint (1024-dim). Must be reached over a direct IPv4 path with no proxy
 * (China-region endpoint) — that is the caller's egress concern, not handled here.
 */
import { createHash } from 'node:crypto'
import {
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
  OpenAIEmbeddingProvider,
} from './embedding.js'

const DASHSCOPE_COMPAT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

export interface SkillEmbedMeta {
  name: string
  description: string
  tags?: string[]
  related_skills?: string[]
}

export interface RankedSkill {
  name: string
  score: number
}

// ── Provider (dedicated singleton) ───────────────

function parseDim(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value.trim())) return fallback
  const n = Number(value.trim())
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function skillEmbeddingConfigFromEnv(): EmbeddingProviderConfig {
  return {
    provider: 'openai', // OpenAI-compatible wire format; real backend tracked via skillEmbeddingBackendId()
    model: process.env.SKILL_EMBEDDING_MODEL ?? 'text-embedding-v4',
    dimensions: parseDim(process.env.SKILL_EMBEDDING_DIMENSIONS, 1024),
    apiKey: process.env.SKILL_EMBEDDING_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '',
    baseUrl: process.env.SKILL_EMBEDDING_BASE_URL ?? DASHSCOPE_COMPAT_BASE,
    batchSize: 10, // DashScope text-embedding-v4 caps batch at 10
    timeoutMs: 3000, // interactive path — fail fast to keyword fallback
  }
}

/**
 * Stable identity of the embedding backend, for cache namespacing.
 * Prevents DashScope vectors (providerId still "openai" on the wire) from
 * colliding with real-OpenAI vectors in a shared cache.
 */
export function skillEmbeddingBackendId(baseUrl?: string): string {
  const url = baseUrl ?? skillEmbeddingConfigFromEnv().baseUrl ?? DASHSCOPE_COMPAT_BASE
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

let _provider: EmbeddingProvider | null = null

export function getSkillEmbeddingProvider(config?: EmbeddingProviderConfig): EmbeddingProvider {
  if (_provider) return _provider
  const cfg = config ?? skillEmbeddingConfigFromEnv()
  _provider = new OpenAIEmbeddingProvider(cfg) // throws if apiKey missing
  return _provider
}

export function isSkillEmbeddingAvailable(): boolean {
  try {
    return (skillEmbeddingConfigFromEnv().apiKey ?? '').length > 0
  } catch {
    return false
  }
}

/** Reset the dedicated provider singleton (for tests / config reload). */
export function resetSkillEmbeddingProvider(): void {
  _provider = null
}

// ── Canonical representation + content hash ───────

function sortedTrimmed(xs: string[] | undefined): string[] {
  return [...(xs ?? [])]
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
}

/**
 * Deterministic canonical serialization of the fields that affect a skill's
 * vector. Used both as the cache-invalidation hash input and (rendered) as the
 * embedded text — keep the two aligned so a content change always re-embeds.
 */
export function skillCanonicalInput(m: SkillEmbedMeta): string {
  return JSON.stringify({
    name: m.name.trim(),
    description: (m.description ?? '').trim(),
    tags: sortedTrimmed(m.tags),
    related: sortedTrimmed(m.related_skills),
  })
}

/** sha256 of the canonical input — cache invalidation key (per content). */
export function skillContentHash(m: SkillEmbedMeta): string {
  return createHash('sha256').update(skillCanonicalInput(m)).digest('hex')
}

/**
 * Marketplace artifact identity: sha256 of the *normalized full SKILL.md*.
 *
 * Single authority for the normalization so the publisher (commercial master),
 * the stored artifact_hash, and the container-side hub sync all compute the
 * exact same digest — the hash is what pins "what the reviewer saw == what the
 * agent executes". Any drift between two copies of this logic would silently
 * break that guarantee, so both callers import this one function.
 */
export function marketplaceArtifactHash(rawSkillMd: string): string {
  const norm = rawSkillMd
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd()
  return createHash('sha256').update(norm).digest('hex')
}

/** Natural-language text actually sent to the embedding model. */
export function skillEmbedText(m: SkillEmbedMeta): string {
  const parts = [`${m.name} — ${(m.description ?? '').trim()}`]
  const tags = sortedTrimmed(m.tags)
  const related = sortedTrimmed(m.related_skills)
  if (tags.length) parts.push(`tags: ${tags.join(', ')}`)
  if (related.length) parts.push(`related: ${related.join(', ')}`)
  return parts.join(' | ')
}

// ── Query cleaning ───────────────────────────────

/**
 * Strip synthetic-prompt noise that dilutes the user's real intent
 * (team-run coordinator headers, previous-context blocks, system-prompt
 * appendices). Measured to lift R@5 (0.71 -> 0.74) on real v3 sessions.
 */
export function cleanSkillQuery(raw: string): string {
  let q = raw ?? ''
  q = q.replace(/<openclaude_previous_context>[\s\S]*?<\/openclaude_previous_context>/g, ' ')
  q = q.replace(/<[^>]*context[^>]*>[\s\S]*?<\/[^>]+>/g, ' ')
  if (/^\s*#\s*Agent Team Run/.test(q)) {
    const blocks = q.split('\n\n')
    if (blocks.length > 1) q = blocks.slice(1).join('\n\n')
  }
  q = q.split(/\n-{3,}\n\s*【/)[0] // drop "\n---\n【…系统提示】" appendix
  q = q.replace(/\s+/g, ' ').trim()
  return q.slice(0, 1500)
}

// ── Ranking ──────────────────────────────────────

export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

/** Pure cosine ranking over already-resolved skill vectors. */
export function rankSkillsByVectors(
  queryVec: ArrayLike<number>,
  skills: Array<{ name: string; vec: ArrayLike<number> }>,
): RankedSkill[] {
  return skills
    .map((s) => ({ name: s.name, score: cosineSim(queryVec, s.vec) }))
    .sort((a, b) => b.score - a.score)
}

function normText(s: string): string {
  return (s ?? '').trim().toLowerCase()
}
function compactText(s: string): string {
  return normText(s).replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * exact-name guard — when the user literally typed a skill's name, that skill
 * must surface regardless of embedding score. Chosen over RRF fusion because it
 * is explainable and does not pollute the (dominant) no-name query case where
 * pure embedding measured best.
 */
export function applyExactNameGuard(
  query: string,
  ranked: RankedSkill[],
  limit: number,
): RankedSkill[] {
  const q = normText(query)
  const cq = compactText(query)
  const pinned = (name: string): boolean => {
    const n = normText(name)
    if (!n) return false
    if (n === q) return true
    if (cq && compactText(name) === cq) return true
    // user spelled out the skill name (hyphens or not) inside the request
    if (n.length >= 4 && (q.includes(n) || (cq.length >= 4 && cq.includes(compactText(name)))))
      return true
    return false
  }
  const head = ranked.filter((r) => pinned(r.name))
  const tail = ranked.filter((r) => !pinned(r.name))
  return [...head, ...tail].slice(0, limit)
}
