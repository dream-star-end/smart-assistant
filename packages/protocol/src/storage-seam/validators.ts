/**
 * OCV5-890 Layer 1 — Storage Seam pure fail-closed validators.
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed.
 * All canonical hashing delegates to `../remotePool/canonical.js`.
 */
import {
  assertWellFormedJsonValue,
  remoteCanonicalSha256,
} from '../remotePool/canonical.js'
import {
  ARTIFACT_BLOB_KINDS,
  ARTIFACT_BLOB_STORAGE_BACKENDS,
  AUTHORITY_ENGINE_KINDS,
  CREDENTIAL_LEASE_MOUNT_KINDS,
  ENGINE_STATE_CAPSULE_PORTABILITIES,
  STORAGE_POOL_KINDS,
  type ArtifactBlobKind,
  type ArtifactBlobRef,
  type ArtifactBlobStorageBackend,
  type AuthorityEngineKind,
  type CredentialLeaseHandle,
  type CredentialLeaseMountKind,
  type EngineStateCapsuleFileEntry,
  type EngineStateCapsuleManifest,
  type EngineStateCapsuleManifestBody,
  type EngineStateCapsulePortability,
  type PlacementDescriptor,
  type StoragePoolKind,
} from './contracts.js'

export const ENGINE_STATE_CAPSULE_MAX_BYTES = 1024 * 1024 * 1024
export const ENGINE_STATE_CAPSULE_MAX_FILES = 2048
export const ARTIFACT_BLOB_MAX_BYTES = 1024 * 1024 * 1024

const SHA256_RE = /^[a-f0-9]{64}$/
const BLOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DRIVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const STICKY_HOME_KEY_RE = /^s-[a-f0-9]{16}$/
const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ \tA-Za-z0-9=._"-]+)?$/
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

const CAPSULE_ID_DOMAIN = 'oc-engine-state-capsule-v1'

const STORAGE_POOL_SET: ReadonlySet<string> = new Set<string>(STORAGE_POOL_KINDS)
const ENGINE_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_ENGINE_KINDS)
const BLOB_KIND_SET: ReadonlySet<string> = new Set<string>(ARTIFACT_BLOB_KINDS)
const BLOB_BACKEND_SET: ReadonlySet<string> = new Set<string>(ARTIFACT_BLOB_STORAGE_BACKENDS)
const PORTABILITY_SET: ReadonlySet<string> = new Set<string>(ENGINE_STATE_CAPSULE_PORTABILITIES)
const MOUNT_KIND_SET: ReadonlySet<string> = new Set<string>(CREDENTIAL_LEASE_MOUNT_KINDS)

export const CAPSULE_ALLOWED_PREFIXES_BY_ENGINE: Readonly<
  Record<AuthorityEngineKind, readonly string[]>
> = Object.freeze({
  ccb: Object.freeze(['projects/', 'sessions/', 'transcripts/', 'todos/', 'plans/']),
  codex: Object.freeze(['sessions/', 'rollouts/', 'threads/', 'history/']),
  antigravity: Object.freeze(['brain/', 'conversations/', 'sessions/', 'state/']),
  grok: Object.freeze(['sessions/', 'conversations/', 'history/']),
  cursor: Object.freeze(['sessions/', 'chats/', 'state/', 'transcripts/']),
  zcode: Object.freeze(['sessions/', 'history/', 'state/']),
})

const FORBIDDEN_CAPSULE_SEGMENTS: ReadonlySet<string> = new Set<string>([
  'auth.json',
  'openclaude.json',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.env',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'oauth.json',
  'token.json',
  'tokens.json',
  'secret.json',
  'secrets.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'cookies',
  'cookies.sqlite',
  'keychain',
])

const FORBIDDEN_CAPSULE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks'] as const

const ARTIFACT_BLOB_REF_KEYS: ReadonlySet<string> = new Set<string>([
  'blobId',
  'tenantId',
  'sha256',
  'sizeBytes',
  'mimeType',
  'kind',
  'logicalName',
  'containerRelativePath',
  'storageBackend',
  'storageUri',
  'createdAt',
])

const PLACEMENT_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set<string>([
  'poolKind',
  'engine',
  'driverId',
  'placementEpoch',
  'hostId',
  'containerId',
  'profileId',
  'operationId',
  'stickyHomeKey',
  'workspaceRef',
])

const CAPSULE_FILE_ENTRY_KEYS: ReadonlySet<string> = new Set<string>([
  'logicalPath',
  'sha256',
  'sizeBytes',
  'blobId',
  'mode',
  'isSqlite',
])

