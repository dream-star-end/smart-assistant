/**
 * OCV5-890 Layer 3 — R8 Anti-Loopback Single-Use Scoped Capability Token (`octk1`).
 *
 * Wire format:
 *   octk1.<base64url(canonicalJSON(claims))>.<base64url(rfc2104HmacSha256(secret, headerAndPayload))>
 *
 * Architecture invariants:
 * - R3-crypto: zero calls to `createHmac`, `timingSafeEqual`, `createSign`, `createVerify`.
 *   Uses RFC 2104 HMAC-SHA256 built directly on `createHash('sha256')` (`ipad 0x36` / `opad 0x5c`)
 *   and constant-time byte XOR comparison.
 * - R3-env: zero `process.env` reads; secret & limits passed via options.
 */
import { createHash, randomBytes } from 'node:crypto'
import { remoteCanonicalJson } from '@openclaude/protocol'

export const SCOPED_CAPABILITY_TOKEN_PREFIX = 'octk1'
const SHA256_BLOCK_BYTES = 64
const DEFAULT_TOKEN_TTL_MS = 30_000
const DEFAULT_MAX_CONSUMED_NONCES = 10_000

export type ScopedCapabilityTokenErrorCode =
  | 'CAPABILITY_TOKEN_SECRET_INVALID'
  | 'CAPABILITY_TOKEN_MALFORMED'
  | 'CAPABILITY_TOKEN_SIGNATURE_INVALID'
  | 'CAPABILITY_TOKEN_CLAIMS_INVALID'
  | 'CAPABILITY_TOKEN_EXPIRED'
  | 'CAPABILITY_TOKEN_TOOL_MISMATCH'
  | 'CAPABILITY_TOKEN_SESSION_MISMATCH'
  | 'CAPABILITY_TOKEN_LEASE_MISMATCH'
  | 'CAPABILITY_TOKEN_CALL_MISMATCH'
  | 'CAPABILITY_TOKEN_BRAIN_GEN_STALE'
  | 'CAPABILITY_TOKEN_REPLAYED'
  | 'CAPABILITY_TOKEN_REPLAY_CACHE_FULL'

export class ScopedCapabilityTokenError extends Error {
  readonly code: ScopedCapabilityTokenErrorCode

  constructor(code: ScopedCapabilityTokenErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ScopedCapabilityTokenError'
    this.code = code
  }
}

/**
 * Standard RFC 2104 HMAC-SHA256 constructed from `createHash('sha256')` with `ipad=0x36`, `opad=0x5c`.
 */
export function rfc2104HmacSha256(
  secret: Uint8Array | string,
  message: Uint8Array | string,
): Buffer {
  const keyRaw = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret)
  const msgBuf = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message)

  const keyBlock = Buffer.alloc(SHA256_BLOCK_BYTES, 0)
  if (keyRaw.length > SHA256_BLOCK_BYTES) {
    createHash('sha256').update(keyRaw).digest().copy(keyBlock, 0)
  } else {
    keyRaw.copy(keyBlock, 0)
  }

  const ipad = Buffer.allocUnsafe(SHA256_BLOCK_BYTES)
  const opad = Buffer.allocUnsafe(SHA256_BLOCK_BYTES)
  for (let i = 0; i < SHA256_BLOCK_BYTES; i++) {
    const kb = keyBlock[i]!
    ipad[i] = kb ^ 0x36
    opad[i] = kb ^ 0x5c
  }

  const innerDigest = createHash('sha256').update(ipad).update(msgBuf).digest()
  return createHash('sha256').update(opad).update(innerDigest).digest()
}

/**
 * Constant-time byte-by-byte XOR comparison (no early exit on mismatch).
 */
export function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  const maxLen = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < maxLen; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export interface ScopedToolCapabilityClaims {
  readonly callId: string
  readonly toolName: string
  readonly sessionKey: string
  readonly leaseId: string
  readonly brainGen: number
  readonly nonce: string
  readonly issuedAtMs: number
  readonly expiresAtMs: number
}

export interface IssueScopedCapabilityTokenInput {
  readonly callId: string
  readonly toolName: string
  readonly sessionKey: string
  readonly leaseId: string
  readonly brainGen: number
  readonly nonce?: string
  readonly issuedAtMs?: number
  readonly expiresAtMs?: number
  readonly ttlMs?: number
}

