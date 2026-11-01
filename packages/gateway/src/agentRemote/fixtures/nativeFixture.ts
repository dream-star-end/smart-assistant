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
import { nativeExecutionHash } from '@openclaude/protocol/agentRemoteNative'
import { SqliteAgentRemoteStore } from '../durableStore.js'
import {
  type NativeJournalRecord,
  nativeJournalEventHash,
  nativeReceiptHash,
} from '../nativeJournal.js'
import { createAgentRemoteService } from '../service.js'
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
export function deliver(record: NativeJournalRecord) {
  record.deliveryAck = {
    kind: 'native.delivery.ack',
    receiptHash: record.receipt!.sha256,
    nativeHeadRevision: 'head1',
    nativeHeadHash: 'b'.repeat(64),
    artifactManifestHash: 'c'.repeat(64),
  }
  record.state = 'completed'
}