const CAPSULE_MANIFEST_KEYS: ReadonlySet<string> = new Set<string>([
  'schemaVersion',
  'capsuleId',
  'tenantId',
  'sessionKey',
  'engine',
  'engineVersion',
  'portability',
  'placementEpoch',
  'nativeSessionId',
  'totalBytes',
  'files',
  'createdAt',
])

const CREDENTIAL_LEASE_KEYS: ReadonlySet<string> = new Set<string>([
  'leaseId',
  'tenantId',
  'profileId',
  'engine',
  'mountKind',
  'noRefreshToken',
  'issuedAt',
  'expiresAt',
  'revoked',
  'scope',
])

function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

function asPlainObject(raw: unknown, code: string): Record<string, unknown> {
  need(raw !== null && typeof raw === 'object' && !Array.isArray(raw), code)
  const proto = Object.getPrototypeOf(raw)
  need(proto === Object.prototype || proto === null, code)
  assertWellFormedJsonValue(raw, true)
  return raw as Record<string, unknown>
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  for (const key of Object.keys(obj)) {
    need(allowed.has(key), code)
  }
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 64) return false
  const ms = Date.parse(value)
  return Number.isFinite(ms)
}

function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 512) return false
  if (CONTROL_CHAR_RE.test(p)) return false
  if (p.startsWith('/') || p.startsWith('\\') || p.includes('\\')) return false
  const segments = p.split('/')
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!
    if (seg.length === 0 || seg === '.' || seg === '..') return false
    if (i === 0 && seg.includes(':')) return false
  }
  return true
}

/**
 * Pure whitelist & anti-traversal/anti-credential check for engine state capsule file paths.
 */
export function isAllowedCapsuleLogicalPath(
  engine: AuthorityEngineKind,
  logicalPath: string,
): boolean {
  if (typeof engine !== 'string' || !ENGINE_SET.has(engine)) return false
  if (typeof logicalPath !== 'string' || !isSafeRelativePath(logicalPath)) return false

  const segments = logicalPath.split('/')
  for (const rawSeg of segments) {
    const lower = rawSeg.toLowerCase()
    if (FORBIDDEN_CAPSULE_SEGMENTS.has(lower)) return false
    if (lower.startsWith('.env.')) return false
    for (const ext of FORBIDDEN_CAPSULE_EXTENSIONS) {
      if (lower.endsWith(ext)) return false
    }
  }

  const allowedPrefixes = CAPSULE_ALLOWED_PREFIXES_BY_ENGINE[engine]
  for (const prefix of allowedPrefixes) {
    if (logicalPath.startsWith(prefix) && logicalPath.length > prefix.length) {
      return true
    }
  }
  return false
}

export function validateArtifactBlobRef(raw: unknown): ArtifactBlobRef {
  const o = asPlainObject(raw, 'STORAGE_ARTIFACT_BLOB_REF_INVALID')
  assertAllowedKeys(o, ARTIFACT_BLOB_REF_KEYS, 'STORAGE_ARTIFACT_BLOB_REF_INVALID')

  need(
    typeof o.blobId === 'string' &&
      BLOB_ID_RE.test(o.blobId) &&
      typeof o.tenantId === 'string' &&
      TENANT_ID_RE.test(o.tenantId) &&
      typeof o.sha256 === 'string' &&
      SHA256_RE.test(o.sha256) &&
      typeof o.sizeBytes === 'number' &&
      Number.isSafeInteger(o.sizeBytes) &&
      o.sizeBytes >= 0 &&
      o.sizeBytes <= ARTIFACT_BLOB_MAX_BYTES &&
      typeof o.mimeType === 'string' &&
      o.mimeType.length > 0 &&
      o.mimeType.length <= 128 &&
      MIME_TYPE_RE.test(o.mimeType) &&
      typeof o.kind === 'string' &&
      BLOB_KIND_SET.has(o.kind),
    'STORAGE_ARTIFACT_BLOB_REF_INVALID',
  )

  if (o.logicalName !== undefined) {
    need(
      typeof o.logicalName === 'string' &&
        o.logicalName.length > 0 &&
        o.logicalName.length <= 256 &&
        !CONTROL_CHAR_RE.test(o.logicalName),
      'STORAGE_ARTIFACT_BLOB_REF_INVALID',
    )
  }
  if (o.containerRelativePath !== undefined) {
    need(
      typeof o.containerRelativePath === 'string' && isSafeRelativePath(o.containerRelativePath),
      'STORAGE_ARTIFACT_BLOB_REF_PATH_INVALID',
    )
  }
  if (o.storageBackend !== undefined) {
    need(
      typeof o.storageBackend === 'string' && BLOB_BACKEND_SET.has(o.storageBackend),
      'STORAGE_ARTIFACT_BLOB_REF_INVALID',
    )
  }
  if (o.storageUri !== undefined) {
    need(
      typeof o.storageUri === 'string' &&
        o.storageUri.length > 0 &&
        o.storageUri.length <= 1024 &&
        !CONTROL_CHAR_RE.test(o.storageUri),
      'STORAGE_ARTIFACT_BLOB_REF_INVALID',
    )
  }
  if (o.createdAt !== undefined) {
    need(isValidIsoTimestamp(o.createdAt), 'STORAGE_ARTIFACT_BLOB_REF_INVALID')
  }

  return Object.freeze({
    blobId: o.blobId,
    tenantId: o.tenantId,
    sha256: o.sha256,
    sizeBytes: o.sizeBytes,
    mimeType: o.mimeType,
    kind: o.kind as ArtifactBlobKind,
    ...(o.logicalName === undefined ? {} : { logicalName: o.logicalName as string }),
    ...(o.containerRelativePath === undefined
      ? {}
      : { containerRelativePath: o.containerRelativePath as string }),
    ...(o.storageBackend === undefined
      ? {}
      : { storageBackend: o.storageBackend as ArtifactBlobStorageBackend }),
    ...(o.storageUri === undefined ? {} : { storageUri: o.storageUri as string }),
    ...(o.createdAt === undefined ? {} : { createdAt: o.createdAt as string }),
  })
}

