import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
// protobufjs is CommonJS; a namespace import yields `{ default }` under tsx and
// `loadSync` is undefined (see the same note in engine/cursorSandRelay.ts).
import protobuf from 'protobufjs'
import { CURSOR_ENGINE_MODELS } from '@openclaude/protocol'
import { CursorSandRelay, encodeCursorSandRequest, recoverXmlToolCalls } from '../engine/cursorSandRelay.js'
import { CursorSandAdapter } from '../engine/cursorSandAdapter.js'
import {
  cursorSandEnabledForSelection,
  recordCursorCredentialResult,
  selectCursorCredential,
} from '../engine/cursorCredentialSelection.js'
import {
  cursorOfficialCcEnabledForModel,
  cursorVariantFor,
  CursorRoutingAdapter,
} from '../engine/cursorRoutingAdapter.js'
import { createEngine } from '../engine/registry.js'

const root = protobuf.loadSync(
  resolve(process.cwd(), 'packages/gateway/src/engine/cursorSandInference.proto'),
)
const StreamRequest = root.lookupType('aiserver.v1.InferenceStreamRequest')
const StreamResponse = root.lookupType('aiserver.v1.InferenceStreamResponse')
const SAND_SELECTION = {
  slot: 2, keyName: 'api-key.2', sandEnabled: true,
  poolGeneration: 'legacy', accountId: '0', keyFingerprint: '0000000000000000',
}
const NATIVE_SELECTION = {
  slot: 1, keyName: 'api-key', sandEnabled: false,
  poolGeneration: 'legacy', accountId: '0', keyFingerprint: '0000000000000000',
}
const STABLE_SAND_SELECTION = {
  slot: 2, keyName: 'api-key.2', sandEnabled: true,
  poolGeneration: 'gen-0123456789abcdef01234567',
  accountId: '42', keyFingerprint: '0123456789abcdef',
}

function envelope(payload: Uint8Array, flags = 0): Buffer {
  const out = Buffer.alloc(5 + payload.length)
  out[0] = flags
  out.writeUInt32BE(payload.length, 1)
  Buffer.from(payload).copy(out, 5)
  return out
}

function responseFrame(field: string, value: unknown): Buffer {
  return envelope(StreamResponse.encode(StreamResponse.fromObject({ [field]: value })).finish())
}

function fakeJwt(): string {
  return `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.y`
}

function inertRun() {
  return {
    submitted: Promise.resolve(),
    summary: Promise.resolve(null),
    end() {},
    getPartialSnapshot: () => ({
      assistantText: '', thinkingText: '', completedTools: [],
      assistantSegments: [], thinkingSegments: [], runtimeEvents: [],
    }),
    getPhantomSignals: () => ({ apiState: 'unknown' as const, skipReason: null }),
    finalized: true,
    pendingToolCalls: 0,
  }
}

test('Sand credential selects every concrete Cursor model while Auto stays native', () => {
  assert.equal(cursorSandEnabledForSelection('cursor-fable-5-high', SAND_SELECTION), true)
  assert.equal(cursorSandEnabledForSelection('cursor-grok-4.6-high', SAND_SELECTION), true)
  assert.equal(cursorSandEnabledForSelection('cursor-opus-5-max-fast', SAND_SELECTION), true)
  assert.equal(cursorSandEnabledForSelection('cursor-composer-2.5-fast', SAND_SELECTION), true)
  assert.equal(cursorSandEnabledForSelection('cursor-auto', SAND_SELECTION), false)
  assert.equal(cursorSandEnabledForSelection('cursor-fable-5-high', NATIVE_SELECTION), false)
})

test('official Claude Code flag selects only local Sand Opus/Fable models', () => {
  const on = { OC_CURSOR_SAND_OFFICIAL_CC: '1' }
  const off = { OC_CURSOR_SAND_OFFICIAL_CC: '0' }
  for (const model of [
    'cursor-opus-4.8-high',
    'cursor-opus-5-max-fast',
    'cursor-fable-5-high',
    'cursor-fable-5.1-xhigh',
  ]) {
    assert.equal(cursorOfficialCcEnabledForModel(model, on), true, model)
    assert.equal(cursorVariantFor(model, SAND_SELECTION, { kind: 'local' }, on), 'sand-official-cc')
    assert.equal(cursorVariantFor(model, SAND_SELECTION, { kind: 'local' }, off), 'sand-ccb')
    assert.equal(cursorVariantFor(model, NATIVE_SELECTION, { kind: 'local' }, on), 'native')
    assert.equal(
      cursorVariantFor(model, SAND_SELECTION, {
        kind: 'remote', hostId: 'host-1', hostMeta: {} as never,
      }, on),
      'sand-ccb',
    )
  }
  for (const model of [
    'cursor-grok-4.6-high',
    'cursor-composer-2.5-fast',
    'cursor-auto',
  ]) {
    assert.equal(cursorOfficialCcEnabledForModel(model, on), false, model)
    const expected = model === 'cursor-auto' ? 'native' : 'sand-ccb'
    assert.equal(cursorVariantFor(model, SAND_SELECTION, { kind: 'local' }, on), expected)
  }
})

