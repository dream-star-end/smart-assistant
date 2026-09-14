/** Private IPC worker: real original v4 prepared statements, no network or SDK. */
import { existsSync } from 'node:fs'
import { isAbsolute, dirname, join } from 'node:path'
import { DelegateDurableDb as LegacyV4 } from './delegateLegacyV4.fixture.js'
import { DelegateDurableDb, type DurableJobRecord } from '../../delegateDurable.js'
import { DelegateJobStore } from '../../delegateJobs.js'

const [role, path] = process.argv.slice(2)
if (!process.send || !path || !isAbsolute(path) || !['legacy', 'modern'].includes(role!)) {
  throw new Error('private profile worker requires IPC, role and absolute DB path')
}
const record = (id: string): DurableJobRecord => ({ id, agentId: 'child', state: 'queued', kind: 'delegate',
  generation: 0, attemptNo: 0, fencingEpoch: 0, checkpointKind: 'none', callback: 'none',
  callbackState: 'none', callbackEpoch: 0, createdAt: 1, updatedAt: 1, lastActivityAt: 1 })
const legacy = role === 'legacy' ? new LegacyV4(path) : undefined
const modern = role === 'modern' ? new DelegateDurableDb(path) : undefined
const watchdog = setTimeout(() => { console.error('private profile worker watchdog'); process.exit(2) }, 20000)
process.send({ event: 'ready', pid: process.pid, role })
process.on('message', (message: { id: number; command: string; job?: string }) => {
  try {
    let result: unknown
    switch (message.command) {
      case 'write':
        if (!legacy || !message.job) throw new Error('legacy writer required')
        legacy.upsert(record(message.job)); result = legacy.get(message.job); break
      case 'fresh-write': {
        if (!message.job) throw new Error('job required')
        const reopened = new LegacyV4(path)
        try { reopened.upsert(record(message.job)); result = reopened.get(message.job) }
        finally { reopened.close() }
        break
      }
      case 'hold-write': {
        if (!legacy || !message.job) throw new Error('legacy writer required')
        const job = message.job, release = join(dirname(path), 'release-writer')
        if (existsSync(release)) throw new Error('release must not preexist')
        legacy.transaction(() => {
          legacy.upsert(record(job)) // Actual write obtains SQLite RESERVED lock.
          process.send!({ event: 'holding', id: message.id })
          const deadline = Date.now() + 10000, wait = new Int32Array(new SharedArrayBuffer(4))
          while (!existsSync(release)) {
            if (Date.now() >= deadline) throw new Error('private writer release timeout')
            Atomics.wait(wait, 0, 0, 10)
          }
        })
        result = legacy.get(job); break
      }
      case 'seal': {
        if (!modern) throw new Error('modern writer required')
        process.send!({ event: 'sealing', id: message.id })
        const store = new DelegateJobStore({ durable: modern, sm: true, deliveryReceipts: true })
        result = { floor: modern.minimumConsumer, admits: store.acceptsDeliveryReceipts }; break
      }
      case 'close':
        legacy?.close(); modern?.close(); clearTimeout(watchdog)
        process.send!({ id: message.id, ok: true }, () => process.disconnect()); return
      default: throw new Error('unknown private command')
    }
    process.send!({ id: message.id, ok: true, result })
  } catch (error) { process.send!({ id: message.id, ok: false, error: String(error) }) }
})
