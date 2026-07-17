/** Root-only, short-lived encrypted bridge from release verification to deploy-time account bind. */

import { hkdfSync, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

import { NONCE_BYTES, TAG_BYTES, decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'
import { type BrowserStorageStateV1, validateBrowserStorageState } from './accounts.js'
import type { ManagedBrowserPluginContractV1 } from './contracts.js'

const HASH_RE = /^[0-9a-f]{64}$/
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const HKDF_INFO = 'openclaude:knowledge-planet-verification-handoff:v2'
const HANDOFF_TTL_MS = 15 * 60_000
const FUTURE_SKEW_MS = 30_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_CIPHERTEXT_BYTES = 256 * 1024 + TAG_BYTES

export const KNOWLEDGE_PLANET_VERIFICATION_HANDOFF_PATH =
  '/run/openclaude-v5/knowledge-planet-plugin-verification.json'

export type KnowledgePlanetVerificationKind = 'existing-account' | 'qr-login'

export interface KnowledgePlanetVerificationExpected {
  artifactHash: string
  execContractHash: string
  workerDigest: string
  imageId: string
  sourceCommit: string
  actionIds: readonly string[]
  resourceDependentActionIds: readonly string[]
  contract: ManagedBrowserPluginContractV1
}

export interface KnowledgePlanetVerificationMetadata {
  schemaVersion: 2
  artifactHash: string
  execContractHash: string
  workerDigest: string
  imageId: string
  sourceCommit: string
  userId: number
  verification: KnowledgePlanetVerificationKind
  replaceExistingAccount: boolean
  expectedExistingAccountInstanceId: string | null
  replacementAccountInstanceId: string | null
  passedActionIds: string[]
  resourceUnavailableActionIds: string[]
  cleanupVerified: true
  createdAt: string
  expiresAt: string
}

interface HandoffFile extends KnowledgePlanetVerificationMetadata {
  nonce: string
  ciphertext: string
}

export interface KnowledgePlanetVerificationHandoff {
  metadata: KnowledgePlanetVerificationMetadata
  storageState: BrowserStorageStateV1
}

interface FileOptions {
  path?: string
  expectedOwnerUid?: number
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function validateExpected(expected: KnowledgePlanetVerificationExpected): void {
  const actionIds = new Set(expected.actionIds)
  if (
    !HASH_RE.test(expected.artifactHash) ||
    !HASH_RE.test(expected.execContractHash) ||
    !HASH_RE.test(expected.workerDigest) ||
    !IMAGE_ID_RE.test(expected.imageId) ||
    !SOURCE_COMMIT_RE.test(expected.sourceCommit) ||
    expected.actionIds.length === 0 ||
    actionIds.size !== expected.actionIds.length ||
    expected.actionIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128) ||
    new Set(expected.resourceDependentActionIds).size !==
      expected.resourceDependentActionIds.length ||
    expected.resourceDependentActionIds.some((id) => !actionIds.has(id))
  )
    throw new Error('Knowledge Planet verification expectation is invalid')
}

function validateCoverage(
  passedValue: unknown,
  unavailableValue: unknown,
  expected: KnowledgePlanetVerificationExpected,
): { passedActionIds: string[]; resourceUnavailableActionIds: string[] } | null {
  if (!Array.isArray(passedValue) || !Array.isArray(unavailableValue)) return null
  if (
    passedValue.some((id) => typeof id !== 'string') ||
    unavailableValue.some((id) => typeof id !== 'string')
  )
    return null
  const passedActionIds = passedValue as string[]
  const resourceUnavailableActionIds = unavailableValue as string[]
  const passed = new Set(passedActionIds)
  const unavailable = new Set(resourceUnavailableActionIds)
  const allowedUnavailable = new Set(expected.resourceDependentActionIds)
  if (
    passed.size !== passedActionIds.length ||
    unavailable.size !== resourceUnavailableActionIds.length ||
    [...unavailable].some((id) => !allowedUnavailable.has(id)) ||
    [...passed].some((id) => unavailable.has(id)) ||
    expected.actionIds.some((id) => !passed.has(id) && !unavailable.has(id)) ||
    [...passed].some((id) => !expected.actionIds.includes(id)) ||
    passedActionIds.join('\0') !==
      expected.actionIds.filter((id) => passed.has(id)).join('\0') ||
    resourceUnavailableActionIds.join('\0') !==
      expected.actionIds.filter((id) => unavailable.has(id)).join('\0')
  )
    return null
  return {
    passedActionIds: [...passedActionIds],
    resourceUnavailableActionIds: [...resourceUnavailableActionIds],
  }
}

function validateUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error('Knowledge Planet verification user is invalid')
}

function metadataAad(metadata: object): Buffer {
  return Buffer.from(JSON.stringify(metadata), 'utf8')
}

// info 域分隔:handoff 与 checkpoint 从同一 KMS 根派生互不相同的子密钥,任一密文
// 不可能被对方的解密路径接受(即便同 AAD 结构),防止两类短命凭据交叉误用。
function deriveKey(env: NodeJS.ProcessEnv, info: string = HKDF_INFO): Buffer {
  const kms = loadKmsKey(env)
  try {
    return Buffer.from(hkdfSync('sha256', kms, Buffer.alloc(0), info, 32))
  } finally {
    zeroBuffer(kms)
  }
}

function safePath(options: FileOptions): { path: string; root: string; expectedOwnerUid: number } {
  const path = options.path ?? KNOWLEDGE_PLANET_VERIFICATION_HANDOFF_PATH
  if (!isAbsolute(path)) throw new Error('Knowledge Planet verification handoff path is unsafe')
  return { path, root: dirname(path), expectedOwnerUid: options.expectedOwnerUid ?? 0 }
}

async function ensurePrivateRoot(root: string, expectedOwnerUid: number): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  let stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedOwnerUid)
    throw new Error('Knowledge Planet verification handoff root is unsafe')
  await chmod(root, 0o700)
  stat = await lstat(root)
  if ((stat.mode & 0o777) !== 0o700)
    throw new Error('Knowledge Planet verification handoff root is unsafe')
}

