import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import type { DnsResolver } from '../connectors/outboundPolicy.js'
import type { BrowserStorageStateV1 } from './accounts.js'
import {
  type ManagedBrowserDriverV1,
  type ManagedBrowserLauncherV1,
  ManagedBrowserRuntime,
  ManagedBrowserRuntimeError,
  type ManagedBrowserSession,
  REQUIRED_BROWSER_LAUNCHER_CAPABILITIES,
  assertSecureBrowserLauncher,
  makeManagedBrowserRequestGuard,
  resolveManagedBrowserPins,
} from './browserRuntime.js'
import type { ManagedBrowserPluginContractV1 } from './contracts.js'

const contract: ManagedBrowserPluginContractV1 = {
  schemaVersion: 1,
  pluginType: 'managed-browser',
  artifactHash: 'a'.repeat(64),
  id: 'browser-reader',
  version: '1.0.0',
  account: { mode: 'required', contractVersion: 1 },
  actions: [
    {
      id: 'read',
      description: 'Read',
      effect: 'read',
      timeoutSeconds: 1,
      params: { type: 'object', additionalProperties: false, properties: {} },
      result: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    },
  ],
  runtime: {
    driverId: 'browser-reader',
    driverVersion: '1.0.0',
    network: {
      origins: ['https://example.com:443'],
      methods: ['GET'],
      forbiddenChannels: [
        'background-network',
        'doh',
        'proxy',
        'quic',
        'websocket',
        'webrtc',
        'worker',
      ],
      redirects: 'revalidate-every-hop',
      ipv4PinsRequired: true,
    },
  },
}
const storageState: BrowserStorageStateV1 = { cookies: [], origins: [] }
const resolver: DnsResolver = {
  resolve4: async () => ['93.184.216.34'],
  resolve6: async () => [],
}
const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(
  opts: {
    execute?: ManagedBrowserDriverV1['execute']
    launch?: ManagedBrowserLauncherV1['launch']
    close?: ManagedBrowserSession['close']
    removeProfile?: (path: string) => Promise<void>
    removeFails?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'oc-browser-runtime-'))
  fixtureRoots.push(root)
  let closed = 0
  let terminated = 0
  let launchedProfile = ''
  const launcher: ManagedBrowserLauncherV1 = {
    id: 'secure-launcher',
    version: '1.0.0',
    capabilities: REQUIRED_BROWSER_LAUNCHER_CAPABILITIES,
    async launch(args) {
      launchedProfile = args.profileDir
      if (opts.launch) return opts.launch(args)
      assert.equal(args.pins[0]!.ip, '93.184.216.34')
      assert.equal(
        args.requestGuard({ url: 'https://example.com/post', method: 'GET' }).ip,
        '93.184.216.34',
      )
      return {
        driverSession: { safe: true },
        exportStorageState: async () => storageState,
        close: async () => {
          closed++
          if (opts.close) await opts.close()
        },
      }
    },
    async terminate() {
      terminated++
    },
  }
  const driver: ManagedBrowserDriverV1 = {
    id: 'browser-reader',
    version: '1.0.0',
    launcherId: 'secure-launcher',
    launcherVersion: '1.0.0',
    maximumNetwork: { origins: ['https://example.com'], methods: ['GET'] },
    execute: opts.execute ?? (async () => ({ ok: true })),
  }
  const runtime = new ManagedBrowserRuntime({
    drivers: new Map([['browser-reader@1.0.0', driver]]),
    launchers: new Map([['secure-launcher@1.0.0', launcher]]),
    profileRoot: root,
    expectedOwnerUid: process.getuid?.() ?? 0,
    resolver,
    cleanupTimeoutMs: 25,
    ...(opts.removeProfile ? { removeProfile: opts.removeProfile } : {}),
    ...(opts.removeFails
      ? {
          removeProfile: async () => {
            throw new Error('disk failure')
          },
        }
      : {}),
  })
  return {
    runtime,
    root,
    get closed() {
      return closed
    },
    get terminated() {
      return terminated
    },
    get profile() {
      return launchedProfile
    },
  }
}

