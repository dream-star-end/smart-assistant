import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type NativeFrame,
  type NativeScope,
  nativeCallbackHash,
  nativeExecutionHash,
  nativeManifestHash,
} from '@openclaude/protocol/agentRemoteNative'
import Database from 'better-sqlite3'
import {
  type NativeHostIdentity,
  type NativeHostPipelinePermit,
  SqliteNativeHostJournal,
} from './nativeHostJournal.js'
import { type NativeJournalRecord, verifyNativeJournalRecord } from './nativeJournal.js'
const identity: NativeHostIdentity = {
  ledgerId: 'l1',
  principalId: 'u1',
  environmentId: 'e1',
  environmentGeneration: 1,
  environmentIncarnation: 'boot1',
}
function scope(): NativeScope {
  return {
    binding: {
      principalId: 'u1',
      sessionId: 's1',
      bindingRevision: 1,
      workerId: 'w1',
      workerInstanceId: 'wi1',
      environmentId: 'e1',
      environmentGeneration: 1,
    },
    nativeSessionId: '12345678-1234-1234-1234-123456789abc',
    environmentIncarnation: 'boot1',
    lease: { ownerInstanceId: 'wi1', epoch: 1 },
    connectionId: 'c1',
    challenge: 'a'.repeat(64),
  }
}
function grant(
  s: NativeScope,
  operationId = 'op1',
  hostInstanceId = 'h1',
): { control: NativeJournalRecord; frame: NativeFrame } {
  const body = {
    kind: 'native.execute' as const,
    contextRevision: 1,
    manifestRevision: 'b'.repeat(64),
    deadlineAtMs: 10000,
    toolUse: { id: `toolu_${operationId}`, name: 'Bash', input: { command: 'synthetic' } },
    assistantMessage: { type: 'assistant' },
  }
  const intent = {
    binding: structuredClone(s.binding),
    nativeSessionId: s.nativeSessionId,
    environmentIncarnation: s.environmentIncarnation,
    operationId,
    body: { ...body, payloadHash: nativeExecutionHash(s, operationId, body) },
  }
  return {
    control: {
      recordVersion: 1,
      request: intent,
      claim: structuredClone(s.lease),
      state: 'dispatched',
      cancelRequested: false,
      dispatch: { hostInstanceId, ledgerId: 'l1', grantId: `g_${operationId}` },
      events: [],
      createdAtMs: 1000,
      updatedAtMs: 1000,
    },
    frame: {
      nativeProtocolVersion: 1,
      scope: structuredClone(s),
      sender: 'worker',
      operationId,
      sequence: 1,
      body: intent.body,
    },
  }
}
function fixture(t: test.TestContext, verifyCancellationExit?: () => boolean) {
  const root = mkdtempSync(join(tmpdir(), 'native-host-'))
  const filename = join(root, 'host.sqlite')
  const opened: SqliteNativeHostJournal[] = []
  let now = 1000
  let exited = false
  const config = {
    filename,
    identity,
    hostInstanceId: 'h1',
    clock: () => now,
    verifyCancellationExit: verifyCancellationExit ?? (() => exited),
  }
  const open = (hostInstanceId = 'h1', initialize = false) => {
    const journal = new SqliteNativeHostJournal({ ...config, hostInstanceId, initialize })
    opened.push(journal)
    return journal
  }
  const journal = open('h1', true)
  const expected = scope()
  journal.installFence(expected, 20000, 1, 'b'.repeat(64))
  t.after(() => {
    for (const journal of opened) journal.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    filename,
    journal,
    expected,
    open,
    setNow: (value: number) => {
      now = value
    },
    setExited: () => {
      exited = true
    },
  }
}
function start(
  f: ReturnType<typeof fixture>,
  operationId = 'op1',
): { permit: NativeHostPipelinePermit; request: ReturnType<typeof grant> } {
  const request = grant(f.expected, operationId)
  const admitted = f.journal.accept(f.expected, request.control, request.frame)
  const started = f.journal.beginPipeline(admitted.operation)
  assert.equal(started.kind, 'start')
  if (started.kind !== 'start') throw Error('fixture')
  return { permit: started.permit, request }
}
function completed(request: ReturnType<typeof grant>) {
  return {
    kind: 'native.receipt' as const,
    payloadHash: request.control.request.body.payloadHash,
    status: 'completed' as const,
  }
}
function cancel(s: NativeScope, request: ReturnType<typeof grant>): NativeFrame {
  return {
    ...request.frame,
    scope: structuredClone(s),
    body: { kind: 'native.cancel', payloadHash: request.control.request.body.payloadHash },
  }
}
test('one pipeline permit and one canonical call survive duplicate accepts and two DB connections', (t) => {
  const f = fixture(t)
  const request = grant(f.expected)
  const a = f.journal.accept(f.expected, request.control, request.frame)
  const second = f.open()
  const b = second.accept(f.expected, request.control, request.frame)
  const first = f.journal.beginPipeline(a.operation)
  assert.equal(first.kind, 'start')
  assert.equal(second.beginPipeline(b.operation).kind, 'evidence')
  if (first.kind !== 'start') throw Error('fixture')
  assert.throws(() => second.beginPipeline(a.operation), /host-local-permit/)
  f.journal.commitEffectiveInput(first.permit, { command: 'changed-by-permission' }, 2)
  assert.throws(
    () => f.journal.beginCanonicalCall(first.permit, { command: 'old-input' }, 2),
    /host-effective-input-conflict/,
  )
  assert.equal(
    f.journal.beginCanonicalCall(first.permit, { command: 'changed-by-permission' }, 2).kind,
    'call',
  )
  assert.equal(
    f.journal.beginCanonicalCall(first.permit, { command: 'changed-by-permission' }, 2).kind,
    'evidence',
  )
  assert.throws(() => second.beginCanonicalCall(first.permit, {}, 2), /host-local-permit/)
})
test('started pipeline cannot replay after reopen; lost executor blocks new work until actual late completion', (t) => {
  const f = fixture(t)
  const running = start(f)
  const newHost = f.open('h2')
  const next = grant(f.expected, 'op2', 'h2')
  assert.throws(
    () => newHost.accept(f.expected, next.control, next.frame),
    /host-unresolved-execution/,
  )
  assert.equal(newHost.markExecutorUnknown('h1'), 1)
  assert.equal(
    newHost.query(f.expected, 'op1', running.request.control.request.body.payloadHash).phase,
    'unknown',
  )
  assert.throws(
    () => newHost.accept(f.expected, next.control, next.frame),
    /host-unresolved-execution/,
  )
  // Only the original in-process producer permit can finish with real evidence.
  f.journal.finish(running.permit, completed(running.request))
  assert.equal(newHost.accept(f.expected, next.control, next.frame).record.phase, 'accepted')
})
test('connection rotation preserves old local permit but rejects old authenticated ingress', (t) => {
  const f = fixture(t)
  const running = start(f)
  const fresh = structuredClone(f.expected)
  fresh.connectionId = 'c2'
  fresh.challenge = 'c'.repeat(64)
  f.journal.installFence(fresh, 20000, 1, 'b'.repeat(64))
  assert.throws(
    () => f.journal.query(f.expected, 'op1', running.request.control.request.body.payloadHash),
    /host-fence-mismatch/,
  )
  f.journal.commitEffectiveInput(running.permit, {}, 1)
  assert.equal(f.journal.beginCanonicalCall(running.permit, {}, 1).kind, 'call')
  assert.equal(
    f.journal.finish(running.permit, completed(running.request)).sourceScope.connectionId,
    'c1',
  )
  assert.equal(
    f.journal.replayEvents(fresh, 'op1', running.request.control.request.body.payloadHash, 0)[0]
      ?.epoch,
    1,
  )
})
test('new epoch fences old calls and holds conflicting work; late receipt retains original producer', (t) => {
  const f = fixture(t)
  const running = start(f)
  const fresh = structuredClone(f.expected)
  fresh.lease.epoch++
  f.journal.installFence(fresh, 20000, 1, 'b'.repeat(64))
  assert.equal(
    f.journal.query(fresh, 'op1', running.request.control.request.body.payloadHash).phase,
    'unknown',
  )
  assert.throws(() => f.journal.commitEffectiveInput(running.permit, {}, 1), /host-session-fence/)
  const next = grant(fresh, 'op2')
  assert.throws(
    () => f.journal.accept(fresh, next.control, next.frame),
    /host-unresolved-execution/,
  )
  f.journal.finish(running.permit, completed(running.request))
  const event = f.journal.replayEvents(
    fresh,
    'op1',
    running.request.control.request.body.payloadHash,
    0,
  )[0]!
  assert.equal(event.epoch, 1)
  assert.equal(event.producerInstanceId, 'h1')
  assert.equal(event.ledgerId, 'l1')
  assert.equal(f.journal.accept(fresh, next.control, next.frame).record.phase, 'accepted')
  assert.throws(
    () => f.journal.installFence(f.expected, 20000, 1, 'b'.repeat(64)),
    /host-old-epoch/,
  )
})
test('cancel-before-execute is durable, burns the grant and never issues a pipeline permit', (t) => {
  const f = fixture(t)
  const request = grant(f.expected)
  assert.equal(f.journal.requestCancel(f.expected, cancel(f.expected, request)), undefined)
  const reopened = f.open()
  const accepted = reopened.accept(f.expected, request.control, request.frame)
  assert.equal(accepted.record.phase, 'cancelled')
  assert.equal(accepted.record.receipt?.body.code, 'not-started')
  assert.equal(reopened.beginPipeline(accepted.operation).kind, 'evidence')
  assert.equal(
    reopened.replayEvents(f.expected, 'op1', request.control.request.body.payloadHash, 0).length,
    1,
  )
  const conflicting = cancel(f.expected, request)
  if (conflicting.body.kind !== 'native.cancel') throw Error('fixture')
  conflicting.body.payloadHash = 'f'.repeat(64)
  assert.throws(() => reopened.requestCancel(f.expected, conflicting), /host-cancel-conflict/)
})
test('started cancellation requires real stop evidence, and completion can win a cancel race', (t) => {
  const f = fixture(t)
  const running = start(f)
  f.journal.commitEffectiveInput(running.permit, {}, 1)
  f.journal.beginCanonicalCall(running.permit, {}, 1)
  assert.equal(
    f.journal.requestCancel(f.expected, cancel(f.expected, running.request))?.phase,
    'call-started',
  )
  const receipt = { ...completed(running.request), status: 'cancelled' as const }
  assert.throws(() => f.journal.finish(running.permit, receipt), /host-cancel-exit-unproven/)
  assert.equal(f.journal.query(f.expected, 'op1', receipt.payloadHash).receipt, undefined)
  assert.equal(f.journal.finish(running.permit, completed(running.request)).phase, 'completed')
  const second = start(f, 'op2')
  f.journal.requestCancel(f.expected, cancel(f.expected, second.request))
  f.setExited()
  assert.equal(
    f.journal.finish(second.permit, { ...completed(second.request), status: 'cancelled' }).phase,
    'cancelled',
  )
})
test('receipt and final outbox event commit together, freeze the prefix and survive reopen', (t) => {
  const f = fixture(t)
  const running = start(f)
  f.journal.appendExecutionEvent(running.permit, {
    kind: 'native.progress',
    message: { type: 'progress', text: 'synthetic' },
  })
  const row = f.journal.finish(running.permit, completed(running.request))
  assert.equal(row.eventCount, 2)
  assert.equal(f.journal.finish(running.permit, completed(running.request)).eventCount, 2)
  assert.throws(
    () => f.journal.finish(running.permit, { ...completed(running.request), status: 'failed' }),
    /host-receipt-conflict/,
  )
  assert.throws(
    () => f.journal.appendExecutionEvent(running.permit, { kind: 'native.progress', message: {} }),
    /host-event-sealed/,
  )
  const reopened = f.open()
  const events = reopened.replayEvents(
    f.expected,
    'op1',
    running.request.control.request.body.payloadHash,
    0,
  )
  assert.deepEqual(
    events.map((event) => event.body.kind),
    ['native.progress', 'native.receipt'],
  )
  assert.equal(
    reopened.query(f.expected, 'op1', row.request.body.payloadHash).receipt?.sha256,
    row.receipt?.sha256,
  )
  const corrupt = new Database(f.filename)
  corrupt.prepare("UPDATE native_host_events SET payload='{}' WHERE sequence=1").run()
  corrupt.close()
  assert.throws(
    () => reopened.replayEvents(f.expected, 'op1', row.request.body.payloadHash, 0),
    /host-event-corrupt/,
  )
})
test('wrong scope, changed hash/grant, expiry, identity loss and foreign DB fail closed', (t) => {
  const f = fixture(t)
  const request = grant(f.expected)
  const wrong = structuredClone(f.expected)
  wrong.binding.principalId = 'u2'
  assert.throws(
    () => f.journal.accept(wrong, request.control, request.frame),
    /native-scope-mismatch/,
  )
  const changed = structuredClone(request.frame)
  if (changed.body.kind !== 'native.execute') throw Error('fixture')
  changed.body.toolUse.input.command = 'different'
  assert.throws(() => f.journal.accept(f.expected, request.control, changed), /native-payload-hash/)
  const missing = join(f.root, 'missing.sqlite')
  assert.throws(
    () => new SqliteNativeHostJournal({ filename: missing, identity, hostInstanceId: 'h1' }),
    /host-ledger-missing/,
  )
  assert.equal(existsSync(missing), false)
  assert.throws(
    () =>
      new SqliteNativeHostJournal({
        filename: f.filename,
        identity: { ...identity, ledgerId: 'lost-ledger' },
        hostInstanceId: 'h1',
      }),
    /host-ledger-identity/,
  )
  const foreign = join(f.root, 'foreign.sqlite')
  const db = new Database(foreign)
  db.exec('CREATE TABLE unrelated(value TEXT)')
  db.close()
  chmodSync(foreign, 0o600)
  assert.throws(
    () => new SqliteNativeHostJournal({ filename: foreign, identity, hostInstanceId: 'h1' }),
    /host-state-format/,
  )
  assert.equal(existsSync(`${foreign}-wal`), false)
  const linked = join(f.root, 'linked.sqlite')
  symlinkSync(f.filename, linked)
  assert.throws(
    () => new SqliteNativeHostJournal({ filename: linked, identity, hostInstanceId: 'h1' }),
    /host-state-file-private/,
  )
  const accepted = f.journal.accept(f.expected, request.control, request.frame)
  f.setNow(20000)
  assert.throws(() => f.journal.beginPipeline(accepted.operation), /host-lease-expired/)
})

// Actual separate processes and SIGKILL, not simulated transaction exceptions.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
function child(t: test.TestContext, config: string, mode: string, root: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>(
    (resolve, reject) => {
      const process = spawn(
        globalThis.process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./fixtures/nativeHostChild.ts', import.meta.url)),
          config,
          mode,
        ],
        {
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, TMPDIR: root, NODE_ENV: 'test' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20000,
          killSignal: 'SIGKILL',
        },
      )
      t.after(() => {
        if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
      })
      let output = ''
      let error = ''
      process.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      process.stderr.on('data', (chunk) => {
        error += String(chunk)
      })
      process.once('error', reject)
      process.once('close', (code, signal) => {
        if (code !== 0 && signal !== 'SIGKILL') reject(Error(`synthetic-child ${code}: ${error}`))
        else resolve({ code, signal, output })
      })
    },
  )
}
function childConfig(f: ReturnType<typeof fixture>, request: ReturnType<typeof grant>) {
  const config = join(f.root, 'child-config.json')
  const hookEffects = join(f.root, 'hook-effects')
  const toolEffects = join(f.root, 'tool-effects')
  writeFileSync(
    config,
    JSON.stringify({
      filename: f.filename,
      identity,
      expected: f.expected,
      control: request.control,
      frame: request.frame,
      hookEffects,
      toolEffects,
    }),
    { mode: 0o600 },
  )
  return { config, hookEffects, toolEffects }
}
test('SIGKILL at accepted, hook, canonical call and receipt boundaries never replays started effects', async (t) => {
  for (const mode of ['accepted', 'pipeline', 'call', 'receipt']) {
    await t.test(mode, async (t) => {
      const f = fixture(t)
      const request = grant(f.expected)
      const paths = childConfig(f, request)
      f.journal.close()
      const result = await child(t, paths.config, mode, f.root)
      assert.equal(result.signal, 'SIGKILL')
      const recovered = f.open()
      const old = recovered.accept(f.expected, request.control, request.frame)
      const resumed = recovered.beginPipeline(old.operation)
      if (mode === 'accepted') {
        assert.equal(resumed.kind, 'start')
        assert.equal(existsSync(paths.hookEffects), false)
      } else {
        assert.equal(resumed.kind, 'evidence')
        assert.equal(readFileSync(paths.hookEffects, 'utf8'), 'hook\n')
        if (mode === 'pipeline') assert.equal(existsSync(paths.toolEffects), false)
        else assert.equal(readFileSync(paths.toolEffects, 'utf8'), 'tool\n')
        if (mode === 'receipt') {
          assert.equal(old.record.phase, 'completed')
          assert.equal(
            recovered
              .replayEvents(f.expected, 'op1', request.control.request.body.payloadHash, 0)
              .at(-1)?.body.kind,
            'native.receipt',
          )
        } else {
          assert.equal(recovered.markExecutorUnknown('h1'), 1)
          assert.equal(
            recovered.query(f.expected, 'op1', request.control.request.body.payloadHash).phase,
            'unknown',
          )
        }
      }
    })
  }
})
test('two real writer processes race one grant; exactly one hook and tool effect runs', async (t) => {
  const f = fixture(t)
  const request = grant(f.expected)
  const paths = childConfig(f, request)
  f.journal.close()
  const results = await Promise.all([
    child(t, paths.config, 'race', f.root),
    child(t, paths.config, 'race', f.root),
  ])
  assert.deepEqual(results.map((result) => JSON.parse(result.output).kind).sort(), [
    'evidence',
    'start',
  ])
  assert.equal(readFileSync(paths.hookEffects, 'utf8'), 'hook\n')
  assert.equal(readFileSync(paths.toolEffects, 'utf8'), 'tool\n')
  const recovered = f.open()
  assert.equal(
    recovered.query(f.expected, 'op1', request.control.request.body.payloadHash).phase,
    'completed',
  )
})

