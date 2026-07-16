import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { type Socket, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
  type CancelableDnsResolver,
  type LocalPluginBrokerActionPolicy,
  LocalPluginBrokerError,
  type LocalPluginBrokerHandle,
  compileLocalPluginBrokerPolicy,
  createLocalPluginBroker,
  verifyLocalPluginBrokerMount,
} from '../plugins/localBroker.js'

const OWNER_UID = process.getuid?.() ?? 0
const OWNER_GID = process.getgid?.() ?? 0
const roots: string[] = []
const handles: LocalPluginBrokerHandle[] = []

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oc-plugin-broker-'))
  roots.push(root)
  return root
}

function rawPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actions: {
      fetch_public: {
        httpRead: {
          origins: ['https://example.com'],
          maxRequests: 8,
          maxConcurrent: 2,
          maxResponseBytes: 4096,
          requestTimeoutMs: 5000,
          ...overrides,
        },
      },
    },
  }
}

function expectCode(code: LocalPluginBrokerError['code']): (error: unknown) => boolean {
  return (error) => error instanceof LocalPluginBrokerError && error.code === code
}

function publicResolver(): CancelableDnsResolver {
  return {
    resolve4: async () => ['8.8.8.8'],
    resolve6: async () => [],
    cancel: () => {},
  }
}

async function makeBroker(
  args: {
    policyOverrides?: Record<string, unknown>
    resolverFactory?: () => CancelableDnsResolver
    fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
  } = {},
): Promise<LocalPluginBrokerHandle> {
  const root = await tempRoot()
  const compiled = compileLocalPluginBrokerPolicy(rawPolicy(args.policyOverrides))
  const policy = compiled.actions.fetch_public
  assert.ok(policy)
  const handle = await createLocalPluginBroker({
    root,
    invocationId: randomUUID(),
    policy,
    expectedOwnerUid: OWNER_UID,
    socketUid: OWNER_UID,
    socketGid: OWNER_GID,
    deps: {
      resolverFactory: args.resolverFactory ?? publicResolver,
      fetchImpl:
        args.fetchImpl ??
        (async () =>
          new Response('ok', {
            status: 200,
            headers: {
              'content-type': 'text/plain',
              etag: 'safe-tag',
              'set-cookie': 'secret=must-not-cross',
            },
          })),
    },
  })
  handles.push(handle)
  return handle
}

interface WireResponse {
  ok: boolean
  response?: {
    status: number
    headers: Record<string, string>
    bodyBase64: string
  }
  error?: { code: LocalPluginBrokerError['code'] }
}

function requestFor(
  handle: LocalPluginBrokerHandle,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    token: handle.mount.token,
    op: 'http.request',
    method: 'GET',
    url: 'https://example.com/public?q=1',
    headers: { accept: 'application/json' },
    ...overrides,
  }
}

async function exchange(
  handle: LocalPluginBrokerHandle,
  request: Record<string, unknown>,
): Promise<WireResponse> {
  return new Promise<WireResponse>((resolveResponse, rejectResponse) => {
    const socket = connect(handle.mount.hostSocketPath)
    let output = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      output += chunk
    })
    socket.once('error', rejectResponse)
    socket.once('end', () => {
      try {
        resolveResponse(JSON.parse(output.trim()) as WireResponse)
      } catch (error) {
        rejectResponse(error)
      }
    })
  })
}

async function connectedSocket(path: string): Promise<Socket> {
  return new Promise<Socket>((resolveSocket, rejectSocket) => {
    const socket = connect(path)
    socket.once('connect', () => resolveSocket(socket))
    socket.once('error', rejectSocket)
  })
}

describe('local Plugin broker policy compiler', () => {
  test('normalizes exact HTTPS origins and enforces action/resource bounds', () => {
    const compiled = compileLocalPluginBrokerPolicy(rawPolicy(), new Set(['fetch_public']))
    assert.deepEqual(compiled.actions.fetch_public?.httpRead.origins, ['https://example.com:443'])
    for (const overrides of [
      { origins: ['http://example.com'] },
      { origins: ['https://example.com/path'] },
      { origins: ['https://example.com', 'https://example.com:443'] },
      { maxRequests: 0 },
      { maxConcurrent: 5 },
      { maxResponseBytes: 1023 },
      { requestTimeoutMs: 30_001 },
      { unexpected: true },
    ]) {
      assert.throws(
        () => compileLocalPluginBrokerPolicy(rawPolicy(overrides)),
        expectCode('INVALID_POLICY'),
      )
    }
    assert.throws(
      () => compileLocalPluginBrokerPolicy(rawPolicy(), new Set(['different_action'])),
      expectCode('INVALID_POLICY'),
    )
  })
})

