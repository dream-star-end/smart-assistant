#!/usr/bin/env node
/**
 * @openclaude/mcp-memory
 *
 * MCP server that exposes OpenClaude's learning loop to the spawned CCB
 * subprocess. This is how the agent gains the ability to:
 *
 *   • `memory`         — curate its own MEMORY.md and USER.md across sessions
 *   • `session_search` — recall past conversations (SQLite FTS5 + second-pass summary)
 *   • `skill_list`     — discover its own accumulated skills (tier-1 progressive disclosure)
 *   • `skill_view`     — load a skill's full instructions (tier-2/3)
 *   • `skill_save`     — distill a successful task into a reusable skill
 *   • `skill_delete`
 *
 * Configuration: the server is spawned per-session by the gateway with
 *   env OPENCLAUDE_AGENT_ID=<id>   (which agent this subprocess belongs to)
 *   env OPENCLAUDE_HOME=...        (optional override)
 *
 * Protocol: MCP stdio transport, official @modelcontextprotocol/sdk.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  MemoryStore,
  SkillStore,
  archivalAdd,
  archivalCount,
  archivalDelete,
  indexTurn,
  loadSessionTurns,
  searchSessions,
  upsertSessionMeta,
  // P1: Hybrid search (BM25 + Vector + RRF)
  hybridArchivalSearch,
  hybridSessionSearch,
  recordAccess,
  initVectorStore,
  upsertArchivalVector,
  deleteArchivalVector,
  isEmbeddingAvailable,
  getEmbeddingProvider,
  getSessionsDb,
  type EmbeddingProvider,
} from '@openclaude/storage'

const AGENT_ID = process.env.OPENCLAUDE_AGENT_ID ?? 'main'

const memory = new MemoryStore(AGENT_ID)
await memory.load()

/**
 * PR4: optional platform baseline skills dir (ro mount in v3 containers).
 * Only the explicit `OPENCLAUDE_BASELINE_SKILLS_DIR` env is honored — we
 * deliberately avoid fallbacks like `${CLAUDE_CONFIG_DIR}/skills` because that
 * env is common in personal/local setups where the dir contains regular
 * user-writable skills (not a platform baseline) and silently treating those as
 * read-only platform skills would break existing workflows.
 *
 * Any failure (missing dir, not a directory, SkillStore constructor throw)
 * warns to stderr and falls back to single-root user-only behavior rather
 * than crashing the MCP server.
 */
function resolveBaselineDir(): string | undefined {
  const raw = process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
  if (!raw || raw.trim() === '') return undefined
  return raw
}

function buildSkillStore(): SkillStore {
  const baselineDir = resolveBaselineDir()
  if (baselineDir == null) return new SkillStore(AGENT_ID)
  try {
    return new SkillStore(AGENT_ID, { baselineDir })
  } catch (err: any) {
    process.stderr.write(
      `[mcp-memory] OPENCLAUDE_BASELINE_SKILLS_DIR invalid (${baselineDir}), falling back to user-only: ${err?.message ?? err}\n`,
    )
    return new SkillStore(AGENT_ID)
  }
}

const skills = buildSkillStore()

// Track in-flight embedding tasks to prevent add/delete race conditions
const pendingEmbeds = new Map<string, Promise<void>>()

// ── P1: Initialize archival schema + embedding + vector store ─
// archivalCount triggers ensureSchema() which creates archival + archival_fts tables.
// Must run before hybridArchivalSearch which queries archival_fts directly.
await archivalCount(AGENT_ID)

let embeddingProvider: EmbeddingProvider | null = null

if (isEmbeddingAvailable()) {
  try {
    embeddingProvider = getEmbeddingProvider()
    await initVectorStore(embeddingProvider.dimensions)
    process.stderr.write(
      `[mcp-memory] embedding enabled: ${embeddingProvider.providerId}/${embeddingProvider.modelId} (${embeddingProvider.dimensions}d)\n`,
    )
  } catch (err: any) {
    process.stderr.write(`[mcp-memory] embedding init failed (falling back to BM25-only): ${err?.message}\n`)
    embeddingProvider = null
  }
}