test('installing a new Worker fence revokes old permits even while old execution is unresolved', (t) => {
  const f = fixture(t)
  const running = start(f)
  const replacement = structuredClone(f.expected)
  replacement.binding.bindingRevision++
  replacement.binding.workerId = 'w2'
  replacement.binding.workerInstanceId = 'wi2'
  replacement.lease = { ownerInstanceId: 'wi2', epoch: 2 }
  replacement.connectionId = 'replacement'
  f.journal.installFence(replacement, 20000, 1, 'b'.repeat(64))
  assert.equal(
    f.journal.query(replacement, 'op1', running.request.control.request.body.payloadHash).phase,
    'unknown',
  )
  assert.throws(() => f.journal.commitEffectiveInput(running.permit, {}, 1), /host-session-fence/)
  const next = grant(replacement, 'op2')
  assert.throws(
    () => f.journal.accept(replacement, next.control, next.frame),
    /host-unresolved-execution/,
  )
  f.journal.finish(running.permit, completed(running.request))
  assert.equal(f.journal.accept(replacement, next.control, next.frame).record.phase, 'accepted')
})
test('ordinary outbox capacity always leaves room for final durable receipt and replay', (t) => {
  const f = fixture(t)
  const running = start(f)
  for (let i = 0; i < 9999; i++)
    f.journal.appendExecutionEvent(running.permit, {
      kind: 'native.progress',
      message: { type: 'progress', index: i },
    })
  assert.throws(
    () => f.journal.appendExecutionEvent(running.permit, { kind: 'native.progress', message: {} }),
    /host-event-sealed-or-capacity/,
  )
  const finished = f.journal.finish(running.permit, completed(running.request))
  assert.equal(finished.eventCount, 10000)
  const reopened = f.open()
  let sequence = 0
  while (sequence < 10000) {
    const batch = reopened.replayEvents(
      f.expected,
      'op1',
      finished.request.body.payloadHash,
      sequence,
    )
    assert.equal(batch[0]?.sequence, sequence + 1)
    sequence += batch.length
    if (sequence === 10000) assert.equal(batch.at(-1)?.body.kind, 'native.receipt')
  }
  assert.equal(
    reopened.query(f.expected, 'op1', finished.request.body.payloadHash).receipt?.sha256,
    finished.receipt?.sha256,
  )
})
test('session manifests never enter the operation prefix; valid Host events fit the control journal', (t) => {
  const f = fixture(t)
  const running = start(f)
  const semantic = {
    kind: 'native.manifest' as const,
    contextRevision: 1,
    tools: [],
    logicalCwd: '/workspace',
    context: { git: '', rules: '', skills: [], mcpInstructions: [] },
  }
  const manifest = { ...semantic, manifestRevision: nativeManifestHash(semantic) }
  assert.throws(
    () => f.journal.appendExecutionEvent(running.permit, manifest),
    /host-operation-event-kind/,
  )
  assert.equal(
    f.journal.query(f.expected, 'op1', running.request.control.request.body.payloadHash).eventCount,
    0,
  )
  f.journal.appendExecutionEvent(running.permit, {
    kind: 'native.progress',
    message: { type: 'progress' },
  })
  const finished = f.journal.finish(running.permit, completed(running.request))
  const control = structuredClone(running.request.control)
  control.events = f.journal.replayEvents(f.expected, 'op1', control.request.body.payloadHash, 0)
  control.receipt = finished.receipt as NonNullable<typeof control.receipt>
  verifyNativeJournalRecord(control)
})
test('an accidental async exit verifier is never accepted as proof of cancellation', (t) => {
  const f = fixture(t, (() => Promise.resolve(true)) as unknown as () => boolean)
  const running = start(f)
  f.journal.requestCancel(f.expected, cancel(f.expected, running.request))
  assert.throws(
    () => f.journal.finish(running.permit, { ...completed(running.request), status: 'cancelled' }),
    /host-cancel-exit-unproven/,
  )
  assert.equal(
    f.journal.query(f.expected, 'op1', running.request.control.request.body.payloadHash).receipt,
    undefined,
  )
})

