import * as defaultFs from 'node:fs/promises'
import path from 'node:path'

import { isPathWithinWorkspace } from './guard.mjs'

export const WORKSPACES_FILE_NAME = 'workspaces.json'
export const WORKSPACES_PRODUCT_DIR = 'Clarvy'
export const WORKSPACES_VERSION = 1

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function resolveWorkspacesPath({
  platform = process.platform,
  env = process.env,
  userDataPath,
  filePath,
} = {}) {
  if (typeof filePath === 'string' && filePath.length > 0) return filePath
  if (platform === 'win32' && typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0) {
    return path.win32.join(env.LOCALAPPDATA, WORKSPACES_PRODUCT_DIR, WORKSPACES_FILE_NAME)
  }
  if (typeof userDataPath === 'string' && userDataPath.length > 0) {
    return path.join(userDataPath, WORKSPACES_FILE_NAME)
  }
  throw new TypeError('workspaces path requires LOCALAPPDATA, userDataPath, or filePath')
}

export function normalizeWorkspaceRoots(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const roots = []
  for (const entry of input) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(trimmed)
  }
  return roots
}

function serializeDoc(roots) {
  return `${JSON.stringify({ version: WORKSPACES_VERSION, roots: normalizeWorkspaceRoots(roots) }, null, 2)}\n`
}

export function parseWorkspacesDoc(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { version: WORKSPACES_VERSION, roots: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { version: WORKSPACES_VERSION, roots: [] }
  }
  if (!isPlainRecord(parsed)) return { version: WORKSPACES_VERSION, roots: [] }
  return {
    version: WORKSPACES_VERSION,
    roots: normalizeWorkspaceRoots(parsed.roots),
  }
}

export function createWorkspaceStore({
  filePath,
  platform = process.platform,
  env = process.env,
  userDataPath,
  fsImpl = defaultFs,
} = {}) {
  const target = resolveWorkspacesPath({ platform, env, userDataPath, filePath })
  let cached = { version: WORKSPACES_VERSION, roots: [] }
  let loaded = false

  async function persist(roots) {
    const directory = path.dirname(target)
    const temporaryPath = `${target}.tmp-${process.pid}-${Date.now()}`
    const body = serializeDoc(roots)
    await fsImpl.mkdir(directory, { recursive: true })
    try {
      await fsImpl.writeFile(temporaryPath, body, { mode: 0o600 })
      await fsImpl.rename(temporaryPath, target)
    } catch (error) {
      await fsImpl.rm?.(temporaryPath, { force: true }).catch?.(() => {})
      throw error
    }
    cached = parseWorkspacesDoc(body)
    loaded = true
    return cached
  }

  async function load() {
    if (loaded) return { ...cached, roots: [...cached.roots] }
    try {
      const raw = await fsImpl.readFile(target, 'utf8')
      cached = parseWorkspacesDoc(raw)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      cached = { version: WORKSPACES_VERSION, roots: [] }
    }
    loaded = true
    return { ...cached, roots: [...cached.roots] }
  }

  return {
    filePath: target,
    async getRoots() {
      const doc = await load()
      return doc.roots
    },
    async setWorkspace(rootPath) {
      if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
        return { ok: false, error: 'invalid-path' }
      }
      const nextRoot = rootPath.trim()
      const current = await load()
      const roots = normalizeWorkspaceRoots([nextRoot, ...current.roots])
      const doc = await persist(roots)
      return { ok: true, roots: doc.roots, path: doc.roots[0] }
    },
    async contains(candidate, options = {}) {
      const roots = await this.getRoots()
      return roots.some((root) =>
        isPathWithinWorkspace(root, candidate, { platform, ...options }),
      )
    },
  }
}
