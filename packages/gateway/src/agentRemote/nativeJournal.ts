import {
  BindingSchema,
  LeaseSchema,
  agentRemoteContentHash,
  remoteCanonical,
  remoteTerminal,
  requireRemote,
  validateRemote,
} from '@openclaude/protocol/agentRemote'
import {
  NativeBodySchema,
  NativeDeliveryAckSchema,
  NativeExecutionBodySchema,
  NativeReceiptBodySchema,
  nativeExecutionHash,
  nativeOperationKey,
  verifyNativeBodySemantics,
  verifyNativeJson,
} from '@openclaude/protocol/agentRemoteNative'
import {
  NATIVE_EXECUTION_RECORD_MAX_BYTES,
  NATIVE_FINAL_EVENT_MAX_BYTES,
  NATIVE_ORDINARY_EVENT_MAX_BYTES,
  type NativeDeliveryBlob,
  NativeDeliveryBlobSchema,
  NativeDeliveryCommitSchema,
  type NativeDeliveryPreparation,
  NativeDeliveryPreparationSchema,
  verifyNativeDeliveryCommit,
  verifyNativeDeliveryPreparation,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
/** Native records share the P2 principal transaction and fences. Execution
 * receipts and durable Writer delivery are deliberately different facts.
 */
import { type Static, Type } from '@sinclair/typebox'
const closed = { additionalProperties: false }
const id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_.:-]+$' })
const number = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' })
export const NativeIntentSchema = Type.Object(
  {
    binding: BindingSchema,
    nativeSessionId: Type.String({
      pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
    }),
    environmentIncarnation: id,
    operationId: id,
    body: NativeExecutionBodySchema,
  },
  closed,
)
export type NativeIntent = Static<typeof NativeIntentSchema>
export const NativeJournalEventSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    sender: Type.Union([Type.Literal('worker'), Type.Literal('execution')]),
    producerInstanceId: id,
    ledgerId: id,
    epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    body: NativeBodySchema,
    sha256: digest,
  },
  closed,
)
export type NativeJournalEvent = Static<typeof NativeJournalEventSchema>
export const NativeJournalRecordSchema = Type.Object(
  {
    recordVersion: Type.Literal(1),
    request: NativeIntentSchema,
    claim: LeaseSchema,
    state: Type.Union(
      (
        [
          'accepted',
          'dispatched',
          'started',
          'unknown',
          'completed',
          'failed',
          'cancelled',
        ] as const
      ).map((x) => Type.Literal(x)),
    ),
    cancelRequested: Type.Boolean(),
    dispatch: Type.Optional(Type.Object({ hostInstanceId: id, ledgerId: id, grantId: id }, closed)),
    effectiveInput: Type.Optional(Type.Object({ sha256: digest, policyRevision: number }, closed)),
    events: Type.Array(NativeJournalEventSchema, { maxItems: 10000 }),
    receipt: Type.Optional(
      Type.Object(
        {
          body: Type.Object(
            {
              ...NativeReceiptBodySchema.properties,
              status: Type.Union(
                (['completed', 'failed', 'cancelled'] as const).map((value) => Type.Literal(value)),
              ),
            },
            closed,
          ),
          sha256: digest,
        },
        closed,
      ),
    ),
    deliveryPreparation: Type.Optional(NativeDeliveryPreparationSchema),
    deliveryCommit: Type.Optional(NativeDeliveryCommitSchema),
    deliveryAck: Type.Optional(NativeDeliveryAckSchema),
    createdAtMs: number,
    updatedAtMs: number,
  },
  closed,
)
export type NativeJournalRecord = Static<typeof NativeJournalRecordSchema>
export function nativeJournalEventHash(
  requestHash: string,
  event: Omit<NativeJournalEvent, 'sha256'>,
): string {
  const { sequence, sender, producerInstanceId, ledgerId, epoch, body } = event
  return agentRemoteContentHash(
    `agent-remote-native-event-v1\n${remoteCanonical({ requestHash, sequence, sender, producerInstanceId, ledgerId, epoch, body })}`,
  )
}
export function nativeReceiptHash(requestHash: string, body: unknown): string {
  return agentRemoteContentHash(
    `agent-remote-native-receipt-v1\n${remoteCanonical({ requestHash, body })}`,
  )
}
/** Shared operation-event boundary for control and Host outboxes. Session
 * bootstrap/manifest and operation commands never enter a result-event prefix. */
