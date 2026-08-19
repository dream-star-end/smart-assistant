/**
 * Immutable incident contract for INC-20260810-LIVE-FRAME-SEQUENCE-RESET.
 *
 * Do not edit, rename, or delete this file in an ordinary refactor. The
 * regression-contract gate locks its exact bytes after merge and proves this
 * test turns red when permanent-conflict classification is disabled.
 */
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { signAccess } from '../../auth/jwt.js'
import {
  BRIDGE_WS_PATH,
  type UserChatBridgeHandler,
  createUserChatBridge,
} from '../../ws/userChatBridge.js'

const CONTRACT =
  'REG-20260817: permanent live-frame conflict never closes the browser or poisons later frames'
const JWT_SECRET = 'x'.repeat(32)

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('contract delivery timeout')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

function waitNextConnection(server: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('mock container connection timeout')), 1_500)
    server.once('connection', (socket) => {
      clearTimeout(timeout)
      resolve(socket)
    })
  })
}

async function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test(CONTRACT, async () => {
  const persisted: number[] = []
  const businessFrames: number[] = []
  let bridge: UserChatBridgeHandler | null = null
  let gateway: http.Server | null = null
  let containerServer: WebSocketServer | null = null
  let browser: WebSocket | null = null

  try {
    containerServer = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => containerServer!.once('listening', resolve))
    const containerPort = (containerServer.address() as { port: number }).port

    bridge = createUserChatBridge({
      jwtSecret: JWT_SECRET,
      resolveContainerEndpoint: async () => ({
        host: '127.0.0.1',
        port: containerPort,
        containerId: 83,
      }),
      containerConnectTimeoutMs: 1_500,
      persistOutboundFrame: async (input) => {
        if (input.frameSeq === 1) {
          const error = new Error('live frame immutable payload conflict') as Error & {
            liveFramePermanentConflict: boolean
          }
          error.liveFramePermanentConflict = true
          throw error
        }
        persisted.push(input.frameSeq)
      },
    })

    gateway = http.createServer((_request, response) => response.end())
    gateway.on('upgrade', (request, socket, head) => {
      if (!bridge!.handleUpgrade(request, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', resolve))
    const gatewayPort = (gateway.address() as { port: number }).port

    const token = (await signAccess({ sub: '707', role: 'user' }, JWT_SECRET)).token
    const containerConnection = waitNextConnection(containerServer)
    browser = new WebSocket(`ws://127.0.0.1:${gatewayPort}${BRIDGE_WS_PATH}`, ['bearer', token])
    await new Promise<void>((resolve) => browser!.once('open', resolve))
    const container = await containerConnection

    browser.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>
        if (
          typeof frame.type === 'string' &&
          !frame.type.startsWith('sys.') &&
          typeof frame.frameSeq === 'number'
        ) {
          businessFrames.push(frame.frameSeq)
        }
      } catch {
        // Connection-only or non-JSON frames are outside this contract.
      }
    })

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      browser!.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') })
      })
    })
    const frame = (frameSeq: number, text: string): string =>
      JSON.stringify({
        type: 'outbound.message',
        sessionKey: 'agent:main:webchat:dm:sess-regression-contract',
        frameSeq,
        peer: { id: 'sess-regression-contract', kind: 'dm' },
        clientMessageId: 'cm-regression-contract',
        blocks: [{ kind: 'text', text }],
      })

    container.send(frame(1, 'permanent conflict'))
    container.send(frame(2, 'must remain deliverable'))

    const outcome = await Promise.race([
      waitFor(() => persisted.includes(2) && businessFrames.includes(2)).then(() => ({
        kind: 'delivered' as const,
      })),
      closed.then((detail) => ({ kind: 'closed' as const, detail })),
    ])

    assert.deepEqual(
      outcome,
      { kind: 'delivered' },
      'a permanent persistence conflict must not close(1011)',
    )
    assert.equal(browser.readyState, WebSocket.OPEN)
    assert.deepEqual(persisted, [2], 'the later frame must persist instead of hitting failedSeq')
    assert.deepEqual(businessFrames, [2], 'the later frame must remain browser-visible')

    browser.close()
    await closed
  } finally {
    if (browser && browser.readyState !== WebSocket.CLOSED) browser.terminate()
    if (bridge) await bridge.shutdown()
    if (containerServer) await closeWebSocketServer(containerServer)
    if (gateway) await closeHttpServer(gateway)
  }
})
