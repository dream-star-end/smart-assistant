import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { AuthorityStateRuntime } from '../turnAuthorityRuntime.js'
import { EngineCapsuleRuntime } from '../turnCapsuleRuntime.js'
import {
  exportSessionCapsuleOnSafeBoundary,
  prepareSessionAuthorityBeforeCreate,
} from '../sessionAuthorityHook.js'
import { probeResumeArtifactForCapsule } from '../engine/resumeArtifacts.js'
import {
  ANTIGRAVITY_PROMPT_STATE_ENGINE,
  readAntigravityPromptState,
  setAntigravityPromptStateObserver,
  writeAntigravityPromptState,
} from '../engine/antigravityPromptState.js'
import { CCB_RESUME_HISTORY_CONTEXT_VERSION, ResumeStore } from '../resumeStore.js'
import {
  enqueuePendingAuthorityAck,
  listPendingAuthorityAcks,
  listPendingAuthorityOps,
  peekPendingCheckpoint,
  savePendingCheckpoint,
  setLocalCheckpointSavedObserver,
} from '../sessionCheckpointStore.js'
import {
  CodedAuthorityRpcError,
  InMemoryArtifactBlobStore,
  InMemorySessionAuthorityStore,
} from '../storageSeam/index.js'

describe('OCV5-907 Wave 2 R1 Audit Regression Proofs (B1–B7 + W1/W5/W6)', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    setAntigravityPromptStateObserver(null)
    setLocalCheckpointSavedObserver(null)
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('B1 + B2: legacy cache without epoch fails closed (409 quarantine) against epoch 2 PG row and routine saves preserve remote_pool & pendingInstallMigration', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-907-b1b2-'))
    tempDirs.push(dir)

    const authority = new InMemorySessionAuthorityStore()
    const sk = 'agent:main:webchat:dm:b1b2'
    // Seed authoritative epoch 2 remote_pool pointer
    await authority.upsertPointer('c:3', {
      sessionKey: sk,
      placementEpoch: 2,
      poolKind: 'remote_pool',
      engine: 'codex',
      nativeSessionId: 'thr-new-epoch2',
      operationId: 'op-keep',
      profileId: 'prof-keep',
      capsuleId: 'cap-keep',
      history: [],
      rejectedIds: [],
      promptCacheMeta: { pendingInstallMigration: { migrationId: 'mig-12345678', placementEpoch: 2 } },
      usageBaseline: { totalCostUsd: 0.2, inputTokens: 9000 },
      historyContextVersion: null,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: new Date().toISOString(),
    })

    const resume = new ResumeStore(path.join(dir, 'resume-map.json'))
    resume.ids.set(sk, 'thr-stale-old-vol')
    resume.provider.set(sk, 'codex')
    const rt = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: resume,
      authorityStore: authority,
      checkpointBaseDir: path.join(dir, 'checkpoints'),
    })

    // Old volume has no knownEpoch -> write MUST fail closed & quarantine local stale head
    rt.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'thr-stale-old-vol', providerTag: 'codex' }])
    await rt.flush()

    assert.equal((await authority.getPointer('c:3', sk))?.nativeSessionId, 'thr-new-epoch2')
    assert.equal(resume.ids.has(sk), false, '409 conflict must quarantine stale local head')

    // Next hydrate pulls authoritative epoch 2 head
    const hyd = await rt.hydrateSessionIfMissing(sk)
    assert.equal(hyd.pointerHydrated, true)
    assert.equal(resume.ids.get(sk), 'thr-new-epoch2')

    // Routine save at known epoch 2 updates cost/head while preserving poolKind & pendingInstallMigration
    rt.syncResumeSnapshots([
      { sessionKey: sk, nativeSessionId: 'thr-new-epoch2', providerTag: 'codex', lastCost: 0.9 },
    ])
    await rt.flush()
    const after = (await authority.getPointer('c:3', sk))!
    assert.equal(after.poolKind, 'remote_pool')
    assert.equal(after.operationId, 'op-keep')
    assert.deepEqual(after.promptCacheMeta, {
      pendingInstallMigration: { migrationId: 'mig-12345678', placementEpoch: 2 },
    })
    assert.deepEqual(after.usageBaseline, { totalCostUsd: 0.9, inputTokens: 9000 })
  })

  it('B3: A -> B -> A rapid sequence under delayed writes converges to A in both local ResumeStore and authority without stale writeback', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-907-b3-'))
    tempDirs.push(dir)

    const baseStore = new InMemorySessionAuthorityStore()
    let delayMs = 0
    const delayedStore: typeof baseStore = Object.assign(Object.create(baseStore), {
      async upsertPointer(...args: Parameters<typeof baseStore.upsertPointer>) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        return baseStore.upsertPointer(...args)
      },
      getPointer: baseStore.getPointer.bind(baseStore),
      getEpoch: baseStore.getEpoch.bind(baseStore),
      getLatestCheckpoint: baseStore.getLatestCheckpoint.bind(baseStore),
      saveCheckpoint: baseStore.saveCheckpoint.bind(baseStore),
      ackCheckpoint: baseStore.ackCheckpoint.bind(baseStore),
    })

    const sk = 'agent:main:webchat:dm:aba'
    const resume = new ResumeStore(path.join(dir, 'resume-map.json'))
    const rt = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: resume,
      authorityStore: delayedStore,
    })

    // 1. Save A and flush
    resume.ids.set(sk, 'id-A')
    resume.provider.set(sk, 'codex')
    rt.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'id-A', providerTag: 'codex' }])
    await rt.flush()
    assert.equal((await baseStore.getPointer('c:3', sk))?.nativeSessionId, 'id-A')

    // 2. Now delay writes and fire B then A back-to-back without awaiting
    delayMs = 40
    resume.ids.set(sk, 'id-B')
    rt.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'id-B', providerTag: 'codex' }])
    await new Promise((r) => setTimeout(r, 10))
    resume.ids.set(sk, 'id-A')
    rt.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'id-A', providerTag: 'codex' }])

    await rt.flush()
    assert.equal(resume.ids.get(sk), 'id-A', 'local store must remain id-A (no stale B overwrite)')
    assert.equal(
      (await baseStore.getPointer('c:3', sk))?.nativeSessionId,
      'id-A',
      'authoritative store must converge to id-A after A -> B -> A',
    )
  })

  it('B4 + B6 + W1 + W5: explicit reset tombstone blocks resurrection, local compact writes through, cross-epoch checkpoint ignored, failed ack retries durably, and AG promptState restores silently', async () => {
    const dirA = mkdtempSync(path.join(tmpdir(), 'ocv5-907-b4a-'))
    const dirB = mkdtempSync(path.join(tmpdir(), 'ocv5-907-b4b-'))
    tempDirs.push(dirA, dirB)

    const authority = new InMemorySessionAuthorityStore()
    const sk = 'agent:main:webchat:dm:b4b6'
    const resumeA = new ResumeStore(path.join(dirA, 'resume-map.json'))
    const ckptA = path.join(dirA, 'checkpoints')
    const agyA = path.join(dirA, 'agy')
    const rtA = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: resumeA,
      authorityStore: authority,
      checkpointBaseDir: ckptA,
      antigravityRootDir: agyA,
    })

    // Seed initial head
    resumeA.ids.set(sk, 'grok-bad-1')
    resumeA.provider.set(sk, 'grok')
    rtA.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'grok-bad-1', providerTag: 'grok' }])
    await rtA.flush()

    // B4: Explicit reset + local compaction checkpoint write-through
    setLocalCheckpointSavedObserver((rec) => {
      void rtA.syncLocalCheckpointWriteThrough(rec, 'grok')
    })
    savePendingCheckpoint(sk, 'Compacted summary after reset', { baseDir: ckptA })
    resumeA.forget(sk)
    rtA.syncResumeReset(sk, 'grok')

    // Same-turn hydrate MUST NOT resurrect grok-bad-1
    const sameTurnHyd = await rtA.hydrateSessionIfMissing(sk)
    assert.equal(sameTurnHyd.pointerHydrated, false)
    assert.equal(resumeA.ids.has(sk), false)
    await rtA.flush()
    assert.equal((await authority.getPointer('c:3', sk))?.nativeSessionId, null)
    const cpAuth = await authority.getLatestCheckpoint('c:3', sk)
    assert.equal(cpAuth?.summary, 'Compacted summary after reset')

    // B6: Bump pointer to epoch 2 -> epoch 1 unacked checkpoint MUST NOT hydrate on container B
    const curPtr = (await authority.getPointer('c:3', sk))!
    await authority.upsertPointer('c:3', {
      ...curPtr,
      placementEpoch: 2,
      engine: 'antigravity',
      nativeSessionId: '11111111-2222-3333-4444-555555555555',
      promptCacheMeta: {
        promptState: {
          v: 1,
          sessionKey: sk,
          conversationId: '11111111-2222-3333-4444-555555555555',
          inputsKey: 'c'.repeat(64),
          injectedAfterBaseline: 5,
          updatedAt: Date.now(),
        },
      },
    })

    const resumeB = new ResumeStore(path.join(dirB, 'resume-map.json'))
    const ckptB = path.join(dirB, 'checkpoints')
    const agyB = path.join(dirB, 'agy')
    let observerCalls = 0
    setAntigravityPromptStateObserver(() => {
      observerCalls += 1
    })

    const rtB = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: resumeB,
      authorityStore: authority,
      checkpointBaseDir: ckptB,
      antigravityRootDir: agyB,
    })
    const hydB = await rtB.hydrateSessionIfMissing(sk)
    assert.equal(hydB.pointerHydrated, true)
    assert.equal(hydB.checkpointHydrated, false, 'epoch 1 checkpoint must not leak into epoch 2')
    assert.equal(hydB.promptStateHydrated, true)
    assert.equal(observerCalls, 0, 'silent AG prompt-state restore must not trigger writeback observer')
    assert.equal(
      readAntigravityPromptState(agyB, sk)?.conversationId,
      '11111111-2222-3333-4444-555555555555',
    )

    // W1: Failed ack persists to pending-authority-acks.json and replays when master recovers
    await authority.saveCheckpoint('c:3', {
      sessionKey: sk,
      sessionId: 'b4b6',
      checkpointGeneration: 'cp-e2-retry',
      placementEpoch: 2,
      mode: 'anchored_v2',
      anchorSeq: 9,
      sourceEngine: 'antigravity',
      summary: 'Epoch 2 summary',
      ackedByTurnKey: null,
      ackedAt: null,
      createdAt: new Date().toISOString(),
    })
    let failAck = true
    const flakyStore: typeof authority = Object.assign(Object.create(authority), {
      async ackCheckpoint(...args: Parameters<typeof authority.ackCheckpoint>) {
        if (failAck) throw new Error('ECONNRESET')
        return authority.ackCheckpoint(...args)
      },
      getPointer: authority.getPointer.bind(authority),
      getEpoch: authority.getEpoch.bind(authority),
      upsertPointer: authority.upsertPointer.bind(authority),
      getLatestCheckpoint: authority.getLatestCheckpoint.bind(authority),
      saveCheckpoint: authority.saveCheckpoint.bind(authority),
    })
    const rtRetry = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: resumeB,
      authorityStore: flakyStore,
      checkpointBaseDir: ckptB,
      antigravityRootDir: agyB,
    })
    await rtRetry.ackCheckpointWriteThrough(sk, 'cp-e2-retry', 'turn-retry-1')
    assert.equal(listPendingAuthorityAcks(ckptB).length, 1)

    failAck = false
    await rtRetry.replayPendingAcks()
    assert.equal(listPendingAuthorityAcks(ckptB).length, 0)
    assert.equal((await authority.getLatestCheckpoint('c:3', sk))?.ackedByTurnKey, 'turn-retry-1')

    // W5: Obsolete CCB historyContextVersion is NOT revived
    const skOldCcb = 'agent:main:webchat:dm:old-ccb'
    await authority.upsertPointer('c:3', {
      sessionKey: skOldCcb,
      placementEpoch: 1,
      poolKind: 'local_container',
      engine: 'ccb',
      nativeSessionId: 'old-ccb-id',
      history: [],
      rejectedIds: [],
      promptCacheMeta: null,
      usageBaseline: null,
      historyContextVersion: null,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: new Date().toISOString(),
    })
    const hydOld = await rtB.hydrateSessionIfMissing(skOldCcb)
    assert.equal(hydOld.pointerHydrated, false)
    assert.equal(resumeB.ids.has(skOldCcb), false)
  })

  it('B5 + B7 + W6: pre-create hook hydrates & rebinds prewarmed runner, restores valid capsule, degrades corrupt capsule to tape_rebuilt, and negative-caches legacy Master 404', async () => {
    const dirA = mkdtempSync(path.join(tmpdir(), 'ocv5-907-b5a-'))
    const dirB = mkdtempSync(path.join(tmpdir(), 'ocv5-907-b5b-'))
    tempDirs.push(dirA, dirB)

    const authority = new InMemorySessionAuthorityStore()
    const blobStore = new InMemoryArtifactBlobStore()
    const sk = 'agent:main:webchat:dm:cap-precreate'
    const nativeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    const resumeA = new ResumeStore(path.join(dirA, 'resume-map.json'))
    const authA = new AuthorityStateRuntime({ tenantId: 'c:3', resumeStore: resumeA, authorityStore: authority })
    const capA = new EngineCapsuleRuntime({
      tenantId: 'c:3',
      stateRoot: path.join(dirA, 'capsule-state'),
      blobStore,
      authorityRuntime: authA,
    })

    // Seed CCB native file + export capsule
    const srcRoot = path.join(dirA, 'claude-src')
    const projDir = path.join(srcRoot, 'projects', '-workspace-old')
    mkdirSync(projDir, { recursive: true })
    const jsonl = '{"type":"user","message":"capsule-precreate-test"}\n'
    writeFileSync(path.join(projDir, `${nativeId}.jsonl`), jsonl, 'utf8')

    // Ensure CCB pointer has current historyContextVersion so W5 allows revival
    await authority.upsertPointer('c:3', {
      sessionKey: sk,
      placementEpoch: 1,
      poolKind: 'local_container',
      engine: 'ccb',
      nativeSessionId: nativeId,
      history: [],
      rejectedIds: [],
      promptCacheMeta: null,
      usageBaseline: null,
      historyContextVersion: CCB_RESUME_HISTORY_CONTEXT_VERSION,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: new Date().toISOString(),
    })

    const exp = await capA.exportSessionCapsuleToAuthority({
      sessionKey: sk,
      engine: 'ccb',
      engineVersion: '2.1.332',
      placementEpoch: 1,
      nativeSessionId: nativeId,
      sourceRoot: srcRoot,
      sourceCwd: '/workspace/old',
    })
    assert.ok(exp && exp.authorityUpdated)

    // Container B runs prepareSessionAuthorityBeforeCreate with an idle prewarmed runner
    const resumeB = new ResumeStore(path.join(dirB, 'resume-map.json'))
    const ckptB = path.join(dirB, 'checkpoints')
    const authB = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: resumeB,
      authorityStore: authority,
      checkpointBaseDir: ckptB,
    })
    const capB = new EngineCapsuleRuntime({
      tenantId: 'c:3',
      stateRoot: path.join(dirB, 'capsule-state'),
      blobStore,
      authorityRuntime: authB,
    })

    // 1. Corrupt blob in CAS -> prepareSessionAuthorityBeforeCreate MUST degrade cleanly
    //    and clear native head while keeping authoritative checkpoint for tape_rebuilt!
    await authority.saveCheckpoint('c:3', {
      sessionKey: sk,
      sessionId: 'cap-precreate',
      checkpointGeneration: 'cp-fallback-tape',
      placementEpoch: 1,
      mode: 'anchored_v2',
      anchorSeq: 2,
      sourceEngine: 'ccb',
      summary: 'Fallback tape_rebuilt summary when capsule corrupt',
      ackedByTurnKey: null,
      ackedAt: null,
      createdAt: new Date().toISOString(),
    })
    const fileBlobRef = Object.values(exp.exported.blobRefs)[0]!
    blobStore.corruptBlobBytesForTest('c:3', fileBlobRef.blobId, new Uint8Array([0, 1, 2]))

    let reboundId: string | null = null
    await prepareSessionAuthorityBeforeCreate({
      authorityRuntime: authB,
      capsuleRuntime: capB,
      resumeStore: resumeB,
      sessionKey: sk,
      engine: 'ccb',
      workspaceCwd: '/workspace/new',
      existingSession: {
        ccbSessionId: null,
        runner: {
          setResumeSessionId: (id) => {
            reboundId = id
          },
        },
      },
    })
    assert.equal(resumeB.ids.has(sk), false, 'corrupt capsule must clear unusable native head')
    assert.equal(reboundId, null, 'runner must not bind corrupt native head')
    assert.equal(
      peekPendingCheckpoint(sk, ckptB)?.generation,
      'cp-fallback-tape',
      'tape_rebuilt checkpoint must remain ready for fallback',
    )

    // 2. W6: Legacy Master 404 negative-caches remote calls
    let callCount = 0
    const legacy404Store: typeof authority = Object.assign(Object.create(authority), {
      async getPointer() {
        callCount += 1
        throw new CodedAuthorityRpcError('NOT_FOUND', 404, 'not found')
      },
    })
    const rtLegacy = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: new ResumeStore(path.join(dirB, 'legacy-resume.json')),
      authorityStore: legacy404Store,
    })
    await rtLegacy.hydrateSessionIfMissing('s-legacy-1')
    assert.equal(rtLegacy.isRemoteEnabled, false)
    await rtLegacy.hydrateSessionIfMissing('s-legacy-2')
    assert.equal(callCount, 1, 'second call must be short-circuited by 404 negative cache')

    // 3. Valid direct capsule round-trip with silent prompt-state check
    const goodBlobStore = new InMemoryArtifactBlobStore()
    const capGood = new EngineCapsuleRuntime({
      tenantId: 'c:3',
      stateRoot: path.join(dirB, 'cap-good'),
      blobStore: goodBlobStore,
      authorityRuntime: authA,
    })
    const expGood = await capGood.exportSessionCapsuleToAuthority({
      sessionKey: sk,
      engine: 'ccb',
      engineVersion: '2.1.332',
      placementEpoch: 1,
      nativeSessionId: nativeId,
      sourceRoot: srcRoot,
      sourceCwd: '/workspace/old',
    })
    assert.ok(expGood)
    const targetGood = path.join(dirB, 'claude-good-dst')
    const impGood = await capGood.importSessionCapsuleFromAuthority({
      sessionKey: sk,
      engine: 'ccb',
      targetRoot: targetGood,
      targetEngineVersion: '2.1.332',
      targetCwd: '/workspace/new',
    })
    assert.equal(impGood?.status, 'imported')
    assert.equal(
      readFileSync(path.join(targetGood, 'projects', '-workspace-new', `${nativeId}.jsonl`), 'utf8'),
      jsonl,
    )
    writeAntigravityPromptState(path.join(dirB, 'agy-noop'), {
      v: 1,
      sessionKey: sk,
      conversationId: '22222222-3333-4444-5555-666666666666',
      inputsKey: 'd'.repeat(64),
      injectedAfterBaseline: 1,
      updatedAt: Date.now(),
    })
    assert.equal(ANTIGRAVITY_PROMPT_STATE_ENGINE, 'antigravity')
  })

  it('R2-B1: hydrate-then-save on legacy volume NEVER borrows observed epoch 2 to overwrite Master; 409 quarantines runner & blocks racing re-save', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-907-r2-b1-'))
    tempDirs.push(dir)
    const authority = new InMemorySessionAuthorityStore()
    const sk = 'agent:main:webchat:dm:r2-b1'
    await authority.upsertPointer('c:3', {
      sessionKey: sk,
      placementEpoch: 2,
      poolKind: 'remote_pool',
      engine: 'codex',
      nativeSessionId: 'current-head-e2',
      operationId: 'op-remote-2',
      profileId: 'prof-2',
      capsuleId: null,
      history: [],
      rejectedIds: [],
      promptCacheMeta: { pendingInstallMigration: 'mig-99' },
      usageBaseline: { totalCostUsd: 3.2 },
      historyContextVersion: null,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: new Date().toISOString(),
    })

    const resumeStore = new ResumeStore(path.join(dir, 'resume-map.json'))
    resumeStore.ids.set(sk, 'legacy-head-e1')
    resumeStore.provider.set(sk, 'codex')
    const quarantinedSessions: string[] = []
    const rt = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore,
      authorityStore: authority,
      checkpointBaseDir: path.join(dir, 'ckpts'),
      onConflictQuarantine: (key) => quarantinedSessions.push(key),
    })

    // Exact R2 sequence: hydrate FIRST (observing epoch 2), then save legacy-head-e1!
    await rt.hydrateSessionIfMissing(sk)
    assert.equal(rt.getObservedAuthorityEpoch(sk), 2)
    assert.equal(rt.getOwnedHeadEpoch(sk), undefined, 'GET must NOT grant owned provenance to legacy head')

    rt.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'legacy-head-e1', providerTag: 'codex' }])
    await rt.flush()

    assert.equal(resumeStore.ids.has(sk), false, '409 must quarantine legacy head from local ResumeStore')
    assert.deepEqual(quarantinedSessions, [sk], '409 must invoke onConflictQuarantine to unbind live runner')
    assert.equal(
      (await authority.getPointer('c:3', sk))?.nativeSessionId,
      'current-head-e2',
      'Master current-head-e2 must remain untouched',
    )

    // Racing re-save of the same quarantined head must be ignored
    rt.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'legacy-head-e1', providerTag: 'codex' }])
    await rt.flush()
    assert.equal((await authority.getPointer('c:3', sk))?.nativeSessionId, 'current-head-e2')
  })

  it('R2-B3: first-create A followed immediately by B (or reset) before A ACKs inherits created epoch without self-409', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-907-r2-b3-'))
    tempDirs.push(dir)
    const authority = new InMemorySessionAuthorityStore()
    let releaseFirst!: () => void
    let firstHeld = false
    const delayedStore: typeof authority = Object.assign(Object.create(authority), {
      async upsertPointer(tenantId: string, pointer: any, expectedEpoch?: number) {
        if (!firstHeld && pointer.nativeSessionId === 'head-A') {
          firstHeld = true
          await new Promise<void>((r) => {
            releaseFirst = r
          })
        }
        return authority.upsertPointer(tenantId, pointer, expectedEpoch)
      },
    })

    const sk = 'agent:main:webchat:dm:r2-b3'
    const resumeStore = new ResumeStore(path.join(dir, 'resume-map.json'))
    const rt = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore,
      authorityStore: delayedStore,
      checkpointBaseDir: path.join(dir, 'ckpts'),
    })

    // Queue A on empty authority, then queue B BEFORE A resolves
    resumeStore.ids.set(sk, 'head-A')
    rt.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'head-A', providerTag: 'codex' }])
    await new Promise((r) => setTimeout(r, 15))
    resumeStore.ids.set(sk, 'head-B')
    rt.syncResumeSnapshots([{ sessionKey: sk, nativeSessionId: 'head-B', providerTag: 'codex' }])
    releaseFirst()
    await rt.flush()

    assert.equal(resumeStore.ids.get(sk), 'head-B', 'local B must NOT be self-quarantined')
    assert.equal((await authority.getPointer('c:3', sk))?.nativeSessionId, 'head-B', 'Master must converge to B')

    // Second brand-new session: create A then immediate reset before A ACKs
    const sk2 = 'agent:main:webchat:dm:r2-b3-reset'
    firstHeld = false
    resumeStore.ids.set(sk2, 'head-A')
    rt.syncResumeSnapshots([{ sessionKey: sk2, nativeSessionId: 'head-A', providerTag: 'codex' }])
    await new Promise((r) => setTimeout(r, 15))
    resumeStore.forget(sk2)
    rt.syncResumeReset(sk2, 'codex')
    releaseFirst()
    await rt.flush()

    assert.equal((await authority.getPointer('c:3', sk2))?.nativeSessionId, null, 'Master must apply chained reset cleanly')
  })

  it('R2-B4: transient reset failure replays durably and compact reset defers until checkpoint summary is confirmed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-907-r2-b4-'))
    tempDirs.push(dir)
    const ckptDir = path.join(dir, 'ckpts')
    const authority = new InMemorySessionAuthorityStore()
    const sk = 'agent:main:webchat:dm:r2-b4'
    await authority.upsertPointer('c:3', {
      sessionKey: sk,
      placementEpoch: 1,
      poolKind: 'local_container',
      engine: 'codex',
      nativeSessionId: 'head-before-compact',
      operationId: null,
      profileId: null,
      capsuleId: null,
      history: [],
      rejectedIds: [],
      promptCacheMeta: null,
      usageBaseline: null,
      historyContextVersion: null,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: new Date().toISOString(),
    })

    let failCheckpoints = true
    const flakyStore: typeof authority = Object.assign(Object.create(authority), {
      async saveCheckpoint(tenantId: string, cp: any) {
        if (failCheckpoints) throw new Error('ECONNREFUSED')
        return authority.saveCheckpoint(tenantId, cp)
      },
    })

    const resumeStore = new ResumeStore(path.join(dir, 'resume-map.json'))
    const rt = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore,
      authorityStore: flakyStore,
      checkpointBaseDir: ckptDir,
    })
    rt.recordOwnedEpoch(sk, 1)
    setLocalCheckpointSavedObserver((rec) => {
      void rt.syncLocalCheckpointWriteThrough(rec, 'codex')
    })

    // Compact sequence: save local checkpoint (fails transiently) -> immediate reset
    savePendingCheckpoint(sk, 'Compacted durable summary', { baseDir: ckptDir })
    rt.syncResumeReset(sk, 'codex')
    await rt.flush()

    // Because checkpoint failed transiently, Master MUST NOT have cleared head yet!
    assert.equal(
      (await authority.getPointer('c:3', sk))?.nativeSessionId,
      'head-before-compact',
      'Master head must not be cleared before compact summary is confirmed',
    )
    assert.equal(listPendingAuthorityOps(ckptDir).length, 2, 'both checkpoint and reset ops must remain durable on disk')

    // Network recovers -> hydrate replays checkpoint FIRST, then reset!
    failCheckpoints = false
    await rt.hydrateSessionIfMissing(sk)
    assert.equal(listPendingAuthorityOps(ckptDir).length, 0, 'durable ops cleared after ordered replay')
    assert.equal((await authority.getPointer('c:3', sk))?.nativeSessionId, null, 'reset confirmed after summary')
    assert.equal((await authority.getLatestCheckpoint('c:3', sk))?.summary, 'Compacted durable summary')
  })

  it('R2-B5 + R2-B6 + R2-W1: prewarmed live runner shuts down & seeds cost baseline; higher grant invalidates stale epoch 1 read; unrelated session never waits on another session failed acks', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-907-r2-b5b6w1-'))
    tempDirs.push(dir)
    const ckptDir = path.join(dir, 'ckpts')
    const authority = new InMemorySessionAuthorityStore()
    const skA = 'agent:main:webchat:dm:r2-session-a'
    const skB = 'agent:main:webchat:dm:r2-session-b'

    await authority.upsertPointer('c:3', {
      sessionKey: skA,
      placementEpoch: 1,
      poolKind: 'local_container',
      engine: 'ccb',
      nativeSessionId: '11111111-1111-4111-8111-111111111111',
      operationId: null,
      profileId: null,
      capsuleId: null,
      history: [],
      rejectedIds: [],
      promptCacheMeta: null,
      usageBaseline: { totalCostUsd: 4.75 },
      historyContextVersion: CCB_RESUME_HISTORY_CONTEXT_VERSION,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: new Date().toISOString(),
    })
    await authority.saveCheckpoint('c:3', {
      sessionKey: skA,
      sessionId: 'r2-session-a',
      checkpointGeneration: 'cp-stale-e1',
      placementEpoch: 1,
      mode: 'anchored_v2',
      anchorSeq: 1,
      sourceEngine: 'ccb',
      summary: 'Old epoch 1 summary',
      ackedByTurnKey: null,
      ackedAt: null,
      createdAt: new Date().toISOString(),
    })

    // W1: Enqueue 3 failing acks for unrelated session B
    enqueuePendingAuthorityAck({ sessionKey: skB, generation: 'b-1', turnKey: 't1', createdAt: 1 }, ckptDir)
    enqueuePendingAuthorityAck({ sessionKey: skB, generation: 'b-2', turnKey: 't2', createdAt: 2 }, ckptDir)
    enqueuePendingAuthorityAck({ sessionKey: skB, generation: 'b-3', turnKey: 't3', createdAt: 3 }, ckptDir)

    const callOrder: string[] = []
    let releaseHungAck!: () => void
    const trackedStore: typeof authority = Object.assign(Object.create(authority), {
      async ackCheckpoint(tenantId: string, sessionKey: string, gen: string, turnKey: string) {
        callOrder.push(`ack:${sessionKey}:${gen}`)
        if (sessionKey === skB) {
          await new Promise<void>((r) => {
            releaseHungAck = r
          })
          throw new Error('ETIMEDOUT')
        }
        return authority.ackCheckpoint(tenantId, sessionKey, gen, turnKey)
      },
      async getPointer(tenantId: string, sessionKey: string) {
        callOrder.push(`getPointer:${sessionKey}`)
        return authority.getPointer(tenantId, sessionKey)
      },
    })

    const resumeStore = new ResumeStore(path.join(dir, 'resume-map.json'))
    const rt = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore,
      authorityStore: trackedStore,
      checkpointBaseDir: ckptDir,
    })

    // B5: Prewarmed cold running process must shutdown BEFORE setResumeSessionId and seed cost baseline
    const runnerEvents: string[] = []
    const prewarmedSession = {
      ccbSessionId: null as string | null,
      _lastCcbCumulativeCost: 0,
      runner: {
        isRunning: true,
        shutdown: async () => {
          runnerEvents.push('shutdown')
          prewarmedSession.runner.isRunning = false
        },
        setResumeSessionId: (id: string) => {
          runnerEvents.push(`setResume:${id}`)
        },
      },
    }

    await prepareSessionAuthorityBeforeCreate({
      authorityRuntime: rt,
      capsuleRuntime: undefined,
      resumeStore,
      sessionKey: skA,
      engine: 'ccb',
      existingSession: prewarmedSession,
    })

    assert.equal(callOrder[0], `getPointer:${skA}`, 'W1: session A hydrate must NOT wait for unrelated session B acks')
    releaseHungAck?.()
    assert.deepEqual(
      runnerEvents,
      ['shutdown', 'setResume:11111111-1111-4111-8111-111111111111'],
      'B5: cold prewarmed runner must shut down before rebinding resume ID',
    )
    assert.equal(prewarmedSession.ccbSessionId, '11111111-1111-4111-8111-111111111111')
    assert.equal(prewarmedSession._lastCcbCumulativeCost, 4.75, 'B5: cost baseline must be seeded on prewarmed session')

    // B6: Higher verified grant arriving while epoch 1 GET is in-flight prevents epoch 1 checkpoint install
    const dirB6 = mkdtempSync(path.join(tmpdir(), 'ocv5-907-r2-b6-'))
    tempDirs.push(dirB6)
    const ckptB6 = path.join(dirB6, 'ckpts')
    let releaseGet!: () => void
    const slowGetStore: typeof authority = Object.assign(Object.create(authority), {
      async getPointer(tenantId: string, sessionKey: string) {
        await new Promise<void>((r) => {
          releaseGet = r
        })
        return authority.getPointer(tenantId, sessionKey)
      },
    })
    const rtB6 = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: new ResumeStore(path.join(dirB6, 'resume.json')),
      authorityStore: slowGetStore,
      checkpointBaseDir: ckptB6,
    })
    const hydratePromise = rtB6.hydrateSessionIfMissing(skA)
    await new Promise((r) => setTimeout(r, 15))
    // Verified grant bumps observed epoch to 2 mid-flight!
    rtB6.recordKnownEpoch(skA, 2)
    releaseGet()
    const resB6 = await hydratePromise
    assert.equal(resB6.checkpointHydrated, false)
    assert.equal(peekPendingCheckpoint(skA, ckptB6), null, 'B6: epoch 1 checkpoint must NEVER be installed when epoch 2 grant is active')
  })

  it('R2-B7: source boundary export + clean Codex volume (no sessions/ dir) restores to real CODEX_HOME and verifies transcript visibility', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-907-r2-b7-'))
    tempDirs.push(dir)
    const authority = new InMemorySessionAuthorityStore()
    const blobStore = new InMemoryArtifactBlobStore()
    const sk = 'agent:main:webchat:dm:r2-b7-codex'
    const threadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

    // Source volume with real CODEX_HOME rollout layout
    const srcCodexHome = path.join(dir, 'src-codex-home')
    const rolloutDir = path.join(srcCodexHome, 'sessions', '2026', '11', '27')
    mkdirSync(rolloutDir, { recursive: true })
    const rolloutPath = path.join(rolloutDir, `rollout-20261127T010000Z-${threadId}.jsonl`)
    writeFileSync(rolloutPath, '{"type":"session_meta","id":"test"}\n', 'utf8')

    await authority.upsertPointer('c:3', {
      sessionKey: sk,
      placementEpoch: 1,
      poolKind: 'local_container',
      engine: 'codex',
      nativeSessionId: threadId,
      operationId: null,
      profileId: null,
      capsuleId: null,
      history: [],
      rejectedIds: [],
      promptCacheMeta: null,
      usageBaseline: null,
      historyContextVersion: null,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: new Date().toISOString(),
    })

    const authSrc = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: new ResumeStore(path.join(dir, 'src-resume.json')),
      authorityStore: authority,
    })
    authSrc.recordOwnedEpoch(sk, 1)
    const capSrc = new EngineCapsuleRuntime({
      tenantId: 'c:3',
      stateRoot: path.join(dir, 'src-cap'),
      blobStore,
      authorityRuntime: authSrc,
    })

    // 1. Source-side production boundary publisher
    const exported = await exportSessionCapsuleOnSafeBoundary({
      capsuleRuntime: capSrc,
      sessionKey: sk,
      engine: 'codex',
      nativeSessionId: threadId,
      artifactContext: { codexHome: srcCodexHome },
    })
    assert.equal(exported, true, 'source boundary export must succeed and update Master capsuleId')
    assert.ok((await authority.getPointer('c:3', sk))?.capsuleId, 'Master pointer must carry capsuleId')

    // 2. Target volume: BRAND-NEW clean CODEX_HOME (sessions/ does NOT even exist yet!)
    const dstCodexHome = path.join(dir, 'dst-codex-home-clean')
    assert.equal(
      probeResumeArtifactForCapsule('codex', threadId, { codexHome: dstCodexHome }),
      'missing',
      'clean volume without sessions/ must report missing (not unknown/exists)',
    )

    const dstResume = new ResumeStore(path.join(dir, 'dst-resume.json'))
    const authDst = new AuthorityStateRuntime({
      tenantId: 'c:3',
      resumeStore: dstResume,
      authorityStore: authority,
      checkpointBaseDir: path.join(dir, 'dst-ckpts'),
    })
    const capDst = new EngineCapsuleRuntime({
      tenantId: 'c:3',
      stateRoot: path.join(dir, 'dst-cap'),
      blobStore,
      authorityRuntime: authDst,
    })

    await prepareSessionAuthorityBeforeCreate({
      authorityRuntime: authDst,
      capsuleRuntime: capDst,
      resumeStore: dstResume,
      sessionKey: sk,
      engine: 'codex',
      artifactContext: { codexHome: dstCodexHome },
    })

    assert.equal(dstResume.ids.get(sk), threadId, 'hydrated native head preserved after successful capsule restore')
    assert.equal(
      probeResumeArtifactForCapsule('codex', threadId, { codexHome: dstCodexHome }),
      'present',
      'restored Codex rollout must be visible at actual CODEX_HOME root',
    )
  })
})
