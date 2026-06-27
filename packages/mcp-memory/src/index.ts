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
 *   • `skill_search`   — find relevant skills by metadata before loading bodies
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

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  type EmbeddingProvider,
  MemoryStore,
  SkillDraftStore,
  type SkillStore,
  buildAgentSkillStore,
  isPlatformReservedSkillName,
  validateSkillName,
  archivalAdd,
  archivalCount,
  archivalDelete,
  deleteArchivalVector,
  getEmbeddingProvider,
  getSessionsDb,
  // P1: Hybrid search (BM25 + Vector + RRF)
  hybridArchivalSearch,
  hybridSessionSearch,
  indexTurn,
  initVectorStore,
  isEmbeddingAvailable,
  loadSessionTurns,
  recordAccess,
  searchSessions,
  searchSkillMetadata,
  syncMarketplaceHub,
  upsertArchivalVector,
  upsertSessionMeta,
} from '@openclaude/storage'

const AGENT_ID = process.env.OPENCLAUDE_AGENT_ID ?? 'main'

/**
 * Read the gateway access token used to authenticate callbacks from this
 * mcp-memory subprocess into the parent gateway HTTP API
 * (`/api/agents/.../message`, `/api/cron`, `/api/...`).
 *
 * Two delivery channels, file-first:
 *
 *   1. `OPENCLAUDE_GATEWAY_TOKEN_FILE` — absolute path to a file containing
 *      the token. v3 codex spawn paths use this so the token is NOT exposed
 *      via the codex argv `-c mcp_servers.openclaude_memory.env={...}`
 *      injection (which would land the token in `ps -ef` / `/proc/<pid>/cmdline`).
 *      The file is written 0600 inside an mkdtemp'd sessionDir owned by the
 *      runner that spawned us, and torn down on shutdown.
 *
 *   2. `OPENCLAUDE_GATEWAY_TOKEN` — direct env var. ccb's subprocessRunner
 *      sets the env via execve (no argv exposure), so it can keep using this
 *      simpler path. master/personal codex paths also still use this.
 *
 * If the file path is set but unreadable we fall back to the env var rather
 * than crash — keeps the agent partially functional (auth-protected calls
 * will fail upstream with 401, which is observable). If neither is set, return
 * empty string and let the gateway reject the unauthenticated call.
 */
function readGatewayToken(): string {
  const file = process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch (err: any) {
      process.stderr.write(
        `[mcp-memory] OPENCLAUDE_GATEWAY_TOKEN_FILE unreadable (${file}), falling back to env: ${err?.message ?? err}\n`,
      )
    }
  }
  return process.env.OPENCLAUDE_GATEWAY_TOKEN || ''
}

const memory = new MemoryStore(AGENT_ID)
await memory.load()

function buildSkillStore(): SkillStore {
  // Overlay (single wiring in @openclaude/storage): platform baseline (ro env)
  // > agent-seed (ro) > shared (rw, user-level/all-agents; single write source)
  // > legacy per-agent. Degrades gracefully if a dir is invalid.
  return buildAgentSkillStore(AGENT_ID)
}

const skills = buildSkillStore()

// Skill-training run id, set by the gateway ONLY when this mcp-memory subprocess is
// itself a skill-training session. When present, the draft-only `skill_propose` tool
// is exposed so the agent can stage candidate skill changes for this run. This env is
// the authoritative run identity — the model cannot redirect proposals to a different
// run via tool args (guarded in handleSkillPropose). Absent in normal sessions, where
// skill_propose is neither listed nor usable.
const SKILL_TRAIN_RUN_ID = (process.env.OPENCLAUDE_SKILL_TRAIN_RUN_ID ?? '').trim()
const drafts = new SkillDraftStore()

// Track in-flight embedding tasks to prevent add/delete race conditions
const pendingEmbeds = new Map<string, Promise<void>>()

// ── P1: Initialize archival schema + embedding + vector store ─
// archivalCount triggers ensureSchema() which creates archival + archival_fts tables.
// Must run before hybridArchivalSearch which queries archival_fts directly.
await archivalCount(AGENT_ID)

