import { lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Publish only complete, private files. References live with the workspace;
 * ending a turn must not remove files still referenced by native history.
 * A content key allows native resume to reuse a reference after process exit. */
export async function writeContextReference(
  cwd: string,
  content: string | Uint8Array,
  filename: string,
  key?: string,
): Promise<{ file: string; remove: () => Promise<void> }> {
  if (key !== undefined && !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid context reference key')
  const destination = key ? join(cwd, `.openclaude-context-${key}`) : undefined
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
  const dir = await mkdtemp(join(cwd, '.openclaude-context-'))
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
