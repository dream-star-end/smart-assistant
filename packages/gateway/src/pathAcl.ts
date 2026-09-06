import { homedir, tmpdir } from 'node:os'
import { resolve, win32 as pathWin32 } from 'node:path'

/**
 * Directory containment: resolve both sides, then prefix-compare using a
 * trailing path.sep (never a bare startsWith). win32 also folds case.
 * Linux result is identical to `candidate === root || candidate.startsWith(root + '/')`
 * after resolve().
 */
export function isPathWithinRoot(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    const c = pathWin32.resolve(candidate)
    const r = pathWin32.resolve(root)
    const cl = c.toLowerCase()
    const rl = r.toLowerCase()
    if (cl === rl) return true
    const prefix = rl.endsWith(pathWin32.sep) ? rl : rl + pathWin32.sep
    return cl.startsWith(prefix)
  }
  const c = resolve(candidate)
  const r = resolve(root)
  if (c === r) return true
  return c.startsWith(r + '/')
}

/** Filename/prefix match for `/tmp/openclaude-*` (not a directory fence). */
export function hasResolvedPrefix(
  candidate: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    const c = pathWin32.resolve(candidate).toLowerCase()
    const p = pathWin32.resolve(prefix).toLowerCase()
    return c.startsWith(p)
  }
  return resolve(candidate).startsWith(resolve(prefix))
}

export function trustedContainerHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    return pathWin32.resolve(env.USERPROFILE || homedir())
  }
  return '/home/agent'
}

/** Children only (Linux ≡ `startsWith(root + '/')`). */
export function isPathStrictlyUnder(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isPathWithinRoot(candidate, root, platform)) return false
  if (platform === 'win32') {
    return pathWin32.resolve(candidate).toLowerCase() !== pathWin32.resolve(root).toLowerCase()
  }
  return resolve(candidate) !== resolve(root)
}

export function openclaudeTempPrefix(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return pathWin32.resolve(pathWin32.join(tmpdir(), 'openclaude-'))
  }
  return resolve('/tmp/openclaude-')
}