const server = new Server(
  { name: 'openclaude-memory', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// ─────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'memory',
    description: [
      'Curate long-term memory across sessions. Two targets:',
      '  - "memory": your own observations (environment facts, conventions, tool quirks, lessons learned)',
      '  - "user":   what you know about the user (preferences, communication style, workflow)',
      '',
      'Use this tool when you learn something durable that should persist across sessions.',
      'Entries are injected into the system prompt at the start of every future session.',
      '',
      'Actions:',
      '  add(target, content)           — append a new entry. Char-budgeted; oldest entries are trimmed first.',
      '  replace(target, needle, new)   — replace the entry matching `needle` substring (must be unique).',
      '  remove(target, needle)         — delete the entry matching `needle`.',
      '  read(target)                   — dump current entries as text.',
      '',
      'Writes are scanned for prompt-injection patterns and will be rejected.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove', 'read'] },
        target: { type: 'string', enum: ['memory', 'user'] },
        content: { type: 'string' },
        needle: { type: 'string' },
      },
      required: ['action', 'target'],
    },
  },
  {
    name: 'session_search',
    description: [
      'Hybrid search across past sessions (BM25 full-text + vector similarity when available).',
      "Set agentId to search another agent's sessions (cross-agent memory access).",
      '',
      'Returns up to `limit` (default 5) top sessions with snippet + metadata.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords or natural language)' },
        limit: { type: 'number', default: 5 },
        agentId: { type: 'string', description: '搜索指定 agent 的会话(默认搜索自己的)' },
        summarize: {
          type: 'boolean',
          default: false,
          description: 'Return LLM-summarized transcripts',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'skill_list',
    description: [
      'List all skills you have accumulated. Returns name + description for each.',
      'Always check this first when starting a new task — you may already have a skill for it.',
      'Token-cheap: returns metadata only. Use `skill_view` to load full instructions.',
    ].join('\n'),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_view',
    description: [
      'Load the full instructions of a named skill (tier-2 progressive disclosure).',
      'Optionally pass `subfile` to load a referenced file inside the skill directory.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        subfile: {
          type: 'string',
          description: 'Optional path inside the skill dir, e.g. references/api.md',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'skill_save',
    description: [
      'Distill a successful task resolution into a reusable skill for future use.',
      'Call this AFTER completing a complex multi-step task that could reasonably come up again.',
      '',
      'Provide:',
      '  name        — lowercase, hyphenated, unique (a-z 0-9 -, max 64 chars)',
      '  description — 1-2 sentence summary of when to use it (max 1024 chars)',
      '  body        — full markdown instructions: overview, prerequisites, steps, examples',
      '  tags        — optional array of topical tags',
      '',
      'The skill is stored under your agent home and will appear in `skill_list` next session.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'description', 'body'],
    },
  },
  {
    name: 'skill_delete',
    description:
      'Delete a skill by name. Use sparingly — only when the skill is clearly wrong or obsolete.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  // ── Archival Memory (Letta-inspired tier-3 long-term storage) ──
  {
    name: 'archival_add',
    description: [
      'Store a piece of knowledge in long-term archival memory (unlimited capacity, FTS5 searchable).',
      'Use for: detailed API docs, project architecture notes, code patterns, procedures that are too long for MEMORY.md.',
      'Unlike Core Memory (MEMORY.md/USER.md), archival entries are NOT in the system prompt — you must search for them.',
      'Returns the entry ID.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'The knowledge to store. Be specific and include keywords for future retrieval.',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags for categorization, e.g. "api,minimax,tts"',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'archival_search',
    description: [
      'Search archival memory using hybrid search (BM25 full-text + vector similarity + RRF fusion).',
      "Use when you need detailed knowledge that's too large for Core Memory.",
      'Supports both keyword queries and natural language questions.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords or natural language)' },
        limit: { type: 'number', default: 5, description: 'Max results to return' },
      },
      required: ['query'],
    },
  },
  {
    name: 'archival_delete',
    description: 'Delete an archival entry by ID. Use when knowledge is outdated or wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry ID (from archival_search results)' },
      },
      required: ['id'],
    },
  },
  // ── Reminder / scheduled task ──
  {
    name: 'create_reminder',
    description: [
      '创建一个定时提醒或定时任务。用户说"5分钟后提醒我吃饭"或"每天9点晨练"时使用此工具。',
      '',
      'schedule 格式为 5 字段 crontab: 分 时 日 月 周 (用户本地时区)。',
      '- 相对时间:"5分钟后" → 计算出具体的分和时,构造一次性 cron',
      '- 绝对时间:"15:30" → "30 15 <今日> <本月> *"',
      '- 重复:"每天9点" → "0 9 * * *"',
      '',
      'oneshot=true 表示只执行一次,false 表示重复执行。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        schedule: { type: 'string', description: '5字段 crontab 表达式 (用户本地时区)' },
        message: { type: 'string', description: '提醒内容,如 "吃饭"' },
        oneshot: { type: 'boolean', description: '是否一次性 (默认 true)', default: true },
      },
      required: ['schedule', 'message'],
    },
  },
  // ── Inter-agent communication ──
  {
    name: 'send_to_agent',
    description: [
      '向另一个 agent 发送消息。目标 agent 会在后台处理,结果推送给用户。',
      '用于多 agent 协作: 让专业 agent 处理特定子任务。',
      '',
      '示例: send_to_agent(agentId="research", message="帮我查一下 React 19 新特性")',
      '',
      '注意: 这是异步操作,你不会收到目标 agent 的回复。回复会直接推送给用户。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent ID (必须已存在)' },
        message: { type: 'string', description: '发送给目标 agent 的消息/任务' },
      },
      required: ['agentId', 'message'],
    },
  },
  // ── Synchronous task delegation ──
  {
    name: 'delegate_task',
    description: [
      '将任务委派给另一个 agent 并等待结果返回。与 send_to_agent 不同,这是同步操作 — 你会直接收到子 agent 的执行结果。',
      '',
      '适用场景:',
      '- 需要专业 agent 处理后你还要继续用结果的场景',
      '- 并行分发多个研究/分析任务',
      '- 需要隔离上下文的子任务',
      '',
      '限制: 最大递归深度 3 层,最大并发 5 个。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent ID (可选,不填则自动选择)' },
        goal: { type: 'string', description: '委派任务的目标描述' },
        context: { type: 'string', description: '传递给子 agent 的上下文信息 (可选)' },
        toolsets: {
          type: 'array',
          items: { type: 'string' },
          description: '限制子 agent 可用的工具集 (可选,如 ["research","browser"])',
        },
      },
      required: ['goal'],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

