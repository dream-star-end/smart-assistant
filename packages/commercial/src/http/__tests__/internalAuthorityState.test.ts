import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { AUTHORITY_STATE_INTERNAL_PREFIX } from '@openclaude/protocol'
import type { SessionEnginePointer } from '@openclaude/protocol/storage-seam'
import {
  makeInternalAuthorityStateHandler,
  type InternalAuthorityStatePatchers,
} from '../internalAuthorityState.js'
import type { PgSessionAuthorityStateStore } from '../../db/threeLayerStateStore.js'

class FakeAuthorityStateStore {
  readonly pointers = new Map<string, SessionEnginePointer>()
  readonly checkpoints = new Map<
    string,
    Array<{
      sessionKey: string
      sessionId: string
      checkpointGeneration: string
      placementEpoch: number
      mode: 'anchored_v2' | 'native_handoff'
      anchorSeq: number
      sourceEngine: 'ccb' | 'codex' | 'antigravity' | 'grok' | 'cursor' | 'zcode'
      summary: string
      instructions?: string | null
      ackedByTurnKey: string | null
      ackedAt: string | null
      createdAt: string
    }>
  >()

  private key(userId: number | bigint, sessionKey: string): string {
    return `${userId.toString()}::${sessionKey}`
  }

  async getEnginePointer(
    userId: number | bigint,
    sessionKey: string,
  ): Promise<SessionEnginePointer | null> {
    return this.pointers.get(this.key(userId, sessionKey)) ?? null
  }

  makePatchers(): InternalAuthorityStatePatchers {
    return {
      patchResume: async (input) => {
        const k = this.key(input.userId, input.sessionKey)
        const cur = this.pointers.get(k)
        if (cur?.migrationState === 'migrating') throw new Error('SESSION_PLACEMENT_MIGRATING')
        if (cur) {
          if (input.createIfAbsentOnly) {
            if (cur.engine !== input.engine || cur.nativeSessionId !== input.nativeSessionId) {
              throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
            }
            return cur
          }
          if (cur.placementEpoch !== input.expectedPlacementEpoch) {
            throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
          }
        } else if (
          input.expectedPlacementEpoch !== undefined &&
          input.expectedPlacementEpoch !== 1
        ) {
          throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
        }
        const nowIso = new Date().toISOString()
        // Narrow patch: preserves poolKind, operationId, profileId, capsuleId, promptCacheMeta, non-cost usageBaseline
        const nextUsage =
          input.totalCostUsd !== undefined
            ? { ...(cur?.usageBaseline ?? {}), totalCostUsd: input.totalCostUsd }
            : (cur?.usageBaseline ?? null)
        const next: SessionEnginePointer = {
          sessionKey: input.sessionKey,
          placementEpoch: cur?.placementEpoch ?? 1,
          poolKind: cur?.poolKind ?? 'local_container',
          engine: input.engine,
          nativeSessionId: input.reset ? null : input.nativeSessionId,
          operationId: cur?.operationId ?? null,
          profileId: cur?.profileId ?? null,
          capsuleId: cur?.capsuleId ?? null,
          history: input.reset ? [] : [...(input.history ?? cur?.history ?? [])],
          rejectedIds: [...(input.rejectedIds ?? cur?.rejectedIds ?? [])],
          promptCacheMeta: cur?.promptCacheMeta ?? null,
          usageBaseline: nextUsage,
          historyContextVersion:
            input.historyContextVersion !== undefined
              ? input.historyContextVersion
              : (cur?.historyContextVersion ?? null),
          promotedFromHistory: input.reset
            ? false
            : (input.promotedFromHistory ?? cur?.promotedFromHistory ?? false),
          migrationState: cur?.migrationState ?? 'active',
          activeMigrationId: cur?.activeMigrationId ?? null,
          updatedAt: nowIso,
          createdAt: cur?.createdAt ?? nowIso,
        }
        this.pointers.set(k, next)
        return next
      },
      patchPromptState: async (input) => {
        const k = this.key(input.userId, input.sessionKey)
        const cur = this.pointers.get(k)
        if (cur && cur.placementEpoch !== input.expectedPlacementEpoch) {
          throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
        }
        const merged = {
          ...(cur?.promptCacheMeta ?? {}),
          conversationId: input.promptState.conversationId,
          inputsKey: input.promptState.inputsKey,
          injectedAfterBaseline: input.promptState.injectedAfterBaseline,
          promptState: input.promptState,
        }
        const nowIso = new Date().toISOString()
        const next: SessionEnginePointer = {
          ...(cur ?? {
            sessionKey: input.sessionKey,
            placementEpoch: 1,
            poolKind: 'local_container',
            engine: input.engine,
            nativeSessionId: input.promptState.conversationId,
            history: [],
            rejectedIds: [],
            promotedFromHistory: false,
            migrationState: 'active',
            activeMigrationId: null,
            createdAt: nowIso,
          }),
          promptCacheMeta: merged,
          updatedAt: nowIso,
        }
        this.pointers.set(k, next)
        return next
      },
      patchCapsule: async (input) => {
        const k = this.key(input.userId, input.sessionKey)
        const cur = this.pointers.get(k)
        if (cur && cur.placementEpoch !== input.expectedPlacementEpoch) {
          throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
        }
        const merged = {
          ...(cur?.promptCacheMeta ?? {}),
          _capsuleMeta: {
            capsuleId: input.capsuleId,
            manifestBlobId: input.manifestBlobId,
            engine: input.engine,
            engineVersion: input.engineVersion,
            placementEpoch: cur?.placementEpoch ?? 1,
            createdAt: input.createdAt,
          },
        }
        const nowIso = new Date().toISOString()
        const next: SessionEnginePointer = {
          ...(cur ?? {
            sessionKey: input.sessionKey,
            placementEpoch: 1,
            poolKind: 'local_container',
            engine: input.engine,
            nativeSessionId: input.nativeSessionId ?? null,
            history: [],
            rejectedIds: [],
            promotedFromHistory: false,
            migrationState: 'active',
            activeMigrationId: null,
            createdAt: nowIso,
          }),
          capsuleId: input.capsuleId,
          promptCacheMeta: merged,
          updatedAt: nowIso,
        }
        this.pointers.set(k, next)
        return next
      },
    }
  }

