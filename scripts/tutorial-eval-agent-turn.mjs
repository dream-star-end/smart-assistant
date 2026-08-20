#!/usr/bin/env node
import { createHmac, randomBytes } from 'node:crypto'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const config = JSON.parse(Buffer.concat(chunks).toString('utf8'))
if (
  !Number.isSafeInteger(config.uid) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(config.caseId ?? '') ||
  typeof config.prompt !== 'string' ||
  !config.prompt.trim() ||
  typeof config.model !== 'string' ||
  typeof config.agentId !== 'string'
) {
  throw new Error('invalid tutorial eval turn config')
}
const secret = process.env.COMMERCIAL_JWT_SECRET
if (!secret || Buffer.byteLength(secret) < 32) throw new Error('COMMERCIAL_JWT_SECRET missing')
const base = String(config.baseUrl ?? 'http://127.0.0.1:18790').replace(/\/$/, '')
const now = Math.floor(Date.now() / 1000)
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const header = encode({ alg: 'HS256', typ: 'JWT' })
const payload = encode({
  role: 'user',
  sub: String(config.uid),
  iat: now,
  exp: now + 1800,
  jti: randomBytes(16).toString('hex'),
})
const unsigned = `${header}.${payload}`
const token = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`
const peerId = `te_${config.caseId.slice(0, 18)}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
const clientMessageId = `tutevalmsg_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`
const put = await fetch(`${base}/api/sessions/${peerId}`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    agentId: config.agentId,
    title: `教程评测 · ${config.caseId}`,
    modelId: config.model,
    messages: [],
  }),
})
if (!put.ok) throw new Error(`session PUT ${put.status}: ${(await put.text()).slice(0, 200)}`)

const frames = []
const startedAt = Date.now()
const readyDeadline = startedAt + 10 * 60_000
let finalText = ''
let finalFrame = null
let sent = false

await new Promise((resolve, reject) => {
  const hardDeadline = setTimeout(() => reject(new Error('tutorial eval turn timeout')), 30 * 60_000)
  const connect = () => {
    const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws/user-chat-bridge', [
      'bearer',
      token,
    ])
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(hardDeadline)
      try { socket.close() } catch {}
      reject(error)
    }
    socket.addEventListener('message', (event) => {
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        fail(new Error('relay returned non-JSON frame'))
        return
      }
      if (frames.length < 10_000) frames.push(frame)
      if (!sent && frame?.type === 'sys.relay_ready') {
        sent = true
        socket.send(JSON.stringify({
          type: 'inbound.message',
          channel: 'webchat',
          peer: { id: peerId, kind: 'dm' },
          clientMessageId,
          agentId: config.agentId,
          model: config.model,
          content: { text: config.prompt },
          ts: Date.now(),
        }))
        return
      }
      if (frame?.type === 'outbound.message' && frame?.peer?.id === peerId) {
        for (const block of frame.blocks ?? []) {
          if (block?.kind === 'text' && typeof block.text === 'string') finalText += block.text
        }
        if (frame.isFinal === true) {
          finalFrame = frame
          settled = true
          clearTimeout(hardDeadline)
          socket.close(1000, 'captured')
          resolve()
        }
      } else if (
        frame?.type === 'outbound.error' ||
        frame?.type === 'outbound.turn_error' ||
        frame?.error
      ) {
        fail(new Error(`turn error: ${JSON.stringify(frame).slice(0, 500)}`))
      }
    })
    socket.addEventListener('error', () => {
      if (sent) fail(new Error('relay websocket error after send'))
    })
    socket.addEventListener('close', (event) => {
      if (settled || finalFrame) return
      if (!sent && Date.now() < readyDeadline && event.code === 4503) {
        setTimeout(connect, 3000)
        return
      }
      fail(new Error(`relay closed before final (${event.code})`))
    })
  }
  connect()
})

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  sourceSessionId: peerId,
  clientMessageId,
  finalText,
  finalFrame,
  frames,
  wallMs: Date.now() - startedAt,
}) + '\n')