test('Cursor routing adapter keeps native, CCB Sand, and official Sand resume ids mutually exclusive', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-sand-resume-discriminator-'))
  const previous = process.env.OC_CURSOR_SAND_OFFICIAL_CC
  const ccbId = 'sand-ccb:463989eb-daba-4a13-a32d-4ef00261ea08'
  const officialId = 'sand-official-cc:3bdc1a6e-63e3-4a3b-a29f-9aeb4e08c1cd'
  const nativeId = 'cursor-native-session-id'
  try {
    process.env.OC_CURSOR_SAND_OFFICIAL_CC = '0'
    const ccb = new CursorRoutingAdapter({
      sessionKey: 'agent:main:test:ccb-resume-discriminator', agentId: 'main', agentBaseDir: dir,
      config: {} as never, model: 'cursor-fable-5.1-high', cursorCredentialSelection: SAND_SELECTION,
    })
    assert.equal(ccb.currentVariant, 'sand-ccb')
    assert.equal(ccb.isResumeIdCompatible(ccbId), true)
    assert.equal(ccb.isResumeIdCompatible(officialId), false)
    assert.equal(ccb.isResumeIdCompatible(nativeId), false)
    await ccb.shutdown()

    process.env.OC_CURSOR_SAND_OFFICIAL_CC = '1'
    const official = new CursorRoutingAdapter({
      sessionKey: 'agent:main:test:official-resume-discriminator', agentId: 'main', agentBaseDir: dir,
      config: {} as never, model: 'cursor-fable-5.1-high', cursorCredentialSelection: SAND_SELECTION,
    })
    assert.equal(official.currentVariant, 'sand-official-cc')
    assert.equal(official.isResumeIdCompatible(officialId), true)
    assert.equal(official.isResumeIdCompatible(ccbId), false)
    assert.equal(official.isResumeIdCompatible(nativeId), false)
    await official.shutdown()

    const native = new CursorRoutingAdapter({
      sessionKey: 'agent:main:test:native-resume-discriminator', agentId: 'main', agentBaseDir: dir,
      config: {} as never, model: 'cursor-fable-5.1-high', cursorCredentialSelection: NATIVE_SELECTION,
    })
    assert.equal(native.currentVariant, 'native')
    assert.equal(native.isResumeIdCompatible(nativeId), true)
    assert.equal(native.isResumeIdCompatible(ccbId), false)
    assert.equal(native.isResumeIdCompatible(officialId), false)
    await native.shutdown()
  } finally {
    if (previous === undefined) delete process.env.OC_CURSOR_SAND_OFFICIAL_CC
    else process.env.OC_CURSOR_SAND_OFFICIAL_CC = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('official local and remote CCB execution targets rebuild the Cursor transport in both directions', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-sand-execution-target-switch-'))
  const previous = process.env.OC_CURSOR_SAND_OFFICIAL_CC
  const remote = {
    kind: 'remote' as const,
    hostId: 'host-1',
    hostMeta: {
      sessionId: 'agent:main:test:target-switch',
      userId: 'user-1',
      hostId: 'host-1',
      controlPath: '/run/ccb-ssh/host-1/ctl.sock',
      knownHostsPath: '/run/ccb-ssh/host-1/known_hosts',
      username: 'runner',
      host: '127.0.0.2',
      port: 22,
      remoteWorkdir: '/workspace',
    },
  }
  try {
    process.env.OC_CURSOR_SAND_OFFICIAL_CC = '1'
    const router = new CursorRoutingAdapter({
      sessionKey: 'agent:main:test:target-switch', agentId: 'main', agentBaseDir: dir,
      config: {} as never, model: 'cursor-fable-5.1-high', cursorCredentialSelection: SAND_SELECTION,
    })
    assert.equal(router.currentVariant, 'sand-official-cc')

    await router.setExecutionTarget(remote)
    assert.equal(router.currentVariant, 'sand-ccb')
    assert.deepEqual(router.executionTarget, remote)

    await router.setExecutionTarget({ kind: 'local' })
    assert.equal(router.currentVariant, 'sand-official-cc')
    assert.deepEqual(router.executionTarget, { kind: 'local' })
    await router.shutdown()
  } finally {
    if (previous === undefined) delete process.env.OC_CURSOR_SAND_OFFICIAL_CC
    else process.env.OC_CURSOR_SAND_OFFICIAL_CC = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cursor engine factory binds transport to the selected key and preserves it across concrete models', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-sand-factory-'))
  const opts = {
    sessionKey: 'agent:main:test:cursor-sand-factory',
    agentId: 'main',
    agentBaseDir: dir,
    config: {} as never,
    model: 'cursor-fable-5-high',
    cursorCredentialSelection: SAND_SELECTION,
  }
  try {
    const sand = createEngine('cursor', opts)
    assert.equal(sand instanceof CursorRoutingAdapter, true)
    assert.equal((sand as unknown as CursorRoutingAdapter).currentVariant, 'sand-ccb')
    assert.equal(sand.capabilities.supportsNativeCompact, false)
    assert.equal(typeof sand.compactForHandoff, 'undefined')
    sand.setModel('cursor-opus-5-high')
    await (sand as CursorRoutingAdapter).refreshVariantForTest()
    assert.equal((sand as unknown as CursorRoutingAdapter).currentVariant, 'sand-ccb')
    assert.deepEqual((sand as CursorRoutingAdapter).currentCredentialForTest, SAND_SELECTION)
    assert.throws(() => sand.setModel('cursor-auto'), /CURSOR_ROUTE_VARIANT_CHANGED_REOPEN_SESSION/)
    await sand.shutdown()

    const native = createEngine('cursor', {
      ...opts,
      model: 'cursor-grok-4.6-high',
      cursorCredentialSelection: NATIVE_SELECTION,
    })
    assert.equal(native instanceof CursorRoutingAdapter, true)
    assert.equal((native as unknown as CursorRoutingAdapter).currentVariant, 'native')
    native.setModel('cursor-composer-2.5')
    await (native as CursorRoutingAdapter).refreshVariantForTest()
    assert.equal((native as CursorRoutingAdapter).currentVariant, 'native')
    await native.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('credential selector parses a high-numbered Sand slot and records the same binding', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-credential-selector-'))
  const wrapper = resolve(dir, 'oc-cursor')
  const capture = resolve(dir, 'recorded')
  const previous = process.env.OC_CURSOR_WRAPPER_BIN
  writeFileSync(wrapper, `#!/bin/sh
set -eu
if [ "\${OPENCLAUDE_CURSOR_SELECT_ONLY:-}" = 1 ]; then
  echo 'oc-cursor: selected_slot 10 api-key.10 sand gen-0123456789abcdef01234567 42 0123456789abcdef'
  exit 0
fi
printf '%s %s %s %s %s\n' \
  "\${OPENCLAUDE_CURSOR_SELECTED_KEY:-}" "\${OPENCLAUDE_CURSOR_RECORD_RESULT:-}" \
  "\${OPENCLAUDE_CURSOR_POOL_GENERATION:-}" "\${OPENCLAUDE_CURSOR_ACCOUNT_ID:-}" \
  "\${OPENCLAUDE_CURSOR_KEY_FINGERPRINT:-}" > ${capture}
`, { mode: 0o755 })
  chmodSync(wrapper, 0o755)
  process.env.OC_CURSOR_WRAPPER_BIN = wrapper
  try {
    const selection = selectCursorCredential({
      agentId: 'main', sessionKey: 'agent:main:test:credential-selector',
      agentBaseDir: dir, model: 'cursor-opus-5-high',
    })
    assert.deepEqual(selection, {
      slot: 10,
      keyName: 'api-key.10',
      sandEnabled: true,
      poolGeneration: 'gen-0123456789abcdef01234567',
      accountId: '42',
      keyFingerprint: '0123456789abcdef',
    })
    recordCursorCredentialResult({
      agentId: 'main', sessionKey: 'agent:main:test:credential-selector',
      agentBaseDir: dir, model: 'cursor-opus-5-high', selection, result: 'ok',
    })
    assert.equal(
      readFileSync(capture, 'utf8').trim(),
      'api-key.10 ok gen-0123456789abcdef01234567 42 0123456789abcdef',
    )
  } finally {
    if (previous === undefined) delete process.env.OC_CURSOR_WRAPPER_BIN
    else process.env.OC_CURSOR_WRAPPER_BIN = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failed credential rebinds within the same transport but refuses a native-to-Sand failover', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-credential-rebind-'))
  try {
    const nextNative = { ...NATIVE_SELECTION, slot: 2, keyName: 'api-key.2' }
    const native = new CursorRoutingAdapter({
      sessionKey: 'agent:main:test:credential-rebind-native', agentId: 'main', agentBaseDir: dir,
      config: {} as never, model: 'cursor-grok-4.6-high', cursorCredentialSelection: NATIVE_SELECTION,
    }, () => nextNative)
    ;(native as unknown as { inner: { emit: (event: string, value: unknown) => void } })
      .inner.emit('external_billing', { status: 'error', terminalCode: 'ENGINE_ERROR' })
    await native.refreshVariantForTest()
    assert.deepEqual(native.currentCredentialForTest, nextNative)
    assert.equal(native.currentVariant, 'native')
    await native.shutdown()

    const mixed = new CursorRoutingAdapter({
      sessionKey: 'agent:main:test:credential-rebind-mixed', agentId: 'main', agentBaseDir: dir,
      config: {} as never, model: 'cursor-grok-4.6-high', cursorCredentialSelection: NATIVE_SELECTION,
    }, () => SAND_SELECTION)
    ;(mixed as unknown as { inner: { emit: (event: string, value: unknown) => void } })
      .inner.emit('external_billing', { status: 'unavailable', terminalCode: 'AUTH_UNAVAILABLE' })
    await assert.rejects(mixed.refreshVariantForTest(), /CURSOR_ROUTE_VARIANT_CHANGED_REOPEN_SESSION/)
    assert.deepEqual(mixed.currentCredentialForTest, NATIVE_SELECTION)
    await mixed.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concrete model quota-family changes reselect an eligible key before the next turn', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-model-family-reselect-'))
  try {
    const nextSand = { ...SAND_SELECTION, slot: 3, keyName: 'api-key.3' }
    let selections = 0
    const router = new CursorRoutingAdapter({
      sessionKey: 'agent:main:test:model-family-reselect', agentId: 'main', agentBaseDir: dir,
      config: {} as never, model: 'cursor-grok-4.6-high', cursorCredentialSelection: SAND_SELECTION,
    }, () => { selections++; return nextSand })
    router.setModel('cursor-opus-5-high')
    await router.refreshVariantForTest()
    assert.equal(selections, 1)
    assert.deepEqual(router.currentCredentialForTest, nextSand)
    assert.equal(router.currentVariant, 'sand-ccb')
    await router.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pool generation changes rebind stable account identity before reading a reused slot', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-generation-rebind-'))
  try {
    const generationOne = {
      slot: 2, keyName: 'api-key.2', sandEnabled: true,
      poolGeneration: 'gen-111111111111111111111111',
      accountId: '2', keyFingerprint: 'aaaaaaaaaaaaaaaa',
    }
    const generationTwo = {
      slot: 1, keyName: 'api-key', sandEnabled: true,
      poolGeneration: 'gen-222222222222222222222222',
      accountId: '2', keyFingerprint: 'aaaaaaaaaaaaaaaa',
    }
    const router = new CursorRoutingAdapter({
      sessionKey: 'agent:main:test:generation-rebind', agentId: 'main', agentBaseDir: dir,
      config: {} as never, model: 'cursor-opus-5-high', cursorCredentialSelection: generationOne,
    }, () => generationTwo)
    await router.refreshVariantForTest()
    assert.deepEqual(router.currentCredentialForTest, generationTwo)
    assert.equal(router.currentVariant, 'sand-ccb')
    await router.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cold submit starts the relay and emits one external billing terminal with usage', async () => {
  let starts = 0
  let closes = 0
  const relay = {
    async start() { starts++; return 'http://127.0.0.1:12345/route/test' },
    async close() { closes++ },
  } as unknown as CursorSandRelay
  const summary = {
    usage: {
      cost: 0, inputTokens: 11, outputTokens: 7,
      cacheReadTokens: 3, cacheCreationTokens: 2, totalTokens: 23,
    },
    assistantText: 'ok', thinkingText: '', assistantSegments: [], thinkingSegments: [],
    tools: [], runtimeEvents: [], stopReason: 'end_turn', numTurns: 1,
    isError: false, staleResumeId: false,
    phantomSignals: { apiState: 'called', skipReason: null },
  }
  const fakeRun = {
    submitted: Promise.resolve(),
    summary: Promise.resolve(summary),
    end() {},
    getPartialSnapshot: () => ({
      assistantText: '', thinkingText: '', completedTools: [],
      assistantSegments: [], thinkingSegments: [], runtimeEvents: [],
    }),
    getPhantomSignals: () => ({ apiState: 'unknown' as const, skipReason: null }),
    finalized: true,
    pendingToolCalls: 0,
  }
  const adapter = new CursorSandAdapter({
    sessionKey: 'agent:main:test:cold-sand', agentId: 'main', agentBaseDir: process.cwd(),
    config: {} as never, model: 'cursor-fable-5-high', cursorCredentialSelection: STABLE_SAND_SELECTION,
  }, relay, () => fakeRun as never, () => {})
  const billing: unknown[] = []
  adapter.on('external_billing', (event) => billing.push(event))
  const run = adapter.submitTurn({
    input: 'hello', requestId: 'a'.repeat(32),
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    onEvent() {}, onPostTerminalRuntimeEvent() {},
  })
  await run.submitted
  assert.equal((await run.summary)?.assistantText, 'ok')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(starts, 1)
  assert.equal(billing.length, 1)
  assert.deepEqual(billing[0], {
    requestId: 'a'.repeat(32), engine: 'cursor', status: 'success',
    durationMs: (billing[0] as { durationMs: number }).durationMs,
    usage: {
      input_tokens: 11, output_tokens: 7,
      cache_read_input_tokens: 3, cache_creation_input_tokens: 2,
    },
    cursorSlotResults: [{ slot: 2, result: 'ok' }],
    cursorAccountId: '42',
    cursorPoolGeneration: 'gen-0123456789abcdef01234567',
    cursorKeyFingerprint: '0123456789abcdef',
  })
  await adapter.shutdown()
  assert.equal(closes, 1)
})