function assertPrivateFile(stat: Stats, expectedOwnerUid: number): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedOwnerUid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size <= 0 ||
    stat.size > MAX_FILE_BYTES
  )
    throw new Error('Knowledge Planet verification handoff file is unsafe')
}

async function writePrivateFile(options: FileOptions, body: Buffer): Promise<void> {
  if (body.length <= 0 || body.length > MAX_FILE_BYTES)
    throw new Error('Knowledge Planet verification handoff exceeds byte limit')
  const { path, root, expectedOwnerUid } = safePath(options)
  await ensurePrivateRoot(root, expectedOwnerUid)
  const temporary = `${path}.tmp-${randomUUID()}`
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
  try {
    const file = await open(temporary, flags, 0o600)
    try {
      await file.writeFile(body)
      await file.sync()
    } finally {
      await file.close()
    }
    await chmod(temporary, 0o600)
    assertPrivateFile(await lstat(temporary), expectedOwnerUid)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  assertPrivateFile(await lstat(path), expectedOwnerUid)
}

async function readPrivateFile(options: FileOptions): Promise<Buffer> {
  const { path, root, expectedOwnerUid } = safePath(options)
  const rootStat = await lstat(root).catch(() => null)
  if (
    !rootStat ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== expectedOwnerUid ||
    (rootStat.mode & 0o777) !== 0o700
  )
    throw new Error('Knowledge Planet verification handoff root is unsafe')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!file) throw new Error('valid Knowledge Planet verification handoff is required')
  try {
    assertPrivateFile(await file.stat(), expectedOwnerUid)
    const body = await file.readFile()
    if (body.length <= 0 || body.length > MAX_FILE_BYTES)
      throw new Error('Knowledge Planet verification handoff exceeds byte limit')
    return body
  } finally {
    await file.close()
  }
}

