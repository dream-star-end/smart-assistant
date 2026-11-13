import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AgentRemoteBinding,
  type AgentRemoteCommand,
  type AgentRemoteEnvironment,
  type AgentRemoteEvent,
  type AgentRemoteRequest,
  agentRemoteContentHash,
  agentRemotePayloadHash,
} from '@openclaude/protocol/agentRemote'
import { describeExistingContainer } from './containerCompatibility.js'
import { createAgentRemoteService } from './service.js'
import { VolatileAgentRemoteStore } from './store.js'

const environment: AgentRemoteEnvironment = {
  protocolVersion: 1,
  principalId: 'u1',
  environmentId: 'e1',
  generation: 1,
  kind: 'container',
  containerId: 'test-container',
  containerIncarnation: 'boot1',
  runtimeRevision: 'test-v1',
  workspaceRoot: '/workspace',
  capabilities: [
    'file.read',
    'file.write',
    'process.exec',
    'process.status',
    'process.logs',
    'process.stop',
  ],
}
async function fixture(capabilities = environment.capabilities) {
  let now = 1000
  const store = new VolatileAgentRemoteStore()
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => store,
    allowVolatileReference: true,
    clock: () => now,
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
    10000,
  )
  await service.registerEnvironment('u1', { ...environment, capabilities })
  const binding = await service.bind('u1', { sessionId: 's1', workerId: 'w1', environmentId: 'e1' })
  const lease = await service.claim('u1', binding, 1000)
  const make = (
    operationId = 'op1',
    command: AgentRemoteCommand = {
      kind: 'process.exec',
      command: 'printf 中文🌏',
      cwd: '/workspace',
      timeoutMs: 500,
    },
  ) => {
    const semantic = {
      protocolVersion: 1 as const,
      binding,
      operationId,
      deadlineAtMs: 10000,
      command,
    }
    return {
      ...structuredClone(semantic),
      lease: { ...lease },
      payloadHash: agentRemotePayloadHash(semantic),
    }
  }
  return {
    service,
    store,
    binding,
    lease,
    make,
    setNow: (value: number) => {
      now = value
    },
  }
}
function event(
  request: AgentRemoteRequest,
  sequence: number,
  body: AgentRemoteEvent['body'],
): AgentRemoteEvent {
  return {
    protocolVersion: 1,
    binding: structuredClone(request.binding),
    operationId: request.operationId,
    payloadHash: request.payloadHash,
    lease: structuredClone(request.lease),
    sequence,
    body:
      body.type === 'started' && request.command.kind === 'process.exec'
        ? {
            ...body,
            job: { jobId: `job-${request.operationId}`, sourceOperationId: request.operationId },
          }
        : body,
  }
}