test('interrupt before cold Sand preparation prevents submission', async () => {
  let releaseStart!: () => void
  const startGate = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise })
  let starts = 0
  let submissions = 0
  const relay = {
    async start() {
      starts++
      await startGate
      return 'http://127.0.0.1:12345/route/test'
    },
    async close() {},
  } as unknown as CursorSandRelay
  const adapter = new CursorSandAdapter({
    sessionKey: 'agent:main:test:cold-sand-cancel', agentId: 'main', agentBaseDir: process.cwd(),
    config: {} as never, model: 'cursor-fable-5-high', cursorCredentialSelection: SAND_SELECTION,
  }, relay, () => {
    submissions++
    throw new Error('cancelled cold submit must not reach the inner adapter')
  }, () => {})
  const billing: Array<{ terminalCode?: string }> = []
  adapter.on('external_billing', (event) => billing.push(event as { terminalCode?: string }))
  const run = adapter.submitTurn({
    input: 'hello', requestId: 'b'.repeat(32),
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    onEvent() {}, onPostTerminalRuntimeEvent() {},
  })
  assert.equal(adapter.interrupt(), true)
  releaseStart()
  await run.submitted
  assert.equal(await run.summary, null)
  assert.equal(starts, 1)
  assert.equal(submissions, 0)
  assert.equal(billing.length, 1)
  assert.equal(billing[0].terminalCode, 'USER_CANCELLED')
  await adapter.shutdown()
})