function decodeBase64(value: unknown, label: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !BASE64_RE.test(value))
    throw new Error(`Knowledge Planet verification ${label} is invalid`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length > maxBytes || decoded.toString('base64') !== value) {
    zeroBuffer(decoded)
    throw new Error(`Knowledge Planet verification ${label} is invalid`)
  }
  return decoded
}

function parseMetadata(
  raw: Record<string, unknown>,
  expected: KnowledgePlanetVerificationExpected,
  now: number,
): KnowledgePlanetVerificationMetadata {
  const coverage = validateCoverage(
    raw.passedActionIds,
    raw.resourceUnavailableActionIds,
    expected,
  )
  if (
    raw.schemaVersion !== 2 ||
    raw.artifactHash !== expected.artifactHash ||
    raw.execContractHash !== expected.execContractHash ||
    raw.workerDigest !== expected.workerDigest ||
    raw.imageId !== expected.imageId ||
    raw.sourceCommit !== expected.sourceCommit ||
    !Number.isSafeInteger(raw.userId) ||
    Number(raw.userId) <= 0 ||
    !['existing-account', 'qr-login'].includes(String(raw.verification)) ||
    typeof raw.replaceExistingAccount !== 'boolean' ||
    (raw.verification === 'existing-account' && raw.replaceExistingAccount !== false) ||
    !(
      raw.expectedExistingAccountInstanceId === null ||
      (typeof raw.expectedExistingAccountInstanceId === 'string' &&
        UUID_RE.test(raw.expectedExistingAccountInstanceId))
    ) ||
    !(
      raw.replacementAccountInstanceId === null ||
      (typeof raw.replacementAccountInstanceId === 'string' &&
        UUID_RE.test(raw.replacementAccountInstanceId))
    ) ||
    (raw.replaceExistingAccount === true &&
      (raw.expectedExistingAccountInstanceId === null ||
        raw.replacementAccountInstanceId === null ||
        raw.replacementAccountInstanceId === raw.expectedExistingAccountInstanceId)) ||
    (raw.replaceExistingAccount === false && raw.replacementAccountInstanceId !== null) ||
    !coverage ||
    raw.cleanupVerified !== true ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.expiresAt !== 'string'
  )
    throw new Error('Knowledge Planet verification handoff does not match this artifact/image')
  const createdAt = Date.parse(raw.createdAt)
  const expiresAt = Date.parse(raw.expiresAt)
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - createdAt !== HANDOFF_TTL_MS ||
    createdAt > now + FUTURE_SKEW_MS ||
    now > expiresAt
  )
    throw new Error('Knowledge Planet verification handoff expired')
  return {
    schemaVersion: 2,
    artifactHash: expected.artifactHash,
    execContractHash: expected.execContractHash,
    workerDigest: expected.workerDigest,
    imageId: expected.imageId,
    sourceCommit: expected.sourceCommit,
    userId: Number(raw.userId),
    verification: raw.verification as KnowledgePlanetVerificationKind,
    replaceExistingAccount: raw.replaceExistingAccount,
    expectedExistingAccountInstanceId: raw.expectedExistingAccountInstanceId as string | null,
    replacementAccountInstanceId: raw.replacementAccountInstanceId as string | null,
    passedActionIds: coverage.passedActionIds,
    resourceUnavailableActionIds: coverage.resourceUnavailableActionIds,
    cleanupVerified: true,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  }
}

