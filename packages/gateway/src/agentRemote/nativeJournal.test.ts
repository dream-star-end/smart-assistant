import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { agentRemoteContentHash } from '@openclaude/protocol/agentRemote'
import { nativeExecutionHash } from '@openclaude/protocol/agentRemoteNative'
import { nativeCheckpointId } from '@openclaude/protocol/agentRemoteState'
import Database from 'better-sqlite3'
import { SqliteAgentRemoteStore } from './durableStore.js'
import { deliver, fixture, receipt, uuid } from './fixtures/nativeFixture.js'
import {
  type NativeJournalRecord,
  nativeJournalEventHash,
  nativeJournalKey,
  nativeReceiptHash,
} from './nativeJournal.js'
import { createAgentRemoteService } from './service.js'
test('native rows survive reopen; receipt alone blocks all four shared mutation gates', async (t) => {
  const f = await fixture(t)
  const record = f.record()
  await f.store.transact('u1', (state) => {
    state.nativeJournal.push(record)
  })
  await f.store.transact('u1', (state) => {
    const row = state.nativeJournal[0]!
    row.state = 'started'
    row.dispatch = { hostInstanceId: 'h1', ledgerId: 'ledger1', grantId: 'g1' }
    receipt(row)
  })
  f.store.close()
  const reopened = new SqliteAgentRemoteStore(f.path)
  t.after(() => reopened.close())
  assert.equal(
    (await reopened.transact('u1', (state) => state.nativeJournal, 'active'))[0]!.receipt!.body
      .kind,
    'native.receipt',
  )
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => reopened,
    clock: () => 1000,
  })!
  await assert.rejects(
    service.registerWorker('u1', { ...f.worker, workerInstanceId: 'wi2' }, 300000),
    /inflight-worker/,
  )
  await assert.rejects(
    service.registerEnvironment('u1', { ...f.environment, generation: 2 }),
    /inflight-environment/,
  )
  await service.registerWorker(
    'u1',
    { ...f.worker, workerId: 'w2', workerInstanceId: 'wi2' },
    300000,
  )
  await assert.rejects(
    service.bind('u1', { sessionId: 's1', workerId: 'w2', environmentId: 'e1' }),
    /inflight-session/,
  )
  const relativePath = `projects/-workspace/${uuid}.jsonl`
  const semantic = {
    schemaVersion: 1 as const,
    principalId: 'u1',
    sessionId: 's1',
    nativeSessionId: uuid,
    engine: 'ccb' as const,
    engineVersion: '2.8.4',
    cwd: '/workspace',
    environmentId: 'e1',
    environmentGeneration: 1,
    bindingRevision: 1,
    authority: { dispatchId: 'd1', turnKey: 't1', tapeCursor: 1, nativeHeadUuid: 'head1' },
    createdAtMs: 1000,
    transcriptRelativePath: relativePath,
    files: [{ relativePath, sizeBytes: 0, sha256: agentRemoteContentHash('') }],
  }
  await assert.rejects(
    service.publishNativeCheckpoint('u1', f.binding, f.lease, {
      ...semantic,
      checkpointId: nativeCheckpointId(semantic),
    }),
    /checkpoint-inflight/,
  )
  await reopened.transact('u1', (state) => {
    deliver(state.nativeJournal[0]!)
  })
  await service.registerEnvironment('u1', { ...f.environment, generation: 2 })
})
test('selection always includes native unresolved and requested terminal across both domains', async (t) => {
  const f = await fixture(t)
  await f.store.transact('u1', (state) => {
    const done = f.record('done')
    receipt(done)
    deliver(done)
    state.nativeJournal.push(done, f.record('active'))
  })
  assert.deepEqual(
    (
      await f.store.transact(
        'u1',
        (state) => state.nativeJournal.map((row) => row.request.operationId),
        'active',
      )
    ).sort(),
    ['active'],
  )
  const key = nativeJournalKey(f.record('done'))
  assert.deepEqual(
    (
      await f.store.transact(
        'u1',
        (state) => state.nativeJournal.map((row) => row.request.operationId),
        { operationKey: key },
      )
    ).sort(),
    ['active', 'done'],
  )
  assert.deepEqual(
    (
      await f.store.transact(
        'u1',
        (state) => state.nativeJournal.map((row) => row.request.operationId),
        { operationKey: 'legacy-unknown', includeOperationKeys: [key] },
      )
    ).sort(),
    ['active', 'done'],
  )
})
test('native request, event prefix, receipt and terminal evidence are immutable and failures roll back', async (t) => {
  const f = await fixture(t)
  await f.store.transact('u1', (state) => {
    state.nativeJournal.push(f.record())
  })
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.nativeJournal[0]!.request.body.toolUse.input.command = 'other'
    }),
    /native-stored-request-hash/,
  )
  await f.store.transact('u1', (state) => {
    const row = state.nativeJournal[0]!
    row.dispatch = { hostInstanceId: 'h1', ledgerId: 'l1', grantId: 'g1' }
    const event = {
      sequence: 1,
      sender: 'execution' as const,
      producerInstanceId: 'h1',
      ledgerId: 'l1',
      epoch: 1,
      body: { kind: 'native.progress' as const, message: { text: 'one' } },
    }
    row.events.push({
      ...event,
      sha256: nativeJournalEventHash(row.request.body.payloadHash, event),
    })
    receipt(row)
  })
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.nativeJournal[0]!.events = []
    }),
    /stored-event-mutation|native-stored-receipt-event/,
  )
  await assert.rejects(
    f.store.transact('u1', (state) => {
      const row = state.nativeJournal[0]!
      const body = {
        kind: 'native.receipt' as const,
        payloadHash: row.request.body.payloadHash,
        status: 'failed' as const,
      }
      row.receipt = { body, sha256: nativeReceiptHash(row.request.body.payloadHash, body) }
    }),
    /stored-native-evidence-mutation|native-stored-receipt-event/,
  )
  await f.store.transact('u1', (state) => {
    deliver(state.nativeJournal[0]!)
  })
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.nativeJournal[0]!.updatedAtMs++
    }),
    /stored-terminal-mutation/,
  )
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.nativeJournal = []
    }),
    /stored-operation-deletion/,
  )
})
test('native terminal requires matching receipt and durable writer ACK; owner/hash/cross-principal reject', async (t) => {
  const f = await fixture(t)
  for (const patch of [
    (row: NativeJournalRecord) => {
      row.state = 'completed'
      receipt(row)
    },
    (row: NativeJournalRecord) => {
      row.claim.ownerInstanceId = 'other'
    },
    (row: NativeJournalRecord) => {
      row.request.body.payloadHash = '0'.repeat(64)
    },
  ]) {
    const row = f.record()
    patch(row)
    await assert.rejects(
      f.store.transact('u1', (state) => {
        state.nativeJournal.push(row)
      }),
    )
  }
  await assert.rejects(
    f.store.transact('u2', (state) => {
      state.nativeJournal.push(f.record())
    }),
    /stored-principal-mismatch/,
  )
  assert.equal((await f.store.transact('u1', (state) => state.nativeJournal)).length, 0)
})
test('v1 owned DB rejects before WAL mutation; v2 keeps explicit v1 metadata shape', async (t) => {
  const f = await fixture(t)
  const legacy = join(f.root, 'legacy.sqlite')
  writeFileSync(legacy, '', { mode: 0o600 })
  const old = new Database(legacy)
  old.pragma('application_id=1095912753')
  old.pragma('user_version=1')
  old.close()
  assert.throws(() => new SqliteAgentRemoteStore(legacy), /state-format-migration-required/)
  await f.store.transact('u1', (state) => {
    state.nativeJournal.push(f.record())
  })
  const db = new Database(f.path, { readonly: true })
  t.after(() => db.close())
  assert.equal(db.pragma('user_version', { simple: true }), 2)
  const metadata = db
    .prepare('SELECT format_version,payload FROM agent_remote_principals')
    .get() as { format_version: number; payload: string }
  assert.equal(metadata.format_version, 1)
  assert.equal(Object.hasOwn(JSON.parse(metadata.payload), 'nativeJournal'), false)
})

