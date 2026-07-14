import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface KernelFileLock {
  release(): Promise<void>
}

export type KernelFileLockMode = 'exclusive' | 'shared'

/**
 * Acquire a real Linux advisory lock and keep the `flock` child alive until
 * release.  Success is acknowledged only after the child prints our random
 * marker; spawn success alone does not mean the lock was acquired.
 *
 * The lock file is intentionally never unlinked/replaced/renamed.  Its inode is
 * the serialization domain shared by every gateway process mounting the user
 * volume.
 */
export async function acquireKernelFileLock(
  lockPath: string,
  timeoutMs = 5_000,
  mode: KernelFileLockMode = 'exclusive',
): Promise<KernelFileLock> {
  await mkdir(dirname(lockPath), { recursive: true })
  const fh = await open(lockPath, 'a', 0o600)
  await fh.close()
  await chmod(lockPath, 0o600)

  const marker = `oc-flock-${randomUUID()}`
  const waitSeconds = Math.max(0.001, timeoutMs / 1000).toFixed(3)
  const proc = spawn(
    '/usr/bin/flock',
    [
      mode === 'shared' ? '--shared' : '--exclusive',
      '--wait',
      waitSeconds,
      lockPath,
      '/bin/sh',
      '-c',
      'printf "%s\\n" "$1"; cat >/dev/null',
      'openclaude-flock',
      marker,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )

  await waitForAcquireMarker(proc, marker, timeoutMs + 1_000)
  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      proc.stdin.end()
      await waitForExit(proc)
    },
  }
}

function waitForAcquireMarker(
  proc: ChildProcessWithoutNullStreams,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.stdout.off('data', onStdout)
      proc.stderr.off('data', onStderr)
      proc.off('error', onError)
      proc.off('exit', onExit)
      if (err) reject(err)
      else resolve()
    }
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8')
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      if (lines.some((line) => line === marker)) finish()
    }
    const onStderr = (chunk: Buffer): void => {
      stderr = (stderr + chunk.toString('utf8')).slice(-500)
    }
    const onError = (err: Error): void => finish(err)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        new Error(
          `kernel flock exited before acquire marker (code=${String(code)}, signal=${String(signal)}, stderr=${stderr.trim()})`,
        ),
      )
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(new Error('kernel flock acquire timeout'))
    }, timeoutMs)
    proc.stdout.on('data', onStdout)
    proc.stderr.on('data', onStderr)
    proc.once('error', onError)
    proc.once('exit', onExit)
  })
}

function waitForExit(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      if (proc.exitCode === 0) resolve()
      else
        reject(new Error(`kernel flock release exited ${String(proc.exitCode ?? proc.signalCode)}`))
      return
    }
    proc.once('error', reject)
    proc.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`kernel flock release exited ${String(code ?? signal)}`))
    })
  })
}
