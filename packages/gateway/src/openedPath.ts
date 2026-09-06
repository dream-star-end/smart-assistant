import { lstatSync, realpathSync } from 'node:fs'

export type ResolveOpenedPathFs = {
  realpathSync: (p: string) => string
  lstatSync: (p: string) => { isSymbolicLink: () => boolean }
}

const defaultFs: ResolveOpenedPathFs = { realpathSync, lstatSync }

/**
 * Resolve the path of an already-opened fd.
 * Linux: `/proc/self/fd/<fd>` (unchanged).
 * win32: realpath(fallbackPath) after refusing a reparse/symlink leaf. Fail-closed.
 */
export function resolveOpenedPath(
  fd: number,
  fallbackPath: string,
  platform: NodeJS.Platform = process.platform,
  fs: ResolveOpenedPathFs = defaultFs,
): string {
  if (platform !== 'win32') {
    return fs.realpathSync(`/proc/self/fd/${fd}`)
  }
  let st: { isSymbolicLink: () => boolean }
  try {
    st = fs.lstatSync(fallbackPath)
  } catch (err) {
    throw err
  }
  if (st.isSymbolicLink()) {
    throw new Error(`reparse point refused: ${fallbackPath}`)
  }
  return fs.realpathSync(fallbackPath)
}
