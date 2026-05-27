import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { __resetCapabilityCacheForTest, isContainerCapabilityReady } from '../capabilityCache.js'

const baseStatus = {
  containerId: 42,
  boundIp: '172.30.0.13',
  port: 18789,
  hostId: '00000000-0000-0000-0000-000000000001',
  dockerContainerId: 'abcdef',
}

describe('isContainerCapabilityReady', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    __resetCapabilityCacheForTest()
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    __resetCapabilityCacheForTest()
    globalThis.fetch = originalFetch
  })

  test('local healthz probe uses an explicit direct dispatcher', async () => {
    let capturedUrl: string | null = null
    let capturedDispatcher: unknown = null

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedDispatcher = (init as (RequestInit & { dispatcher?: unknown }) | undefined)
        ?.dispatcher
      return new Response(JSON.stringify({ containerId: '42', capabilities: ['file-proxy-v1'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    const ready = await isContainerCapabilityReady(baseStatus, ['file-proxy-v1'], {
      selfHostId: baseStatus.hostId,
    })

    assert.equal(ready, true)
    assert.equal(capturedUrl, 'http://172.30.0.13:18789/healthz')
    assert.ok(capturedDispatcher, 'local healthz fetch must bypass global EnvHttpProxyAgent')
  })

  test('injected fetchHealthz path is still honored', async () => {
    let globalFetchCalled = false
    globalThis.fetch = (async () => {
      globalFetchCalled = true
      throw new Error('should not use global fetch when fetchHealthz is injected')
    }) as typeof globalThis.fetch

    const ready = await isContainerCapabilityReady(baseStatus, ['file-proxy-v1'], {
      selfHostId: baseStatus.hostId,
      fetchHealthz: async (boundIp, port) => {
        assert.equal(boundIp, baseStatus.boundIp)
        assert.equal(port, baseStatus.port)
        return { containerId: '42', capabilities: ['file-proxy-v1'] }
      },
    })

    assert.equal(ready, true)
    assert.equal(globalFetchCalled, false)
  })
})
