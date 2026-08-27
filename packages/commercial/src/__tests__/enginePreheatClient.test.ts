/**
 * master→容器 engine-preheat 客户端:HMAC 头、不 provision、404/5xx/超时 fail-open。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/enginePreheatClient.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ENGINE_PREHEAT_PATH } from '@openclaude/protocol'

import { computeInboundNonce } from '../bridgeSecret.js'
import {
  makeEnginePreheatClient,
  parseUidFromGatewayUserId,
} from '../dispatch/enginePreheatClient.js'
import type { ContainerTransport } from '../wechat/inboundDispatcher.js'

const SECRET = 's'.repeat(32)
const CONTAINER_ID = 7

function recordingTransport(handler: {
  status?: number
  throwError?: Error
  onCall?: (info: {
    path: string
    headers: Record<string, string>
    body: string | null
  }) => void
}): ContainerTransport & { calls: number } {
  const rec = { calls: 0 }
  const impl = async (
    _method: string,
    _ep: unknown,
    path: string,
    headers: Record<string, string>,
    body: string | null,
  ) => {
    rec.calls += 1
    handler.onCall?.({ path, headers, body })
    if (handler.throwError) throw handler.throwError
    return { status: handler.status ?? 200, bodyText: '{"ok":true}' }
  }
  return {
    post: async (ep, path, headers, body) => impl('POST', ep, path, headers, body),
    request: async (method, ep, path, headers, body) => impl(method, ep, path, headers, body),
    get calls() {
      return rec.calls
    },
  }
}

describe('parseUidFromGatewayUserId', () => {
  test('c:<uid> 与裸数字', () => {
    assert.equal(parseUidFromGatewayUserId('c:3'), 3n)
    assert.equal(parseUidFromGatewayUserId('42'), 42n)
  })
  test('个人版 default / 非法 → null', () => {
    assert.equal(parseUidFromGatewayUserId('default'), null)
    assert.equal(parseUidFromGatewayUserId('c:0'), null)
    assert.equal(parseUidFromGatewayUserId(''), null)
  })
})

describe('makeEnginePreheatClient', () => {
  test('200 + HMAC 头与 wechat inbound 同款', async () => {
    let seen: { path: string; headers: Record<string, string>; body: string | null } | undefined
    const transport = recordingTransport({
      status: 200,
      onCall: (info) => {
        seen = info
      },
    })
    const post = makeEnginePreheatClient({
      transport,
      bridgeSecret: SECRET,
      resolveRunningEndpoint: async () => ({
        host: '172.30.0.4',
        port: 18789,
        containerId: CONTAINER_ID,
      }),
    })
    await post({
      userId: 'c:3',
      sessionId: 'webtest1234',
      agentId: 'main',
      modelId: 'glm-5.3-zai',
    })
    assert.equal(transport.calls, 1)
    assert.ok(seen)
    assert.equal(seen!.path, ENGINE_PREHEAT_PATH)
    assert.equal(seen!.headers['x-openclaude-container-id'], String(CONTAINER_ID))
    assert.equal(
      seen!.headers['x-openclaude-inbound-nonce'],
      computeInboundNonce(SECRET, CONTAINER_ID),
    )
    assert.deepEqual(JSON.parse(seen!.body ?? '{}'), {
      sessionId: 'webtest1234',
      agentId: 'main',
      modelId: 'glm-5.3-zai',
    })
  })

  test('容器未运行 → 不 POST', async () => {
    const transport = recordingTransport({})
    const post = makeEnginePreheatClient({
      transport,
      bridgeSecret: SECRET,
      resolveRunningEndpoint: async () => null,
    })
    await post({ userId: 'c:3', sessionId: 'webtest1234', agentId: 'main' })
    assert.equal(transport.calls, 0)
  })

  test('404 旧容器无路由 → 不抛', async () => {
    const transport = recordingTransport({ status: 404 })
    const post = makeEnginePreheatClient({
      transport,
      bridgeSecret: SECRET,
      resolveRunningEndpoint: async () => ({
        host: '127.0.0.1',
        port: 18789,
        containerId: CONTAINER_ID,
      }),
    })
    await post({ userId: 'c:3', sessionId: 'webtest1234', agentId: 'main' })
    assert.equal(transport.calls, 1)
  })

  test('5xx → 不抛', async () => {
    const transport = recordingTransport({ status: 503 })
    const post = makeEnginePreheatClient({
      transport,
      bridgeSecret: SECRET,
      resolveRunningEndpoint: async () => ({
        host: '127.0.0.1',
        port: 18789,
        containerId: CONTAINER_ID,
      }),
    })
    await post({ userId: 'c:3', sessionId: 'webtest1234', agentId: 'main' })
    assert.equal(transport.calls, 1)
  })

  test('transport 超时 → 不抛', async () => {
    const transport = recordingTransport({ throwError: new Error('timeout') })
    const post = makeEnginePreheatClient({
      transport,
      bridgeSecret: SECRET,
      resolveRunningEndpoint: async () => ({
        host: '127.0.0.1',
        port: 18789,
        containerId: CONTAINER_ID,
      }),
    })
    await post({ userId: 'c:3', sessionId: 'webtest1234', agentId: 'main' })
    assert.equal(transport.calls, 1)
  })

  test('resolve 抛 → 不抛不 POST', async () => {
    const transport = recordingTransport({})
    const post = makeEnginePreheatClient({
      transport,
      bridgeSecret: SECRET,
      resolveRunningEndpoint: async () => {
        throw new Error('db down')
      },
    })
    await post({ userId: 'c:3', sessionId: 'webtest1234', agentId: 'main' })
    assert.equal(transport.calls, 0)
  })

  test('remote-host tunnel 且 transport 不支持 → 不 POST', async () => {
    const transport = recordingTransport({})
    const post = makeEnginePreheatClient({
      transport,
      bridgeSecret: SECRET,
      resolveRunningEndpoint: async () => ({
        host: '10.0.0.8',
        port: 18789,
        containerId: CONTAINER_ID,
        tunnel: { kind: 'remote-host' },
      }),
    })
    await post({ userId: 'c:3', sessionId: 'webtest1234', agentId: 'main' })
    assert.equal(transport.calls, 0)
  })
})