test('interrupting a live Sand turn stays cooperative until shutdown finalizes it', async () => {
  // Regression: a synchronous inner.end() on interrupt resolved the summary
  // before the process was gone, so SessionManager never escalated to
  // shutdown and a CCB process hung on a blocked tool survived into the next
  // turn (deep-thinking spinner with zero frames).
  const relay = {
    async start() { return 'http://127.0.0.1:12345/route/test' },
    async close() {},
  } as unknown as CursorSandRelay
  let resolveInner!: (value: null) => void
  let innerEnds = 0
  let innerFinalized = false
  const liveRun = {
    ...inertRun(),
    summary: new Promise<null>((resolvePromise) => { resolveInner = resolvePromise }),
    end() { innerEnds++; innerFinalized = true; resolveInner(null) },
    get finalized() { return innerFinalized },
  }
  const adapter = new CursorSandAdapter({
    sessionKey: 'agent:main:test:live-sand-cancel', agentId: 'main', agentBaseDir: process.cwd(),
    config: {} as never, model: 'cursor-fable-5-high', cursorCredentialSelection: SAND_SELECTION,
  }, relay, () => liveRun as never, () => {})
  const billing: Array<{ terminalCode?: string }> = []
  adapter.on('external_billing', (event) => billing.push(event as { terminalCode?: string }))
  const run = adapter.submitTurn({
    input: 'hello', requestId: 'c'.repeat(32),
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    onEvent() {}, onPostTerminalRuntimeEvent() {},
  })
  await run.submitted
  assert.equal(adapter.interrupt(), true)
  let settled = false
  void run.summary.then(() => { settled = true })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  assert.equal(innerEnds, 0, 'interrupt must not force-finalize a live run')
  assert.equal(settled, false, 'summary must stay pending so the caller can escalate')
  assert.equal(run.finalized, false)
  await adapter.shutdown()
  assert.equal(await run.summary, null)
  assert.equal(innerEnds, 1, 'shutdown settles the unanswered run exactly once')
  assert.equal(billing.length, 1)
  assert.equal(billing[0].terminalCode, 'USER_CANCELLED')
})

test('shutdown during cold Sand preparation waits and prevents resurrection', async () => {
  let releaseStart!: () => void
  let markStart!: () => void
  const startGate = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise })
  const startEntered = new Promise<void>((resolvePromise) => { markStart = resolvePromise })
  let submissions = 0
  const relay = {
    async start() {
      markStart()
      await startGate
      return 'http://127.0.0.1:12345/route/test'
    },
    async close() {},
  } as unknown as CursorSandRelay
  const adapter = new CursorSandAdapter({
    sessionKey: 'agent:main:test:cold-sand-shutdown', agentId: 'main', agentBaseDir: process.cwd(),
    config: {} as never, model: 'cursor-fable-5-high', cursorCredentialSelection: SAND_SELECTION,
  }, relay, () => {
    submissions++
    return inertRun() as never
  }, () => {})
  const run = adapter.submitTurn({
    input: 'hello', sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(), onEvent() {}, onPostTerminalRuntimeEvent() {},
  })
  const submittedFailure = run.submitted.then(
    () => null,
    (error: unknown) => error,
  )
  await startEntered
  let shutdownSettled = false
  const shutdown = adapter.shutdown().then(() => { shutdownSettled = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(shutdownSettled, false)
  releaseStart()
  assert.match(String(await submittedFailure), /CURSOR_SAND_ADAPTER_SHUTDOWN/)
  assert.equal(await run.summary, null)
  await shutdown
  assert.equal(submissions, 0)
  assert.equal(adapter.isRunning, false)
  const restarted = adapter.submitTurn({
    input: 'after recycle', sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(), onEvent() {}, onPostTerminalRuntimeEvent() {},
  })
  await restarted.submitted
  assert.equal(submissions, 1)
  await adapter.shutdown()
})

