/**
 * Session-display mock gateway.
 *
 * Speaks the hello path that is on feat/v5-selfhost today: the #1198
 * compatibility turn_status, outbound ring catch-up, and the #1200
 * `outbound.session_snapshot` (commercial/src/ws/helloOpenDispatchSnapshot.ts);
 * HTTP live-frames carries the same snapshot (commercial/src/db/sessionSnapshot.ts,
 * one dispatch stream, no pages/byte limits). engine_starting is stored with a
 * frameSeq so a later hello does not replay it after the detached snapshot
 * and paint 「正在启动引擎」 again. Content frames stay replayable.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, sep } from 'node:path'
import { WebSocketServer } from 'ws'

export const SESSION_ID = 'sdsession1'
export const AGENT_ID = 'main'
export const TERMINAL_MARKER = 'R5_TERMINAL_ANSWER'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
}

function sessionKey() {
  return `agent:${AGENT_ID}:webchat:dm:${SESSION_ID}`
}

function peer() {
  return { id: SESSION_ID, kind: 'dm' }
}

function relayReady() {
  return { type: 'sys.relay_ready', automaticRecoveryOwner: 'master-v1' }
}

function engineStarting(clientMessageId, frameSeq) {
  return {
    type: 'outbound.turn_status',
    sessionKey: sessionKey(),
    channel: 'webchat',
    peer: peer(),
    clientMessageId,
    status: 'engine_starting',
    frameSeq,
    ts: Date.now(),
  }
}

function thinkingFrame(clientMessageId, frameSeq, text) {
  return {
    type: 'outbound.message',
    sessionKey: sessionKey(),
    channel: 'webchat',
    peer: peer(),
    clientMessageId,
    frameSeq,
    blocks: [{ kind: 'thinking', text, messageId: `srv-${clientMessageId}-thinking` }],
    isFinal: false,
  }
}

function finalText(clientMessageId, frameSeq, text) {
  return {
    type: 'outbound.message',
    sessionKey: sessionKey(),
    channel: 'webchat',
    peer: peer(),
    clientMessageId,
    frameSeq,
    blocks: [{ kind: 'text', text, messageId: `srv-${clientMessageId}-answer` }],
    isFinal: true,
    meta: { turn: 1, stopReason: 'end_turn' },
  }
}

const STREAM_KEY = 'dispatch:dsp-sd-1:1'

function isReplayable(frame) {
  if (typeof frame.frameSeq !== 'number' || frame.frameSeq <= 0) return false
  if (frame.type === 'outbound.turn_status') {
    return frame.status !== 'engine_starting' && frame.status !== 'engine_resuming'
  }
  return true
}

export class MockGateway {
  constructor() {
    this.reset()
  }

  reset() {
    this.userText = ''
    this.userMessageId = ''
    this.clientMessageId = ''
    this.status = 'idle'
    this.admittedAt = 0
    this.engineReady = false
    this.frames = []
    this.nextSeq = 1
    this.dropBudget = 0
    this.finishAfterDrops = false
    this.suppressHelloBody = false
    this.credits = null
    this.snapshotReads = []
    this.terminalText = ''
    this.inboundMessages = []
    this.hellos = 0
    this.closes = 0
    this.connections = 0
    this.updatedAt = 1
    this.historyRevision = 1
    this.trace = []
  }

  note(message) {
    this.trace.push(message)
    if (this.trace.length > 80) this.trace.shift()
  }

  debug() {
    return {
      status: this.status,
      clientMessageId: this.clientMessageId,
      engineReady: this.engineReady,
      dropBudget: this.dropBudget,
      hellos: this.hellos,
      closes: this.closes,
      connections: this.connections,
      snapshotReads: this.snapshotReads,
      inbound: this.inboundMessages,
      frames: this.frames.map(
        (frame) =>
          `${frame.type}:${frame.frameSeq ?? '-'}:${frame.status ?? ''}:${frame.isFinal ? 'final' : ''}`,
      ),
      trace: this.trace,
    }
  }

  armDrops(count) {
    this.dropBudget = count
    this.finishAfterDrops = true
    this.note(`armDrops ${count}`)
  }

  /**
   * New device: the turn is already admitted and a thinking frame exists, but
   * this browser has never seen it. Hello catch-up is the only delivery path.
   */
  seedCold({ userText, clientMessageId, thinking, admittedAt }) {
    this.reset()
    this.userText = userText
    this.userMessageId = clientMessageId
    this.clientMessageId = clientMessageId
    this.status = 'open'
    this.admittedAt = admittedAt
    this.engineReady = true
    this.frames.push(engineStarting(clientMessageId, this.nextSeq++))
    this.frames.push(thinkingFrame(clientMessageId, this.nextSeq++, thinking))
    this.updatedAt = admittedAt
    this.note(`seedCold ${clientMessageId}`)
  }

  parkThinking(text) {
    if (this.status !== 'open' || !this.clientMessageId) {
      throw new Error('parkThinking requires an open turn')
    }
    this.engineReady = true
    this.frames.push(thinkingFrame(this.clientMessageId, this.nextSeq++, text))
    this.updatedAt += 1
    this.note(`parkThinking seq=${this.nextSeq - 1}`)
  }

  emitFinal(text) {
    this.frames.push(finalText(this.clientMessageId, this.nextSeq++, text))
    this.status = 'terminal'
    this.engineReady = true
    this.terminalText = text
    this.updatedAt += 1
    this.note(`emitFinal ${text}`)
  }

  snapshotFrame() {
    return {
      type: 'outbound.turn_status',
      sessionKey: sessionKey(),
      channel: 'webchat',
      peer: peer(),
      clientMessageId: this.clientMessageId,
      status: this.engineReady ? null : 'engine_starting',
      meta: { detached: true, since: this.admittedAt },
      ts: Date.now(),
    }
  }

  /** buildSessionSnapshot for this one-dispatch session (#1200 contract). */
  sessionSnapshot({ afterSeq, streamKey } = {}) {
    const snapshot = {
      v: 1, sessionId: SESSION_ID, dispatch: null, streamKey: null, lastFrameSeq: null,
      lastFrameAt: null, engineReady: null, turnStatus: null, reconcile: null,
      pendingPermissions: { items: [], completeness: 'complete' }, usage: null, credits: null,
      frames: [], nextAfterSeq: 0, hasMore: false, gap: null, asOf: Date.now(),
    }
    if (!this.clientMessageId) return snapshot
    const open = this.status === 'open'
    snapshot.dispatch = {
      id: 'dsp-sd-1', clientMessageId: this.clientMessageId, agentId: AGENT_ID,
      status: open ? 'accepted' : 'terminal', outcome: open ? null : 'completed', attempt: 1,
      since: this.admittedAt, acceptedAt: this.admittedAt, terminalAt: open ? null : this.updatedAt,
    }
    snapshot.streamKey = STREAM_KEY
    const lastFrameSeq = this.frames.reduce((max, frame) => Math.max(max, frame.frameSeq || 0), 0)
    snapshot.lastFrameSeq = lastFrameSeq || null
    snapshot.lastFrameAt = lastFrameSeq ? Date.now() : null
    if (open) {
      snapshot.engineReady = this.engineReady
      snapshot.turnStatus = this.snapshotFrame()
      if (this.credits) snapshot.credits = { ...this.credits, asOf: Date.now() }
    } else snapshot.reconcile = 'turn_completed'
    const asked = Number(afterSeq) > 0 ? Number(afterSeq) : 0
    const reset = asked > 0 && (streamKey !== STREAM_KEY || asked > lastFrameSeq)
    snapshot.nextAfterSeq = reset ? 0 : asked
    for (const payload of this.frames) {
      if (!(payload.frameSeq > snapshot.nextAfterSeq)) continue
      snapshot.frames.push({ recordId: `rec-${payload.frameSeq}`, frameSeq: payload.frameSeq, payload })
      snapshot.nextAfterSeq = payload.frameSeq
    }
    if (reset) snapshot.gap = { reason: 'cursor_reset' }
    return snapshot
  }

  userMessage() {
    if (!this.userMessageId) return null
    return {
      id: this.userMessageId,
      role: 'user',
      text: this.userText,
      ts: this.admittedAt || 1,
      status: 'sent',
      _clientMessageId: this.clientMessageId,
    }
  }

  sessionDetail() {
    const message = this.userMessage()
    const open =
      this.status === 'open' && this.clientMessageId
        ? {
            dispatchId: 'dsp-sd-1',
            clientMessageId: this.clientMessageId,
            status: 'accepted',
            acceptedAt: this.admittedAt,
          }
        : undefined
    return {
      id: SESSION_ID,
      agentId: AGENT_ID,
      title: '边界剧本',
      updatedAt: this.updatedAt,
      historyRevision: this.historyRevision,
      timelineGeneration: 1,
      maxSeq: Math.max(0, this.nextSeq - 1),
      messages: [
        ...(message ? [message] : []),
        ...(this.terminalText
          ? [
              {
                id: `srv-${this.clientMessageId}-answer`,
                role: 'assistant',
                text: this.terminalText,
                ts: this.updatedAt,
                status: 'complete',
                _clientMessageId: this.clientMessageId,
              },
            ]
          : []),
      ],
      ...(open ? { openDispatch: open } : {}),
    }
  }

  liveFramesPage() {
    return {
      frames: this.frames.map((payload, index) => ({
        recordId: `rec-${index + 1}`,
        streamKey: sessionKey(),
        source: 'gateway',
        clientMessageId: this.clientMessageId,
        payload,
      })),
      nextCursor: String(this.frames.length),
      hasMore: false,
      streamClientMessageIds: this.clientMessageId ? [this.clientMessageId] : [],
      hasTapeProjection: false,
    }
  }

  send(ws, frame) {
    if (ws.readyState !== 1) return false
    ws.send(JSON.stringify(frame))
    return true
  }

  maybeDrop(ws) {
    if (!(this.dropBudget > 0)) return false
    this.dropBudget -= 1
    this.note(`scheduleClose budgetLeft=${this.dropBudget}`)
    setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }, 40)
    return true
  }

  admit(ws, frame) {
    const clientMessageId = String(frame.clientMessageId || '')
    const text = String(frame.content?.text || '')
    this.inboundMessages.push({ clientMessageId, text })
    if (this.status === 'open' && clientMessageId && clientMessageId !== this.clientMessageId) {
      this.note(`ack-only extra ${clientMessageId}`)
      this.send(ws, {
        type: 'outbound.ack',
        admitted: true,
        peer: peer(),
        clientMessageId,
        idempotencyKey: frame.idempotencyKey,
      })
      return
    }
    if (this.status !== 'idle') {
      this.note(`ignore inbound while ${this.status}`)
      return
    }
    this.userText = text
    this.userMessageId = clientMessageId
    this.clientMessageId = clientMessageId
    this.status = 'open'
    this.admittedAt = Date.now()
    this.engineReady = false
    this.updatedAt += 1
    this.note(`admit ${clientMessageId}`)
    this.send(ws, {
      type: 'outbound.ack',
      admitted: true,
      peer: peer(),
      clientMessageId,
      idempotencyKey: frame.idempotencyKey,
    })
    const starting = engineStarting(clientMessageId, this.nextSeq++)
    this.frames.push(starting)
    this.send(ws, starting)
    this.maybeDrop(ws)
  }

  onHello(ws, frame) {
    this.hellos += 1
    const peers = Array.isArray(frame.peers) ? frame.peers : []
    const match = peers.find((item) => item && item.peerId === SESSION_ID) || peers[0] || null
    const inFlight = !!(
      match?.inFlight &&
      match.inFlightClientMessageId === this.clientMessageId &&
      this.clientMessageId
    )
    const last = Number(match?.lastFrameSeq) || 0
    this.note(
      `hello inFlight=${inFlight} last=${last} budget=${this.dropBudget} status=${this.status}`,
    )
    queueMicrotask(() => {
      if (ws.readyState !== 1) return
      if (this.suppressHelloBody) {
        this.send(ws, relayReady())
        return
      }
      if (this.finishAfterDrops && this.dropBudget <= 0 && this.status === 'open' && inFlight) {
        this.emitFinal(TERMINAL_MARKER)
      }
      if (this.status === 'open' && this.clientMessageId) {
        this.send(ws, this.snapshotFrame())
      }
      if (match?.peerId === SESSION_ID) {
        this.send(ws, {
          type: 'outbound.session_snapshot', channel: 'webchat', peer: peer(),
          snapshot: this.sessionSnapshot({ afterSeq: match.lastFrameSeq, streamKey: match.lastStreamKey }),
        })
      }
      for (const item of this.frames) {
        if (!isReplayable(item)) continue
        if ((item.frameSeq || 0) <= last) continue
        this.send(ws, item)
      }
      this.send(ws, relayReady())
      if (this.status === 'open' && inFlight) this.maybeDrop(ws)
    })
  }

  handleSocket(ws) {
    this.connections += 1
    this.note(`open #${this.connections}`)
    this.send(ws, relayReady())
    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!frame || typeof frame.type !== 'string') return
      if (frame.type === 'ping') {
        this.send(ws, { type: 'pong', id: frame.id })
        return
      }
      if (frame.type === 'inbound.hello') {
        this.onHello(ws, frame)
        return
      }
      if (frame.type === 'inbound.message') {
        this.admit(ws, frame)
        return
      }
      if (frame.type === 'inbound.control.stop') {
        this.send(ws, {
          type: 'outbound.control.receipt',
          controlId: frame.controlId,
          controlKind: 'stop',
          status: 'applied',
          peer: peer(),
          clientMessageId: frame.clientMessageId,
        })
      }
    })
    ws.on('close', () => {
      this.closes += 1
      this.note(`close total=${this.closes}`)
    })
  }
}