describe('managed-browser Plugin runtime', () => {
  test('requires the exact socket-isolation capability attestation', () => {
    assert.throws(
      () =>
        assertSecureBrowserLauncher({
          id: 'bad-launcher',
          version: '1.0.0',
          capabilities: {
            ...REQUIRED_BROWSER_LAUNCHER_CAPABILITIES,
            exactPinnedTls: false,
          } as never,
          launch: async () => {
            throw new Error('never')
          },
          terminate: async () => {},
        }),
      (error: unknown) =>
        error instanceof ManagedBrowserRuntimeError && error.code === 'INSECURE_LAUNCHER',
    )
  })

  test('requires the registry key to match the launcher identity pin', async () => {
    const f = await fixture()
    const mismatched = new ManagedBrowserRuntime({
      drivers: new Map([
        [
          'browser-reader@1.0.0',
          {
            id: 'browser-reader',
            version: '1.0.0',
            launcherId: 'expected-launcher',
            launcherVersion: '1.0.0',
            maximumNetwork: { origins: ['https://example.com'], methods: ['GET'] },
            execute: async () => ({ ok: true }),
          },
        ],
      ]),
      launchers: new Map([
        [
          'expected-launcher@1.0.0',
          {
            id: 'different-launcher',
            version: '1.0.0',
            capabilities: REQUIRED_BROWSER_LAUNCHER_CAPABILITIES,
            launch: async () => {
              throw new Error('must not launch')
            },
            terminate: async () => {},
          },
        ],
      ]),
      profileRoot: f.root,
      expectedOwnerUid: process.getuid?.() ?? 0,
      resolver,
    })
    await assert.rejects(
      mismatched.runReadAction({
        contract,
        storageState,
        actionId: 'read',
        params: {},
        signal: new AbortController().signal,
      }),
      /launcher pin mismatch/,
    )
  })

  test('resolves all DNS records, requires IPv4 and guards every request/redirect hop', async () => {
    const pins = await resolveManagedBrowserPins(contract, resolver)
    const guard = makeManagedBrowserRequestGuard(contract, pins)
    assert.equal(guard({ url: 'https://example.com/a?b=1', method: 'GET' }).ip, '93.184.216.34')
    assert.throws(
      () => guard({ url: 'wss://example.com/socket', method: 'GET' }),
      /credential-free HTTPS/,
    )
    assert.throws(
      () => guard({ url: 'https://evil.example/', method: 'GET', isRedirect: true }),
      /not signed/,
    )
    assert.throws(
      () => guard({ url: 'https://example.com/', method: 'POST' }),
      /method is not signed/,
    )

    const mixed: DnsResolver = {
      resolve4: async () => ['93.184.216.34'],
      resolve6: async () => ['::1'],
    }
    await assert.rejects(resolveManagedBrowserPins(contract, mixed), /DNS is unsafe/)
    const ipv6Only: DnsResolver = {
      resolve4: async () => [],
      resolve6: async () => ['2606:4700:4700::1111'],
    }
    await assert.rejects(resolveManagedBrowserPins(contract, ipv6Only), /requires an IPv4 pin/)
  })

  test('validates result/state, closes the process and removes profile before returning', async () => {
    const f = await fixture()
    const output = await f.runtime.runReadAction({
      contract,
      storageState,
      actionId: 'read',
      params: {},
      signal: new AbortController().signal,
    })
    assert.deepEqual(output, { result: { ok: true }, storageState })
    assert.equal(f.closed, 1)
    assert.equal(f.terminated, 1)
    assert.ok(f.profile)
    const { lstat } = await import('node:fs/promises')
    assert.equal(await lstat(f.profile).catch(() => null), null)
  })

  test('cleanup failure suppresses the business result', async () => {
    const f = await fixture({ removeFails: true })
    await assert.rejects(
      f.runtime.runReadAction({
        contract,
        storageState,
        actionId: 'read',
        params: {},
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof ManagedBrowserRuntimeError && error.code === 'CLEANUP_FAILED',
    )
    assert.equal(f.closed, 1)
  })

  test('a hanging close suppresses the result but still hard-terminates and removes the profile', async () => {
    const f = await fixture({ close: async () => await new Promise(() => {}) })
    await assert.rejects(
      f.runtime.runReadAction({
        contract,
        storageState,
        actionId: 'read',
        params: {},
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof ManagedBrowserRuntimeError && error.code === 'CLEANUP_FAILED',
    )
    assert.equal(f.closed, 1)
    assert.equal(f.terminated, 1)
    const { lstat } = await import('node:fs/promises')
    assert.equal(await lstat(f.profile).catch(() => null), null)
  })

  test('a hanging profile remover is bounded and suppresses the business result', async () => {
    const f = await fixture({ removeProfile: async () => await new Promise(() => {}) })
    const started = Date.now()
    await assert.rejects(
      f.runtime.runReadAction({
        contract,
        storageState,
        actionId: 'read',
        params: {},
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof ManagedBrowserRuntimeError && error.code === 'CLEANUP_FAILED',
    )
    assert.ok(Date.now() - started < 1000)
    assert.equal(f.closed, 1)
    assert.equal(f.terminated, 1)
  })

  test('hard timeout terminates a driver that ignores AbortSignal and still cleans up', async () => {
    const f = await fixture({
      execute: async () => await new Promise(() => {}),
    })
    await assert.rejects(
      f.runtime.runReadAction({
        contract,
        storageState,
        actionId: 'read',
        params: {},
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof ManagedBrowserRuntimeError && error.code === 'TIMEOUT',
    )
    assert.equal(f.closed, 1)
    assert.equal(f.terminated, 1)
  })

  test('hard timeout terminates a launcher that never resolves', async () => {
    const f = await fixture({
      launch: async () => await new Promise(() => {}),
    })
    await assert.rejects(
      f.runtime.runReadAction({
        contract,
        storageState,
        actionId: 'read',
        params: {},
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof ManagedBrowserRuntimeError && error.code === 'TIMEOUT',
    )
    assert.equal(f.closed, 0)
    assert.equal(f.terminated, 1)
    const { lstat } = await import('node:fs/promises')
    assert.equal(await lstat(f.profile).catch(() => null), null)
  })

  test('an already-aborted parent never launches a browser', async () => {
    const f = await fixture()
    const parent = new AbortController()
    parent.abort(new Error('lease lost'))
    await assert.rejects(
      f.runtime.runReadAction({
        contract,
        storageState,
        actionId: 'read',
        params: {},
        signal: parent.signal,
      }),
      /lease lost/,
    )
    assert.equal(f.profile, '')
    assert.equal(f.terminated, 0)
  })
})
