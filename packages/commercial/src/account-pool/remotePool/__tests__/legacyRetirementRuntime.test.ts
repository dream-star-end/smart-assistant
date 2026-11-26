/**
 * Unit & multi-instance concurrency tests for Wave 3 P2-2 (`LegacyTrackRetirementGate`,
 * shared PG `system_settings` authority, `pg_advisory_xact_lock` commit barrier, all legacy
 * write entrypoints, startup error safety, and atomic unseal).
 *
 * Covers R1 audit blockers B01, B02, B03, B04, and W05.
 * Run: npx tsx --test packages/commercial/src/account-pool/remotePool/__tests__/legacyRetirementRuntime.test.ts
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { admitCommission } from '../../codexCommissioningStore.js'
import { placeRemoteLane } from '../../remoteBrainPool.js'
import { createRemoteNativeTurnFinance } from '../../../billing/remoteNativeTurnBilling.js'
import { handleAdminRemoteDriverV4 } from '../../../http/admin/remoteDriverV4.js'
import type { CommercialHttpDeps, RequestContext } from '../../../http/handlers.js'
import { RemoteDriverV4CommissioningService } from '../commissioningService.js'
import { LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY } from '../legacyRetirement.js'
import {
  LEGACY_REMOTE_TRACK_RETIRED,
  LEGACY_RETIREMENT_BLOCKED,
  LEGACY_RETIREMENT_SETTING_KEY,
  UNMIGRATED_LEGACY_MODEL_OFFERS,
  LegacyRetirementBlockedError,
  LegacyTrackRetirementGate,
  type LegacyRetirementPoolClient,
  type LegacyRetirementPoolLike,
  assertLegacyTrackNotRetiredTx,
  evaluateUnmigratedLegacyModelOffers,
  parseLegacyRetirementMode,
} from '../legacyRetirementRuntime.js'
import { revertDriverV4ProfileToLegacy } from '../profileCutover.js'

/**
 * In-memory transactional PG harness implementing:
 * - `system_settings` persistence across multiple gate instances (B01)
 * - Real shared vs exclusive `pg_advisory_xact_lock` semantics across concurrent transactions (B02)
 * - Read-only enforcement verification on `request_finalize_journal` / `remote_agent_bindings`
 */
