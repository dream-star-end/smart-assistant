import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function generateAccessToken(): string {
  return randomBytes(32).toString('hex')
}

export function checkToken(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

// ── Password hashing (scrypt) ──

const SCRYPT_KEYLEN = 64
const SCRYPT_COST = 16384 // N
const SCRYPT_BLOCK = 8    // r
const SCRYPT_PARALLEL = 1 // p

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST, r: SCRYPT_BLOCK, p: SCRYPT_PARALLEL,
  })
  return `${salt}:${derived.toString('hex')}`
}

export function verifyPassword(password: string, hash: string): boolean {
  const [salt, key] = hash.split(':')
  if (!salt || !key) return false
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST, r: SCRYPT_BLOCK, p: SCRYPT_PARALLEL,
  })
  try {
    return timingSafeEqual(derived, Buffer.from(key, 'hex'))
  } catch {
    return false
  }
}

// ── Lightweight JWT (HMAC-SHA256, no external deps) ──

export interface JwtPayload {
  userId: string
  exp: number // unix seconds
}

export function signJwt(payload: JwtPayload, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  if (sig.length !== expected.length) return null
  let diff = 0
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  if (diff !== 0) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload
    if (payload.exp && payload.exp < Date.now() / 1000) return null // expired
    return payload
  } catch {
    return null
  }
}
