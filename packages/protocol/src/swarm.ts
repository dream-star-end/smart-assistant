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
  /** Incremental member telemetry parsed from transcript (optional; 100% backwards-compatible). */
  elapsedMs?: number
  inputTokens?: number
  outputTokens?: number
  toolCalls?: number
  /** True when telemetry scanning still has unread backlog or hit its per-file budget/line cap. */
  telemetryPartial?: boolean
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

export type SwarmPostsMode = 'full' | 'delta'

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
  /** Wire transport mode for `posts`: `'full'` (or omitted, legacy default) carries
   * the full bounded tail; `'delta'` carries only posts added since `deltaBaseSeq`
   * so consumers merge them onto their previous snapshot (OCV5-819). */
  postsMode?: SwarmPostsMode
  deltaBaseSeq?: number
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

function clampSwarmText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function swarmUtf8Bytes(str: string): number {
  let bytes = 0
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

export type SwarmSnapshotMergeResult =
  | { ok: true; snapshot: SwarmSnapshot }
  | { ok: false; reason: 'stale' | 'missing_base' }

/**
 * Strict merger for `SwarmSnapshot` (`'full'` or `'delta'`) that validates
 * `deltaBaseSeq` continuity before accepting a delta frame (OCV5-819 B7).
 *
 * - Returns `{ ok: false, reason: 'stale' }` when `revision <= prev.revision`.
 * - Returns `{ ok: false, reason: 'missing_base' }` when a `'delta'` frame
 *   depends on prior posts (`deltaBaseSeq > prevHeadSeq` or missing baseline),
 *   so callers fail closed instead of certifying a gapped board as complete.
 */
export function mergeSwarmSnapshotsStrict(
  prev: SwarmSnapshot | null,
  incoming: SwarmSnapshot,
): SwarmSnapshotMergeResult {
  const sameSwarm = prev !== null && prev.swarmId === incoming.swarmId
  if (sameSwarm && incoming.revision <= prev.revision) {
    return { ok: false, reason: 'stale' }
  }

  let mergedPosts: SwarmBoardPost[]
  if (incoming.postsMode === 'delta') {
    const baseSeq = typeof incoming.deltaBaseSeq === 'number' && Number.isFinite(incoming.deltaBaseSeq)
      ? Math.max(0, Math.floor(incoming.deltaBaseSeq))
      : 0
    const prevHeadSeq = sameSwarm && prev.posts.length > 0
      ? prev.posts[prev.posts.length - 1]!.seq
      : 0
    if (baseSeq > 0 && (!sameSwarm || prevHeadSeq < baseSeq)) {
      return { ok: false, reason: 'missing_base' }
    }
    if (!sameSwarm && incoming.totalPosts > incoming.posts.length) {
      return { ok: false, reason: 'missing_base' }
    }
    const bySeq = new Map<number, SwarmBoardPost>()
    if (sameSwarm) {
      for (const p of prev.posts) bySeq.set(p.seq, p)
    }
    for (const p of incoming.posts) bySeq.set(p.seq, p)
    const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    mergedPosts =
      sorted.length > SWARM_MAX_POSTS
        ? sorted.slice(sorted.length - SWARM_MAX_POSTS)
        : sorted
  } else {
    mergedPosts =
      incoming.posts.length > SWARM_MAX_POSTS
        ? incoming.posts.slice(incoming.posts.length - SWARM_MAX_POSTS)
        : [...incoming.posts]
  }

  const totalPosts = Math.max(
    incoming.totalPosts,
    sameSwarm ? prev.totalPosts : 0,
    mergedPosts.length,
  )
  const truncatedPosts =
    totalPosts > mergedPosts.length ? totalPosts - mergedPosts.length : undefined

  const normalized: SwarmSnapshot = {
    swarmId: incoming.swarmId,
    title: incoming.title,
    phase: incoming.phase,
    revision: incoming.revision,
    updatedAt: incoming.updatedAt,
    ...(incoming.startedAt !== undefined
      ? { startedAt: incoming.startedAt }
      : sameSwarm && prev.startedAt !== undefined
        ? { startedAt: prev.startedAt }
        : {}),
    members: incoming.members,
    channels: incoming.channels,
    posts: mergedPosts,
    totalPosts,
    ...(truncatedPosts ? { truncatedPosts } : {}),
  }
  return { ok: true, snapshot: normalized }
}

/**
 * Merge an incoming `SwarmSnapshot` (either `'full'` or `'delta'`) onto an
 * optional previous snapshot for the same swarm.
 *
 * Returns `null` when the incoming snapshot is stale or missing its delta base.
 */
export function mergeSwarmSnapshots(
  prev: SwarmSnapshot | null,
  incoming: SwarmSnapshot,
): SwarmSnapshot | null {
  const res = mergeSwarmSnapshotsStrict(prev, incoming)
  return res.ok ? res.snapshot : null
}

/**
 * Produce a UTF-8 byte-bounded copy of a SwarmSnapshot whose complete
 * `{ swarmId, title, phase, snapshot }` envelope fits within `maxBytes`.
 * Pure zero-dependency implementation usable in browser, protocol, and Node.
 */
export function compactSwarmSnapshotToByteBudget(
  snap: SwarmSnapshot,
  maxBytes: number,
): SwarmSnapshot {
  const envelopeFits = (candidate: SwarmSnapshot): boolean =>
    swarmUtf8Bytes(
      JSON.stringify({
        swarmId: candidate.swarmId,
        title: candidate.title,
        phase: candidate.phase,
        snapshot: candidate,
      }),
    ) <= maxBytes

  const cleanBase: SwarmSnapshot = {
    swarmId: snap.swarmId,
    title: snap.title,
    phase: snap.phase,
    revision: snap.revision,
    updatedAt: snap.updatedAt,
    ...(snap.startedAt !== undefined ? { startedAt: snap.startedAt } : {}),
    members: snap.members,
    channels: snap.channels,
    posts: snap.posts,
    totalPosts: snap.totalPosts,
    ...(snap.truncatedPosts ? { truncatedPosts: snap.truncatedPosts } : {}),
  }
  if (envelopeFits(cleanBase)) return cleanBase

  const baseMembers = cleanBase.members.map((m) => ({
    ...m,
    ...(m.activity ? { activity: clampSwarmText(m.activity, 80) } : {}),
    ...(m.lastError ? { lastError: clampSwarmText(m.lastError, 120) } : {}),
  }))
  const baseChannels = cleanBase.channels.map((c) => ({
    ...c,
    ...(c.topic ? { topic: clampSwarmText(c.topic, 80) } : {}),
  }))

  for (const [maxPosts, maxPostText] of [
    [80, 1200],
    [40, 600],
    [40, 320],
    [24, 220],
    [12, 160],
    [6, 120],
    [0, 0],
  ] as const) {
    const posts =
      maxPosts === 0
        ? []
        : cleanBase.posts.slice(-maxPosts).map((p) => ({
            ...p,
            text: clampSwarmText(p.text, maxPostText),
          }))
    const truncatedPosts =
      cleanBase.totalPosts > posts.length ? cleanBase.totalPosts - posts.length : undefined
    const candidate: SwarmSnapshot = {
      ...cleanBase,
      title: clampSwarmText(cleanBase.title, 120),
      members: baseMembers,
      channels: baseChannels,
      posts,
      ...(truncatedPosts ? { truncatedPosts } : {}),
    }
    if (envelopeFits(candidate)) return candidate
  }

  const minimalMembers = baseMembers.map((m) => ({
    name: clampSwarmText(m.name, 40),
    role: m.role,
    status: m.status,
    ...(m.workspace ? { workspace: clampSwarmText(m.workspace, 24) } : {}),
    stepCount: m.stepCount,
    unreadCount: m.unreadCount,
    ...(m.failed ? { failed: true } : {}),
  }))
  const minimalChannels = baseChannels.map((c) => ({
    name: clampSwarmText(c.name, 32),
    memberCount: c.memberCount,
    postCount: c.postCount,
  }))
  for (const [mCap, cCap] of [
    [16, 8],
    [8, 4],
    [4, 2],
    [0, 0],
  ] as const) {
    const candidate: SwarmSnapshot = {
      swarmId: cleanBase.swarmId,
      title: clampSwarmText(cleanBase.title, 80),
      phase: cleanBase.phase,
      revision: cleanBase.revision,
      updatedAt: cleanBase.updatedAt,
      ...(cleanBase.startedAt !== undefined ? { startedAt: cleanBase.startedAt } : {}),
      members: minimalMembers.slice(0, mCap),
      channels: minimalChannels.slice(0, cCap),
      posts: [],
      totalPosts: cleanBase.totalPosts,
      ...(cleanBase.totalPosts > 0 ? { truncatedPosts: cleanBase.totalPosts } : {}),
    }
    if (envelopeFits(candidate)) return candidate
  }
  return {
    swarmId: cleanBase.swarmId,
    title: clampSwarmText(cleanBase.title, 32),
    phase: cleanBase.phase,
    revision: cleanBase.revision,
    updatedAt: cleanBase.updatedAt,
    members: [],
    channels: [],
    posts: [],
    totalPosts: cleanBase.totalPosts,
    ...(cleanBase.totalPosts > 0 ? { truncatedPosts: cleanBase.totalPosts } : {}),
  }
}
