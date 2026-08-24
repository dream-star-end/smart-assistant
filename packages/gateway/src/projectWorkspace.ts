/**
 * Bound-chat / taskboard cwd for a turn.
 *
 * Flag off → default cwd (old behavior). Bound session without a ready
 * session-repo uses the project workspace spec. session_repo overlay is
 * applied later in decideEngineCwd when the clone is ready.
 */
import {
  isProjectContextEnabled,
  parseProjectWorkspace,
  resolveProjectCwd,
  type ProjectWorkspace,
} from '@openclaude/storage'
import type { EngineCwdSource } from './engineCwd.js'
import { resolveTurnProjectContext } from './projectContextRuntime.js'

export interface ChatRunWorkspace {
  projectId: string | null
  workspaceCwd?: string
  spec: ProjectWorkspace | null
  cwdSource: EngineCwdSource
  bound: boolean
}

export interface BoardProjectWorkspaceView {
  workspaceSpec?: ProjectWorkspace | null
  workspace?: string | null
}

const UNBOUND: ChatRunWorkspace = {
  projectId: null,
  spec: null,
  cwdSource: 'default',
  bound: false,
}

async function defaultGetBoardProject(id: string): Promise<BoardProjectWorkspaceView | null> {
  try {
    const { getProject, getTaskboardDb } = await import('./taskboard/db/index.js')
    const project = getProject(getTaskboardDb(), id)
    if (!project) return null
    return {
      workspaceSpec: parseProjectWorkspace(project.workspaceSpec ?? project.workspace),
      workspace: project.workspace,
    }
  } catch {
    return null
  }
}

export async function resolveChatRunWorkspace(opts: {
  sessionId?: string
  boardProjectId?: string
  env?: NodeJS.ProcessEnv
  getBoardProject?: (id: string) => BoardProjectWorkspaceView | null | Promise<BoardProjectWorkspaceView | null>
}): Promise<ChatRunWorkspace> {
  if (!isProjectContextEnabled(opts.env ?? process.env)) return UNBOUND
  const resolved = await resolveTurnProjectContext({
    sessionId: opts.sessionId,
    boardProjectId: opts.boardProjectId,
    env: opts.env,
  })
  const projectId = resolved?.boardProjectId ?? null
  if (!projectId || !resolved?.bound) return UNBOUND
  const lookup = opts.getBoardProject ?? defaultGetBoardProject
  const project = await lookup(projectId)
  const spec =
    project?.workspaceSpec ?? parseProjectWorkspace(project?.workspace) ?? { kind: 'default' as const }
  const cwd = resolveProjectCwd(spec, projectId, opts.env)
  if (!cwd.ok) {
    return { projectId, spec, cwdSource: 'default', bound: true }
  }
  return {
    projectId,
    workspaceCwd: cwd.cwd,
    spec,
    cwdSource: spec.kind === 'default' ? 'default' : 'project_workspace',
    bound: true,
  }
}