export function validatePlacementDescriptor(raw: unknown): PlacementDescriptor {
  const o = asPlainObject(raw, 'STORAGE_PLACEMENT_DESCRIPTOR_INVALID')
  assertAllowedKeys(o, PLACEMENT_DESCRIPTOR_KEYS, 'STORAGE_PLACEMENT_DESCRIPTOR_INVALID')

  need(
    typeof o.poolKind === 'string' &&
      STORAGE_POOL_SET.has(o.poolKind) &&
      typeof o.engine === 'string' &&
      ENGINE_SET.has(o.engine) &&
      typeof o.driverId === 'string' &&
      DRIVER_ID_RE.test(o.driverId) &&
      typeof o.placementEpoch === 'number' &&
      Number.isSafeInteger(o.placementEpoch) &&
      o.placementEpoch >= 1,
    'STORAGE_PLACEMENT_DESCRIPTOR_INVALID',
  )

  for (const field of ['hostId', 'containerId', 'profileId', 'operationId', 'workspaceRef'] as const) {
    const val = o[field]
    if (val !== undefined) {
      need(
        typeof val === 'string' && val.length > 0 && val.length <= 256 && !CONTROL_CHAR_RE.test(val),
        'STORAGE_PLACEMENT_DESCRIPTOR_INVALID',
      )
    }
  }
  if (o.stickyHomeKey !== undefined) {
    need(
      typeof o.stickyHomeKey === 'string' && STICKY_HOME_KEY_RE.test(o.stickyHomeKey),
      'STORAGE_PLACEMENT_DESCRIPTOR_STICKY_KEY_INVALID',
    )
  }

  return Object.freeze({
    poolKind: o.poolKind as StoragePoolKind,
    engine: o.engine as AuthorityEngineKind,
    driverId: o.driverId,
    placementEpoch: o.placementEpoch,
    ...(o.hostId === undefined ? {} : { hostId: o.hostId as string }),
    ...(o.containerId === undefined ? {} : { containerId: o.containerId as string }),
    ...(o.profileId === undefined ? {} : { profileId: o.profileId as string }),
    ...(o.operationId === undefined ? {} : { operationId: o.operationId as string }),
    ...(o.stickyHomeKey === undefined ? {} : { stickyHomeKey: o.stickyHomeKey as string }),
    ...(o.workspaceRef === undefined ? {} : { workspaceRef: o.workspaceRef as string }),
  })
}

