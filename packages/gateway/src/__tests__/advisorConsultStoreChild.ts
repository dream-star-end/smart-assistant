import { existsSync } from 'node:fs'

import { AdvisorConsultStore, type AdvisorConsultRecord } from '../advisorConsultStore.js'

const dbPath = process.env.OC_ADVISOR_DB
const barrier = process.env.OC_ADVISOR_BARRIER
const raw = process.env.OC_ADVISOR_RECORD
if (!dbPath || !raw) throw new Error('OC_ADVISOR_DB and OC_ADVISOR_RECORD required')
const record = JSON.parse(raw) as AdvisorConsultRecord
process.stdout.write('ready\n')
if (barrier) {
  const deadline = Date.now() + 10_000
  while (!existsSync(barrier)) {
    if (Date.now() > deadline) throw new Error('insert barrier timeout')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}
const store = new AdvisorConsultStore(dbPath)
try {
  const result = store.insertNew(record)
  process.stdout.write(
    `${JSON.stringify({
      reused: result.reused,
      consultId: result.record.consultId,
      question: result.record.question,
    })}\n`,
  )
} finally {
  store.close()
}
