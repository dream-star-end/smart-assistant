/** Synthetic control fixture paired with a real CCB Writer process. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeExecutionHash } from '@openclaude/protocol/agentRemoteNative'
import {
  nativeDeliveryPreparationHash,
  nativeTranscriptMessageHash,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
import { nativeArtifactManifestHash } from '@openclaude/storage'
import { SqliteAgentRemoteStore } from '../durableStore.js'
import type { NativeJournalRecord } from '../nativeJournal.js'
import { NativeJournalService } from '../nativeService.js'
import { createAgentRemoteService } from '../service.js'
import { receipt } from './nativeFixture.js'

async function readProof(): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of process.stdin) {
    const bytes = Buffer.from(value)
    size += bytes.length
    if (size > 1024 * 1024) throw Error('fixture proof bound')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}
const [mode, root] = process.argv.slice(2)
if (!root) throw Error('fixture root required')
const sid = '00000000-0000-4000-8000-000000000006'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const timestamp = '2026-11-01T00:00:00.000Z'
const store = new SqliteAgentRemoteStore(join(root, 'control.sqlite'))
const native = new NativeJournalService(store, () => 1000)
try {
  if (mode === 'init') {
    const service = createAgentRemoteService({
      env: { OC_AGENT_REMOTE_ENABLED: '1' },
      createStore: () => store,
      clock: () => 1000,
    })!
    await service.registerWorker(
      'u1',
      {
        protocolVersion: 1,
        principalId: 'u1',
        workerId: 'w1',
        workerInstanceId: 'wi1',
        engines: ['ccb'],
      },
      300000,
    )
    await service.registerEnvironment('u1', {
      protocolVersion: 1,
      principalId: 'u1',
      environmentId: 'e1',
      generation: 1,
      kind: 'container',
      containerId: 'synthetic',
      containerIncarnation: 'boot1',
      runtimeRevision: 'r1',
      workspaceRoot: '/workspace',
      capabilities: ['file.read'],
    })
    const binding = await service.bind('u1', {
      sessionId: 's1',
      workerId: 'w1',
      environmentId: 'e1',
    })
    const lease = await service.claim('u1', binding, 1000)
    const source = (n: number, type: 'user' | 'assistant' = 'user') => ({
      type,
      uuid: uuid(n),
      timestamp,
      message: {
        role: type,
        ...(type === 'assistant' ? { id: `model-${n}` } : {}),
        content: [{ type: 'text', text: `frozen-${n}` }],
      },
    })
    const initial = [source(0), source(1, 'assistant')]
    const messages = [source(2), source(3, 'assistant'), source(4)]
    const identity = { binding, nativeSessionId: sid, environmentIncarnation: 'boot1' }
    const operationId = 'crash-delivery'
    const semantic = {
      kind: 'native.execute' as const,
      contextRevision: 1,
      manifestRevision: 'a'.repeat(64),
      deadlineAtMs: 10000,
      toolUse: { id: 'toolu_crash', name: 'Bash', input: { command: 'synthetic' } },
      assistantMessage: initial[1],
    }
    const payloadHash = nativeExecutionHash(identity, operationId, semantic)
    const row: NativeJournalRecord = {
      recordVersion: 1,
      request: { ...identity, operationId, body: { ...semantic, payloadHash } },
      claim: lease,
      state: 'accepted',
      cancelRequested: false,
      events: [],
      createdAtMs: 1000,
      updatedAtMs: 1000,
    }
    receipt(row)
    await store.transact('u1', (state) => {
      state.nativeJournal.push(row)
    })
    const scope = { ...identity, lease, connectionId: 'writer1', challenge: 'a'.repeat(64) }
    const base = {
      version: 1 as const,
      receiptHash: row.receipt!.sha256,
      projectionVersion: 1 as const,
      source: {
        kind: 'execution' as const,
        hostInstanceId: row.dispatch!.hostInstanceId,
        ledgerId: row.dispatch!.ledgerId,
        environmentIncarnation: 'boot1',
        sealedSequence: row.events.length,
        sealedEventHash: row.events.at(-1)!.sha256,
        blobs: [],
      },
      artifactManifestHash: nativeArtifactManifestHash([]),
      artifactCount: 0,
      messages: messages.map((message, index) => ({
        uuid: message.uuid,
        target: { kind: 'main' as const },
        projectionHash: nativeTranscriptMessageHash(message),
        parentUuid: index ? messages[index - 1]!.uuid : uuid(1),
        timestamp,
      })),
    }
    const preparation = {
      ...base,
      preparationHash: nativeDeliveryPreparationHash(payloadHash, base),
    }
    await native.prepareDelivery('u1', scope, operationId, payloadHash, preparation)
    writeFileSync(
      join(root, 'delivery.json'),
      JSON.stringify({
        nativeSessionId: sid,
        operationId,
        payloadHash,
        scope,
        preparation,
        initial,
        messages,
      }),
      { mode: 0o600 },
    )
    process.stdout.write('{}')
  } else {
    const pinned = JSON.parse(readFileSync(join(root, 'delivery.json'), 'utf8'))
    const row =
      mode === 'commit'
        ? await native.commitDelivery(
            'u1',
            pinned.scope,
            pinned.operationId,
            pinned.payloadHash,
            pinned.preparation.preparationHash,
            JSON.parse(await readProof()),
          )
        : await native.query('u1', pinned.scope, pinned.operationId, pinned.payloadHash)
    process.stdout.write(JSON.stringify(row))
  }
} finally {
  store.close()
}
