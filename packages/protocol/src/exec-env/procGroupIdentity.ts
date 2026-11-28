/**
 * OCV5-890 / OCV5-924 — Pure zero-dependency Linux `/proc/<pid>/stat` parser and
 * start-time-fenced process-group identity verifier (L0 contract primitive, no `node:*`).
 *
 * Shared by `@openclaude/storage` (`execEnvProcInspect`) and `@openclaude/gateway`
 * (`processGroupShutdown`) so PGID reuse never causes stale snapshots to signal
 * another turn's process group.
 */

export interface ParsedProcStat {
  state: string
  pgrp: number
  startTimeTicks: number
}

export interface ProcGroupVerifyReader {
  readProcStat: (pid: number) => ParsedProcStat | null
  listProcPids: () => readonly number[]
}

/**
 * Parse Linux `/proc/<pid>/stat` extracting field 3 (`state`), field 5 (`pgrp`), and field 22 (`starttime`).
 */
export function parseProcStatFull(statLine: string): ParsedProcStat | null {
  const rparen = statLine.lastIndexOf(')')
  if (rparen < 0) return null
  const rest = statLine.slice(rparen + 1).trim()
  if (!rest) return null
  const fields = rest.split(/\s+/)
  const state = fields[0]
  const rawPgrp = fields[2]
  const rawTicks = fields[19]
  if (!state || !rawPgrp || !rawTicks) return null
  if (!/^-?\d+$/.test(rawPgrp) || !/^\d+$/.test(rawTicks)) return null
  const pgrp = Number(rawPgrp)
  const startTimeTicks = Number(rawTicks)
  if (!Number.isSafeInteger(pgrp) || !Number.isSafeInteger(startTimeTicks) || startTimeTicks < 0) {
    return null
  }
  return { state, pgrp, startTimeTicks }
}

export function parseProcStatStartTimeTicks(statLine: string): number | null {
  return parseProcStatFull(statLine)?.startTimeTicks ?? null
}

export function isParsedProcAlive(stat: ParsedProcStat | null | undefined): stat is ParsedProcStat {
  return stat != null && stat.state !== 'Z' && stat.state !== 'X' && stat.state !== 'x'
}

/**
 * Verify that `pgid` still belongs to the process group captured at `minStartTicks`:
 * - If leader `pid === pgid` is alive, its `pgrp` must equal `pgid` and `startTimeTicks === minStartTicks`
 *   (immediately rejecting recycled leader PIDs/PGIDs).
 * - Otherwise, at least one alive member in `listProcPids()` must have `pgrp === pgid` and
 *   `startTimeTicks >= minStartTicks`.
 */
export function verifyProcGroupByStartTicks(
  pgid: number,
  minStartTicks: number | null,
  reader: ProcGroupVerifyReader,
): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1 || minStartTicks === null) return false
  const leaderStat = reader.readProcStat(pgid)
  if (isParsedProcAlive(leaderStat)) {
    return leaderStat.pgrp === pgid && leaderStat.startTimeTicks === minStartTicks
  }
  for (const pid of reader.listProcPids()) {
    if (pid === pgid || !Number.isInteger(pid) || pid <= 1) continue
    const stat = reader.readProcStat(pid)
    if (isParsedProcAlive(stat) && stat.pgrp === pgid && stat.startTimeTicks >= minStartTicks) {
      return true
    }
  }
  return false
}
