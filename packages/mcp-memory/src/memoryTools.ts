/**
 * memoryTools — 长期记忆(Recall / Archival)工具的可复用核心逻辑。
 *
 * 权威源:这 4 个记忆工具(session_search / archival_add / archival_search /
 * archival_delete)的实现只此一份。历史上它们(连同已退役的 Core `memory` 子命令)
 * 内联在 mcp-memory 的常驻 MCP server(index.ts)里;Phase 2 把它们从常驻 stdio
 * server 拆出改成一次性 `oc-memory` CLI(见 ocMemoryCli.ts)——常驻 stdio
 * 传输脆弱(被 console 污染 / 崩溃即死 → codex 死等 turn 被掐),一次性进程无
 * 传输可死。index.ts 不再暴露这些工具;它们唯一的消费者是本模块 + CLI。
 *
 * memdir 重构:Core 记忆(旧 `memory` add/replace/remove/read 子命令)已退役——
 * Core 记忆改为「引擎原生直接编辑文件」(agents/<id>/memory/<slug>.md + MEMORY.md
 * 索引,见 storage/src/memoryDir.ts)。CLI 侧仍拦截 `oc-memory memory ...` 打印迁移
 * 提示(见 ocMemoryCli.ts),但不再有 handleMemory / MemoryStore 依赖。
 *
 * 依赖:全部来自 @openclaude/storage(archival* + session search + 可选 embedding),
 * 与旧 MCP handler 完全同源。容器内 embedding 未配置(EMBEDDING_* / OPENAI_API_KEY
 * 均缺省)→ isEmbeddingAvailable() 为 false → 走 BM25-only,与旧 MCP server 行为一致。
 *
 * 返回结构刻意沿用旧 MCP handler 的 `{ content:[{type:'text',text}], isError? }`
 * ——CLI 直接取 content[0].text 打印,isError 决定退出码;单一返回形状不分叉。
 */
import {
  type EmbeddingProvider,
  MemoryDir,
  archivalAdd,
  archivalCount,
  archivalDelete,
  deleteArchivalVector,
  getEmbeddingProvider,
  getSessionsDb,
  hybridArchivalSearch,
  hybridSessionSearch,
  initVectorStore,
  isEmbeddingAvailable,
  loadSessionTurns,
  recordAccess,
  readUserProfile,
  scanMemoryContent,
  paths,
  isManagedAgentRuntime,
  isMemoryExpired,
  memoryCalendarDate,
  parseMemoryFrontmatter,
  tokenizeCoreMemory,
  coverageAtLeastHalf,
  readMemoryTurnPolicy,
  reciprocalRankFusion,
  searchSessions,
  upsertArchivalVector,
} from '@openclaude/storage'
import {
  type CoreMemoryDocument,
  type CoreMemorySemanticOptions,
  rankCoreMemorySemantically,
} from './coreMemorySemantic.js'

export interface MemoryToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  /** Privacy-minimized observability metadata; never rendered to the model. */
  telemetry?: {
    outcome: 'hit' | 'no_match' | 'success' | 'denied' | 'error' | 'skipped'
    policyReason?: string
    retrievalMode?: 'lexical' | 'semantic' | 'hybrid' | 'bm25' | 'none'
    resultCount?: number
    topMatchKey?: string
  }
}

export function toolOk(msg: string, telemetry?: MemoryToolResult['telemetry']): MemoryToolResult {
  return { content: [{ type: 'text', text: msg }], ...(telemetry ? { telemetry } : {}) }
}
export function toolError(
  msg: string,
  telemetry: MemoryToolResult['telemetry'] = { outcome: 'error' },
): MemoryToolResult {
  return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true, telemetry }
}

/**
 * Per-agent memory runtime: (optional) embedding provider + in-flight embed
 * tasks. Created once per process (MCP server startup or a single CLI
 * invocation) and threaded through every handler so there is no hidden
 * module-level singleton state.
 *
 * memdir 重构后不再持有 MemoryStore —— Core 记忆已改为引擎原生直接编辑文件,
 * 本 context 只服务 session_search / archival_* 三类深层召回工具。
 */