function createSharedTransactionalPg(state: {
  activeLegacyBindings: number
  unsettledLegacyJournals: number
  unmigratedLegacyModels?: string[]
  historicalRow?: Record<string, unknown> | null
  failSettingsWrite?: boolean
  failAllQueries?: boolean
}) {
  let settingValue: unknown = null
  let sharedHolders = 0
  let exclusiveHeld = false
  const waiters: Array<() => void> = []

  const wakeWaiters = () => {
    while (waiters.length > 0) {
      const fn = waiters.shift()!
      fn()
    }
  }

  const acquireShared = async (): Promise<void> => {
    while (exclusiveHeld) {
      await new Promise<void>((r) => waiters.push(r))
    }
    sharedHolders += 1
  }

  const acquireExclusive = async (): Promise<void> => {
    while (exclusiveHeld || sharedHolders > 0) {
      await new Promise<void>((r) => waiters.push(r))
    }
    exclusiveHeld = true
  }

  const execQuery = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] | undefined,
    txLocks: { shared: boolean; exclusive: boolean },
  ): Promise<{ rows: T[]; rowCount: number }> => {
    if (state.failAllQueries) {
      throw new Error('PG_CONNECTION_UNAVAILABLE')
    }
    const normalized = sql.trim().replace(/\s+/g, ' ')
    if (normalized === 'BEGIN') return { rows: [], rowCount: 0 }
    if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      if (txLocks.shared) {
        txLocks.shared = false
        sharedHolders = Math.max(0, sharedHolders - 1)
        wakeWaiters()
      }
      if (txLocks.exclusive) {
        txLocks.exclusive = false
        exclusiveHeld = false
        wakeWaiters()
      }
      return { rows: [], rowCount: 0 }
    }
    if (normalized.includes('pg_advisory_xact_lock_shared')) {
      if (!txLocks.shared) {
        await acquireShared()
        txLocks.shared = true
      }
      return { rows: [], rowCount: 0 }
    }
    if (normalized.includes('pg_advisory_xact_lock(')) {
      if (!txLocks.exclusive) {
        await acquireExclusive()
        txLocks.exclusive = true
      }
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('SELECT value FROM system_settings')) {
      return settingValue === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ value: settingValue } as unknown as T], rowCount: 1 }
    }
    if (normalized.startsWith('INSERT INTO system_settings')) {
      if (state.failSettingsWrite) {
        throw new Error('PG_WRITE_FAILED')
      }
      assert.equal(params?.[0], LEGACY_RETIREMENT_SETTING_KEY)
      settingValue = JSON.parse(String(params?.[1]))
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('FROM remote_agent_bindings')) {
      return { rows: [{ cnt: String(state.activeLegacyBindings) } as unknown as T], rowCount: 1 }
    }
    if (normalized.includes('FROM remote_model_offers')) {
      const models = state.unmigratedLegacyModels ?? []
      return {
        rows: models.map((m) => ({ canonical_model_id: m }) as unknown as T),
        rowCount: models.length,
      }
    }
    if (normalized.includes('COUNT(*)::text AS cnt')) {
      return {
        rows: [{ cnt: String(state.unsettledLegacyJournals) } as unknown as T],
        rowCount: 1,
      }
    }
    if (normalized.includes('FROM request_finalize_journal')) {
      assert.match(normalized, /^SELECT\b/i, 'legacy lookup must remain strictly read-only')
      return {
        rows: state.historicalRow ? [state.historicalRow as unknown as T] : [],
        rowCount: state.historicalRow ? 1 : 0,
      }
    }
    return { rows: [], rowCount: 0 }
  }

  const pool: LegacyRetirementPoolLike = {
    async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      const oneShot = { shared: false, exclusive: false }
      try {
        return await execQuery<T>(sql, params, oneShot)
      } finally {
        if (oneShot.shared) {
          sharedHolders = Math.max(0, sharedHolders - 1)
          wakeWaiters()
        }
        if (oneShot.exclusive) {
          exclusiveHeld = false
          wakeWaiters()
        }
      }
    },
    async connect(): Promise<LegacyRetirementPoolClient> {
      const txLocks = { shared: false, exclusive: false }
      return {
        query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
          execQuery<T>(sql, params, txLocks),
        release() {
          if (txLocks.shared) {
            txLocks.shared = false
            sharedHolders = Math.max(0, sharedHolders - 1)
            wakeWaiters()
          }
          if (txLocks.exclusive) {
            txLocks.exclusive = false
            exclusiveHeld = false
            wakeWaiters()
          }
        },
      }
    },
  }

  return {
    pool,
    getSetting: () => settingValue,
  }
}

describe('parseLegacyRetirementMode (OCV5-908 P2-2)', () => {
  it('defaults to auto on selfhost V5 and force_off on commercial, honoring explicit overrides', () => {
    assert.equal(parseLegacyRetirementMode(undefined, true), 'auto')
    assert.equal(parseLegacyRetirementMode('', true), 'auto')
    assert.equal(parseLegacyRetirementMode('0', true), 'force_off')
    assert.equal(parseLegacyRetirementMode('false', true), 'force_off')
    assert.equal(parseLegacyRetirementMode('off', true), 'force_off')
    assert.equal(parseLegacyRetirementMode('1', true), 'force_on')
    assert.equal(parseLegacyRetirementMode('true', true), 'force_on')

    assert.equal(parseLegacyRetirementMode(undefined, false), 'force_off')
    assert.equal(parseLegacyRetirementMode('0', false), 'force_off')
    assert.equal(parseLegacyRetirementMode('1', false), 'force_on')
    assert.equal(parseLegacyRetirementMode('auto', false), 'auto')
  })
})

