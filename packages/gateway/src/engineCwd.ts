/**
 * Engine spawn cwd: bound project workspace, optional session-repo overlay.
 *
 * session_repo overlay is allowed: when the GitHub clone is `ready`, adapters
 * switch to snapshot.workspaceDir. Ordinary bound sessions (no repo, or repo
 * not ready) MUST keep the project workspace passed as agentBaseDir.
 * ~/.openclaude/projects is never a cwd (enforced by resolveProjectCwd).
 *
 * Desktop Host may inject OPENCLAUDE_ENGINE_CWD / OPENCLAUDE_ADD_DIRS; when
 * set and there is no ready session-repo overlay, those win over agentBaseDir.
 * Unset → existing container/personal behavior.
 */

export type EngineCwdSource = 'project_workspace' | 'session_repo' | 'default'

export interface EngineCwdDecision {
  cwd: string
  source: EngineCwdSource
  agentBaseDir: string
  sessionRepoOverlay: boolean
}

export function resolveDesktopWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const cwd = env.OPENCLAUDE_ENGINE_CWD?.trim() || ''
  if (cwd) return cwd
  const delim = platform === 'win32' ? ';' : ':'
  const first = (env.OPENCLAUDE_ADD_DIRS || '')
    .split(delim)
    .map((entry) => entry.trim())
    .filter(Boolean)[0]
  return first || ''
}

export function decideEngineCwd(opts: {
  agentBaseDir: string
  repoSnapshot?: { status?: string; workspaceDir?: string | null } | null
  projectBound?: boolean
  desktopWorkspaceDir?: string
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
  const desktop = typeof opts.desktopWorkspaceDir === 'string' ? opts.desktopWorkspaceDir.trim() : ''
  if (desktop) {
    return {
      cwd: desktop,
      source: 'project_workspace',
      agentBaseDir,
      sessionRepoOverlay: false,
    }
  }
  return {
    cwd: agentBaseDir,
    source: opts.projectBound ? 'project_workspace' : 'default',
    agentBaseDir,
    sessionRepoOverlay: false,
  }
}
