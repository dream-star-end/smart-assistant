import * as defaultFs from 'node:fs/promises'
import path from 'node:path'

export const IDENTITY_FILE_NAME = 'identity.enc'
export const IDENTITY_DIR_NAME = 'identity'
export const IDENTITY_PRODUCT_DIR = 'Clarvy'

const DEVICE_CREDENTIAL_PATTERN =
  /^oc-dv\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/i
const FORBIDDEN_IDENTITY_KEYS = Object.freeze([
  'pkce_verifier',
  'verifier',
  'oc-v3',
  'oc_v3',
  'code',
  'token',
])
const SECRET_FIELD_PATTERN = /verifier|pem|cert|key|token|credential|secret|code/i

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function resolveIdentityDirectory({
  platform = process.platform,
  env = process.env,
  userDataPath,
} = {}) {
  if (platform === 'win32' && typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0) {
    return path.win32.join(env.LOCALAPPDATA, IDENTITY_PRODUCT_DIR, IDENTITY_DIR_NAME)
  }
  if (typeof userDataPath === 'string' && userDataPath.length > 0) {
    return path.join(userDataPath, IDENTITY_DIR_NAME)
  }
  throw new TypeError('identity directory requires LOCALAPPDATA or userDataPath')
}

export function redactSecrets(value, depth = 0) {
  if (depth > 6) return '[truncated]'
  if (value == null) return value
  if (typeof value === 'string') {
    if (value.includes('BEGIN ') || SECRET_FIELD_PATTERN.test(value) && value.length > 40) {
      return '[redacted]'
    }
    return value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactSecrets(entry, depth + 1))
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_FIELD_PATTERN.test(key) ? '[redacted]' : redactSecrets(entry, depth + 1)
  }
  return result
}

export function normalizeIdentityRecord(input) {
  if (!isPlainRecord(input)) {
    throw new TypeError('identity payload required')
  }
  for (const key of FORBIDDEN_IDENTITY_KEYS) {
    if (Object.hasOwn(input, key)) {
      throw new Error('identity payload must not include ephemeral secrets')
    }
  }

  const device_cert = input.device_cert
  const device_key = input.device_key
  const device_credential = input.device_credential
  if (typeof device_cert !== 'string' || !device_cert.includes('BEGIN CERTIFICATE')) {
    throw new TypeError('device_cert required')
  }
  if (typeof device_key !== 'string' || !device_key.includes('BEGIN')) {
    throw new TypeError('device_key required')
  }
  if (typeof device_credential !== 'string' || !DEVICE_CREDENTIAL_PATTERN.test(device_credential)) {
    throw new TypeError('device_credential required')
  }

  return {
    version: 1,
    deviceId: typeof input.deviceId === 'string' ? input.deviceId : '',
    containerId: input.containerId ?? null,
    device_cert,
    device_key,
    device_credential,
  }
}

export function createMemoryIdentityStore() {
  let record = null
  const writes = []
  return {
    kind: 'memory',
    get writes() {
      return writes.slice()
    },
    async save(input) {
      const normalized = normalizeIdentityRecord(input)
      writes.push({ ...normalized })
      record = normalized
    },
    async load() {
      return record ? { ...record } : null
    },
    async revoke() {
      record = null
    },
  }
}

export function createEncryptedFileIdentityStore({
  directory,
  encrypt,
  decrypt,
  fsImpl = defaultFs,
  fileName = IDENTITY_FILE_NAME,
} = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('identity directory required')
  }
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') {
    throw new TypeError('encrypt and decrypt are required')
  }

  const filePath = path.join(directory, fileName)
  const writes = []

  async function persist(buffer) {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    await fsImpl.mkdir(directory, { recursive: true })
    try {
      await fsImpl.writeFile(temporaryPath, buffer, { mode: 0o600 })
      await fsImpl.rename(temporaryPath, filePath)
    } catch (error) {
      await fsImpl.rm?.(temporaryPath, { force: true }).catch?.(() => {})
      throw error
    }
  }

  return {
    kind: 'encrypted-file',
    filePath,
    get writes() {
      return writes.slice()
    },
    async save(input) {
      const normalized = normalizeIdentityRecord(input)
      const serialized = `${JSON.stringify(normalized)}\n`
      writes.push(serialized)
      const encrypted = encrypt(serialized)
      if (!Buffer.isBuffer(encrypted)) {
        throw new TypeError('encrypt must return a Buffer')
      }
      await persist(encrypted)
    },
    async load() {
      try {
        const encrypted = await fsImpl.readFile(filePath)
        const serialized = decrypt(encrypted)
        if (typeof serialized !== 'string') return null
        return normalizeIdentityRecord(JSON.parse(serialized))
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') return null
        throw error
      }
    },
    async revoke() {
      await fsImpl.rm(filePath, { force: true })
    },
  }
}

export function createSafeStorageIdentityStore({
  directory,
  safeStorage,
  fsImpl = defaultFs,
} = {}) {
  if (!safeStorage || typeof safeStorage.encryptString !== 'function') {
    throw new TypeError('Electron safeStorage is required')
  }
  if (typeof safeStorage.isEncryptionAvailable === 'function' && !safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available')
  }
  return createEncryptedFileIdentityStore({
    directory,
    fsImpl,
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buffer) => safeStorage.decryptString(buffer),
  })
}
