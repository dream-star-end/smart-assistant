import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

export interface ProcStatIdentity {
  readonly ppid: number
  readonly starttime: string | null
}

/**
 * Parses `ppid` (field 4) and `starttime` (field 22, when present) from Linux `/proc/[pid]/stat`.
 * `comm` (field 2) is wrapped in parentheses and may itself contain spaces,
 * newlines, or `)` characters, so only the final `)` reliably terminates `comm`.
 */
export function parseProcStatIdentity(
  statContent: string,
): ProcStatIdentity | null {
  const closeParen = statContent.lastIndexOf(')')
  if (closeParen < 0) {
    return null
  }
  const rest = statContent.slice(closeParen + 1).trimStart()
  if (!rest) {
    return null
  }
  const fields = rest.split(/\s+/)
  const ppid = Number.parseInt(fields[1] ?? '', 10)
  if (!Number.isInteger(ppid) || ppid < 0) {
    return null
  }
  const rawStarttime = fields[19]
  const starttime =
    typeof rawStarttime === 'string' && /^\d+$/.test(rawStarttime)
      ? rawStarttime
      : null
  return { ppid, starttime }
}

export function parseProcStatPpid(statContent: string): number | null {
  return parseProcStatIdentity(statContent)?.ppid ?? null
}

function readProcIdentity(
  pid: number,
  procRoot: string,
): ProcStatIdentity | null {
  try {
    return parseProcStatIdentity(readFileSync(`${procRoot}/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

function addChildEdge(
  childrenByPpid: Map<number, Set<number>>,
  ppid: number,
  childPid: number,
): void {
  let set = childrenByPpid.get(ppid)
  if (!set) {
    set = new Set<number>()
    childrenByPpid.set(ppid, set)
  }
  set.add(childPid)
}

export interface ProcDescendantEntry {
  readonly pid: number
  readonly starttime: string | null
}

/**
 * Walks a Linux `/proc`-shaped tree and returns all transitive descendants of `rootPid`
 * (with their sampled `/proc/[pid]/stat` `starttime` identity when available)
 * without spawning `/bin/ps` (which is absent in minimal container images).
 */
export function collectProcDescendantsWithIdentity(
  rootPid: number,
  procRoot = '/proc',
): ProcDescendantEntry[] {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return []
  }

  const childrenByPpid = new Map<number, Set<number>>()
  const starttimes = new Map<number, string | null>()
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10)
    if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== entry) {
      continue
    }
    const identity = readProcIdentity(pid, procRoot)
    if (identity !== null) {
      starttimes.set(pid, identity.starttime)
      addChildEdge(childrenByPpid, identity.ppid, pid)
    }
    try {
      const tids = readdirSync(`${procRoot}/${pid}/task`)
      for (const tid of tids) {
        try {
          const childrenRaw = readFileSync(
            `${procRoot}/${pid}/task/${tid}/children`,
            'utf8',
          ).trim()
          if (!childrenRaw) continue
          for (const tok of childrenRaw.split(/\s+/)) {
            const cpid = Number.parseInt(tok, 10)
            if (Number.isInteger(cpid) && cpid > 0) {
              addChildEdge(childrenByPpid, pid, cpid)
            }
          }
        } catch {
          // CONFIG_PROC_CHILDREN disabled or thread exited — stat scan above already covers it.
        }
      }
    } catch {
      // Process exited — ignore.
    }
  }

  const visited = new Set<number>([rootPid])
  const queue: number[] = [rootPid]
  const descendants: ProcDescendantEntry[] = []
  const selfPid = process.pid

  while (queue.length > 0) {
    const current = queue.shift()!
    const kids = childrenByPpid.get(current)
    if (!kids) continue
    for (const kid of kids) {
      if (kid === selfPid || visited.has(kid)) continue
      visited.add(kid)
      descendants.push({
        pid: kid,
        starttime: starttimes.get(kid) ?? readProcIdentity(kid, procRoot)?.starttime ?? null,
      })
      queue.push(kid)
    }
  }

  return descendants
}

export function collectProcDescendants(
  rootPid: number,
  procRoot = '/proc',
): number[] {
  return collectProcDescendantsWithIdentity(rootPid, procRoot).map(d => d.pid)
}

function safeSignal(targetPid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(targetPid, sig)
  } catch {
    // ESRCH (already exited) or EPERM — safe to ignore.
  }
}

/**
 * Re-verifies `/proc/[pid]/stat` `starttime` (non-atomic best-effort guard against PID reuse
 * when pidfd is unavailable) before sending `sig`.
 */
export function signalIfSameProcess(
  targetPid: number,
  expectedStarttime: string | null,
  sig: NodeJS.Signals,
  procRoot = '/proc',
  sendSignal: (pid: number, signal: NodeJS.Signals) => void = safeSignal,
): boolean {
  if (expectedStarttime !== null) {
    const current = readProcIdentity(targetPid, procRoot)
    if (current === null || current.starttime !== expectedStarttime) {
      return false
    }
  }
  sendSignal(targetPid, sig)
  return true
}

/**
 * Terminates `pid`, its process group (`-pid`), and any `setsid()`-escaped descendants
 * without relying on unguarded external `ps` spawns (prevents `Uncaught Error: spawn ps ENOENT`
 * in minimal Linux containers).
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
  procRoot = '/proc',
): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {
        safeSignal(pid, signal)
      })
      killer.unref()
    } catch {
      safeSignal(pid, signal)
    }
    return
  }

  if (existsSync(procRoot)) {
    const rootStarttime = readProcIdentity(pid, procRoot)?.starttime ?? null
    // Freeze root process group first, then iteratively discover and SIGSTOP escaped
    // descendants across up to 3 passes so escaped children cannot keep forking mid-scan.
    safeSignal(-pid, 'SIGSTOP')
    signalIfSameProcess(pid, rootStarttime, 'SIGSTOP', procRoot)

    const tracked = new Map<number, string | null>()
    for (let pass = 0; pass < 3; pass++) {
      let added = 0
      for (const entry of collectProcDescendantsWithIdentity(pid, procRoot)) {
        if (!tracked.has(entry.pid)) {
          tracked.set(entry.pid, entry.starttime)
          signalIfSameProcess(entry.pid, entry.starttime, 'SIGSTOP', procRoot)
          added += 1
        }
      }
      if (added === 0) break
    }

    const ordered = [...tracked.entries()]
    safeSignal(-pid, signal)
    signalIfSameProcess(pid, rootStarttime, signal, procRoot)
    for (let i = ordered.length - 1; i >= 0; i--) {
      const [descPid, descStart] = ordered[i]!
      signalIfSameProcess(descPid, descStart, signal, procRoot)
    }
    if (signal !== 'SIGKILL') {
      safeSignal(-pid, 'SIGCONT')
      signalIfSameProcess(pid, rootStarttime, 'SIGCONT', procRoot)
      for (let i = ordered.length - 1; i >= 0; i--) {
        const [descPid, descStart] = ordered[i]!
        signalIfSameProcess(descPid, descStart, 'SIGCONT', procRoot)
      }
    }
    return
  }

  // Non-/proc POSIX (e.g. macOS): kill the detached process group immediately and
  // best-effort walk direct children via pgrep with mandatory error handling.
  safeSignal(-pid, signal)
  safeSignal(pid, signal)
  if (signal !== 'SIGKILL') {
    safeSignal(-pid, 'SIGCONT')
    safeSignal(pid, 'SIGCONT')
  }
  try {
    const pgrep = spawn('pgrep', ['-P', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    pgrep.on('error', () => {})
    pgrep.stdout?.on('data', (chunk: Buffer | string) => {
      out += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    pgrep.on('close', () => {
      for (const tok of out.trim().split(/\s+/)) {
        const childPid = Number.parseInt(tok, 10)
        if (Number.isInteger(childPid) && childPid > 1 && childPid !== pid) {
          killProcessTree(childPid, signal, procRoot)
        }
      }
    })
    pgrep.unref()
  } catch {
    // Ignore spawn errors when pgrep is unavailable.
  }
}
