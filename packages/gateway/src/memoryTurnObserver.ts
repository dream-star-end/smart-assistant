import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import type { ToolCalledEvent, TurnCompletedEvent } from '@openclaude/protocol'
import {
  MemoryDir,
  beginMemoryTurnObservation,
  completeMemoryTurnObservation,
  markMemoryTurnEvidence,
  paths,
  recordMemoryUsageEvent,
} from '@openclaude/storage'

import { type GatewayEventBus, eventBus } from './eventBus.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'memoryTurnObserver' })

type Snapshot = { core: Map<string, string>; profile: string | null; dirRealPath: string | null }
const activeSnapshots = new Map<string, Snapshot>()
const sharedDirLoggedAgents = new Set<string>()

function turnSnapshotMetadata(shared: boolean): Record<string, unknown> {
  return shared
    ? { source: 'turn_snapshot', shared: true, attribution: 'ambiguous' }
    : { source: 'turn_snapshot' }
}

function logSharedMemoryDirOnce(
  agentId: string,
  dirPath: string,
  dirRealPath: string | null,
  shared: boolean,
): void {
  if (sharedDirLoggedAgents.has(agentId)) return
  sharedDirLoggedAgents.add(agentId)
  log.debug('turn_snapshot memory dir shared-symlink detection', {
    agentId,
    dirPath,
    dirRealPath,
    shared,
  })
}

async function resolveMemoryDirRealPath(dirPath: string): Promise<string | null> {
  try {
    return await realpath(dirPath)
  } catch {
    return null
  }
}

/** `child` 是否落在 `root` 目录树内(含相等);两边都应是已 realpath 的绝对路径。 */
function isPathInside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 记忆目录是否是「指向别处的共享符号链接」(多 agent 共用一份 memory/ → 快照 diff 归因
 * 不清,事件要盖 attribution:'ambiguous')。
 *
 * 判据是 **realpath 后是否仍在本 agent 目录树内**,而不是 `realpath !== 词法路径` 的裸字符串
 * 比较(MSC MEM-13):HOME 本身经过 symlink / junction / Windows 8.3 短名 / macOS `/var`→
 * `/private/var` 时,所有 agent 的 realpath 都与词法路径不同,裸比较会把独占目录一律误判为
 * 共享,让整份用量遥测的归属信号失真。agent 根目录也 realpath 后再比前缀,两边口径一致。
 */
export async function isSharedMemoryDir(agentId: string): Promise<boolean> {
  const dirPath = new MemoryDir(agentId).dirPath()
  const dirRealPath = await resolveMemoryDirRealPath(dirPath)
  let shared = false
  if (dirRealPath != null) {
    const agentRoot = paths.agentDir(agentId)
    const agentRootReal = (await resolveMemoryDirRealPath(agentRoot)) ?? agentRoot
    shared = !isPathInside(agentRootReal, dirRealPath)
  }
  logSharedMemoryDirOnce(agentId, dirPath, dirRealPath, shared)
  return shared
}

function key(sessionKey: string, turnIndex: number): string {
  return `${sessionKey}\u0000${turnIndex}`
}

async function fileStamp(path: string): Promise<string | null> {
  try {
    const value = await stat(path, { bigint: true })
    return `${value.size}:${value.mtimeNs}:${value.ctimeNs}`
  } catch {
    return null
  }
}

export async function captureMemorySnapshot(agentId: string): Promise<Snapshot> {
  const dir = new MemoryDir(agentId).dirPath()
  const dirRealPath = await resolveMemoryDirRealPath(dir)
  const core = new Map<string, string>()
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/.test(entry.name)) continue
      const stamp = await fileStamp(join(dir, entry.name))
      if (stamp) core.set(entry.name, stamp)
    }
  } catch {
    // Empty/missing memory directory is a valid snapshot.
  }
  return { core, profile: await fileStamp(paths.sharedUserMd), dirRealPath }
}

export async function beginMemoryTurnTracking(input: {
  sessionKey: string
  turnIndex: number
  agentId: string
  userText: string
}): Promise<void> {
  const snapshot = await captureMemorySnapshot(input.agentId)
  await beginMemoryTurnObservation({
    ...input,
    softReminderActive: true,
  })
  activeSnapshots.set(key(input.sessionKey, input.turnIndex), snapshot)
  while (activeSnapshots.size > 512) {
    const oldest = activeSnapshots.keys().next().value
    if (typeof oldest !== 'string') break
    activeSnapshots.delete(oldest)
  }
  // A non-empty Core library is visible through the per-runner MEMORY slot.
  // Record turn visibility explicitly so a model that answers from the injected
  // index without calling core-search still participates in freshness-gap shadowing.
  if (snapshot.core.size > 0) {
    await recordMemoryUsageEvent({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      turnIndex: input.turnIndex,
      operation: 'index_injected',
      memoryType: 'system',
      outcome: 'success',
      resultCount: snapshot.core.size,
      metadata: { source: 'turn_visibility' },
    })
  }
}