// Reconcile installed marketplace skills into the hub layer (v3 only; no-op
// otherwise). Fire-and-forget + fail-soft so it never delays mcp readiness.
void syncMarketplaceHub()

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
    name: 'skill_search',
    description: [
      'Search available skills by name, description, tags, and related_skills.',
      'Use this before `skill_view` when you need a relevant skill but do not know its exact name.',
      'Also use this before `skill_save` to avoid creating duplicate skills.',
      'Returns metadata only; call `skill_view(name)` for full instructions.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "deploy", "定时任务", "skill search"' },
        limit: {
          type: 'number',
          default: 5,
          description: 'Max results to return (clamped to 1..25)',
        },
      },
      required: ['query'],
    },
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
      '  force       — optional; set true to skip the near-duplicate check',
      '',
      'Before creating a NEW skill, this checks whether a semantically similar',
      'skill already exists. If one does, the save is declined with a pointer to',
      'it — prefer updating that skill (skill_save with its name) over adding a',
      'near-duplicate. Pass force:true to create anyway.',
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
        force: { type: 'boolean' },
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
          description:
            '可选:为子 agent 额外授予的平台工具集名(目前仅 "browser";网页提取/论文下载已是常驻 CLI——oc-web / scansci-pdf,无需工具集)。通常无需手动指定 —— 系统会按任务目标自动挂载;只能授予平台已配置的工具集,无法越权,填错或填不存在的名字会被忽略而非报错。',
        },
      },
      required: ['goal'],
    },
  },
  // (v5 ccb-only:ask_gpt55_codex direct bridge 已移除 —— 无 codex agent。)
]

// Draft-only skill proposal tool. Exposed ONLY inside a skill-training session
// (OPENCLAUDE_SKILL_TRAIN_RUN_ID set). Stages a candidate change into the run's draft
// area; it never touches the authoritative library. The user reviews each draft as a
// diff and confirms the merge afterward.
const SKILL_PROPOSE_TOOL = {
  name: 'skill_propose',
  description: [
    'Stage a candidate skill change for the current training run (draft only — NOT applied).',
    'The user reviews your proposals as a diff and confirms the merge afterward.',
    '',
    'Provide:',
    '  name        — target skill name (lowercase a-z 0-9 -, max 64 chars)',
    '  op          — "create" (new skill), "update" (revise existing), or "delete" (propose removal)',
    '  description — when-to-use summary (required for create/update, max 1024 chars)',
    '  body        — full SKILL.md instructions (required for create/update)',
    '  tags        — optional topical tags',
    '  rationale   — one paragraph citing the evidence sessions for this change',
    '',
    'Only USER-AUTHORED skills can be proposed against; platform baseline/agent-seed skills are rejected.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      op: { type: 'string', enum: ['create', 'update', 'delete'] },
      description: { type: 'string' },
      body: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
    },
    required: ['name', 'op', 'rationale'],
  },
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  // In a training session the authoritative-write tools are REMOVED (training must
  // only stage drafts via skill_propose); normal sessions keep the full toolset.
  tools: SKILL_TRAIN_RUN_ID
    ? [
        ...TOOLS.filter((t) => t.name !== 'skill_save' && t.name !== 'skill_delete'),
        SKILL_PROPOSE_TOOL,
      ]
    : TOOLS,
}))

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
      case 'skill_search':
        return await handleSkillSearch(args as any)
      case 'skill_view':
        return await handleSkillView(args as any)
      case 'skill_save':
        return await handleSkillSave(args as any)
      case 'skill_delete':
        return await handleSkillDelete(args as any)
      case 'skill_propose':
        return await handleSkillPropose(args as any)
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

/**
 * v3 semantic skill ranking via the master embedding relay. The DashScope key
 * lives on master (never in the container) — we send only raw skill metadata
 * (master computes the content hash + embed text itself, so a container can't
 * poison the shared cache), and the cleaned query is embedded master-side.
 * Returns validated ranked {name, score} or null to signal "fall back to the
 * deterministic keyword search" (no master configured = personal version, or
 * any relay/embedding failure). Never throws.
 */