test('shutdown during Sand preheat waits and leaves no revived runner', async () => {
  let releaseStart!: () => void
  let markStart!: () => void
  const startGate = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise })
  const startEntered = new Promise<void>((resolvePromise) => { markStart = resolvePromise })
  const relay = {
    async start() {
      markStart()
      await startGate
      return 'http://127.0.0.1:12345/route/test'
    },
    async close() {},
  } as unknown as CursorSandRelay
  const adapter = new CursorSandAdapter({
    sessionKey: 'agent:main:test:sand-preheat-shutdown', agentId: 'main', agentBaseDir: process.cwd(),
    config: {} as never, model: 'cursor-fable-5-high', cursorCredentialSelection: SAND_SELECTION,
  }, relay, () => inertRun() as never, () => {})
  const preheat = adapter.preheat()
  const preheatFailure = preheat.then(
    () => null,
    (error: unknown) => error,
  )
  await startEntered
  let shutdownSettled = false
  const shutdown = adapter.shutdown().then(() => { shutdownSettled = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(shutdownSettled, false)
  releaseStart()
  assert.match(String(await preheatFailure), /CURSOR_SAND_ADAPTER_SHUTDOWN/)
  await shutdown
  assert.equal(adapter.isRunning, false)
  const restarted = adapter.submitTurn({
    input: 'after preheat recycle', sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(), onEvent() {}, onPostTerminalRuntimeEvent() {},
  })
  await restarted.submitted
  await adapter.shutdown()
})

