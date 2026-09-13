import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { ReceiptCandidateLifecycle } from '../../receiptCandidateLifecycle.js'

const store = new ReceiptCandidateLifecycle(process.argv[2]!)
await store.withActive(process.argv[3]!, async namespace => {
  process.stdout.write('WRITER_LOCKED\n')
  await new Promise<void>(resolve => { process.stdin.once('data', () => resolve()); process.stdin.resume() })
  const fd = openSync(join(namespace, 'cache', 'candidate'), 'wx', 0o600)
  try { writeSync(fd, 'candidate'); fsyncSync(fd) } finally { closeSync(fd) }
  process.stdout.write('WRITER_PUBLISHED\n')
})
process.stdin.pause()
