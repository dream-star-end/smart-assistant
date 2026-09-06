import https from 'node:https'
import { createOutboundTlsOptions, parseHttpsOrigin } from '../tunnel/bootstrap.mjs'

export const TOKEN_MINT_PATH = '/api/desktop/token'
export const TOKEN_REFRESH_PATH = '/api/desktop/token/refresh'
export const DEFAULT_REFRESH_LEAD_MS = 10 * 60 * 1000

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks)))
    res.on('error', reject)
  })
}

function parseTokenResponse(status, raw) {
  let json
  try {
    json = JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    const err = new Error('token response is not JSON')
    err.code = 'BAD_TOKEN_RESPONSE'
    err.status = status
    throw err
  }
  if (status !== 200 || typeof json.token !== 'string' || !json.token.startsWith('oc-v3.')) {
    const err = new Error(json?.error?.message || `token HTTP ${status}`)
    err.code = json?.error?.code || 'TOKEN_HTTP'
    err.status = status
    throw err
  }
  return {
    token: json.token,
    expires_in: Number(json.expires_in) || 3600,
    container_id: json.container_id ?? null,
    generation: Number(json.generation) || 0,
  }
}

export function postDesktopToken({
  origin,
  path,
  tls,
  body,
  authorization,
  timeoutMs = 15_000,
}) {
  const url = parseHttpsOrigin(origin, 'tokenOrigin')
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'content-length': String(payload.length),
    host: url.host,
  }
  if (authorization) headers.authorization = authorization
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: Number(url.port) || 443,
      path,
      method: 'POST',
      headers,
      servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ? undefined : url.hostname,
      ca: tls.ca,
      cert: tls.cert,
      key: tls.key,
      minVersion: tls.minVersion ?? 'TLSv1.3',
      maxVersion: tls.maxVersion ?? 'TLSv1.3',
      rejectUnauthorized: true,
      checkServerIdentity: tls.checkServerIdentity,
    }, async (res) => {
      try {
        const raw = await collect(res)
        resolve(parseTokenResponse(res.statusCode, raw))
      } catch (err) {
        reject(err)
      }
    })
    const timer = setTimeout(() => {
      req.destroy()
      const err = new Error('token request timeout')
      err.code = 'TIMEOUT'
      reject(err)
    }, timeoutMs)
    timer.unref?.()
    req.on('error', reject)
    req.end(payload)
  })
}

export function createTokenMinter({
  identity,
  registerOrigin,
  spkiPin,
  deviceCaPem,
  refreshLeadMs = DEFAULT_REFRESH_LEAD_MS,
  now = () => Date.now(),
  onRotated,
  onError,
}) {
  let timer = null
  let stopped = true
  let inFlight = null

  const tlsFor = () => createOutboundTlsOptions({
    spkiPin,
    deviceCaPem,
    certPem: identity.getCertPem(),
    keyPem: identity.getKeyPem(),
  })

  function schedule(expiresInSec) {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (stopped) return
    const ttlMs = Math.max(1, Number(expiresInSec) * 1000)
    const delay = Math.max(50, ttlMs - refreshLeadMs)
    timer = setTimeout(() => {
      timer = null
      void refresh('schedule')
    }, delay)
    timer.unref?.()
  }

  async function applySession(result, reason) {
    identity.setSession(result.token, result.generation, result.container_id)
    onRotated?.({ reason, generation: result.generation, expires_in: result.expires_in })
    schedule(result.expires_in)
    return result
  }

  async function mint(reason = 'mint') {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const credential = identity.getDeviceCredential()
      const result = await postDesktopToken({
        origin: registerOrigin,
        path: TOKEN_MINT_PATH,
        tls: tlsFor(),
        body: { device_credential: credential },
        authorization: `Bearer ${credential}`,
      })
      return applySession(result, reason)
    })().catch((err) => {
      onError?.(err)
      throw err
    }).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function refresh(reason = 'refresh') {
    if (inFlight) return inFlight
    inFlight = (async () => {
      if (!identity.hasSession()) return mint(reason)
      const credential = identity.getDeviceCredential()
      const token = identity.getToken()
      const result = await postDesktopToken({
        origin: registerOrigin,
        path: TOKEN_REFRESH_PATH,
        tls: tlsFor(),
        body: { device_credential: credential, token },
        authorization: `Bearer ${token}`,
      })
      return applySession(result, reason)
    })().catch((err) => {
      onError?.(err)
      throw err
    }).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    mint,
    refresh,
    start(expiresInSec) {
      stopped = false
      if (expiresInSec != null) schedule(expiresInSec)
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    get now() {
      return now()
    },
  }
}
