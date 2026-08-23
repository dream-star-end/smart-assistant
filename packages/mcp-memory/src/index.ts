#!/usr/bin/env node
/**
 * @openclaude/mcp-memory
 *
 * MCP server that exposes OpenClaude's learning loop to the spawned CCB
 * subprocess. This is how the agent gains the ability to:
 *
 *   • `skill_list`     — discover its own accumulated skills (tier-1 progressive disclosure)
 *   • `skill_search`   — find relevant skills by metadata before loading bodies
 *   • `skill_view`     — load a skill's full instructions (tier-2/3)
 *   • `skill_save`     — distill a successful task into a reusable skill
 *   • `skill_delete`
 *   • reminder / delegate / taskboard tools (see TOOLS below)
 *
 * NOTE: the recall/archival tools (`session_search`, `archival_add`,
 * `archival_search`, `archival_delete`) used to live here too. They were moved
 * OUT of this long-lived stdio server into the one-shot `oc-memory` CLI
 * (packages/mcp-memory/src/ocMemoryCli.ts, shared logic in memoryTools.ts) — a
 * persistent stdio transport is fragile (console pollution or a crash kills the
 * whole transport → codex hangs). The Core `memory` tool (add/replace/remove/read
 * over MEMORY.md/USER.md) has since been RETIRED entirely (memdir refactor):
 * Core memory is now direct file editing under agents/<id>/memory/ + a MEMORY.md
 * index (see @openclaude/storage MemoryDir). skill / reminder / delegate tools
 * remain here (lower frequency, delegate needs the long-lived gateway-callback socket).
 *
 * Configuration: the server is spawned per-session by the gateway with
 *   env OPENCLAUDE_AGENT_ID=<id>   (which agent this subprocess belongs to)
 *   env OPENCLAUDE_HOME=...        (optional override)
 *
 * Protocol: MCP stdio transport, official @modelcontextprotocol/sdk.
 */

// 必须第一个 import:stdout 只留给 JSON-RPC + 未捕获异常不退出(见 mcpStdioGuard 注释)。
import './mcpStdioGuard.js'
import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  SkillDraftStore,
  type SkillStore,
  buildAgentSkillStore,
  isPlatformReservedSkillName,
  parseSkillEvalsJson,
  searchSkillMetadata,
  serializeSkillEvals,
  syncMarketplaceHub,
  validateSkillName,
} from '@openclaude/storage'

import {
  type FanoutTask,
  aggregateDelegateFanoutResults,
  normalizeFanoutTasks,
} from './delegateFanout.js'
import { normalizeDelegateAgentId, normalizeDelegateModel } from './delegateArgs.js'
import {
  formatDelegateFanoutRunning,
  resolveCursorFastWaitMs,
  runCursorDelegateFastPath,
  type FanoutCursorItem,
  type FormattedDelegateResult,
} from './delegateCursorFastPath.js'
import { formatSendToAgentStart } from './sendToAgent.js'
import {
  describeDelegateTransportError,
  gatewayDelegateHeaders,
  gatewayBaseUrl,
  postJsonToGateway,
  readGatewayToken,
} from './gatewayClient.js'
import {
  askUserHttpTimeoutMs,
  askUserToolPostedFallback,
  askUserToolResultFromGateway,
  remainingAskUserWaitMs,
} from './askUserClient.js'
import { type ReminderJobView, formatReminderList } from './reminderFormat.js'
import { rejectClientAssignedResumeIds, resolveReminderResume } from './reminderResume.js'
import { filterSkillEvalTools, isSkillEvalBlockedTool } from './skillEvalToolPolicy.js'
// Tool 定义(TOOLS / SKILL_PROPOSE_TOOL)抽到 ./toolDefs.ts(纯数据模块,无副作用),
// 让「TOOLS ↔ toolNames.ts」锁步单测能直接 import 校验,而不触发本入口模块顶层的
// server.connect(见 toolDefs.ts / __tests__/toolNames.test.ts)。
import {
  handleTaskComment,
  handleTaskCreate,
  handleTaskGet,
  handleTaskList,
  handleTaskUpdate,
} from './taskboardMcp.js'
import { SKILL_PROPOSE_TOOL, TOOLS, normalizeAskUserQuestions } from './toolDefs.js'
import {
  cursorDelegateCliHint,
  isCursorHiddenDelegateTool,
} from './cursorDelegatePolicy.js'