export interface VerifyScopedCapabilityTokenExpected {
  readonly toolName: string
  readonly sessionKey: string
  readonly leaseId: string
  readonly callId?: string
  readonly minBrainGen?: number
  readonly nowMs?: number
}

export interface ScopedCapabilityTokenAuthorityOptions {
  readonly secret: Uint8Array | string
  readonly defaultTtlMs?: number
  readonly maxConsumedNonces?: number
  readonly clock?: () => number
}

function isNonEmptyString(v: unknown, maxLen = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen
}

function isValidBase64Url(v: string): boolean {
  return v.length > 0 && /^[A-Za-z0-9_-]+$/.test(v)
}

function validateClaims(raw: unknown): ScopedToolCapabilityClaims {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScopedCapabilityTokenError('CAPABILITY_TOKEN_CLAIMS_INVALID', 'Claims must be object')
  }
  const c = raw as Record<string, unknown>
  const keys = Object.keys(c)
  if (keys.length !== 8) {
    throw new ScopedCapabilityTokenError(
      'CAPABILITY_TOKEN_CLAIMS_INVALID',
      'Unexpected claim keys in capability token',
    )
  }
  if (
    !isNonEmptyString(c.callId) ||
    !isNonEmptyString(c.toolName) ||
    !isNonEmptyString(c.sessionKey, 512) ||
    !isNonEmptyString(c.leaseId) ||
    !isNonEmptyString(c.nonce) ||
    typeof c.brainGen !== 'number' ||
    !Number.isSafeInteger(c.brainGen) ||
    c.brainGen < 1 ||
    typeof c.issuedAtMs !== 'number' ||
    !Number.isSafeInteger(c.issuedAtMs) ||
    c.issuedAtMs < 0 ||
    typeof c.expiresAtMs !== 'number' ||
    !Number.isSafeInteger(c.expiresAtMs) ||
    c.expiresAtMs <= c.issuedAtMs
  ) {
    throw new ScopedCapabilityTokenError(
      'CAPABILITY_TOKEN_CLAIMS_INVALID',
      'Invalid claim field value in capability token',
    )
  }

  return Object.freeze({
    callId: c.callId,
    toolName: c.toolName,
    sessionKey: c.sessionKey,
    leaseId: c.leaseId,
    brainGen: c.brainGen,
    nonce: c.nonce,
    issuedAtMs: c.issuedAtMs,
    expiresAtMs: c.expiresAtMs,
  })
}

export class ScopedCapabilityTokenAuthority {
  private readonly secret: Buffer
  private readonly defaultTtlMs: number
  private readonly maxConsumedNonces: number
  private readonly clock: () => number
  private readonly consumedNonces = new Map<string, number>()

