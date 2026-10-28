import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openSystemActionsRuntime } from '../system-assistant/runtime.js'
import { SystemOperationRegistry } from '../system-assistant/operations.js'
import { readSystemActionBody } from '../system-assistant/httpLifetime.js'
async function slowBody(t: import('node:test').TestContext, deadlineMs: number) {
  const runtime = openSystemActionsRuntime({ stateParent: mkdtempSync(join(tmpdir(), 'oc-system-slow-body-')), registry: new SystemOperationRegistry([]),
    jwtSecret: 'synthetic-only', firstPartyOrigin: 'https://synthetic.example', runner: { async query() { throw new Error('no database in body proof') } } })
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  let finished!: () => void
  const settled = new Promise<void>(resolve => { finished = resolve })
  let rejected = false
  const server = createServer((req, res) => {
    void runtime.track(async signal => { entered(); await readSystemActionBody(req, 16384, signal, deadlineMs) })
      .catch(() => { rejected = true })
      .finally(() => { res.destroy(); finished() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const client = request({ hostname: '127.0.0.1', port: address.port, path: '/', method: 'POST' })
  client.on('error', () => {})
  client.write('{') // Deliberately never end this actual chunked HTTP request.
  t.after(async () => { client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.closeAndDrain() })
  await reading
  return { runtime, settled, rejected: () => rejected }
}
// Harness margin for runtime open and real socket teardown. The injected
// deadline and the rejection / admission assertions are unchanged.
test('closing admission aborts an incomplete real HTTP body and drains without closing live business resources early', { timeout: 10000 }, async t => {
  const f = await slowBody(t, 60000)
  await f.runtime.closeAndDrain()
  await f.settled
  assert.equal(f.rejected(), true)
})
test('an incomplete HTTP body has a finite total read deadline while admission remains open', { timeout: 10000 }, async t => {
  const f = await slowBody(t, 30)
  await f.settled
  assert.equal(f.rejected(), true)
  assert.equal(await f.runtime.track(async () => 'still open'), 'still open')
})