test('routing interrupt during deferred variant preparation prevents inner submission', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-sand-routing-cancel-'))
  const router = new CursorRoutingAdapter({
    sessionKey: 'agent:main:test:routing-cancel', agentId: 'main', agentBaseDir: dir,
    config: {} as never, model: 'cursor-grok-4.6-high', cursorCredentialSelection: NATIVE_SELECTION,
  })
  try {
    let releaseVariant!: () => void
    let markVariant!: () => void
    const variantGate = new Promise<void>((resolvePromise) => { releaseVariant = resolvePromise })
    const variantEntered = new Promise<void>((resolvePromise) => { markVariant = resolvePromise })
    let submissions = 0
    const testRouter = router as unknown as {
      ensureVariant: () => Promise<void>
      inner: { submitTurn: () => ReturnType<typeof inertRun> }
    }
    testRouter.ensureVariant = async () => { markVariant(); await variantGate }
    testRouter.inner.submitTurn = () => {
      submissions++
      throw new Error('cancelled routing submit must not reach the inner adapter')
    }
    const run = router.submitTurn({
      input: 'hello', sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(), onEvent() {}, onPostTerminalRuntimeEvent() {},
    })
    await variantEntered
    assert.equal(router.interrupt(), true)
    releaseVariant()
    await run.submitted
    assert.equal(await run.summary, null)
    assert.equal(submissions, 0)
  } finally {
    await router.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('routing interrupt of a live inner run delegates to the inner adapter without ending it', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-sand-routing-live-cancel-'))
  const router = new CursorRoutingAdapter({
    sessionKey: 'agent:main:test:routing-live-cancel', agentId: 'main', agentBaseDir: dir,
    config: {} as never, model: 'cursor-grok-4.6-high', cursorCredentialSelection: NATIVE_SELECTION,
  })
  try {
    let innerEnds = 0
    let innerInterrupts = 0
    let resolveInner!: (value: null) => void
    const liveRun = {
      ...inertRun(),
      summary: new Promise<null>((resolvePromise) => { resolveInner = resolvePromise }),
      end() { innerEnds++; resolveInner(null) },
      finalized: false,
    }
    const testRouter = router as unknown as {
      ensureVariant: () => Promise<void>
      inner: { submitTurn: () => typeof liveRun; interrupt: () => boolean }
    }
    testRouter.ensureVariant = async () => {}
    testRouter.inner.submitTurn = () => liveRun
    testRouter.inner.interrupt = () => { innerInterrupts++; return true }
    const run = router.submitTurn({
      input: 'hello', sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(), onEvent() {}, onPostTerminalRuntimeEvent() {},
    })
    await run.submitted
    assert.equal(router.interrupt(), true)
    assert.equal(innerInterrupts, 1)
    assert.equal(innerEnds, 0, 'routing cancel must not force-finalize the inner run')
    let settled = false
    void run.summary.then(() => { settled = true })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    assert.equal(settled, false)
    run.end()
    assert.equal(innerEnds, 1)
    assert.equal(await run.summary, null)
  } finally {
    await router.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('routing shutdown during deferred preparation prevents resurrection', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-sand-routing-shutdown-'))
  const router = new CursorRoutingAdapter({
    sessionKey: 'agent:main:test:routing-shutdown', agentId: 'main', agentBaseDir: dir,
    config: {} as never, model: 'cursor-grok-4.6-high', cursorCredentialSelection: NATIVE_SELECTION,
  })
  try {
    let releaseVariant!: () => void
    let markVariant!: () => void
    const variantGate = new Promise<void>((resolvePromise) => { releaseVariant = resolvePromise })
    const variantEntered = new Promise<void>((resolvePromise) => { markVariant = resolvePromise })
    let submissions = 0
    const testRouter = router as unknown as {
      ensureVariant: () => Promise<void>
      inner: { submitTurn: () => ReturnType<typeof inertRun> }
    }
    testRouter.ensureVariant = async () => { markVariant(); await variantGate }
    testRouter.inner.submitTurn = () => {
      submissions++
      return inertRun()
    }
    const run = router.submitTurn({
      input: 'hello', sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(), onEvent() {}, onPostTerminalRuntimeEvent() {},
    })
    const submittedFailure = run.submitted.then(
      () => null,
      (error: unknown) => error,
    )
    await variantEntered
    let shutdownSettled = false
    const shutdown = router.shutdown().then(() => { shutdownSettled = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(shutdownSettled, false)
    releaseVariant()
    assert.match(String(await submittedFailure), /CURSOR_ROUTER_SHUTDOWN/)
    assert.equal(await run.summary, null)
    await shutdown
    assert.equal(submissions, 0)
    router.setModel('cursor-grok-4.6-high')
    router.setToolsets(['browser'])
    const restarted = router.submitTurn({
      input: 'after same-variant recycle', sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(), onEvent() {}, onPostTerminalRuntimeEvent() {},
    })
    await restarted.submitted
    assert.equal(submissions, 1)
  } finally {
    await router.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool recovery accepts XML and bounded compact control but rejects unknown tools', () => {
  const bash = { name: 'Bash', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
  const read = { name: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
  const xml = recoverXmlToolCalls(
    '<tool_use name="Read">{"path":"a.txt"}</tool_use>',
    [read],
  )
  assert.equal(xml.tools.length, 1)
  assert.equal(xml.tools[0].name, 'Read')
  assert.deepEqual(xml.tools[0].input, { path: 'a.txt' })
  assert.equal(xml.text, '')

  const example = recoverXmlToolCalls(
    'Example: <tool_use name="Bash">{"command":"danger"}</tool_use>',
    [bash],
  )
  assert.equal(example.tools.length, 0)
  assert.match(example.text, /Example:/)

  const compact = recoverXmlToolCalls(
    'tool_call: {"name":"Bash","arguments":{"command":"printf ok"}}',
    [bash],
  )
  assert.equal(compact.tools.length, 1)
  assert.equal(compact.tools[0].name, 'Bash')
  assert.equal(compact.text, '')

  const compactWithSuffix = recoverXmlToolCalls(
    'tool_call: {"name":"Bash","arguments":{"command":"printf ok"}}\nresult',
    [bash],
  )
  assert.equal(compactWithSuffix.tools.length, 0)

  const colon = recoverXmlToolCalls(': Bash\ninput: {"command":"printf ok"}', [bash])
  assert.equal(colon.tools.length, 1)
  assert.equal(colon.tools[0].name, 'Bash')
  assert.deepEqual(colon.tools[0].input, { command: 'printf ok' })
  assert.equal(colon.text, '')

  const cursorCardText = recoverXmlToolCalls(
    'name Bash\ninput {"command":"printf ok"}\n\nresult\nFAKE_RESULT\nfinal answer',
    [bash],
  )
  assert.equal(cursorCardText.tools.length, 1)
  assert.equal(cursorCardText.tools[0].name, 'Bash')
  assert.deepEqual(cursorCardText.tools[0].input, { command: 'printf ok' })
  assert.equal(cursorCardText.text, '')

  const rejected = recoverXmlToolCalls(
    'tool_call: {"name":"Unadvertised","arguments":{}}',
    [bash],
  )
  assert.equal(rejected.tools.length, 0)

  const inferred = recoverXmlToolCalls(
    '{"command":"printf ok"}',
    [
      bash,
      read,
    ],
  )
  assert.equal(inferred.tools.length, 1)
  assert.equal(inferred.tools[0].name, 'Bash')
  assert.equal(inferred.text, '')

  const wrongType = recoverXmlToolCalls(
    '{"command":123}',
    [bash],
  )
  assert.equal(wrongType.tools.length, 0)
})

test('Fable Sand encodes native tool schemas and structured tool-result history', () => {
  const encoded = encodeCursorSandRequest({
    model: 'cursor-fable-5-high',
    max_tokens: 512,
    system: [{ type: 'text', text: 'system' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' }],
      },
    ],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
  })
  assert.equal(encoded.upstreamModel, 'claude-fable-5-thinking-high')
  const request = StreamRequest.toObject(StreamRequest.decode(encoded.bytes), { oneofs: true })
  assert.equal(request.modelId, 'claude-fable-5-thinking-high')
  assert.equal(request.modelConfig.maxTokens, 512)
  assert.equal(request.messages[0].role, 4)
  assert.doesNotMatch(request.messages[0].text, /<tool_use name="TOOL_NAME">/)
  assert.equal(request.tools.length, 1)
  assert.equal(request.tools[0].name, 'Read')
  assert.equal(
    request.tools[0].parameters.fields.jsonSchema.structValue.fields.type.stringValue,
    'object',
  )
  const assistant = request.messages.find((message: { role?: number }) => message.role === 2)
  assert.equal(assistant.toolCalls[0].toolCallId, 'toolu_1')
  assert.equal(assistant.toolCalls[0].toolName, 'Read')
  assert.equal(assistant.toolCalls[0].rawToolCallArgs, '{"path":"a.txt"}')
  const toolResult = request.messages.find((message: { role?: number }) => message.role === 3)
  assert.equal(toolResult.toolContent.parts[0].toolCallId, 'toolu_1')
  assert.equal(toolResult.toolContent.parts[0].toolName, 'Read')
  assert.equal(toolResult.toolContent.parts[0].result.stringValue, 'contents')
})

test('Sand keeps Read image blocks in tool results and user turns (vision regression)', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const encoded = encodeCursorSandRequest({
    model: 'cursor-fable-5.1-high',
    system: [{ type: 'text', text: 'system' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_img', name: 'Read', input: { file_path: '/tmp/shot.png' } }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_img',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
        }],
      },
    ],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
  })
  const request = StreamRequest.toObject(StreamRequest.decode(encoded.bytes), { oneofs: true })
  // Plain user turn with an inline image keeps both text and pixels.
  const userTurn = request.messages.find((message: { role?: number }) => message.role === 1)
  assert.equal(userTurn.parts.parts.length, 2)
  assert.equal(userTurn.parts.parts[0].text.text, 'look at this')
  assert.equal(userTurn.parts.parts[1].image.mimeType, 'image/png')
  assert.equal(userTurn.parts.parts[1].image.data, png)
  // Read tool result with an image block is not squashed to an empty string.
  const toolResult = request.messages.find((message: { role?: number }) => message.role === 3)
  const part = toolResult.toolContent.parts[0]
  assert.equal(part.toolCallId, 'toolu_img')
  assert.equal(part.toolName, 'Read')
  assert.notEqual(part.result.stringValue, '')
  assert.equal(part.experimentalContent.length, 1)
  assert.equal(part.experimentalContent[0].image.mimeType, 'image/png')
  assert.equal(part.experimentalContent[0].image.data, png)
})

test('Grok Sand encodes native tool schemas and structured tool-result history', () => {
  const encoded = encodeCursorSandRequest({
    model: 'cursor-grok-4.6-high',
    system: [{ type: 'text', text: 'system' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'printf ok' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    ],
    tools: [{
      name: 'Bash',
      description: 'run a command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    }],
  })
  const request = StreamRequest.toObject(StreamRequest.decode(encoded.bytes), { oneofs: true })
  assert.equal(request.modelId, 'cursor-grok-4.6-high')
  assert.equal(request.messages[0].role, 4)
  assert.doesNotMatch(request.messages[0].text, /<tool_use name="TOOL_NAME">/)
  assert.equal(request.tools.length, 1)
  assert.equal(request.tools[0].name, 'Bash')
  const schema = request.tools[0].parameters.fields.jsonSchema.structValue.fields
  assert.equal(schema.type.stringValue, 'object')
  assert.equal(schema.properties.structValue.fields.command.structValue.fields.type.stringValue, 'string')
  assert.equal(schema.required.listValue.values[0].stringValue, 'command')
  const assistant = request.messages.find((message: { role?: number }) => message.role === 2)
  assert.equal(assistant.toolCalls[0].toolCallId, 'call_1')
  assert.equal(assistant.toolCalls[0].toolName, 'Bash')
  assert.equal(assistant.toolCalls[0].rawToolCallArgs, '{"command":"printf ok"}')
  const toolResult = request.messages.find((message: { role?: number }) => message.role === 3)
  assert.equal(toolResult.toolContent.parts[0].toolCallId, 'call_1')
  assert.equal(toolResult.toolContent.parts[0].toolName, 'Bash')
  assert.equal(toolResult.toolContent.parts[0].result.stringValue, 'ok')
})

test('every concrete catalog Cursor model maps to its Sand InferenceService id', () => {
  const unique = [...new Map(CURSOR_ENGINE_MODELS.map((model) => [model.id, model])).values()]
  for (const model of unique) {
    if (model.upstreamModel === null) continue
    const encoded = encodeCursorSandRequest({
      model: model.id,
      messages: [{ role: 'user', content: 'OK' }],
      max_tokens: 64,
    })
    const request = StreamRequest.toObject(StreamRequest.decode(encoded.bytes), { oneofs: true })
    assert.equal(encoded.upstreamModel, model.upstreamModel, model.id)
    assert.equal(request.modelId, model.upstreamModel, model.id)
    assert.equal(request.requestedModel.modelId, model.upstreamModel, model.id)
  }
  assert.throws(
    () => encodeCursorSandRequest({ model: 'cursor-auto', messages: [{ role: 'user', content: 'OK' }] }),
    /CURSOR_SAND_MODEL_NOT_SUPPORTED/,
  )
})

test('loopback relay hits InferenceService/Stream with Sand identity and emits Anthropic SSE', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/auth/exchange_user_api_key')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.InferenceService/Stream')
    const headers = new Headers(init.headers)
    assert.equal(headers.get('x-cursor-client-type'), 'sand')
    assert.equal(headers.get('x-cursor-client-version'), 'cli-2026.08.11-e8db854')
    assert.equal(headers.get('content-type'), 'application/connect+proto')
    const body = Buffer.from(init.body as Uint8Array)
    const length = body.readUInt32BE(1)
    const request = StreamRequest.toObject(
      StreamRequest.decode(body.subarray(5, 5 + length)),
      { oneofs: true },
    )
    assert.equal(request.modelId, 'claude-fable-5-thinking-high')
    assert.equal(request.tools.length, 1)
    assert.equal(request.tools[0].name, 'Read')
    assert.equal(
      request.tools[0].parameters.fields.jsonSchema.structValue.fields.type.stringValue,
      'object',
    )
    const response = Buffer.concat([
      responseFrame('thinkingPart', { text: 'thought' }),
      responseFrame('textPart', { text: 'done' }),
      responseFrame('toolCallPart', { toolCallId: 'toolu_x', toolName: 'Read' }),
      responseFrame('toolCallPart', { toolCallId: 'toolu_x', args: '{"path":' }),
      responseFrame('toolCallPart', { toolCallId: 'toolu_x', args: '"a.txt"}' }),
      responseFrame('toolCallPart', {
        toolCallId: 'toolu_x', toolName: 'Read', args: '{"path":"a.txt"}', isComplete: true,
      }),
      responseFrame('usage', { promptTokens: 10, completionTokens: 4, totalTokens: 14 }),
      envelope(Buffer.from('{}'), 0x02),
    ])
    return new Response(response, {
      status: 200,
      headers: { 'content-type': 'application/connect+proto' },
    })
  }
  const relay = new CursorSandRelay({
    fetchImpl,
    readApiKey: () => Buffer.from('crsr_test'),
  })
  const baseUrl = await relay.start()
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-fable-5-high',
        stream: true,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /event: message_start/)
    assert.match(text, /"usage":\{"input_tokens":0,"output_tokens":0\}/)
    assert.match(text, /"usage":\{"input_tokens":10,"output_tokens":4\}/)
    assert.match(text, /"type":"thinking_delta"/)
    assert.match(text, /"type":"text_delta","text":"done"/)
    assert.match(text, /"type":"tool_use"/)
    assert.match(text, /"type":"input_json_delta"/)
    assert.match(text, /"partial_json":"\{\\"path\\":\\"a.txt\\"\}"/)
    assert.equal((text.match(/"type":"tool_use"/g) ?? []).length, 1)
    assert.match(text, /"stop_reason":"tool_use"/)
    assert.match(text, /event: message_stop/)
    assert.equal(calls.length, 2)
  } finally {
    await relay.close()
  }
})

test('relay passes non-Sand models (CCB sub-agent pin) through to the internal proxy verbatim', async () => {
  const seen: { url: string; auth: string | null; body: string }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/auth/exchange_user_api_key') || url.includes('InferenceService')) {
      throw new Error(`Sand upstream must not be touched for passthrough: ${url}`)
    }
    const headers = new Headers(init?.headers)
    seen.push({ url, auth: headers.get('authorization'), body: Buffer.from(init?.body as Uint8Array).toString('utf8') })
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const relay = new CursorSandRelay({
    fetchImpl,
    readApiKey: () => Buffer.from('crsr_test'),
    passthrough: { baseUrl: 'http://proxy.internal:18892', authToken: 'container-bearer' },
  })
  const baseUrl = await relay.start()
  try {
    const payload = JSON.stringify({
      model: 'glm-5.3-zai', stream: true, max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /event: message_stop/)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, 'http://proxy.internal:18892/v1/messages')
    assert.equal(seen[0].auth, 'Bearer container-bearer')
    assert.equal(seen[0].body, payload)
  } finally {
    await relay.close()
  }
})

test('relay rejects non-Sand models with 400 (not 502) when no passthrough proxy exists', async () => {
  const relay = new CursorSandRelay({
    fetchImpl: async () => { throw new Error('unreachable') },
    readApiKey: () => Buffer.from('crsr_test'),
    passthrough: null,
  })
  const baseUrl = await relay.start()
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3-zai', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /not a Cursor Sand route/)
  } finally {
    await relay.close()
  }
})

test('native Fable forwards thinking before the upstream stream ends', async () => {
  let releaseUpstream!: () => void
  const upstreamGate = new Promise<void>((resolvePromise) => { releaseUpstream = resolvePromise })
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/auth/exchange_user_api_key')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(responseFrame('thinkingPart', { text: 'EARLY_THINKING' }))
        void upstreamGate.then(() => {
          controller.enqueue(responseFrame('textPart', { text: 'LATE_ANSWER' }))
          controller.enqueue(responseFrame('usage', {
            promptTokens: 5, completionTokens: 2, totalTokens: 7,
          }))
          controller.enqueue(envelope(Buffer.from('{}'), 0x02))
          controller.close()
        })
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/connect+proto' },
    })
  }
  const relay = new CursorSandRelay({ fetchImpl, readApiKey: () => Buffer.from('crsr_test') })
  const baseUrl = await relay.start()
  let released = false
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-fable-5-high', stream: true, max_tokens: 64,
        messages: [{ role: 'user', content: 'answer' }],
      }),
    })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    let prefix = ''
    while (!prefix.includes('EARLY_THINKING')) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('early thinking timeout')),
          1_000,
        )),
      ])
      assert.equal(next.done, false)
      prefix += Buffer.from(next.value!).toString('utf8')
    }
    assert.doesNotMatch(prefix, /LATE_ANSWER/)
    releaseUpstream()
    released = true
    let suffix = ''
    while (true) {
      const next = await reader.read()
      if (next.done) break
      suffix += Buffer.from(next.value).toString('utf8')
    }
    assert.match(prefix + suffix, /LATE_ANSWER/)
    assert.match(prefix + suffix, /"usage":\{"input_tokens":5,"output_tokens":2\}/)
  } finally {
    if (!released) releaseUpstream()
    await relay.close()
  }
})