test('default off never constructs store; volatile reference requires explicit opt-in', () => {
  let constructions = 0
  const createStore = () => {
    constructions++
    return new VolatileAgentRemoteStore()
  }
  for (const flag of [undefined, '', '0', 'true'])
    assert.equal(
      createAgentRemoteService({ env: { OC_AGENT_REMOTE_ENABLED: flag }, createStore }),
      undefined,
    )
  assert.equal(constructions, 0)
  assert.throws(
    () => createAgentRemoteService({ env: { OC_AGENT_REMOTE_ENABLED: '1' }, createStore }),
    /durable-store-required/,
  )
})
test('container compatibility accepts explicit descriptors and rejects secrets/vendor wire fields', () => {
  const copy = describeExistingContainer(environment)
  copy.capabilities.length = 0
  assert.ok(environment.capabilities.length > 0)
  assert.throws(
    () =>
      describeExistingContainer({ ...environment, token: 'synthetic' } as AgentRemoteEnvironment),
    /bad-shape/,
  )
  assert.throws(
    () =>
      describeExistingContainer({
        ...environment,
        capabilities: ['vendor.magic'],
      } as unknown as AgentRemoteEnvironment),
    /bad-shape/,
  )
})
test('principal/session/environment generation/worker incarnation mismatches reject', async () => {
  const f = await fixture()
  const request = f.make()
  await assert.rejects(f.service.accept('u2', request), /principal-mismatch/)
  for (const patch of [
    { sessionId: 'other' },
    { environmentGeneration: 2 },
    { workerInstanceId: 'old' },
  ]) {
    const binding = { ...request.binding, ...patch }
    await assert.rejects(f.service.claim('u1', binding, 1000), /binding-mismatch/)
  }
  await assert.rejects(f.service.registerEnvironment('u2', environment), /principal-mismatch/)
})
test('lease claim has one concurrent winner, forged epoch cannot advance authority', async () => {
  const f = await fixture()
  await f.service.release('u1', f.binding, f.lease)
  const results = await Promise.allSettled([
    f.service.claim('u1', f.binding, 1000),
    f.service.claim('u1', f.binding, 1000),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const winner = results.find((result) => result.status === 'fulfilled')!
  assert.equal(winner.status, 'fulfilled')
  if (winner.status !== 'fulfilled') return
  assert.equal(winner.value.epoch, 2)
  await assert.rejects(
    f.service.renew('u1', f.binding, { ...winner.value, epoch: 9999 }, 1000),
    /stale-lease/,
  )
  await assert.rejects(
    f.service.renew('u1', f.binding, { ...winner.value, ownerInstanceId: 'other' }, 1000),
    /stale-lease/,
  )
  await f.service.renew('u1', f.binding, winner.value, 1000)
  await assert.rejects(f.service.release('u1', f.binding, f.lease), /stale-lease/)
})
test('start admission atomically rechecks lease after another claimant takes over', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  f.setNow(2001)
  const successor = await f.service.claim('u1', f.binding, 1000)
  let executionCount = 0
  await assert.rejects(async () => {
    await f.service.authorizeStart('u1', f.binding, request.operationId, f.lease)
    await f.service.observe('u1', event(request, 1, { type: 'started' }))
    executionCount++
  }, /stale-lease/)
  assert.equal(executionCount, 0)
  const duplicate = await f.service.accept('u1', { ...request, lease: successor })
  assert.equal(duplicate.state, 'accepted')
  assert.equal(duplicate.claim.epoch, 1)
  const recovered = await f.service.recover('u1', f.binding, request.operationId, successor)
  assert.equal(recovered.claim.epoch, 2)
  await f.service.authorizeStart('u1', f.binding, request.operationId, successor)
  await f.service.observe('u1', { ...event(request, 1, { type: 'started' }), lease: successor })
})
test('worker expiry and environment replacement fence previously accepted work', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  await assert.rejects(
    f.service.registerEnvironment('u1', {
      ...environment,
      generation: 2,
      containerIncarnation: 'boot2',
    }),
    /inflight-environment/,
  )
  await assert.rejects(
    f.service.registerWorker(
      'u1',
      {
        protocolVersion: 1,
        principalId: 'u1',
        workerId: 'w1',
        workerInstanceId: 'wi2',
        engines: ['ccb'],
      },
      1000,
    ),
    /inflight-worker/,
  )
  f.setNow(11000)
  await assert.rejects(
    f.service.observe('u1', event(request, 1, { type: 'started' })),
    /worker-unavailable/,
  )
})
test('deduplication and snapshots survive caller mutation and changed epoch', async () => {
  const f = await fixture()
  const request = f.make()
  const pristine = structuredClone(request)
  const accepted = await f.service.accept('u1', request)
  request.command = { kind: 'process.exec', command: 'mutated', cwd: '/workspace', timeoutMs: 1 }
  accepted.request.binding.environmentId = 'mutated'
  accepted.claim.epoch = 77
  assert.equal((await f.service.accept('u1', pristine)).request.command.kind, 'process.exec')
  f.setNow(2001)
  const token = await f.service.claim('u1', f.binding, 1000)
  const retry = await f.service.accept('u1', { ...pristine, lease: token })
  assert.deepEqual(retry.request.command, pristine.command)
  assert.equal(retry.claim.epoch, 1)
  const changed = f.make('op1', {
    kind: 'process.exec',
    command: 'different',
    cwd: '/workspace',
    timeoutMs: 1,
  })
  await assert.rejects(f.service.accept('u1', { ...changed, lease: token }), /operation-conflict/)
})
test('started without a receipt becomes unknown, never auto-executes or rebinds', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, request.operationId, f.lease)
  await f.service.observe('u1', event(request, 1, { type: 'started' }))
  f.setNow(2001)
  const token = await f.service.claim('u1', f.binding, 1000)
  assert.equal((await f.service.recover('u1', f.binding, 'op1', token)).state, 'unknown')
  assert.equal((await f.service.accept('u1', { ...request, lease: token })).state, 'unknown')
  await assert.rejects(
    f.service.observe('u1', { ...event(request, 2, { type: 'started' }), lease: token }),
    /observation-mismatch/,
  )
  await f.service.registerEnvironment('u1', {
    ...environment,
    environmentId: 'e2',
    containerId: 'container2',
  })
  await assert.rejects(
    f.service.bind('u1', { sessionId: 's1', workerId: 'w1', environmentId: 'e2' }),
    /inflight-session/,
  )
})
test('event replay, sequence gaps and contradictory payloads are distinct', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  const started = event(request, 1, { type: 'started' })
  await f.service.authorizeStart('u1', f.binding, request.operationId, f.lease)
  await f.service.observe('u1', started)
  await f.service.observe('u1', started)
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 1, { type: 'output', stream: 'stdout', offsetBytes: 0, text: 'x' }),
    ),
    /event-conflict/,
  )
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 3, { type: 'receipt', receipt: { status: 'completed', exitCode: 0 } }),
    ),
    /event-gap/,
  )
  await assert.rejects(
    f.service.observe('u1', {
      ...event(request, 2, { type: 'output', stream: 'stdout', offsetBytes: 0, text: 'x' }),
      operationId: 'other',
    }),
    /unknown-operation/,
  )
})
test('UTF-8 cursors are per operation and stream, cancellation is not stop evidence', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, request.operationId, f.lease)
  await f.service.observe('u1', event(request, 1, { type: 'started' }))
  assert.equal((await f.service.requestCancel('u1', f.binding, 'op1', f.lease)).state, 'started')
  const text = 'bg-one 中文🌏\n'
  assert.equal(Buffer.byteLength(text), 18)
  const output = await f.service.observe(
    'u1',
    event(request, 2, { type: 'output', stream: 'stdout', offsetBytes: 0, text }),
  )
  assert.equal(output.cursor.stdout, 18)
  assert.equal(output.cursor.stderr, 0)
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 3, {
        type: 'output',
        stream: 'stdout',
        offsetBytes: text.length,
        text: 'bad',
      }),
    ),
    /cursor-mismatch/,
  )
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 3, {
        type: 'receipt',
        receipt: { status: 'cancelled', stopScope: 'process-tree' },
      }),
    ),
    /unsupported-stop-evidence/,
  )
  const stopped = await f.service.observe(
    'u1',
    event(request, 3, { type: 'receipt', receipt: { status: 'cancelled', stopScope: 'leader' } }),
  )
  assert.equal(stopped.state, 'cancelled')
  assert.deepEqual(stopped.receipt, { status: 'cancelled', stopScope: 'leader' })
})
test('terminal receipt is set once; nonzero exit is completion, not transport error', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, request.operationId, f.lease)
  await f.service.observe('u1', event(request, 1, { type: 'started' }))
  const done = event(request, 2, { type: 'receipt', receipt: { status: 'completed', exitCode: 7 } })
  assert.equal((await f.service.observe('u1', done)).state, 'completed')
  await f.service.observe('u1', done)
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 2, { type: 'receipt', receipt: { status: 'cancelled', stopScope: 'leader' } }),
    ),
    /event-conflict/,
  )
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 3, { type: 'receipt', receipt: { status: 'failed', code: 'late' } }),
    ),
    /operation-closed/,
  )
})
test('registry generation is immutable and revision/epoch do not reset on rebind', async () => {
  const f = await fixture()
  await assert.rejects(
    f.service.registerEnvironment('u1', { ...environment, containerIncarnation: 'reused-name' }),
    /environment-generation/,
  )
  await f.service.registerEnvironment('u1', {
    ...environment,
    generation: 2,
    containerIncarnation: 'boot2',
  })
  const binding = await f.service.bind('u1', {
    sessionId: 's1',
    workerId: 'w1',
    environmentId: 'e1',
  })
  assert.equal(binding.bindingRevision, 2)
  assert.equal(binding.environmentGeneration, 2)
  await assert.rejects(f.service.renew('u1', f.binding, f.lease, 1000), /binding-mismatch/)
  assert.equal((await f.service.claim('u1', binding, 1000)).epoch, 2)
})
test('conditional writes unavailable in P0 adapter cannot silently degrade', async () => {
  const f = await fixture()
  await assert.rejects(
    f.service.accept(
      'u1',
      f.make('write', {
        kind: 'file.write',
        path: '/file',
        contentUtf8: '中文',
        expectedSha256: 'a'.repeat(64),
      }),
    ),
    /unsupported-capability/,
  )
})
test('bad deadlines, TTL and lease epochs fail before state mutation', async () => {
  const f = await fixture()
  for (const epoch of [Number.NaN, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.service.renew('u1', f.binding, { ...f.lease, epoch }, 1000), /bad-shape/)
  await assert.rejects(
    f.service.renew('u1', f.binding, f.lease, Number.POSITIVE_INFINITY),
    /bad-ttl/,
  )
  await f.service.renew('u1', f.binding, f.lease, 1000)
  const request = f.make()
  const { payloadHash: _hash, lease: _lease, ...semantic } = request
  semantic.deadlineAtMs = 999
  await assert.rejects(
    f.service.accept('u1', {
      ...semantic,
      lease: f.lease,
      payloadHash: agentRemotePayloadHash(semantic),
    }),
    /deadline-expired/,
  )
})
test('failed transactions roll back state; store does not retain callback references', async () => {
  const store = new VolatileAgentRemoteStore()
  await assert.rejects(
    store.transact('u1', (state) => {
      state.workers.push({
        protocolVersion: 1,
        principalId: 'u1',
        workerId: 'w',
        workerInstanceId: 'wi',
        engines: ['ccb'],
        expiresAtMs: 1,
      })
      throw new Error('abort')
    }),
    /abort/,
  )
  assert.equal(await store.transact('u1', (state) => state.workers.length), 0)
})

test('queued cancellation blocks a later start grant; cancellation cannot erase history', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  await f.service.requestCancel('u1', f.binding, 'op1', f.lease)
  await assert.rejects(
    f.service.authorizeStart('u1', f.binding, request.operationId, f.lease),
    /cancel-pending/,
  )
  f.setNow(2001)
  const next = await f.service.claim('u1', f.binding, 1000)
  await assert.rejects(f.service.recover('u1', f.binding, 'op1', next), /cancel-pending/)
  assert.equal((await f.service.query('u1', f.binding, 'op1')).state, 'accepted')
})
test('queries remain scoped and useful after lease expiry; recovery needs a new epoch', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  await assert.rejects(
    f.service.recover('u1', f.binding, 'op1', f.lease),
    /recovery-requires-new-epoch/,
  )
  f.setNow(12000)
  assert.equal((await f.service.query('u1', f.binding, 'op1')).state, 'accepted')
  await assert.rejects(f.service.query('u2', f.binding, 'op1'), /principal-mismatch/)
  await assert.rejects(
    f.service.query('u1', { ...f.binding, sessionId: 'other' }, 'op1'),
    /unknown-operation/,
  )
})