export interface MemoryToolsContext {
  agentId: string
  embeddingProvider: EmbeddingProvider | null
  /** Track in-flight embedding tasks so archival_delete can await before cleanup
   *  (add/delete race), and the CLI can drain before exit. */
  pendingEmbeds: Map<string, Promise<void>>
}

/**
 * Build a MemoryToolsContext for `agentId`. Startup sequence:
 *   1. archivalCount(agentId)                — triggers ensureSchema() so the
 *      archival + archival_fts tables exist BEFORE any hybridArchivalSearch
 *      (which queries archival_fts directly).
 *   2. embedding provider init (best-effort) — BM25-only when unavailable.
 */
export async function createMemoryToolsContext(agentId: string): Promise<MemoryToolsContext> {
  // archivalCount triggers ensureSchema() which creates archival + archival_fts
  // tables. Must run before hybridArchivalSearch which queries archival_fts.
  await archivalCount(agentId)

  let embeddingProvider: EmbeddingProvider | null = null
  if (isEmbeddingAvailable()) {
    try {
      embeddingProvider = getEmbeddingProvider()
      await initVectorStore(embeddingProvider.dimensions)
      process.stderr.write(
        `[oc-memory] embedding enabled: ${embeddingProvider.providerId}/${embeddingProvider.modelId} (${embeddingProvider.dimensions}d)\n`,
      )
    } catch (err: any) {
      process.stderr.write(
        `[oc-memory] embedding init failed (falling back to BM25-only): ${err?.message}\n`,
      )
      embeddingProvider = null
    }
  }

  return { agentId, embeddingProvider, pendingEmbeds: new Map() }
}

/** Await any in-flight embedding tasks. CLI calls this before exit so a
 *  short-lived process doesn't drop a fire-and-forget embed on the floor
 *  (no-op when embeddings are unavailable — the map stays empty). */
export async function drainPendingEmbeds(ctx: MemoryToolsContext): Promise<void> {
  const pending = [...ctx.pendingEmbeds.values()]
  if (pending.length > 0) await Promise.allSettled(pending)
}

/** Lucene/Okapi BM25; k1/b are the standard defaults. N is 14–100 in-memory Core files. */
const CORE_BM25_K1 = 1.2
const CORE_BM25_B = 0.75
/**
 * Strong hit: phrase match, or matched query-term characters cover at least
 * half the query (`matchedCharacters * 2 >= totalTermCharacters`).
 *
 * 1/3 (`* 3`) is too loose for CJK: a 3-token query such as 今天天气怎么样
 * is 6 characters, so a single 2-character token already passes 1/3 and
 * would admit weather/how-to false hits as "strong". Half-coverage means
 * that same 2-character token *does* admit 记忆功能优化 (terms 记忆+功能 =
 * 4 chars) while rejecting weather (2 < 3) and dashi-taskboard (任务 2 << 18).
 *
 * Weak fallback uses the same half-coverage floor so a junk query cannot
 * return "maybe unrelated" hits. In practice the weak band is empty once
 * strong also uses 50% — kept so a future extra strong constraint can still
 * fall back without reopening the no-match hole.
 */
const WEAK_LEXICAL_FALLBACK_LIMIT = 3
const WEAK_LEXICAL_FALLBACK_NOTE =
  'Weak lexical fallback: no match cleared the coverage bar; these top hits may be unrelated — read excerpts before using them.'
/**
 * Keep hits within this fraction of the top BM25 score. 0.35 is the upper
 * end of the usual 0.25–0.35 IR window: a document at 35% of top-1 is still
 * in the same relevance band (near-duplicate cluster), while generic-token
 * tails of H3/OCR boilerplate fall off. Sweep 0.2–0.5 is in the eval notes;
 * 0.35 is the in-window value that also clears E06.
 */
const CORE_RELATIVE_SCORE_RATIO = 0.35

function bm25Idf(documentCount: number, df: number): number {
  return Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
}

