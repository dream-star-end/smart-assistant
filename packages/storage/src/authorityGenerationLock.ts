/** Linux host-only flock held by Node's retained open-file-description after the fixed helper exits. */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { KernelFileLock } from './kernelFileLock.js'
export async function acquireAuthorityGenerationLock(path: string, timeoutMs = 5000): Promise<KernelFileLock> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Authority lock unavailable')
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Authority lock unavailable')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', (timeoutMs / 1000).toFixed(3), '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      })
      const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs + 1000)
      child.once('error', reject)
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        if (code === 0 && signal === null) resolve()
        else reject(new Error('Authority lock acquire failed'))
      })
    })
    const current = await lstat(path)
    if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1) throw new Error('Authority lock unavailable')
    let released = false
    return { async release() { if (released) return; released = true; await file.close() } }
  } catch (err) { await file.close(); throw err }
}
