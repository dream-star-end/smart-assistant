/**
 * File- and process-level lane ownership metadata for dual-slot concurrent runtimes.
 *
 * Each lane directory (`<view>/<operationId>` and `<root>/lanes/<operationId>`) can record a
 * private `owner.json` (`0o600`) identifying the owning slot, runtime instance, PID and Linux
 * `/proc/<pid>/stat` start ticks. Peer slots inspect this file to avoid deleting live peer lanes
 * during container adoption and to coordinate fail-closed cross-slot session handovers.
 */
import { randomBytes } from 'node:crypto'
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const LANE_OWNER_FILENAME = 'owner.json'

export interface LaneOwnerMetadata {
  version: 1
  slot: string
  instanceId: string
  pid: number
  pidStartTicks: string | null
  sessionKey: string
  operationId: string
  generation: string
  createdAt: number
}

export type ProcessAliveChecker = (pid: number, expectedStartTicks: string | null) => boolean
export type SocketListeningChecker = (sockPath: string) => boolean

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Reads field 22 (`starttime` in clock ticks) from Linux `/proc/<pid>/stat` to guard against
 * PID wrap-around. Returns `null` on non-Linux platforms or if the process does not exist.
 */
export function readProcessStartTicks(pid: number): string | null {
  if (process.platform !== 'linux') return null
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closeParen = raw.lastIndexOf(')')
    if (closeParen === -1) return null
    const rest = raw.slice(closeParen + 1).trimStart()
    if (!rest) return null
    const fields = rest.split(/\s+/)
    // Field 3 (`state`) is index 0 after `)`; field 22 (`starttime`) is index 19.
    const startTicks = fields[19]
    if (!startTicks || !/^\d+$/.test(startTicks)) return null
    return startTicks
  } catch {
    return null
  }
}

/**
 * Checks whether `pid` is currently alive and (when `expectedStartTicks` is non-empty) matches
 * the exact `/proc/<pid>/stat` start ticks so recycled PIDs are never mistaken for live peers.
 */
export function isProcessAliveWithStartTicks(
  pid: number,
  expectedStartTicks: string | null,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'EPERM') return false
  }
  if (expectedStartTicks !== null && expectedStartTicks !== '') {
    const currentTicks = readProcessStartTicks(pid)
    return currentTicks === expectedStartTicks
  }
  return true
}

/**
 * Zero-side-effect AF_UNIX listening probe for legacy lane directories that predate `owner.json`.
 *
 * Returns `false` only when `sockPath` is missing / not a socket or Linux `/proc/net/unix` proves
 * no live listening or connected endpoint owns the path. Fails safe (`true`) when socket liveness
 * cannot be disproved so live legacy lanes are never deleted during dual-slot adoption.
 */
export function isUnixSocketListening(sockPath: string): boolean {
  try {
    const st = lstatSync(sockPath)
    if (!st.isSocket()) return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    return true
  }
  if (process.platform !== 'linux') return true
  let canonicalPath: string | null = null
  try {
    canonicalPath = join(realpathSync(dirname(sockPath)), basename(sockPath))
  } catch {
    canonicalPath = null
  }
  try {
    const raw = readFileSync('/proc/net/unix', 'utf8')
    const lines = raw.split('\n')
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) continue
      const match =
        /^\S+\s+\S+\s+\S+\s+([0-9a-fA-F]+)\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)\s+\d+\s+(.+)$/.exec(line)
      if (!match) continue
      const flags = Number.parseInt(match[1]!, 16)
      const state = match[2]!.toUpperCase()
      const entryPath = match[3]!.trimEnd()
      if (entryPath !== sockPath && (canonicalPath === null || entryPath !== canonicalPath)) {
        continue
      }
      // 0x10000 = SO_ACCEPTCON (listening), state 03 = SS_CONNECTED (active stream endpoint).
      if ((flags & 0x10000) !== 0 || state === '03') {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

/**
 * Atomically writes `<dir>/owner.json` with mode `0o600`, fsyncing both file and directory.
 */
export function writeLaneOwnerFile(dir: string, meta: LaneOwnerMetadata): void {
  const target = join(dir, LANE_OWNER_FILENAME)
  const tmpPath = join(
    dir,
    `.${LANE_OWNER_FILENAME}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`,
  )
  let fd: number | undefined
  try {
    fd = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    fchmodSync(fd, 0o600)
    writeFileSync(fd, JSON.stringify(meta))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, target)
    syncDirectory(dir)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Ignore secondary close error.
      }
    }
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // Ignore secondary cleanup error.
    }
    throw error
  }
}

function isValidLaneOwnerMetadata(value: unknown): value is LaneOwnerMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.version === 1 &&
    typeof record.slot === 'string' &&
    record.slot.length > 0 &&
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    (record.pidStartTicks === null ||
      (typeof record.pidStartTicks === 'string' && record.pidStartTicks.length > 0)) &&
    typeof record.sessionKey === 'string' &&
    record.sessionKey.length > 0 &&
    typeof record.operationId === 'string' &&
    record.operationId.length > 0 &&
    typeof record.generation === 'string' &&
    record.generation.length > 0 &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt)
  )
}

/**
 * Reads and validates `<dir>/owner.json`. Returns `null` if missing, symlinked, or malformed.
 */
export function readLaneOwnerFile(dir: string): LaneOwnerMetadata | null {
  const path = join(dir, LANE_OWNER_FILENAME)
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink()) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isValidLaneOwnerMetadata(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Determines whether `viewEntryDir` is owned by a live peer slot/instance other than
 * `(selfSlot, selfInstanceId)`.
 */
export function isLivePeerOwnedLane(
  viewEntryDir: string,
  selfSlot: string,
  selfInstanceId: string,
  isProcessAlive: ProcessAliveChecker = isProcessAliveWithStartTicks,
): { livePeer: boolean; owner: LaneOwnerMetadata | null } {
  const owner = readLaneOwnerFile(viewEntryDir)
  if (!owner) return { livePeer: false, owner: null }
  if (owner.slot === selfSlot && owner.instanceId === selfInstanceId) {
    return { livePeer: false, owner }
  }
  const alive = isProcessAlive(owner.pid, owner.pidStartTicks)
  return { livePeer: alive, owner }
}