function normalizeCapsuleFileEntry(
  raw: unknown,
  engine: AuthorityEngineKind,
): EngineStateCapsuleFileEntry {
  const f = asPlainObject(raw, 'STORAGE_CAPSULE_FILE_INVALID')
  assertAllowedKeys(f, CAPSULE_FILE_ENTRY_KEYS, 'STORAGE_CAPSULE_FILE_INVALID')

  need(
    typeof f.logicalPath === 'string' &&
      isAllowedCapsuleLogicalPath(engine, f.logicalPath),
    'STORAGE_CAPSULE_PATH_FORBIDDEN',
  )
  need(
    typeof f.sha256 === 'string' &&
      SHA256_RE.test(f.sha256) &&
      typeof f.sizeBytes === 'number' &&
      Number.isSafeInteger(f.sizeBytes) &&
      f.sizeBytes >= 0 &&
      f.sizeBytes <= ENGINE_STATE_CAPSULE_MAX_BYTES,
    'STORAGE_CAPSULE_FILE_INVALID',
  )
  if (f.blobId !== undefined) {
    need(typeof f.blobId === 'string' && BLOB_ID_RE.test(f.blobId), 'STORAGE_CAPSULE_FILE_INVALID')
  }
  if (f.mode !== undefined) {
    need(
      typeof f.mode === 'number' && Number.isSafeInteger(f.mode) && f.mode >= 0 && f.mode <= 0o7777,
      'STORAGE_CAPSULE_FILE_INVALID',
    )
  }
  if (f.isSqlite !== undefined) {
    need(typeof f.isSqlite === 'boolean', 'STORAGE_CAPSULE_FILE_INVALID')
  }

  return Object.freeze({
    logicalPath: f.logicalPath,
    sha256: f.sha256,
    sizeBytes: f.sizeBytes,
    ...(f.blobId === undefined ? {} : { blobId: f.blobId as string }),
    ...(f.mode === undefined ? {} : { mode: f.mode as number }),
    ...(f.isSqlite === undefined ? {} : { isSqlite: f.isSqlite as boolean }),
  })
}

export function computeEngineStateCapsuleId(
  manifestWithoutId: EngineStateCapsuleManifestBody,
): string {
  assertWellFormedJsonValue(manifestWithoutId, false)
  const payload = {
    domain: CAPSULE_ID_DOMAIN,
    schemaVersion: manifestWithoutId.schemaVersion,
    tenantId: manifestWithoutId.tenantId,
    sessionKey: manifestWithoutId.sessionKey,
    engine: manifestWithoutId.engine,
    engineVersion: manifestWithoutId.engineVersion,
    portability: manifestWithoutId.portability,
    placementEpoch: manifestWithoutId.placementEpoch,
    nativeSessionId: manifestWithoutId.nativeSessionId ?? null,
    totalBytes: manifestWithoutId.totalBytes,
    files: manifestWithoutId.files,
    createdAt: manifestWithoutId.createdAt,
  }
  return remoteCanonicalSha256(payload)
}

export function validateEngineStateCapsuleManifest(raw: unknown): EngineStateCapsuleManifest {
  const o = asPlainObject(raw, 'STORAGE_CAPSULE_MANIFEST_INVALID')
  assertAllowedKeys(o, CAPSULE_MANIFEST_KEYS, 'STORAGE_CAPSULE_MANIFEST_INVALID')

  need(o.schemaVersion === 1, 'STORAGE_CAPSULE_SCHEMA_VERSION_UNSUPPORTED')
  need(
    typeof o.capsuleId === 'string' &&
      SHA256_RE.test(o.capsuleId) &&
      typeof o.tenantId === 'string' &&
      TENANT_ID_RE.test(o.tenantId) &&
      typeof o.sessionKey === 'string' &&
      o.sessionKey.length > 0 &&
      o.sessionKey.length <= 512 &&
      !CONTROL_CHAR_RE.test(o.sessionKey) &&
      typeof o.engine === 'string' &&
      ENGINE_SET.has(o.engine) &&
      typeof o.engineVersion === 'string' &&
      o.engineVersion.length > 0 &&
      o.engineVersion.length <= 64 &&
      !CONTROL_CHAR_RE.test(o.engineVersion) &&
      typeof o.portability === 'string' &&
      PORTABILITY_SET.has(o.portability) &&
      typeof o.placementEpoch === 'number' &&
      Number.isSafeInteger(o.placementEpoch) &&
      o.placementEpoch >= 1 &&
      typeof o.totalBytes === 'number' &&
      Number.isSafeInteger(o.totalBytes) &&
      o.totalBytes >= 0 &&
      isValidIsoTimestamp(o.createdAt) &&
      Array.isArray(o.files),
    'STORAGE_CAPSULE_MANIFEST_INVALID',
  )

  if (o.nativeSessionId !== undefined && o.nativeSessionId !== null) {
    need(
      typeof o.nativeSessionId === 'string' &&
        o.nativeSessionId.length > 0 &&
        o.nativeSessionId.length <= 256 &&
        !CONTROL_CHAR_RE.test(o.nativeSessionId),
      'STORAGE_CAPSULE_MANIFEST_INVALID',
    )
  }

  need(o.files.length <= ENGINE_STATE_CAPSULE_MAX_FILES, 'STORAGE_CAPSULE_TOO_MANY_FILES')

  const engine = o.engine as AuthorityEngineKind
  const seenPaths = new Set<string>()
  const normalizedFiles: EngineStateCapsuleFileEntry[] = []
  let sumBytes = 0

  for (const rawFile of o.files) {
    const file = normalizeCapsuleFileEntry(rawFile, engine)
    need(!seenPaths.has(file.logicalPath), 'STORAGE_CAPSULE_DUPLICATE_PATH')
    seenPaths.add(file.logicalPath)
    sumBytes += file.sizeBytes
    need(sumBytes <= ENGINE_STATE_CAPSULE_MAX_BYTES, 'STORAGE_CAPSULE_SIZE_EXCEEDED')
    normalizedFiles.push(file)
  }

  need(o.totalBytes <= ENGINE_STATE_CAPSULE_MAX_BYTES, 'STORAGE_CAPSULE_SIZE_EXCEEDED')
  need(sumBytes === o.totalBytes, 'STORAGE_CAPSULE_TOTAL_BYTES_MISMATCH')

  const body: EngineStateCapsuleManifestBody = {
    schemaVersion: 1,
    tenantId: o.tenantId,
    sessionKey: o.sessionKey,
    engine,
    engineVersion: o.engineVersion,
    portability: o.portability as EngineStateCapsulePortability,
    placementEpoch: o.placementEpoch,
    ...(o.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: o.nativeSessionId as string | null }),
    totalBytes: o.totalBytes,
    files: Object.freeze(normalizedFiles),
    createdAt: o.createdAt,
  }

  const expectedId = computeEngineStateCapsuleId(body)
  need(expectedId === o.capsuleId, 'STORAGE_CAPSULE_ID_MISMATCH')

  return Object.freeze({
    ...body,
    capsuleId: expectedId,
  })
}