// ─────────────────────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  try {
    switch (name) {
      case 'memory':
        return await handleMemory(args as any)
      case 'session_search':
        return await handleSessionSearch(args as any)
      case 'skill_list':
        return await handleSkillList()
      case 'skill_view':
        return await handleSkillView(args as any)
      case 'skill_save':
        return await handleSkillSave(args as any)
      case 'skill_delete':
        return await handleSkillDelete(args as any)
      case 'archival_add':
        return await handleArchivalAdd(args as any)
      case 'archival_search':
        return await handleArchivalSearch(args as any)
      case 'archival_delete':
        return await handleArchivalDelete(args as any)
      case 'create_reminder':
        return await handleCreateReminder(args as any)
      case 'send_to_agent':
        return await handleSendToAgent(args as any)
      case 'delegate_task':
        return await handleDelegateTask(args as any)
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
    }
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `error: ${err?.message ?? String(err)}` }],
      isError: true,
    }
  }
})

async function handleMemory(args: {
  action: string
  target: 'memory' | 'user'
  content?: string
  needle?: string
}) {
  await memory.load() // refresh from disk every call (in case user edited via UI)
  const target = args.target
  switch (args.action) {
    case 'read': {
      const text = memory.read(target)
      return {
        content: [
          {
            type: 'text',
            text:
              text ||
              `(${target} is empty — use memory(add, ${target}, "...") to populate it with things worth remembering across sessions)`,
          },
        ],
      }
    }
    case 'add': {
      if (!args.content) return toolError('content required for add')
      const r = await memory.add(target, args.content)
      if (!r.ok) return toolError(r.error ?? 'add failed')
      return toolOk(`Added to ${target}. Current size: ${memory.charCount(target)} chars.`)
    }
    case 'replace': {
      if (!args.needle || !args.content) return toolError('needle and content required for replace')
      const r = await memory.replace(target, args.needle, args.content)
      if (!r.ok) return toolError(r.error ?? 'replace failed')
      return toolOk(`Replaced in ${target}.`)
    }
    case 'remove': {
      if (!args.needle) return toolError('needle required for remove')
      const r = await memory.remove(target, args.needle)
      if (!r.ok) return toolError(r.error ?? 'remove failed')
      return toolOk(`Removed from ${target}.`)
    }
    default:
      return toolError(`unknown action: ${args.action}`)
  }
}