test('unknown is an observation, never an immutable final receipt; later trusted terminal can close', async (t) => {
  const f = await fixture(t)
  const row = f.record()
  const unknown = {
    kind: 'native.receipt' as const,
    payloadHash: row.request.body.payloadHash,
    status: 'unknown' as const,
  }
  await assert.rejects(
    f.store.transact('u1', (state) => {
      const invalid = structuredClone(row)
      Reflect.set(invalid, 'receipt', {
        body: unknown,
        sha256: nativeReceiptHash(row.request.body.payloadHash, unknown),
      })
      state.nativeJournal.push(invalid)
    }),
  )
  row.dispatch = { hostInstanceId: 'h1', ledgerId: 'l1', grantId: 'g1' }
  row.state = 'unknown'
  const event = {
    sequence: 1,
    sender: 'execution' as const,
    producerInstanceId: 'h1',
    ledgerId: 'l1',
    epoch: 1,
    body: unknown,
  }
  row.events.push({ ...event, sha256: nativeJournalEventHash(row.request.body.payloadHash, event) })
  await f.store.transact('u1', (state) => {
    state.nativeJournal.push(row)
  })
  await f.store.transact('u1', (state) => {
    const current = state.nativeJournal[0]!
    receipt(current)
    deliver(current)
  })
  assert.equal(await f.store.transact('u1', (state) => state.nativeJournal[0]!.state), 'completed')
})
test('rehashed stored events still enforce peer direction, native scope and grant provenance', async (t) => {
  const f = await fixture(t)
  const artifact = {
    nativeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    relativePath: 'tool-results/toolu_a.txt',
    sizeBytes: 0,
    sha256: agentRemoteContentHash(''),
  }
  for (const variant of ['direction', 'scope', 'producer', 'epoch']) {
    const row = f.record()
    row.dispatch = { hostInstanceId: 'h1', ledgerId: 'l1', grantId: 'g1' }
    const event = {
      sequence: 1,
      sender: variant === 'direction' ? ('worker' as const) : ('execution' as const),
      producerInstanceId: variant === 'producer' ? 'h2' : 'h1',
      ledgerId: 'l1',
      epoch: variant === 'epoch' ? 2 : 1,
      body:
        variant === 'direction' || variant === 'scope'
          ? { kind: 'native.artifacts' as const, artifacts: [artifact] }
          : { kind: 'native.progress' as const, message: { text: 'one' } },
    }
    row.events.push({
      ...event,
      sha256: nativeJournalEventHash(row.request.body.payloadHash, event),
    })
    await assert.rejects(
      f.store.transact('u1', (state) => {
        state.nativeJournal.push(row)
      }),
      /native-direction|native-artifact-session|native-stored-event-producer|native-stored-event-epoch/,
    )
  }
})