function bm25TermScore(tf: number, docLength: number, avgdl: number, idf: number): number {
  if (tf <= 0) return 0
  const denom = tf + CORE_BM25_K1 * (1 - CORE_BM25_B + CORE_BM25_B * (docLength / avgdl))
  return idf * ((tf * (CORE_BM25_K1 + 1)) / denom)
}

type CoreHit = { score: number; path: string; label: string; size: number; snippet: string; matchedCharacters: number }

function applyRelativeScoreCutoff(hits: CoreHit[], ratio: number): CoreHit[] {
  if (hits.length <= 1) return hits
  const topScore = hits[0]!.score
  if (!(topScore > 0)) return hits
  return hits.filter((hit) => hit.score >= topScore * ratio)
}

function countSubstring(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    count++
    from = at + needle.length
  }
  return count
}

async function memorySearchPolicyError(kind: 'core' | 'deep'): Promise<MemoryToolResult | null> {
  if (!isManagedAgentRuntime()) return null
  const sessionKey =
    process.env.OPENCLAUDE_SESSION_KEY?.trim() || process.env.OC_SESSION_KEY?.trim()
  if (!sessionKey) return toolError('memory search is unavailable without an active turn policy', {
    outcome: 'denied',
    policyReason: 'missing_session',
  })
  const policy = await readMemoryTurnPolicy(sessionKey)
  if (!policy) return toolError('memory search is unavailable because the active turn policy is missing or expired', {
    outcome: 'denied',
    policyReason: 'missing_or_expired',
  })
  if (!policy.allowed)
    return toolError(`memory search is disabled for this turn (${policy.reason}); answer from the current request`, {
      outcome: 'denied',
      policyReason: policy.reason,
    })
  if (
    kind === 'deep' &&
    (policy.reason === 'on_demand_core' || policy.reason === 'inherited_parent_core')
  ) {
    return toolError(
      `session and archival search require explicit continuity or stored-material intent (${policy.reason})`,
      { outcome: 'denied', policyReason: policy.reason },
    )
  }
  return null
}

export type StrongCoreHit = { path: string; label: string }

function ttlWarn(message: string): void {
  process.stderr.write(`[memory-ttl] ${message}\n`)
}