async function semanticSkillRank(
  list: Array<{ name: string; description: string; tags?: string[]; related_skills?: string[] }>,
  query: string,
  limit: number | undefined,
): Promise<Array<{ name: string; score: number }> | null> {
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token || list.length === 0) return null
  try {
    const res = await postJsonToGateway(`${base.replace(/\/+$/, '')}/internal/v3/skill-embed`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query,
        limit,
        skills: list.map((s) => ({
          name: s.name,
          description: s.description,
          tags: s.tags,
          related_skills: s.related_skills,
        })),
      }),
      timeoutMs: 3500,
    })
    if (res.statusCode < 200 || res.statusCode >= 300) return null
    const data = JSON.parse(res.body) as { ok?: boolean; ranked?: unknown }
    if (!data.ok || !Array.isArray(data.ranked)) return null
    const ranked = data.ranked.filter(
      (r): r is { name: string; score: number } =>
        !!r && typeof r.name === 'string' && typeof r.score === 'number',
    )
    return ranked.length > 0 ? ranked : null
  } catch {
    return null // fail-closed → keyword
  }
}

async function handleSkillSearch(args: { query: string; limit?: number } | undefined) {
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!query) return toolError('query required')

  const list = await skills.list()

  // v3: semantic ranking via master relay (key stays on master); any miss → keyword fallback.
  const semantic = await semanticSkillRank(list, query, args?.limit)
  if (semantic) {
    const byName = new Map(list.map((s) => [s.name, s]))
    const matched = semantic.map((r) => ({ r, s: byName.get(r.name) })).filter((x) => x.s)
    // If none of the ranked names map back to a known skill, treat as a miss
    // and fall through to keyword rather than emitting an empty "Found N".
    if (matched.length > 0) {
      const lines = [`Found ${matched.length} relevant skill(s) for "${query}" (semantic):`, '']
      for (const { r, s } of matched) {
        lines.push(`### ${r.name} [source: ${s!.source}, relevance: ${r.score.toFixed(3)}]`)
        lines.push(s!.description)
        if (s!.tags && s!.tags.length > 0) lines.push(`tags: ${s!.tags.join(', ')}`)
        if (s!.related_skills && s!.related_skills.length > 0)
          lines.push(`related_skills: ${s!.related_skills.join(', ')}`)
        lines.push('')
      }
      lines.push('Next: call `skill_view(name)` for the best match before applying it.')
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }
  }

  const hits = searchSkillMetadata(list, query, args?.limit)
  if (hits.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: [
            `No matching skills found for "${query}".`,
            'Try a broader query or call `skill_list()` to browse all available skills.',
            'If this was a reusable workflow you just validated, create it with `skill_save` after the task is complete.',
          ].join('\n'),
        },
      ],
    }
  }

  const lines = [`Found ${hits.length} matching skill(s) for "${query}":`, '']
  for (const s of hits) {
    lines.push(`### ${s.name} [source: ${s.source}, score: ${s.score}]`)
    lines.push(s.description)
    if (s.tags && s.tags.length > 0) lines.push(`tags: ${s.tags.join(', ')}`)
    if (s.related_skills && s.related_skills.length > 0)
      lines.push(`related_skills: ${s.related_skills.join(', ')}`)
    if (s.matched.length > 0) lines.push(`matched: ${s.matched.join(', ')}`)
    lines.push('')
  }
  lines.push('Next: call `skill_view(name)` for the best match before applying it.')
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

// Cosine threshold above which a new skill is treated as a near-duplicate of an
// existing one. Conservative (force-overridable) to avoid blocking legit skills.
const SKILL_DUP_THRESHOLD = 0.82