export function nativeOperationEventKindAllowed(kind: string): boolean {
  return ![
    'native.execute',
    'native.query',
    'native.cancel',
    'runtime.bootstrap',
    'runtime.refresh',
    'native.manifest',
  ].includes(kind)
}
const sameNativeEvidence = (a: unknown, b: unknown) => remoteCanonical(a) === remoteCanonical(b)
export function verifyNativeDeliveryEvidence(
  row: NativeJournalRecord,
  preparation: NativeDeliveryPreparation,
): void {
  const source = preparation.source
  if (source.kind === 'control.not-started') {
    requireRemote(
      !row.dispatch &&
        row.events.length === 0 &&
        row.receipt?.body.status === 'cancelled' &&
        row.receipt.body.code === 'not-started' &&
        source.receiptHash === row.receipt.sha256,
      'native-delivery-source',
    )
  } else {
    const last = row.events.at(-1)
    requireRemote(
      row.dispatch &&
        source.hostInstanceId === row.dispatch.hostInstanceId &&
        source.ledgerId === row.dispatch.ledgerId &&
        source.environmentIncarnation === row.request.environmentIncarnation &&
        last?.body.kind === 'native.receipt' &&
        source.sealedSequence === row.events.length &&
        source.sealedEventHash === last.sha256,
      'native-delivery-source',
    )
    // Source blobs must be declared by the Host envelope, never invented by a
    // Worker/model as a URL or a path. The source port also checks op ownership.
    const declared = new Map<string, NativeDeliveryBlob>()
    for (const event of row.events) {
      const message =
        event.body.kind === 'native.progress' || event.body.kind === 'native.receipt'
          ? event.body.message
          : undefined
      const envelope = message && typeof message === 'object' ? message.nativeDelivery : undefined
      if (
        envelope &&
        typeof envelope === 'object' &&
        !Array.isArray(envelope) &&
        'blobs' in envelope &&
        Array.isArray(envelope.blobs)
      )
        for (const blob of envelope.blobs) {
          validateRemote<NativeDeliveryBlob>(NativeDeliveryBlobSchema, blob)
          const old = declared.get(blob.resourceId)
          requireRemote(
            !old || sameNativeEvidence(old, blob),
            'native-delivery-source-blob-conflict',
          )
          declared.set(blob.resourceId, blob)
        }
    }
    requireRemote(
      sameNativeEvidence(
        [...declared.values()].sort((a, b) =>
          a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0,
        ),
        [...source.blobs].sort((a, b) =>
          a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0,
        ),
      ),
      'native-delivery-source-blobs',
    )
  }
  const artifacts = new Map<
    string,
    import('@openclaude/protocol/agentRemoteNative').NativeArtifact
  >()
  for (const event of row.events)
    if (event.body.kind === 'native.artifacts')
      for (const artifact of event.body.artifacts) {
        const previous = artifacts.get(artifact.relativePath)
        requireRemote(
          !previous || sameNativeEvidence(previous, artifact),
          'native-delivery-artifact-conflict',
        )
        artifacts.set(artifact.relativePath, artifact)
      }
  const manifest = [...artifacts.values()].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  )
  requireRemote(
    preparation.artifactCount === manifest.length &&
      preparation.artifactManifestHash ===
        agentRemoteContentHash(`agent-remote-native-artifacts-v1\n${remoteCanonical(manifest)}`),
    'native-delivery-artifact-manifest',
  )
}