async function loadAndScoreCoreLexical(args: {
  agentId: string
  query: string
  today?: string
}): Promise<{
  documents: CoreMemoryDocument[]
  lexicalHits: CoreHit[]
  strongLexicalHits: CoreHit[]
  totalTermCharacters: number
}> {
  const query = args.query.trim()
  const today = args.today ?? memoryCalendarDate()
  const q = query.normalize('NFKC').toLocaleLowerCase()
  const terms = [
    ...new Set([
      ...[...new Intl.Segmenter('zh', { granularity: 'word' }).segment(q)]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment),
    ].filter((term) => term.length >= 2 || term === q)),
  ]
  const totalTermCharacters = terms.reduce((total, term) => total + term.length, 0)
  type IndexedCoreDoc = {
    path: string
    label: string
    content: string
    size: number
    normalized: string
    tokens: string[]
  }
  const lexicalHits: CoreHit[] = []
  const strongLexicalHits: CoreHit[] = []
  const documents: CoreMemoryDocument[] = []
  const indexed: IndexedCoreDoc[] = []
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const add = (path: string, label: string, content: string, size: number) => {
    if (!content.trim() || !scanMemoryContent(content).ok) return
    const { fm } = parseMemoryFrontmatter(content)
    if (isMemoryExpired(fm.expires, today, ttlWarn, path)) return
    documents.push({ path, label, content, size })
    const normalized = content.normalize('NFKC').toLocaleLowerCase()
    indexed.push({
      path,
      label,
      content,
      size,
      normalized,
      tokens: tokenizeCoreMemory(normalized, segmenter),
    })
  }

  try {
    const { text } = await readUserProfile()
    add(paths.sharedUserMd, 'user profile', text, Buffer.byteLength(text))
  } catch {}
  const dir = new MemoryDir(args.agentId)
  for (const meta of await dir.list()) {
    const read = await dir.read(meta.file)
    if (read) add(`${dir.dirPath()}/${meta.file}`, `${meta.name} (${meta.type})`, read.content, meta.size)
  }

  const documentCount = indexed.length
  const avgdl =
    documentCount === 0
      ? 1
      : Math.max(
          indexed.reduce((sum, doc) => sum + doc.tokens.length, 0) / documentCount,
          1,
        )
  const df = new Map<string, number>()
  for (const term of terms) df.set(term, 0)
  let phraseDf = 0
  for (const doc of indexed) {
    const seen = new Set(doc.tokens)
    for (const term of terms) {
      if (seen.has(term)) df.set(term, (df.get(term) ?? 0) + 1)
    }
    if (q.length >= 2 && doc.normalized.includes(q)) phraseDf++
  }

  for (const doc of indexed) {
    const tf = new Map<string, number>()
    for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    let score = 0
    let matchedTerms = 0
    let matchedCharacters = 0
    let at = q.length >= 2 ? doc.normalized.indexOf(q) : -1
    const phraseHit = at >= 0
    for (const term of terms) {
      const termTf = tf.get(term) ?? 0
      if (termTf <= 0) continue
      matchedTerms++
      matchedCharacters += term.length
      score += bm25TermScore(
        termTf,
        doc.tokens.length,
        avgdl,
        bm25Idf(documentCount, df.get(term) ?? 0),
      )
      const i = doc.normalized.indexOf(term)
      if (i >= 0 && (at < 0 || i < at)) at = i
    }
    if (phraseHit) {
      score += bm25TermScore(
        countSubstring(doc.normalized, q),
        doc.tokens.length,
        avgdl,
        bm25Idf(documentCount, phraseDf),
      )
    }
    if (matchedTerms === 0 && !phraseHit) continue
    const from = Math.max(0, at - 180)
    const excerpt = doc.content.slice(from, from + 600).replace(/\s+/g, ' ').trim()
    const hit = {
      score,
      path: doc.path,
      label: doc.label,
      size: doc.size,
      snippet: `${from > 0 ? '…' : ''}${excerpt}${from + 600 < doc.content.length ? '…' : ''}`,
      matchedCharacters,
    }
    lexicalHits.push(hit)
    if (phraseHit || coverageAtLeastHalf(matchedCharacters, totalTermCharacters)) {
      strongLexicalHits.push(hit)
    }
  }
  lexicalHits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  strongLexicalHits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return { documents, lexicalHits, strongLexicalHits, totalTermCharacters }
}

/**
 * Dedup probe for the auto-write path. Reuses the same strong-hit rule as
 * core-search (phrase match, or matched query-term characters covering at
 * least half the query via CORE_COVERAGE_NUMERATOR). Expired entries are
 * already dropped by the loader, so a lapsed auto memory cannot block a new write.
 */
export async function hasStrongCoreMemoryHit(args: {
  agentId: string
  query: string
  today?: string
}): Promise<{ hit: boolean; path?: string; label?: string }> {
  const query = args.query.trim()
  if (!query) return { hit: false }
  const scored = await loadAndScoreCoreLexical({
    agentId: args.agentId,
    query,
    today: args.today,
  })
  const top = scored.strongLexicalHits[0]
  return top ? { hit: true, path: top.path, label: top.label } : { hit: false }
}

