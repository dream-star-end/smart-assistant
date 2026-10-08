/**
 * Read-only view of a project's workspace folder for the project home
 * (文件 → 项目文件夹): list a directory, download one file.
 *
 * The root is the same cwd a turn of this project runs in (resolveProjectCwd).
 * Every request path is resolved with realpath and must stay inside that
 * root; symlinks are listed but never followed. A default-workspace project
 * whose default workspace is not configured has no folder to show (the
 * fallback cwd is the gateway process directory, not the user's files).
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parseProjectWorkspace, resolveProjectCwd, type ProjectWorkspace } from '@openclaude/storage'

export const PROJECT_WORKSPACE_LIST_MAX = 500
export const PROJECT_WORKSPACE_FILE_MAX_BYTES = 50 * 1024 * 1024

export interface ProjectWorkspaceEntry {
  name: string
  type: 'dir' | 'file' | 'link' | 'other'
  size: number | null
  mtime: number | null
}

export type ProjectWorkspacePathError =
  | 'no_workspace'
  | 'invalid_path'
  | 'not_found'
  | 'not_directory'
  | 'not_file'
  | 'too_large'

export type ProjectWorkspaceRootResult =
  | { ok: true; root: string; kind: ProjectWorkspace['kind'] }
  | { ok: false; error: 'no_workspace' }

export function resolveProjectWorkspaceRoot(
  project: { id: string; workspaceSpec?: ProjectWorkspace | null; workspace?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): ProjectWorkspaceRootResult {
  const spec =
    project.workspaceSpec ?? parseProjectWorkspace(project.workspace) ?? { kind: 'default' as const }
  if (spec.kind === 'default' && !env.OPENCLAUDE_DEFAULT_WORKSPACE?.trim()) {
    return { ok: false, error: 'no_workspace' }
  }
  const cwd = resolveProjectCwd(spec, project.id, env)
  if (!cwd.ok) return { ok: false, error: 'no_workspace' }
  return { ok: true, root: cwd.cwd, kind: spec.kind }
}

/** A client-relative path → its real path inside root, or why not. */
async function resolveInside(
  root: string,
  rel: string,
): Promise<{ ok: true; abs: string; rel: string } | { ok: false; error: ProjectWorkspacePathError }> {
  if (typeof rel !== 'string' || rel.length > 1024 || rel.includes('\0') || isAbsolute(rel)) {
    return { ok: false, error: 'invalid_path' }
  }
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..')) return { ok: false, error: 'invalid_path' }
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch {
    return { ok: false, error: 'no_workspace' }
  }
  let abs: string
  try {
    abs = await realpath(join(rootReal, ...parts))
  } catch {
    return { ok: false, error: 'not_found' }
  }
  if (abs !== rootReal && !abs.startsWith(rootReal + sep)) return { ok: false, error: 'invalid_path' }
  return { ok: true, abs, rel: relative(rootReal, abs).split(sep).join('/') }
}

export async function listProjectWorkspaceDir(
  root: string,
  rel: string,
): Promise<
  | { ok: true; path: string; entries: ProjectWorkspaceEntry[]; truncated: boolean }
  | { ok: false; error: ProjectWorkspacePathError }
> {
  const target = await resolveInside(root, rel)
  if (!target.ok) return target
  let names: string[]
  try {
    const st = await stat(target.abs)
    if (!st.isDirectory()) return { ok: false, error: 'not_directory' }
    names = await readdir(target.abs)
  } catch {
    return { ok: false, error: 'not_found' }
  }
  names.sort((a, b) => a.localeCompare(b))
  const truncated = names.length > PROJECT_WORKSPACE_LIST_MAX
  const entries: ProjectWorkspaceEntry[] = []
  for (const name of names.slice(0, PROJECT_WORKSPACE_LIST_MAX)) {
    try {
      const st = await lstat(join(target.abs, name))
      const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
      entries.push({ name, type, size: type === 'file' ? st.size : null, mtime: st.mtimeMs })
    } catch {
      /* gone between readdir and lstat */
    }
  }
  // Folders first; Array.prototype.sort is stable, so names stay sorted within each group.
  entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir'))
  return { ok: true, path: target.rel, entries, truncated }
}

export async function openProjectWorkspaceFile(
  root: string,
  rel: string,
): Promise<{ ok: true; abs: string; name: string; size: number } | { ok: false; error: ProjectWorkspacePathError }> {
  if (!rel) return { ok: false, error: 'invalid_path' }
  const target = await resolveInside(root, rel)
  if (!target.ok) return target
  try {
    const st = await stat(target.abs)
    if (!st.isFile()) return { ok: false, error: 'not_file' }
    if (st.size > PROJECT_WORKSPACE_FILE_MAX_BYTES) return { ok: false, error: 'too_large' }
    return { ok: true, abs: target.abs, name: target.rel.split('/').pop() || 'file', size: st.size }
  } catch {
    return { ok: false, error: 'not_found' }
  }
}
