/**
 * Common spawn-time run-context writer (auditor blocker #4).
 *
 * Call AFTER PromptContextResult.applied + cwd are frozen and BEFORE the
 * model subprocess is spawned. Fail-soft: never throw into the spawn path.
 * Taskboard runs get context_* columns written when the descriptor runId
 * matches tb_ticket_run.id.
 */
import {
  classifySlot,
  createRunContextDescriptor,
  emptyProjectRunSnapshot,
  isProjectContextEnabled,
  pruneProjectRunSnapshots,
  realpathOrNull,
  readProjectRunContextFile,
  safeRunIdSegment,
  writeProjectRunContextFile,
  type ProjectRunCwdSource,
  type ProjectRunSlotHash,
  type RunContextDescriptor,
} from '@openclaude/storage'
import type { EngineCwdDecision } from './engineCwd.js'
import { getRun, getTaskboardDb, updateRun } from './taskboard/db/index.js'

export interface FrozenProjectContextDigests {
  contextVersion: number
  assetsRevision: number
  projectMdSha256: string | null
  skillManifestSha256: string | null
  officialMemoryManifestSha256: string | null
}

export type { RunContextDescriptor }
export { createRunContextDescriptor }

export interface PromptAppliedSlot {
  name: string
  bytes: number
  sha256: string
}

export interface PersistRunContextInput {
  descriptor: RunContextDescriptor | null | undefined
  applied: readonly PromptAppliedSlot[]
  promptContentSha256?: string
  cwd: string | null
  cwdSource?: ProjectRunCwdSource
  sessionRepoOverlay?: boolean
  repo?: { owner: string; repo: string; branch: string; headSha: string | null }
  /** Frozen by buildPromptContext. Writer must not re-read project meta/ledger. */
  frozen?: FrozenProjectContextDigests
}

export interface PersistRunContextResult {
  wrote: boolean
  sha256?: string
  snapshotId?: string
  contextVersion?: number
  error?: string
}

/**
 * Run id for a webchat turn. One id per turn (not per chat), so a chat whose
 * context changes between turns keeps a snapshot for each, instead of every
 * spawn overwriting `runs/webchat_<chat>`.
 */
export function webchatRunId(peerId: string, turnTraceId: string): string {
  return `webchat:${peerId}:${turnTraceId}`
}

/**
 * A later turn of a live session brings a new descriptor. Engines keep the
 * descriptor object they were built with and persist snapshots from it, so
 * replacing the session's reference would leave them on the first turn's run
 * id. When the run still targets the same project and session, carry the new
 * run id into the object they hold; otherwise take the new descriptor.
 */
export function adoptRunContext(
  current: RunContextDescriptor | undefined,
  next: RunContextDescriptor,
): RunContextDescriptor {
  if (
    current &&
    current.boardProjectId === next.boardProjectId &&
    current.sessionKey === next.sessionKey &&
    current.channel === next.channel
  ) {
    current.runId = next.runId
    return current
  }
  return next
}

export async function persistRunContextSnapshot(
  input: PersistRunContextInput,
): Promise<PersistRunContextResult> {
  try {
    const desc = input.descriptor
    if (!desc) return { wrote: false }
    if (!isProjectContextEnabled()) return { wrote: false }
    if (!desc.persistSnapshot || !desc.boardProjectId) return { wrote: false }

    const slots: ProjectRunSlotHash[] = input.applied.map((s) => {
      const { volatile, redacted } = classifySlot(s.name)
      return { name: s.name, bytes: s.bytes, sha256: s.sha256, volatile, redacted }
    })
    const frozen = input.frozen
    const cwd = input.cwd ?? desc.workspaceCwd
    const snapshot = emptyProjectRunSnapshot({
      runId: desc.runId,
      boardProjectId: desc.boardProjectId,
      contextVersion: frozen?.contextVersion ?? 0,
      createdAt: Date.now(),
      agentId: desc.agentId,
      channel: desc.channel,
      sessionKey: desc.sessionKey,
      ticket: desc.ticket,
      workspace: {
        spec: desc.workspaceSpec,
        cwd,
        cwdRealpath: realpathOrNull(cwd),
        cwdSource: input.cwdSource ?? desc.cwdSource,
        sessionRepoOverlay: input.sessionRepoOverlay ?? desc.cwdSource === 'session_repo',
        repo: input.repo,
      },
      hashes: {
        promptContentSha256: input.promptContentSha256,
        slots,
        projectMdSha256: frozen?.projectMdSha256 ?? undefined,
        projectSkillsSha256: frozen?.skillManifestSha256 ?? undefined,
        officialMemoryManifestSha256: frozen?.officialMemoryManifestSha256 ?? null,
      },
      promotion: {
        officialCount: 0,
        officialManifestSha256: frozen?.officialMemoryManifestSha256 ?? null,
      },
    })
    const written = await writeProjectRunContextFile(snapshot)
    const snapshotId = safeRunIdSegment(desc.runId)
    try {
      const db = getTaskboardDb()
      const run = getRun(db, desc.runId)
      if (run) {
        updateRun(db, desc.runId, {
          contextSnapshotId: snapshotId,
          contextSha256: written.sha256,
          contextVersion: frozen?.contextVersion ?? 0,
        })
      }
    } catch {
      /* webchat / tests without matching run row */
    }
    void pruneProjectRunSnapshots(desc.boardProjectId).catch(() => {})
    return {
      wrote: true,
      sha256: written.sha256,
      snapshotId,
      contextVersion: frozen?.contextVersion,
    }
  } catch (err) {
    return { wrote: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function cwdFieldsFromDecision(decision: EngineCwdDecision): {
  cwd: string
  cwdSource: ProjectRunCwdSource
  sessionRepoOverlay: boolean
} {
  return {
    cwd: decision.cwd,
    cwdSource: decision.source,
    sessionRepoOverlay: decision.sessionRepoOverlay,
  }
}

export { readProjectRunContextFile, createRunContextDescriptor as createDescriptor }