export async function handleCoreSearch(args: {
  agentId: string
  query: string
  limit?: number
  offset?: number
  /** Test seam: freeze the TTL calendar day (YYYY-MM-DD). */
  today?: string
  /** Test seam for the authenticated master relay; omitted by the CLI. */
  semanticOptions?: CoreMemorySemanticOptions
}): Promise<MemoryToolResult> {
  const denied = await memorySearchPolicyError('core')
  if (denied) return denied
  const query = args.query.trim()
  if (!query) return toolError('core-search requires a non-empty query string')
  const limit = args.limit ?? 5
  const offset = args.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    return toolError('core-search --limit must be an integer from 1 to 20')
  if (!Number.isInteger(offset) || offset < 0)
    return toolError('core-search --offset must be a non-negative integer')

  const { documents, lexicalHits, strongLexicalHits, totalTermCharacters } =
    await loadAndScoreCoreLexical({
      agentId: args.agentId,
      query,
      today: args.today,
    })

  // 词法强命中时语义不会改善结果，只作为失手时的 fallback，避免无谓的 embedding 往返。
  const semanticFiles =
    strongLexicalHits.length === 0
      ? await rankCoreMemorySemantically(query, documents, args.semanticOptions)
      : null
  // Admit by half-coverage (or whole-query phrase). If nothing clears that bar,
  // only fall back when a weak hit still covers half the query characters —
  // otherwise return No match rather than "maybe unrelated" junk.
  let weakLexicalFallback = false
  let hits: CoreHit[]
  if (semanticFiles === null) {
    if (strongLexicalHits.length > 0) hits = strongLexicalHits
    else {
      const weakEligible = lexicalHits.filter((hit) =>
        coverageAtLeastHalf(hit.matchedCharacters, totalTermCharacters),
      )
      if (weakEligible.length > 0) {
        hits = weakEligible.slice(0, WEAK_LEXICAL_FALLBACK_LIMIT)
        weakLexicalFallback = true
      } else hits = []
    }
    hits = applyRelativeScoreCutoff(hits, CORE_RELATIVE_SCORE_RATIO)
  } else {
    // 强命中为空才会到这里；语义空数组则保持空结果，不回落到弱词法。
    hits = strongLexicalHits
  }
  if (semanticFiles?.length) {
    const documentByPath = new Map(documents.map((document) => [document.path, document]))
    const lexicalByPath = new Map(strongLexicalHits.map((hit) => [hit.path, hit]))
    hits = reciprocalRankFusion(
      strongLexicalHits.map((hit) => hit.path),
      semanticFiles.map((file) => file.path),
    ).flatMap((candidate) => {
      const lexical = lexicalByPath.get(candidate.id)
      if (lexical) return [{ ...lexical, score: candidate.score }]
      const semantic = semanticFiles.find((file) => file.path === candidate.id)
      const document = documentByPath.get(candidate.id)
      if (!semantic || !document) return []
      const from = Math.max(0, semantic.start - 80)
      const excerpt = document.content.slice(from, from + 600).replace(/\s+/g, ' ').trim()
      return [{
        score: candidate.score,
        path: document.path,
        label: document.label,
        size: document.size,
        snippet: `${from > 0 ? '…' : ''}${excerpt}${from + 600 < document.content.length ? '…' : ''}`,
        matchedCharacters: 0,
      }]
    })
  }
  const page = hits.slice(offset, offset + limit)
  const retrievalMode = semanticFiles === null ? 'lexical' : 'semantic'
  if (hits.length === 0) return toolOk(`No safe Core memories match "${query}".`, {
    outcome: 'no_match',
    retrievalMode,
    resultCount: 0,
  })
  if (!page.length)
    return toolOk(
      `Found ${hits.length} safe Core matches for "${query}", but offset ${offset} is past the last result.`,
      {
        outcome: 'hit',
        retrievalMode,
        resultCount: hits.length,
        topMatchKey: hits[0]?.path,
      },
    )
  const lines = [`Found ${hits.length} safe Core matches for "${query}". Showing ${offset + 1}-${offset + page.length}:`]
  if (weakLexicalFallback) lines.push(WEAK_LEXICAL_FALLBACK_NOTE)
  lines.push('')
  page.forEach((hit, i) => {
    lines.push(`[${offset + i + 1}] ${hit.label}\npath: ${hit.path}\nsize: ${hit.size} bytes\nexcerpt: ${hit.snippet}`, '')
  })
  if (offset + page.length < hits.length)
    lines.push(`More matches available: rerun with --offset ${offset + page.length}.`)
  lines.push('Excerpts are bounded; use Read with offset/limit on the path for complete content.')
  return toolOk(lines.join('\n'), {
    outcome: 'hit',
    retrievalMode,
    resultCount: hits.length,
    topMatchKey: hits[0]?.path,
  })
}

