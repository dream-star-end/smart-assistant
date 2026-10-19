/** Crypto boundary only. Persistence must use the installed-account transaction/fence. */
import { randomUUID } from 'node:crypto'
import { decryptToBuffer, encrypt } from '../../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../../crypto/keys.js'
import { LiteratureError } from './errors.js'
import { LITERATURE_SITE } from './policy.js'

export interface LiteratureCredentials {
  schemaVersion: 1
  username: string
  password: string
}
export interface LiteratureSecretScope {
  userId: number
  accountId: string
}
export interface SealedLiteratureCredentials {
  schemaVersion: 1
  aadSeed: string
  ciphertext: Buffer
  nonce: Buffer
}
function scopeAad(scope: LiteratureSecretScope, seed: string): Buffer {
  if (
    !Number.isSafeInteger(scope.userId) ||
    scope.userId < 1 ||
    !/^[1-9][0-9]{0,18}$/.test(scope.accountId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(seed)
  )
    throw new LiteratureError('SECRET_INVALID')
  return Buffer.from(
    `literature-login:v1:${scope.userId}:${scope.accountId}:${LITERATURE_SITE}:${seed}`,
  )
}
export function parseLiteratureCredentials(value: unknown): LiteratureCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LiteratureError('SECRET_INVALID')
  const o = value as Record<string, unknown>
  if (
    Object.getPrototypeOf(o) !== Object.prototype ||
    Object.keys(o).sort().join(',') !== 'password,schemaVersion,username' ||
    Object.values(Object.getOwnPropertyDescriptors(o)).some((d) => !Object.hasOwn(d, 'value')) ||
    o.schemaVersion !== 1 ||
    typeof o.username !== 'string' ||
    !o.username.length ||
    o.username.length > 256 ||
    typeof o.password !== 'string' ||
    !o.password.length ||
    o.password.length > 512 ||
    ['\0', '\r', '\n'].some(
      (c) => (o.username as string).includes(c) || (o.password as string).includes(c),
    )
  )
    throw new LiteratureError('SECRET_INVALID')
  return { schemaVersion: 1, username: o.username, password: o.password }
}
export function sealLiteratureCredentials(
  value: unknown,
  scope: LiteratureSecretScope,
  env: NodeJS.ProcessEnv = process.env,
): SealedLiteratureCredentials {
  const payload = parseLiteratureCredentials(value)
  const seed = randomUUID()
  const aad = scopeAad(scope, seed)
  const key = loadKmsKey(env)
  const plaintext = Buffer.from(JSON.stringify(payload))
  try {
    return { schemaVersion: 1, aadSeed: seed, ...encrypt(plaintext, key, aad) }
  } finally {
    zeroBuffer(key)
    zeroBuffer(plaintext)
  }
}
export function openLiteratureCredentials(
  sealed: SealedLiteratureCredentials,
  scope: LiteratureSecretScope,
  env: NodeJS.ProcessEnv = process.env,
): LiteratureCredentials {
  let key: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    if (
      sealed.schemaVersion !== 1 ||
      !Buffer.isBuffer(sealed.ciphertext) ||
      sealed.ciphertext.length > 8192 ||
      !Buffer.isBuffer(sealed.nonce)
    )
      throw new Error()
    const aad = scopeAad(scope, sealed.aadSeed)
    key = loadKmsKey(env)
    plaintext = decryptToBuffer(sealed.ciphertext, sealed.nonce, key, aad)
    return parseLiteratureCredentials(JSON.parse(plaintext.toString('utf8')))
  } catch {
    throw new LiteratureError('SECRET_INVALID')
  } finally {
    if (key) zeroBuffer(key)
    if (plaintext) zeroBuffer(plaintext)
  }
}
