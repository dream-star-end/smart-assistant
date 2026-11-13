/** Process-incarnation evidence for recovery; no signal is sent to any process. */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureSystemActionDirectory, fsyncSystemActionDirectory } from './privateState.js'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export interface SystemActionExecutorIdentity { version: 1; id: string; pid: number; startTicks: string; bootId: string }
export type ExecutorObservation = 'gone' | 'live' | 'unknown'
function startTicks(stat: string): string | null {
  const end = stat.lastIndexOf(')')
  if (end < 2) return null
  const fields = stat.slice(end + 1).trim().split(/\s+/)
  const ticks = fields[19]
  return ticks && /^[1-9][0-9]*$/.test(ticks) ? ticks : null
}
function bootId(): string | null {
  try { const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); return UUID.test(id) ? id : null } catch { return null }
}
function parse(raw: unknown): SystemActionExecutorIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  return Object.keys(v).sort().join(',') === 'bootId,id,pid,startTicks,version' && v.version === 1 && typeof v.id === 'string' && UUID.test(v.id) &&
    typeof v.pid === 'number' && Number.isSafeInteger(v.pid) && v.pid > 0 && typeof v.startTicks === 'string' && /^[1-9][0-9]*$/.test(v.startTicks) && typeof v.bootId === 'string' && UUID.test(v.bootId)
    ? v as unknown as SystemActionExecutorIdentity : null
}
export function currentSystemActionExecutor(): SystemActionExecutorIdentity {
  const currentBoot = bootId()
  const ticks = startTicks(readFileSync(`/proc/${process.pid}/stat`, 'utf8'))
  if (!currentBoot || !ticks) throw new Error('Cannot verify system action executor identity')
  return { version: 1, id: randomUUID(), pid: process.pid, startTicks: ticks, bootId: currentBoot }
}
export function persistSystemActionExecutor(root: string, identity: SystemActionExecutorIdentity): void {
  if (!parse(identity)) throw new Error('Invalid system action executor identity')
  const directory = join(root, 'executors')
  ensureSystemActionDirectory(directory)
  const fd = openSync(join(directory, `${identity.id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(identity)); fsyncSync(fd) } finally { closeSync(fd) }
  fsyncSystemActionDirectory(directory)
}
export function observeSystemActionExecutor(identity: SystemActionExecutorIdentity): ExecutorObservation {
  const currentBoot = bootId()
  if (!currentBoot) return 'unknown'
  if (currentBoot !== identity.bootId) return 'gone'
  try {
    const ticks = startTicks(readFileSync(`/proc/${identity.pid}/stat`, 'utf8'))
    return !ticks ? 'unknown' : ticks === identity.startTicks ? 'live' : 'gone'
  } catch (e) { return e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT' ? 'gone' : 'unknown' }
}
/** Caller supplies the private ledger and invokes this only while it is open. Unknown witnesses retain the executing fence. */
export function recoverStoppedSystemActionExecutors(root: string, currentId: string, markLost: (id: string) => number,
  observe: (identity: SystemActionExecutorIdentity) => ExecutorObservation = observeSystemActionExecutor,
): { recovered: number; unresolved: number } {
  if (!UUID.test(currentId)) throw new Error('Invalid current system action executor')
  const directory = join(root, 'executors')
  ensureSystemActionDirectory(directory)
  let recovered = 0
  let unresolved = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !UUID.test(entry.name.slice(0, -5)) || entry.name === `${currentId}.json`) continue
    let identity: SystemActionExecutorIdentity | null = null
    try {
      const fd = openSync(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 4096) { unresolved++; continue }
        identity = parse(JSON.parse(readFileSync(fd, 'utf8')))
      } finally { closeSync(fd) }
    } catch { unresolved++; continue }
    if (!identity || entry.name !== `${identity.id}.json`) { unresolved++; continue }
    const state = observe(identity)
    if (state === 'gone') recovered += markLost(identity.id)
    else unresolved++
  }
  return { recovered, unresolved }
}