describe('local Plugin broker wire and outbound policy', () => {
  test('serves one authenticated GET and returns only bounded safe response fields', async () => {
    let seenInput = ''
    const seenInits: Record<string, unknown>[] = []
    const handle = await makeBroker({
      fetchImpl: async (input, init) => {
        seenInput = input
        seenInits.push(init)
        return new Response('public body', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            etag: 'v1',
            'last-modified': 'Wed, 16 Jul 2026 00:00:00 GMT',
            'set-cookie': 'secret=must-not-cross',
            location: 'https://hidden.example/',
          },
        })
      },
    })
    await verifyLocalPluginBrokerMount(handle.mount, {
      expectedOwnerUid: OWNER_UID,
      socketUid: OWNER_UID,
      socketGid: OWNER_GID,
    })
    const response = await exchange(handle, requestFor(handle))
    assert.equal(response.ok, true)
    assert.equal(response.response?.status, 200)
    assert.equal(
      Buffer.from(response.response?.bodyBase64 ?? '', 'base64').toString(),
      'public body',
    )
    assert.deepEqual(response.response?.headers, {
      'content-type': 'text/plain',
      etag: 'v1',
      'last-modified': 'Wed, 16 Jul 2026 00:00:00 GMT',
    })
    assert.equal(seenInput, 'https://example.com/public?q=1')
    const seenInit = seenInits[0]
    assert.ok(seenInit)
    const headers = seenInit?.headers as Record<string, string>
    assert.equal(headers.accept, 'application/json')
    assert.equal(headers['user-agent'], 'OpenClaude-Plugin-Broker/1')
    assert.equal('authorization' in headers, false)
    assert.equal(seenInit.redirect, 'error')
  })

  test('rejects bad token, methods, headers, credentials, fragments and other origins', async () => {
    let fetches = 0
    const handle = await makeBroker({
      fetchImpl: async () => {
        fetches += 1
        return new Response('unexpected')
      },
    })
    const cases: Array<[Record<string, unknown>, LocalPluginBrokerError['code']]> = [
      [requestFor(handle, { token: randomBytes(32).toString('base64url') }), 'UNAUTHORIZED'],
      [requestFor(handle, { method: 'POST' }), 'BAD_REQUEST'],
      [requestFor(handle, { headers: { authorization: 'Bearer secret' } }), 'BAD_REQUEST'],
      [requestFor(handle, { url: 'https://user:pass@example.com/x' }), 'OUTBOUND_BLOCKED'],
      [requestFor(handle, { url: 'https://example.com/x#fragment' }), 'OUTBOUND_BLOCKED'],
      [requestFor(handle, { url: 'https://other.example/x' }), 'OUTBOUND_BLOCKED'],
    ]
    for (const [request, code] of cases) {
      const response = await exchange(handle, request)
      assert.equal(response.ok, false)
      assert.equal(response.error?.code, code)
    }
    assert.equal(fetches, 0)
  })

  test('rejects private/mixed DNS answers before fetch and rejects redirects', async () => {
    let fetches = 0
    const privateHandle = await makeBroker({
      resolverFactory: () => ({
        resolve4: async () => ['8.8.8.8', '10.0.0.1'],
        resolve6: async () => [],
        cancel: () => {},
      }),
      fetchImpl: async () => {
        fetches += 1
        return new Response('unexpected')
      },
    })
    const blocked = await exchange(privateHandle, requestFor(privateHandle))
    assert.equal(blocked.error?.code, 'OUTBOUND_BLOCKED')
    assert.equal(fetches, 0)

    const redirectHandle = await makeBroker({
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
    })
    const redirect = await exchange(redirectHandle, requestFor(redirectHandle))
    assert.equal(redirect.error?.code, 'OUTBOUND_BLOCKED')
  })

  test('caps decoded response bytes and enforces total/concurrent quotas', async () => {
    const oversized = await makeBroker({
      policyOverrides: { maxResponseBytes: 1024 },
      fetchImpl: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.alloc(700, 1))
            controller.enqueue(Buffer.alloc(700, 2))
            controller.close()
          },
        })
        return new Response(body)
      },
    })
    const tooLarge = await exchange(oversized, requestFor(oversized))
    assert.equal(tooLarge.error?.code, 'RESPONSE_LIMIT')

    const once = await makeBroker({ policyOverrides: { maxRequests: 1 } })
    assert.equal((await exchange(once, requestFor(once))).ok, true)
    assert.equal((await exchange(once, requestFor(once))).error?.code, 'QUOTA_EXCEEDED')

    let releaseFetch!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const concurrent = await makeBroker({
      policyOverrides: { maxRequests: 2, maxConcurrent: 1 },
      fetchImpl: async () => {
        markStarted()
        await fetchGate
        return new Response('done')
      },
    })
    const first = exchange(concurrent, requestFor(concurrent))
    await started
    const second = await exchange(concurrent, requestFor(concurrent))
    assert.equal(second.error?.code, 'QUOTA_EXCEEDED')
    releaseFetch()
    assert.equal((await first).ok, true)
  })
})

