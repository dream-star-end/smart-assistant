/** Delivery metadata lives with the control journal, not in inode-specific
 * Worker staging. Large result bytes remain in pinned, authenticated sources. */
import { type Static, Type } from '@sinclair/typebox'
import {
  agentRemoteContentHash,
  remoteCanonical,
  requireRemote,
  validateRemote,
} from './agentRemote.js'
import {
  NativeDeliveryAckSchema,
  snapshotNativeTranscriptJson,
  verifyNativeJson,
} from './agentRemoteNative.js'
const closed = { additionalProperties: false }
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' })
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_.:-]+$' })
const uuid = Type.String({
  pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
})
export const NATIVE_DELIVERY_METADATA_MAX_BYTES = 7 * 1024 * 1024
// Includes request, the complete observed event prefix, and duplicated receipt.
// Reserve preparation/commit/ACK room before accepting more execution evidence.
export const NATIVE_EXECUTION_RECORD_MAX_BYTES = 48 * 1024 * 1024
// Account complete canonical events, including envelopes/hashes. The Host must
// reject before assigning a sequence; persisted prefixes are never truncated.
// Requests fit 8 MiB; 16 MiB ordinary events + 8 MiB final + its 8 MiB receipt
// copy leave room within the 48 MiB execution record and 64 MiB complete row.
export const NATIVE_ORDINARY_EVENT_MAX_BYTES = 16 * 1024 * 1024
export const NATIVE_FINAL_EVENT_MAX_BYTES = 8 * 1024 * 1024
export const NativeTranscriptTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal('main') }, closed),
  Type.Object(
    {
      kind: Type.Literal('sidechain'),
      agentId: Type.String({ pattern: '^a(?:[A-Za-z0-9_-]{1,96}-)?[a-f0-9]{16}$' }),
    },
    closed,
  ),
])
export type NativeTranscriptTarget = Static<typeof NativeTranscriptTargetSchema>
export const NativeMessageProjectionSchema = Type.Object(
  {
    uuid,
    target: NativeTranscriptTargetSchema,
    projectionHash: digest,
    parentUuid: Type.Union([uuid, Type.Null()]),
    logicalParentUuid: Type.Optional(Type.Union([uuid, Type.Null()])),
    timestamp: Type.String({ minLength: 1, maxLength: 128 }),
  },
  closed,
)
export type NativeMessageProjection = Static<typeof NativeMessageProjectionSchema>
export const NativeDeliveryBlobSchema = Type.Object(
  { resourceId: id, sizeBytes: integer, sha256: digest },
  closed,
)
export type NativeDeliveryBlob = Static<typeof NativeDeliveryBlobSchema>
export const NativeDeliverySourceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('execution'),
      hostInstanceId: id,
      ledgerId: id,
      environmentIncarnation: id,
      sealedSequence: positive,
      sealedEventHash: digest,
      /** Content-addressed, supervisor-owned objects; never arbitrary URLs/paths. */
      blobs: Type.Array(NativeDeliveryBlobSchema, { maxItems: 10000 }),
    },
    closed,
  ),
  Type.Object({ kind: Type.Literal('control.not-started'), receiptHash: digest }, closed),
])
export const NativeDeliveryPreparationSchema = Type.Object(
  {
    version: Type.Literal(1),
    preparationHash: digest,
    receiptHash: digest,
    projectionVersion: Type.Literal(1),
    source: NativeDeliverySourceSchema,
    artifactManifestHash: digest,
    artifactCount: integer,
    messages: Type.Array(NativeMessageProjectionSchema, { maxItems: 10000 }),
  },
  closed,
)
export type NativeDeliveryPreparation = Static<typeof NativeDeliveryPreparationSchema>
const prefix = Type.Object({ headUuid: uuid, headBytes: positive, prefixHash: digest }, closed)
export const NativeDeliveryWriterProofSchema = Type.Object(
  {
    nativeSessionId: uuid,
    preparationHash: digest,
    artifactManifestHash: digest,
    /** Always the real main JSONL, including when delivery targets only sidechains. */
    main: prefix,
    files: Type.Array(
      Type.Object(
        {
          target: NativeTranscriptTargetSchema,
          headBytes: positive,
          prefixHash: digest,
          projectionsHash: digest,
        },
        closed,
      ),
      { maxItems: 10000 },
    ),
  },
  closed,
)
export type NativeDeliveryWriterProof = Static<typeof NativeDeliveryWriterProofSchema>
export const NativeDeliveryCommitSchema = Type.Object(
  {
    version: Type.Literal(1),
    commitHash: digest,
    preparationHash: digest,
    receiptHash: digest,
    proof: NativeDeliveryWriterProofSchema,
    ack: NativeDeliveryAckSchema,
    committedAtMs: integer,
  },
  closed,
)
export type NativeDeliveryCommit = Static<typeof NativeDeliveryCommitSchema>
export function nativeDeliveryPreparationHash(
  requestHash: string,
  value: Omit<NativeDeliveryPreparation, 'preparationHash'>,
): string {
  const {
    version,
    receiptHash,
    projectionVersion,
    source,
    artifactManifestHash,
    artifactCount,
    messages,
  } = value
  return agentRemoteContentHash(
    `agent-remote-native-delivery-prepare-v1\n${remoteCanonical({ requestHash, version, receiptHash, projectionVersion, source, artifactManifestHash, artifactCount, messages })}`,
  )
}
export function nativeDeliveryCommitHash(
  requestHash: string,
  value: Omit<NativeDeliveryCommit, 'commitHash'>,
): string {
  const { version, preparationHash, receiptHash, proof, ack, committedAtMs } = value
  return agentRemoteContentHash(
    `agent-remote-native-delivery-commit-v1\n${remoteCanonical({ requestHash, version, preparationHash, receiptHash, proof, ack, committedAtMs })}`,
  )
}
export function nativeTranscriptTargetKey(target: NativeTranscriptTarget): string {
  return remoteCanonical(target)
}
export function nativeMessageProjectionsHash(messages: readonly NativeMessageProjection[]): string {
  return agentRemoteContentHash(
    `agent-remote-native-message-projections-v1\n${remoteCanonical(messages)}`,
  )
}
export function verifyNativeDeliveryPreparation(
  value: unknown,
  requestHash: string,
): asserts value is NativeDeliveryPreparation {
  verifyNativeJson(value)
  validateRemote<NativeDeliveryPreparation>(NativeDeliveryPreparationSchema, value)
  requireRemote(
    Buffer.byteLength(remoteCanonical(value), 'utf8') <= NATIVE_DELIVERY_METADATA_MAX_BYTES,
    'native-delivery-capacity',
  )
  requireRemote(
    value.preparationHash === nativeDeliveryPreparationHash(requestHash, value),
    'native-delivery-prepare-hash',
  )
  const ids = value.messages.map((message) => remoteCanonical([message.target, message.uuid]))
  requireRemote(new Set(ids).size === ids.length, 'native-delivery-message-duplicate')
  if (value.source.kind === 'execution') {
    const refs = value.source.blobs.map((blob) => blob.resourceId)
    requireRemote(new Set(refs).size === refs.length, 'native-delivery-source-duplicate')
  }
}
export function verifyNativeDeliveryCommit(
  value: unknown,
  requestHash: string,
  preparation: NativeDeliveryPreparation,
  nativeSessionId: string,
): asserts value is NativeDeliveryCommit {
  verifyNativeJson(value)
  validateRemote<NativeDeliveryCommit>(NativeDeliveryCommitSchema, value)
  requireRemote(
    Buffer.byteLength(remoteCanonical(value), 'utf8') <= NATIVE_DELIVERY_METADATA_MAX_BYTES,
    'native-delivery-capacity',
  )
  requireRemote(
    value.commitHash === nativeDeliveryCommitHash(requestHash, value),
    'native-delivery-commit-hash',
  )
  const { proof, ack } = value
  requireRemote(
    value.preparationHash === preparation.preparationHash &&
      value.receiptHash === preparation.receiptHash &&
      proof.preparationHash === preparation.preparationHash &&
      proof.nativeSessionId === nativeSessionId &&
      proof.artifactManifestHash === preparation.artifactManifestHash,
    'native-delivery-commit-scope',
  )
  requireRemote(
    ack.receiptHash === preparation.receiptHash &&
      ack.artifactManifestHash === preparation.artifactManifestHash &&
      ack.nativeHeadRevision === proof.main.headUuid &&
      ack.nativeHeadHash === proof.main.prefixHash,
    'native-delivery-commit-ack',
  )
  const groups = new Map<string, NativeMessageProjection[]>()
  for (const message of preparation.messages) {
    const key = nativeTranscriptTargetKey(message.target)
    const group = groups.get(key) ?? []
    group.push(message)
    groups.set(key, group)
  }
  const keys = proof.files.map((file) => nativeTranscriptTargetKey(file.target))
  requireRemote(
    new Set(keys).size === keys.length && keys.length === groups.size,
    'native-delivery-proof-files',
  )
  for (const file of proof.files) {
    const messages = groups.get(nativeTranscriptTargetKey(file.target))
    requireRemote(
      messages && file.projectionsHash === nativeMessageProjectionsHash(messages),
      'native-delivery-proof-projections',
    )
    if (file.target.kind === 'main')
      requireRemote(
        file.headBytes === proof.main.headBytes && file.prefixHash === proof.main.prefixHash,
        'native-delivery-proof-main',
      )
  }
}

// Only Writer envelope fields are excluded. UUID/type, source assistant identity
// and the entire message body (including usage/stop_reason) remain semantic.
const writerEnvelopeFields = new Set([
  'parentUuid',
  'logicalParentUuid',
  'isSidechain',
  'agentId',
  'teamName',
  'agentName',
  'promptId',
  'userType',
  'entrypoint',
  'cwd',
  'sessionId',
  'timestamp',
  'version',
  'gitBranch',
  'slug',
])
export function nativeTranscriptMessageContent(value: unknown): Record<string, unknown> {
  const snapshot = snapshotNativeTranscriptJson(value)
  requireRemote(
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),
    'native-transcript-message',
  )
  return Object.fromEntries(
    Object.entries(snapshot as Record<string, unknown>).filter(
      ([key]) => !writerEnvelopeFields.has(key),
    ),
  )
}
export function nativeTranscriptMessageHash(value: unknown): string {
  return agentRemoteContentHash(
    `agent-remote-native-message-v1\n${remoteCanonical(nativeTranscriptMessageContent(value))}`,
  )
}
