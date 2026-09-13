/** Stops only after the real retired manifest directory has been fsynced. */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { ReceiptCandidateLifecycle } from '../../receiptCandidateLifecycle.js'
const [root, partition] = process.argv.slice(2)
if (!root || !partition) throw new Error('root and partition required')
const original = fs.fsyncSync
fs.fsyncSync = fd => {
  original(fd)
  if (fs.readlinkSync(`/proc/self/fd/${fd}`) === join(root, 'namespaces')) {
    fs.writeSync(1, 'RETIRED_SYNCED\n')
    process.kill(process.pid, 'SIGSTOP')
  }
}
syncBuiltinESMExports()
await new ReceiptCandidateLifecycle(root).retire(partition, () => true)
throw new Error('test must kill the stopped retire process before GC')