  async peekRollingCheckpoint(userId: number | bigint, sessionKey: string, expectedEpoch?: number) {
    const list = this.checkpoints.get(this.key(userId, sessionKey)) ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const rec = list[i]!
      if (rec.ackedByTurnKey) continue
      if (expectedEpoch !== undefined && rec.placementEpoch !== expectedEpoch) continue
      return rec
    }
    return null
  }

  async getRollingCheckpointByGeneration(
    userId: number | bigint,
    sessionKey: string,
    generation: string,
  ) {
    const list = this.checkpoints.get(this.key(userId, sessionKey)) ?? []
    return list.find((r) => r.checkpointGeneration === generation && !r.ackedByTurnKey) ?? null
  }

  async saveRollingCheckpoint(input: {
    userId: number | bigint
    sessionKey: string
    sessionId: string
    expectedPlacementEpoch: number
    mode: 'anchored_v2' | 'native_handoff'
    anchorSeq: number
    sourceEngine: 'ccb' | 'codex' | 'antigravity' | 'grok' | 'cursor' | 'zcode'
    summary: string
    instructions?: string | null
    checkpointGeneration?: string
  }) {
    const k = this.key(input.userId, input.sessionKey)
    const cur = this.pointers.get(k)
    if (cur && cur.placementEpoch !== input.expectedPlacementEpoch) {
      throw new Error('CHECKPOINT_PLACEMENT_EPOCH_MISMATCH')
    }
    const gen = input.checkpointGeneration ?? 'cp-auto-1'
    const now = Date.now()
    const list = this.checkpoints.get(k) ?? []
    list.push({
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      checkpointGeneration: gen,
      placementEpoch: input.expectedPlacementEpoch,
      mode: input.mode,
      anchorSeq: input.anchorSeq,
      sourceEngine: input.sourceEngine,
      summary: input.summary,
      instructions: input.instructions ?? null,
      ackedByTurnKey: null,
      ackedAt: null,
      createdAt: new Date(now).toISOString(),
    })
    this.checkpoints.set(k, list)
    return { checkpointGeneration: gen, createdAtMs: now }
  }

  async ackRollingCheckpoint(cas: {
    userId: number | bigint
    sessionKey: string
    checkpointGeneration: string
    consumedByTurnKey: string
  }): Promise<boolean> {
    const list = this.checkpoints.get(this.key(cas.userId, cas.sessionKey)) ?? []
    const rec = list.find(
      (r) => !r.ackedByTurnKey && r.checkpointGeneration === cas.checkpointGeneration,
    )
    if (!rec) return false
    rec.ackedByTurnKey = cas.consumedByTurnKey
    rec.ackedAt = new Date().toISOString()
    return true
  }
}