export async function recordSnapshotDiff(
  event: Pick<TurnCompletedEvent, 'sessionKey' | 'turnIndex' | 'agentId'>,
): Promise<void> {
  const snapshotKey = key(event.sessionKey, event.turnIndex)
  const before = activeSnapshots.get(snapshotKey)
  activeSnapshots.delete(snapshotKey)
  if (!before) return
  const after = await captureMemorySnapshot(event.agentId)
  const metadata = turnSnapshotMetadata(await isSharedMemoryDir(event.agentId))
  for (const [file, stamp] of after.core) {
    const previous = before.core.get(file)
    if (previous === stamp) continue
    await recordMemoryUsageEvent({
      agentId: event.agentId,
      sessionKey: event.sessionKey,
      turnIndex: event.turnIndex,
      operation: previous ? 'core_update' : 'core_write',
      memoryType: 'core',
      outcome: 'success',
      topMatchKey: file,
      metadata,
    })
  }
  for (const file of before.core.keys()) {
    if (after.core.has(file)) continue
    await recordMemoryUsageEvent({
      agentId: event.agentId,
      sessionKey: event.sessionKey,
      turnIndex: event.turnIndex,
      operation: 'core_delete',
      memoryType: 'core',
      outcome: 'success',
      topMatchKey: file,
      metadata,
    })
  }
  if (before.profile !== after.profile) {
    await recordMemoryUsageEvent({
      agentId: event.agentId,
      sessionKey: event.sessionKey,
      turnIndex: event.turnIndex,
      operation: 'profile_write',
      memoryType: 'profile',
      outcome: 'success',
      metadata,
    })
  }
}

const EVIDENCE_TOOL_NAMES = new Set([
  'WebSearch',
  'WebFetch',
  'codex:webSearch',
  'web__run',
  'Browser',
])
const EVIDENCE_COMMAND_RE =
  /(?:\b(?:curl|psql|sqlite3|systemctl|journalctl|docker|git|oc-web|oc-browser)\b|healthz|VERSION\.json|MANIFEST\.json|sourceCommit)/i
const MEMORY_ONLY_RE =
  /(?:oc-memory\s+(?:core-search|session-search|archival-)|\.openclaude\/agents\/[^/]+\/memory\/|MEMORY\.md)/i

export function isCurrentEvidenceTool(
  event: Pick<ToolCalledEvent, 'toolName' | 'inputPreview'>,
): boolean {
  if (EVIDENCE_TOOL_NAMES.has(event.toolName)) return true
  const input = event.inputPreview ?? ''
  if (MEMORY_ONLY_RE.test(input) && !EVIDENCE_COMMAND_RE.test(input.replace(MEMORY_ONLY_RE, '')))
    return false
  if (event.toolName === 'Read' || event.toolName === 'Grep') {
    return /(?:VERSION\.json|MANIFEST\.json|\.log\b|\/proc\/|\/etc\/|release)/i.test(input)
  }
  if (event.toolName === 'Bash' || event.toolName.includes('exec'))
    return EVIDENCE_COMMAND_RE.test(input)
  return false
}

export function startMemoryTurnObserver(bus: Pick<GatewayEventBus, 'on'> = eventBus): void {
  bus.on('tool.called', (event) => {
    if (!isCurrentEvidenceTool(event)) return
    void markMemoryTurnEvidence(event.sessionKey, event.turnIndex).catch((err) =>
      log.warn('failed to mark current evidence', { sessionKey: event.sessionKey }, err),
    )
  })
  bus.on('turn.completed', (event) => {
    void (async () => {
      await recordSnapshotDiff(event)
      await completeMemoryTurnObservation(event.sessionKey, event.turnIndex, event.timestamp)
    })().catch((err) =>
      log.warn(
        'failed to finalize memory turn observation',
        {
          sessionKey: event.sessionKey,
          turnIndex: event.turnIndex,
        },
        err,
      ),
    )
  })
  bus.on('session.crashed', (event) => {
    const prefix = `${event.sessionKey}\u0000`
    for (const snapshotKey of [...activeSnapshots.keys()]) {
      if (!snapshotKey.startsWith(prefix)) continue
      const turnIndex = Number(snapshotKey.slice(prefix.length))
      if (!Number.isSafeInteger(turnIndex) || turnIndex < 1) {
        activeSnapshots.delete(snapshotKey)
        continue
      }
      void (async () => {
        await recordSnapshotDiff({
          sessionKey: event.sessionKey,
          turnIndex,
          agentId: event.agentId,
        })
        await completeMemoryTurnObservation(event.sessionKey, turnIndex, event.timestamp)
      })().catch((err) =>
        log.warn(
          'failed to finalize crashed memory turn observation',
          {
            sessionKey: event.sessionKey,
            turnIndex,
          },
          err,
        ),
      )
    }
  })
}
