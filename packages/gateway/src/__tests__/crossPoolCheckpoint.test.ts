import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { REMOTE_DRIVER_BACKEND, type RemoteExecutionBackend } from '@openclaude/protocol'
import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'
import {
  CROSS_POOL_CHECKPOINT_FIELD,
  CROSS_POOL_CHECKPOINT_MAX_SUMMARY_CHARS,
  MIGRATION_INSTALL_RECEIPT_TYPE,
  finalizeInboundCrossPoolMigration,
  ingestVerifiedCrossPoolCheckpoint,
  resolveMigrationAwareStoredResume,
  type MigrationInstallReceiptFrame,
} from '../crossPoolCheckpoint.js'
import '../engine/ccbAdapter.js'
import type { EngineAdapter, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import { registerRemoteDriverAdapter, type EngineCreateOpts } from '../engine/registry.js'
import type { TurnExecutionDescriptor } from '../modelAuthority.js'
import type { ExecutionTarget } from '../remoteTarget.js'
import {
  ackPendingCheckpoint,
  checkpointFilePath,
  clearPendingCheckpoint,
  peekPendingCheckpoint,
  savePendingCheckpointWithGeneration,
} from '../sessionCheckpointStore.js'
import { SessionManager } from '../sessionManager.js'
import { setV3MasterSinkSingleton } from '../v3MasterSink.js'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function makeVerifiedAuthority(
  overrides?: Partial<NonNullable<TurnExecutionDescriptor['poolMigration']>>,
): Pick<TurnExecutionDescriptor, 'poolMigration'> {
  return {
    poolMigration: {
      migrationId: 'mig-cross-pool-0001',
      placementEpoch: 2,
      allowBackendTransition: true,
      continuityTier: 'tape_rebuilt',
      ...overrides,
    },
  }
}

function makeWireFrame(overrides?: Record<string, unknown>): Record<string, unknown> {
  const summary = '## Cross-Pool Warm-Resume Checkpoint\n\n### First-Turn Goal\nKeep OCV5-902 safe.'
  return {
    type: 'inbound.message',
    [CROSS_POOL_CHECKPOINT_FIELD]: {
      v: 1,
      generation: 'cp-gen-0001',
      migrationId: 'mig-cross-pool-0001',
      placementEpoch: 2,
      mode: 'anchored_v2',
      anchorSeq: 7,
      sourceEngine: 'ccb',
      summary,
      sha256: sha256(summary),
      ...overrides,
    },
  }
}

describe('OCV5-902 P0-1: gateway crossPoolCheckpoint & savePendingCheckpointWithGeneration', () => {
  it('savePendingCheckpointWithGeneration writes atomically (0600), preserves exact generation, and is idempotent on duplicate generation', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'ocv5-cp-store-'))
    try {
      const sessionKey = 'agent:main:webchat:dm:cp-gen-idempotent'
      const rec1 = savePendingCheckpointWithGeneration(sessionKey, 'Summary v1', {
        generation: 'cp-fixed-gen-1',
        instructions: 'Keep tests green',
        baseDir,
      })
      assert.equal(rec1.generation, 'cp-fixed-gen-1')
      assert.equal(rec1.summary, 'Summary v1')
      assert.equal(rec1.instructions, 'Keep tests green')

      const filePath = checkpointFilePath(sessionKey, baseDir)
      const st1 = statSync(filePath)
      assert.equal(st1.mode & 0o777, 0o600)

      // Idempotent duplicate call with same generation must NOT rewrite disk
      const rec2 = savePendingCheckpointWithGeneration(sessionKey, 'Different text ignored', {
        generation: 'cp-fixed-gen-1',
        baseDir,
      })
      assert.equal(rec2.generation, 'cp-fixed-gen-1')
      assert.equal(rec2.summary, 'Summary v1')
      const st2 = statSync(filePath)
      assert.equal(st2.ino, st1.ino)

      // Different generation atomically replaces on disk
      const rec3 = savePendingCheckpointWithGeneration(sessionKey, 'Summary v2', {
        generation: 'cp-fixed-gen-2',
        baseDir,
      })
      assert.equal(rec3.generation, 'cp-fixed-gen-2')
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir)?.summary, 'Summary v2')

      // Wrong generation ack fails; exact generation ack deletes file
      assert.equal(ackPendingCheckpoint(sessionKey, 'cp-fixed-gen-1', baseDir), false)
      assert.equal(ackPendingCheckpoint(sessionKey, 'cp-fixed-gen-2', baseDir), true)
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir), null)

      // Empty summary / empty generation throw
      assert.throws(
        () => savePendingCheckpointWithGeneration(sessionKey, '   ', { generation: 'g1', baseDir }),
        /EMPTY_CHECKPOINT_SUMMARY/,
      )
      assert.throws(
        () => savePendingCheckpointWithGeneration(sessionKey, 'valid', { generation: '  ', baseDir }),
        /EMPTY_CHECKPOINT_GENERATION/,
      )
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('ingestVerifiedCrossPoolCheckpoint accepts verified frame (both via DI store and standalone) and is idempotent on redelivery', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'ocv5-cp-ingest-ok-'))
    try {
      const sessionKey1 = 'agent:main:webchat:dm:ingest-di'
      const frame = makeWireFrame()
      const auth = makeVerifiedAuthority()

      const res1 = ingestVerifiedCrossPoolCheckpoint(frame, auth, sessionKey1, {
        baseDir,
        saveCheckpoint: savePendingCheckpointWithGeneration,
      })
      assert.deepEqual(res1, {
        accepted: true,
        generation: 'cp-gen-0001',
        migrationId: 'mig-cross-pool-0001',
        placementEpoch: 2,
      })

      const filePath1 = checkpointFilePath(sessionKey1, baseDir)
      const ino1 = statSync(filePath1).ino
      const peek1 = peekPendingCheckpoint(sessionKey1, baseDir)
      assert.equal(peek1?.generation, 'cp-gen-0001')
      assert.ok(peek1?.summary.includes('OCV5-902'))

      // Redelivery of the exact same frame is idempotent and does not rewrite disk
      const res1Retry = ingestVerifiedCrossPoolCheckpoint(frame, auth, sessionKey1, {
        baseDir,
        saveCheckpoint: savePendingCheckpointWithGeneration,
      })
      assert.equal(res1Retry.accepted, true)
      assert.equal(statSync(filePath1).ino, ino1)

      // Standalone path (no saveCheckpoint callback) writes identical format readable by peekPendingCheckpoint
      const sessionKey2 = 'agent:main:webchat:dm:ingest-standalone'
      const res2 = ingestVerifiedCrossPoolCheckpoint(frame, auth, sessionKey2, { baseDir })
      assert.equal(res2.accepted, true)
      const peek2 = peekPendingCheckpoint(sessionKey2, baseDir)
      assert.equal(peek2?.generation, 'cp-gen-0001')
      assert.ok(peek2?.summary.includes('OCV5-902'))
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('ingestVerifiedCrossPoolCheckpoint fails closed against forged, tampered, mismatched, oversized, or symlink-targeted payloads', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'ocv5-cp-ingest-neg-'))
    try {
      const sessionKey = 'agent:main:webchat:dm:ingest-neg'
      const auth = makeVerifiedAuthority()

      // Missing field
      assert.deepEqual(ingestVerifiedCrossPoolCheckpoint({ type: 'inbound.message' }, auth, sessionKey, { baseDir }), {
        accepted: false,
        reason: 'missing',
      })

      // Forged client frame WITHOUT verified turnAuthority.poolMigration
      assert.deepEqual(ingestVerifiedCrossPoolCheckpoint(makeWireFrame(), undefined, sessionKey, { baseDir }), {
        accepted: false,
        reason: 'missing_authority',
      })
      assert.deepEqual(ingestVerifiedCrossPoolCheckpoint(makeWireFrame(), {}, sessionKey, { baseDir }), {
        accepted: false,
        reason: 'missing_authority',
      })

      // Wrong continuityTier (cold_degraded / hot_native)
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(
          makeWireFrame(),
          makeVerifiedAuthority({ continuityTier: 'cold_degraded' }),
          sessionKey,
          { baseDir },
        ),
        { accepted: false, reason: 'tier_mismatch' },
      )

      // Mismatched migrationId
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(
          makeWireFrame({ migrationId: 'mig-forged-9999' }),
          auth,
          sessionKey,
          { baseDir },
        ),
        { accepted: false, reason: 'migration_id_mismatch' },
      )

      // Mismatched placementEpoch
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(makeWireFrame({ placementEpoch: 3 }), auth, sessionKey, { baseDir }),
        { accepted: false, reason: 'epoch_mismatch' },
      )

      // Tampered summary (sha256 mismatch)
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(
          makeWireFrame({ summary: 'Tampered prompt injection payload' }),
          auth,
          sessionKey,
          { baseDir },
        ),
        { accepted: false, reason: 'sha256_mismatch' },
      )

      // Oversized summary (> 16384 chars)
      const huge = 'x'.repeat(CROSS_POOL_CHECKPOINT_MAX_SUMMARY_CHARS + 1)
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(
          makeWireFrame({ summary: huge, sha256: sha256(huge) }),
          auth,
          sessionKey,
          { baseDir },
        ),
        { accepted: false, reason: 'invalid_shape' },
      )

      // Wrong version / malformed sha256
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(makeWireFrame({ v: 2 }), auth, sessionKey, { baseDir }),
        { accepted: false, reason: 'invalid_shape' },
      )
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(makeWireFrame({ sha256: 'not-hex' }), auth, sessionKey, { baseDir }),
        { accepted: false, reason: 'invalid_shape' },
      )

      // Nothing was persisted on disk after all negative attempts!
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir), null)

      // Symlink target fails closed with persist_failed (never crashes)
      const decoyPath = join(baseDir, 'decoy.json')
      writeFileSync(decoyPath, '{}', 'utf8')
      const targetPath = checkpointFilePath(sessionKey, baseDir)
      symlinkSync(decoyPath, targetPath)
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(makeWireFrame(), auth, sessionKey, {
          baseDir,
          saveCheckpoint: savePendingCheckpointWithGeneration,
        }),
        { accepted: false, reason: 'persist_failed' },
      )
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('W2: rejects out-of-order older placementEpoch and replay of already-consumed generation', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'ocv5-cp-w2-'))
    try {
      const sessionKey = 'agent:main:webchat:dm:cp-w2-watermark'

      // Save epoch 3 checkpoint
      const recEpoch3 = savePendingCheckpointWithGeneration(sessionKey, 'Epoch 3 anchored summary', {
        generation: 'cp-gen-epoch-3',
        placementEpoch: 3,
        baseDir,
      })
      assert.equal(recEpoch3.placementEpoch, 3)
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir)?.placementEpoch, 3)

      // Out-of-order older placementEpoch (epoch 2) MUST be rejected and NEVER overwrite epoch 3!
      assert.throws(
        () =>
          savePendingCheckpointWithGeneration(sessionKey, 'Stale epoch 2 summary', {
            generation: 'cp-gen-epoch-2-late',
            placementEpoch: 2,
            baseDir,
          }),
        /CHECKPOINT_STALE_PLACEMENT_EPOCH/,
      )
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir)?.generation, 'cp-gen-epoch-3')

      // ingestVerifiedCrossPoolCheckpoint maps stale epoch to reason: 'stale_epoch' and emits NO receipt
      const lateFrame = makeWireFrame({
        generation: 'cp-gen-epoch-2-late',
        placementEpoch: 2,
      })
      const lateAuth = makeVerifiedAuthority({ placementEpoch: 2 })
      const receiptsOnLate: MigrationInstallReceiptFrame[] = []
      const lateFinalize = finalizeInboundCrossPoolMigration(
        lateFrame,
        lateAuth,
        sessionKey,
        (f) => receiptsOnLate.push(f),
        { baseDir, clientMessageId: 'cmid-late', dispatchContext: { dispatchId: 'd-late', attemptNo: 1 } },
      )
      assert.equal(lateFinalize.receiptSent, false)
      assert.deepEqual(lateFinalize.ingestResult, { accepted: false, reason: 'stale_epoch' })
      assert.equal(receiptsOnLate.length, 0)

      // Ack epoch 3 checkpoint -> generation is now consumed in durable watermark
      assert.equal(ackPendingCheckpoint(sessionKey, 'cp-gen-epoch-3', baseDir), true)
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir), null)

      // Replaying already-consumed generation MUST be rejected and NEVER recreate file!
      assert.throws(
        () =>
          savePendingCheckpointWithGeneration(sessionKey, 'Replayed epoch 3 summary', {
            generation: 'cp-gen-epoch-3',
            placementEpoch: 3,
            baseDir,
          }),
        /CHECKPOINT_GENERATION_ALREADY_CONSUMED/,
      )
      const replayFrame = makeWireFrame({
        generation: 'cp-gen-epoch-3',
        placementEpoch: 3,
      })
      const replayAuth = makeVerifiedAuthority({ placementEpoch: 3 })
      assert.deepEqual(
        ingestVerifiedCrossPoolCheckpoint(replayFrame, replayAuth, sessionKey, { baseDir }),
        {
          accepted: false,
          reason: 'already_consumed',
          generation: 'cp-gen-epoch-3',
          migrationId: 'mig-cross-pool-0001',
          placementEpoch: 3,
        },
      )
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir), null)

      // B1 R2: finalizeInboundCrossPoolMigration on already_consumed RE-EMITS migration_install_receipt
      // without recreating the pending checkpoint on disk (converges Master PG if original receipt was lost).
      const reemitReceipts: MigrationInstallReceiptFrame[] = []
      const reemitRes = finalizeInboundCrossPoolMigration(
        replayFrame,
        replayAuth,
        sessionKey,
        (f) => reemitReceipts.push(f),
        { baseDir, clientMessageId: 'cmid-reemit', dispatchContext: { dispatchId: 'd-reemit', attemptNo: 1 } },
      )
      assert.equal(reemitRes.receiptSent, true)
      assert.equal(reemitRes.fatalError, undefined)
      assert.equal(reemitReceipts.length, 1)
      assert.equal(reemitReceipts[0]!.checkpointGeneration, 'cp-gen-epoch-3')
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir), null)

      // W2 R2: Even if a stale checkpoint file survives a crash after watermark write,
      // peekPendingCheckpoint MUST ignore the already-consumed generation.
      writeFileSync(
        checkpointFilePath(sessionKey, baseDir),
        JSON.stringify({
          sessionKey,
          generation: 'cp-gen-epoch-3',
          summary: 'Orphaned stale file after crash',
          createdAt: Date.now(),
          placementEpoch: 3,
        }),
        'utf8',
      )
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir), null)

      // B1 R2: persist_failed MUST return fatalError so inboundDispatch aborts fail-closed without running!
      const failReceipts: MigrationInstallReceiptFrame[] = []
      const persistFailRes = finalizeInboundCrossPoolMigration(
        makeWireFrame({ generation: 'cp-gen-epoch-4-fail', placementEpoch: 4 }),
        makeVerifiedAuthority({ placementEpoch: 4 }),
        sessionKey,
        (f) => failReceipts.push(f),
        {
          baseDir,
          clientMessageId: 'cmid-fail',
          dispatchContext: { dispatchId: 'd-fail', attemptNo: 1 },
          saveCheckpoint: () => {
            throw new Error('ENOSPC')
          },
        },
      )
      assert.equal(persistFailRes.receiptSent, false)
      assert.equal(persistFailRes.fatalError, 'CROSS_POOL_CHECKPOINT_PERSIST_FAILED')
      assert.equal(failReceipts.length, 0)

      // Newer epoch 4 with fresh generation succeeds cleanly
      const recEpoch4 = savePendingCheckpointWithGeneration(sessionKey, 'Epoch 4 fresh summary', {
        generation: 'cp-gen-epoch-4',
        placementEpoch: 4,
        baseDir,
      })
      assert.equal(recEpoch4.placementEpoch, 4)
      assert.equal(peekPendingCheckpoint(sessionKey, baseDir)?.generation, 'cp-gen-epoch-4')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('B3 real SessionManager return-to-remote E2E: isolates local native resume ID on authorized migration, injects anchored_v2 checkpoint into remote runner, acks only after turn completes, and keeps unauthorized turns fail-closed', async () => {
    const sessionKey = `agent:main:webchat:dm:b3-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const operationId = '66666666-6666-4666-8666-666666666666'
    const remoteBackend: RemoteExecutionBackend = Object.freeze({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: 'cc',
      driverVersion: '5.0.0',
      engineId: 'cc',
      authorityEngine: 'ccb' as const,
      sessionKey,
      operationId,
      generation: '1',
      profileId: 'prof-b3-1',
      authEpoch: 'epoch-1',
    })

    // Unit check: remote -> local authorized migration isolates bound remote resume IDs
    assert.deepEqual(
      resolveMigrationAwareStoredResume({
        storedResumeId: `remotev4:${operationId}:native-r1`,
        executionBackend: undefined,
        hasAuthorizedMigration: true,
      }),
      { effectiveStoredResumeId: undefined, clearStaleResume: true },
    )
    assert.deepEqual(
      resolveMigrationAwareStoredResume({
        storedResumeId: `cc5-t1555u:${operationId}:${operationId}`,
        executionBackend: undefined,
        hasAuthorizedMigration: true,
      }),
      { effectiveStoredResumeId: undefined, clearStaleResume: true },
    )

    const capturedCreateOpts: EngineCreateOpts[] = []
    const capturedPrompts: Array<string | Array<{ type: string; [k: string]: unknown }>> = []
    let checkpointPresentDuringTurn = false

    class FakeRemoteV4Adapter extends EventEmitter implements EngineAdapter {
      readonly executionBackend?: RemoteExecutionBackend
      readonly engineId = 'ccb'
      readonly capabilities = {
        billingMode: 'proxy' as const,
        supportsEffort: true,
        resumeKind: 'ccb-session' as const,
        needsServerRequestId: false,
        historyMode: 'native-resume' as const,
        permissionModel: 'native' as const,
        emitsCallUsage: false,
        emitsToolInputDeltas: false,
        supportsNativeCompact: false,
        multimodalInput: 'native' as const,
      }
      nativeSessionId: string | null = null
      model: string | undefined
      effortLevel: string | undefined
      toolsets: string[] | undefined
      executionTarget: ExecutionTarget = { kind: 'local' }
      pendingToolCalls = 0
      isRunning = true
      lastActivityAt = Date.now()

      constructor(opts: EngineCreateOpts) {
        super()
        capturedCreateOpts.push(opts)
        this.executionBackend = opts.executionBackend
        this.model = opts.model
        this.nativeSessionId = opts.resumeSessionId ?? null
      }

      async start(): Promise<void> {}
      submitTurn(params: TurnParams): EngineTurnRun {
        capturedPrompts.push(params.input)
        checkpointPresentDuringTurn = peekPendingCheckpoint(sessionKey) !== null
        const replyText = '远端 runner 已收到锚定摘要并完成首轮。'
        const summaryPromise = (async () => {
          params.onEvent({
            kind: 'block',
            block: { kind: 'text', text: replyText },
          })
          params.onEvent({
            kind: 'final',
            meta: { stopReason: 'end_turn', turn: 1 },
          })
          return {
            usage: {
              cost: 0,
              inputTokens: 100,
              outputTokens: 32,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 132,
            },
            assistantText: replyText,
            thinkingText: '',
            assistantSegments: [{ index: 0, text: replyText, ts: Date.now() }],
            thinkingSegments: [],
            tools: [],
            runtimeEvents: [],
            stopReason: 'end_turn',
            numTurns: 1,
            isError: false,
            staleResumeId: false,
            phantomSignals: { apiState: 'called' as const, skipReason: null },
          }
        })()
        return {
          submitted: Promise.resolve(),
          summary: summaryPromise,
          end() {},
          getPartialSnapshot: () => ({
            assistantText: replyText,
            thinkingText: '',
            completedTools: [],
            assistantSegments: [],
            thinkingSegments: [],
            runtimeEvents: [],
          }),
          getPhantomSignals: () => ({ apiState: 'called' as const, skipReason: null }),
          finalized: true,
          pendingToolCalls: 0,
        }
      }
      interrupt(): boolean {
        return true
      }
      async shutdown(): Promise<void> {
        this.isRunning = false
      }
      async waitForOutputDrain(): Promise<void> {}
      clearSessionId(): void {
        this.nativeSessionId = null
      }
      setModel(model: string | undefined): void {
        this.model = model
      }
      setEffortLevel(level: string | undefined): void {
        this.effortLevel = level
      }
      setTraceId(): void {}
      async setGoalState(): Promise<void> {}
      updateConfig(): void {}
      setToolsets(toolsets: string[] | undefined): void {
        this.toolsets = toolsets
      }
      setExecutionTarget(target: ExecutionTarget): void {
        this.executionTarget = target
      }
      sendPermissionResponse(): boolean {
        return false
      }
      getPartialSnapshot() {
        return {
          assistantText: '',
          thinkingText: '',
          completedTools: [],
          assistantSegments: [],
          thinkingSegments: [],
          runtimeEvents: [],
        }
      }
      getBoundRepoBinding() {
        return null
      }
    }

    const sm = new SessionManager({
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: '' },
      defaults: { model: 'claude-opus-4-6' },
    } as unknown as OpenClaudeConfig)
    const internals = sm as unknown as {
      _resumeMap: Map<string, string>
      _resumeMapProvider: Map<string, string>
      _saveResumeMap: () => void
    }
    internals._saveResumeMap = () => {}
    internals._resumeMap.clear()
    internals._resumeMapProvider.clear()
    // Seed a real local native resume ID left behind after a local fallback turn!
    internals._resumeMap.set(sessionKey, 'local-codex-thread-1')
    internals._resumeMapProvider.set(sessionKey, 'ccb')

    registerRemoteDriverAdapter((opts) => new FakeRemoteV4Adapter(opts))
    setV3MasterSinkSingleton({
      persistOrQueue: async () => ({ ok: true }),
      attemptOnce: async () => {},
    })
    const agent = { id: 'main', model: 'claude-opus-4-6', cwd: process.cwd() } as AgentDef

    try {
      // Negative: ordinary turn WITHOUT poolMigration MUST still fail closed!
      await assert.rejects(
        () =>
          sm.getOrCreate({
            sessionKey,
            peerId: 'b3-peer',
            userId: '7',
            channel: 'webchat',
            agent,
            model: 'claude-opus-4-6-remote',
            executionAuthority: {
              source: 'bridge_signed',
              engine: 'ccb',
              canonicalModel: 'claude-opus-4-6-remote',
              executionBackend: remoteBackend,
            },
          }),
        /CC5_BACKEND_REQUIRES_NEW_SESSION|CC5_TEST_REMOTE_RESUME_UNSUPPORTED/,
      )
      // Also verify resolveMigrationAwareStoredResume directly throws on unauthorized turn
      assert.throws(
        () =>
          resolveMigrationAwareStoredResume({
            storedResumeId: 'local-codex-thread-1',
            executionBackend: remoteBackend,
            hasAuthorizedMigration: false,
          }),
        /CC5_TEST_REMOTE_RESUME_UNSUPPORTED/,
      )

      // Positive: authorized return-to-remote migration succeeds with real SessionManager.getOrCreate
      const poolMigration = {
        migrationId: 'mig-b3-return-0001',
        placementEpoch: 3,
        allowBackendTransition: true as const,
        continuityTier: 'tape_rebuilt' as const,
      }
      const session = await sm.getOrCreate({
        sessionKey,
        peerId: 'b3-peer',
        userId: '7',
        channel: 'webchat',
        agent,
        model: 'claude-opus-4-6-remote',
        executionAuthority: {
          source: 'bridge_signed',
          engine: 'ccb',
          canonicalModel: 'claude-opus-4-6-remote',
          executionBackend: remoteBackend,
        },
        ...(poolMigration ? { poolMigration } : {}),
      })
      assert.equal(capturedCreateOpts.length, 1)
      assert.equal(capturedCreateOpts[0]!.resumeSessionId, undefined)
      assert.equal(internals._resumeMap.has(sessionKey), false)

      // Ingest verified anchored_v2 checkpoint + emit install receipt (exact inboundDispatch order)
      const anchoredSummary =
        '## Cross-Pool Warm-Resume Checkpoint (anchored_v2)\n\n### First-Turn Goal\nPreserve B3 E2E context across return-to-remote.'
      const wireFrame = makeWireFrame({
        generation: 'cp-gen-b3-e2e-1',
        migrationId: poolMigration.migrationId,
        placementEpoch: poolMigration.placementEpoch,
        summary: anchoredSummary,
        sha256: sha256(anchoredSummary),
      })
      const receipts: MigrationInstallReceiptFrame[] = []
      const fin = finalizeInboundCrossPoolMigration(
        wireFrame,
        { poolMigration },
        sessionKey,
        (f) => receipts.push(f),
        {
          clientMessageId: 'cmid-b3-e2e-1',
          dispatchContext: { dispatchId: 'disp-b3-e2e-1', attemptNo: 1, clientMessageId: 'cmid-b3-e2e-1' },
        },
      )
      assert.equal(fin.receiptSent, true)
      assert.equal(receipts.length, 1)
      assert.equal(receipts[0]!.type, MIGRATION_INSTALL_RECEIPT_TYPE)
      assert.equal(receipts[0]!.checkpointGeneration, 'cp-gen-b3-e2e-1')
      assert.equal(peekPendingCheckpoint(sessionKey)?.generation, 'cp-gen-b3-e2e-1')

      // Submit real turn with matching signed modelAuthority -> remote runner receives anchored_v2
      // summary & checkpoint acks ONLY after turn succeeds
      await sm.submit(
        session,
        '请继续执行远端首轮任务',
        () => {},
        undefined,
        'claude-opus-4-6-remote',
        undefined,
        'trace-b3-e2e-1',
        undefined,
        {
          modelAuthority: {
            authorityEnvelope: 'test-authority-env',
            leaseEnvelope: 'test-lease-env',
            executionDescriptor: {
              canonicalModel: 'claude-opus-4-6-remote',
              engine: 'ccb',
              contextWindow: 200_000,
              supportsVision: true,
              supportedEfforts: ['medium'],
              executionBackend: remoteBackend,
              poolMigration,
            },
          } as never,
        },
      )

      assert.equal(capturedPrompts.length, 1)
      const firstPromptText =
        typeof capturedPrompts[0] === 'string'
          ? capturedPrompts[0]
          : JSON.stringify(capturedPrompts[0])
      assert.ok(firstPromptText.includes('anchored_v2'))
      assert.ok(firstPromptText.includes('Preserve B3 E2E context across return-to-remote.'))
      assert.equal(checkpointPresentDuringTurn, true)
      assert.equal(peekPendingCheckpoint(sessionKey), null)
    } finally {
      setV3MasterSinkSingleton(null)
      clearPendingCheckpoint(sessionKey)
      await sm.shutdownAll().catch(() => {})
    }
  })
})
