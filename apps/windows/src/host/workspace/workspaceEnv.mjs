/**
 * Fields S6 merges into gateway spawn (cwd / --add-dir / extraEnv).
 * Do not call buildGatewayEnv here — S4 owns that constructor.
 */
export function buildWorkspaceEnv({ roots = [], platform = process.platform } = {}) {
  const addDirs = Array.isArray(roots)
    ? roots.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : []
  const engineCwd = addDirs[0] || ''
  const delim = platform === 'win32' ? ';' : ':'
  const extraEnv = engineCwd
    ? {
        OPENCLAUDE_ENGINE_CWD: engineCwd,
        OPENCLAUDE_ADD_DIRS: addDirs.join(delim),
      }
    : {}
  return {
    engineCwd,
    addDirs,
    extraEnv,
    spawn: {
      cwd: engineCwd || undefined,
      args: addDirs.flatMap((dir) => ['--add-dir', dir]),
    },
  }
}
