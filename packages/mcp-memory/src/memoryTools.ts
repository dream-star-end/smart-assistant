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
  searchSessions,
  upsertArchivalVector,
} from '@openclaude/storage'

export interface MemoryToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export function toolOk(msg: string): MemoryToolResult {
  return { content: [{ type: 'text', text: msg }] }
}
export function toolError(msg: string): MemoryToolResult {
  return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
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
    return { content: [{ type: 'text', text: `No past sessions match "${args.query}"${scope}.` }] }
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
  return { content: [{ type: 'text', text: lines.join('\n') }] }
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
  return toolOk(`Stored in archival memory (id=${id}). Total entries: ${count}`)
}

// ── archival_search (Archival: hybrid BM25 + vector + RRF) ──
export async function handleArchivalSearch(
  ctx: MemoryToolsContext,
  args: { query: string; limit?: number },
): Promise<MemoryToolResult> {
  if (typeof args.query !== 'string' || args.query.trim() === '') {
    return toolError('archival_search requires a non-empty query string')
  }
  const limit = args.limit ?? 5
  const results = await hybridArchivalSearch(ctx.agentId, args.query, ctx.embeddingProvider, limit)
  if (results.length === 0) return toolOk(`No archival entries match "${args.query}".`)

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
  return toolOk(`Found ${results.length} archival entries (${mode}):\n\n${lines.join('\n\n---\n\n')}`)
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
  return toolOk(`Deleted archival entry ${args.id}.`)
}