export async function writeKnowledgePlanetVerificationHandoff(input: {
  expected: KnowledgePlanetVerificationExpected
  userId: number
  verification: KnowledgePlanetVerificationKind
  replaceExistingAccount: boolean
  expectedExistingAccountInstanceId: string | null
  replacementAccountInstanceId: string | null
  passedActionIds: readonly string[]
  resourceUnavailableActionIds: readonly string[]
  storageState: unknown
  env?: NodeJS.ProcessEnv
  now?: number
  file?: FileOptions
}): Promise<KnowledgePlanetVerificationMetadata> {
  validateExpected(input.expected)
  validateUserId(input.userId)
  const coverage = validateCoverage(
    input.passedActionIds,
    input.resourceUnavailableActionIds,
    input.expected,
  )
  if (
    !coverage ||
    (input.verification === 'existing-account' && input.replaceExistingAccount) ||
    !(
      input.expectedExistingAccountInstanceId === null ||
      UUID_RE.test(input.expectedExistingAccountInstanceId)
    ) ||
    !(
      input.replacementAccountInstanceId === null ||
      UUID_RE.test(input.replacementAccountInstanceId)
    ) ||
    (input.replaceExistingAccount &&
      (input.expectedExistingAccountInstanceId === null ||
        input.replacementAccountInstanceId === null ||
        input.replacementAccountInstanceId === input.expectedExistingAccountInstanceId)) ||
    (!input.replaceExistingAccount && input.replacementAccountInstanceId !== null)
  )
    throw new Error('Knowledge Planet verification result is invalid')
  const now = input.now ?? Date.now()
  if (!Number.isFinite(now)) throw new Error('Knowledge Planet verification time is invalid')
  const metadata: KnowledgePlanetVerificationMetadata = {
    schemaVersion: 2,
    artifactHash: input.expected.artifactHash,
    execContractHash: input.expected.execContractHash,
    workerDigest: input.expected.workerDigest,
    imageId: input.expected.imageId,
    sourceCommit: input.expected.sourceCommit,
    userId: input.userId,
    verification: input.verification,
    replaceExistingAccount: input.replaceExistingAccount,
    expectedExistingAccountInstanceId: input.expectedExistingAccountInstanceId,
    replacementAccountInstanceId: input.replacementAccountInstanceId,
    passedActionIds: coverage.passedActionIds,
    resourceUnavailableActionIds: coverage.resourceUnavailableActionIds,
    cleanupVerified: true,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + HANDOFF_TTL_MS).toISOString(),
  }
  const state = validateBrowserStorageState(input.storageState, input.expected.contract)
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8')
  const aad = metadataAad(metadata)
  const key = deriveKey(input.env ?? process.env)
  try {
    const encrypted = encrypt(plaintext, key, aad)
    try {
      const file: HandoffFile = {
        ...metadata,
        nonce: encrypted.nonce.toString('base64'),
        ciphertext: encrypted.ciphertext.toString('base64'),
      }
      await writePrivateFile(input.file ?? {}, Buffer.from(`${JSON.stringify(file)}\n`, 'utf8'))
    } finally {
      zeroBuffer(encrypted.nonce)
      zeroBuffer(encrypted.ciphertext)
    }
  } finally {
    zeroBuffer(plaintext)
    zeroBuffer(aad)
    zeroBuffer(key)
  }
  return metadata
}