export function validateCredentialLeaseHandle(raw: unknown): CredentialLeaseHandle {
  const o = asPlainObject(raw, 'STORAGE_CREDENTIAL_LEASE_INVALID')
  assertAllowedKeys(o, CREDENTIAL_LEASE_KEYS, 'STORAGE_CREDENTIAL_LEASE_INVALID')

  need(
    typeof o.leaseId === 'string' &&
      IDENT_RE.test(o.leaseId) &&
      typeof o.tenantId === 'string' &&
      TENANT_ID_RE.test(o.tenantId) &&
      typeof o.profileId === 'string' &&
      IDENT_RE.test(o.profileId) &&
      typeof o.engine === 'string' &&
      ENGINE_SET.has(o.engine) &&
      typeof o.mountKind === 'string' &&
      MOUNT_KIND_SET.has(o.mountKind) &&
      typeof o.noRefreshToken === 'boolean' &&
      isValidIsoTimestamp(o.issuedAt) &&
      isValidIsoTimestamp(o.expiresAt),
    'STORAGE_CREDENTIAL_LEASE_INVALID',
  )

  need(Date.parse(o.expiresAt) > Date.parse(o.issuedAt), 'STORAGE_CREDENTIAL_LEASE_WINDOW_INVALID')

  if (o.mountKind === 'memfd_or_tmpfs') {
    need(o.noRefreshToken === true, 'STORAGE_CREDENTIAL_LEASE_REFRESH_TOKEN_FORBIDDEN')
  }

  if (o.revoked !== undefined) {
    need(typeof o.revoked === 'boolean', 'STORAGE_CREDENTIAL_LEASE_INVALID')
  }

  let scope: readonly string[] | undefined
  if (o.scope !== undefined) {
    need(Array.isArray(o.scope) && o.scope.length <= 64, 'STORAGE_CREDENTIAL_LEASE_INVALID')
    for (const item of o.scope) {
      need(typeof item === 'string' && IDENT_RE.test(item), 'STORAGE_CREDENTIAL_LEASE_INVALID')
    }
    scope = Object.freeze([...(o.scope as string[])])
  }

  return Object.freeze({
    leaseId: o.leaseId,
    tenantId: o.tenantId,
    profileId: o.profileId,
    engine: o.engine as AuthorityEngineKind,
    mountKind: o.mountKind as CredentialLeaseMountKind,
    noRefreshToken: o.noRefreshToken,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
    ...(o.revoked === undefined ? {} : { revoked: o.revoked as boolean }),
    ...(scope === undefined ? {} : { scope }),
  })
}
