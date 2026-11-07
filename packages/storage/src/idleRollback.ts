/** Append-only native transcripts retain the original chain. A durable tombstone
 * excludes only an abandoned idle operation's synthetic rows on every resume.
 * Written only after runner shutdown + authoritative quiescence, before op settlement. */
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, openSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class IdleRecoveryCorrupt extends Error {
  constructor() { super('IDLE_RECOVERY_CORRUPT') }
}
export interface IdleRollback {
  v: 1
  sessionId: string
  opId: string
  restoreTip: string
}
function folder(home: string, sessionId: string): string {
  return join(home, 'idle-abandoned', encodeURIComponent(sessionId))
}
export function idleSyntheticUuid(opId: string, role: string): string {
  const h = createHash('sha256').update(`${opId}:${role}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export function readIdleRollbacks(home: string, sessionId: string): IdleRollback[] {
  let names: string[]
  try { names = readdirSync(folder(home, sessionId)) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new IdleRecoveryCorrupt() }
  return names.filter(n => n.endsWith('.json')).map(name => {
    try {
      const r = JSON.parse(readFileSync(join(folder(home, sessionId), name), 'utf8')) as IdleRollback
      if (r.v !== 1 || r.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(r.opId)
        || name !== r.opId + '.json' || typeof r.restoreTip !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.restoreTip)) throw new IdleRecoveryCorrupt()
      return r
    } catch { throw new IdleRecoveryCorrupt() }
  })
}
export function writeIdleRollback(home: string, rollback: IdleRollback): void {
  const dir = folder(home, rollback.sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, rollback.opId + '.json')
  const tmp = path + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(rollback), { mode: 0o600 })
  const file = openSync(tmp, 'r')
  try { fsyncSync(file) } finally { closeSync(file) }
  renameSync(tmp, path)
  const directory = openSync(dir, 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
  readIdleRollbacks(home, rollback.sessionId) // fail closed before caller settles the op
}
/** Called BEFORE compact pruning/relinks; never rewrites the JSONL or integrity receipt. */
export function filterAbandonedIdleRows(bytes: Buffer, rollbacks: readonly IdleRollback[]): Buffer {
  if (!rollbacks.length) return bytes
  const removed = new Map<string, string>()
  for (const r of rollbacks) for (const role of ['boundary', 'summary', 'resume-leaf'])
    removed.set(idleSyntheticUuid(r.opId, role), r.restoreTip)
  const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) as Record<string, unknown> } catch { throw new IdleRecoveryCorrupt() }
  })
  const ids = new Set(rows.map(r => r.uuid))
  for (const r of rollbacks) if (!ids.has(r.restoreTip) || removed.has(r.restoreTip))
    throw new IdleRecoveryCorrupt()
  return Buffer.from(rows.filter(r => !removed.has(String(r.uuid))).map(r => {
    const tip = removed.get(String(r.parentUuid))
    return JSON.stringify(tip ? { ...r, parentUuid: tip } : r)
  }).join('\n') + '\n')
}