describe('OCV5-907 P1-1: internalAuthorityState RPC handler (R1 hardened)', () => {
  const servers: Server[] = []

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  })

  async function startHarness(store: FakeAuthorityStateStore) {
    const handler = makeInternalAuthorityStateHandler({
      store: store as unknown as PgSessionAuthorityStateStore,
      patchers: store.makePatchers(),
      verify: async (req) => {
        const auth = req.headers.authorization ?? ''
        if (auth === 'Bearer tok-u3') return { userId: 3 }
        if (auth === 'Bearer tok-u9') return { userId: 9 }
        throw new Error('unauthorized')
      },
    })
    const server = createServer((req, res) => {
      void handler(req, res, { hostUuid: 'self', boundIp: '127.0.0.1' })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    return `http://127.0.0.1:${addr.port}${AUTHORITY_STATE_INTERNAL_PREFIX}`
  }

  it('enforces B1 precondition, B2 field ownership (preserves remote_pool & pendingInstallMigration), B4 reset, and B6 epoch-scoped checkpoint', async () => {
    const store = new FakeAuthorityStateStore()
    const base = await startHarness(store)
    const sk = 'agent:main:webchat:dm:sess1'

    // Unauthenticated rejected
    assert.equal((await fetch(`${base}epoch?sessionKey=${sk}`)).status, 401)

    // Seed authoritative epoch 2 remote_pool pointer with pendingInstallMigration & extra usage keys
    store.pointers.set(`3::${sk}`, {
      sessionKey: sk,
      placementEpoch: 2,
      poolKind: 'remote_pool',
      engine: 'codex',
      nativeSessionId: 'thr-remote-v2',
      operationId: 'op-remote-1',
      profileId: 'prof-1',
      capsuleId: 'cap-keep-1',
      history: ['thr-remote-v1'],
      rejectedIds: [],
      promptCacheMeta: {
        pendingInstallMigration: { migrationId: 'mig-12345678', placementEpoch: 2 },
      },
      usageBaseline: { totalCostUsd: 0.5, inputTokens: 12000 },
      historyContextVersion: null,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: new Date().toISOString(),
    })

    // B1: Missing expectedPlacementEpoch & createIfAbsentOnly -> 400
    const noPrecond = await fetch(`${base}pointer`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: sk, engine: 'codex', nativeSessionId: 'old-head' }),
    })
    assert.equal(noPrecond.status, 400)

    // B1: Legacy cache (createIfAbsentOnly: true) with stale head -> 409, MUST NOT clobber epoch 2
    const legacyOverwrite = await fetch(`${base}pointer`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionKey: sk,
        engine: 'codex',
        nativeSessionId: 'old-local-head',
        createIfAbsentOnly: true,
      }),
    })
    assert.equal(legacyOverwrite.status, 409)
    assert.equal(store.pointers.get(`3::${sk}`)?.nativeSessionId, 'thr-remote-v2')

    // B2: Narrow PUT /pointer at epoch 2 attempting to pass poolKind/promptCacheMeta MUST preserve master-owned fields
    const narrowPut = await fetch(`${base}pointer`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionKey: sk,
        engine: 'codex',
        nativeSessionId: 'thr-remote-v2b',
        poolKind: 'local_container',
        promptCacheMeta: null,
        totalCostUsd: 0.75,
        expectedPlacementEpoch: 2,
      }),
    })
    assert.equal(narrowPut.status, 200)
    const afterPut = store.pointers.get(`3::${sk}`)!
    assert.equal(afterPut.nativeSessionId, 'thr-remote-v2b')
    assert.equal(afterPut.poolKind, 'remote_pool')
    assert.equal(afterPut.operationId, 'op-remote-1')
    assert.equal(afterPut.capsuleId, 'cap-keep-1')
    assert.deepEqual(afterPut.promptCacheMeta, {
      pendingInstallMigration: { migrationId: 'mig-12345678', placementEpoch: 2 },
    })
    assert.deepEqual(afterPut.usageBaseline, { totalCostUsd: 0.75, inputTokens: 12000 })

    // B2: Narrow PATCH /prompt-state & PATCH /capsule preserve pendingInstallMigration
    const psRes = await fetch(`${base}prompt-state`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionKey: sk,
        engine: 'antigravity',
        expectedPlacementEpoch: 2,
        promptState: {
          v: 1,
          sessionKey: sk,
          conversationId: '11111111-2222-3333-4444-555555555555',
          inputsKey: 'b'.repeat(64),
          injectedAfterBaseline: 4,
          updatedAt: Date.now(),
        },
      }),
    })
    assert.equal(psRes.status, 200)
    const afterPs = store.pointers.get(`3::${sk}`)!
    assert.ok((afterPs.promptCacheMeta as Record<string, unknown>).pendingInstallMigration)
    assert.ok((afterPs.promptCacheMeta as Record<string, unknown>).promptState)

    const capRes = await fetch(`${base}capsule`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionKey: sk,
        engine: 'codex',
        expectedPlacementEpoch: 2,
        capsuleId: 'cap-new-99',
        manifestBlobId: 'blob-manifest-99',
        engineVersion: '0.172.0',
        createdAt: new Date().toISOString(),
      }),
    })
    assert.equal(capRes.status, 200)
    const afterCap = store.pointers.get(`3::${sk}`)!
    assert.equal(afterCap.capsuleId, 'cap-new-99')
    assert.ok((afterCap.promptCacheMeta as Record<string, unknown>).pendingInstallMigration)
    assert.ok((afterCap.promptCacheMeta as Record<string, unknown>).promptState)
    assert.ok((afterCap.promptCacheMeta as Record<string, unknown>)._capsuleMeta)

    // B6: Unacked checkpoint from epoch 1 MUST NOT be returned when pointer is at epoch 2
    store.checkpoints.set(`3::${sk}`, [
      {
        sessionKey: sk,
        sessionId: 'sess1',
        checkpointGeneration: 'cp-epoch-1-stale',
        placementEpoch: 1,
        mode: 'anchored_v2',
        anchorSeq: 2,
        sourceEngine: 'codex',
        summary: 'Stale epoch 1 summary',
        instructions: null,
        ackedByTurnKey: null,
        ackedAt: null,
        createdAt: new Date().toISOString(),
      },
    ])
    const staleCpRes = await fetch(`${base}checkpoint?sessionKey=${encodeURIComponent(sk)}`, {
      headers: { authorization: 'Bearer tok-u3' },
    })
    assert.equal(staleCpRes.status, 200)
    assert.equal(((await staleCpRes.json()) as { checkpoint: unknown }).checkpoint, null)

    // Save epoch 2 checkpoint -> returned and acked via Generation CAS
    const cp2Res = await fetch(`${base}checkpoint`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionKey: sk,
        sessionId: 'sess1',
        checkpointGeneration: 'cp-epoch-2-fresh',
        expectedPlacementEpoch: 2,
        mode: 'anchored_v2',
        anchorSeq: 5,
        sourceEngine: 'codex',
        summary: 'Fresh epoch 2 summary',
      }),
    })
    assert.equal(cp2Res.status, 200)
    const freshCpRes = await fetch(`${base}checkpoint?sessionKey=${encodeURIComponent(sk)}`, {
      headers: { authorization: 'Bearer tok-u3' },
    })
    assert.equal(
      ((await freshCpRes.json()) as { checkpoint: { checkpointGeneration: string } }).checkpoint
        .checkpointGeneration,
      'cp-epoch-2-fresh',
    )

    // R2-B6: Even if caller passes explicit placementEpoch=1 after Master moved to epoch 2,
    // Master single-view validation MUST return checkpoint: null (never serve stale epoch 1).
    const explicitStaleRes = await fetch(
      `${base}checkpoint?sessionKey=${encodeURIComponent(sk)}&placementEpoch=1`,
      { headers: { authorization: 'Bearer tok-u3' } },
    )
    assert.equal(explicitStaleRes.status, 200)
    assert.equal(((await explicitStaleRes.json()) as { checkpoint: unknown }).checkpoint, null)

    // B4: Explicit reset clears nativeSessionId & history while keeping poolKind & pendingInstallMigration
    const resetRes = await fetch(`${base}pointer`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionKey: sk,
        engine: 'codex',
        nativeSessionId: null,
        reset: true,
        expectedPlacementEpoch: 2,
      }),
    })
    assert.equal(resetRes.status, 200)
    const afterReset = store.pointers.get(`3::${sk}`)!
    assert.equal(afterReset.nativeSessionId, null)
    assert.deepEqual(afterReset.history, [])
    assert.equal(afterReset.poolKind, 'remote_pool')
  })

  it('rejects oversized pointer payloads with HTTP 413', async () => {
    const store = new FakeAuthorityStateStore()
    const base = await startHarness(store)
    const oversized = JSON.stringify({
      sessionKey: 's1',
      engine: 'codex',
      createIfAbsentOnly: true,
      history: ['x'.repeat(200 * 1024)],
    })
    const res = await fetch(`${base}pointer`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: oversized,
    })
    assert.equal(res.status, 413)
  })
})
