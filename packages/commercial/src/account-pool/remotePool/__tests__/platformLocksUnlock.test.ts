import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import {
  REMOTE_DRIVER_PROTOCOL_VERSION,
  computeStickyHomeKey,
  type RemoteProbeSnapshot,
} from '@openclaude/protocol'
import { computeRemoteCapabilityProfileFromProbe } from '../../remoteBrainPool.js'
import { computeProbeFingerprintTs } from '../driftCoordinator.js'
import {
  placeRemoteDriverLane,
  type PlaceRemoteDriverLaneOptions,
} from '../placement.js'
import { loadRemoteDriverRegistry } from '../registry.js'

function makeHealthyCandidateRow(args: {
  readonly profileId: string
  readonly nodeId: string
  readonly driverId: string
  readonly engine: string
  readonly profileName: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly nowMs: number
  readonly stale?: boolean
}) {
  const reg = loadRemoteDriverRegistry().get(args.driverId)
  assert.ok(reg, `driver ${args.driverId} must exist in registry`)
  const policySha256 = 'a'.repeat(64)
  const snapshot: RemoteProbeSnapshot = {
    schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    driverId: reg.driverId,
    engineId: reg.engineId,
    driverVersion: reg.driverVersion,
    source: `${reg.driverId}:cli-probe`,
    freshness: 'cli-observed',
    cliVersion: '2.0.0',
    cliSha256: 'b'.repeat(64),
    rawResponseSha256: 'c'.repeat(64),
    authPresent: true,
    accountObserved: true,
    observedAt: new Date(args.nowMs).toISOString(),
    models: [
      {
        upstreamModelId: args.upstreamModel,
        displayName: args.upstreamModel,
        defaultEffort: 'medium',
        supportsVision: true,
        supportsAdaptiveThinking: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    ],
  }
  const verifiedFingerprint = computeProbeFingerprintTs(snapshot, {
    driverDigest: reg.driverDigest,
    coreDigest: reg.coreDigest,
    policySha256,
  })
  return {
    profile_id: args.profileId,
    id: args.profileId,
    node_id: args.nodeId,
    engine: args.engine,
    driver_id: reg.driverId,
    profile_name: args.profileName,
    weight: 100,
    health_score: 100,
    hot_slots: 0,
    active_slots: 0,
    max_hot_slots: 8,
    max_concurrent_lanes: 5,
    auth_epoch: 'epoch-1',
    execution_ready: true,
    verified_fingerprint: verifiedFingerprint,
    probe_snapshot: snapshot,
    execution_manifest: { policySha256 },
    last_probe_ok_at: new Date(args.stale ? args.nowMs - 86_400_000 : args.nowMs - 1_000).toISOString(),
    offer_id: `offer-${args.profileId}`,
    upstream_model_id: args.upstreamModel,
    canonical_model_id: args.canonicalModel,
    label: `node-${args.nodeId}`,
    ssh_host: '127.0.0.1',
    ssh_port: 22,
    ssh_user: 'openclaude',
    host_key_fp: 'SHA256:test',
    key_id: `key-${args.nodeId}`,
    rtt_ms_p50: 12,
    node_status: 'active',
  }
}

function makeMockPlacementPool(args: {
  readonly candidates: Array<Record<string, any>>
  readonly sticky?: {
    operation_id: string
    run_id: string
    profile_id: string
    generation: string
    native_session_id: string | null
  }
  readonly usedByProfile?: Record<string, number>
  readonly pendingJournalOperationIds?: Set<string>
  readonly onInsertBinding?: (params?: unknown[]) => void
}): Pool {
  const usedMap = args.usedByProfile ?? {}
  const client = {
    async query(sql: string, params?: unknown[]) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (
        normalized === 'BEGIN' ||
        normalized === 'COMMIT' ||
        normalized === 'ROLLBACK' ||
        normalized.startsWith('SELECT pg_advisory_xact_lock')
      ) {
        return { rows: [], rowCount: 0 }
      }
      if (normalized.includes("FROM remote_agent_bindings WHERE uid = $1 AND session_key = $2 AND state <> 'released'")) {
        return { rows: [], rowCount: 0 }
      }
      if (normalized.includes('FROM remote_model_offers o')) {
        return { rows: args.candidates, rowCount: args.candidates.length }
      }
      if (normalized.includes('SELECT operation_id::text, run_id::text, profile_id::text')) {
        return args.sticky
          ? { rows: [args.sticky], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }
      if (normalized.includes('SELECT COUNT(*)::int AS profile_used')) {
        const pid = String(params?.[0] ?? '')
        return { rows: [{ profile_used: usedMap[pid] ?? 0 }], rowCount: 1 }
      }
      if (normalized.includes('FROM request_finalize_journal')) {
        const opId = String(params?.[2] ?? '')
        if (args.pendingJournalOperationIds?.has(opId)) {
          return { rows: [{ '?column?': 1 }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (normalized.startsWith('INSERT INTO remote_agent_bindings')) {
        args.onInsertBinding?.(params)
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL in mock pool: ${normalized}`)
    },
    release() {},
  }
  return {
    async connect() {
      return client
    },
  } as unknown as Pool
}

describe('OCV5-890 Wave 3: platformLocksUnlock', () => {
  it('preserves real probed vision, efforts, and adaptive thinking for remote ccb and antigravity', () => {
    const ccbRich = computeRemoteCapabilityProfileFromProbe({
      catalogEngine: 'ccb',
      baseCapabilityProfile: null,
      probedModel: {
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
        supportsAdaptiveThinking: true,
      },
    })
    assert.equal(ccbRich.supports_vision, true)
    assert.deepEqual(ccbRich.reasoning.supported, ['low', 'medium', 'high'])
    assert.equal(ccbRich.reasoning.codex_model_default, null)
    assert.equal(ccbRich.ccb.capability_zero, true)
    assert.equal(ccbRich.ccb.supports_thinking, true)
    assert.equal((ccbRich.ccb as Record<string, unknown>).context_owner, 'box-native-v1')

    const agyRich = computeRemoteCapabilityProfileFromProbe({
      catalogEngine: 'antigravity',
      baseCapabilityProfile: null,
      probedModel: {
        supportsVision: true,
        supportedEfforts: ['low', 'high'],
        supportsAdaptiveThinking: true,
      },
    })
    assert.equal(agyRich.supports_vision, true)
    assert.deepEqual(agyRich.reasoning.supported, ['low', 'high'])
    assert.equal(agyRich.ccb.capability_zero, false)
    assert.equal(agyRich.ccb.supports_thinking, true)
    assert.equal('context_owner' in agyRich.ccb, false)
  })

  it('falls back safely when probe capabilities are missing or restricted by base catalog', () => {
    const ccbEmpty = computeRemoteCapabilityProfileFromProbe({
      catalogEngine: 'ccb',
      baseCapabilityProfile: null,
      probedModel: null,
    })
    assert.equal(ccbEmpty.supports_vision, false)
    assert.deepEqual(ccbEmpty.reasoning.supported, [])
    assert.equal(ccbEmpty.ccb.supports_thinking, false)
    assert.equal(ccbEmpty.ccb.capability_zero, true)

    const ccbIntersect = computeRemoteCapabilityProfileFromProbe({
      catalogEngine: 'ccb',
      baseCapabilityProfile: {
        supports_vision: false,
        reasoning: { supported: ['medium', 'high'] },
        ccb: { supports_thinking: false },
      },
      probedModel: {
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
        supportsAdaptiveThinking: true,
      },
    })
    assert.equal(ccbIntersect.supports_vision, false)
    assert.deepEqual(ccbIntersect.reasoning.supported, ['medium', 'high'])
    assert.equal(ccbIntersect.ccb.supports_thinking, false)

    const agyFallback = computeRemoteCapabilityProfileFromProbe({
      catalogEngine: 'antigravity',
      baseCapabilityProfile: null,
      probedModel: undefined,
    })
    assert.equal(agyFallback.supports_vision, false)
    assert.deepEqual(agyFallback.reasoning.supported, ['low', 'medium', 'high'])
    assert.equal(agyFallback.ccb.supports_thinking, false)
  })

  it('computeStickyHomeKey is deterministic, format-locked, and free of op/gen noise', () => {
    const keyA = computeStickyHomeKey('agent:main:webchat:dm:session-alpha')
    const keyA2 = computeStickyHomeKey('agent:main:webchat:dm:session-alpha')
    const keyB = computeStickyHomeKey('agent:main:webchat:dm:session-beta')
    assert.equal(keyA, keyA2)
    assert.match(keyA, /^s-[a-f0-9]{16}$/)
    assert.notEqual(keyA, keyB)
  })

  it('placeRemoteDriverLane preserves default sticky fail-closed and unlocks cross-node failover with allowStickyFailover', async () => {
    const nowMs = Date.parse('2026-11-25T12:00:00.000Z')
    const staleStickyRow = makeHealthyCandidateRow({
      profileId: 'prof-dead',
      nodeId: 'node-1',
      driverId: 'antigravity',
      engine: 'antigravity',
      profileName: 'agy-1',
      canonicalModel: 'antigravity-gemini-4-carbon-remote',
      upstreamModel: 'gemini-4-carbon',
      nowMs,
      stale: true,
    })
    const healthyBackupRow = makeHealthyCandidateRow({
      profileId: 'prof-healthy',
      nodeId: 'node-2',
      driverId: 'antigravity',
      engine: 'antigravity',
      profileName: 'agy-2',
      canonicalModel: 'antigravity-gemini-4-carbon-remote',
      upstreamModel: 'gemini-4-carbon',
      nowMs,
    })
    const stickyBinding = {
      operation_id: '11111111-1111-4111-8111-111111111111',
      run_id: '22222222-2222-4222-8222-222222222222',
      profile_id: 'prof-dead',
      generation: '4',
      native_session_id: 'native-old-conv',
    }
    const baseInput = {
      uid: '42',
      containerDbId: '99',
      dockerId: 'd'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:sticky-failover-session',
      canonicalModel: 'antigravity-gemini-4-carbon-remote',
      driverId: 'antigravity',
    }
    const pool = makeMockPlacementPool({
      candidates: [staleStickyRow, healthyBackupRow],
      sticky: stickyBinding,
    })

    // 1) Default behavior (allowStickyFailover unset) keeps exact original error code
    await assert.rejects(
      () => placeRemoteDriverLane(baseInput, { pool, now: () => nowMs }),
      /REMOTE_DRIVER_PROBE_STALE/,
    )

    // 2) Explicit allowStickyFailover=true drifts seamlessly onto the healthy backup profile
    const failoverOpts: PlaceRemoteDriverLaneOptions = {
      pool,
      now: () => nowMs,
      allowStickyFailover: true,
    }
    const placed = await placeRemoteDriverLane(baseInput, failoverOpts)
    assert.equal(placed.profileUuid, 'prof-healthy')
    assert.equal(placed.nodeId, 'node-2')
    assert.equal(placed.migratedFromProfileId, 'prof-dead')
    assert.equal(placed.generation, '1')
    assert.equal(placed.spec.manifest.nativeSessionId, null)
    assert.equal(
      placed.spec.driverContext.stickyHomeKey,
      computeStickyHomeKey(baseInput.sessionKey),
    )

    // 3) Missing sticky profile (node completely gone) also fails over cleanly when authorized,
    //    and stays REMOTE_LANE_PROFILE_UNAVAILABLE when unauthorized.
    const gonePool = makeMockPlacementPool({
      candidates: [healthyBackupRow],
      sticky: stickyBinding,
    })
    await assert.rejects(
      () => placeRemoteDriverLane(baseInput, { pool: gonePool, now: () => nowMs }),
      /REMOTE_LANE_PROFILE_UNAVAILABLE/,
    )
    const placedAfterGone = await placeRemoteDriverLane(baseInput, {
      pool: gonePool,
      now: () => nowMs,
      allowStickyFailover: true,
    })
    assert.equal(placedAfterGone.profileUuid, 'prof-healthy')
    assert.equal(placedAfterGone.migratedFromProfileId, 'prof-dead')
  })

  it('placeRemoteDriverLane injects stickyHomeKey only for antigravity driver and keeps it stable', async () => {
    const nowMs = Date.parse('2026-11-25T12:00:00.000Z')
    const ccRow = makeHealthyCandidateRow({
      profileId: 'prof-cc',
      nodeId: 'node-3',
      driverId: 'cc',
      engine: 'claude-code',
      profileName: 'cc-1',
      canonicalModel: 'claude-opus-4-6-remote',
      upstreamModel: 'claude-opus-4-6',
      nowMs,
    })
    const ccPlaced = await placeRemoteDriverLane(
      {
        uid: '42',
        containerDbId: '99',
        dockerId: 'e'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:cc-no-sticky-home',
        canonicalModel: 'claude-opus-4-6-remote',
        driverId: 'cc',
      },
      {
        pool: makeMockPlacementPool({ candidates: [ccRow] }),
        now: () => nowMs,
      },
    )
    assert.equal(ccPlaced.spec.driverContext.stickyHomeKey, undefined)
  })

  it('B06: cross-node allowStickyFailover still rejects REMOTE_OPERATION_BILLING_PENDING until prior operation journal settles', async () => {
    const nowMs = Date.parse('2026-11-25T12:00:00.000Z')
    const fullStickyRow = makeHealthyCandidateRow({
      profileId: 'prof-full',
      nodeId: 'node-1',
      driverId: 'cc',
      engine: 'claude-code',
      profileName: 'cc-full',
      canonicalModel: 'claude-opus-4-6-remote',
      upstreamModel: 'claude-opus-4-6',
      nowMs,
    })
    const healthyBackupRow = makeHealthyCandidateRow({
      profileId: 'prof-backup',
      nodeId: 'node-2',
      driverId: 'cc',
      engine: 'claude-code',
      profileName: 'cc-backup',
      canonicalModel: 'claude-opus-4-6-remote',
      upstreamModel: 'claude-opus-4-6',
      nowMs,
    })
    const priorOperationId = '33333333-3333-4333-8333-333333333333'
    const stickyBinding = {
      operation_id: priorOperationId,
      run_id: '44444444-4444-4444-8444-444444444444',
      profile_id: 'prof-full',
      generation: '2',
      native_session_id: 'native-cc-old',
    }
    const pendingOps = new Set<string>([priorOperationId])
    let insertCount = 0
    const pool = makeMockPlacementPool({
      candidates: [fullStickyRow, healthyBackupRow],
      sticky: stickyBinding,
      usedByProfile: { 'prof-full': 5, 'prof-backup': 0 },
      pendingJournalOperationIds: pendingOps,
      onInsertBinding: () => {
        insertCount += 1
      },
    })
    const input = {
      uid: '42',
      containerDbId: '99',
      dockerId: 'f'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:b06-pending-billing-fence',
      canonicalModel: 'claude-opus-4-6-remote',
      driverId: 'cc',
    }

    // 1) Old binding is released, old profile is full, backup profile is available,
    //    allowStickyFailover=true, BUT prior operation still has an inflight journal -> MUST reject!
    await assert.rejects(
      () =>
        placeRemoteDriverLane(input, {
          pool,
          now: () => nowMs,
          allowStickyFailover: true,
        }),
      /REMOTE_OPERATION_BILLING_PENDING/,
    )
    assert.equal(insertCount, 0)

    // 2) Once prior operation's billing journal reaches terminal state, failover succeeds
    //    and admits a brand-new operation on the backup profile.
    pendingOps.clear()
    const placed = await placeRemoteDriverLane(input, {
      pool,
      now: () => nowMs,
      allowStickyFailover: true,
    })
    assert.equal(insertCount, 1)
    assert.equal(placed.profileUuid, 'prof-backup')
    assert.equal(placed.nodeId, 'node-2')
    assert.equal(placed.migratedFromProfileId, 'prof-full')
    assert.notEqual(placed.binding.operationId, priorOperationId)
    assert.equal(placed.generation, '1')
  })

  it('B06-R2: with 0 eligible remote profiles and unsettled sticky journal, rejects REMOTE_OPERATION_BILLING_PENDING BEFORE REMOTE_LANE_PROFILE_UNAVAILABLE', async () => {
    const nowMs = Date.parse('2026-11-25T12:00:00.000Z')
    const priorOperationId = '55555555-5555-4555-8555-555555555555'
    const stickyBinding = {
      operation_id: priorOperationId,
      run_id: '66666666-6666-4666-8666-666666666666',
      profile_id: 'prof-offline',
      generation: '3',
      native_session_id: 'native-cc-offline',
    }
    const pool = makeMockPlacementPool({
      candidates: [],
      sticky: stickyBinding,
      pendingJournalOperationIds: new Set([priorOperationId]),
    })
    await assert.rejects(
      () =>
        placeRemoteDriverLane(
          {
            uid: '42',
            containerDbId: '99',
            dockerId: 'e'.repeat(64),
            sessionKey: 'agent:main:webchat:dm:b06-zero-candidates',
            canonicalModel: 'claude-opus-4-6-remote',
            driverId: 'cc',
          },
          { pool, now: () => nowMs, allowStickyFailover: true },
        ),
      /REMOTE_OPERATION_BILLING_PENDING/,
    )
  })
})