  constructor(opts: ScopedCapabilityTokenAuthorityOptions) {
    const secretBuf =
      typeof opts.secret === 'string' ? Buffer.from(opts.secret, 'utf8') : Buffer.from(opts.secret)
    if (secretBuf.length < 16) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_SECRET_INVALID',
        'Capability token secret must be at least 16 bytes',
      )
    }
    this.secret = secretBuf
    this.defaultTtlMs = Math.max(1, Math.floor(opts.defaultTtlMs ?? DEFAULT_TOKEN_TTL_MS))
    this.maxConsumedNonces = Math.max(
      1,
      Math.floor(opts.maxConsumedNonces ?? DEFAULT_MAX_CONSUMED_NONCES),
    )
    this.clock = opts.clock ?? (() => Date.now())
  }

  issueToken(input: IssueScopedCapabilityTokenInput): {
    readonly token: string
    readonly claims: ScopedToolCapabilityClaims
  } {
    const issuedAtMs = Math.floor(input.issuedAtMs ?? this.clock())
    const ttlMs = Math.max(1, Math.floor(input.ttlMs ?? this.defaultTtlMs))
    const expiresAtMs = Math.floor(input.expiresAtMs ?? issuedAtMs + ttlMs)
    const nonce = input.nonce ?? randomBytes(16).toString('base64url')

    const claims = validateClaims({
      callId: input.callId,
      toolName: input.toolName,
      sessionKey: input.sessionKey,
      leaseId: input.leaseId,
      brainGen: input.brainGen,
      nonce,
      issuedAtMs,
      expiresAtMs,
    })

    const canonical = remoteCanonicalJson(claims)
    const payloadB64 = Buffer.from(canonical, 'utf8').toString('base64url')
    const headerAndPayload = `${SCOPED_CAPABILITY_TOKEN_PREFIX}.${payloadB64}`
    const mac = rfc2104HmacSha256(this.secret, headerAndPayload)
    const sigB64 = mac.toString('base64url')

    return {
      token: `${headerAndPayload}.${sigB64}`,
      claims,
    }
  }

  verifyAndConsumeToken(
    token: string,
    expected: VerifyScopedCapabilityTokenExpected,
  ): ScopedToolCapabilityClaims {
    if (typeof token !== 'string' || token.length === 0) {
      throw new ScopedCapabilityTokenError('CAPABILITY_TOKEN_MALFORMED', 'Empty capability token')
    }
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_MALFORMED',
        'Capability token must have 3 dot-separated segments',
      )
    }
    const [prefix, payloadB64, sigB64] = parts
    if (
      prefix !== SCOPED_CAPABILITY_TOKEN_PREFIX ||
      !payloadB64 ||
      !sigB64 ||
      !isValidBase64Url(payloadB64) ||
      !isValidBase64Url(sigB64)
    ) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_MALFORMED',
        'Invalid capability token prefix or encoding',
      )
    }

    const headerAndPayload = `${prefix}.${payloadB64}`
    const expectedMac = rfc2104HmacSha256(this.secret, headerAndPayload)
    const providedMac = Buffer.from(sigB64, 'base64url')
    if (!constantTimeBytesEqual(providedMac, expectedMac)) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_SIGNATURE_INVALID',
        'Capability token signature verification failed',
      )
    }

    let parsed: unknown
    let decodedUtf8: string
    try {
      decodedUtf8 = Buffer.from(payloadB64, 'base64url').toString('utf8')
      parsed = JSON.parse(decodedUtf8)
    } catch {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_CLAIMS_INVALID',
        'Failed to decode capability token claims JSON',
      )
    }

    const claims = validateClaims(parsed)
    if (remoteCanonicalJson(claims) !== decodedUtf8) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_CLAIMS_INVALID',
        'Capability token claims are not canonically encoded',
      )
    }

    const nowMs = expected.nowMs ?? this.clock()
    if (nowMs > claims.expiresAtMs) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_EXPIRED',
        `Capability token expired at ${claims.expiresAtMs} (now=${nowMs})`,
      )
    }

    if (claims.toolName !== expected.toolName) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_TOOL_MISMATCH',
        `Token toolName "${claims.toolName}" does not match expected "${expected.toolName}"`,
      )
    }
    if (claims.sessionKey !== expected.sessionKey) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_SESSION_MISMATCH',
        `Token sessionKey mismatch`,
      )
    }
    if (claims.leaseId !== expected.leaseId) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_LEASE_MISMATCH',
        `Token leaseId "${claims.leaseId}" does not match expected "${expected.leaseId}"`,
      )
    }
    if (expected.callId !== undefined && claims.callId !== expected.callId) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_CALL_MISMATCH',
        `Token callId "${claims.callId}" does not match expected "${expected.callId}"`,
      )
    }
    if (expected.minBrainGen !== undefined && claims.brainGen < expected.minBrainGen) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_BRAIN_GEN_STALE',
        `Token brainGen ${claims.brainGen} < required ${expected.minBrainGen}`,
      )
    }

    const nonceKey = `${claims.leaseId}:${claims.nonce}`
    if (this.consumedNonces.has(nonceKey)) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_REPLAYED',
        `Capability token nonce ${claims.nonce} has already been consumed`,
      )
    }

    this.recordConsumedNonce(nonceKey, claims.expiresAtMs, nowMs)
    return claims
  }

  get consumedNonceCount(): number {
    return this.consumedNonces.size
  }

  private recordConsumedNonce(nonceKey: string, expiresAtMs: number, nowMs: number): void {
    if (this.consumedNonces.size >= this.maxConsumedNonces) {
      for (const [k, exp] of this.consumedNonces) {
        if (exp < nowMs) this.consumedNonces.delete(k)
      }
    }
    if (this.consumedNonces.size >= this.maxConsumedNonces) {
      throw new ScopedCapabilityTokenError(
        'CAPABILITY_TOKEN_REPLAY_CACHE_FULL',
        `Consumed nonce replay cache is full (${this.consumedNonces.size}/${this.maxConsumedNonces}); refusing to evict unexpired nonces`,
      )
    }
    this.consumedNonces.set(nonceKey, expiresAtMs)
  }
}