test('ordinary tool examples remain text and do not trigger a correction request', async () => {
  let inferenceCalls = 0
  const ordinary = 'Example: <tool_use name="Bash">{"command":"printf unsafe"}</tool_use>'
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/auth/exchange_user_api_key')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    inferenceCalls++
    return new Response(Buffer.concat([
      responseFrame('textPart', { text: ordinary }),
      responseFrame('usage', { promptTokens: 8, completionTokens: 6, totalTokens: 14 }),
      envelope(Buffer.from('{}'), 0x02),
    ]), {
      status: 200,
      headers: { 'content-type': 'application/connect+proto' },
    })
  }
  const relay = new CursorSandRelay({ fetchImpl, readApiKey: () => Buffer.from('crsr_test') })
  const baseUrl = await relay.start()
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-fable-5-high', stream: true, max_tokens: 64,
        messages: [{ role: 'user', content: 'show a tool example' }],
        tools: [{
          name: 'Bash',
          input_schema: {
            type: 'object', properties: { command: { type: 'string' } }, required: ['command'],
          },
        }],
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /Example:/)
    assert.match(body, /"stop_reason":"end_turn"/)
    assert.equal(inferenceCalls, 1)
  } finally {
    await relay.close()
  }
})

test('mixed tool JSON and fabricated result is corrected to structured tool_use without leaking raw text', async () => {
  let inferenceCalls = 0
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/auth/exchange_user_api_key')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    inferenceCalls++
    const text = inferenceCalls === 1
      ? '{"command":"printf ok"}\n\nFAKE_RESULT'
      : '<tool_use name="Bash">{"command":"printf ok"}</tool_use>'
    return new Response(Buffer.concat([
      responseFrame('textPart', { text }),
      responseFrame('usage', { promptTokens: 8, completionTokens: 6, totalTokens: 14 }),
      envelope(Buffer.from('{}'), 0x02),
    ]), {
      status: 200,
      headers: { 'content-type': 'application/connect+proto' },
    })
  }
  const relay = new CursorSandRelay({ fetchImpl, readApiKey: () => Buffer.from('crsr_test') })
  const baseUrl = await relay.start()
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-fable-5-high', stream: true, max_tokens: 64,
        messages: [{ role: 'user', content: 'run it' }],
        tools: [{
          name: 'Bash',
          input_schema: {
            type: 'object', properties: { command: { type: 'string' } }, required: ['command'],
          },
        }],
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /"type":"tool_use"/)
    assert.match(body, /"stop_reason":"tool_use"/)
    assert.doesNotMatch(body, /FAKE_RESULT/)
    assert.equal(inferenceCalls, 2)
  } finally {
    await relay.close()
  }
})

