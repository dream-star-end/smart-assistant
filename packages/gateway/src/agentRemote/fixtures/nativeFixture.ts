import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type test from 'node:test'
import type {
  AgentRemoteBinding,
  AgentRemoteEnvironment,
  AgentRemoteLeaseToken,
  AgentRemoteWorker,
} from '@openclaude/protocol/agentRemote'
import { agentRemoteContentHash, remoteCanonical } from '@openclaude/protocol/agentRemote'
import { nativeExecutionHash } from '@openclaude/protocol/agentRemoteNative'
import {
  type NativeDeliveryPreparation,
  type NativeDeliveryWriterProof,
  nativeDeliveryCommitHash,
  nativeDeliveryPreparationHash,
  nativeMessageProjectionsHash,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
import { SqliteAgentRemoteStore } from '../durableStore.js'
import {
  type NativeJournalRecord,
  nativeJournalEventHash,
  nativeReceiptHash,
} from '../nativeJournal.js'
import { createAgentRemoteService } from '../service.js'
import type { AgentRemoteState } from '../store.js'
export const uuid = '12345678-1234-1234-1234-123456789abc'
export interface NativeFixture {
  root: string
  path: string
  store: SqliteAgentRemoteStore
  service: NonNullable<ReturnType<typeof createAgentRemoteService>>
  worker: AgentRemoteWorker
  environment: AgentRemoteEnvironment
  binding: AgentRemoteBinding
  lease: AgentRemoteLeaseToken
  record: (operationId?: string) => NativeJournalRecord
  now: () => number
  setNow: (value: number) => void
}
export async function fixture(t: test.TestContext): Promise<NativeFixture> {
  const root = mkdtempSync(join(tmpdir(), 'native-journal-'))
  const path = join(root, 'native.sqlite')
  const store = new SqliteAgentRemoteStore(path)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  let now = 1000
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => store,
    clock: () => now,
  })!
  const worker = {
    protocolVersion: 1 as const,
    principalId: 'u1',
    workerId: 'w1',
    workerInstanceId: 'wi1',
    engines: ['ccb' as const],
  }
  await service.registerWorker('u1', worker, 300000)
  const environment = {
    protocolVersion: 1 as const,
    principalId: 'u1',
    environmentId: 'e1',
    generation: 1,
    kind: 'container' as const,
    containerId: 'synthetic',
    containerIncarnation: 'boot1',
    runtimeRevision: 'r1',
    workspaceRoot: '/workspace',
    capabilities: ['file.read' as const],
  }
  await service.registerEnvironment('u1', environment)
  const binding = await service.bind('u1', { sessionId: 's1', workerId: 'w1', environmentId: 'e1' })
  const lease = await service.claim('u1', binding, 1000)
  await service.pinNativeSession('u1', binding, lease, uuid)
  function record(operationId = 'op1'): NativeJournalRecord {
    const identity = { binding, nativeSessionId: uuid, environmentIncarnation: 'boot1' }
    const semantic = {
      kind: 'native.execute' as const,
      contextRevision: 1,
      manifestRevision: 'a'.repeat(64),
      deadlineAtMs: 10000,
      toolUse: { id: `toolu_${operationId}`, name: 'Bash', input: { command: 'synthetic' } },
      assistantMessage: { type: 'assistant' },
    }
    return {
      recordVersion: 1,
      request: {
        ...structuredClone(identity),
        operationId,
        body: { ...semantic, payloadHash: nativeExecutionHash(identity, operationId, semantic) },
      },
      claim: { ...lease },
      state: 'accepted',
      cancelRequested: false,
      events: [],
      createdAtMs: 1000,
      updatedAtMs: 1000,
    }
  }
  return {
    root,
    path,
    store,
    service,
    worker,
    environment,
    binding,
    lease,
    record,
    now: () => now,
    setNow: (value: number) => {
      now = value
    },
  }
}
export function receipt(record: NativeJournalRecord) {
  const body = {
    kind: 'native.receipt' as const,
    payloadHash: record.request.body.payloadHash,
    status: 'completed' as const,
    message: { type: 'user', content: 'done' },
  }
  record.dispatch ??= { hostInstanceId: 'h1', ledgerId: 'l1', grantId: 'g1' }
  if (record.state === 'accepted') record.state = 'dispatched'
  const event = {
    sequence: record.events.length + 1,
    sender: 'execution' as const,
    producerInstanceId: record.dispatch.hostInstanceId,
    ledgerId: record.dispatch.ledgerId,
    epoch: record.claim.epoch,
    body,
  }
  record.events.push({
    ...event,
    sha256: nativeJournalEventHash(record.request.body.payloadHash, event),
  })
  record.receipt = { body, sha256: nativeReceiptHash(record.request.body.payloadHash, body) }
}
/** Synthetic control/store state only: this helper is never Writer IO proof. */
export function syntheticDelivery(record: NativeJournalRecord): {
  preparation: NativeDeliveryPreparation
  proof: NativeDeliveryWriterProof
} {
  const hash = agentRemoteContentHash(record.request.operationId)
  const messageUuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  const artifacts = new Map()
  for (const event of record.events)
    if (event.body.kind === 'native.artifacts')
      for (const artifact of event.body.artifacts) artifacts.set(artifact.relativePath, artifact)
  const manifest = [...artifacts.values()].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  )
  const artifactManifestHash = agentRemoteContentHash(
    `agent-remote-native-artifacts-v1\n${remoteCanonical(manifest)}`,
  )
  const message = {
    uuid: messageUuid,
    target: { kind: 'main' as const },
    projectionHash: 'b'.repeat(64),
    parentUuid: null,
    timestamp: '2026-11-01T20:00:00.000Z',
  }
  const source = record.dispatch
    ? {
        kind: 'execution' as const,
        ...record.dispatch,
        environmentIncarnation: record.request.environmentIncarnation,
        sealedSequence: record.events.length,
        sealedEventHash: record.events.at(-1)!.sha256,
        blobs: [],
      }
    : { kind: 'control.not-started' as const, receiptHash: record.receipt!.sha256 }
  // grantId is dispatch authorization, never part of the sealed source identity.
  const preparedSource =
    source.kind === 'execution'
      ? {
          kind: source.kind,
          hostInstanceId: source.hostInstanceId,
          ledgerId: source.ledgerId,
          environmentIncarnation: source.environmentIncarnation,
          sealedSequence: source.sealedSequence,
          sealedEventHash: source.sealedEventHash,
          blobs: source.blobs,
        }
      : source
  const semantic = {
    version: 1 as const,
    receiptHash: record.receipt!.sha256,
    projectionVersion: 1 as const,
    source: preparedSource,
    artifactManifestHash,
    artifactCount: manifest.length,
    messages: [message],
  }
  const preparation = {
    ...semantic,
    preparationHash: nativeDeliveryPreparationHash(record.request.body.payloadHash, semantic),
  }
  const proof = {
    nativeSessionId: record.request.nativeSessionId,
    preparationHash: preparation.preparationHash,
    artifactManifestHash,
    main: { headUuid: messageUuid, headBytes: 100, prefixHash: 'c'.repeat(64) },
    files: [
      {
        target: { kind: 'main' as const },
        headBytes: 100,
        prefixHash: 'c'.repeat(64),
        projectionsHash: nativeMessageProjectionsHash(preparation.messages),
      },
    ],
  }
  return { preparation, proof }
}
export function deliver(record: NativeJournalRecord, state?: AgentRemoteState) {
  const firstCommit = !record.deliveryCommit
  const { preparation, proof } = syntheticDelivery(record)
  record.deliveryPreparation = preparation
  const body = {
    version: 1 as const,
    preparationHash: preparation.preparationHash,
    receiptHash: record.receipt!.sha256,
    proof,
    ack: {
      kind: 'native.delivery.ack' as const,
      receiptHash: record.receipt!.sha256,
      nativeHeadRevision: proof.main.headUuid,
      nativeHeadHash: proof.main.prefixHash,
      artifactManifestHash: preparation.artifactManifestHash,
    },
    committedAtMs: record.updatedAtMs,
  }
  record.deliveryCommit = {
    ...body,
    commitHash: nativeDeliveryCommitHash(record.request.body.payloadHash, body),
  }
  record.deliveryAck = structuredClone(record.deliveryCommit.ack)
  if (firstCommit && state)
    state.sessions.find(
      (session) => session.binding.sessionId === record.request.binding.sessionId,
    )!.nativeDeliveryWatermark++
  record.state = record.receipt!.body.status
}
