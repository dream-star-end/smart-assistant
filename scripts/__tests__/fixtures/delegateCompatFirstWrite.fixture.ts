/** Independent private writer: no child processes, network or production HOME. */
import assert from 'node:assert/strict'
import { DelegateDurableDb } from '../../../packages/gateway/src/delegateDurable.js'
import { DelegateJobStore } from '../../../packages/gateway/src/delegateJobs.js'

const [path, mode] = process.argv.slice(2)
assert.equal(process.env.NODE_ENV, 'test')
assert.ok(path && (mode === 'existing' || mode === 'absent'))
let db: DelegateDurableDb | undefined
if (mode === 'existing') {
  db = new DelegateDurableDb(path)
  assert.equal(db.minimumConsumer, 1)
}
process.once('message', message => {
  try {
    assert.equal(message, 'seal')
    db ??= new DelegateDurableDb(path)
    const store = new DelegateJobStore({ durable: db, sm: true, failureInbox: true })
    assert.equal(db.minimumConsumer, 2)
    assert.equal(store.acceptsNewFailureSources, true)
    assert.equal(db.loadAll().length, 0)
    store.close()
    process.send?.('sealed', () => process.disconnect?.())
  } catch (error) {
    console.error(error)
    db?.close()
    process.exitCode = 1
    process.disconnect?.()
  }
})
process.send?.('ready')
