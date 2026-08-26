/**
 * Run-context descriptor (unique authority) + spawn-time snapshot files.
 *
 * Engines MUST NOT invent runId/projectId. Session/delegate/patrol pass a
 * RunContextDescriptor; the common writer persists metadata after
 * PromptContextResult.applied and cwd are frozen, before subprocess spawn.
 *
 * Reproducibility:
 *   - Answers which slots / project version / cwd / HEAD this run saw.
 *   - Does NOT promise bit-identical prompt replay.
 *   - conflictPolicy `run_isolated`: later promotions do not rewrite this run.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import type { ProjectWorkspace } from './projectContext.js'
import { BOARD_PROJECT_ID_RE } from './projectContext.js'
import { paths } from './paths.js'

export type ProjectRunCwdSource = 'project_workspace' | 'session_repo' | 'default'
export type ProjectRunConflictPolicy = 'run_isolated'

export const VOLATILE_SLOT_NAMES = new Set([
  'ENV',
  'MODEL_HINT',
  'SKILLS_LITERATURE',
  'REPO',
])
export const REDACTED_SLOT_NAMES = new Set(['SOUL', 'USER'])

export const PROJECT_RUN_SNAPSHOT_KEEP = 50
export const PROJECT_RUN_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Unique authority for run identity. Engines read this; they never guess. */
export interface RunContextDescriptor {
  schemaVersion: 1
  runId: string
  boardProjectId: string | null
  channel: string
  agentId: string
  sessionKey: string
  turnKey?: string
  ticket?: { id: string; identifier: string; version: number }
  cwdSource: ProjectRunCwdSource
  workspaceSpec: ProjectWorkspace | null
  workspaceCwd: string | null
  persistSnapshot: boolean
}

export interface ProjectRunSlotHash {
  name: string
  bytes: number
  sha256: string
  volatile: boolean
  redacted: boolean
}

export interface ProjectRunContextSnapshotDescriptor {
  schemaVersion: 1
  runId: string
  boardProjectId: string
  contextVersion: number
  createdAt: number
  agentId: string
  channel: string
  sessionKey: string
  ticket?: { id: string; identifier: string; version: number }
  workspace: {
    spec: ProjectWorkspace | null
    cwd: string | null
    cwdRealpath: string | null
    cwdSource: ProjectRunCwdSource
    sessionRepoOverlay: boolean
    repo?: { owner: string; repo: string; branch: string; headSha: string | null }
  }
  hashes: {
    promptContentSha256?: string
    slots: ProjectRunSlotHash[]
    projectMdSha256?: string
    projectMemoryIndexSha256?: string
    projectSkillsSha256?: string
    pinnedAssets?: Array<{ id: string; digest: string | null }>
    officialMemoryManifestSha256?: string | null
  }
  promotion: {
    officialCount: number
    officialManifestSha256: string | null
  }
  freshness: {
    dynamicFacts: 'live'
    memoryPolicyReason?: string
  }
  conflictPolicy: ProjectRunConflictPolicy
  replay: 'audit_only_not_bit_identical'
}

export function createRunContextDescriptor(input: {
  runId: string
  boardProjectId?: string | null
  channel: string
  agentId: string
  sessionKey: string
  turnKey?: string
  ticket?: { id: string; identifier: string; version: number }
  cwdSource?: ProjectRunCwdSource
  workspaceSpec?: ProjectWorkspace | null
  workspaceCwd?: string | null
  persistSnapshot?: boolean
}): RunContextDescriptor {
  const board =
    typeof input.boardProjectId === 'string' && BOARD_PROJECT_ID_RE.test(input.boardProjectId)
      ? input.boardProjectId.toLowerCase()
      : null
  return {
    schemaVersion: 1,
    runId: input.runId,
    boardProjectId: board,
    channel: input.channel,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    turnKey: input.turnKey,
    ticket: input.ticket,
    cwdSource: input.cwdSource ?? 'default',
    workspaceSpec: input.workspaceSpec ?? null,
    workspaceCwd: input.workspaceCwd ?? null,
    persistSnapshot: input.persistSnapshot ?? Boolean(board),
  }
}

export function safeRunIdSegment(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180) || 'run'
}