const AGENT_ID = process.env.OPENCLAUDE_AGENT_ID ?? 'main'
/** 本 MCP 子进程的委派深度(由网关 spawn env 注入)。>0 = 子 agent 环境,
 *  没有直接面向用户的交互面 —— ask_user 直接短路返回 skipped。 */
const DELEGATION_DEPTH = Math.max(
  0,
  Number.parseInt(process.env.OPENCLAUDE_DELEGATION_DEPTH || '0', 10) || 0,
)
/** 引擎身份(由网关 spawn env 注入)。ask_user 定义保留但默认不暴露:
 *  Cursor 已改走正文 ```options 围栏;仅 OC_ASK_USER_MCP=1 时恢复原 MCP 卡。
 *  恢复时仍只挂在 Cursor 主会话上 —— CCB/Codex 各有原生提问工具。 */
const ENGINE_ID = (process.env.OPENCLAUDE_ENGINE || '').trim().toLowerCase()
const ASK_USER_MCP_ESCAPE = process.env.OC_ASK_USER_MCP === '1'
const ASK_USER_ENABLED = ENGINE_ID === 'cursor'

function buildSkillStore(): SkillStore {
  // Overlay (single wiring in @openclaude/storage): platform baseline (ro env)
  // > agent-seed (ro) > shared (rw, user-level/all-agents; single write source)
  // > legacy per-agent. Degrades gracefully if a dir is invalid.
  return buildAgentSkillStore(AGENT_ID)
}

const skills = buildSkillStore()

// ── Skill-eval arm 控制(评测隔离会话专用,普通会话两个 env 均缺省) ──
// EXCLUDE:'without' 基线 —— 目标技能对本会话完全不可见(list/search/view 全隐藏,
// 与 promptSlots SKILLS 摘要的同名过滤配对;漏一半就是假基线)。
// DRAFT:'draft' arm —— 目标技能以草稿目录内容替换现版(view 返草稿,list 描述用草稿)。
// 评测会话总开关:置 1 时本会话禁止 skill_save/skill_delete(评测跑分不得污染技能库)。
const SKILL_EVAL_MODE = (process.env.OPENCLAUDE_SKILL_EVAL_MODE ?? '').trim() === '1'
const SKILL_EVAL_EXCLUDE = (process.env.OPENCLAUDE_SKILL_EVAL_EXCLUDE ?? '').trim()
const SKILL_EVAL_DRAFT_NAME = (process.env.OPENCLAUDE_SKILL_EVAL_DRAFT_NAME ?? '').trim()
const SKILL_EVAL_DRAFT_DIR = (process.env.OPENCLAUDE_SKILL_EVAL_DRAFT_DIR ?? '').trim()

function evalDraftRaw(): string | null {
  if (!SKILL_EVAL_DRAFT_NAME || !SKILL_EVAL_DRAFT_DIR) return null
  try {
    return readFileSync(`${SKILL_EVAL_DRAFT_DIR}/SKILL.md`, 'utf8')
  } catch {
    return null
  }
}

/** list() 结果按评测 arm 调整(exclude 滤掉 / draft 换描述)。 */
function applyEvalArmToList<T extends { name: string; description: string }>(list: T[]): T[] {
  let out = list
  if (SKILL_EVAL_EXCLUDE) out = out.filter((s) => s.name !== SKILL_EVAL_EXCLUDE)
  if (SKILL_EVAL_DRAFT_NAME) {
    const raw = evalDraftRaw()
    if (raw) {
      const m = raw.match(/^description:\s*(.+)$/m)
      const desc = m ? m[1].trim().replace(/^"|"$/g, '') : null
      if (desc) out = out.map((s) => (s.name === SKILL_EVAL_DRAFT_NAME ? { ...s, description: desc } : s))
    }
  }
  return out
}

