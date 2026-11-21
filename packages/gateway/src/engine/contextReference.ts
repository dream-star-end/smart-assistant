import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONTEXT_REFERENCE_DIR_PREFIX = '.openclaude-context-'

export function contextReferenceSessionScope(sessionKey: string): string {
  return `s-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`
}

/** Publish only complete, private files. References live with the workspace;
 * ending a turn must not remove files still referenced by native history.
 * A content key allows native resume to reuse a reference after process exit. */
export async function writeContextReference(
  cwd: string,
  content: string | Uint8Array,
  filename: string,
  key?: string,
  sessionKey?: string,
): Promise<{ file: string; remove: () => Promise<void> }> {
  if (key !== undefined && !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid context reference key')
  const scopePrefix = sessionKey
    ? `${CONTEXT_REFERENCE_DIR_PREFIX}${contextReferenceSessionScope(sessionKey)}-`
    : CONTEXT_REFERENCE_DIR_PREFIX
  const destination = key ? join(cwd, `${scopePrefix}${key}`) : undefined
  const verifyExisting = async () => {
    const dirInfo = await lstat(destination!)
    const file = join(destination!, filename)
    const fileInfo = await lstat(file)
    if (!dirInfo.isDirectory() || !fileInfo.isFile() ||
      !Buffer.from(await readFile(file)).equals(Buffer.from(content))) {
      throw new Error('Context reference does not match its original content')
    }
    return { file, remove: async () => {} }
  }
  if (destination) {
    try { return await verifyExisting() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const dir = await mkdtemp(join(cwd, scopePrefix))
  const remove = () => rm(dir, { recursive: true, force: true })
  try {
    const file = join(dir, filename)
    await writeFile(file, content, { mode: 0o600, flag: 'wx' })
    if (!destination) return { file, remove }
    try {
      await rename(dir, destination)
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      // Another request published the same key. Never read a partially written
      // target or overwrite it; compare the already complete immutable file.
      await remove()
      return await verifyExisting()
    }
    return { file: join(destination, filename), remove: () => rm(destination, { recursive: true, force: true }) }
  } catch (error) {
    await remove()
    throw error
  }
}

/**
 * Remove stale `.openclaude-context-*` directories from a workspace on session teardown.
 * When `sessionKey` is provided (B4), ONLY removes directories owned by that exact
 * full sessionKey (`s-<sha256(sessionKey).slice(0,24)>`), never touching sibling agents.
 */
export async function cleanupContextReferences(cwd: string, sessionKey?: string): Promise<number> {
  if (!cwd) return 0
  let entries: string[]
  try {
    entries = await readdir(cwd)
  } catch {
    return 0
  }
  const matchPrefix = sessionKey
    ? `${CONTEXT_REFERENCE_DIR_PREFIX}${contextReferenceSessionScope(sessionKey)}-`
    : CONTEXT_REFERENCE_DIR_PREFIX
  let removed = 0
  for (const name of entries) {
    if (!name.startsWith(matchPrefix)) continue
    try {
      const target = join(cwd, name)
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      await rm(target, { recursive: true, force: true })
      removed += 1
    } catch {
      // fail-open
    }
  }
  return removed
}