export function classifySlot(name: string): { volatile: boolean; redacted: boolean } {
  return {
    volatile: VOLATILE_SLOT_NAMES.has(name),
    redacted: REDACTED_SLOT_NAMES.has(name),
  }
}

export function emptyProjectRunSnapshot(
  partial: Omit<
    ProjectRunContextSnapshotDescriptor,
    'schemaVersion' | 'conflictPolicy' | 'freshness' | 'replay'
  > &
    Partial<Pick<ProjectRunContextSnapshotDescriptor, 'freshness' | 'conflictPolicy' | 'replay'>>,
): ProjectRunContextSnapshotDescriptor {
  return {
    schemaVersion: 1,
    conflictPolicy: partial.conflictPolicy ?? 'run_isolated',
    freshness: partial.freshness ?? { dynamicFacts: 'live' },
    replay: 'audit_only_not_bit_identical',
    ...partial,
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

async function atomicWrite(target: string, body: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp-${randomUUID()}`
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, target)
}

export async function writeProjectRunContextFile(
  snapshot: ProjectRunContextSnapshotDescriptor,
): Promise<{ path: string; sha256: string }> {
  if (!BOARD_PROJECT_ID_RE.test(snapshot.boardProjectId)) {
    throw new Error('invalid boardProjectId')
  }
  const runSeg = safeRunIdSegment(snapshot.runId)
  const path = paths.projectRunContextFile(snapshot.boardProjectId, runSeg)
  const body = `${JSON.stringify(snapshot, null, 2)}\n`
  await atomicWrite(path, body)
  return { path, sha256: sha256Hex(body) }
}

export async function readProjectRunContextFile(
  boardProjectId: string,
  runId: string,
): Promise<ProjectRunContextSnapshotDescriptor | null> {
  if (!BOARD_PROJECT_ID_RE.test(boardProjectId)) return null
  const path = paths.projectRunContextFile(boardProjectId, safeRunIdSegment(runId))
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as ProjectRunContextSnapshotDescriptor
  } catch {
    return null
  }
}

export function realpathOrNull(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  try {
    return existsSync(cwd) ? realpathSync(cwd) : cwd
  } catch {
    return cwd
  }
}

/**
 * Keep the newest 50 snapshots or those newer than 30 days (whichever keeps
 * more). Fail-soft: errors never throw to the caller.
 */
export async function pruneProjectRunSnapshots(boardProjectId: string): Promise<void> {
  if (!BOARD_PROJECT_ID_RE.test(boardProjectId)) return
  const root = paths.projectRunsDir(boardProjectId)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  const now = Date.now()
  const entries: Array<{ name: string; mtime: number; path: string }> = []
  for (const name of names) {
    const dir = join(root, name)
    try {
      const st = await stat(dir)
      if (!st.isDirectory()) continue
      entries.push({ name, mtime: st.mtimeMs, path: dir })
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  const keep = new Set(
    entries
      .filter((e) => now - e.mtime < PROJECT_RUN_SNAPSHOT_MAX_AGE_MS)
      .slice(0, PROJECT_RUN_SNAPSHOT_KEEP)
      .map((e) => e.name),
  )
  for (const e of entries) {
    if (keep.has(e.name)) continue
    await rm(e.path, { recursive: true, force: true }).catch(() => {})
  }
}

export function pruneProjectRunSnapshotsSync(boardProjectId: string): void {
  if (!BOARD_PROJECT_ID_RE.test(boardProjectId)) return
  const root = paths.projectRunsDir(boardProjectId)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  const now = Date.now()
  const entries: Array<{ name: string; mtime: number; path: string }> = []
  for (const name of names) {
    const dir = join(root, name)
    try {
      const st = statSync(dir)
      if (!st.isDirectory()) continue
      entries.push({ name, mtime: st.mtimeMs, path: dir })
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  const keep = new Set(
    entries
      .filter((e) => now - e.mtime < PROJECT_RUN_SNAPSHOT_MAX_AGE_MS)
      .slice(0, PROJECT_RUN_SNAPSHOT_KEEP)
      .map((e) => e.name),
  )
  for (const e of entries) {
    if (keep.has(e.name)) continue
    try {
      rm(e.path, { recursive: true, force: true }).catch(() => {})
    } catch {
      /* fail-soft */
    }
  }
}