/**
 * v3 near-duplicate detection for skill_save. Reuses the master embedding relay
 * (DashScope key stays on master): ranks existing skills against the new skill's
 * text and returns the closest one if above the similarity threshold. Excludes a
 * same-named skill (that is an update, not a duplicate). Fail-open — any miss
 * (no master configured / relay error / timeout) returns null and the save
 * proceeds, so this is a soft quality gate, never a hard dependency.
 */
async function findNearDuplicateSkill(
  meta: { name: string; description: string; tags?: string[] },
  existing: Array<{ name: string; description: string; tags?: string[]; related_skills?: string[] }>,
): Promise<{ name: string; score: number } | null> {
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  const others = existing.filter((s) => s.name !== meta.name)
  if (!base || !token || others.length === 0) return null
  try {
    const res = await postJsonToGateway(`${base.replace(/\/+$/, '')}/internal/v3/skill-embed`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        // include tags so dedup doesn't rely on description text alone
        query: [meta.name, meta.description, ...(meta.tags ?? [])].join(' '),
        // ask for several: exact-name-guard may reorder, so scan for the true
        // highest-cosine candidate rather than trusting index 0
        limit: 5,
        skills: others.map((s) => ({
          name: s.name,
          description: s.description,
          tags: s.tags,
          related_skills: s.related_skills,
        })),
      }),
      timeoutMs: 3500,
    })
    if (res.statusCode < 200 || res.statusCode >= 300) return null
    const data = JSON.parse(res.body) as { ok?: boolean; ranked?: unknown }
    if (!data.ok || !Array.isArray(data.ranked)) return null
    let best: { name: string; score: number } | null = null
    for (const r of data.ranked) {
      if (!r || typeof r.name !== 'string' || typeof r.score !== 'number') continue
      if (!best || r.score > best.score) best = { name: r.name, score: r.score }
    }
    return best && best.score >= SKILL_DUP_THRESHOLD ? best : null
  } catch {
    return null // fail-open → save proceeds
  }
}

async function handleSkillSave(args: {
  name: string
  description: string
  body: string
  tags?: string[]
  force?: boolean
}) {
  // Defense in depth: training sessions must never write the authoritative library
  // (the tool is also removed from the training tool list above).
  if (SKILL_TRAIN_RUN_ID) {
    return toolError('skill_save is disabled during a training run — use skill_propose (draft only)')
  }
  // Near-duplicate soft gate: steer toward updating an existing similar skill
  // rather than growing the library uncontrolled. force:true bypasses. Only the
  // v3 path (master configured) runs it — personal version skips entirely (no
  // extra skills.list() cost).
  if (!args.force && process.env.OPENCLAUDE_V3_MASTER_BASE_URL && process.env.OPENCLAUDE_V3_CONTAINER_TOKEN) {
    const dup = await findNearDuplicateSkill(
      { name: args.name, description: args.description, tags: args.tags },
      await skills.list(),
    )
    if (dup) {
      return toolError(
        [
          `A semantically similar skill already exists: "${dup.name}" (similarity ${dup.score.toFixed(2)}).`,
          `Prefer updating it — call skill_save with name="${dup.name}".`,
          'To create this as a separate new skill anyway, call skill_save again with force:true.',
        ].join(' '),
      )
    }
  }
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
  if (SKILL_TRAIN_RUN_ID) {
    return toolError(
      'skill_delete is disabled during a training run — use skill_propose op="delete" (draft only)',
    )
  }
  const r = await skills.delete(args.name)
  if (!r.ok) return toolError(r.error ?? 'delete failed')
  // PR4: when a user shadow was removed but the platform baseline remains,
  // propagate the note so the agent understands why list still shows the name.
  const msg = r.note
    ? `Deleted skill "${args.name}". ${r.note}`
    : `Deleted skill "${args.name}".`
  return toolOk(msg)
}

