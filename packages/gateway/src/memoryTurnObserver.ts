import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

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

type Snapshot = { core: Map<string, string>; profile: string | null }
const activeSnapshots = new Map<string, Snapshot>()

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
  return { core, profile: await fileStamp(paths.sharedUserMd) }
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

async function recordSnapshotDiff(
  event: Pick<TurnCompletedEvent, 'sessionKey' | 'turnIndex' | 'agentId'>,
): Promise<void> {
  const snapshotKey = key(event.sessionKey, event.turnIndex)
  const before = activeSnapshots.get(snapshotKey)
  activeSnapshots.delete(snapshotKey)
  if (!before) return
  const after = await captureMemorySnapshot(event.agentId)
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
      metadata: { source: 'turn_snapshot' },
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
      metadata: { source: 'turn_snapshot' },
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
      metadata: { source: 'turn_snapshot' },
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
