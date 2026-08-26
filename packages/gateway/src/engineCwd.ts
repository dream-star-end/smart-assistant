/**
 * Engine spawn cwd: bound project workspace, optional session-repo overlay.
 *
 * session_repo overlay is allowed: when the GitHub clone is `ready`, adapters
 * switch to snapshot.workspaceDir. Ordinary bound sessions (no repo, or repo
 * not ready) MUST keep the project workspace passed as agentBaseDir.
 * ~/.openclaude/projects is never a cwd (enforced by resolveProjectCwd).
 */

export type EngineCwdSource = 'project_workspace' | 'session_repo' | 'default'

export interface EngineCwdDecision {
  cwd: string
  source: EngineCwdSource
  agentBaseDir: string
  sessionRepoOverlay: boolean
}

export function decideEngineCwd(opts: {
  agentBaseDir: string
  repoSnapshot?: { status?: string; workspaceDir?: string | null } | null
  projectBound?: boolean
}): EngineCwdDecision {
  const agentBaseDir = opts.agentBaseDir
  const repoDir =
    opts.repoSnapshot?.status === 'ready' && opts.repoSnapshot.workspaceDir
      ? opts.repoSnapshot.workspaceDir
      : null
  if (repoDir) {
    return {
      cwd: repoDir,
      source: 'session_repo',
      agentBaseDir,
      sessionRepoOverlay: true,
    }
  }
  return {
    cwd: agentBaseDir,
    source: opts.projectBound ? 'project_workspace' : 'default',
    agentBaseDir,
    sessionRepoOverlay: false,
  }
}
