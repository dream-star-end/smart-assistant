import assert from 'node:assert/strict'
import { createServer, get, type IncomingHttpHeaders } from 'node:http'
import { describe, test } from 'node:test'
import { _immutableRecordIdHeaders } from '../server.js'

async function writeHeadRoundTrip(recordId: string): Promise<IncomingHttpHeaders> {
  const server = createServer((_req, res) => {
    res.writeHead(206, {
      'Content-Type': 'application/json',
      ..._immutableRecordIdHeaders(recordId),
    })
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    return await new Promise<IncomingHttpHeaders>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}/payload`, (response) => {
        response.resume()
        response.once('end', () => resolve(response.headers))
      }).once('error', reject)
    })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  }
}

describe('deferred payload immutable record headers', () => {
  test('safe ids preserve the rolling-compatible legacy header', async () => {
    const headers = await writeHeadRoundTrip('record-safe_123')
    assert.equal(headers['x-openclaude-record-id'], 'record-safe_123')
    assert.equal(headers['x-openclaude-record-id-base64url'], undefined)
  })

  test('LF, Unicode, and overlong historical ids survive node:http writeHead', async () => {
    for (const id of ['call-one\nfc-two', '记录-🙂', 'x'.repeat(1025)]) {
      const headers = await writeHeadRoundTrip(id)
      assert.equal(headers['x-openclaude-record-id'], undefined)
      assert.equal(
        headers['x-openclaude-record-id-base64url'],
        Buffer.from(id, 'utf8').toString('base64url'),
      )
    }
  })
})
