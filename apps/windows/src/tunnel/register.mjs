/**
 * WSS register client for GET /ws/desktop-container-register.
 * Contrasts packages/commercial/src/ws/desktopRegister.ts.
 */

import { MUX_VERSION, REGISTER_TIMEOUT_MS } from './mux.mjs'
import { connectWss } from './wss.mjs'
import { assertTunnelIdentity } from './identity.mjs'
import { DESKTOP_REGISTER_PATH } from './bootstrap.mjs'

export class RegisterError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'RegisterError'
    this.code = code
    Object.assign(this, extra)
  }
}

export function buildRegisterMessage({
  containerId,
  muxVersion = MUX_VERSION,
  keyringFp,
}) {
  if (!Number.isInteger(containerId) || containerId <= 0) {
    throw new RegisterError('BAD_REGISTER', 'containerId required')
  }
  if (typeof keyringFp !== 'string') {
    throw new RegisterError('BAD_REGISTER', 'keyringFp required')
  }
  return {
    type: 'register',
    v: 1,
    containerId,
    muxVersion,
    keyringFp,
  }
}

function parseRegisterPayload(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    throw new RegisterError('BAD_REGISTER', 'register ack is not JSON')
  }
  if (!msg || typeof msg !== 'object') {
    throw new RegisterError('BAD_REGISTER', 'register ack is not an object')
  }
  return msg
}

/**
 * Perform mTLS WSS upgrade + register JSON + wait for register_ok.
 * On success the socket is still open and ready for mux binary frames.
 */
export async function registerDesktopTunnel({
  registerUrl,
  tls,
  identity,
  containerId,
  keyringFp,
  muxVersion = MUX_VERSION,
  timeoutMs = REGISTER_TIMEOUT_MS,
  connectTimeoutMs = 15_000,
}) {
  assertTunnelIdentity(identity)
  const token = identity.getToken()
  if (typeof token !== 'string' || !token.startsWith('oc-v3.')) {
    throw new RegisterError('BAD_TOKEN', 'identity token must be oc-v3.*')
  }
  const url = typeof registerUrl === 'string' ? new URL(registerUrl) : registerUrl
  if (!url.pathname || url.pathname === '/') url.pathname = DESKTOP_REGISTER_PATH

  let ws
  try {
    ws = await connectWss({
      url,
      tls,
      timeoutMs: connectTimeoutMs,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
  } catch (err) {
    if (err && err.code === 'HTTP_STATUS') {
      throw new RegisterError(
        err.status === 503 ? 'KILLSWITCH' : err.status === 404 ? 'FLAG_OFF' : err.status === 401 ? 'UNAUTHORIZED' : 'HTTP_STATUS',
        err.message,
        { status: err.status, body: err.body },
      )
    }
    throw err
  }

  const msg = buildRegisterMessage({ containerId, muxVersion, keyringFp })
  return await waitRegisterAck(ws, msg, timeoutMs)
}

export function waitRegisterAck(ws, registerMessage, timeoutMs = REGISTER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      ws.off('error', onError)
      if (err) reject(err)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      try { ws.close(1008, 'register_timeout') } catch { /* */ }
      finish(new RegisterError('REGISTER_TIMEOUT', 'no register ack within 10s'))
    }, timeoutMs)
    timer.unref?.()

    const onMessage = (raw) => {
      let ack
      try {
        ack = parseRegisterPayload(raw)
      } catch (err) {
        try { ws.close(1008, 'bad_register') } catch { /* */ }
        finish(err)
        return
      }
      if (ack.type === 'register_ok' && ack.v === 1) {
        finish(null, { ws, ack })
        return
      }
      try { ws.close(1008, 'bad_register') } catch { /* */ }
      finish(new RegisterError('BAD_REGISTER', `unexpected first frame type ${ack.type}`))
    }
    const onClose = (code, reasonBuf) => {
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf ?? '')
      const mapped = mapClose(code, reason)
      finish(mapped)
    }
    const onError = (err) => {
      finish(err instanceof Error ? err : new RegisterError('WS_ERROR', String(err)))
    }
    ws.on('message', onMessage)
    ws.on('close', onClose)
    ws.on('error', onError)
    try {
      ws.sendText(JSON.stringify(registerMessage))
    } catch (err) {
      finish(err)
    }
  })
}

export function mapClose(code, reason) {
  const why = String(reason ?? '')
  if (why === 'update_required' || (code === 1008 && why.includes('update_required'))) {
    return new RegisterError('UPDATE_REQUIRED', 'server requested update', { closeCode: code, reason: why })
  }
  if (why === 'mux_version') {
    return new RegisterError('MUX_VERSION', 'client mux version rejected', { closeCode: code, reason: why })
  }
  if (why === 'stale_generation') {
    return new RegisterError('STALE_GENERATION', 'token generation fenced', { closeCode: code, reason: why })
  }
  if (why === 'register_timeout') {
    return new RegisterError('REGISTER_TIMEOUT', 'server register timeout', { closeCode: code, reason: why })
  }
  if (why === 'replaced' || why === 'desktop_tunnel_dropped' || why === 'token_rotated') {
    return new RegisterError('REPLACED', why, { closeCode: code, reason: why })
  }
  return new RegisterError('WS_CLOSE', `wss closed ${code} ${why}`.trim(), { closeCode: code, reason: why })
}
