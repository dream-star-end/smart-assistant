/**
 * Extracted MCP tool handlers (`post_message`, `read_board`, `swarm` status/channel/add)
 * for `RemoteSwarmRuntime` to keep `remoteSwarmRuntime.ts` modular and below file-size limits.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { SWARM_MAX_CHANNELS, SWARM_MAX_MEMBERS } from '@openclaude/protocol'
import { isSwarmMonitorAgentName } from './engine/swarmStallMonitor.js'
import { offloadPayloadIfOversized, truncateUtf8Safe } from './payloadOffloadGate.js'
import {
  type BoardPostRecord,
  type RemoteSwarmLocation,
  type RosterFile,
  type RosterMemberRecord,
  readBoardPostsFromDisk,
} from './remoteSwarmLocks.js'
import {
  createWorkerGitWorktree,
  findGitRepoTopLevel,
  isGitWorktreeUnsafeToDelete,
  removeWorkerGitWorktree,
  worktreePathForWorker,
} from './remoteSwarmReconcile.js'

export const MEMBER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const RESERVED_MEMBER_NAMES = new Set(['all', 'coordinator'])
export const DEFAULT_READ_BOARD_LIMIT = 50
export const MAX_READ_BOARD_LIMIT = 200
export const DEFAULT_READ_BOARD_MAX_BYTES = 32 * 1024
export const MAX_READ_BOARD_MAX_BYTES = 128 * 1024
export const MAX_SWARM_POST_CHARS = 24_000
const MAX_SHARD_ADD = 8

export interface RemoteSwarmToolHost {
  readonly location: RemoteSwarmLocation
  readonly model: string
  readonly workspaceCwd: string
  isWorkerRunning(name: string): boolean
  getInterruptGeneration(): number
  isSessionStopped(expectedGeneration: number): boolean
  readRoster(): Promise<RosterFile>
  mutateRoster<T>(fn: (roster: RosterFile) => T): Promise<T>
  appendBoardPost(input: {
    agent: string
    text: string
    channel?: string
    kind?: string
    control?: Record<string, unknown>
    expectedGeneration?: number
  }): Promise<BoardPostRecord | null>
}

export function inferMemberRole(name: string): RosterMemberRecord['role'] {
  const lower = name.toLowerCase()
  if (lower === 'coordinator') return 'coordinator'
  if (/^narrator(?:-\d+)?$/.test(lower)) return 'narrator'
  if (/^monitor(?:-\d+)?$/.test(lower)) return 'monitor'
  if (/verif|review|audit|qa|test/.test(lower)) return 'verifier'
  return 'worker'
}

export async function executePostMessageTool(
  host: RemoteSwarmToolHost,
  caller: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawText = typeof args.text === 'string' ? args.text.trim() : ''
  if (!rawText) throw new Error('SWARM_POST_EMPTY')
  const gatedPost =
    rawText.length > MAX_SWARM_POST_CHARS
      ? offloadPayloadIfOversized({
          workspaceDir: host.location.swarmDir,
          sessionId: host.location.swarmId,
          category: `swarm-post-${caller}`,
          label: `swarm:${caller}`,
          content: rawText,
          inlineMaxChars: MAX_SWARM_POST_CHARS,
        })
      : null
  const text = gatedPost ? gatedPost.text : rawText
  const roster = await host.readRoster()
  const requestedCh = typeof args.channel === 'string' ? args.channel.trim().toLowerCase() : ''
  let channel: string
  if (requestedCh) {
    if (requestedCh !== 'main') {
      if (!roster.channels[requestedCh]) {
        throw new Error(`SWARM_CHANNEL_NOT_FOUND:${requestedCh}`)
      }
      if (roster.channels[requestedCh]?.archived) {
        throw new Error(`SWARM_CHANNEL_ARCHIVED:${requestedCh}`)
      }
    }
    channel = requestedCh
  } else {
    const workerChannel =
      caller === 'coordinator'
        ? undefined
        : (roster.members[caller]?.channels ?? ['main']).find(
            (c) => c !== 'main' && roster.channels[c] && !roster.channels[c]?.archived,
          )
    channel = workerChannel ?? 'main'
  }
  const post = await host.appendBoardPost({ agent: caller, channel, text })
  if (!post) throw new Error('SWARM_POST_INTERRUPTED')
  return {
    ok: true,
    seq: post.seq,
    channel: post.channel,
    time: post.time,
    ...(gatedPost?.offloaded
      ? {
          truncated: true,
          warning: `Post exceeded ${MAX_SWARM_POST_CHARS} chars and was offloaded to disk.`,
          ...(gatedPost.artifactPath ? { artifact_path: gatedPost.artifactPath } : {}),
        }
      : {}),
  }
}

export async function executeReadBoardTool(
  host: RemoteSwarmToolHost,
  caller: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const since =
    typeof args.since === 'number' && Number.isFinite(args.since) && args.since >= 0
      ? Math.floor(args.since)
      : 0
  const rawLimit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.floor(args.limit)
      : DEFAULT_READ_BOARD_LIMIT
  const limit = Math.max(1, Math.min(MAX_READ_BOARD_LIMIT, rawLimit))
  const rawMaxBytes =
    typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes)
      ? Math.floor(args.maxBytes)
      : typeof args.max_bytes === 'number' && Number.isFinite(args.max_bytes)
        ? Math.floor(args.max_bytes)
        : DEFAULT_READ_BOARD_MAX_BYTES
  const maxBytes = Math.max(1_024, Math.min(MAX_READ_BOARD_MAX_BYTES, rawMaxBytes))
  const channelFilter = typeof args.channel === 'string' ? args.channel.trim() : ''
  const roster = await host.readRoster()
  const memberChannels = roster.members[caller]?.channels ?? ['main']
  const allPosts = readBoardPostsFromDisk(host.location.swarmDir)
  const filtered = allPosts.filter((p) => {
    if (p.seq <= since) return false
    if (channelFilter === '*') return true
    if (channelFilter) return p.channel === channelFilter
    if (caller === 'coordinator') return true
    return p.channel === 'main' || memberChannels.includes(p.channel)
  })
  const countTruncated = filtered.length > limit
  const countBounded = countTruncated ? filtered.slice(filtered.length - limit) : filtered
  // Apply UTF-8 byte budget from newest backwards, keeping complete messages without splitting UTF-8.
  const byteBounded: typeof countBounded = []
  let usedBytes = 0
  let byteBudgetHit = false
  for (let i = countBounded.length - 1; i >= 0; i -= 1) {
    const post = countBounded[i]!
    const postBytes = Buffer.byteLength(JSON.stringify(post), 'utf8')
    if (byteBounded.length > 0 && usedBytes + postBytes > maxBytes) {
      byteBudgetHit = true
      break
    }
    if (byteBounded.length === 0 && postBytes > maxBytes) {
      const textBudget = Math.max(256, maxBytes - 256)
      const clipped = truncateUtf8Safe(post.text, textBudget)
      byteBounded.unshift({
        ...post,
        text: clipped.truncated
          ? `${clipped.text}… [truncated to fit read_board maxBytes=${maxBytes}]`
          : clipped.text,
      })
      usedBytes += maxBytes
      byteBudgetHit = true
      break
    }
    byteBounded.unshift(post)
    usedBytes += postBytes
  }
  const truncated = countTruncated || byteBudgetHit
  const headSeq = allPosts.reduce((m, p) => Math.max(m, p.seq), 0)
  const readCursor = byteBounded.reduce((m, p) => Math.max(m, p.seq), since)
  if (roster.members[caller]) {
    await host.mutateRoster((r) => {
      const m = r.members[caller]
      if (m) {
        m.last_read_seq = Math.max(m.last_read_seq ?? 0, readCursor)
      }
    })
  }
  return {
    ok: true,
    head_seq: headSeq,
    truncated,
    byte_budget_hit: byteBudgetHit,
    max_bytes: maxBytes,
    total_matching: filtered.length,
    posts: byteBounded,
  }
}

export async function executeSwarmStatusAction(
  host: RemoteSwarmToolHost,
): Promise<Record<string, unknown>> {
  const roster = await host.readRoster()
  const allPosts = readBoardPostsFromDisk(host.location.swarmDir)
  const headSeq = allPosts.reduce((m, p) => Math.max(m, p.seq), 0)
  const members = Object.entries(roster.members).map(([name, m]) => ({
    name,
    role: m.role,
    model: m.model,
    status: m.killed
      ? 'killed'
      : host.isWorkerRunning(name) || (name === 'coordinator' && m.phase === 'RUNNING')
        ? 'working'
        : m.phase === 'STOPPED'
          ? 'stopped'
          : 'waiting',
    channels: m.channels,
    workspace: m.workspace?.path ?? host.workspaceCwd,
    workspace_mode: m.workspace?.mode ?? 'inherit',
  }))
  return {
    ok: true,
    swarm_id: host.location.swarmId,
    title: roster.title,
    head_seq: headSeq,
    members,
    channels: Object.entries(roster.channels).map(([name, ch]) => ({
      name,
      ...(ch.topic ? { topic: ch.topic } : {}),
      ...(ch.archived ? { archived: true } : {}),
    })),
  }
}

export async function executeSwarmChannelAction(
  host: RemoteSwarmToolHost,
  caller: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = typeof args.op === 'string' ? args.op.trim().toLowerCase() : 'list'
  if (op === 'list') {
    const roster = await host.readRoster()
    return {
      ok: true,
      channels: Object.entries(roster.channels).map(([name, ch]) => ({
        name,
        ...(ch.topic ? { topic: ch.topic } : {}),
        ...(ch.archived ? { archived: true } : {}),
        subscribers: Object.values(roster.members).filter(
          (m) => !m.killed && (m.channels ?? []).includes(name),
        ).length,
      })),
    }
  }
  const chName = typeof args.channel === 'string' ? args.channel.trim().toLowerCase() : ''
  if (!CHANNEL_NAME_RE.test(chName) || chName === 'main') {
    throw new Error('SWARM_CHANNEL_NAME_INVALID')
  }
  if (op === 'create') {
    const topic = typeof args.topic === 'string' ? args.topic.trim().slice(0, 160) : undefined
    await host.mutateRoster((roster) => {
      if (Object.keys(roster.channels).length >= SWARM_MAX_CHANNELS && !roster.channels[chName]) {
        throw new Error('SWARM_CHANNEL_LIMIT_REACHED')
      }
      roster.channels[chName] = { ...(topic ? { topic } : {}), creator: caller, archived: false }
    })
    return { ok: true, channel: chName, topic }
  }
  if (op === 'archive') {
    await host.mutateRoster((roster) => {
      if (!roster.channels[chName]) throw new Error('SWARM_CHANNEL_NOT_FOUND')
      roster.channels[chName]!.archived = true
    })
    return { ok: true, channel: chName, archived: true }
  }
  if (op === 'subscribe' || op === 'unsubscribe' || op === 'join' || op === 'leave') {
    const target =
      typeof args.name === 'string' && args.name.trim() ? args.name.trim().toLowerCase() : caller
    const channels = await host.mutateRoster((roster) => {
      const member = roster.members[target]
      if (!member) throw new Error('SWARM_MEMBER_NOT_FOUND')
      if (!roster.channels[chName]) throw new Error('SWARM_CHANNEL_NOT_FOUND')
      const set = new Set(member.channels ?? ['main'])
      if (op === 'subscribe' || op === 'join') set.add(chName)
      else set.delete(chName)
      set.add('main')
      member.channels = [...set]
      return member.channels
    })
    return { ok: true, name: target, channels }
  }
  throw new Error(`SWARM_CHANNEL_OP_UNSUPPORTED:${op}`)
}

export async function executeSwarmAddAction(
  host: RemoteSwarmToolHost,
  caller: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // B4: Capture cancelable generation at `add` admission so a Stop occurring while
  // creating worktrees or waiting on `.board.lock` can never post a brief or start workers.
  const addGeneration = host.getInterruptGeneration()
  const baseName = typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''
  const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
  if (!MEMBER_NAME_RE.test(baseName) || RESERVED_MEMBER_NAMES.has(baseName)) {
    throw new Error('SWARM_MEMBER_NAME_INVALID')
  }
  if (isSwarmMonitorAgentName(baseName)) {
    return {
      ok: true,
      skipped: true,
      managed_by_gateway: true,
      added: [],
      note: 'OpenClaude gateway already runs deterministic zero-token stall monitoring for this swarm; do not spawn an LLM monitor worker.',
    }
  }
  if (!brief) throw new Error('SWARM_BRIEF_REQUIRED')

  const tasksArr = Array.isArray(args.tasks)
    ? args.tasks.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : null
  const nRaw = typeof args.n === 'number' && Number.isInteger(args.n) ? args.n : 1
  const count = tasksArr
    ? Math.min(tasksArr.length, MAX_SHARD_ADD)
    : Math.max(1, Math.min(nRaw, MAX_SHARD_ADD))
  const requestedWorkspace =
    args.workspace === 'share' || args.workspace === 'branch' ? args.workspace : 'inherit'
  const requestedChannels = Array.isArray(args.channels)
    ? [
        ...new Set(
          args.channels
            .filter(
              (c): c is string =>
                typeof c === 'string' && CHANNEL_NAME_RE.test(c.trim().toLowerCase()),
            )
            .map((c) => c.trim().toLowerCase()),
        ),
      ]
    : []
  const workerModel =
    typeof args.model === 'string' && args.model.trim() ? args.model.trim() : host.model

  const specs: Array<{ name: string; fullBrief: string }> =
    count === 1 && !tasksArr
      ? [{ name: baseName, fullBrief: brief }]
      : Array.from({ length: count }, (_, idx) => ({
          name: `${baseName}-${idx + 1}`,
          fullBrief: tasksArr ? `${brief}\n\n[Shard Target]: ${tasksArr[idx]}` : brief,
        }))

  // B3 + P2-3: Atomically validate AND exclusively reserve all member names under `.roster.lock`
  // with a unique `opId` BEFORE creating any git worktree. Only the reservation owner can create,
  // commit, or roll back those worktrees, preventing concurrent same-name `add` calls from sharing
  // a path or deleting the winner's worktree on rollback.
  const primaryChannel = requestedChannels[0] || 'main'
  const memberChannels = [...new Set(['main', ...requestedChannels])]
  const opId = randomUUID()
  const PENDING_ADD_TTL_MS = 60_000
  const reservedNames: string[] = []

  await host.mutateRoster((roster) => {
    const now = Date.now()
    if (roster.pending_adds) {
      for (const [k, rec] of Object.entries(roster.pending_adds)) {
        if (!rec || now - rec.created_at > PENDING_ADD_TTL_MS) {
          delete roster.pending_adds[k]
        }
      }
      if (Object.keys(roster.pending_adds).length === 0) {
        delete roster.pending_adds
      }
    }
    const activePendingCount = Object.keys(roster.pending_adds ?? {}).length
    if (Object.keys(roster.members).length + activePendingCount + specs.length > SWARM_MAX_MEMBERS) {
      throw new Error('SWARM_MEMBER_LIMIT_REACHED')
    }
    for (const ch of requestedChannels) {
      if (ch !== 'main' && roster.channels[ch]?.archived) {
        throw new Error(`SWARM_CHANNEL_ARCHIVED:${ch}`)
      }
    }
    const newChannelsNeeded = requestedChannels.filter((ch) => ch !== 'main' && !roster.channels[ch])
    if (Object.keys(roster.channels).length + newChannelsNeeded.length > SWARM_MAX_CHANNELS) {
      throw new Error('SWARM_CHANNEL_LIMIT_REACHED')
    }
    for (const spec of specs) {
      if (roster.members[spec.name] || roster.pending_adds?.[spec.name]) {
        throw new Error(`SWARM_MEMBER_EXISTS:${spec.name}`)
      }
    }
    if (requestedWorkspace !== 'inherit') {
      const repoTop = findGitRepoTopLevel(host.workspaceCwd)
      if (!repoTop) {
        throw new Error(
          `SWARM_WORKTREE_CREATE_FAILED: workspace is not a git repository (${host.workspaceCwd})`,
        )
      }
      for (const spec of specs) {
        const wtPath = worktreePathForWorker(repoTop, host.location.swarmId, spec.name)
        if (existsSync(wtPath) && isGitWorktreeUnsafeToDelete(repoTop, wtPath)) {
          throw new Error(
            `SWARM_WORKTREE_CREATE_FAILED: existing worktree has uncommitted or unmerged changes (${wtPath})`,
          )
        }
      }
    }
    roster.pending_adds ??= {}
    for (const spec of specs) {
      roster.pending_adds[spec.name] = { op_id: opId, created_at: now }
      reservedNames.push(spec.name)
    }
  })

  // Create all worktrees and commit roster atomically; roll back ONLY owned reservations on failure.
  const createdWorktrees: Array<{
    name: string
    ws: { mode: 'share' | 'branch'; path: string; branch?: string }
  }> = []
  const wsByMember = new Map<
    string,
    { mode: 'inherit' } | { mode: 'share' | 'branch'; path: string; branch?: string }
  >()

  try {
    for (const spec of specs) {
      if (requestedWorkspace === 'inherit') {
        wsByMember.set(spec.name, { mode: 'inherit' })
      } else {
        const ws = createWorkerGitWorktree(
          host.workspaceCwd,
          host.location.swarmId,
          spec.name,
          requestedWorkspace,
        )
        createdWorktrees.push({ name: spec.name, ws })
        wsByMember.set(spec.name, ws)
      }
    }

    const existingHead = readBoardPostsFromDisk(host.location.swarmDir).reduce(
      (m, p) => Math.max(m, p.seq),
      0,
    )

    await host.mutateRoster((roster) => {
      if (host.isSessionStopped(addGeneration)) {
        throw new Error('SWARM_ADD_INTERRUPTED')
      }
      for (const spec of specs) {
        if (roster.members[spec.name]) {
          throw new Error(`SWARM_MEMBER_EXISTS:${spec.name}`)
        }
        if (roster.pending_adds?.[spec.name]?.op_id !== opId) {
          throw new Error(`SWARM_ADD_RESERVATION_LOST:${spec.name}`)
        }
      }
      if (Object.keys(roster.members).length + specs.length > SWARM_MAX_MEMBERS) {
        throw new Error('SWARM_MEMBER_LIMIT_REACHED')
      }
      for (const ch of requestedChannels) {
        if (ch !== 'main' && roster.channels[ch]?.archived) {
          throw new Error(`SWARM_CHANNEL_ARCHIVED:${ch}`)
        }
      }
      const toCreateChannels = requestedChannels.filter((ch) => ch !== 'main' && !roster.channels[ch])
      if (Object.keys(roster.channels).length + toCreateChannels.length > SWARM_MAX_CHANNELS) {
        throw new Error('SWARM_CHANNEL_LIMIT_REACHED')
      }
      for (const ch of toCreateChannels) {
        roster.channels[ch] = { creator: caller, archived: false }
      }
      for (const spec of specs) {
        roster.members[spec.name] = {
          conversation_id: randomUUID(),
          role: inferMemberRole(spec.name),
          model: workerModel,
          phase: 'RUNNING',
          wake_mode: 'mentions',
          wait_since: existingHead,
          last_read_seq: existingHead,
          killed: false,
          channels: memberChannels,
          workspace: wsByMember.get(spec.name) ?? { mode: 'inherit' },
          added_by: caller,
        }
        if (roster.pending_adds) {
          delete roster.pending_adds[spec.name]
        }
      }
      if (roster.pending_adds && Object.keys(roster.pending_adds).length === 0) {
        delete roster.pending_adds
      }
    })
  } catch (err) {
    // B3: Verify reservation ownership under `.roster.lock` BEFORE deleting any created worktree
    // so a failing operation can NEVER remove another owner's committed or reserved worktree.
    const ownedToRollback = new Set<string>()
    try {
      await host.mutateRoster((roster) => {
        for (const name of reservedNames) {
          if (roster.pending_adds?.[name]?.op_id === opId && !roster.members[name]) {
            ownedToRollback.add(name)
            delete roster.pending_adds[name]
          }
        }
        if (roster.pending_adds && Object.keys(roster.pending_adds).length === 0) {
          delete roster.pending_adds
        }
      })
    } catch {
      /* fail closed: if ownership cannot be verified, do not delete any worktree */
    }
    for (const created of createdWorktrees.reverse()) {
      if (!ownedToRollback.has(created.name)) continue
      removeWorkerGitWorktree(host.workspaceCwd, created.ws.path, {
        forceDirty: true,
        branchName: created.ws.branch,
      })
    }
    throw err
  }

  const added: Array<{ name: string; workspace_mode: string; workspace: string; seq: number }> = []
  let interrupted = false
  for (const spec of specs) {
    if (host.isSessionStopped(addGeneration)) {
      interrupted = true
      break
    }
    const ws = wsByMember.get(spec.name) ?? { mode: 'inherit' as const }
    const post = await host.appendBoardPost({
      agent: caller,
      channel: primaryChannel,
      text: `@${spec.name} ${spec.fullBrief}`,
      kind: 'brief',
      expectedGeneration: addGeneration,
    })
    if (!post) {
      interrupted = true
      break
    }
    added.push({
      name: spec.name,
      workspace_mode: ws.mode,
      workspace: 'path' in ws ? ws.path : host.workspaceCwd,
      seq: post.seq,
    })
  }
  if (interrupted) {
    const addedNames = new Set(added.map((a) => a.name))
    const unstartedNames = specs.filter((s) => !addedNames.has(s.name)).map((s) => s.name)
    try {
      await host.mutateRoster((roster) => {
        for (const spec of specs) {
          const rec = roster.members[spec.name]
          if (rec && !rec.killed && rec.phase === 'RUNNING') {
            rec.phase = 'STOPPED'
          }
        }
      })
    } catch {
      /* ignore settle failure on interrupted add */
    }
    return {
      ok: false,
      interrupted: true,
      cancelled: true,
      error: 'SWARM_ADD_INTERRUPTED',
      stopped: unstartedNames,
      added,
    }
  }
  return { ok: true, added }
}