// Draft-only proposal handler (skill-training sessions only). Stages a candidate
// change into the run's draft area; never writes the authoritative library. Authority
// rules: (1) the run id comes from the spawn env, not tool args — the model cannot
// redirect drafts to another run; (2) only user-authored skills may be proposed
// against — platform baseline/agent-seed skills are read-only and rejected.
async function handleSkillPropose(args: {
  name: string
  op: 'create' | 'update' | 'delete'
  description?: string
  body?: string
  tags?: string[]
  rationale?: string
  runId?: string
}) {
  if (!SKILL_TRAIN_RUN_ID) {
    return toolError('skill_propose is only available during a skill-training run')
  }
  if (args.runId && args.runId !== SKILL_TRAIN_RUN_ID) {
    return toolError(`runId mismatch — this training run is "${SKILL_TRAIN_RUN_ID}"`)
  }
  const op = args.op
  if (op !== 'create' && op !== 'update' && op !== 'delete') {
    return toolError('op must be "create", "update", or "delete"')
  }
  const nameCheck = validateSkillName(args.name)
  if (!nameCheck.ok) return toolError(nameCheck.error ?? 'invalid skill name')
  const rationale = typeof args.rationale === 'string' ? args.rationale.trim() : ''
  if (!rationale) return toolError('rationale required — cite the evidence for this change')

  // Authoritative reserved-name guard: reject names reserved by the env baseline OR
  // ANY agent's seed up front (same invariant SkillStore.save enforces at merge), not
  // just the names visible in THIS training agent's overlay.
  if (await isPlatformReservedSkillName(args.name)) {
    return toolError(`"${args.name}" is reserved by a platform skill — cannot propose changes to it`)
  }

  // Resolve the current authoritative skill (baseline-wins overlay) for authority
  // checks + base-version pinning.
  const current = await skills.view(args.name)
  const currentMeta = current && typeof current !== 'string' ? current : null
  if (currentMeta && currentMeta.source === 'platform') {
    return toolError(
      `"${args.name}" is a platform skill (read-only) — cannot propose changes to it`,
    )
  }
  if (op === 'create' && currentMeta) {
    return toolError(`"${args.name}" already exists — use op="update" instead`)
  }
  if ((op === 'update' || op === 'delete') && !currentMeta) {
    return toolError(`"${args.name}" not found among your skills — use op="create" to add it`)
  }
  if (op !== 'delete') {
    const description = typeof args.description === 'string' ? args.description.trim() : ''
    const body = typeof args.body === 'string' ? args.body : ''
    if (!description) return toolError('description required for create/update')
    if (!body.trim()) return toolError('body required for create/update')
    const res = await drafts.writeDraft({
      runId: SKILL_TRAIN_RUN_ID,
      op,
      meta: { name: args.name, description, tags: args.tags },
      body,
      rationale,
      authoredBy: 'ai',
      baseVersion: currentMeta?.version ?? null,
    })
    if (!res.ok) return toolError(res.error ?? 'propose failed')
  } else {
    const res = await drafts.writeDraft({
      runId: SKILL_TRAIN_RUN_ID,
      op: 'delete',
      meta: { name: args.name, description: currentMeta?.description ?? '' },
      body: '',
      rationale,
      authoredBy: 'ai',
      baseVersion: currentMeta?.version ?? null,
    })
    if (!res.ok) return toolError(res.error ?? 'propose failed')
  }
  return toolOk(
    `Staged ${op} draft for "${args.name}" (run ${SKILL_TRAIN_RUN_ID}). Awaiting user review in the diff panel.`,
  )
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
  const gatewayToken = readGatewayToken()
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
  return handleDelegateTaskToAgent(args.agentId || 'main', {
    goal: args.goal,
    context: args.context,
    toolsets: args.toolsets,
    label: args.agentId || 'main',
  })
}

// (v5 ccb-only:handleAskGpt55Codex 已移除 —— 无 codex agent。)

