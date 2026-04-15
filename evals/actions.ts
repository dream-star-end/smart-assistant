// Action executor — maps action names in task YAML to actual subsystem calls.
// All actions are async and return a result value for assertion judges.

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import {
  type EventLogEntry,
  type UsageLogEntry,
  SkillStore,
  getUsageSummary,
  indexTurn,
  insertEvent,
  insertUsageLog,
  parseFrontmatter,
  paths,
  queryEvents,
  readAgentsConfig,
  readConfig,
  searchSessions,
  upsertSessionMeta,
  validateSkillName,
} from '@openclaude/storage'

export type ActionFn = (args: Record<string, unknown>) => Promise<unknown>

// ── Skill actions ──

async function skill_save(args: Record<string, unknown>): Promise<unknown> {
  const store = new SkillStore(String(args.agentId ?? 'eval-agent'))
  return store.save(
    {
      name: String(args.name),
      description: String(args.description ?? 'eval skill'),
      version: args.version ? String(args.version) : undefined,
      tags: args.tags as string[] | undefined,
    },
    String(args.body ?? ''),
  )
}

async function skill_list(args: Record<string, unknown>): Promise<unknown> {
  const store = new SkillStore(String(args.agentId ?? 'eval-agent'))
  return store.list()
}

async function skill_view(args: Record<string, unknown>): Promise<unknown> {
  const store = new SkillStore(String(args.agentId ?? 'eval-agent'))
  return store.view(String(args.name), args.subfile ? String(args.subfile) : undefined)
}

async function skill_history(args: Record<string, unknown>): Promise<unknown> {
  const store = new SkillStore(String(args.agentId ?? 'eval-agent'))
  return store.history(String(args.name))
}

async function skill_restore(args: Record<string, unknown>): Promise<unknown> {
  const store = new SkillStore(String(args.agentId ?? 'eval-agent'))
  return store.restore(String(args.name), String(args.version))
}

async function skill_delete(args: Record<string, unknown>): Promise<unknown> {
  const store = new SkillStore(String(args.agentId ?? 'eval-agent'))
  return store.delete(String(args.name))
}

async function skill_validate_name(args: Record<string, unknown>): Promise<unknown> {
  return validateSkillName(String(args.name))
}

async function skill_parse_frontmatter(args: Record<string, unknown>): Promise<unknown> {
  return parseFrontmatter(String(args.raw))
}

// ── Session/search actions ──

async function session_upsert(args: Record<string, unknown>): Promise<unknown> {
  await upsertSessionMeta({
    id: String(args.id),
    agentId: String(args.agentId ?? 'eval-agent'),
    channel: String(args.channel ?? 'eval'),
    peerId: String(args.peerId ?? 'eval-user'),
    title: String(args.title ?? 'eval session'),
    startedAt: Number(args.startedAt ?? Date.now()),
    lastAt: Number(args.lastAt ?? Date.now()),
    turnCount: Number(args.turnCount ?? 0),
    totalCostUSD: Number(args.totalCostUSD ?? 0),
  })
  return { ok: true }
}

async function session_index_turn(args: Record<string, unknown>): Promise<unknown> {
  await indexTurn(
    String(args.sessionId),
    Number(args.turnIdx),
    String(args.userText ?? ''),
    String(args.assistantText ?? ''),
  )
  return { ok: true }
}

async function session_search(args: Record<string, unknown>): Promise<unknown> {
  return searchSessions(
    String(args.query),
    Number(args.limit ?? 5),
    args.agentId ? String(args.agentId) : undefined,
  )
}

// ── Event/cost actions ──

async function event_insert(args: Record<string, unknown>): Promise<unknown> {
  await insertEvent(args as unknown as EventLogEntry)
  return { ok: true }
}

async function event_query(args: Record<string, unknown>): Promise<unknown> {
  return queryEvents({
    type: args.type ? String(args.type) : undefined,
    agentId: args.agentId ? String(args.agentId) : undefined,
    sessionKey: args.sessionKey ? String(args.sessionKey) : undefined,
    since: args.since != null ? Number(args.since) : undefined,
    limit: args.limit ? Number(args.limit) : undefined,
  })
}

async function usage_insert(args: Record<string, unknown>): Promise<unknown> {
  await insertUsageLog(args as unknown as UsageLogEntry)
  return { ok: true }
}

async function usage_summary(args: Record<string, unknown>): Promise<unknown> {
  return getUsageSummary({
    agentId: args.agentId ? String(args.agentId) : undefined,
    sessionId: args.sessionId ? String(args.sessionId) : undefined,
    since: args.since != null ? Number(args.since) : undefined,
  })
}

// ── Security/validation actions ──

async function validate_skill_name(args: Record<string, unknown>): Promise<unknown> {
  return validateSkillName(String(args.name))
}

async function skill_store_construct(args: Record<string, unknown>): Promise<unknown> {
  try {
    new SkillStore(String(args.agentId))
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// ── Config actions ──

async function config_read(_args: Record<string, unknown>): Promise<unknown> {
  return readConfig()
}

async function agents_config_read(_args: Record<string, unknown>): Promise<unknown> {
  return readAgentsConfig()
}

// ── Utility actions ──

/** Cleanup eval data (skills, sessions) for test isolation */
async function cleanup(args: Record<string, unknown>): Promise<unknown> {
  const agentId = String(args.agentId ?? 'eval-agent')
  // Validate agentId to prevent path traversal via cleanup
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    return { ok: false, error: `invalid agentId for cleanup: ${agentId}` }
  }
  const skillsDir = paths.agentSkillsDir(agentId)
  if (existsSync(skillsDir)) {
    await rm(skillsDir, { recursive: true, force: true })
  }
  return { ok: true }
}

// ── Action registry ──

const ACTIONS: Record<string, ActionFn> = {
  skill_save,
  skill_list,
  skill_view,
  skill_history,
  skill_restore,
  skill_delete,
  skill_validate_name,
  skill_parse_frontmatter,
  session_upsert,
  session_index_turn,
  session_search,
  event_insert,
  event_query,
  usage_insert,
  usage_summary,
  validate_skill_name,
  skill_store_construct,
  config_read,
  agents_config_read,
  cleanup,
}

export function getAction(name: string): ActionFn | undefined {
  return ACTIONS[name]
}

export function listActions(): string[] {
  return Object.keys(ACTIONS)
}
