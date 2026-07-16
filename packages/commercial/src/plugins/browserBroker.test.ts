import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { randomUUID } from 'node:crypto'

import { ManagedBrowserBrokerError, createManagedBrowserTlsBroker } from './browserBroker.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

describe('managed-browser TLS broker', () => {
  test('authenticates one exact pinned destination and removes its socket', async () => {
    const upstream = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen))
    const address = upstream.address()
    assert.ok(address && typeof address === 'object')
    const root = await mkdtemp(join(tmpdir(), 'oc-browser-broker-'))
    roots.push(root)
    const broker = await createManagedBrowserTlsBroker({
      root,
      invocationId: randomUUID(),
      pins: [
        {
          origin: `https://api.example:${address.port}`,
          hostname: 'api.example',
          port: address.port,
          ip: '127.0.0.1',
          family: 4,
        },
      ],
      expectedOwnerUid: process.getuid?.() ?? 0,
      socketUid: process.getuid?.() ?? 0,
      socketGid: process.getgid?.() ?? 0,
    })
    const client = createConnection(broker.mount.hostSocketPath)
    await new Promise<void>((resolveConnect, reject) => {
      client.once('connect', resolveConnect)
      client.once('error', reject)
    })
    client.write(frame({ token: broker.mount.token, host: 'api.example', port: address.port }))
    const chunks: Buffer[] = []
    client.on('data', (chunk) => chunks.push(chunk))
    await new Promise<void>((resolveAck, reject) => {
      const wait = () => {
        if (Buffer.concat(chunks).length >= 1) resolveAck()
        else setTimeout(wait, 5)
      }
      client.once('error', reject)
      wait()
    })
    assert.equal(Buffer.concat(chunks)[0], 0)
    client.write('hello')
    await new Promise<void>((resolveEcho) => {
      const wait = () => {
        if (Buffer.concat(chunks).subarray(1).toString() === 'hello') resolveEcho()
        else setTimeout(wait, 5)
      }
      wait()
    })
    client.destroy()
    await broker.close()
    assert.equal(broker.stats().closed, true)
    assert.equal(
      await import('node:fs/promises').then((fs) =>
        fs.stat(broker.mount.hostDirectory).catch(() => null),
      ),
      null,
    )
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()))
  })

  test('fails closed for a wrong token or destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-browser-broker-'))
    roots.push(root)
    const broker = await createManagedBrowserTlsBroker({
      root,
      invocationId: randomUUID(),
      pins: [
        {
          origin: 'https://api.example:443',
          hostname: 'api.example',
          port: 443,
          ip: '93.184.216.34',
          family: 4,
        },
      ],
      expectedOwnerUid: process.getuid?.() ?? 0,
      socketUid: process.getuid?.() ?? 0,
      socketGid: process.getgid?.() ?? 0,
    })
    for (const auth of [
      { token: 'x'.repeat(43), host: 'api.example', port: 443 },
      { token: broker.mount.token, host: 'evil.example', port: 443 },
    ]) {
      const client = createConnection(broker.mount.hostSocketPath)
      await new Promise<void>((resolveConnect) => client.once('connect', resolveConnect))
      client.write(frame(auth))
      await new Promise<void>((resolveClose) => client.once('close', resolveClose))
    }
    assert.equal(broker.stats().acceptedConnections, 2)
    await broker.close()
  })

  test('rejects a DNS name disguised as a pinned IPv4 address', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-browser-broker-'))
    roots.push(root)
    await assert.rejects(
      createManagedBrowserTlsBroker({
        root,
        invocationId: randomUUID(),
        pins: [
          {
            origin: 'https://api.example:443',
            hostname: 'api.example',
            port: 443,
            ip: 'resolver.example',
            family: 4,
          },
        ],
        expectedOwnerUid: process.getuid?.() ?? 0,
      }),
      (error: unknown) =>
        error instanceof ManagedBrowserBrokerError && error.code === 'INVALID_CONFIG',
    )
  })
})
