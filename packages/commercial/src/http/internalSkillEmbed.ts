/**
 * V3 commercial skill-embedding relay (master side).
 *
 * Semantic skill_search egress is forced through the master so the DashScope
 * embedding key never enters user containers (it is a platform-level credential,
 * not the user's). Mirrors the codex relay trust model:
 *
 *   container mcp-memory → (container token) → master /internal/v3/skill-embed
 *     → master holds DASHSCOPE key, embeds via dashscope (direct IPv4/no-proxy),
 *       caches vectors cross-tenant by content hash, ranks, returns order.
 *
 * Fail-closed: any embedding failure returns ok:false so the caller falls back
 * to the deterministic keyword search. The key is never echoed.
 *
 * Auth reuses verifyContainerIdentity — identical to internalCodexRelay so a
 * single source governs container→master trust. See [internalCodexRelay.ts].
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  type RankedSkill,
  applyExactNameGuard,
  cleanSkillQuery,
  getSkillEmbeddingProvider,
  isSkillEmbeddingAvailable,
  rankSkillsByVectors,
  skillContentHash,
  skillEmbedText,
  skillEmbeddingBackendId,
  skillEmbeddingConfigFromEnv,
} from '@openclaude/storage'
import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const SKILL_EMBED_PREFIX = '/internal/v3/skill-embed'

/** Per-host request context, identical to the codex relay. */
export interface SkillEmbedCtx {
  hostUuid: string
  boundIp: string
}

/**
 * One skill the caller wants ranked — RAW metadata only. The master computes
 * the content hash and embed text itself (via the shared storage helpers) so a
 * malicious container cannot poison the cross-tenant cache by sending a baseline
 * skill's hash paired with attacker-controlled text.
 */
export interface SkillEmbedItem {
  name: string
  description: string
  tags?: string[]
  related_skills?: string[]
}

export interface SkillEmbedRequest {
  query: string
  limit?: number
  skills: SkillEmbedItem[]
}

/**
 * Cross-tenant skill-vector cache (master-side). Keyed by (contentHash, backendId, dimensions).
 * Pluggable so the handler is unit-testable without Postgres; the PG-backed impl is wired
 * at server construction. Baseline skills (shared by all tenants) are embedded once.
 */
export interface SkillEmbedCache {
  getMany(
    hashes: string[],
    backendId: string,
    dimensions: number,
  ): Promise<Map<string, Float32Array>>
  putMany(
    entries: Array<{ contentHash: string; vec: Float32Array }>,
    backendId: string,
    dimensions: number,
  ): Promise<void>
}

/** Central feedback row (see migration 0082). */
export interface SkillSearchLogRow {
  userId: number
  containerId: number
  rawQuery: string
  cleanedQuery: string
  method: 'embed' | 'fallback'
  ok: boolean
  reason?: string
  returned: RankedSkill[]
  model: string
  backendId: string
  dimensions: number
}

export interface SkillEmbedDeps {
  identityRepo: ContainerIdentityRepo
  cache: SkillEmbedCache
  logger?: Logger
  /** Test seam — defaults to the dedicated SKILL_EMBEDDING_* provider. */
  embedImpl?: (texts: string[], kind: 'query' | 'document') => Promise<Float32Array[]>
  /** Best-effort central feedback sink (fire-and-forget; must not throw). */
  recordSearch?: (row: SkillSearchLogRow) => void
}

export type SkillEmbedHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SkillEmbedCtx,
) => Promise<void>

const MAX_BODY_BYTES = 256 * 1024
// Real v3 catalogs are ~10–50 skills. Bound the cold-cache embedding fan-out
// (serial DashScope batches) so a pathological request can't run away on cost.
const MAX_SKILLS = 64
const MAX_NAME_LEN = 128
const MAX_DESC_LEN = 2048
const MAX_QUERY_LEN = 8000
const DEFAULT_LIMIT = 15

function asStringArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') return undefined
    out.push(x.slice(0, MAX_NAME_LEN))
  }
  return out.slice(0, 64)
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

async function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > cap) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseRequest(raw: string): SkillEmbedRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.query !== 'string') return null
  if (!Array.isArray(obj.skills) || obj.skills.length === 0 || obj.skills.length > MAX_SKILLS) {
    return null
  }
  const skills: SkillEmbedItem[] = []
  for (const s of obj.skills) {
    if (typeof s !== 'object' || s === null) return null
    const it = s as Record<string, unknown>
    if (typeof it.name !== 'string' || typeof it.description !== 'string') return null
    if (!it.name) return null
    const tags = asStringArray(it.tags)
    const related = asStringArray(it.related_skills)
    if (it.tags !== undefined && tags === undefined) return null
    if (it.related_skills !== undefined && related === undefined) return null
    skills.push({
      name: it.name.slice(0, MAX_NAME_LEN),
      description: it.description.slice(0, MAX_DESC_LEN),
      tags,
      related_skills: related,
    })
  }
  const limit =
    typeof obj.limit === 'number' && obj.limit > 0
      ? Math.min(Math.floor(obj.limit), 50)
      : DEFAULT_LIMIT
  return { query: obj.query.slice(0, MAX_QUERY_LEN), limit, skills }
}