// Skill-training run id, set by the gateway ONLY when this mcp-memory subprocess is
// itself a skill-training session. When present, the draft-only `skill_propose` tool
// is exposed so the agent can stage candidate skill changes for this run. This env is
// the authoritative run identity — the model cannot redirect proposals to a different
// run via tool args (guarded in handleSkillPropose). Absent in normal sessions, where
// skill_propose is neither listed nor usable.
const SKILL_TRAIN_RUN_ID = (process.env.OPENCLAUDE_SKILL_TRAIN_RUN_ID ?? '').trim()
const drafts = new SkillDraftStore()

// Reconcile installed marketplace skills into the hub layer (v3 only; no-op
// otherwise). Fire-and-forget + fail-soft so it never delays mcp readiness.
void syncMarketplaceHub()

// NOTE: session_search / archival_* moved to the oc-memory CLI; the Core `memory`
// tool is retired (memdir — Core memory is direct file editing now). The archival
// schema bootstrap and embedding-provider init that used to live here now live in
// createMemoryToolsContext (memoryTools.ts), constructed per CLI invocation. This
// server no longer touches memory state.

const server = new Server(
  { name: 'openclaude-memory', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// ─────────────────────────────────────────────────────────────
// Tool definitions → ./toolDefs.ts(纯数据模块,见顶部 import)。抽成零副作用后
// 「TOOLS 名单 ↔ toolNames.ts」锁步单测可直接 import 校验,不必触发本入口模块顶层的
// server.connect;新增/改名工具漏改任一侧都会被测试拦下。recall/archival 与已退役的
// Core `memory` 为何不在表内,见 toolDefs.ts 文件头 NOTE。
// ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Training session REMOVES authoritative-write tools (only skill_propose drafts).
  let base = SKILL_TRAIN_RUN_ID
    ? [
        ...TOOLS.filter((t) => t.name !== 'skill_save' && t.name !== 'skill_delete'),
        SKILL_PROPOSE_TOOL,
      ]
    : TOOLS
  // ask_user 默认不暴露(Cursor 已改走正文 ```options 围栏)。仅当
  // OC_ASK_USER_MCP=1 且本进程是 Cursor 主会话时才恢复暴露。
  // discovery 过滤不是授权边界,CallTool 侧还有短路兜底。
  if (DELEGATION_DEPTH > 0 || !ASK_USER_ENABLED || !ASK_USER_MCP_ESCAPE) {
    base = base.filter((t) => t.name !== 'ask_user')
  }
  if (ENGINE_ID === 'cursor') {
    base = base.filter((t) => !isCursorHiddenDelegateTool(t.name, 'cursor'))
  }
  return { tools: filterSkillEvalTools(base, SKILL_EVAL_MODE) }
})