export async function readKnowledgePlanetVerificationHandoff(input: {
  expected: KnowledgePlanetVerificationExpected
  env?: NodeJS.ProcessEnv
  now?: number
  file?: FileOptions
}): Promise<KnowledgePlanetVerificationHandoff> {
  validateExpected(input.expected)
  const body = await readPrivateFile(input.file ?? {})
  let raw: unknown
  try {
    raw = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('Knowledge Planet verification handoff is invalid')
  } finally {
    zeroBuffer(body)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Knowledge Planet verification handoff is invalid')
  const record = raw as Record<string, unknown>
  if (
    !exactKeys(record, [
      'schemaVersion',
      'artifactHash',
      'execContractHash',
      'workerDigest',
      'imageId',
      'sourceCommit',
      'userId',
      'verification',
      'replaceExistingAccount',
      'expectedExistingAccountInstanceId',
      'replacementAccountInstanceId',
      'passedActionIds',
      'resourceUnavailableActionIds',
      'cleanupVerified',
      'createdAt',
      'expiresAt',
      'nonce',
      'ciphertext',
    ])
  )
    throw new Error('Knowledge Planet verification handoff is invalid')
  const metadata = parseMetadata(record, input.expected, input.now ?? Date.now())
  const nonce = decodeBase64(record.nonce, 'nonce', NONCE_BYTES)
  const ciphertext = decodeBase64(record.ciphertext, 'ciphertext', MAX_CIPHERTEXT_BYTES)
  if (nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) {
    zeroBuffer(nonce)
    zeroBuffer(ciphertext)
    throw new Error('Knowledge Planet verification ciphertext is invalid')
  }
  const aad = metadataAad(metadata)
  const key = deriveKey(input.env ?? process.env)
  let plaintext: Buffer | null = null
  try {
    plaintext = decryptToBuffer(ciphertext, nonce, key, aad)
    const parsed = JSON.parse(plaintext.toString('utf8'))
    return {
      metadata,
      storageState: validateBrowserStorageState(parsed, input.expected.contract),
    }
  } catch {
    throw new Error('Knowledge Planet verification handoff authentication failed')
  } finally {
    if (plaintext) zeroBuffer(plaintext)
    zeroBuffer(nonce)
    zeroBuffer(ciphertext)
    zeroBuffer(aad)
    zeroBuffer(key)
  }
}

export async function deleteKnowledgePlanetVerificationHandoff(
  file: FileOptions = {},
): Promise<void> {
  const { path } = safePath(file)
  await rm(path, { force: true })
}

// ─────────────────────────── post-scan checkpoint (C2) ───────────────────────────
// 扫码成功后、正式 handoff 写盘前的短命加密快照。背景:旧实现里已认证 storageState 只在内存,
// 要等 runActionSmoke(~15-20 次真实 API)全过 + handoff 落盘才持久化;其间任一抖动/进程重跑
// 都逼用户重扫。checkpoint 复用本模块的 AEAD + 原子私有写基建(独立路径 + 域分隔密钥 + 短 TTL),
// probeAuthenticated 命中即写;post-scan 任一失败优先从有效 checkpoint 恢复继续,成功写 handoff 后删。

const CHECKPOINT_HKDF_INFO = 'openclaude:knowledge-planet-verification-checkpoint:v1'
const CHECKPOINT_TTL_MS = 30 * 60_000

export const KNOWLEDGE_PLANET_VERIFICATION_CHECKPOINT_PATH =
  '/run/openclaude-v5/knowledge-planet-plugin-verification-checkpoint.json'

export interface KnowledgePlanetVerificationCheckpointMetadata {
  schemaVersion: 1
  artifactHash: string
  execContractHash: string
  workerDigest: string
  imageId: string
  sourceCommit: string
  userId: number
  // checkpoint 只存在于 qr-login 路径(existing-account 复用不扫码,无需 checkpoint)。
  verification: 'qr-login'
  replaceExistingAccount: boolean
  expectedExistingAccountInstanceId: string | null
  replacementAccountInstanceId: string | null
  createdAt: string
  expiresAt: string
}

interface CheckpointFile extends KnowledgePlanetVerificationCheckpointMetadata {
  nonce: string
  ciphertext: string
}

export interface KnowledgePlanetVerificationCheckpoint {
  metadata: KnowledgePlanetVerificationCheckpointMetadata
  storageState: BrowserStorageStateV1
}

// handoff 与 checkpoint 都携带 replace-account 意图,校验规则一致,收口一处避免两套并行判定。
function assertReplacementIntent(input: {
  verification: 'qr-login' | 'existing-account'
  replaceExistingAccount: boolean
  expectedExistingAccountInstanceId: string | null
  replacementAccountInstanceId: string | null
}): void {
  if (
    (input.verification === 'existing-account' && input.replaceExistingAccount) ||
    !(
      input.expectedExistingAccountInstanceId === null ||
      UUID_RE.test(input.expectedExistingAccountInstanceId)
    ) ||
    !(
      input.replacementAccountInstanceId === null ||
      UUID_RE.test(input.replacementAccountInstanceId)
    ) ||
    (input.replaceExistingAccount &&
      (input.expectedExistingAccountInstanceId === null ||
        input.replacementAccountInstanceId === null ||
        input.replacementAccountInstanceId === input.expectedExistingAccountInstanceId)) ||
    (!input.replaceExistingAccount && input.replacementAccountInstanceId !== null)
  )
    throw new Error('Knowledge Planet verification checkpoint intent is invalid')
}

function checkpointSafePath(file: FileOptions): {
  path: string
  root: string
  expectedOwnerUid: number
} {
  const path = file.path ?? KNOWLEDGE_PLANET_VERIFICATION_CHECKPOINT_PATH
  if (!isAbsolute(path)) throw new Error('Knowledge Planet verification checkpoint path is unsafe')
  return { path, root: dirname(path), expectedOwnerUid: file.expectedOwnerUid ?? 0 }
}

export async function writeKnowledgePlanetVerificationCheckpoint(input: {
  expected: KnowledgePlanetVerificationExpected
  userId: number
  replaceExistingAccount: boolean
  expectedExistingAccountInstanceId: string | null
  replacementAccountInstanceId: string | null
  storageState: unknown
  env?: NodeJS.ProcessEnv
  now?: number
  file?: FileOptions
}): Promise<KnowledgePlanetVerificationCheckpointMetadata> {
  validateExpected(input.expected)
  validateUserId(input.userId)
  assertReplacementIntent({
    verification: 'qr-login',
    replaceExistingAccount: input.replaceExistingAccount,
    expectedExistingAccountInstanceId: input.expectedExistingAccountInstanceId,
    replacementAccountInstanceId: input.replacementAccountInstanceId,
  })
  const now = input.now ?? Date.now()
  if (!Number.isFinite(now)) throw new Error('Knowledge Planet verification time is invalid')
  const metadata: KnowledgePlanetVerificationCheckpointMetadata = {
    schemaVersion: 1,
    artifactHash: input.expected.artifactHash,
    execContractHash: input.expected.execContractHash,
    workerDigest: input.expected.workerDigest,
    imageId: input.expected.imageId,
    sourceCommit: input.expected.sourceCommit,
    userId: input.userId,
    verification: 'qr-login',
    replaceExistingAccount: input.replaceExistingAccount,
    expectedExistingAccountInstanceId: input.expectedExistingAccountInstanceId,
    replacementAccountInstanceId: input.replacementAccountInstanceId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHECKPOINT_TTL_MS).toISOString(),
  }
  const state = validateBrowserStorageState(input.storageState, input.expected.contract)
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8')
  const aad = metadataAad(metadata)
  const key = deriveKey(input.env ?? process.env, CHECKPOINT_HKDF_INFO)
  try {
    const encrypted = encrypt(plaintext, key, aad)
    try {
      const file: CheckpointFile = {
        ...metadata,
        nonce: encrypted.nonce.toString('base64'),
        ciphertext: encrypted.ciphertext.toString('base64'),
      }
      await writePrivateFile(
        checkpointSafePath(input.file ?? {}),
        Buffer.from(`${JSON.stringify(file)}\n`, 'utf8'),
      )
    } finally {
      zeroBuffer(encrypted.nonce)
      zeroBuffer(encrypted.ciphertext)
    }
  } finally {
    zeroBuffer(plaintext)
    zeroBuffer(aad)
    zeroBuffer(key)
  }
  return metadata
}