export function makeSkillEmbedHandler(deps: SkillEmbedDeps): SkillEmbedHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalSkillEmbed' })
  // Force DIRECT egress: DashScope is China-region and must bypass the process
  // -global EnvHttpProxyAgent (which routes overseas for Anthropic). Same pattern
  // as the MiniMax media proxy.
  const provider = () =>
    getSkillEmbeddingProvider({
      ...skillEmbeddingConfigFromEnv(),
      dispatcher: directEgressDispatcher(),
    })
  const embed =
    deps.embedImpl ??
    ((texts: string[], kind: 'query' | 'document') => provider().embed(texts, kind))
  // recordSearch is best-effort and must never affect the response, even if a
  // caller-supplied sink throws synchronously.
  const safeRecord = (row: SkillSearchLogRow) => {
    try {
      deps.recordSearch?.(row)
    } catch {
      /* logging must never break skill_search */
    }
  }

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp })

    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }, requestId)
      return
    }

    // Auth — identical container-identity gate as the codex relay.
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn('identity_failed', { errcode: err.code })
        sendJson(
          res,
          401,
          { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } },
          requestId,
        )
        return
      }
      throw err
    }
    const userLog = reqLog.child({ uid: identity.userId, containerId: identity.containerId })

    // If embedding is not configured, tell the caller to use keyword fallback —
    // never 500 (skill_search must keep working).
    if (!isSkillEmbeddingAvailable()) {
      sendJson(res, 200, { ok: false, reason: 'embedding_unavailable' }, requestId)
      return
    }

    let body: string
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch {
      sendJson(
        res,
        413,
        { error: { code: 'BODY_TOO_LARGE', message: 'body too large' } },
        requestId,
      )
      return
    }
    const parsed = parseRequest(body)
    if (!parsed) {
      sendJson(
        res,
        400,
        { error: { code: 'BAD_REQUEST', message: 'invalid skill-embed request' } },
        requestId,
      )
      return
    }

    const prov = provider()
    const backendId = `${skillEmbeddingBackendId()}/${prov.modelId}` // namespace by model too
    const dim = prov.dimensions
    const cleaned = cleanSkillQuery(parsed.query)

    try {
      // 1) query vector (cleaned query, query-side embedding)
      const [queryVec] = await embed([cleaned], 'query')
      if (!queryVec) throw new Error('empty query embedding')

      // 2) master computes the content hash + embed text ITSELF from the raw
      //    metadata — it never trusts a container-supplied hash↔text pairing, so
      //    the cross-tenant cache cannot be poisoned. Cache hit, else embed-and-
      //    cache. Any embed throw → keyword fallback below (no mixed ranking).
      const items = parsed.skills.map((s) => ({
        name: s.name,
        hash: skillContentHash(s),
        text: skillEmbedText(s),
      }))
      const hashes = [...new Set(items.map((i) => i.hash))]
      const cached = await deps.cache.getMany(hashes, backendId, dim)
      const missing = hashes.filter((h) => !cached.has(h))
      if (missing.length > 0) {
        const textByHash = new Map<string, string>()
        for (const it of items) if (!textByHash.has(it.hash)) textByHash.set(it.hash, it.text)
        const vecs = await embed(
          missing.map((h) => textByHash.get(h) ?? ''),
          'document',
        )
        const toCache: Array<{ contentHash: string; vec: Float32Array }> = []
        for (let i = 0; i < missing.length; i++) {
          const v = vecs[i]
          if (!v) throw new Error('embed count mismatch')
          cached.set(missing[i], v)
          toCache.push({ contentHash: missing[i], vec: v })
        }
        // Cache write is best-effort; ranking already has the vectors.
        await deps.cache.putMany(toCache, backendId, dim).catch((e) => {
          userLog.warn('cache_put_failed', { err: e instanceof Error ? e.message : String(e) })
        })
      }

      // 3) rank (all-or-keyword: every item has a vector here) + exact-name guard
      const withVecs = items.map((it) => ({
        name: it.name,
        vec: cached.get(it.hash) as Float32Array,
      }))
      const ranked: RankedSkill[] = applyExactNameGuard(
        cleaned,
        rankSkillsByVectors(queryVec, withVecs),
        parsed.limit ?? DEFAULT_LIMIT,
      )

      userLog.info('skill_embed_ok', {
        skills: parsed.skills.length,
        misses: missing.length,
        returned: ranked.length,
        model: prov.modelId,
      })
      safeRecord({
        userId: identity.userId,
        containerId: identity.containerId,
        rawQuery: parsed.query,
        cleanedQuery: cleaned,
        method: 'embed',
        ok: true,
        returned: ranked,
        model: prov.modelId,
        backendId,
        dimensions: dim,
      })
      sendJson(
        res,
        200,
        {
          ok: true,
          method: 'embed',
          ranked,
          cleanedQuery: cleaned,
          backendId,
          model: prov.modelId,
          dimensions: dim,
        },
        requestId,
      )
    } catch (err) {
      // Fail-closed to keyword: ok:false, sanitized reason, never echo the key.
      const msg = (err instanceof Error ? err.message : String(err)).replace(
        /sk-[A-Za-z0-9_-]+/g,
        'sk-***',
      )
      userLog.warn('skill_embed_failed', { err: msg })
      safeRecord({
        userId: identity.userId,
        containerId: identity.containerId,
        rawQuery: parsed.query,
        cleanedQuery: cleaned,
        method: 'fallback',
        ok: false,
        reason: 'embed_error',
        returned: [],
        model: prov.modelId,
        backendId,
        dimensions: dim,
      })
      sendJson(res, 200, { ok: false, reason: 'embed_error' }, requestId)
    }
  }
}