/**
 * The captain's HTTP client must wait strictly longer than the gateway's
 * authoritative delegate lifetime. The gateway runs the child up to its hard
 * timeout — delegateTimeout.ts clamps that to at most 2h — and ALWAYS sends an
 * HTTP response (on completion / idle timeout / hard timeout). It only writes
 * that response after the child finishes; progress streams over a separate WS,
 * so nothing flows on this socket until the very end. The original code used
 * global fetch, whose undici default 5min headersTimeout aborted any non-trivial
 * delegation mid-run → "委派失败: fetch failed", while the orphaned child kept
 * burning tokens.
 *
 * The gateway is the single authority on delegate lifetime; the client only has
 * to outlast the gateway's maximum possible hold time. Since that ceiling is a
 * fixed 2h (delegateTimeout.ts hard-timeout clamp), wait 2h + a margin — this
 * never re-splits the two sides regardless of any OPENCLAUDE_DELEGATE_HARD_*
 * env tuning (the gateway can never exceed its own clamp).
 */
const DELEGATE_CLIENT_TIMEOUT_MS = 2 * 60 * 60_000 + 60_000

/**
 * node:http surfaces the real transport failure on `err.code` (ECONNREFUSED,
 * ECONNRESET, socket timeout…). Fold the code into the message so delegation
 * failures are diagnosable instead of the opaque dead-end the old fetch path
 * produced.
 */
function describeDelegateTransportError(err: any): string {
  const code = err?.code || err?.cause?.code
  const base = err?.message ?? String(err)
  return code ? `${base} (${code})` : base
}

/**
 * POST JSON to the in-container gateway over node:http. We deliberately avoid
 * global fetch / undici here: the only knob we need is "wait long enough for the
 * gateway to answer", and a socket-inactivity timeout gives exactly that without
 * pulling in undici's separate 5min headersTimeout (the original bug) or a new
 * runtime dependency for this spawned MCP subprocess. Nothing flows on the
 * socket until the gateway finishes the whole child run, so the inactivity timer
 * acts as the total client wait cap.
 */
function postJsonToGateway(
  url: string,
  opts: { headers: Record<string, string>; body: string; timeoutMs: number },
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk as Buffer))
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(opts.timeoutMs, () => {
      const err: any = new Error(`delegate client timeout after ${Math.round(opts.timeoutMs / 1000)}s`)
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.end(opts.body)
  })
}

async function handleDelegateTaskToAgent(
  targetAgent: string,
  args: {
    goal: string
    context?: string
    toolsets?: string[]
    label: string
  },
) {
  const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT || '18789'
  const gatewayToken = readGatewayToken()
  const sourceAgent = process.env.OPENCLAUDE_AGENT_ID || 'unknown'
  const parentSessionKey = process.env.OPENCLAUDE_SESSION_KEY || ''
  try {
    // Pass delegation depth so gateway can enforce recursion limit
    const currentDepth = Number.parseInt(process.env.OPENCLAUDE_DELEGATION_DEPTH || '0', 10)
    const res = await postJsonToGateway(
      `http://127.0.0.1:${gatewayPort}/api/agents/${encodeURIComponent(targetAgent)}/delegate`,
      {
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
          ...(parentSessionKey ? { streamProgress: true, parentSessionKey } : {}),
        }),
        timeoutMs: DELEGATE_CLIENT_TIMEOUT_MS,
      },
    )
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return toolError(`委派失败: ${res.body}`)
    }
    const data = JSON.parse(res.body) as any
    if (data.error || data.ok === false) {
      return toolError(`子 agent 执行出错: ${data.error || data.output || 'unknown error'}`)
    }
    const output = data.output || ''
    if (looksLikeDelegateApiError(output)) {
      return toolError(`子 agent 执行出错: ${output}`)
    }
    return toolOk(`✅ 委派完成 (agent: ${args.label})\n\n${output || '(无输出)'}`)
  } catch (err: any) {
    return toolError(`委派失败: ${describeDelegateTransportError(err)}`)
  }
}

function looksLikeDelegateApiError(raw: unknown): boolean {
  const s = String(raw ?? '').trim()
  if (!s) return false
  return /^API Error:\s*(?:\d{3}\b|\{)/i.test(s)
}

async function handleCreateReminder(args: {
  schedule: string
  message: string
  oneshot?: boolean
}) {
  // Call the gateway's /api/cron endpoint to create the reminder
  const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT || '18789'
  const gatewayToken = readGatewayToken()
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
