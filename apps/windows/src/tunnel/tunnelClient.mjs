/**
 * Tunnel client state machine (§4): connecting / registered / degraded / offline.
 *
 * Sleep / network-change hooks are methods (S6 wires Electron powerMonitor).
 * Token refresh drops the current WSS and reconnects with the new token,
 * skipping the attempt while HTTP streams are in-flight (R4).
 */

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MUX_VERSION,
  REGISTER_TIMEOUT_MS,
} from './mux.mjs'
import { createBootstrap } from './bootstrap.mjs'
import { assertTunnelIdentity } from './identity.mjs'
import { RegisterError, mapClose, registerDesktopTunnel } from './register.mjs'
import { attachMuxHttpServer } from './muxHttpServer.mjs'

export const TunnelState = Object.freeze({
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  REGISTERED: 'registered',
  DEGRADED: 'degraded',
})

function jittered(base, jitter) {
  const span = base * jitter
  return Math.max(0, Math.round(base - span + Math.random() * 2 * span))
}

export function createTunnelClient(opts) {
  const {
    identity,
    registerOrigin,
    egressOrigin,
    spkiPin,
    deviceCaPem,
    containerId,
    keyringFp = '',
    handler,
    onOpenWs,
    onState,
    onUpdateRequired,
    onEvent,
    refreshToken,
    now = () => Date.now(),
    initialBackoffMs = 1_000,
    maxBackoffMs = 60_000,
    jitter = 0.2,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
    minHeartbeatIntervalMs = HEARTBEAT_MIN_INTERVAL_MS,
    registerTimeoutMs = REGISTER_TIMEOUT_MS,
    killSwitchBackoffMs = 30_000,
    connectTimeoutMs = 15_000,
  } = opts

  assertTunnelIdentity(identity)
  const beatGap = Math.max(minHeartbeatIntervalMs, 1)

  const bootstrap = createBootstrap({ registerOrigin, egressOrigin, spkiPin, deviceCaPem })
  let state = TunnelState.OFFLINE
  let stopped = true
  let updateRequired = false
  let ws = null
  let mux = null
  let backoffMs = initialBackoffMs
  let reconnectTimer = null
  let heartbeatTimer = null
  let lastHeartbeatAck = 0
  let lastHeartbeatSent = 0
  let missedAcks = 0
  let generation = typeof identity.getGeneration === 'function' ? identity.getGeneration() : 0
  let inFlightRefresh = null
  const connectTimes = []

  const emit = (event, extra = {}) => {
    onEvent?.(event, { state, ...extra })
  }

  const setState = (next) => {
    if (state === next) return
    state = next
    onState?.(next)
    emit('state', { state: next })
  }

  const clearTimers = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const dropSocket = (code, reason) => {
    const currentMux = mux
    const currentWs = ws
    mux = null
    ws = null
    lastHeartbeatAck = 0
    lastHeartbeatSent = 0
    missedAcks = 0
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    try { currentMux?.close() } catch { /* */ }
    try { currentWs?.close(code, reason) } catch { /* */ }
  }

  const scheduleReconnect = (reason, { minDelay } = {}) => {
    if (stopped || updateRequired) return
    setState(state === TunnelState.REGISTERED ? TunnelState.DEGRADED : TunnelState.DEGRADED)
    if (reconnectTimer) return
    const base = Math.max(minDelay ?? 0, backoffMs)
    const delay = jittered(base, jitter)
    emit('backoff', { reason, delay, backoffMs })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      backoffMs = Math.min(maxBackoffMs, Math.max(initialBackoffMs, backoffMs * 2))
      void connect('backoff')
    }, delay)
    reconnectTimer.unref?.()
  }

  const stopReconnectForever = (reason) => {
    updateRequired = reason === 'update_required' || reason === 'mux_version'
    stopped = true
    clearTimers()
    dropSocket(1008, reason)
    setState(TunnelState.OFFLINE)
    if (updateRequired) onUpdateRequired?.({ reason })
    emit('stopped', { reason })
  }

  const startHeartbeat = () => {
    lastHeartbeatAck = now()
    lastHeartbeatSent = 0
    missedAcks = 0
    const beat = () => {
      if (!ws || !mux) return
      const t = now()
      if (lastHeartbeatSent && t - lastHeartbeatSent < beatGap) return
      if (t - lastHeartbeatAck > heartbeatTimeoutMs) {
        missedAcks += 1
        emit('heartbeat_timeout', { missedAcks })
        if (missedAcks >= 1) {
          try { mux.goaway('heartbeat_timeout') } catch { /* */ }
          dropSocket(4001, 'heartbeat_timeout')
          scheduleReconnect('heartbeat_timeout')
        }
        return
      }
      lastHeartbeatSent = t
      try { mux.sendHeartbeat(t) } catch { /* */ }
    }
    beat()
    heartbeatTimer = setInterval(beat, heartbeatIntervalMs)
    heartbeatTimer.unref?.()
  }

  async function connect(reason = 'start') {
    if (stopped || updateRequired) return
    if (state === TunnelState.CONNECTING) return
    dropSocket(4001, 'reconnect')
    setState(TunnelState.CONNECTING)
    connectTimes.push(now())
    emit('connecting', { reason, generation })
    const tls = bootstrap.tlsOptionsFor(identity)
    try {
      const { ws: sock, ack } = await registerDesktopTunnel({
        registerUrl: bootstrap.registerUrl,
        tls,
        identity,
        containerId,
        keyringFp,
        muxVersion: MUX_VERSION,
        timeoutMs: registerTimeoutMs,
        connectTimeoutMs,
      })
      ws = sock
      mux = attachMuxHttpServer({
        transport: {
          send(data) {
            sock.sendBinary(data)
          },
          close(code, why) {
            sock.close(code, why)
          },
          terminate() {
            sock.terminate()
          },
          on(event, cb) {
            sock.on(event, cb)
          },
          off(event, cb) {
            sock.off(event, cb)
          },
        },
        handler,
        onOpenWs,
        onHeartbeatAck() {
          lastHeartbeatAck = now()
          missedAcks = 0
        },
        onFailClosed(err) {
          emit('fail_closed', { message: err.message, code: err.code })
          dropSocket(4001, err.message)
          if (!stopped && !updateRequired) scheduleReconnect('fail_closed')
        },
      })
      sock.on('close', (code, reasonBuf) => {
        const why = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf ?? '')
        const mapped = mapClose(code, why)
        emit('ws_close', { code, reason: why, mapped: mapped.code })
        dropSocket(code, why)
        if (stopped || updateRequired) return
        if (mapped.code === 'UPDATE_REQUIRED' || mapped.code === 'MUX_VERSION') {
          stopReconnectForever(mapped.code === 'MUX_VERSION' ? 'mux_version' : 'update_required')
          return
        }
        if (mapped.code === 'STALE_GENERATION') {
          void rotateAndReconnect('stale_generation')
          return
        }
        scheduleReconnect(mapped.code || 'ws_close')
      })
      backoffMs = initialBackoffMs
      generation = ack.generation ?? generation
      setState(TunnelState.REGISTERED)
      startHeartbeat()
      emit('register_ok', { ack })
    } catch (err) {
      emit('connect_error', { code: err?.code, message: err?.message, status: err?.status })
      dropSocket(4001, err?.message)
      if (stopped || updateRequired) return
      if (err instanceof RegisterError && (err.code === 'UPDATE_REQUIRED' || err.code === 'MUX_VERSION')) {
        stopReconnectForever(err.code === 'MUX_VERSION' ? 'mux_version' : 'update_required')
        return
      }
      if (err instanceof RegisterError && err.code === 'FLAG_OFF') {
        stopReconnectForever('flag_off')
        return
      }
      if (err instanceof RegisterError && err.code === 'KILLSWITCH') {
        setState(TunnelState.DEGRADED)
        scheduleReconnect('killswitch', { minDelay: killSwitchBackoffMs })
        return
      }
      if (err instanceof RegisterError && (err.code === 'STALE_GENERATION' || err.code === 'UNAUTHORIZED')) {
        void rotateAndReconnect(err.code)
        return
      }
      scheduleReconnect(err?.code || 'connect_error')
    }
  }

  async function rotateAndReconnect(reason) {
    if (stopped || updateRequired) return
    if (inFlightRefresh) return inFlightRefresh
    inFlightRefresh = (async () => {
      emit('token_refresh', { reason, inFlight: mux?.size ?? 0 })
      const waitStart = now()
      while (mux && mux.size > 0 && now() - waitStart < 5_000) {
        await new Promise((r) => setTimeout(r, 50))
      }
      dropSocket(4001, 'token_rotated')
      if (typeof refreshToken === 'function') {
        try {
          const next = await refreshToken({ reason, generation })
          if (next?.token) identity.setSession?.(next.token, next.generation)
          if (typeof next?.generation === 'number') generation = next.generation
        } catch (err) {
          emit('token_refresh_failed', { message: err.message })
          scheduleReconnect('token_refresh_failed')
          return
        }
      }
      backoffMs = initialBackoffMs
      await connect('token_refresh')
    })().finally(() => {
      inFlightRefresh = null
    })
    return inFlightRefresh
  }

  return {
    get state() {
      return state
    },
    get generation() {
      return generation
    },
    get bootstrap() {
      return bootstrap
    },
    get muxSize() {
      return mux?.size ?? 0
    },
    get connectTimes() {
      return connectTimes.slice()
    },
    get updateRequired() {
      return updateRequired
    },
    get stopped() {
      return stopped
    },
    start() {
      stopped = false
      updateRequired = false
      backoffMs = initialBackoffMs
      void connect('start')
    },
    stop(reason = 'stop') {
      stopped = true
      clearTimers()
      dropSocket(1000, reason)
      setState(TunnelState.OFFLINE)
    },
    onSuspend() {
      emit('suspend', {})
      try { mux?.goaway('suspend') } catch { /* */ }
      dropSocket(4001, 'suspend')
      if (!stopped && !updateRequired) setState(TunnelState.DEGRADED)
    },
    onResume() {
      emit('resume', {})
      if (stopped || updateRequired) return
      backoffMs = initialBackoffMs
      void connect('resume')
    },
    onNetworkChange() {
      emit('network_change', {})
      try { mux?.goaway('network_change') } catch { /* */ }
      dropSocket(4001, 'network_change')
      if (stopped || updateRequired) return
      backoffMs = initialBackoffMs
      void connect('network_change')
    },
    refreshAndReconnect(reason = 'manual_refresh') {
      return rotateAndReconnect(reason)
    },
    send(frame) {
      if (!ws) throw new Error('not registered')
      ws.sendBinary(frame)
    },
    sendHeartbeat() {
      mux?.sendHeartbeat(now())
    },
  }
}