test('a committed dispatch intent without a started event is still unsafe to replay', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, 'op1', f.lease)
  await assert.rejects(
    f.service.authorizeStart('u1', f.binding, 'op1', f.lease),
    /already-dispatched/,
  )
  f.setNow(2001)
  const token = await f.service.claim('u1', f.binding, 1000)
  assert.equal((await f.service.recover('u1', f.binding, 'op1', token)).state, 'unknown')
  await assert.rejects(
    f.service.authorizeStart('u1', f.binding, 'op1', token),
    /stale-operation-claim/,
  )
})

test('cancel after dispatch cannot suppress delayed started and real stop evidence', async () => {
  const f = await fixture()
  const request = f.make()
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, 'op1', f.lease)
  assert.equal((await f.service.requestCancel('u1', f.binding, 'op1', f.lease)).state, 'dispatched')
  assert.equal(
    (await f.service.observe('u1', event(request, 1, { type: 'started' }))).cancelRequested,
    true,
  )
  assert.equal(
    (
      await f.service.observe(
        'u1',
        event(request, 2, {
          type: 'receipt',
          receipt: { status: 'cancelled', stopScope: 'leader' },
        }),
      )
    ).state,
    'cancelled',
  )
})
test('deadline limits dispatch admission, not delayed facts from already-dispatched work', async () => {
  const f = await fixture()
  const request = f.make()
  const { payloadHash: _hash, lease: _lease, ...semantic } = request
  semantic.deadlineAtMs = 1100
  const short = { ...semantic, lease: f.lease, payloadHash: agentRemotePayloadHash(semantic) }
  await f.service.accept('u1', short)
  await f.service.authorizeStart('u1', f.binding, 'op1', f.lease)
  f.setNow(1200)
  await f.service.observe('u1', event(short, 1, { type: 'started' }))
  assert.equal(
    (
      await f.service.observe(
        'u1',
        event(short, 2, { type: 'receipt', receipt: { status: 'completed', exitCode: 0 } }),
      )
    ).state,
    'completed',
  )
})
test('file read returns verifiable bounded UTF-8 bytes, rejects wrong offsets/hashes/result kinds', async () => {
  const f = await fixture()
  const request = f.make('read', { kind: 'file.read', path: '/a', offsetBytes: 0, limitBytes: 10 })
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, 'read', f.lease)
  await f.service.observe('u1', event(request, 1, { type: 'started' }))
  const result = {
    kind: 'file.read' as const,
    path: '/a',
    offsetBytes: 0,
    nextOffsetBytes: 10,
    totalBytes: 10,
    eof: true,
    contentUtf8: '中文🌏',
    contentSha256: agentRemoteContentHash('中文🌏'),
    fileSha256: agentRemoteContentHash('中文🌏'),
  }
  for (const patch of [
    { nextOffsetBytes: 3 },
    { contentSha256: 'a'.repeat(64) },
    { eof: false },
    { path: '/other' },
    { contentUtf8: '中文🌏x' },
  ])
    await assert.rejects(
      f.service.observe(
        'u1',
        event(request, 2, {
          type: 'receipt',
          receipt: { status: 'completed', result: { ...result, ...patch } },
        }),
      ),
      /invalid-file-result/,
    )
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 2, { type: 'receipt', receipt: { status: 'completed' } }),
    ),
    /result-kind-mismatch/,
  )
  const completed = await f.service.observe(
    'u1',
    event(request, 2, { type: 'receipt', receipt: { status: 'completed', result } }),
  )
  assert.deepEqual(completed.receipt, { status: 'completed', result })
  assert.deepEqual((await f.service.query('u1', f.binding, 'read')).receipt, completed.receipt)
})
test('file write result identifies the actual expected content and path', async () => {
  const f = await fixture()
  const request = f.make('write', { kind: 'file.write', path: '/a', contentUtf8: '中文🌏' })
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, 'write', f.lease)
  await f.service.observe('u1', event(request, 1, { type: 'started' }))
  const result = {
    kind: 'file.write' as const,
    path: '/a',
    totalBytes: 10,
    sha256: agentRemoteContentHash('中文🌏'),
  }
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 2, {
        type: 'receipt',
        receipt: {
          status: 'completed',
          result: { ...result, kind: 'file.edit', previousSha256: 'a'.repeat(64), replacements: 1 },
        },
      }),
    ),
    /result-kind-mismatch/,
  )
  await f.service.observe(
    'u1',
    event(request, 2, { type: 'receipt', receipt: { status: 'completed', result } }),
  )
})
test('started exposes a scoped job, status/logs/stop return typed results without vendor IDs escaping scope', async () => {
  const f = await fixture()
  const parent = f.make()
  await f.service.accept('u1', parent)
  await f.service.authorizeStart('u1', f.binding, 'op1', f.lease)
  const started = await f.service.observe('u1', event(parent, 1, { type: 'started' }))
  const job = started.job!
  assert.deepEqual(job, { jobId: 'job-op1', sourceOperationId: 'op1' })
  await assert.rejects(
    f.service.accept('u1', f.make('bad', { kind: 'process.status', ...job, jobId: 'another-job' })),
    /job-scope-mismatch/,
  )
  await assert.rejects(
    f.service.accept(
      'u1',
      f.make('bad', { kind: 'process.status', ...job, sourceOperationId: 'other-operation' }),
    ),
    /unknown-operation/,
  )
  const commands: AgentRemoteCommand[] = [
    { kind: 'process.status', ...job },
    { kind: 'process.logs', ...job, stream: 'stdout', offsetBytes: 0, limitBytes: 10 },
    { kind: 'process.stop', ...job, scope: 'leader' },
  ]
  for (const command of commands) {
    const request = f.make(command.kind, command)
    await f.service.accept('u1', request)
    await f.service.authorizeStart('u1', f.binding, request.operationId, f.lease)
    await f.service.observe('u1', event(request, 1, { type: 'started' }))
    const result =
      command.kind === 'process.status'
        ? { kind: 'process.status' as const, job, state: 'running' as const }
        : command.kind === 'process.logs'
          ? {
              kind: 'process.logs' as const,
              job,
              stream: 'stdout' as const,
              offsetBytes: 0,
              nextOffsetBytes: 10,
              eof: false,
              text: '中文🌏',
            }
          : { kind: 'process.stop' as const, job, stopScope: 'leader' as const }
    await assert.rejects(
      f.service.observe(
        'u1',
        event(request, 2, {
          type: 'receipt',
          receipt: { status: 'completed', result: { ...result, job: { ...job, jobId: 'wrong' } } },
        }),
      ),
      /job-scope-mismatch/,
    )
    const done = await f.service.observe(
      'u1',
      event(request, 2, { type: 'receipt', receipt: { status: 'completed', result } }),
    )
    assert.equal(done.state, 'completed')
  }
  // A completed stop action does not forge a separate target-process receipt.
  assert.equal((await f.service.query('u1', f.binding, 'op1')).state, 'started')
})

test('edit receipt preserves the conditional version and exactly one replacement', async () => {
  const f = await fixture([...environment.capabilities, 'file.edit', 'file.cas'])
  const request = f.make('edit', {
    kind: 'file.edit',
    path: '/a',
    oldText: 'before',
    newText: 'after',
    expectedSha256: 'a'.repeat(64),
  })
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, 'edit', f.lease)
  await f.service.observe('u1', event(request, 1, { type: 'started' }))
  const result = {
    kind: 'file.edit' as const,
    path: '/a',
    totalBytes: 5,
    sha256: agentRemoteContentHash('after'),
    previousSha256: 'a'.repeat(64),
    replacements: 1 as const,
  }
  await assert.rejects(
    f.service.observe(
      'u1',
      event(request, 2, {
        type: 'receipt',
        receipt: { status: 'completed', result: { ...result, previousSha256: 'b'.repeat(64) } },
      }),
    ),
    /invalid-file-result/,
  )
  await f.service.observe(
    'u1',
    event(request, 2, { type: 'receipt', receipt: { status: 'completed', result } }),
  )
})