async function handleSessionSearch(args: {
  query: string
  limit?: number
  agentId?: string
  summarize?: boolean
}) {
  // Default: search only THIS agent's sessions. Pass agentId to search another agent.
  const searchAgentId = args.agentId ?? AGENT_ID
  const limit = args.limit ?? 5

  // Use hybrid search (BM25 + vector) when embedding is available, else BM25-only
  const hits = embeddingProvider
    ? await hybridSessionSearch(args.query, embeddingProvider, limit, searchAgentId)
    : (await searchSessions(args.query, limit, searchAgentId)).map(h => ({
        ...h, bm25Rank: null as number | null, vecRank: null as number | null,
      }))

  if (hits.length === 0) {
    const scope = args.agentId ? ` (agent: ${args.agentId})` : ''
    return { content: [{ type: 'text', text: `No past sessions match "${args.query}"${scope}.` }] }
  }
  const scope = args.agentId ? ` (agent: ${args.agentId})` : ''
  const mode = embeddingProvider ? 'hybrid' : 'BM25'
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

async function handleSkillList() {
  const list = await skills.list()
  if (list.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No skills yet. Use `skill_save` to distill successful task resolutions into reusable skills.',
        },
      ],
    }
  }
  // PR4: group by source so the agent can tell platform-baseline (read-only,
  // auto-loaded by Claude Code) from user-created skills it can edit/delete.
  const platform = list.filter((s) => s.source === 'platform')
  const user = list.filter((s) => s.source === 'user')
  const lines = [`You have ${list.length} skill(s):`, '']
  if (platform.length > 0) {
    lines.push('## Platform baseline (read-only)')
    lines.push('')
    for (const s of platform) {
      lines.push(`### ${s.name}`)
      lines.push(s.description)
      if (s.tags && s.tags.length > 0) lines.push(`tags: ${s.tags.join(', ')}`)
      lines.push('')
    }
  }
  if (user.length > 0) {
    lines.push('## User-created')
    lines.push('')
    for (const s of user) {
      lines.push(`### ${s.name}`)
      lines.push(s.description)
      if (s.tags && s.tags.length > 0) lines.push(`tags: ${s.tags.join(', ')}`)
      lines.push('')
    }
  }
  lines.push('Use `skill_view(name)` to load full instructions for any skill above.')
  lines.push(
    'Baseline skills cannot be overwritten via `skill_save` (name is reserved) or deleted via `skill_delete`.',
  )
  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

async function handleSkillView(args: { name: string; subfile?: string }) {
  const v = await skills.view(args.name, args.subfile)
  if (!v) return toolError('skill not found')
  if (typeof v === 'string') {
    // Subfile read returns a bare string; we have no source metadata here without
    // a second lookup, but the containing skill_view call can be assumed to land
    // in whichever root actually owned the parent name (baseline-wins).
    return { content: [{ type: 'text', text: v }] }
  }
  const header = `[source: ${v.source}]`
  return { content: [{ type: 'text', text: `${header}\n\n${v.rawContent}` }] }
}

async function handleSkillSave(args: {
  name: string
  description: string
  body: string
  tags?: string[]
}) {
  const r = await skills.save(
    {
      name: args.name,
      description: args.description,
      tags: args.tags,
    },
    args.body,
  )
  if (!r.ok) return toolError(r.error ?? 'save failed')
  return toolOk(`Saved skill "${args.name}".`)
}

