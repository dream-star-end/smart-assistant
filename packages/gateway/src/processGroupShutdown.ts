/** Bounded process-group termination shared by the CCB supervisor and the
 * one-shot CLI engine adapters.
 *
 * Every engine spawn site uses `detached: true`, so the direct child owns a
 * process group and only a group signal reaches its tool descendants. None of
 * these waits may be unbounded: a descendant that escapes the group keeps the
 * turn's stdout open, and a caller blocked on the close barrier would never
 * write a terminal state. */

import { spawnSync as spawnSyncDefault } from 'node:child_process'
import type { Readable } from 'node:stream'

type SignalTarget = {
  pid?: number | undefined
  kill(signal: NodeJS.Signals): boolean
}

export type KillProcessGroupOpts = {
  platform?: NodeJS.Platform
  kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean
  spawnSync?: (
    command: string,
    args?: readonly string[],
    options?: { windowsHide?: boolean; stdio?: 'ignore' },
  ) => unknown
}

export function shutdownTimeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export function waitForCloseWithin(
  closePromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (closed: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(closed)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    closePromise.then(() => finish(true))
  })
}

export function killProcessGroup(
  proc: SignalTarget,
  signal: NodeJS.Signals,
  opts?: KillProcessGroupOpts,
): void {
  const platform = opts?.platform ?? process.platform
  const groupKill = opts?.kill ?? process.kill.bind(process)
  const pid = proc.pid

  if (platform === 'win32') {
    if (typeof pid === 'number' && pid > 0) {
      const spawnSync = opts?.spawnSync ?? spawnSyncDefault
      try {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch {
        /* Job Object would be better; P2 uses taskkill /T. Fall back below. */
      }
    }
    try {
      proc.kill(signal)
    } catch {
      /* ignore */
    }
    return
  }

  try {
    if (typeof pid === 'number' && pid > 0) {
      groupKill(-pid, signal)
      return
    }
  } catch {
    // Fall back to the direct child if the detached process group is already
    // gone or unavailable on this platform.
  }
  try {
    proc.kill(signal)
  } catch {
    /* ignore */
  }
}

/** Drop our read ends of a child's stdio.
 *
 * A descendant that outlived a process-group SIGKILL still owns the write
 * ends, so 'close' never fires and the fds stay pinned for as long as the
 * gateway runs. Releasing our side both frees them and is usually what finally
 * lets 'close' fire. */
export function detachChildStdio(proc: {
  stdout?: Readable | null
  stderr?: Readable | null
}): void {
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue
    try {
      stream.removeAllListeners('data')
      // An unhandled 'error' from the teardown itself would take the gateway
      // down, and nothing above this point listens on the streams.
      stream.on('error', () => {})
      stream.destroy()
    } catch {
      /* already torn down */
    }
  }
}
