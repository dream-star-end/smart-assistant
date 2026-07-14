/** Domain-separated Ed25519 assertion for commercial master → container preview. */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

import {
  CONTAINER_PREVIEW_PROTOCOL_VERSION,
  type ContainerPreviewViewport,
  canonicalContainerPreviewTarget,
} from './containerPreview.js'
import { type AuthorityKeyring, type JsonValue, canonicalizePayload } from './modelAuthority.js'

export const CONTAINER_PREVIEW_ASSERTION_KIND = 'container_preview_bridge'
export const CONTAINER_PREVIEW_ASSERTION_MAX_TTL_MS = 30_000
const CONTAINER_PREVIEW_ASSERTION_DOMAIN = 'oc-container-preview-bridge-v1'

export type ContainerPreviewAssertionErrorCode =
  | 'BadShape'
  | 'UnknownKey'
  | 'VerifyFail'
  | 'Expired'

export class ContainerPreviewAssertionError extends Error {
  constructor(
    readonly code: ContainerPreviewAssertionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ContainerPreviewAssertionError'
  }
}

export interface ContainerPreviewBridgeAssertionPayload {
  readonly v: typeof CONTAINER_PREVIEW_PROTOCOL_VERSION
  readonly keyId: string
  readonly uid: number
  readonly containerId: number
  /** 128-bit lower-case hex, consumed once by the container gateway. */
  readonly sessionId: string
  /** SHA-256 of canonical URL + canonical viewport serialization. */
  readonly targetHash: string
  readonly issuedAt: number
  readonly expiresAt: number
}

export function containerPreviewTargetHash(
  canonicalUrl: string,
  viewport: ContainerPreviewViewport,
): string {
  return createHash('sha256')
    .update(canonicalContainerPreviewTarget(canonicalUrl, viewport), 'utf8')
    .digest('hex')
}

export function containerPreviewAssertionSigningInput(
  payload: ContainerPreviewBridgeAssertionPayload,
): Buffer {
  return Buffer.from(
    `${CONTAINER_PREVIEW_ASSERTION_DOMAIN}\n${canonicalizePayload(payload as unknown as JsonValue)}`,
    'utf8',
  )
}

export function encodeContainerPreviewAssertion(
  payload: ContainerPreviewBridgeAssertionPayload,
  signature: Uint8Array,
): string {
  if (signature.byteLength !== 64)
    throw new ContainerPreviewAssertionError('BadShape', 'bad signature length')
  const envelope = {
    v: CONTAINER_PREVIEW_PROTOCOL_VERSION,
    kind: CONTAINER_PREVIEW_ASSERTION_KIND,
    payload,
    sig: Buffer.from(signature).toString('base64url'),
  }
  return Buffer.from(canonicalizePayload(envelope as unknown as JsonValue), 'utf8').toString(
    'base64url',
  )
}

export function verifyContainerPreviewAssertion(
  envelope: string,
  keyring: AuthorityKeyring,
  now: number = Date.now(),
): ContainerPreviewBridgeAssertionPayload {
  if (typeof envelope !== 'string' || envelope.length < 1 || envelope.length > 4_096) {
    throw new ContainerPreviewAssertionError('BadShape', 'assertion length invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(envelope, 'base64url').toString('utf8'))
  } catch {
    throw new ContainerPreviewAssertionError('BadShape', 'assertion is not valid JSON')
  }
  if (!isRecord(decoded) || !hasExactKeys(decoded, ['kind', 'payload', 'sig', 'v'])) {
    throw new ContainerPreviewAssertionError('BadShape', 'assertion envelope shape invalid')
  }
  if (
    decoded.v !== CONTAINER_PREVIEW_PROTOCOL_VERSION ||
    decoded.kind !== CONTAINER_PREVIEW_ASSERTION_KIND
  ) {
    throw new ContainerPreviewAssertionError('BadShape', 'assertion kind or version invalid')
  }
  const payload = parsePayload(decoded.payload)
  if (typeof decoded.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(decoded.sig)) {
    throw new ContainerPreviewAssertionError('BadShape', 'assertion signature shape invalid')
  }
  const signature = Buffer.from(decoded.sig, 'base64url')
  if (signature.byteLength !== 64)
    throw new ContainerPreviewAssertionError('BadShape', 'bad signature length')

  const publicRaw = keyring.get(payload.keyId)
  if (!publicRaw)
    throw new ContainerPreviewAssertionError('UnknownKey', 'assertion key is not trusted')
  if (publicRaw.byteLength !== 32)
    throw new ContainerPreviewAssertionError('BadShape', 'bad public key length')
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicRaw).toString('base64url') },
    format: 'jwk',
  })
  if (!cryptoVerify(null, containerPreviewAssertionSigningInput(payload), publicKey, signature)) {
    throw new ContainerPreviewAssertionError('VerifyFail', 'assertion signature invalid')
  }
  if (payload.expiresAt <= now)
    throw new ContainerPreviewAssertionError('Expired', 'assertion expired')
  if (
    payload.issuedAt > now + 5_000 ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > CONTAINER_PREVIEW_ASSERTION_MAX_TTL_MS
  ) {
    throw new ContainerPreviewAssertionError('BadShape', 'assertion timestamps invalid')
  }
  return payload
}

function parsePayload(value: unknown): ContainerPreviewBridgeAssertionPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'containerId',
      'expiresAt',
      'issuedAt',
      'keyId',
      'sessionId',
      'targetHash',
      'uid',
      'v',
    ])
  ) {
    throw new ContainerPreviewAssertionError('BadShape', 'assertion payload shape invalid')
  }
  if (value.v !== CONTAINER_PREVIEW_PROTOCOL_VERSION) {
    throw new ContainerPreviewAssertionError('BadShape', 'payload version invalid')
  }
  if (typeof value.keyId !== 'string' || !/^mak1_[0-9a-f]{16}$/.test(value.keyId)) {
    throw new ContainerPreviewAssertionError('BadShape', 'payload keyId invalid')
  }
  if (!safePositiveInteger(value.uid) || !safePositiveInteger(value.containerId)) {
    throw new ContainerPreviewAssertionError('BadShape', 'payload identity invalid')
  }
  if (typeof value.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(value.sessionId)) {
    throw new ContainerPreviewAssertionError('BadShape', 'payload sessionId invalid')
  }
  if (typeof value.targetHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.targetHash)) {
    throw new ContainerPreviewAssertionError('BadShape', 'payload targetHash invalid')
  }
  if (!safeTimestamp(value.issuedAt) || !safeTimestamp(value.expiresAt)) {
    throw new ContainerPreviewAssertionError('BadShape', 'payload timestamps invalid')
  }
  return value as unknown as ContainerPreviewBridgeAssertionPayload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