async function handleSkillDelete(args: { name: string }) {
  const r = await skills.delete(args.name)
  if (!r.ok) return toolError(r.error ?? 'delete failed')
  // PR4: when a user shadow was removed but the platform baseline remains,
  // propagate the note so the agent understands why list still shows the name.
  const msg = r.note
    ? `Deleted skill "${args.name}". ${r.note}`
    : `Deleted skill "${args.name}".`
  return toolOk(msg)
}

// ── Archival Memory handlers ──
async function handleArchivalAdd(args: { content: string; tags?: string }) {
  // Guard against missing/empty content — the archival table's `content` column
  // is NOT NULL, so reaching the INSERT with undefined surfaces a cryptic
  // "constraint failed" SQL error. Callers sometimes pass `title`/other
  // unsupported fields (schema only accepts `content` and `tags`, unknown
  // props are silently dropped by MCP), leaving `args.content` undefined.
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    return toolError(
      'archival_add requires a non-empty `content` string (schema only accepts `content` and optional `tags` — any `title` or other fields are dropped by MCP)',
    )
  }
  const id = await archivalAdd(AGENT_ID, args.content, args.tags)

  // P1: Generate embedding and store vector (fire-and-forget to avoid blocking response)
  // Tracked in pendingEmbeds so archival_delete can await before cleanup.
  if (embeddingProvider) {
    const provider = embeddingProvider
    const task = (async () => {
      try {
        const [vec] = await provider.embed([args.content], 'document')
        // Verify the archival row still exists before inserting vector
        // (a concurrent delete may have removed it during embedding)
        const db = await getSessionsDb()
        const row = db.prepare('SELECT 1 FROM archival WHERE id = ?').get(id)
        if (row) await upsertArchivalVector(id, vec)
      } catch (err: any) {
        process.stderr.write(`[mcp-memory] embedding failed for archival ${id}: ${err?.message}\n`)
      } finally {
        pendingEmbeds.delete(id)
      }
    })()
    // embed() is async — task always suspends at first await before finally runs,
    // so set() always registers before delete() fires.
    pendingEmbeds.set(id, task)
  }

  const count = await archivalCount(AGENT_ID)
  return toolOk(`Stored in archival memory (id=${id}). Total entries: ${count}`)
}

async function handleArchivalSearch(args: { query: string; limit?: number }) {
  if (typeof args.query !== 'string' || args.query.trim() === '') {
    return toolError('archival_search requires a non-empty `query` string')
  }
  const limit = args.limit ?? 5
  const results = await hybridArchivalSearch(AGENT_ID, args.query, embeddingProvider, limit)
  if (results.length === 0) return toolOk(`No archival entries match "${args.query}".`)

  // Track access for lifecycle (non-blocking)
  recordAccess(results.map(r => r.id)).catch(() => {})

  const mode = embeddingProvider ? 'hybrid (BM25+vector)' : 'BM25-only'
  const lines = results.map((r, i) => {
    const ranks: string[] = []
    if (r.bm25Rank != null) ranks.push(`bm25:#${r.bm25Rank}`)
    if (r.vecRank != null) ranks.push(`vec:#${r.vecRank}`)
    const rankInfo = ranks.length > 0 ? ` [${ranks.join(', ')}]` : ''
    return `[${i + 1}] id=${r.id} tags=${r.tags || '(none)'}${rankInfo}\n${r.content}`
  })
  return toolOk(
    `Found ${results.length} archival entries (${mode}):\n\n${lines.join('\n\n---\n\n')}`,
  )
}

async function handleArchivalDelete(args: { id: string }) {
  if (typeof args.id !== 'string' || args.id.trim() === '') {
    return toolError('archival_delete requires a non-empty `id` string (from archival_search results)')
  }
  const ok = await archivalDelete(AGENT_ID, args.id)
  if (!ok) return toolError(`Entry ${args.id} not found.`)

  // P1: Await any in-flight embedding before deleting vector (prevents add/delete race)
  const pending = pendingEmbeds.get(args.id)
  if (pending) await pending

  if (embeddingProvider) {
    try {
      await deleteArchivalVector(args.id)
    } catch (err: any) {
      // deleteArchivalVector does not throw on missing rows —
      // any error here is a real DB/vec issue, so log it.
      process.stderr.write(`[mcp-memory] vector delete failed for ${args.id}: ${err?.message}\n`)
    }
  }
  return toolOk(`Deleted archival entry ${args.id}.`)
}

