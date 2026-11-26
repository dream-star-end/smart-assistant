/**
 * Shared symlink-safe production file discovery & coverage guard for governance scanners (OCV5-903 B4).
 *
 * Strictly uses the caller-supplied `--root <candidateDir>` (never `import.meta.url`),
 * resolves symlinked package/source entries safely with cycle protection, and verifies
 * non-zero `packages/gateway/src` coverage whenever that directory exists.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export function statFollowSafe(absPath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(absPath)
  } catch {
    return null
  }
}

export function walkDirectorySymlinkSafe(opts: {
  root: string
  relDir: string
  skipDirs: ReadonlySet<string>
  includeFile: (relPosix: string) => boolean
  out: string[]
  visitedDirs: Set<string>
}): void {
  const abs = path.join(opts.root, opts.relDir)
  const dirSt = statFollowSafe(abs)
  if (!dirSt || !dirSt.isDirectory()) return
  let canonDir: string
  try {
    canonDir = realpathSync(abs)
  } catch {
    return
  }
  if (opts.visitedDirs.has(canonDir)) return
  opts.visitedDirs.add(canonDir)

  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (opts.skipDirs.has(ent.name)) continue
    const nextRel = `${opts.relDir}/${ent.name}`
    const nextAbs = path.join(abs, ent.name)
    if (ent.isDirectory()) {
      walkDirectorySymlinkSafe({ ...opts, relDir: nextRel })
    } else if (ent.isFile()) {
      if (opts.includeFile(nextRel)) opts.out.push(nextRel)
    } else if (ent.isSymbolicLink()) {
      const targetSt = statFollowSafe(nextAbs)
      if (!targetSt) continue
      if (targetSt.isDirectory()) walkDirectorySymlinkSafe({ ...opts, relDir: nextRel })
      else if (targetSt.isFile() && opts.includeFile(nextRel)) opts.out.push(nextRel)
    }
  }
}

export function discoverPackagesProdFiles(opts: {
  root: string
  skipDirs: ReadonlySet<string>
  includeFile: (relPosix: string) => boolean
  fallbackRootSrc?: boolean
}): string[] {
  const out: string[] = []
  const visitedDirs = new Set<string>()
  const pkgRoot = path.join(opts.root, 'packages')
  if (statFollowSafe(pkgRoot)?.isDirectory()) {
    for (const pkg of readdirSync(pkgRoot, { withFileTypes: true })) {
      const pkgAbs = path.join(pkgRoot, pkg.name)
      const isDir = pkg.isDirectory() || (pkg.isSymbolicLink() && Boolean(statFollowSafe(pkgAbs)?.isDirectory()))
      if (!isDir) continue
      if (pkg.name === 'channels') {
        const chRoot = path.join(pkgRoot, 'channels')
        if (statFollowSafe(chRoot)?.isDirectory()) {
          for (const ch of readdirSync(chRoot, { withFileTypes: true })) {
            const chAbs = path.join(chRoot, ch.name)
            const chIsDir = ch.isDirectory() || (ch.isSymbolicLink() && Boolean(statFollowSafe(chAbs)?.isDirectory()))
            if (chIsDir) {
              walkDirectorySymlinkSafe({
                root: opts.root,
                relDir: `packages/channels/${ch.name}/src`,
                skipDirs: opts.skipDirs,
                includeFile: opts.includeFile,
                out,
                visitedDirs,
              })
            }
          }
        }
      } else {
        walkDirectorySymlinkSafe({
          root: opts.root,
          relDir: `packages/${pkg.name}/src`,
          skipDirs: opts.skipDirs,
          includeFile: opts.includeFile,
          out,
          visitedDirs,
        })
      }
    }
  } else if (opts.fallbackRootSrc && statFollowSafe(path.join(opts.root, 'src'))?.isDirectory()) {
    walkDirectorySymlinkSafe({
      root: opts.root,
      relDir: 'src',
      skipDirs: opts.skipDirs,
      includeFile: opts.includeFile,
      out,
      visitedDirs,
    })
  }
  return out.sort()
}

export function checkGatewayCoverage(root: string, discoveredFiles: readonly string[]): string | null {
  const gatewaySrc = path.join(root, 'packages', 'gateway', 'src')
  if (statFollowSafe(gatewaySrc)?.isDirectory()) {
    const gatewayFiles = discoveredFiles.filter((f) => f.startsWith('packages/gateway/src/')).length
    if (gatewayFiles === 0) {
      return `coverage check failed: ${gatewaySrc} exists under --root ${root} but 0 gateway production files were discovered`
    }
  }
  return null
}
