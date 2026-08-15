/**
 * V5 workspace inspect data-plane protocol (PR-A).
 * JSON shapes and limits only — no IO.
 */

export const WORKSPACE_INSPECT_PROTOCOL_VERSION = 1 as const

export const WORKSPACE_INSPECT_MAX_LIST_ENTRIES = 200
export const WORKSPACE_INSPECT_MAX_GIT_ENTRIES = 500
export const WORKSPACE_INSPECT_MAX_GIT_STDOUT_BYTES = 1024 * 1024
export const WORKSPACE_INSPECT_MAX_JSON_BYTES = 256 * 1024
export const WORKSPACE_INSPECT_GIT_TIMEOUT_MS = 5_000
export const WORKSPACE_INSPECT_LIST_TIMEOUT_MS = 2_000
export const WORKSPACE_INSPECT_MAX_PATH_DEPTH = 32
export const WORKSPACE_INSPECT_PROCESS_CONCURRENCY = 2
export const WORKSPACE_INSPECT_SESSION_CONCURRENCY = 1

export const WORKSPACE_INSPECT_ERROR_CODES = [
  'BAD_SESSION_ID',
  'BAD_PATH',
  'MISSING_SESSION_ID',
  'PATH_DENIED',
  'NOT_FOUND',
  'IN_FLIGHT',
  'HOST_FORBIDDEN',
  'GIT_TIMEOUT',
  'LIST_TIMEOUT',
  'WORKSPACE_CHANGED',
] as const

export type WorkspaceInspectErrorCode = (typeof WORKSPACE_INSPECT_ERROR_CODES)[number]

export const WORKSPACE_INSPECT_EMPTY_REASONS = ['no_workspace', 'not_ready', 'not_a_repo'] as const
export type WorkspaceInspectEmptyReason = (typeof WORKSPACE_INSPECT_EMPTY_REASONS)[number]

export const WORKSPACE_INSPECT_SKIP_NAMES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
  'vendor',
] as const

export type WorkspaceInspectSkipName = (typeof WORKSPACE_INSPECT_SKIP_NAMES)[number]

export type WorkspaceInspectTruncationReason = 'max_entries' | 'stdout_limit' | 'byte_budget'

export interface WorkspaceInspectTruncation {
  reason: WorkspaceInspectTruncationReason
  omitted: null | 'unknown'
}

export interface WorkspaceInspectEmptyBody {
  ok: true
  empty: true
  reason: WorkspaceInspectEmptyReason
  snapshot: null
}

export interface WorkspaceInspectLiveHead {
  authority: 'live'
  branch: string | null
  sha: string
  detached: boolean
}

export interface WorkspaceInspectDiffTotals {
  added: number
  deleted: number
}

export type WorkspaceInspectGitStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'copied'
  | 'unmerged'

export interface WorkspaceInspectGitEntry {
  path: string
  status: WorkspaceInspectGitStatus
  added: number | null
  deleted: number | null
  binary: boolean
  previewable: boolean
  preview_path?: string
}

export interface WorkspaceInspectGitSnapshot {
  live_head: WorkspaceInspectLiveHead
  diff: WorkspaceInspectDiffTotals | null
  entries: WorkspaceInspectGitEntry[]
  truncated: boolean
  truncation: WorkspaceInspectTruncation | null
}

export interface WorkspaceInspectGitSnapshotBody {
  ok: true
  empty: false
  snapshot: WorkspaceInspectGitSnapshot
}

export type WorkspaceInspectListKind = 'file' | 'dir' | 'symlink' | 'skipped'
export type WorkspaceInspectSkipReason = 'vendor' | 'vcs' | 'denied'

export interface WorkspaceInspectListEntry {
  name: string
  kind: WorkspaceInspectListKind
  reason?: WorkspaceInspectSkipReason
  previewable?: boolean
  preview_path?: string
}

export interface WorkspaceInspectListDirBody {
  ok: true
  empty: false
  cwd: string
  entries: WorkspaceInspectListEntry[]
  truncated: boolean
  truncation: WorkspaceInspectTruncation | null
}

export interface WorkspaceInspectErrorBody {
  ok: false
  error: {
    code: WorkspaceInspectErrorCode
    message: string
  }
}

export type WorkspaceInspectGitResponse =
  | WorkspaceInspectEmptyBody
  | WorkspaceInspectGitSnapshotBody
  | WorkspaceInspectErrorBody

export type WorkspaceInspectListResponse =
  | WorkspaceInspectEmptyBody
  | WorkspaceInspectListDirBody
  | WorkspaceInspectErrorBody