export async function startSessionDisplayGateway(assetDir) {
  const gateway = new MockGateway()
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const path = url.pathname
      if (path.startsWith('/api/')) {
        const sessionPath = `/api/sessions/${SESSION_ID}`
        if (
          req.method === 'GET' &&
          (path === `${sessionPath}/live-frames` || path.startsWith(`${sessionPath}/live-frames/`))
        ) {
          const query = {
            afterSeq: url.searchParams.get('afterSeq'),
            streamKey: url.searchParams.get('streamKey') ?? undefined,
            dispatch: url.searchParams.get('dispatch') ?? undefined,
          }
          gateway.snapshotReads.push(query)
          gateway.note(`HTTP snapshot afterSeq=${query.afterSeq} stream=${query.streamKey ?? '-'} dispatch=${query.dispatch ?? '-'}`)
          const body = JSON.stringify({
            ...gateway.liveFramesPage(),
            snapshot: gateway.sessionSnapshot(query),
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(body)
          return
        }
        if (req.method === 'GET' && path === sessionPath) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(gateway.sessionDetail()))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{}')
        return
      }
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
      const file = join(assetDir, rel)
      if (
        rel &&
        !rel.includes('..') &&
        (file === assetDir || file.startsWith(assetDir + sep)) &&
        existsSync(file) &&
        statSync(file).isFile()
      ) {
        res.writeHead(200, {
          'content-type': MIME[extname(file)] || 'application/octet-stream',
          'cache-control': 'no-store',
        })
        createReadStream(file).pipe(res)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(error?.stack ? error.stack : error))
    }
  })

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws/user-chat-bridge') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })
  wss.on('connection', (ws) => gateway.handleSocket(ws))

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  gateway.url = `http://127.0.0.1:${port}/`
  gateway.stop = async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(() => resolve()))
    await new Promise((resolve) => server.close(() => resolve()))
  }
  return gateway
}