// ── memory (Core) 已退役 ──
// memdir 重构:Core 记忆(旧 memory add/replace/remove/read)改为引擎原生直接编辑文件
// (agents/<id>/memory/<slug>.md + MEMORY.md 索引)。此处不再有 handleMemory;
// `oc-memory memory ...` 由 CLI 拦截打印迁移提示(见 ocMemoryCli.ts)。

// ── session_search (Recall: hybrid BM25 + vector over past sessions) ──
export async function handleSessionSearch(
  ctx: MemoryToolsContext,
  args: {
    query: string
    limit?: number
    agentId?: string
    summarize?: boolean
  },
): Promise<MemoryToolResult> {
  const denied = await memorySearchPolicyError('deep')
  if (denied) return denied
  // Default: search only THIS agent's sessions. Pass agentId to search another agent.
  const searchAgentId = args.agentId ?? ctx.agentId
  const limit = args.limit ?? 5

  // Use hybrid search (BM25 + vector) when embedding is available, else BM25-only
  const hits = ctx.embeddingProvider
    ? await hybridSessionSearch(args.query, ctx.embeddingProvider, limit, searchAgentId)
    : (await searchSessions(args.query, limit, searchAgentId)).map((h) => ({
        ...h,
        bm25Rank: null as number | null,
        vecRank: null as number | null,
      }))

  if (hits.length === 0) {
    const scope = args.agentId ? ` (agent: ${args.agentId})` : ''
    return toolOk(`No past sessions match "${args.query}"${scope}.`, {
      outcome: 'no_match',
      retrievalMode: ctx.embeddingProvider ? 'hybrid' : 'bm25',
      resultCount: 0,
    })
  }
  const scope = args.agentId ? ` (agent: ${args.agentId})` : ''
  const mode = ctx.embeddingProvider ? 'hybrid' : 'BM25'
  const lines: string[] = [
    `Found ${hits.length} past sessions matching "${args.query}"${scope} (${mode}):`,
    '',
  ]
  for (const h of hits) {
    const when = new Date(h.lastAt).toISOString().slice(0, 19).replace('T', ' ')
    lines.push(`• ${h.title} — ${when} [${h.channel}] (score ${h.score.toFixed(2)})`)
    const cleanSnippet = h.snippet.replace(/<\/?mark>/g, '**').slice(0, 300)
    lines.push(`  ${cleanSnippet}`)
    lines.push('')
  }
  // Second-pass summary: optional, per-hit, capped for token budget
  if (args.summarize) {
    lines.push('---')
    lines.push('Full summaries:')
    lines.push('')
    for (const h of hits.slice(0, 3)) {
      const turns = await loadSessionTurns(h.sessionId)
      const text = turns
        .map((t) => `[${t.role}] ${t.content}`)
        .join('\n')
        .slice(0, 4000)
      lines.push(`### ${h.title}`)
      lines.push(text)
      lines.push('')
    }
  }
  return toolOk(lines.join('\n'), {
    outcome: 'hit',
    retrievalMode: ctx.embeddingProvider ? 'hybrid' : 'bm25',
    resultCount: hits.length,
    topMatchKey: hits[0]?.sessionId,
  })
}