// ─────────────────────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  try {
    // Discovery filtering is not an authorization boundary: an MCP client can
    // still call a hidden tool by name. Reject before any gateway request,
    // persistent write, or delegation starts.
    if (SKILL_EVAL_MODE && isSkillEvalBlockedTool(name)) {
      return toolError(`tool "${name}" is disabled in eval sessions`)
    }
    if (isCursorHiddenDelegateTool(name)) {
      return toolError(cursorDelegateCliHint(name))
    }
    switch (name) {
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
      case 'create_reminder':
        return await handleCreateReminder(args as any)
      case 'list_reminders':
        return await handleListReminders()
      case 'update_reminder':
        return await handleUpdateReminder(args as any)
      case 'delete_reminder':
        return await handleDeleteReminder(args as any)
      case 'send_to_agent':
        return await handleSendToAgent(args as any)
      case 'delegate_task':
        return await handleDelegateTask(args as any)
      case 'delegate_tasks':
        return await handleDelegateTasks(args as any)
      case 'request_review':
        return await handleRequestReview(args as any)
      case 'task_create':
        return await handleTaskCreate(args as any)
      case 'task_update':
        return await handleTaskUpdate(args as any)
      case 'task_comment':
        return await handleTaskComment(args as any)
      case 'task_list':
        return await handleTaskList(args as any)
      case 'task_get':
        return await handleTaskGet(args as any)
      case 'ask_user':
        return await handleAskUser(args as any)
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

async function handleSkillList() {
  const list = applyEvalArmToList(await skills.list())
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

  const list = applyEvalArmToList(await skills.list())

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
  if (SKILL_EVAL_EXCLUDE && args.name === SKILL_EVAL_EXCLUDE) return toolError('skill not found')
  if (SKILL_EVAL_DRAFT_NAME && args.name === SKILL_EVAL_DRAFT_NAME && !args.subfile) {
    const raw = evalDraftRaw()
    if (raw) return { content: [{ type: 'text', text: `[source: user]\n\n${raw}` }] }
  }
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
  existing: Array<{
    name: string
    description: string
    tags?: string[]
    related_skills?: string[]
  }>,
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
    return toolError(
      'skill_save is disabled during a training run — use skill_propose (draft only)',
    )
  }
  // Near-duplicate soft gate: steer toward updating an existing similar skill
  // rather than growing the library uncontrolled. force:true bypasses. Only the
  // v3 path (master configured) runs it — personal version skips entirely (no
  // extra skills.list() cost).
  if (
    !args.force &&
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL &&
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  ) {
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
  if (SKILL_EVAL_MODE) return toolError('skill writes are disabled in eval sessions')
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
  if (SKILL_EVAL_MODE) return toolError('skill writes are disabled in eval sessions')
  const r = await skills.delete(args.name)
  if (!r.ok) return toolError(r.error ?? 'delete failed')
  // PR4: when a user shadow was removed but the platform baseline remains,
  // propagate the note so the agent understands why list still shows the name.
  const msg = r.note ? `Deleted skill "${args.name}". ${r.note}` : `Deleted skill "${args.name}".`
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
  evals?: unknown
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
    return toolError(
      `"${args.name}" is reserved by a platform skill — cannot propose changes to it`,
    )
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
    // 随草稿提议的评测用例:先过 schema 校验再落盘(坏用例直接拒,防污染评测门)。
    let evalsJson: string | undefined
    if (args.evals !== undefined) {
      const parsedEvals = parseSkillEvalsJson(JSON.stringify(args.evals))
      if (!parsedEvals.ok) {
        return toolError(`evals 不合法: ${parsedEvals.errors.join('; ')}`)
      }
      evalsJson = serializeSkillEvals(parsedEvals.file)
    }
    const res = await drafts.writeDraft({
      runId: SKILL_TRAIN_RUN_ID,
      op,
      evalsJson,
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

// ─────────────────────────────────────────────────────────────
async function handleSendToAgent(args: { agentId: string; message: string }) {
  const agentNorm = normalizeDelegateAgentId(args.agentId)
  if (!agentNorm.ok) return toolError(agentNorm.error)
  const agentId = agentNorm.agentId
  if (!agentId) return toolError('agentId 必填')
  const sourceAgent = process.env.OPENCLAUDE_AGENT_ID || 'unknown'
  const parentSessionKey = process.env.OPENCLAUDE_SESSION_KEY || ''
  const currentDepth = Number.parseInt(process.env.OPENCLAUDE_DELEGATION_DEPTH || '0', 10)
  try {
    const res = await postJsonToGateway(
      `${gatewayBaseUrl()}/api/agents/${encodeURIComponent(agentId)}/delegate`,
      {
        headers: {
          ...gatewayDelegateHeaders(),
          'x-delegation-depth': String(currentDepth),
        },
        body: JSON.stringify({
          goal: args.message,
          sourceAgent,
          async: true,
          callbackOnComplete: 'origin-inject',
          ...(parentSessionKey ? { streamProgress: true, parentSessionKey } : {}),
        }),
        timeoutMs: 15_000,
      },
    )
    const started = formatSendToAgentStart(res.statusCode, res.body, agentId)
    if (typeof started !== 'string') return toolError(started.error)
    return toolOk(started)
  } catch (err: any) {
    return toolError(`发送失败: ${describeDelegateTransportError(err)}`)
  }
}

async function handleDelegateTask(args: {
  agentId?: string
  model?: string
  goal: string
  context?: string
  effort?: string
  toolsets?: string[]
  resumeSessionKey?: string
}) {
  const agentNorm = normalizeDelegateAgentId(args.agentId)
  if (!agentNorm.ok) return toolError(agentNorm.error)
  const modelNorm = normalizeDelegateModel(args.model)
  if (!modelNorm.ok) return toolError(modelNorm.error)
  const agentId = agentNorm.agentId || 'main'
  return handleDelegateTaskToAgent(agentId, {
    goal: args.goal,
    context: args.context,
    effort: args.effort,
    toolsets: args.toolsets,
    resumeSessionKey: args.resumeSessionKey,
    model: modelNorm.model,
    label: agentNorm.agentId || 'main',
  })
}

/**
 * fan-out 并行委派:一次派发多个**互相独立**的子任务,Promise.all 并发走既有
 * /delegate 端点(gateway 端零改动 —— per-parent 分桶 3 + 全局闸 5 + 有界排队本就
 * 为并发设计,超出的会排队而非硬拒)。单项失败经 handleDelegateTaskToAgent 的
 * try/catch 收敛成 toolError(从不 throw),故 Promise.all 不会因单项拒绝而整体失败,
 * 结果按输入顺序聚合、每项独立标注 ✅/❌。校验/聚合逻辑抽到纯函数 delegateFanout.ts
 * (可单测),本处只负责调用编排。
 */
async function handleDelegateTasks(args: { tasks?: unknown }) {
  const normalized = normalizeFanoutTasks(args?.tasks)
  if (!normalized.ok) return toolError(normalized.error)
  return handleAsyncDelegateTasks(normalized.tasks)
}

// (v5 ccb-only:handleAskGpt55Codex 已移除 —— 无 codex agent。)

/**
 * Delegate tools no longer use one long HTTP request: every engine starts an
 * async job, waits briefly, then returns a resumable job handle before its
 * MCP tools/call deadline. send_to_agent returns that handle immediately and
 * lets the gateway inject the origin session when the child finishes.
 */

/**
 * 引擎交互提问桥(仅 Cursor,且仅 OC_ASK_USER_MCP=1 逃生开关):把选择题 POST
 * 给网关,在 55s 窗口内阻塞等回答。默认关闭 —— Cursor 已改走正文 ```options
 * 围栏,避免老提示词模型卡在 MCP 60s 硬超时上。开关打开时保持原行为。
 */
async function handleAskUser(args: { questions?: unknown } | undefined | null) {
  if (!ASK_USER_MCP_ESCAPE) {
    return toolOk(
      'Cursor 引擎已改为在正文输出 ```options 围栏选项卡提问，请改用该方式并立刻结束本回合',
    )
  }
  const questions = normalizeAskUserQuestions(args?.questions)
  if (!questions) {
    return toolError(
      'ask_user 参数无效:questions 必须是 1-4 个 {question, options:[{label,(description)}], (header),(multiSelect)}',
    )
  }
  if (DELEGATION_DEPTH > 0) {
    return toolOk(
      JSON.stringify({
        status: 'skipped',
        reason:
          'subagent has no interactive user — decide yourself, or list numbered options in your final report',
      }),
    )
  }
  if (!ASK_USER_ENABLED) {
    return toolError(
      'ask_user is only available on the Cursor engine; use the engine-native question tool',
    )
  }
  const sessionKey = process.env.OPENCLAUDE_SESSION_KEY || ''
  if (!sessionKey) return toolError('ask_user unavailable: no session key in environment')
  const startedAt = Date.now()
  const waitMs = remainingAskUserWaitMs(startedAt)
  const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT || '18789'
  const gatewayToken = readGatewayToken()
  try {
    const res = await postJsonToGateway(
      `http://127.0.0.1:${gatewayPort}/api/agents/${encodeURIComponent(AGENT_ID)}/ask-user`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayToken}`,
          'x-delegation-depth': String(DELEGATION_DEPTH),
        },
        body: JSON.stringify({ sessionKey, questions, waitMs }),
        timeoutMs: askUserHttpTimeoutMs(waitMs),
      },
    )
    return askUserToolResultFromGateway(res)
  } catch (err: any) {
    process.stderr.write(
      `[mcp-memory] ask_user gateway call failed: ${describeDelegateTransportError(err)}\n`,
    )
    return askUserToolPostedFallback()
  }
}

/**
 * 团队质量审查(队长自主送审):草稿经 gateway 委派给隐藏审查员 hidden-reviewer。
 * gateway 侧按目标身份派生审查语义(资源闸保留槽/回传不封顶/结构化 verdict),并做
 * 团队门(非团队 turn 409 拒绝)与审查任务书包装(用户原始需求取服务端权威快照)。
 * 熔断:hidden guard ≤3 次/turn,超限 429 —— 直接把结构化错误回给队长收敛。
 */
async function handleRequestReview(args: {
  draft?: string
  revisionNote?: string
  resumeSessionKey?: string
}) {
  const draft = typeof args?.draft === 'string' ? args.draft.trim() : ''
  if (!draft) {
    return toolError('draft 必填:请把准备提交给用户的完整答复草稿放进 draft 参数')
  }
  const note =
    typeof args?.revisionNote === 'string' && args.revisionNote.trim()
      ? `\n\n【队长修订说明】\n${args.revisionNote.trim().slice(0, 4000)}`
      : ''
  return handleDelegateTaskToAgent('hidden-reviewer', {
    goal: '对队长准备提交给用户的最终答复草稿做独立质量审查,给出结构化裁决。',
    context: draft.slice(0, 16000) + note,
    label: '质量审查',
    resumeSessionKey:
      typeof args.resumeSessionKey === 'string' ? args.resumeSessionKey : undefined,
  })
}

async function handleAsyncDelegateTasks(tasks: FanoutTask[]) {
  const items = await Promise.all(
    tasks.map(async (t): Promise<FanoutCursorItem> => {
      const label = t.agentId || 'main'
      try {
        const r = await runAsyncDelegateToAgent(label, {
          goal: t.goal,
          context: t.context,
          effort: t.effort,
          toolsets: t.toolsets,
          resumeSessionKey: t.resumeSessionKey,
          model: t.model,
          label,
        })
        if (r.kind === 'running') {
          return {
            label,
            goal: t.goal,
            isError: false,
            text: r.text,
            running: true,
            jobId: r.jobId,
          }
        }
        return {
          label,
          goal: t.goal,
          isError: r.kind === 'error',
          text: r.kind === 'error' ? `error: ${r.text}` : r.text,
        }
      } catch (err: any) {
        return {
          label,
          goal: t.goal,
          isError: true,
          text: `委派失败: ${describeDelegateTransportError(err)}`,
        }
      }
    }),
  )
  if (items.some((it) => it.running)) return toolOk(formatDelegateFanoutRunning(items))
  return toolOk(
    aggregateDelegateFanoutResults(
      items.map((it) => ({
        label: it.label,
        goal: it.goal,
        isError: it.isError,
        text: it.text,
      })),
    ),
  )
}

async function runAsyncDelegateToAgent(
  targetAgent: string,
  args: {
    goal: string
    context?: string
    effort?: string
    toolsets?: string[]
    resumeSessionKey?: string
    model?: string
    label: string
  },
): Promise<FormattedDelegateResult> {
  const sourceAgent = process.env.OPENCLAUDE_AGENT_ID || 'unknown'
  const parentSessionKey = process.env.OPENCLAUDE_SESSION_KEY || ''
  const currentDepth = Number.parseInt(process.env.OPENCLAUDE_DELEGATION_DEPTH || '0', 10)
  const headers = {
    ...gatewayDelegateHeaders(),
    'x-delegation-depth': String(currentDepth),
  }
  const base = gatewayBaseUrl()
  const body = JSON.stringify({
    goal: args.goal,
    context: args.context,
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.model ? { model: args.model } : {}),
    sourceAgent,
    toolsets: args.toolsets,
    async: true,
    ...(args.resumeSessionKey ? { resumeSessionKey: args.resumeSessionKey } : {}),
    ...(parentSessionKey ? { streamProgress: true, parentSessionKey } : {}),
  })
  const fastWaitMs = resolveCursorFastWaitMs()
  return runCursorDelegateFastPath({
    fastWaitMs,
    label: args.label,
    goal: args.goal,
    transport: {
      start: () =>
        postJsonToGateway(`${base}/api/agents/${encodeURIComponent(targetAgent)}/delegate`, {
          headers,
          body,
          timeoutMs: 15_000,
        }),
      wait: (jobId, waitMs) =>
        postJsonToGateway(`${base}/api/delegate/wait`, {
          headers,
          body: JSON.stringify({ jobId, waitMs }),
          timeoutMs: waitMs + 15_000,
        }),
    },
  })
}

async function handleDelegateTaskToAgent(
  targetAgent: string,
  args: {
    goal: string
    context?: string
    effort?: string
    toolsets?: string[]
    resumeSessionKey?: string
    model?: string
    label: string
  },
) {
  try {
    const r = await runAsyncDelegateToAgent(targetAgent, args)
    if (r.kind === 'error') return toolError(r.text)
    return toolOk(r.text)
  } catch (err: any) {
    return toolError(`委派失败: ${describeDelegateTransportError(err)}`)
  }
}

// ── 定时任务工具族共用:gateway /api/cron 客户端 ────────────────────────────
function gatewayCronBase(): { base: string; headers: Record<string, string> } {
  const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT || '18789'
  return {
    base: `http://127.0.0.1:${gatewayPort}/api/cron`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${readGatewayToken()}`,
    },
  }
}

async function handleCreateReminder(args: {
  schedule: string
  message: string
  oneshot?: boolean
  kind?: 'reminder' | 'task'
  deliver?: 'webchat' | 'local'
  resume?: 'isolated' | 'origin-session'
}) {
  const forbidden = rejectClientAssignedResumeIds(args)
  if (forbidden) return toolError(forbidden)
  const resume = resolveReminderResume(args)
  if (!resume.ok) return toolError(resume.error)
  const { base, headers } = gatewayCronBase()
  const isTask = args.kind === 'task'
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        schedule: args.schedule,
        // reminder = 到点原样播报;task = message 即任务指令,到点真执行。
        prompt: isTask
          ? args.message
          : `请直接输出以下提醒内容,不要添加任何额外文字:\n\n⏰ 提醒: ${args.message}`,
        deliver: args.deliver === 'local' ? 'local' : 'webchat',
        oneshot: args.oneshot !== false,
        label: args.message.slice(0, 50),
        ...(resume.resume === 'origin-session'
          ? { resume: 'origin-session', originSessionKey: resume.originSessionKey }
          : {}),
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      return toolError(`创建${isTask ? '任务' : '提醒'}失败: ${err}`)
    }
    const data = (await res.json()) as any
    return toolOk(
      `✅ ${isTask ? '定时任务' : '提醒'}已创建: "${args.message}"\n⏰ 计划: \`${args.schedule}\`\nID: \`${data.job?.id ?? '?'}\`${args.oneshot !== false ? ' (一次性)' : ' (重复)'}${resume.resume === 'origin-session' ? '\n🔁 到点将回到本对话继续' : ''}`,
    )
  } catch (err: any) {
    return toolError(`创建${isTask ? '任务' : '提醒'}失败: ${err?.message ?? String(err)}`)
  }
}

async function handleListReminders() {
  const { base, headers } = gatewayCronBase()
  try {
    const res = await fetch(base, { headers })
    if (!res.ok) return toolError(`获取定时任务失败: ${await res.text()}`)
    const data = (await res.json()) as { jobs?: ReminderJobView[] }
    const jobs = data.jobs ?? []
    if (jobs.length === 0) return toolOk('当前没有任何定时提醒/任务。可用 create_reminder 创建。')
    // 标题压平 + 系统任务友好名 + 逐行格式契约统一收口到 reminderFormat.ts(纯函数,单测钉死)。
    // 前端 parseReminderListOutput 严格依赖该逐行格式;系统任务 prompt 内嵌换行曾把行式输出
    // 拆碎、击穿前端逐行解析器(本批现网 bug),压平在 reminderTitle 里根治。
    return toolOk(formatReminderList(jobs))
  } catch (err: any) {
    return toolError(`获取定时任务失败: ${err?.message ?? String(err)}`)
  }
}

async function handleUpdateReminder(args: {
  id: string
  schedule?: string
  message?: string
  label?: string
  enabled?: boolean
  oneshot?: boolean
  deliver?: 'webchat' | 'local'
}) {
  const { base, headers } = gatewayCronBase()
  const patch: Record<string, unknown> = {}
  if (args.schedule !== undefined) patch.schedule = args.schedule
  if (args.message !== undefined) patch.prompt = args.message
  if (args.label !== undefined) patch.label = args.label
  if (args.enabled !== undefined) patch.enabled = args.enabled
  if (args.oneshot !== undefined) {
    patch.oneshot = args.oneshot
    // 一次性→重复:若任务曾触发后被自动停用,顺手重新启用(除非显式要求停用)。
    if (args.oneshot === false && args.enabled === undefined) patch.enabled = true
  }
  if (args.deliver !== undefined) patch.deliver = args.deliver
  if (Object.keys(patch).length === 0) return toolError('没有要修改的字段')
  try {
    const res = await fetch(`${base}/${encodeURIComponent(args.id)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(patch),
    })
    if (res.status === 404) return toolError(`任务不存在: ${args.id}(用 list_reminders 查 ID)`)
    if (!res.ok) return toolError(`修改失败: ${await res.text()}`)
    return toolOk(`✅ 已修改任务 \`${args.id}\`: ${Object.keys(patch).join(', ')}`)
  } catch (err: any) {
    return toolError(`修改失败: ${err?.message ?? String(err)}`)
  }
}

async function handleDeleteReminder(args: { id: string }) {
  const { base, headers } = gatewayCronBase()
  try {
    const res = await fetch(`${base}/${encodeURIComponent(args.id)}`, {
      method: 'DELETE',
      headers,
    })
    if (res.status === 404) return toolError(`任务不存在: ${args.id}(用 list_reminders 查 ID)`)
    if (!res.ok) return toolError(`删除失败: ${await res.text()}`)
    return toolOk(`✅ 已删除任务 \`${args.id}\``)
  } catch (err: any) {
    return toolError(`删除失败: ${err?.message ?? String(err)}`)
  }
}

function toolOk(msg: string) {
  return { content: [{ type: 'text', text: msg }] }
}
function toolError(msg: string) {
  return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
}

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[mcp-memory] started for agent=${AGENT_ID}\n`)
