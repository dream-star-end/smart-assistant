/**
 * Async Linux process candidate discovery (`ps` pre-filter + `/proc` fallback)
 * and bounded `/proc/<pid>/{stat,cmdline,environ}` reader for CLI process-group teardown.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isParsedProcAlive, parseProcStatFull } from '@openclaude/protocol'

const execFileAsync = promisify(execFile)

export interface ParsedProcStat {
  readonly pid: number
  readonly comm: string
  readonly ppid: number
  readonly pgid: number
}

interface PsRow {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly etimes: number
}

/**
 * Parse Linux `/proc/<pid>/stat`, safely handling comm names that contain spaces
 * or `)` by locating the LAST `)` before splitting state/ppid/pgrp.
 */
export function parseProcStat(pid: number, raw: string | null | undefined): ParsedProcStat | null {
  if (!raw) return null
  const lparen = raw.indexOf('(')
  const rparen = raw.lastIndexOf(')')
  if (lparen < 0 || rparen <= lparen) return null
  const comm = raw.slice(lparen + 1, rparen)
  const rest = raw.slice(rparen + 1).trim().split(/\s+/)
  if (rest.length < 3) return null
  const ppid = Number.parseInt(rest[1]!, 10)
  const pgid = Number.parseInt(rest[2]!, 10)
  if (!Number.isFinite(ppid) || ppid < 0 || !Number.isFinite(pgid) || pgid <= 0) return null
  return { pid, comm, ppid, pgid }
}

export function parseNumericProcEntry(entry: string): number | null {
  if (!/^\d+$/.test(entry)) return null
  const pid = Number.parseInt(entry, 10)
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null
}

function parsePsOutputRows(stdout: string): { rows: Map<number, PsRow>; childrenByPpid: Map<number, number[]> } {
  const rows = new Map<number, PsRow>()
  const childrenByPpid = new Map<number, number[]>()
  for (const rawLine of stdout.split('\n')) {
    const parts = rawLine.trim().split(/\s+/)
    if (parts.length < 4) continue
    const pid = Number.parseInt(parts[0]!, 10)
    const ppid = Number.parseInt(parts[1]!, 10)
    const pgid = Number.parseInt(parts[2]!, 10)
    const etimes = Number.parseInt(parts[3]!, 10)
    if (pid <= 1 || pid === 2 || ppid === 2 || pgid <= 0 || !Number.isFinite(etimes)) continue
    rows.set(pid, { pid, ppid, pgid, etimes })
    const list = childrenByPpid.get(ppid)
    if (list) list.push(pid)
    else childrenByPpid.set(ppid, [pid])
  }
  return { rows, childrenByPpid }
}