describe('local Plugin broker lifecycle', () => {
  test('timeout cancels an in-flight resolver', async () => {
    let rejectDns!: (error: Error) => void
    let markStarted!: () => void
    let cancellations = 0
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const handle = await makeBroker({
      policyOverrides: { requestTimeoutMs: 1000 },
      resolverFactory: () => ({
        resolve4: async () =>
          new Promise<string[]>((_resolve, reject) => {
            rejectDns = reject
            markStarted()
          }),
        resolve6: async () => [],
        cancel: () => {
          cancellations += 1
          rejectDns(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }))
        },
      }),
    })
    const pending = exchange(handle, requestFor(handle))
    await started
    const response = await pending
    assert.equal(response.error?.code, 'TIMEOUT')
    assert.equal(cancellations, 1)
  })

  test('close aborts work, destroys incomplete clients, waits for handlers and removes mount', async () => {
    let rejectDns!: (error: Error) => void
    let markStarted!: () => void
    let cancellations = 0
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const handle = await makeBroker({
      resolverFactory: () => ({
        resolve4: async () =>
          new Promise<string[]>((_resolve, reject) => {
            rejectDns = reject
            markStarted()
          }),
        resolve6: async () => [],
        cancel: () => {
          cancellations += 1
          rejectDns(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }))
        },
      }),
    })
    const active = await connectedSocket(handle.mount.hostSocketPath)
    active.on('error', () => {})
    active.write(`${JSON.stringify(requestFor(handle))}\n`)
    await started
    const incomplete = await connectedSocket(handle.mount.hostSocketPath)
    incomplete.on('error', () => {})
    incomplete.write('{"version":1')

    await handle.close()
    assert.equal(cancellations, 1)
    assert.equal(active.destroyed, true)
    assert.equal(incomplete.destroyed, true)
    assert.deepEqual(handle.stats(), {
      acceptedConnections: 2,
      openConnections: 0,
      activeHandlers: 0,
      activeRequests: 0,
      requestsStarted: 1,
      closing: true,
      closed: true,
    })
    assert.equal(await lstat(handle.mount.hostDirectory).catch(() => null), null)
    assert.deepEqual(await readdir(handle.mount.brokerRoot), [])
    await handle.close()
  })

  test('mount verifier fails closed after the socket mode changes', async () => {
    const handle = await makeBroker()
    await chmod(handle.mount.hostSocketPath, 0o666)
    await assert.rejects(
      verifyLocalPluginBrokerMount(handle.mount, {
        expectedOwnerUid: OWNER_UID,
        socketUid: OWNER_UID,
        socketGid: OWNER_GID,
      }),
      expectCode('INVALID_POLICY'),
    )
    await chmod(handle.mount.hostSocketPath, 0o600)
  })
})
