import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Linux flock belongs to an open file description. fd 3 in the short-lived
 * flock process is a dup of the writer's fd, NOT an independently opened file.
 * The writer keeps that description alive after flock exits. Killing a helper
 * therefore cannot unlock a still-running input writer (unlike a lock-holder
 * child running cat). Never unlink/replace this lock inode, including on error.
 */
export async function withReceiptWriteBarrier<T>(
  lockPath: string,
  write: () => Promise<T>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  if (process.platform !== 'linux') throw new Error('receipt writer barrier requires Linux flock')
  const timeoutMs = opts.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('invalid receipt writer barrier timeout')
  }
  opts.signal?.throwIfAborted()
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const fd = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    if (!(await fd.stat()).isFile()) throw new Error('receipt barrier must be a regular file')
    await fd.chmod(0o600)
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', String(timeoutMs / 1000), '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd.fd],
      })
      let failure: Error | undefined
      // Once a write begins, abort must not close the fd underneath it. Here
      // only the acquisition helper exists; wait for its close before release.
      const abort = () => {
        failure = new Error('receipt writer barrier acquisition aborted')
        child.kill('SIGKILL')
      }
      const deadline = setTimeout(() => {
        failure = new Error('receipt writer barrier acquisition timed out')
        child.kill('SIGKILL')
      }, timeoutMs + 1000)
      opts.signal?.addEventListener('abort', abort, { once: true })
      if (opts.signal?.aborted) abort()
      child.once('error', err => { failure = err })
      child.once('close', code => {
        clearTimeout(deadline)
        opts.signal?.removeEventListener('abort', abort)
        if (failure) reject(failure)
        else if (code !== 0) reject(new Error(`receipt writer barrier flock failed (${code})`))
        else resolve()
      })
    })
    opts.signal?.throwIfAborted()
    // await is intentional: finally must not close the descriptor while the
    // promise's actual append/flush/fsync/owner commit is still in progress.
    return await write()
  } finally {
    await fd.close()
  }
}
