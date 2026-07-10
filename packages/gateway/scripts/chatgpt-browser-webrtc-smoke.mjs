#!/usr/bin/env node
// Automated real-transport smoke for the ChatGPT browser sidecar.
//
// Required: OC_CGB_TOKEN (read it from the running sidecar process environment
// inside the invoking shell; never print it). Optional overrides:
// OC_CGB_PORT, OC_CGB_RUNTIME_DIR, OC_CGB_SMOKE_USER, OC_CGB_SMOKE_WIDTH/HEIGHT/DPR.

import { createRequire } from 'node:module'

const runtimeDir = process.env.OC_CGB_RUNTIME_DIR || '/opt/openclaude/chatgpt-browser'
const require = createRequire(`${runtimeDir}/package.json`)
const WebSocket = require('ws')
const wrtc = require('@roamhq/wrtc')

const token = process.env.OC_CGB_TOKEN || ''
const port = Number(process.env.OC_CGB_PORT || '18994')
const user = process.env.OC_CGB_SMOKE_USER || `smoke-${Date.now()}`
const width = Number(process.env.OC_CGB_SMOKE_WIDTH || '428')
const height = Number(process.env.OC_CGB_SMOKE_HEIGHT || '674')
const dpr = Number(process.env.OC_CGB_SMOKE_DPR || '2')
const expectedWidth = Math.round(width * Math.min(Math.max(dpr, 1), 2)) & ~1
const expectedHeight = Math.round(height * Math.min(Math.max(dpr, 1), 2)) & ~1

if (!token) {
  console.error('OC_CGB_TOKEN is required')
  process.exit(2)
}
if (!/^smoke-[A-Za-z0-9._-]{1,96}$/.test(user)) {
  console.error('OC_CGB_SMOKE_USER must use a disposable smoke-* identity')
  process.exit(2)
}

const startedAt = Date.now()
const result = {
  ready: false,
  connected: false,
  codec: '',
  controlOpen: false,
  fastOpen: false,
  exactFrame: false,
  fallbackJpeg: false,
  frame: null,
  elapsedMs: 0,
}
let finished = false
let pc = null
let sink = null
let remoteSet = false
const remoteCandidates = []
let fallbackRequested = false
let controlChannel = null
let fastChannel = null

const ws = new WebSocket(
  `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}`,
)
const timeout = setTimeout(() => finish(new Error('smoke timeout')), 35_000)

function send(obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

function maybeRequestFallback() {
  if (
    fallbackRequested ||
    !result.exactFrame ||
    !result.connected ||
    !result.controlOpen ||
    !result.fastOpen
  ) {
    return
  }
  fallbackRequested = true
  send({ t: 'webrtc-active' })
  setTimeout(() => send({ t: 'webrtc-fallback', reason: 'automated-smoke' }), 250)
}

function finish(err) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  result.elapsedMs = Date.now() - startedAt
  try {
    sink?.stop()
  } catch {}
  try {
    pc?.close()
  } catch {}
  // The smoke profile is disposable; wipe it through the same validated input
  // path so production never accumulates test login/profile state.
  send({ t: 'clearLogin' })
  setTimeout(() => {
    try {
      ws.close()
    } catch {}
    console.log(JSON.stringify({ ok: !err, ...result, error: err?.message }, null, 2))
    process.exit(err ? 1 : 0)
  }, 150)
}

ws.on('message', async (data, isBinary) => {
  if (isBinary) {
    if (fallbackRequested) {
      result.fallbackJpeg = true
      finish()
    }
    return
  }
  let message
  try {
    message = JSON.parse(data.toString('utf8'))
  } catch {
    return
  }
  if (message.t === 'status' && message.state === 'ready') {
    result.ready = true
    send({ t: 'resize', w: width, h: height, dpr, mode: 'clear' })
    return
  }
  if (message.t === 'webrtc-candidate') {
    if (!pc || !message.candidate) return
    if (remoteSet) await pc.addIceCandidate(message.candidate).catch(() => {})
    else remoteCandidates.push(message.candidate)
    return
  }
  if (message.t === 'webrtc-state' && message.state === 'connected') {
    result.connected = true
    maybeRequestFallback()
    return
  }
  if (message.t !== 'webrtc-offer') return

  pc = new wrtc.RTCPeerConnection({ iceServers: message.iceServers || [] })
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ t: 'webrtc-candidate', candidate: event.candidate.toJSON() })
    }
  }
  pc.ondatachannel = (event) => {
    if (event.channel.label === 'cgb-control') {
      controlChannel = event.channel
      controlChannel.onopen = () => {
        result.controlOpen = true
        maybeRequestFallback()
      }
    } else if (event.channel.label === 'cgb-fast') {
      fastChannel = event.channel
      fastChannel.onopen = () => {
        result.fastOpen = true
        maybeRequestFallback()
      }
    }
  }
  pc.ontrack = (event) => {
    if (event.track.kind !== 'video') return
    sink = new wrtc.nonstandard.RTCVideoSink(event.track)
    sink.onframe = ({ frame }) => {
      result.frame = [frame.width, frame.height]
      if (frame.width === expectedWidth && frame.height === expectedHeight) {
        result.exactFrame = true
        maybeRequestFallback()
      }
    }
  }
  await pc.setRemoteDescription(message.sdp)
  remoteSet = true
  for (const candidate of remoteCandidates.splice(0)) {
    await pc.addIceCandidate(candidate).catch(() => {})
  }
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  result.codec = (message.sdp.sdp.match(/a=rtpmap:\d+ (VP9|H264|VP8|AV1)\/90000/i) || [])[1] || ''
  send({
    t: 'webrtc-answer',
    sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
  })
})

ws.on('error', (err) => finish(err))
ws.on('close', () => {
  if (!finished) finish(new Error('sidecar closed before smoke completed'))
})
