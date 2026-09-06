/**
 * Merge S5 `buildWorkspaceEnv()` into Host gateway spawn options.
 * Does not rewrite `buildGatewayEnv` — extraEnv/cwd are applied at the call site.
 *
 * `--add-dir` is carried in extraEnv (`OPENCLAUDE_ADD_DIRS`) plus `spawn.args`
 * for CCB. It is NOT appended to the gateway process argv (gatewayCmd does
 * not accept those flags).
 */
export function applyWorkspaceToGatewaySpawn(workspaceEnv, base = {}) {
  const extraEnv = {
    ...(base.extraEnv && typeof base.extraEnv === 'object' ? base.extraEnv : {}),
    ...(workspaceEnv?.extraEnv && typeof workspaceEnv.extraEnv === 'object' ? workspaceEnv.extraEnv : {}),
  }
  const cwd =
    (typeof workspaceEnv?.spawn?.cwd === 'string' && workspaceEnv.spawn.cwd) ||
    (typeof base.cwd === 'string' && base.cwd) ||
    undefined
  return {
    extraEnv,
    cwd,
    addDirArgs: Array.isArray(workspaceEnv?.spawn?.args) ? workspaceEnv.spawn.args.slice() : [],
  }
}