function parseCheckpointMetadata(
  raw: Record<string, unknown>,
  expected: KnowledgePlanetVerificationExpected,
  now: number,
): KnowledgePlanetVerificationCheckpointMetadata {
  if (
    raw.schemaVersion !== 1 ||
    raw.artifactHash !== expected.artifactHash ||
    raw.execContractHash !== expected.execContractHash ||
    raw.workerDigest !== expected.workerDigest ||
    raw.imageId !== expected.imageId ||
    raw.sourceCommit !== expected.sourceCommit ||
    !Number.isSafeInteger(raw.userId) ||
    Number(raw.userId) <= 0 ||
    raw.verification !== 'qr-login' ||
    typeof raw.replaceExistingAccount !== 'boolean' ||
    !(
      raw.expectedExistingAccountInstanceId === null ||
      (typeof raw.expectedExistingAccountInstanceId === 'string' &&
        UUID_RE.test(raw.expectedExistingAccountInstanceId))
    ) ||
    !(
      raw.replacementAccountInstanceId === null ||
      (typeof raw.replacementAccountInstanceId === 'string' &&
        UUID_RE.test(raw.replacementAccountInstanceId))
    ) ||
    (raw.replaceExistingAccount === true &&
      (raw.expectedExistingAccountInstanceId === null ||
        raw.replacementAccountInstanceId === null ||
        raw.replacementAccountInstanceId === raw.expectedExistingAccountInstanceId)) ||
    (raw.replaceExistingAccount === false && raw.replacementAccountInstanceId !== null) ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.expiresAt !== 'string'
  )
    throw new Error('Knowledge Planet verification checkpoint does not match this artifact/image')
  const createdAt = Date.parse(raw.createdAt)
  const expiresAt = Date.parse(raw.expiresAt)
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - createdAt !== CHECKPOINT_TTL_MS ||
    createdAt > now + FUTURE_SKEW_MS ||
    now > expiresAt
  )
    throw new Error('Knowledge Planet verification checkpoint expired')
  return {
    schemaVersion: 1,
    artifactHash: expected.artifactHash,
    execContractHash: expected.execContractHash,
    workerDigest: expected.workerDigest,
    imageId: expected.imageId,
    sourceCommit: expected.sourceCommit,
    userId: Number(raw.userId),
    verification: 'qr-login',
    replaceExistingAccount: raw.replaceExistingAccount,
    expectedExistingAccountInstanceId: raw.expectedExistingAccountInstanceId as string | null,
    replacementAccountInstanceId: raw.replacementAccountInstanceId as string | null,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  }
}

