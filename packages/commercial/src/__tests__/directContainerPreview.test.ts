import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  createServer,
  request as httpRequest,
} from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, describe, it } from 'node:test'

import {
  type DirectContainerPreviewDeps,
  type DirectContainerPreviewService,
  type QuickTunnelLease,
  createDirectContainerPreviewService,
  createSameSitePreviewHostLease,
} from '../ws/directContainerPreview.js'

const services: DirectContainerPreviewService[] = []

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.shutdown()))
})

describe('native direct container preview authorization', () => {
  it('uses a random same-site host without launching cloudflared and claims only its reserved namespace', async () => {
    let tunnelLaunches = 0
    const service = makeService(
      async () => {
        tunnelLaunches++
        throw new Error('same-site mode must not launch cloudflared')
      },
      { previewHostnameSuffix: 'claudeai.chat' },
    )
    const issued = await service.issue(6n, 'http://127.0.0.1:5173/app?q=1', undefined)
    assert.ok(issued)
    const publicUrl = new URL(issued.url)
    assert.match(publicUrl.hostname, /^ocp-[0-9a-f]{32}\.claudeai\.chat$/)
    assert.equal(tunnelLaunches, 0)

    const server = createServer((req, res) => {
      void service.handleHttp(req, res).then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 418
          res.end()
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const bootstrap = await request(port, publicUrl.pathname + publicUrl.search, {
        Host: `${publicUrl.hostname.toUpperCase()}.:443`,
      })
      assert.equal(bootstrap.status, 302)
      assert.match(String(bootstrap.headers['set-cookie']?.[0]), /SameSite=None; Partitioned/)

      const malformed = await request(port, '/', { Host: 'ocp-short.claudeai.chat' })
      assert.equal(malformed.status, 400)
      const unknown = await request(port, '/', {
        Host: `ocp-${'f'.repeat(32)}.claudeai.chat:443`,
      })
      assert.equal(unknown.status, 404)
      const root = await request(port, '/', { Host: 'claudeai.chat' })
      assert.equal(root.status, 418)
      const ordinary = await request(port, '/', { Host: 'status.claudeai.chat' })
      assert.equal(ordinary.status, 418)
      const deeper = await request(port, '/', {
        Host: `ocp-${'e'.repeat(32)}.nested.claudeai.chat`,
      })
      assert.equal(deeper.status, 418)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('strictly validates the same-site suffix and its relationship to the HTTPS parent', () => {
    const invalid: Array<
      Pick<DirectContainerPreviewDeps, 'parentOrigin' | 'previewHostnameSuffix'>
    > = [
      { parentOrigin: 'http://claudeai.chat', previewHostnameSuffix: 'claudeai.chat' },
      { parentOrigin: 'https://claudeai.chat', previewHostnameSuffix: 'CLAUDEAI.CHAT' },
      { parentOrigin: 'https://claudeai.chat', previewHostnameSuffix: '*.claudeai.chat' },
      { parentOrigin: 'https://claudeai.chat', previewHostnameSuffix: 'claudeai.chat.' },
      { parentOrigin: 'https://claudeai.chat', previewHostnameSuffix: '127.0.0.1' },
      { parentOrigin: 'https://claudeai.chat', previewHostnameSuffix: 'example.com' },
    ]
    for (const options of invalid) {
      assert.throws(() =>
        makeService(async () => fakeTunnel('unused.trycloudflare.com').lease, options),
      )
    }
  })

  it('same-site leases close idempotently and resolve their exit exactly once', async () => {
    const lease = createSameSitePreviewHostLease('claudeai.chat')
    assert.match(lease.hostname, /^ocp-[0-9a-f]{32}\.claudeai\.chat$/)
    let exits = 0
    void lease.exited.then(() => exits++)
    await Promise.all([lease.close(), lease.close(), lease.close()])
    await lease.exited
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(exits, 1)
  })

  it('consumes bootstrap once, requires one reserved cookie, and serves platform bridge first', async () => {
    const tunnel = fakeTunnel('alpha-preview.trycloudflare.com')
    const service = makeService(async () => tunnel.lease)
    const issued = await service.issue(7n, 'http://127.0.0.1:5173/app?q=1', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      isMobile: false,
    })
    assert.ok(issued)
    const publicUrl = new URL(issued.url)
    assert.equal(publicUrl.hostname, 'alpha-preview.trycloudflare.com')

    const server = createServer((req, res) => {
      void service.handleHttp(req, res).then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 418
          res.end()
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const bootstrap = await request(port, publicUrl.pathname + publicUrl.search, {
        Host: `${publicUrl.hostname.toUpperCase()}.:443`,
      })
      assert.equal(bootstrap.status, 302)
      assert.equal(bootstrap.headers.location, '/app?q=1')
      assert.match(String(bootstrap.headers['set-cookie']?.[0]), /SameSite=None; Partitioned/)
      assert.equal(bootstrap.headers['cache-control'], 'no-store')
      const cookie = String(bootstrap.headers['set-cookie']?.[0]).split(';', 1)[0]!

      const replay = await request(port, publicUrl.pathname + publicUrl.search, {
        Host: publicUrl.hostname,
      })
      assert.equal(replay.status, 401)

      const bridge = await request(port, '/__oc_preview_bridge.js', {
        Host: publicUrl.hostname,
        Cookie: cookie,
      })
      assert.equal(bridge.status, 200)
      assert.match(bridge.body, /oc-direct-preview-v1/)
      assert.match(bridge.body, /https:\/\/claudeai\.chat/)
      assert.doesNotThrow(
        () => new Function(bridge.body),
        'injected bridge must be valid JavaScript',
      )

      const wrongMethod = await request(
        port,
        publicUrl.pathname + publicUrl.search,
        { Host: publicUrl.hostname },
        'POST',
      )
      assert.equal(wrongMethod.status, 405)

      const duplicate = await request(port, '/__oc_preview_bridge.js', {
        Host: publicUrl.hostname,
        Cookie: `${cookie}; ${cookie}`,
      })
      assert.equal(duplicate.status, 401)

      const worker = await request(port, '/worker.js', {
        Host: publicUrl.hostname,
        Cookie: cookie,
        'Sec-Fetch-Dest': 'serviceworker',
      })
      assert.equal(worker.status, 403)

      const malformedPreviewHost = await request(port, '/', {
        Host: `${publicUrl.hostname}:bogus`,
      })
      assert.equal(malformedPreviewHost.status, 400)
      const unknownPreviewHost = await request(port, '/', {
        Host: 'unknown-preview.trycloudflare.com:443',
      })
      assert.equal(unknownPreviewHost.status, 404)
      const ordinaryHost = await request(port, '/', { Host: 'claudeai.chat' })
      assert.equal(ordinaryHost.status, 418, 'ordinary application hosts must still fall through')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('heartbeats are owner-authenticated and revoke closes the dedicated tunnel', async () => {
    const first = fakeTunnel('first-preview.trycloudflare.com')
    const second = fakeTunnel('second-preview.trycloudflare.com')
    const queue = [first.lease, second.lease]
    const service = makeService(async () => queue.shift()!)
    const one = await service.issue(9n, 'http://localhost:3000/', undefined)
    assert.ok(one)
    assert.equal(service.activeCount(), 1)
    assert.equal(service.heartbeat(10n, one.sessionId), false)
    assert.equal(service.heartbeat(9n, one.sessionId), true)

    const two = await service.issue(9n, 'http://localhost:3001/', undefined)
    assert.ok(two)
    assert.equal(first.closed(), true, 'same-user replacement must kill the prior tunnel')
    assert.equal(service.activeCount(), 1)
    assert.equal(await service.revoke(10n, two.sessionId), false)
    assert.equal(await service.revoke(9n, two.sessionId), true)
    assert.equal(second.closed(), true)
    assert.equal(service.activeCount(), 0)
  })

  it('passes the current B-slot loopback origin to every Quick Tunnel launch', async () => {
    const tunnel = fakeTunnel('slot-b-preview.trycloudflare.com')
    let launchedOrigin = ''
    const service = makeService(
      async (originUrl) => {
        launchedOrigin = originUrl
        return tunnel.lease
      },
      { tunnelOrigin: 'http://127.0.0.1:18795' },
    )

    const issued = await service.issue(24n, 'http://localhost:3000/', undefined)
    assert.ok(issued)
    assert.equal(launchedOrigin, 'http://127.0.0.1:18795')
  })

  it('bounds pending-plus-active WebSockets per session and globally, then releases slots', async () => {
    const first = fakeTunnel('ws-one-preview.trycloudflare.com')
    const second = fakeTunnel('ws-two-preview.trycloudflare.com')
    const queue = [first.lease, second.lease]
    const never = new Promise<never>(() => {})
    const service = makeService(async () => queue.shift()!, {
      maxWebSocketsPerSession: 2,
      maxWebSocketsGlobal: 3,
      resolveContainerEndpoint: async () => await never,
    })
    const one = await service.issue(25n, 'http://localhost:3000/', undefined)
    const two = await service.issue(26n, 'http://localhost:3001/', undefined)
    assert.ok(one)
    assert.ok(two)
    const authOne = await bootstrap(service, one.url)
    const authTwo = await bootstrap(service, two.url)

    const malformedAuthority = upgrade(service, `${authOne.hostname}:bogus`, authOne.cookie)
    assert.equal(malformedAuthority.destroyed, true)
    const a1 = upgrade(service, `${authOne.hostname.toUpperCase()}.:443`, authOne.cookie)
    const a2 = upgrade(service, authOne.hostname, authOne.cookie)
    assert.equal(a1.destroyed, false)
    assert.equal(a2.destroyed, false)
    const perSessionExcess = upgrade(service, authOne.hostname, authOne.cookie)
    assert.equal(perSessionExcess.destroyed, true)

    const b1 = upgrade(service, authTwo.hostname, authTwo.cookie)
    assert.equal(b1.destroyed, false)
    const globalExcess = upgrade(service, authTwo.hostname, authTwo.cookie)
    assert.equal(globalExcess.destroyed, true)

    const a1Closed = once(a1, 'close')
    a1.destroy()
    await a1Closed
    const recovered = upgrade(service, authTwo.hostname, authTwo.cookie)
    assert.equal(recovered.destroyed, false, 'closing a socket must immediately release its slot')
  })

  it('revokes a session when its one-off tunnel exits and never leases an already-dead host', async () => {
    const crashed = fakeTunnel('crashed-preview.trycloudflare.com')
    const service = makeService(async () => crashed.lease)
    const issued = await service.issue(12n, 'http://localhost:3000/', undefined)
    assert.ok(issued)
    crashed.crash()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(service.activeCount(), 0)

    let closed = false
    const dead: QuickTunnelLease = {
      hostname: 'dead-preview.trycloudflare.com',
      exited: Promise.resolve(),
      async close() {
        closed = true
      },
    }
    const second = makeService(async () => dead)
    assert.equal(await second.issue(13n, 'http://localhost:3000/', undefined), null)
    assert.equal(closed, false, 'an already-exited lease is absent rather than double-closed')
  })

  it('bounds cold tunnel acquisition and closes a lease that arrives after fallback', async () => {
    const late = fakeTunnel('late-preview.trycloudflare.com')
    let resolveLaunch!: (lease: QuickTunnelLease) => void
    const service = makeService(
      () =>
        new Promise((resolve) => {
          resolveLaunch = resolve
        }),
      { tunnelAcquireTimeoutMs: 5 },
    )

    const startedAt = Date.now()
    assert.equal(await service.issue(21n, 'http://localhost:3000/', undefined), null)
    assert.ok(
      Date.now() - startedAt < 250,
      'legacy fallback must not inherit cloudflared startup TTL',
    )
    resolveLaunch(late.lease)
    await waitUntil(late.closed)
    assert.equal(service.activeCount(), 0)
  })

  it('keeps only the latest same-user issue when tunnel acquisitions race', async () => {
    const first = fakeTunnel('race-one-preview.trycloudflare.com')
    const second = fakeTunnel('race-two-preview.trycloudflare.com')
    const launches: Array<(lease: QuickTunnelLease) => void> = []
    const service = makeService(
      () =>
        new Promise((resolve) => {
          launches.push(resolve)
        }),
      { tunnelAcquireTimeoutMs: 1_000 },
    )

    const onePromise = service.issue(22n, 'http://localhost:3000/', undefined)
    const twoPromise = service.issue(22n, 'http://localhost:3001/', undefined)
    await waitUntil(() => launches.length === 2)
    launches[0]!(first.lease)
    launches[1]!(second.lease)
    const [one, two] = await Promise.all([onePromise, twoPromise])

    assert.equal(one, null)
    assert.ok(two)
    assert.equal(first.closed(), true)
    assert.equal(service.activeCount(), 1)
    await service.revoke(22n, two.sessionId)
  })

  it('closes a tunnel that finishes starting after shutdown', async () => {
    const late = fakeTunnel('shutdown-late-preview.trycloudflare.com')
    let resolveLaunch!: (lease: QuickTunnelLease) => void
    const service = makeService(
      () =>
        new Promise((resolve) => {
          resolveLaunch = resolve
        }),
      { tunnelAcquireTimeoutMs: 1_000 },
    )
    const pendingIssue = service.issue(28n, 'http://localhost:3000/', undefined)
    await waitUntil(() => resolveLaunch !== undefined)
    const shutdown = service.shutdown()
    resolveLaunch(late.lease)
    assert.equal(await pendingIssue, null)
    await shutdown
    await waitUntil(late.closed)
    assert.equal(service.activeCount(), 0)
  })

  it('expires an abandoned bootstrap at its 30-second ticket deadline', async () => {
    let at = 10_000
    const tunnel = fakeTunnel('expired-preview.trycloudflare.com')
    const service = makeService(async () => tunnel.lease, { now: () => at })
    const issued = await service.issue(23n, 'http://localhost:3000/', undefined)
    assert.ok(issued)
    const publicUrl = new URL(issued.url)
    at += 30_000

    const server = createServer((req, res) => {
      void service.handleHttp(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const expired = await request(port, publicUrl.pathname + publicUrl.search, {
        Host: publicUrl.hostname,
      })
      assert.equal(expired.status, 410)
      assert.equal(tunnel.closed(), true)
      assert.equal(service.activeCount(), 0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

function makeService(
  launchTunnel: (originUrl: string) => Promise<QuickTunnelLease>,
  options: Partial<
    Pick<
      DirectContainerPreviewDeps,
      | 'now'
      | 'tunnelAcquireTimeoutMs'
      | 'tunnelOrigin'
      | 'maxWebSocketsPerSession'
      | 'maxWebSocketsGlobal'
      | 'resolveContainerEndpoint'
      | 'parentOrigin'
      | 'previewHostnameSuffix'
      | 'warmTunnels'
    >
  > = {},
): DirectContainerPreviewService {
  const {
    tunnelOrigin = 'http://127.0.0.1:18790',
    parentOrigin = 'https://claudeai.chat',
    resolveContainerEndpoint = async () => {
      throw new Error('not used')
    },
    ...rest
  } = options
  const service = createDirectContainerPreviewService({
    signer: {} as never,
    resolveContainerEndpoint,
    parentOrigin,
    tunnelOrigin,
    launchTunnel,
    maxSessions: 4,
    warmTunnels: 0,
    ...rest,
  })
  services.push(service)
  return service
}

async function bootstrap(
  service: DirectContainerPreviewService,
  issuedUrl: string,
): Promise<{ hostname: string; cookie: string }> {
  const publicUrl = new URL(issuedUrl)
  const server = createServer((req, res) => void service.handleHttp(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const response = await request(port, publicUrl.pathname + publicUrl.search, {
      Host: publicUrl.hostname,
    })
    assert.equal(response.status, 302)
    return {
      hostname: publicUrl.hostname,
      cookie: String(response.headers['set-cookie']?.[0]).split(';', 1)[0]!,
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function upgrade(
  service: DirectContainerPreviewService,
  hostname: string,
  cookie: string,
): PassThrough {
  const socket = new PassThrough()
  const handled = service.handleUpgrade(
    {
      method: 'GET',
      url: '/hmr',
      headers: { host: hostname, cookie },
    } as IncomingMessage,
    socket,
    Buffer.alloc(0),
  )
  assert.equal(handled, true)
  return socket
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function fakeTunnel(hostname: string): {
  lease: QuickTunnelLease
  closed(): boolean
  crash(): void
} {
  let didClose = false
  let resolveExit: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  return {
    lease: {
      hostname,
      exited,
      async close() {
        didClose = true
        resolveExit()
      },
    },
    closed: () => didClose,
    crash: () => resolveExit(),
  }
}

async function request(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}