test('logical session epoch also revokes permits from a different native UUID', (t) => {
  const f = fixture(t)
  const running = start(f)
  const replacement = structuredClone(f.expected)
  replacement.nativeSessionId = '12345678-1234-1234-1234-123456789abd'
  replacement.lease.epoch++
  replacement.connectionId = 'new-native'
  f.journal.installFence(replacement, 20000, 1, 'b'.repeat(64))
  assert.throws(
    () => f.journal.commitEffectiveInput(running.permit, {}, 1),
    /host-session-fence|host-fence-mismatch/,
  )
  const next = grant(replacement, 'op2')
  assert.throws(
    () => f.journal.accept(replacement, next.control, next.frame),
    /host-unresolved-execution/,
  )
  assert.throws(
    () => f.journal.installFence(f.expected, 20000, 1, 'b'.repeat(64)),
    /host-old-epoch/,
  )
  f.journal.finish(running.permit, completed(running.request))
  assert.equal(f.journal.accept(replacement, next.control, next.frame).record.phase, 'accepted')
})

test('new native owner reads original history without reinstalling its old execution fence', (t) => {
  const f = fixture(t)
  const running = start(f)
  const fresh = structuredClone(f.expected)
  fresh.nativeSessionId = '12345678-1234-1234-1234-123456789abd'
  fresh.binding.bindingRevision++
  fresh.binding.workerInstanceId = 'wi2'
  fresh.lease = { ownerInstanceId: 'wi2', epoch: 2 }
  fresh.connectionId = 'new-owner'
  f.journal.installFence(fresh, 20000, 1, 'b'.repeat(64))
  f.journal.finish(running.permit, completed(running.request))
  const target = {
    nativeSessionId: f.expected.nativeSessionId,
    operationId: 'op1',
    payloadHash: running.request.control.request.body.payloadHash,
  }
  const reopened = f.open('h2')
  assert.equal(
    reopened.queryHistory(fresh, target).sourceScope.nativeSessionId,
    f.expected.nativeSessionId,
  )
  const events = reopened.replayHistoryEvents(fresh, target, 0)
  assert.equal(events.at(-1)?.body.kind, 'native.receipt')
  assert.equal(events[0]?.epoch, 1)
  assert.equal(events[0]?.producerInstanceId, 'h1')
  assert.throws(() => reopened.installFence(f.expected, 20000, 1, 'b'.repeat(64)), /host-old-epoch/)
  assert.throws(() => f.journal.commitEffectiveInput(running.permit, {}, 1), /host-session-fence/)
  assert.throws(() => reopened.query(f.expected, 'op1', target.payloadHash), /host-session-fence/)
  assert.throws(
    () => reopened.queryHistory(fresh, { ...target, operationId: 'foreign' }),
    /host-operation-missing/,
  )
})
test('a different logical session keeps its own lease and pipeline across another session reset', (t) => {
  const f = fixture(t)
  const other = structuredClone(f.expected)
  other.binding.sessionId = 's2'
  f.journal.installFence(other, 20000, 1, 'b'.repeat(64))
  const request = grant(other)
  const accepted = f.journal.accept(other, request.control, request.frame)
  const started = f.journal.beginPipeline(accepted.operation)
  assert.equal(started.kind, 'start')
  if (started.kind !== 'start') throw Error('fixture')
  const replacement = structuredClone(f.expected)
  replacement.nativeSessionId = '12345678-1234-1234-1234-123456789abd'
  replacement.lease.epoch++
  f.journal.installFence(replacement, 20000, 1, 'b'.repeat(64))
  f.journal.commitEffectiveInput(started.permit, {}, 1)
  assert.equal(f.journal.beginCanonicalCall(started.permit, {}, 1).kind, 'call')
})
test('fenced pipelines may report late progress but cannot initiate new permission/model callbacks', (t) => {
  const f = fixture(t)
  const running = start(f)
  const fresh = structuredClone(f.expected)
  fresh.nativeSessionId = '12345678-1234-1234-1234-123456789abd'
  fresh.lease.epoch++
  f.journal.installFence(fresh, 20000, 1, 'b'.repeat(64))
  const callback = {
    kind: 'permission' as const,
    callbackId: 'permission1',
    toolUse: running.request.control.request.body.toolUse,
    policyRevision: 1,
  }
  assert.throws(
    () =>
      f.journal.appendExecutionEvent(running.permit, {
        kind: 'native.callback',
        callback,
        callbackHash: nativeCallbackHash(f.expected, 'op1', callback),
      }),
    /host-session-fence/,
  )
  assert.equal(
    f.journal.appendExecutionEvent(running.permit, {
      kind: 'native.progress',
      message: { type: 'progress' },
    }).sequence,
    1,
  )
})

test('unknown under the same current lease cannot start a fresh callback or commit another call input', (t) => {
  const f = fixture(t)
  const running = start(f)
  f.journal.markExecutorUnknown('h1')
  const callback = {
    kind: 'permission' as const,
    callbackId: 'permission1',
    toolUse: running.request.control.request.body.toolUse,
    policyRevision: 1,
  }
  assert.throws(
    () =>
      f.journal.appendExecutionEvent(running.permit, {
        kind: 'native.callback',
        callback,
        callbackHash: nativeCallbackHash(f.expected, 'op1', callback),
      }),
    /host-not-startable/,
  )
  assert.throws(() => f.journal.commitEffectiveInput(running.permit, {}, 1), /host-not-startable/)
  assert.equal(f.journal.beginCanonicalCall(running.permit, {}, 1).kind, 'evidence')
  assert.equal(
    f.journal.appendExecutionEvent(running.permit, { kind: 'native.progress', message: {} })
      .sequence,
    1,
  )
  assert.equal(f.journal.finish(running.permit, completed(running.request)).phase, 'completed')
})