export async function readKnowledgePlanetVerificationCheckpoint(input: {
  expected: KnowledgePlanetVerificationExpected
  env?: NodeJS.ProcessEnv
  now?: number
  file?: FileOptions
}): Promise<KnowledgePlanetVerificationCheckpoint> {
  validateExpected(input.expected)
  const body = await readPrivateFile(checkpointSafePath(input.file ?? {}))
  let raw: unknown
  try {
    raw = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('Knowledge Planet verification checkpoint is invalid')
  } finally {
    zeroBuffer(body)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Knowledge Planet verification checkpoint is invalid')
  const record = raw as Record<string, unknown>
  if (
    !exactKeys(record, [
      'schemaVersion',
      'artifactHash',
      'execContractHash',
      'workerDigest',
      'imageId',
      'sourceCommit',
      'userId',
      'verification',
      'replaceExistingAccount',
      'expectedExistingAccountInstanceId',
      'replacementAccountInstanceId',
      'createdAt',
      'expiresAt',
      'nonce',
      'ciphertext',
    ])
  )
    throw new Error('Knowledge Planet verification checkpoint is invalid')
  const metadata = parseCheckpointMetadata(record, input.expected, input.now ?? Date.now())
  const nonce = decodeBase64(record.nonce, 'nonce', NONCE_BYTES)
  const ciphertext = decodeBase64(record.ciphertext, 'ciphertext', MAX_CIPHERTEXT_BYTES)
  if (nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) {
    zeroBuffer(nonce)
    zeroBuffer(ciphertext)
    throw new Error('Knowledge Planet verification checkpoint ciphertext is invalid')
  }
  const aad = metadataAad(metadata)
  const key = deriveKey(input.env ?? process.env, CHECKPOINT_HKDF_INFO)
  let plaintext: Buffer | null = null
  try {
    plaintext = decryptToBuffer(ciphertext, nonce, key, aad)
    const parsed = JSON.parse(plaintext.toString('utf8'))
    return {
      metadata,
      storageState: validateBrowserStorageState(parsed, input.expected.contract),
    }
  } catch {
    throw new Error('Knowledge Planet verification checkpoint authentication failed')
  } finally {
    if (plaintext) zeroBuffer(plaintext)
    zeroBuffer(nonce)
    zeroBuffer(ciphertext)
    zeroBuffer(aad)
    zeroBuffer(key)
  }
}

export async function deleteKnowledgePlanetVerificationCheckpoint(
  file: FileOptions = {},
): Promise<void> {
  const { path } = checkpointSafePath(file)
  await rm(path, { force: true })
}
