import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { goCacheTurn, waitGoCacheUsage } from './go-cache-turn.mjs'
import { assessGoCache } from './user-contract-go-cache.mjs'

async function fixture(t, reply) {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const input = JSON.parse(String(raw))
    const send = (meta, extra = {}) => ws.send(JSON.stringify({
      type: 'outbound.message', peer: input.peer, clientMessageId: input.clientMessageId,
      isFinal: true, meta, ...extra,
    }))
    reply(send, ws)
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => server.close(resolve))
  })
  return { base: `http://127.0.0.1:${server.address().port}`, token: 'fixture',
    peer: 'p', cmid: 'c', model: 'm', text: '1', timeout: 2_000 }
}
const committed = { reconcileSource: 'tape_commit', reconcile: 'turn_completed' }

test('content final cannot advance the next turn before a durable success', async (t) => {
  let commit
  let sawContent
  const content = new Promise((resolve) => { sawContent = resolve })
  const args = await fixture(t, (send) => {
    send(undefined)
    commit = () => send(committed)
    sawContent()
  })
  let complete = false
  const result = goCacheTurn(args).then(() => { complete = true })
  await content
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(complete, false)
  commit()
  await result
  assert.equal(complete, true)
})

test('back-to-back content and commit frames are both observed', async (t) => {
  const args = await fixture(t, (send) => { send(undefined); send(committed) })
  await goCacheTurn(args)
})

test('historical third-turn crashed final fails as a turn failure, never missing cache usage', async (t) => {
  const args = await fixture(t, (send) => {
    send(undefined)
    send({ reconcileSource: 'tape_commit', reconcile: 'turn_crashed' })
  })
  await assert.rejects(goCacheTurn(args), /turn committed as turn_crashed/)
})

test('a foreign committed frame cannot complete this turn; missing commit fails closed', async (t) => {
  const args = await fixture(t, (send, ws) => {
    send(committed, { clientMessageId: 'foreign' })
    send(undefined)
    ws.close()
  })
  await assert.rejects(goCacheTurn(args), /before the committed turn/)
})

test('accounting visibility barrier waits for every successful turn without resending', async () => {
  let reads = 0
  const rows = [undefined, { requests: '2' }, {
    requests: '3', input_tokens: '34468', cache_read_tokens: '68194', cache_write_tokens: '0',
  }]
  const row = await waitGoCacheUsage(async () => rows[reads++], 3, { sleep: async () => {} })
  assert.equal(reads, 3)
  assert.equal(assessGoCache(row).ok, true)
  await assert.rejects(waitGoCacheUsage(async () => ({ requests: '2' }), 3,
    { attempts: 2, sleep: async () => {} }), /expected ≥3 billed requests, got 2/)
  assert.equal(assessGoCache({ requests: 3, input_tokens: 69903, cache_read_tokens: 32738 }).ok, false)
})
