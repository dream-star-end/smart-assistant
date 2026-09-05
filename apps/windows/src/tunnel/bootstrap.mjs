/**
 * Outbound TLS for 18445/18446: device mTLS + SPKI pin of the origin leaf.
 * rejectUnauthorized is always true. checkServerIdentity always compares SPKI.
 * A localhost SAN P1 origin cert is accepted only when the pin matches.
 */

import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto'

export const DESKTOP_REGISTER_PATH = '/ws/desktop-container-register'

export function spkiSha256Base64FromDer(der) {
  if (!Buffer.isBuffer(der) || der.length === 0) {
    throw new Error('SPKI_PIN_INPUT: empty certificate DER')
  }
  const x = new X509Certificate(der)
  const spki = x.publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('base64')
}

export function spkiSha256Base64FromPem(pem) {
  if (typeof pem !== 'string' || !pem.includes('BEGIN CERTIFICATE')) {
    throw new Error('SPKI_PIN_INPUT: expected certificate PEM')
  }
  const x = new X509Certificate(pem)
  const spki = x.publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('base64')
}

export function pinsMatch(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

/**
 * Node tls.checkServerIdentity: return undefined to accept, Error to reject.
 * Pin match is the identity; hostname/SAN is not trusted on its own (R1).
 */
export function createSpkiPinChecker(expectedPin) {
  if (typeof expectedPin !== 'string' || expectedPin.length < 16) {
    throw new Error('spkiPin is required')
  }
  return function checkServerIdentity(_hostname, cert) {
    let got
    try {
      const der = cert && Buffer.isBuffer(cert.raw) ? cert.raw : null
      if (!der) {
        const err = new Error('SPKI_PIN_MISMATCH')
        err.code = 'ERR_TLS_SPKI_PIN_MISMATCH'
        return err
      }
      got = spkiSha256Base64FromDer(der)
    } catch (cause) {
      const err = new Error('SPKI_PIN_MISMATCH')
      err.code = 'ERR_TLS_SPKI_PIN_MISMATCH'
      err.cause = cause
      return err
    }
    if (!pinsMatch(expectedPin, got)) {
      const err = new Error('SPKI_PIN_MISMATCH')
      err.code = 'ERR_TLS_SPKI_PIN_MISMATCH'
      return err
    }
    return undefined
  }
}

export function parseRegisterUrl(registerOrigin) {
  if (typeof registerOrigin !== 'string' || registerOrigin.length === 0) {
    throw new Error('registerOrigin is required')
  }
  const raw = registerOrigin.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
  const url = new URL(raw)
  if (url.protocol !== 'wss:') {
    throw new Error('registerOrigin must be wss:// (TLS required)')
  }
  if (!url.pathname || url.pathname === '/') {
    url.pathname = DESKTOP_REGISTER_PATH
  }
  return url
}

export function parseHttpsOrigin(origin, label) {
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new Error(`${label} is required`)
  }
  const url = new URL(origin.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'))
  if (url.protocol !== 'https:') {
    throw new Error(`${label} must be https:// (TLS required)`)
  }
  return url
}

/**
 * Frozen TLS options for every outbound desktop connection.
 * Callers must not spread-overwrite rejectUnauthorized / checkServerIdentity.
 */
export function createOutboundTlsOptions({
  spkiPin,
  deviceCaPem,
  certPem,
  keyPem,
}) {
  if (typeof spkiPin !== 'string' || spkiPin.length < 16) {
    throw new Error('spkiPin is required')
  }
  if (typeof deviceCaPem !== 'string' || !deviceCaPem.includes('BEGIN CERTIFICATE')) {
    throw new Error('deviceCaPem is required')
  }
  if (typeof certPem !== 'string' || !certPem.includes('BEGIN CERTIFICATE')) {
    throw new Error('device cert PEM is required')
  }
  if (typeof keyPem !== 'string' || !keyPem.includes('BEGIN')) {
    throw new Error('device key PEM is required')
  }
  const checkServerIdentity = createSpkiPinChecker(spkiPin)
  return Object.freeze({
    ca: deviceCaPem,
    cert: certPem,
    key: keyPem,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    requestCert: false,
    rejectUnauthorized: true,
    checkServerIdentity,
  })
}

export function createBootstrap({
  registerOrigin,
  egressOrigin,
  spkiPin,
  deviceCaPem,
}) {
  const registerUrl = parseRegisterUrl(registerOrigin)
  const egressUrl = parseHttpsOrigin(egressOrigin, 'egressOrigin')
  return Object.freeze({
    registerOrigin: registerUrl.toString(),
    registerUrl,
    egressOrigin: egressUrl.toString(),
    egressUrl,
    spkiPin,
    deviceCaPem,
    tlsOptionsFor(identity) {
      return createOutboundTlsOptions({
        spkiPin,
        deviceCaPem,
        certPem: identity.getCertPem(),
        keyPem: identity.getKeyPem(),
      })
    },
  })
}