// ─────────────────────────────────────────────────────────────
async function handleSendToAgent(args: { agentId: string; message: string }) {
  const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT || '18789'
  const gatewayToken = process.env.OPENCLAUDE_GATEWAY_TOKEN || ''
  const sourceAgent = process.env.OPENCLAUDE_AGENT_ID || 'unknown'
  try {
    const res = await fetch(
      `http://127.0.0.1:${gatewayPort}/api/agents/${encodeURIComponent(args.agentId)}/message`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({
          message: args.message,
          sourceAgent,
        }),
      },
    )
    if (!res.ok) {
      const err = await res.text()
      return toolError(`发送失败: ${err}`)
    }
    const data = (await res.json()) as any
    return toolOk(
      `✅ 已发送给 agent "${args.agentId}": "${args.message.slice(0, 50)}${args.message.length > 50 ? '...' : ''}"\n目标 agent 将在后台处理,结果会推送给用户。`,
    )
  } catch (err: any) {
    return toolError(`发送失败: ${err?.message ?? String(err)}`)
  }
}

async function handleDelegateTask(args: {
  agentId?: string
  goal: string
  context?: string
  toolsets?: string[]
}) {
  const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT || '18789'
  const gatewayToken = process.env.OPENCLAUDE_GATEWAY_TOKEN || ''
  const sourceAgent = process.env.OPENCLAUDE_AGENT_ID || 'unknown'
  const targetAgent = args.agentId || 'main'
  try {
    // Pass delegation depth so gateway can enforce recursion limit
    const currentDepth = Number.parseInt(process.env.OPENCLAUDE_DELEGATION_DEPTH || '0', 10)
    const res = await fetch(
      `http://127.0.0.1:${gatewayPort}/api/agents/${encodeURIComponent(targetAgent)}/delegate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayToken}`,
          'x-delegation-depth': String(currentDepth),
        },
        body: JSON.stringify({
          goal: args.goal,
          context: args.context,
          sourceAgent,
          toolsets: args.toolsets,
        }),
      },
    )
    if (!res.ok) {
      const err = await res.text()
      return toolError(`委派失败: ${err}`)
    }
    const data = (await res.json()) as any
    if (data.error) {
      return toolError(`子 agent 执行出错: ${data.error}`)
    }
    return toolOk(`✅ 委派完成 (agent: ${targetAgent})\n\n${data.output || '(无输出)'}`)
  } catch (err: any) {
    return toolError(`委派失败: ${err?.message ?? String(err)}`)
  }
}

async function handleCreateReminder(args: {
  schedule: string
  message: string
  oneshot?: boolean
}) {
  // Call the gateway's /api/cron endpoint to create the reminder
  const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT || '18789'
  const gatewayToken = process.env.OPENCLAUDE_GATEWAY_TOKEN || ''
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/api/cron`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        schedule: args.schedule,
        prompt: `请直接输出以下提醒内容,不要添加任何额外文字:\n\n⏰ 提醒: ${args.message}`,
        deliver: 'webchat',
        oneshot: args.oneshot !== false,
        label: args.message,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      return toolError(`创建提醒失败: ${err}`)
    }
    const data = (await res.json()) as any
    return toolOk(
      `✅ 提醒已创建: "${args.message}"\n⏰ 计划: \`${args.schedule}\`\nID: \`${data.job?.id ?? '?'}\`${args.oneshot !== false ? ' (一次性)' : ' (重复)'}`,
    )
  } catch (err: any) {
    return toolError(`创建提醒失败: ${err?.message ?? String(err)}`)
  }
}

function toolOk(msg: string) {
  return { content: [{ type: 'text', text: msg }] }
}
function toolError(msg: string) {
  return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
}

// ─────────────────────────────────────────────────────────────
// Expose session indexing to the gateway via env-controlled IPC-free path:
// the gateway writes directly to the same SQLite file; we re-export the API
// from @openclaude/storage so both processes can use it.

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[mcp-memory] started for agent=${AGENT_ID}\n`)