test('count_tokens remains loopback-scoped and side-effect free', async () => {
  let upstreamCalls = 0
  const relay = new CursorSandRelay({
    fetchImpl: async () => {
      upstreamCalls++
      throw new Error('must not call upstream')
    },
    readApiKey: () => Buffer.from('unused'),
  })
  const baseUrl = await relay.start()
  try {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cursor-fable-5-high', messages: [{ role: 'user', content: 'hello' }] }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { input_tokens: number }
    assert.equal(body.input_tokens > 0, true)
    assert.equal(upstreamCalls, 0)
  } finally {
    await relay.close()
  }
})

test('downstream abort cancels the Cursor stream and relay close does not hang', async () => {
  let upstreamAborted = false
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input).endsWith('/auth/exchange_user_api_key')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener('abort', () => {
          upstreamAborted = true
          controller.error(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      },
      cancel() { upstreamAborted = true },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/connect+proto' },
    })
  }
  const relay = new CursorSandRelay({ fetchImpl, readApiKey: () => Buffer.from('crsr_test') })
  const baseUrl = await relay.start()
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'cursor-fable-5-high', stream: true, max_tokens: 64,
      messages: [{ role: 'user', content: 'wait' }],
    }),
    signal: controller.signal,
  })
  controller.abort()
  await response.text().catch(() => {})
  await Promise.race([
    relay.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('relay close timeout')), 500)),
  ])
  assert.equal(upstreamAborted, true)
})
