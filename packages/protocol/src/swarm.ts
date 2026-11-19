/**
 * Antigravity native swarm mode — pure zero-dependency types & helpers (OCV5-809).
 *
 * Intentionally free of `@sinclair/typebox` so browser bundles importing runtime
 * guards (`isSwarmSnapshot`, `parseSwarmSlashCommand`) never pull TypeBox into
 * the first-screen chunk. Wire TypeBox schemas live in `./frames.ts`.
 */

export const SWARM_BOARD_TOOL_NAME = 'SwarmBoard'
export const SWARM_MAX_MEMBERS = 32
export const SWARM_MAX_CHANNELS = 24
export const SWARM_MAX_POSTS = 120
export const SWARM_MAX_POST_CHARS = 4000

export type SwarmMemberRole = 'coordinator' | 'worker' | 'verifier' | 'monitor' | 'narrator'
export type SwarmMemberStatus = 'working' | 'waiting' | 'stopped' | 'killed'
export type SwarmPhase = 'starting' | 'running' | 'completed' | 'interrupted' | 'error'

export interface SwarmMemberSnapshot {
  name: string
  role: SwarmMemberRole
  status: SwarmMemberStatus
  model?: string
  channels?: string[]
  workspace?: string
  wakeMode?: string
  stepCount: number
  activity?: string
  failed?: boolean
  lastError?: string
  unreadCount: number
  lastPostSeq?: number
  lastActiveAt?: number
}

export interface SwarmChannelSnapshot {
  name: string
  topic?: string
  archived?: boolean
  memberCount: number
  postCount: number
}

export interface SwarmBoardPost {
  seq: number
  agent: string
  text: string
  time?: string
  channel?: string
  mentions: string[]
}

export interface SwarmSnapshot {
  swarmId: string
  title: string
  phase: SwarmPhase
  revision: number
  updatedAt: number
  startedAt?: number
  members: SwarmMemberSnapshot[]
  channels: SwarmChannelSnapshot[]
  posts: SwarmBoardPost[]
  totalPosts: number
  truncatedPosts?: number
}

/** Extract `@name`, `@all`, and `@#channel` mentions matching Antigravity board rules. */
const MENTION_RE = /(?:^|[^A-Za-z0-9_#-])@(#?[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?![A-Za-z0-9._-])/g

export function extractSwarmMentions(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  MENTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MENTION_RE.exec(text)) !== null) {
    const raw = match[1]?.toLowerCase()
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

export function isSwarmSnapshot(value: unknown): value is SwarmSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.swarmId === 'string' &&
    obj.swarmId.length > 0 &&
    typeof obj.title === 'string' &&
    (obj.phase === 'starting' ||
      obj.phase === 'running' ||
      obj.phase === 'completed' ||
      obj.phase === 'interrupted' ||
      obj.phase === 'error') &&
    typeof obj.revision === 'number' &&
    Number.isFinite(obj.revision) &&
    typeof obj.updatedAt === 'number' &&
    Array.isArray(obj.members) &&
    Array.isArray(obj.channels) &&
    Array.isArray(obj.posts) &&
    typeof obj.totalPosts === 'number'
  )
}

/** Parse leading `/swarm` slash command. Returns stripped task text when matched, else null. */
export function parseSwarmSlashCommand(rawText: string): { matched: true; task: string } | null {
  const trimmed = rawText.trim()
  if (trimmed === '/swarm') return { matched: true, task: '' }
  const match = /^\/swarm(?:\s+([\s\S]*))$/i.exec(trimmed)
  if (!match) return null
  return { matched: true, task: (match[1] ?? '').trim() }
}
