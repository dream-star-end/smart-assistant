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
  loadProjectContext,
  officialManifestSha256,
  paths,
  ProjectMemoryLedger,
  pruneProjectRunSnapshots,
  realpathOrNull,
  readProjectRunContextFile,
  safeRunIdSegment,
  writeProjectRunContextFile,
  type ProjectRunCwdSource,
  type ProjectRunSlotHash,
  type RunContextDescriptor,
} from '@openclaude/storage'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineCwdDecision } from './engineCwd.js'
import { getRun, getTaskboardDb, updateRun } from './taskboard/db/index.js'

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
}

export interface PersistRunContextResult {
  wrote: boolean
  sha256?: string
  snapshotId?: string
  contextVersion?: number
  error?: string
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function digestDir(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined
  try {
    const names = readdirSync(dir).filter((n) => !n.startsWith('.')).sort()
    return sha256Hex(names.join('\n'))
  } catch {
    return undefined
  }
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
    const ctx = await loadProjectContext(desc.boardProjectId)
    let officialCount = 0
    let officialManifest: string | null = null
    try {
      const ledger = new ProjectMemoryLedger(getTaskboardDb())
      const official = ledger.listOfficial(desc.boardProjectId)
      officialCount = official.length
      officialManifest = officialManifestSha256(official)
    } catch {
      /* personal tests without taskboard */
    }
    const cwd = input.cwd ?? desc.workspaceCwd
    const snapshot = emptyProjectRunSnapshot({
      runId: desc.runId,
      boardProjectId: desc.boardProjectId,
      contextVersion: ctx.version,
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
        projectMdSha256: ctx.meta.instructionsSha256 ?? undefined,
        projectSkillsSha256: digestDir(join(paths.projectDir(desc.boardProjectId), 'skills')),
        officialMemoryManifestSha256: officialManifest,
      },
      promotion: {
        officialCount,
        officialManifestSha256: officialManifest,
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
          contextVersion: ctx.version,
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
      contextVersion: ctx.version,
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