describe('B01 + B02 + B03 + B04 + W05 — Shared PG retirement authority & commit barriers', () => {
  it('B01: Master seal/unseal immediately propagates to independent Relay A & Relay B instances via shared PG state', async () => {
    const db = { activeLegacyBindings: 0, unsettledLegacyJournals: 0 }
    const { pool } = createSharedTransactionalPg(db)

    const masterGate = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    const relayAGate = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    const relayBGate = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })

    // Master auto-seals at startup; Relay A & B immediately see enforced=true with same revision
    const sBoot = await masterGate.initializeAtStartup()
    assert.equal(sBoot.enforced, true)
    assert.equal(sBoot.revision, 1)

    await assert.rejects(() => relayAGate.assertLegacyPlacementAllowedAsync(), /LEGACY_REMOTE_TRACK_RETIRED/)
    await assert.rejects(() => relayBGate.assertLegacyPlacementAllowedAsync(), /LEGACY_REMOTE_TRACK_RETIRED/)

    // Operator unseals on Master -> Relay A & B immediately allow legacy placement and report enforced=false
    const sUnsealed = await masterGate.unseal(3)
    assert.equal(sUnsealed.enforced, false)
    assert.equal(sUnsealed.revision, 2)

    await relayAGate.assertLegacyPlacementAllowedAsync()
    await relayBGate.assertLegacyPlacementAllowedAsync()
    const relayAStatus = await relayAGate.getStatus()
    assert.equal(relayAStatus.enforced, false)
    assert.equal(relayAStatus.revision, 2)

    // Restarting a fresh Relay C in `auto` mode respects the active operator unseal!
    const relayCGate = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    const sRestarted = await relayCGate.initializeAtStartup()
    assert.equal(sRestarted.enforced, false)
    assert.equal(sRestarted.revision, 2)

    // Operator re-seals on Master -> Relay A/B/C immediately fail closed again
    const sResealed = await masterGate.seal(3)
    assert.equal(sResealed.enforced, true)
    assert.equal(sResealed.revision, 3)
    await assert.rejects(() => relayAGate.assertLegacyPlacementAllowedAsync(), /LEGACY_REMOTE_TRACK_RETIRED/)
    await assert.rejects(() => relayCGate.assertLegacyPlacementAllowedAsync(), /LEGACY_REMOTE_TRACK_RETIRED/)
  })

  it('B02: advisory-lock commit barrier prevents any in-flight legacy writer from committing after seal() succeeds', async () => {
    const db = { activeLegacyBindings: 0, unsettledLegacyJournals: 0 }
    const { pool } = createSharedTransactionalPg(db)
    const gate = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })

    // Scenario 1: In-flight legacy placement tx acquires shared lock BEFORE seal(), writes binding, commits.
    // Concurrent seal() MUST wait for the writer to commit, then observe activeLegacyBindings=1 and FAIL CLOSED.
    const writerClient = await pool.connect!()
    await writerClient.query('BEGIN')
    await assertLegacyTrackNotRetiredTx(writerClient, 'placement')

    let sealFinished = false
    const sealPromise = gate.seal(3).finally(() => {
      sealFinished = true
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(sealFinished, false, 'seal() must wait for in-flight shared-lock legacy writer')

    // Writer commits its new legacy binding
    db.activeLegacyBindings = 1
    await writerClient.query('COMMIT')
    writerClient.release()

    await assert.rejects(
      () => sealPromise,
      (err: unknown) =>
        err instanceof LegacyRetirementBlockedError &&
        err.code === LEGACY_RETIREMENT_BLOCKED &&
        err.readiness.activeLegacyBindingCount === 1,
    )
    assert.equal(gate.isRetired(), false)

    // Scenario 2: Binding is released, seal() succeeds -> subsequent transactional writer MUST fail closed
    db.activeLegacyBindings = 0
    const sealed = await gate.seal(3)
    assert.equal(sealed.enforced, true)

    const lateWriter = await pool.connect!()
    try {
      await lateWriter.query('BEGIN')
      await assert.rejects(
        () => assertLegacyTrackNotRetiredTx(lateWriter, 'placement'),
        new RegExp(LEGACY_REMOTE_TRACK_RETIRED),
      )
      await assert.rejects(
        () => assertLegacyTrackNotRetiredTx(lateWriter, 'billing'),
        new RegExp(LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY),
      )
      await lateWriter.query('ROLLBACK')
    } finally {
      lateWriter.release()
    }
  })

  it('B03: ALL 4 legacy write entrypoints (placeRemoteLane, admitCommission, revertDriverV4ProfileToLegacy, remoteNativeTurnBilling.admit) fail closed when sealed', async () => {
    const db = { activeLegacyBindings: 0, unsettledLegacyJournals: 0 }
    const { pool } = createSharedTransactionalPg(db)
    const gate = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    await gate.initializeAtStartup()
    assert.equal(gate.isRetired(), true)

    // 1. placeRemoteLane
    await assert.rejects(
      () =>
        placeRemoteLane(
          {
            uid: 3,
            containerDbId: '1',
            dockerId: 'a'.repeat(64),
            sessionKey: 'agent:main:webchat:dm:test-b03',
            canonicalModel: 'claude-sonnet-5-remote',
          },
          { pool: pool as never },
        ),
      new RegExp(LEGACY_REMOTE_TRACK_RETIRED),
    )

    // 2. Old Codex commissioning admitCommission
    await assert.rejects(
      () =>
        admitCommission(
          pool as never,
          '3',
          '2eba9f14-b00c-4335-b846-20bcc682c6dc',
          async () => ({ containerDbId: '1', dockerId: 'a'.repeat(64) }),
        ),
      new RegExp(LEGACY_REMOTE_TRACK_RETIRED),
    )

    // 3. Underlying revertDriverV4ProfileToLegacy (blocks BOTH manual revert and auto-rollback!)
    await assert.rejects(
      () =>
        revertDriverV4ProfileToLegacy(pool as never, {
          profileId: '2eba9f14-b00c-4335-b846-20bcc682c6dc',
          expectedMinReadyGeneration: '1',
        }),
      new RegExp(LEGACY_REMOTE_TRACK_RETIRED),
    )

    // 4. Legacy billing finance.admit()
    const finance = createRemoteNativeTurnFinance({
      pool: pool as never,
      preCheckRedis: {} as never,
      catalog: {} as never,
      keyring: {} as never,
      loadUserModelAuthz: async () => {
        throw new Error('should not be reached')
      },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      upstreamModel: 'claude-sonnet-5',
      legacyRetirementGate: gate,
    })
    await assert.rejects(
      () => finance.admit({} as never),
      new RegExp(LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY),
    )
  })

  it('B04: startup PG rejection produces ZERO unhandledRejection events when caught, and force_off succeeds even if PG is down', async () => {
    const { pool } = createSharedTransactionalPg({
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 0,
      failAllQueries: true,
    })

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const gateAuto = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
      await assert.rejects(() => gateAuto.initializeAtStartup(), /PG_CONNECTION_UNAVAILABLE/)
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(unhandled.length, 0, 'caught initializeAtStartup must never emit unhandledRejection')

      // force_off skips unnecessary PG query and succeeds even while PG is unreachable
      const gateOff = new LegacyTrackRetirementGate({ queryable: pool, mode: 'force_off' })
      const offStatus = await gateOff.initializeAtStartup()
      assert.equal(offStatus.enforced, false)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('W05: failed unseal() does NOT mutate local enforced state when PG write fails', async () => {
    const db = {
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 0,
      failSettingsWrite: false,
    }
    const { pool } = createSharedTransactionalPg(db)
    const gate = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    await gate.initializeAtStartup()
    assert.equal(gate.isRetired(), true)

    db.failSettingsWrite = true
    await assert.rejects(() => gate.unseal(3), /PG_WRITE_FAILED/)
    assert.equal(gate.isRetired(), true, 'local enforced state must remain true when PG unseal fails')
  })

  it('exposes read-only historical lookup while sealed and enforces auth on HTTP handler', async () => {
    const { pool } = createSharedTransactionalPg({
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 0,
      historicalRow: {
        request_id: 'req-codex-77',
        user_id: '3',
        state: 'committed',
        precheck_credits: '100',
        final_credits: '15',
        ledger_id: '101',
        usage_id: '202',
        error_msg: null,
        ctx: {
          remoteNativeBillingRecovery: 'remote-native-v2',
          remoteNative: { scope: { backendKind: 'codex-app-server-v1' } },
        },
        created_at: new Date('2026-11-21T00:00:00.000Z'),
        updated_at: new Date('2026-11-21T00:02:00.000Z'),
      },
    })
    const gate = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    await gate.initializeAtStartup()
    const svc = new RemoteDriverV4CommissioningService({
      executorDeps: {
        pool: pool as never,
        preCheckRedis: {} as never,
        catalog: {} as never,
        keyring: () => ({}) as never,
        signer: {} as never,
        loadUserModelAuthz: async () => ({}) as never,
        log: {} as never,
        containerSource: async () => null,
      },
      legacyRetirementGate: gate,
    })

    const rec = await svc.lookupLegacyHistoricalTurn({ requestId: 'req-codex-77', userId: 3n })
    assert.ok(rec)
    assert.equal(rec.backendKind, 'codex-app-server-v1')
    assert.equal(rec.finalCredits, 15)

    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/api/admin/remote-pool/driver-v4/legacy-retirement',
      headers: {},
    }) as unknown as IncomingMessage
    const res = {
      headersSent: false,
      writeHead: () => res,
      end: () => {},
    } as unknown as ServerResponse
    await assert.rejects(
      () =>
        handleAdminRemoteDriverV4(
          req,
          res,
          { clientIp: '127.0.0.1', userAgent: 'test', requestId: 'r1' } as RequestContext,
          { jwtSecret: 'secret', remoteDriverV4: svc } as unknown as CommercialHttpDeps,
        ),
      /unauthorized|missing|token|401/i,
    )
  })

  it('F05: force_off disables auto-seal without contradicting an already-sealed PG state, while /unseal globally unseals', async () => {
    const { pool } = createSharedTransactionalPg({
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 0,
    })
    // Master seals in auto mode
    const master = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    const sealed = await master.initializeAtStartup()
    assert.equal(sealed.enforced, true)

    // Restarted peer with force_off MUST honestly report enforced=true (not lie enforced=false)
    // and agree with all 4 transactional writers until authoritative unseal() commits to PG.
    const peerOff = new LegacyTrackRetirementGate({ queryable: pool, mode: 'force_off' })
    const peerBoot = await peerOff.initializeAtStartup()
    assert.equal(peerBoot.enforced, true)
    assert.equal(peerOff.isRetired(), true)
    await assert.rejects(() => peerOff.assertLegacyPlacementAllowedAsync(), new RegExp(LEGACY_REMOTE_TRACK_RETIRED))

    // Authoritative operator unseal commits globally to PG -> both peerOff & writers now allow!
    const unsealed = await master.unseal(3)
    assert.equal(unsealed.enforced, false)
    await peerOff.assertLegacyPlacementAllowedAsync()
    await peerOff.assertLegacyBillingWriteAllowedAsync()
  })

  it('A01: peer Relay billing admit() immediately refreshes after Master unseal() without stale positive cache', async () => {
    const { pool } = createSharedTransactionalPg({
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 0,
    })
    const master = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    const relay = new LegacyTrackRetirementGate({ queryable: pool, mode: 'auto' })
    await master.initializeAtStartup()
    await relay.initializeAtStartup()
    assert.equal(relay.isRetired(), true)

    // Master unseals; relay has NOT done any placement refresh yet!
    await master.unseal(3)

    // Calling assertLegacyBillingWriteAllowedAsync (used by remoteNativeTurnBilling.admit) MUST NOT
    // throw stale LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY — it refreshes from shared PG immediately.
    await relay.assertLegacyBillingWriteAllowedAsync()
    assert.equal(relay.isRetired(), false)
  })

  it('Steward P1-2: idle legacy-only and partially-migrated clusters stay unsealed until all enabled legacy offers have verified v4 coverage', async () => {
    // 1. Legacy-only deployment at idle (0 active bindings, 0 unsettled journals, 1 legacy-only offer)
    const legacyOnlyDb = {
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 0,
      unmigratedLegacyModels: ['claude-sonnet-5-remote'],
    }
    const { pool: legacyPool } = createSharedTransactionalPg(legacyOnlyDb)
    const legacyGate = new LegacyTrackRetirementGate({ queryable: legacyPool, mode: 'auto' })
    const legacyBoot = await legacyGate.initializeAtStartup()
    assert.equal(legacyBoot.enforced, false, 'idle legacy-only deployment must NOT auto-seal')
    assert.equal(legacyBoot.readiness.readyToRetire, false)
    assert.ok(legacyBoot.readiness.blockingReasons.includes(UNMIGRATED_LEGACY_MODEL_OFFERS))
    await legacyGate.assertLegacyPlacementAllowedAsync()
    await assert.rejects(
      () => legacyGate.seal(3),
      (err: unknown) =>
        err instanceof LegacyRetirementBlockedError &&
        err.readiness.blockingReasons.includes(UNMIGRATED_LEGACY_MODEL_OFFERS),
    )

    // 2. Partial migration at idle (model A migrated to v4, model B still legacy-only)
    const partialDb = {
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 0,
      unmigratedLegacyModels: ['codex-gpt-5-remote'],
    }
    const { pool: partialPool } = createSharedTransactionalPg(partialDb)
    const partialGate = new LegacyTrackRetirementGate({ queryable: partialPool, mode: 'auto' })
    const partialBoot = await partialGate.initializeAtStartup()
    assert.equal(partialBoot.enforced, false, 'partially migrated cluster must NOT auto-seal')
    assert.ok(partialBoot.readiness.blockingReasons.includes(UNMIGRATED_LEGACY_MODEL_OFFERS))

    // 3. Once model B also receives verified v4 coverage (unmigratedLegacyModels becomes empty),
    //    auto startup seals cleanly and fails closed on legacy placement.
    partialDb.unmigratedLegacyModels = []
    const migratedGate = new LegacyTrackRetirementGate({ queryable: partialPool, mode: 'auto' })
    const migratedBoot = await migratedGate.initializeAtStartup()
    assert.equal(migratedBoot.enforced, true, 'fully migrated idle cluster must auto-seal')
    assert.equal(migratedBoot.readiness.readyToRetire, true)
    await assert.rejects(
      () => migratedGate.assertLegacyPlacementAllowedAsync(),
      new RegExp(LEGACY_REMOTE_TRACK_RETIRED),
    )

    // 4. Verify the SQL predicate enforces same-engine matching (`p2.engine = p.engine`) so a
    //    cross-engine v4 offer (e.g. antigravity) can never satisfy coverage for a legacy cc offer.
    let capturedSql = ''
    const sqlCapturePool: LegacyRetirementPoolLike = {
      async query<T extends Record<string, unknown>>(sql: string) {
        capturedSql = sql
        return {
          rows: [{ canonical_model_id: 'claude-sonnet-5-remote', engine: 'cc' } as unknown as T],
          rowCount: 1,
        }
      },
    }
    const unmigrated = await evaluateUnmigratedLegacyModelOffers(sqlCapturePool)
    assert.match(capturedSql, /\bp2\.engine\s*=\s*p\.engine\b/)
    assert.match(capturedSql, /\bp2\.execution_ready\s*=\s*TRUE\b/)
    assert.deepEqual([...unmigrated], ['claude-sonnet-5-remote@cc'])
  })

  const PG_TEST_URL = process.env.TEST_DATABASE_URL?.trim() || ''
  const PG_REQUIRED = Boolean(process.env.CI || process.env.REQUIRE_TEST_DB)

  it(
    'Steward P1-2 (isolated PG): cross-engine v4 offer blocks auto/manual seal while same-engine verified v4 offer permits sealing',
    { skip: !PG_REQUIRED && !PG_TEST_URL },
    async () => {
      assert.ok(PG_TEST_URL, 'TEST_DATABASE_URL required when CI or REQUIRE_TEST_DB is set')
      const target = new URL(PG_TEST_URL)
      assert.ok(['postgres:', 'postgresql:'].includes(target.protocol))
      assert.ok(decodeURIComponent(target.pathname.slice(1)).endsWith('_test'))
      const schema = `legacy_retire_${process.pid}_${randomBytes(6).toString('hex')}`
      const real = new Pool({
        connectionString: PG_TEST_URL,
        max: 4,
        application_name: 'legacy-retirement-isolated-test',
      })
      let created = false
      try {
        await real.query(`CREATE SCHEMA ${schema}`)
        created = true
        await real.query(`CREATE TABLE ${schema}.system_settings (
          key TEXT PRIMARY KEY, value JSONB NOT NULL, description TEXT, updated_at TIMESTAMPTZ, updated_by BIGINT
        )`)
        await real.query(`CREATE TABLE ${schema}.remote_agent_nodes (
          id TEXT PRIMARY KEY, status TEXT NOT NULL, disabled_by TEXT
        )`)
        await real.query(`CREATE TABLE ${schema}.remote_agent_profiles (
          id TEXT PRIMARY KEY, node_id TEXT NOT NULL, engine TEXT NOT NULL, driver_id TEXT,
          execution_ready BOOLEAN NOT NULL DEFAULT FALSE, status TEXT NOT NULL, disabled_by TEXT,
          execution_manifest JSONB
        )`)
        await real.query(`CREATE TABLE ${schema}.remote_model_offers (
          id SERIAL PRIMARY KEY, profile_id TEXT NOT NULL, canonical_model_id TEXT NOT NULL, enabled BOOLEAN NOT NULL
        )`)
        await real.query(`CREATE TABLE ${schema}.remote_agent_bindings (
          id SERIAL PRIMARY KEY, profile_id TEXT, state TEXT NOT NULL, driver_id TEXT, remote_protocol_version INT NOT NULL DEFAULT 1
        )`)
        await real.query(`CREATE TABLE ${schema}.request_finalize_journal (
          request_id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, state TEXT NOT NULL, ctx JSONB NOT NULL DEFAULT '{}'::jsonb,
          precheck_credits BIGINT NOT NULL DEFAULT 0, final_credits BIGINT, ledger_id BIGINT, usage_id BIGINT,
          error_msg TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`)

        // Active node + legacy cc profile offer + cross-engine verified v4 antigravity offer for SAME model M
        await real.query(`INSERT INTO ${schema}.remote_agent_nodes (id, status) VALUES ('node-1', 'active')`)
        await real.query(`INSERT INTO ${schema}.remote_agent_profiles (id, node_id, engine, driver_id, execution_ready, status) VALUES
          ('prof-leg-cc', 'node-1', 'cc', NULL, TRUE, 'active'),
          ('prof-v4-ag', 'node-1', 'antigravity', 'antigravity-v4', TRUE, 'active')`)
        await real.query(`INSERT INTO ${schema}.remote_model_offers (profile_id, canonical_model_id, enabled) VALUES
          ('prof-leg-cc', 'model-shared-m', TRUE),
          ('prof-v4-ag', 'model-shared-m', TRUE)`)

        const scopedPool: LegacyRetirementPoolLike = {
          async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
            const client = await real.connect()
            try {
              await client.query(`SET search_path TO ${schema}`)
              return (await client.query(sql, params)) as { rows: T[]; rowCount: number | null }
            } finally {
              client.release()
            }
          },
          async connect(): Promise<LegacyRetirementPoolClient> {
            const client = await real.connect()
            try {
              await client.query(`SET search_path TO ${schema}`)
            } catch (err) {
              client.release()
              throw err
            }
            return {
              query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
                client.query(sql, params) as Promise<{ rows: T[]; rowCount: number | null }>,
              release: () => client.release(),
            }
          },
        }

        // Cross-engine v4 offer MUST block BOTH auto startup seal AND manual operator seal
        const gate = new LegacyTrackRetirementGate({ queryable: scopedPool, mode: 'auto' })
        const bootCross = await gate.initializeAtStartup()
        assert.equal(bootCross.enforced, false, 'cross-engine v4 offer must NOT satisfy legacy cc coverage')
        assert.ok(bootCross.readiness.blockingReasons.includes(UNMIGRATED_LEGACY_MODEL_OFFERS))
        await assert.rejects(
          () => gate.seal(3),
          (err: unknown) =>
            err instanceof LegacyRetirementBlockedError &&
            err.readiness.blockingReasons.includes(UNMIGRATED_LEGACY_MODEL_OFFERS),
        )

        // Add an UNVERIFIED (execution_ready=FALSE) same-engine v4 cc offer -> STILL blocked!
        await real.query(
          `INSERT INTO ${schema}.remote_agent_profiles (id, node_id, engine, driver_id, execution_ready, status)
           VALUES ('prof-v4-cc', 'node-1', 'cc', 'cc-v4', FALSE, 'active')`,
        )
        await real.query(
          `INSERT INTO ${schema}.remote_model_offers (profile_id, canonical_model_id, enabled)
           VALUES ('prof-v4-cc', 'model-shared-m', TRUE)`,
        )
        await assert.rejects(() => gate.seal(3), /UNMIGRATED_LEGACY_MODEL_OFFERS/)

        // Verify the same-engine v4 cc profile (execution_ready=TRUE) -> NOW auto startup & manual seal succeed!
        await real.query(`UPDATE ${schema}.remote_agent_profiles SET execution_ready = TRUE WHERE id = 'prof-v4-cc'`)
        const bootSame = await gate.initializeAtStartup()
        assert.equal(bootSame.enforced, true, 'same-engine verified v4 offer must allow auto-seal')
        assert.equal(bootSame.readiness.readyToRetire, true)

        // Real PG transactional barrier rejects legacy placement once sealed
        const txClient = await scopedPool.connect!()
        try {
          await txClient.query('BEGIN')
          await assert.rejects(
            () => assertLegacyTrackNotRetiredTx(txClient, 'placement'),
            new RegExp(LEGACY_REMOTE_TRACK_RETIRED),
          )
          await txClient.query('ROLLBACK')
        } finally {
          txClient.release()
        }
      } finally {
        try {
          if (created) await real.query(`DROP SCHEMA ${schema} CASCADE`)
        } finally {
          await real.end()
        }
      }
    },
  )
})