function selectCandidatePidsFromPsOutput(
  stdout: string,
  selfPid: number,
  trackedPgids?: ReadonlySet<number>,
): number[] | null {
  const { rows, childrenByPpid } = parsePsOutputRows(stdout)
  const selfRow = rows.get(selfPid)
  if (!selfRow) return null
  const maxTurnEtimes = selfRow.etimes + 5
  const selected = new Set<number>([selfPid])
  const queue: number[] = []
  for (const row of rows.values()) {
    if (row.etimes <= maxTurnEtimes || trackedPgids?.has(row.pgid) || trackedPgids?.has(row.pid)) {
      selected.add(row.pid)
      if (rows.has(row.ppid)) selected.add(row.ppid)
      queue.push(row.pid)
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    for (const childPid of childrenByPpid.get(queue[i]!) ?? []) {
      if (!selected.has(childPid)) {
        selected.add(childPid)
        queue.push(childPid)
      }
    }
  }
  return [...selected]
}

async function discoverCandidateProcPidsAsync(
  trackedPgids?: ReadonlySet<number>,
): Promise<{ entries: string[]; candidatePids: number[]; scanDegraded: boolean }> {
  try {
    const { stdout } = await execFileAsync('ps', ['-e', '-o', 'pid=,ppid=,pgid=,etimes='], {
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const selected = selectCandidatePidsFromPsOutput(stdout, process.pid, trackedPgids)
    if (selected && selected.length > 0) {
      return { entries: selected.map(String), candidatePids: selected, scanDegraded: false }
    }
  } catch (err) {
    void err
  }
  let dirReadFailed = false
  const entries = await readdir('/proc').catch(() => {
    dirReadFailed = true
    return [] as string[]
  })
  const candidatePids = entries
    .map(parseNumericProcEntry)
    .filter((pid): pid is number => pid !== null && pid !== 2)
  return { entries, candidatePids, scanDegraded: dirReadFailed }
}

function isMissingProcError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ESRCH'
}

function mayBeMcpLauncherComm(comm: string): boolean {
  const commLower = comm.trim().toLowerCase()
  return (
    commLower.includes('oc-') ||
    commLower.includes('mcp') ||
    commLower.includes('node') ||
    commLower === 'tsx' ||
    commLower === 'sh' ||
    commLower === 'bash'
  )
}

async function readSingleCandidateProcAsync(
  pid: number,
  needEnviron: boolean,
  statTexts: Map<number, string>,
  cmdlineTexts: Map<number, string>,
  environTexts: Map<number, string>,
  unreadablePids: Set<number>,
): Promise<void> {
  let statRaw: string | null = null
  try {
    statRaw = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (err) {
    if (!isMissingProcError(err)) unreadablePids.add(pid)
    return
  }
  const parsed = parseProcStat(pid, statRaw)
  const verified = parseProcStatFull(statRaw)
  if (!parsed || !verified) {
    unreadablePids.add(pid)
    return
  }
  if (parsed.pid === 2 || parsed.ppid === 2 || !isParsedProcAlive(verified)) return
  statTexts.set(pid, statRaw)
  if (mayBeMcpLauncherComm(parsed.comm)) {
    const cmdRaw = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null)
    if (cmdRaw !== null) cmdlineTexts.set(pid, cmdRaw)
  }
  if (needEnviron) {
    const envRaw = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null)
    if (envRaw !== null) environTexts.set(pid, envRaw)
  }
}

export function collectTrackedPgids(
  rootPid: number | undefined,
  snapshot: { readonly rootPid: number; readonly descendantPgids: readonly number[] } | null | undefined,
): Set<number> {
  const tracked = new Set<number>()
  if (typeof rootPid === 'number' && rootPid > 1) tracked.add(rootPid)
  if (snapshot) {
    if (snapshot.rootPid > 1) tracked.add(snapshot.rootPid)
    for (const pgid of snapshot.descendantPgids) {
      if (pgid > 1) tracked.add(pgid)
    }
  }
  return tracked
}

export async function readLinuxProcFilesAsync(
  needEnviron: boolean,
  trackedPgids?: ReadonlySet<number>,
): Promise<{
  entries: string[]
  statTexts: Map<number, string>
  cmdlineTexts: Map<number, string>
  environTexts: Map<number, string>
  unreadablePids: Set<number>
  scanDegraded: boolean
}> {
  const { entries, candidatePids, scanDegraded } = await discoverCandidateProcPidsAsync(trackedPgids)
  const statTexts = new Map<number, string>()
  const cmdlineTexts = new Map<number, string>()
  const environTexts = new Map<number, string>()
  const unreadablePids = new Set<number>()
  if (candidatePids.length === 0) {
    return { entries, statTexts, cmdlineTexts, environTexts, unreadablePids, scanDegraded }
  }
  let cursor = 0
  const workerCount = Math.min(32, candidatePids.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < candidatePids.length) {
        const pid = candidatePids[cursor]!
        cursor += 1
        await readSingleCandidateProcAsync(
          pid,
          needEnviron,
          statTexts,
          cmdlineTexts,
          environTexts,
          unreadablePids,
        )
      }
    }),
  )
  return { entries, statTexts, cmdlineTexts, environTexts, unreadablePids, scanDegraded }
}