// ── archival_add (Archival: unlimited FTS5-searchable long-term store) ──
export async function handleArchivalAdd(
  ctx: MemoryToolsContext,
  args: { content: string; tags?: string },
): Promise<MemoryToolResult> {
  // Guard against missing/empty content — the archival table's `content` column
  // is NOT NULL, so reaching the INSERT with undefined surfaces a cryptic
  // "constraint failed" SQL error.
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    return toolError(
      'archival_add requires a non-empty content string (only content and optional tags are accepted)',
    )
  }
  const id = await archivalAdd(ctx.agentId, args.content, args.tags)

  // Generate embedding and store vector (fire-and-forget to avoid blocking response).
  // Tracked in pendingEmbeds so archival_delete / CLI drain can await before cleanup.
  if (ctx.embeddingProvider) {
    const provider = ctx.embeddingProvider
    const task = (async () => {
      try {
        const [vec] = await provider.embed([args.content], 'document')
        // Verify the archival row still exists before inserting vector
        // (a concurrent delete may have removed it during embedding)
        const db = await getSessionsDb()
        const row = db.prepare('SELECT 1 FROM archival WHERE id = ?').get(id)
        if (row) await upsertArchivalVector(id, vec)
      } catch (err: any) {
        process.stderr.write(`[oc-memory] embedding failed for archival ${id}: ${err?.message}\n`)
      } finally {
        ctx.pendingEmbeds.delete(id)
      }
    })()
    // embed() is async — task always suspends at first await before finally runs,
    // so set() always registers before delete() fires.
    ctx.pendingEmbeds.set(id, task)
  }

  const count = await archivalCount(ctx.agentId)
  return toolOk(`Stored in archival memory (id=${id}). Total entries: ${count}`, {
    outcome: 'success',
    retrievalMode: 'none',
    resultCount: 1,
    topMatchKey: id,
  })
}

// ── archival_search (Archival: hybrid BM25 + vector + RRF) ──
export async function handleArchivalSearch(
  ctx: MemoryToolsContext,
  args: { query: string; limit?: number },
): Promise<MemoryToolResult> {
  const denied = await memorySearchPolicyError('deep')
  if (denied) return denied
  if (typeof args.query !== 'string' || args.query.trim() === '') {
    return toolError('archival_search requires a non-empty query string')
  }
  const limit = args.limit ?? 5
  const results = await hybridArchivalSearch(ctx.agentId, args.query, ctx.embeddingProvider, limit)
  if (results.length === 0) return toolOk(`No archival entries match "${args.query}".`, {
    outcome: 'no_match',
    retrievalMode: ctx.embeddingProvider ? 'hybrid' : 'bm25',
    resultCount: 0,
  })

  // Track access for lifecycle (non-blocking)
  recordAccess(results.map((r) => r.id)).catch(() => {})

  const mode = ctx.embeddingProvider ? 'hybrid (BM25+vector)' : 'BM25-only'
  const lines = results.map((r, i) => {
    const ranks: string[] = []
    if (r.bm25Rank != null) ranks.push(`bm25:#${r.bm25Rank}`)
    if (r.vecRank != null) ranks.push(`vec:#${r.vecRank}`)
    const rankInfo = ranks.length > 0 ? ` [${ranks.join(', ')}]` : ''
    return `[${i + 1}] id=${r.id} tags=${r.tags || '(none)'}${rankInfo}\n${r.content}`
  })
  return toolOk(`Found ${results.length} archival entries (${mode}):\n\n${lines.join('\n\n---\n\n')}`, {
    outcome: 'hit',
    retrievalMode: ctx.embeddingProvider ? 'hybrid' : 'bm25',
    resultCount: results.length,
    topMatchKey: results[0]?.id,
  })
}

// ── archival_delete ──
export async function handleArchivalDelete(
  ctx: MemoryToolsContext,
  args: { id: string },
): Promise<MemoryToolResult> {
  if (typeof args.id !== 'string' || args.id.trim() === '') {
    return toolError('archival_delete requires a non-empty id string (from archival_search results)')
  }
  const ok = await archivalDelete(ctx.agentId, args.id)
  if (!ok) return toolError(`Entry ${args.id} not found.`)

  // Await any in-flight embedding before deleting vector (prevents add/delete race)
  const pending = ctx.pendingEmbeds.get(args.id)
  if (pending) await pending

  if (ctx.embeddingProvider) {
    try {
      await deleteArchivalVector(args.id)
    } catch (err: any) {
      // deleteArchivalVector does not throw on missing rows —
      // any error here is a real DB/vec issue, so log it.
      process.stderr.write(`[oc-memory] vector delete failed for ${args.id}: ${err?.message}\n`)
    }
  }
  return toolOk(`Deleted archival entry ${args.id}.`, {
    outcome: 'success',
    retrievalMode: 'none',
    resultCount: 1,
    topMatchKey: args.id,
  })
}
