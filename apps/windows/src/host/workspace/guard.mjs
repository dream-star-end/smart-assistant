import fs from 'node:fs'
import path from 'node:path'

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function defaultRealpath(input) {
  return fs.realpathSync(input)
}

function containsDotDotSegment(value, pathApi) {
  const sep = pathApi.sep
  const unified = String(value).replace(/[\\/]/g, sep)
  return unified.split(sep).includes('..')
}

function foldWin32(value, pathApi) {
  return pathApi.toNamespacedPath(String(value)).toLowerCase()
}

/**
 * Workspace fence (design v2 §7.2.2 / P2-DES-02).
 *
 * realpath (junctions) → win32 namespaced + case-fold → path.relative.
 * Prefix string compare against the root is not the decision.
 */
export function isPathWithinWorkspace(root, candidate, options = {}) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false
  if (root.length === 0 || candidate.length === 0) return false

  const platform = options.platform || process.platform
  const pathApi = pathApiFor(platform)
  const resolveReal = typeof options.realpath === 'function' ? options.realpath : defaultRealpath

  let rootReal
  let candReal
  try {
    rootReal = String(resolveReal(root))
    candReal = String(resolveReal(candidate))
  } catch {
    return false
  }
  if (!rootReal || !candReal) return false

  // Unresolved `..` after realpath (identity stubs / UNC `share\..`) is fail-closed.
  if (containsDotDotSegment(rootReal, pathApi) || containsDotDotSegment(candReal, pathApi)) {
    return false
  }

  let rootN = rootReal
  let candN = candReal
  if (platform === 'win32') {
    rootN = foldWin32(rootN, pathApi)
    candN = foldWin32(candN, pathApi)
  }

  const rel = pathApi.relative(rootN, candN)
  if (rel === '') return true
  if (pathApi.isAbsolute(rel)) return false
  if (rel === '..') return false

  const sep = pathApi.sep
  const segments = rel.split(sep)
  if (segments[0] === '..') return false
  if (segments.includes('..')) return false
  return true
}

export function isPathWithinAnyWorkspace(roots, candidate, options = {}) {
  if (!Array.isArray(roots) || roots.length === 0) return false
  return roots.some((root) => isPathWithinWorkspace(root, candidate, options))
}