export function verifyNativeJournalRecord(value: unknown): asserts value is NativeJournalRecord {
  validateRemote<NativeJournalRecord>(NativeJournalRecordSchema, value)
  verifyNativeJson(value.request)
  const { payloadHash, ...body } = value.request.body
  requireRemote(
    payloadHash === nativeExecutionHash(value.request, value.request.operationId, body),
    'native-stored-request-hash',
  )
  requireRemote(value.updatedAtMs >= value.createdAtMs, 'native-stored-time')
  requireRemote(
    value.claim.ownerInstanceId === value.request.binding.workerInstanceId,
    'native-stored-owner',
  )
  let finalEvent: typeof value.receipt | undefined
  let ordinaryBytes = 0
  for (let index = 0; index < value.events.length; index++) {
    requireRemote(!finalEvent, 'native-stored-event-after-receipt')
    const { sha256, ...event } = value.events[index]!
    verifyNativeJson(event.body)
    const eventBytes = Buffer.byteLength(remoteCanonical(value.events[index]), 'utf8')
    if (event.body.kind === 'native.receipt' && event.body.status !== 'unknown') {
      requireRemote(eventBytes <= NATIVE_FINAL_EVENT_MAX_BYTES, 'native-final-event-capacity')
    } else {
      ordinaryBytes += eventBytes
      requireRemote(
        ordinaryBytes <= NATIVE_ORDINARY_EVENT_MAX_BYTES && index < 9999,
        'native-ordinary-event-capacity',
      )
    }
    if (event.body.kind === 'native.receipt') {
      requireRemote(event.body.payloadHash === payloadHash, 'native-stored-receipt')
      if (event.body.status !== 'unknown')
        finalEvent = {
          body: { ...event.body, status: event.body.status },
          sha256: nativeReceiptHash(payloadHash, event.body),
        }
    }

    verifyNativeBodySemantics(value.request, value.request.operationId, event.sender, event.body)
    requireRemote(event.epoch === value.claim.epoch, 'native-stored-event-epoch')
    if (event.sender === 'execution')
      requireRemote(
        value.dispatch &&
          event.producerInstanceId === value.dispatch.hostInstanceId &&
          event.ledgerId === value.dispatch.ledgerId,
        'native-stored-event-producer',
      )
    else
      requireRemote(
        event.producerInstanceId === value.request.binding.workerInstanceId,
        'native-stored-event-producer',
      )

    requireRemote(
      event.sequence === index + 1 && sha256 === nativeJournalEventHash(payloadHash, event),
      'native-stored-event-hash',
    )
    requireRemote(nativeOperationEventKindAllowed(event.body.kind), 'native-stored-event-kind')
  }
  requireRemote(!finalEvent || value.receipt, 'native-stored-receipt-event')
  if (value.receipt) {
    verifyNativeJson(value.receipt.body)
    const notStarted =
      value.receipt.body.status === 'cancelled' &&
      value.receipt.body.code === 'not-started' &&
      !value.dispatch &&
      value.events.length === 0
    requireRemote(
      notStarted || (finalEvent && remoteCanonical(finalEvent) === remoteCanonical(value.receipt)),
      'native-stored-receipt-event',
    )

    requireRemote(
      value.receipt.body.kind === 'native.receipt' &&
        value.receipt.body.payloadHash === payloadHash &&
        value.receipt.sha256 === nativeReceiptHash(payloadHash, value.receipt.body),
      'native-stored-receipt',
    )
  }
  const { deliveryPreparation, deliveryCommit, deliveryAck, ...execution } = value
  requireRemote(
    Buffer.byteLength(remoteCanonical(execution), 'utf8') <= NATIVE_EXECUTION_RECORD_MAX_BYTES,
    'native-execution-capacity',
  )
  if (deliveryPreparation) {
    verifyNativeDeliveryPreparation(deliveryPreparation, payloadHash)
    requireRemote(
      value.receipt && deliveryPreparation.receiptHash === value.receipt.sha256,
      'native-stored-preparation-receipt',
    )
    verifyNativeDeliveryEvidence(value, deliveryPreparation)
  }
  if (deliveryCommit) {
    requireRemote(deliveryPreparation, 'native-stored-commit-without-prepare')
    verifyNativeDeliveryCommit(
      deliveryCommit,
      payloadHash,
      deliveryPreparation!,
      value.request.nativeSessionId,
    )
    requireRemote(
      deliveryAck && remoteCanonical(deliveryAck) === remoteCanonical(deliveryCommit.ack),
      'native-stored-commit-without-ack',
    )
  }
  if (deliveryAck) requireRemote(deliveryCommit, 'native-stored-delivery-without-commit')
  if (value.deliveryAck)
    requireRemote(
      value.receipt &&
        value.receipt.body.kind === 'native.receipt' &&
        value.deliveryAck.receiptHash === value.receipt.sha256,
      'native-stored-delivery',
    )
  if (remoteTerminal(value.state))
    requireRemote(
      value.receipt?.body.kind === 'native.receipt' &&
        value.receipt.body.status === value.state &&
        value.deliveryAck,
      'native-stored-terminal-without-delivery',
    )
  else requireRemote(!value.deliveryAck, 'native-stored-delivery-state')
  if (value.state === 'accepted')
    requireRemote(
      !value.dispatch && !value.effectiveInput && value.events.length === 0,
      'native-stored-accepted-state',
    )
  if (['dispatched', 'started', 'unknown'].includes(value.state))
    requireRemote(value.dispatch, 'native-stored-dispatch')
  if (value.effectiveInput) requireRemote(value.dispatch, 'native-stored-effective-input')
}
export function nativeJournalKey(record: NativeJournalRecord): string {
  return nativeOperationKey(record.request, record.request.operationId)
}
