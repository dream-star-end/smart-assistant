/**
 * Phase 3 reusable run-context snapshot descriptor.
 *
 * Phase 2 stores the type and cwd-source contract only. Writers that persist
 * `projects/<id>/runs/<runId>/context.json` (phase 3) MUST use this shape so
 * chat, taskboard, and preview share one schema.
 *
 * Reproducibility (do not weaken):
 *   - A snapshot answers "which slots / project version / cwd / HEAD this run saw".
 *   - It does NOT promise a bit-identical prompt replay (ENV probes, literature,
 *     MODEL_HINT, clocks, user.md always-block are live).
 *   - conflictPolicy `run_isolated`: a later promotion does not rewrite the
 *     already-injected text of a running turn.
 */

import type { ProjectWorkspace } from './projectContext.js'

export type ProjectRunCwdSource = 'project_workspace' | 'session_repo' | 'default'

export type ProjectRunConflictPolicy = 'run_isolated'

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
    /** session_repo overlay is allowed and wins when the clone is ready. */
    cwdSource: ProjectRunCwdSource
    sessionRepoOverlay: boolean
    repo?: { owner: string; repo: string; branch: string; headSha: string | null }
  }
  hashes: {
    promptContentSha256?: string
    slots?: Array<{ name: string; bytes: number; sha256: string }>
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
}

export function emptyProjectRunSnapshot(
  partial: Omit<ProjectRunContextSnapshotDescriptor, 'schemaVersion' | 'conflictPolicy' | 'freshness'> &
    Partial<Pick<ProjectRunContextSnapshotDescriptor, 'freshness' | 'conflictPolicy'>>,
): ProjectRunContextSnapshotDescriptor {
  return {
    schemaVersion: 1,
    conflictPolicy: partial.conflictPolicy ?? 'run_isolated',
    freshness: partial.freshness ?? { dynamicFacts: 'live' },
    ...partial,
  }
}
