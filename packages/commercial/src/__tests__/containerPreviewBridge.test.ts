import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, test } from 'node:test'

import {
  CONTAINER_PREVIEW_ASSERTION_HEADER,
  CONTAINER_PREVIEW_TICKET_PROTOCOL,
} from '@openclaude/protocol'
import { verifyContainerPreviewAssertion } from '@openclaude/protocol/containerPreviewAuth'
import { WebSocket, WebSocketServer } from 'ws'

import { AuthoritySigner } from '../ws/authoritySigner.js'
import { createContainerPreviewBridge } from '../ws/containerPreviewBridge.js'
import { ContainerPreviewTicketStore } from '../ws/containerPreviewTickets.js'

const origin = 'https://claudeai.chat'

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('server did not bind')
      resolve(address.port)
    }),
  )
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<{ data: Buffer; binary: boolean }> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data, binary) => resolve({ data: Buffer.from(data as any), binary }))
    ws.once('error', reject)
  })
}

describe('public container preview bridge', () => {
  const signer = AuthoritySigner.createEphemeral()
  const tickets = new ContainerPreviewTicketStore()
  const containerHttp = createServer()
  const containerWss = new WebSocketServer({ noServer: true })
  const publicHttp = createServer()
  let containerPort = 0
  let publicPort = 0
  let bridge: ReturnType<typeof createContainerPreviewBridge>
  let lastAssertion = ''

  before(async () => {
    containerHttp.on('upgrade', (req, socket, head) => {
      lastAssertion = String(req.headers[CONTAINER_PREVIEW_ASSERTION_HEADER] ?? '')
      containerWss.handleUpgrade(req, socket, head, (ws) =>
        containerWss.emit('connection', ws, req),
      )
    })
    containerPort = await listen(containerHttp)
    bridge = createContainerPreviewBridge({
      tickets,
      signer,
      allowedOrigin: origin,
      resolveContainerEndpoint: async () => ({
        host: '127.0.0.1',
        port: containerPort,
        containerId: 77,
      }),
    })
    publicHttp.on('upgrade', (req, socket, head) => {
      if (!bridge.handleUpgrade(req, socket, head)) socket.destroy()
    })
    publicPort = await listen(publicHttp)
  })

  after(async () => {
    await bridge.shutdown()
    for (const client of containerWss.clients) client.terminate()
    await new Promise<void>((resolve) => containerWss.close(() => resolve()))
    await new Promise<void>((resolve) => containerHttp.close(() => resolve()))
    await new Promise<void>((resolve) => publicHttp.close(() => resolve()))
  })

  test('consumes one ticket, signs the exact target, and forwards JSON + large JPEG frames', async () => {
    const issued = tickets.issue(42n, 'http://localhost:3000/', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      isMobile: false,
    })
    const containerConnected = new Promise<WebSocket>((resolve) =>
      containerWss.once('connection', resolve),
    )
    const browser = new WebSocket(
      `ws://127.0.0.1:${publicPort}/ws/container-preview`,
      [CONTAINER_PREVIEW_TICKET_PROTOCOL, issued.ticket],
      { origin },
    )
    await opened(browser)
    const container = await containerConnected
    const openFrame = await nextMessage(container)
    assert.equal(openFrame.binary, false)
    assert.equal(JSON.parse(openFrame.data.toString()).type, 'preview.open')

    const assertion = verifyContainerPreviewAssertion(lastAssertion, signer.publicKeyring())
    assert.equal(assertion.uid, 42)
    assert.equal(assertion.containerId, 77)

    const statusPromise = nextMessage(browser)
    container.send(JSON.stringify({ type: 'preview.status', status: 'loading' }))
    assert.equal(JSON.parse((await statusPromise).data.toString()).status, 'loading')

    const jpeg = Buffer.alloc(256 * 1024, 0x5a)
    const jpegPromise = nextMessage(browser)
    container.send(jpeg, { binary: true })
    const forwarded = await jpegPromise
    assert.equal(forwarded.binary, true)
    assert.equal(forwarded.data.byteLength, jpeg.byteLength)
    assert.equal(forwarded.data[0], 0x5a)

    browser.close()
    container.close()
  })

  test('wrong Origin is rejected before ticket consumption, then the same ticket works once', async () => {
    const issued = tickets.issue(43n, 'http://localhost:3001/', undefined)
    const rejected = new WebSocket(
      `ws://127.0.0.1:${publicPort}/ws/container-preview`,
      [CONTAINER_PREVIEW_TICKET_PROTOCOL, issued.ticket],
      { origin: 'https://evil.test' },
    )
    const status = await new Promise<number>((resolve, reject) => {
      rejected.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      rejected.once('error', (err) => {
        if (!/Unexpected server response/.test(err.message)) reject(err)
      })
    })
    assert.equal(status, 403)

    const containerConnected = new Promise<WebSocket>((resolve) =>
      containerWss.once('connection', resolve),
    )
    const accepted = new WebSocket(
      `ws://127.0.0.1:${publicPort}/ws/container-preview`,
      [CONTAINER_PREVIEW_TICKET_PROTOCOL, issued.ticket],
      { origin },
    )
    await opened(accepted)
    const container = await containerConnected
    await nextMessage(container)
    accepted.close()
    container.close()

    const replay = new WebSocket(
      `ws://127.0.0.1:${publicPort}/ws/container-preview`,
      [CONTAINER_PREVIEW_TICKET_PROTOCOL, issued.ticket],
      { origin },
    )
    const replayStatus = await new Promise<number>((resolve) => {
      replay.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      replay.once('error', () => {})
    })
    assert.equal(replayStatus, 401)
  })

  test('a fresh same-user ticket replaces the prior session for device switching', async () => {
    const firstTicket = tickets.issue(44n, 'http://localhost:3002/', undefined)
    const firstContainerConnected = new Promise<WebSocket>((resolve) =>
      containerWss.once('connection', resolve),
    )
    const firstBrowser = new WebSocket(
      `ws://127.0.0.1:${publicPort}/ws/container-preview`,
      [CONTAINER_PREVIEW_TICKET_PROTOCOL, firstTicket.ticket],
      { origin },
    )
    await opened(firstBrowser)
    const firstContainer = await firstContainerConnected
    await nextMessage(firstContainer)
    const firstClosed = new Promise<void>((resolve) => firstBrowser.once('close', () => resolve()))

    const secondTicket = tickets.issue(44n, 'http://localhost:3002/', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
    })
    const secondContainerConnected = new Promise<WebSocket>((resolve) =>
      containerWss.once('connection', resolve),
    )
    const secondBrowser = new WebSocket(
      `ws://127.0.0.1:${publicPort}/ws/container-preview`,
      [CONTAINER_PREVIEW_TICKET_PROTOCOL, secondTicket.ticket],
      { origin },
    )
    await opened(secondBrowser)
    const secondContainer = await secondContainerConnected
    const open = JSON.parse((await nextMessage(secondContainer)).data.toString())
    assert.equal(open.viewport.isMobile, true)
    await firstClosed

    secondBrowser.close()
    firstContainer.close()
    secondContainer.close()
  })

  test('a same-user replacement keeps its slot when the global pool is full', async () => {
    const limitedTickets = new ContainerPreviewTicketStore()
    const limitedHttp = createServer()
    const limitedBridge = createContainerPreviewBridge({
      tickets: limitedTickets,
      signer,
      allowedOrigin: origin,
      maxGlobalSessions: 1,
      resolveContainerEndpoint: async () => ({
        host: '127.0.0.1',
        port: containerPort,
        containerId: 77,
      }),
    })
    limitedHttp.on('upgrade', (req, socket, head) => {
      if (!limitedBridge.handleUpgrade(req, socket, head)) socket.destroy()
    })
    const limitedPort = await listen(limitedHttp)
    let firstBrowser: WebSocket | null = null
    let secondBrowser: WebSocket | null = null
    let firstContainer: WebSocket | null = null
    let secondContainer: WebSocket | null = null
    try {
      const firstTicket = limitedTickets.issue(50n, 'http://localhost:3010/', undefined)
      const firstContainerConnected = new Promise<WebSocket>((resolve) =>
        containerWss.once('connection', resolve),
      )
      firstBrowser = new WebSocket(
        `ws://127.0.0.1:${limitedPort}/ws/container-preview`,
        [CONTAINER_PREVIEW_TICKET_PROTOCOL, firstTicket.ticket],
        { origin },
      )
      await opened(firstBrowser)
      firstContainer = await firstContainerConnected
      await nextMessage(firstContainer)
      assert.equal(limitedBridge.activeCount(), 1)
      const firstClosed = new Promise<void>((resolve) =>
        firstBrowser!.once('close', () => resolve()),
      )

      const secondTicket = limitedTickets.issue(50n, 'http://localhost:3010/', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        isMobile: true,
      })
      const secondContainerConnected = new Promise<WebSocket>((resolve) =>
        containerWss.once('connection', resolve),
      )
      secondBrowser = new WebSocket(
        `ws://127.0.0.1:${limitedPort}/ws/container-preview`,
        [CONTAINER_PREVIEW_TICKET_PROTOCOL, secondTicket.ticket],
        { origin },
      )
      await opened(secondBrowser)
      secondContainer = await secondContainerConnected
      await nextMessage(secondContainer)
      await firstClosed
      assert.equal(limitedBridge.activeCount(), 1)

      const otherTicket = limitedTickets.issue(51n, 'http://localhost:3011/', undefined)
      const rejected = new WebSocket(
        `ws://127.0.0.1:${limitedPort}/ws/container-preview`,
        [CONTAINER_PREVIEW_TICKET_PROTOCOL, otherTicket.ticket],
        { origin },
      )
      const status = await new Promise<number>((resolve) => {
        rejected.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        rejected.once('error', () => {})
      })
      assert.equal(status, 503)
      assert.equal(secondBrowser.readyState, WebSocket.OPEN)
      assert.equal(limitedBridge.activeCount(), 1)
    } finally {
      firstBrowser?.close()
      secondBrowser?.close()
      firstContainer?.close()
      secondContainer?.close()
      await limitedBridge.shutdown()
      await new Promise<void>((resolve) => limitedHttp.close(() => resolve()))
    }
  })
})
