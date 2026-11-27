import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlacementMigrationRecord } from '@openclaude/protocol/storage-seam'
import {
  AUDIT_RETENTION_POLICIES,
  type RetentionPolicy,
  resolveRetentionPolicies,
  startAuditRetentionSweeper,
} from '../admin/auditRetention.js'
import { RETENTION_REGISTRY } from '../admin/retentionRegistry.js'
import {
  MigrationCoordinator,
  type MigrationAuthorityStorePort,
  type PendingCredentialReconciliationRecord,
  type PendingCredentialReconciliationStore,
} from '../account-pool/remotePool/migrationCoordinator.js'

function makeInMemoryReconcileStore(
  initial: PendingCredentialReconciliationRecord[],
): PendingCredentialReconciliationStore {
  const map = new Map<string, PendingCredentialReconciliationRecord>(
    initial.map((r) => [r.migrationId, r]),
  )
  return {
    put(rec) {
      map.set(rec.migrationId, rec)
    },
    get(id) {
      return map.get(id) ?? null
    },
    delete(id) {
      map.delete(id)
    },
    list() {
      return [...map.values()]
    },
  }
}

describe('OCV5-913 Steward R1 B2: session_placement_migrations survives retention sweep for crash recovery', () => {
  it('registers session_placement_migrations as durable and excludes it from TTL resolution even with overrides', (t) => {
    t.mock.method(console, 'warn', () => undefined)
    assert.deepEqual(RETENTION_REGISTRY.session_placement_migrations, { kind: 'durable' })
    assert.deepEqual(RETENTION_REGISTRY.artifact_blob_uploads, { kind: 'ttl' })
    assert.equal(
      AUDIT_RETENTION_POLICIES.some((p) => p.table === 'session_placement_migrations'),
      false,
    )
    const policies = resolveRetentionPolicies('session_placement_migrations=1,artifact_blob_uploads=7')
    assert.equal(
      policies.some((p) => p.table === 'session_placement_migrations'),
      false,
      'override must never add session_placement_migrations to TTL deletion',
    )
    const uploadPolicy = policies.find((p) => p.table === 'artifact_blob_uploads')
    assert.equal(uploadPolicy?.days, 7)
  })

  it('reconciles both committed and aborted terminal migrations after a full retention sweep + coordinator restart', async () => {
    const oldCreatedAt = '2026-07-01T00:00:00.000Z' // > 120d old: would have been deleted by a 90d created_at TTL
    const committedId = 'mig-committed-after-sweep'
    const abortedId = 'mig-aborted-after-sweep'

    const localPlacement = {
      poolKind: 'local_container' as const,
      engine: 'codex' as const,
      driverId: 'codex',
      placementEpoch: 1,
    }
    const remotePlacement1 = {
      poolKind: 'remote_pool' as const,
      engine: 'codex' as const,
      driverId: 'codex',
      placementEpoch: 2,
      profileId: 'prof-remote-1',
    }
    const remotePlacement2 = {
      poolKind: 'remote_pool' as const,
      engine: 'codex' as const,
      driverId: 'codex',
      placementEpoch: 2,
      profileId: 'prof-remote-2',
    }

    const migrations = new Map<string, PlacementMigrationRecord>([
      [
        committedId,
        {
          migrationId: committedId,
          tenantId: '42',
          sessionKey: 'sess:sweep:committed',
          fromEpoch: 1,
          toEpoch: 2,
          fromPlacement: localPlacement,
          toPlacement: remotePlacement1,
          state: 'committed',
          createdAt: oldCreatedAt,
          completedAt: '2026-11-27T08:00:00.000Z',
        },
      ],
      [
        abortedId,
        {
          migrationId: abortedId,
          tenantId: '42',
          sessionKey: 'sess:sweep:aborted',
          fromEpoch: 1,
          toEpoch: 2,
          fromPlacement: localPlacement,
          toPlacement: remotePlacement2,
          state: 'aborted',
          createdAt: oldCreatedAt,
          completedAt: '2026-11-27T08:00:00.000Z',
        },
      ],
    ])
    const uploadRows = new Map<string, { status: string; updatedAt: string }>([
      ['upl-old-completed', { status: 'completed', updatedAt: oldCreatedAt }],
    ])

    // Simulate a real retention sweep tick applying every resolved TTL policy.
    const sweptTables: string[] = []
    const sweeper = startAuditRetentionSweeper({
      intervalMs: 3_600_000,
      purgeFn: async (policy: RetentionPolicy) => {
        sweptTables.push(policy.table)
        if (policy.table === 'session_placement_migrations') {
          const count = migrations.size
          migrations.clear()
          return count
        }
        if (policy.table === 'artifact_blob_uploads') {
          const count = uploadRows.size
          uploadRows.clear()
          return count
        }
        return 0
      },
      sessionGoalsPurgeFn: async () => 0,
      wechatAuditPurgeFn: async () => 0,
    })
    try {
      const counts = await sweeper.runNow()
      assert.equal(counts.artifact_blob_uploads, 1)
      assert.equal(sweptTables.includes('session_placement_migrations'), false)
      assert.equal(migrations.size, 2, 'authoritative migration rows must survive retention sweep')
    } finally {
      await sweeper.stop()
    }

    // Pending WAL intents persisted before crash (pgDecision not yet written back locally).
    const pendingStore = makeInMemoryReconcileStore([
      {
        migrationId: committedId,
        userId: 42,
        sessionKey: 'sess:sweep:committed',
        fromEpoch: 1,
        toEpoch: 2,
        fromPlacement: localPlacement,
        toPlacement: remotePlacement1,
        execEnvLeaseId: 'exec-1',
        currentBrainGen: 1,
        targetBrainGen: 2,
        targetFencingToken: 'ft-2',
        sourceCredentialLeaseId: 'cred-src-1',
        targetCredentialLease: {
          leaseId: 'cred-dst-1',
          tenantId: '42',
          profileId: 'prof-remote-1',
          engine: 'codex',
          mountKind: 'memfd_or_tmpfs',
          noRefreshToken: true,
          issuedAt: '2026-11-27T07:59:00.000Z',
          expiresAt: '2026-11-27T08:15:00.000Z',
        },
        pgDecision: 'unknown',
        sourceLeaseRevoked: false,
        targetLeaseRevoked: false,
        sourceExecEnvRestored: false,
        sourceQuiesced: true,
        reason: 'post_commit_crash_before_wal_ack',
        recordedAt: '2026-11-27T07:59:00.000Z',
      },
      {
        migrationId: abortedId,
        userId: 42,
        sessionKey: 'sess:sweep:aborted',
        fromEpoch: 1,
        toEpoch: 2,
        fromPlacement: localPlacement,
        toPlacement: remotePlacement2,
        execEnvLeaseId: 'exec-2',
        currentBrainGen: 3,
        targetBrainGen: 4,
        targetFencingToken: 'ft-4',
        sourceCredentialLeaseId: 'cred-src-2',
        targetCredentialLease: {
          leaseId: 'cred-dst-2',
          tenantId: '42',
          profileId: 'prof-remote-2',
          engine: 'codex',
          mountKind: 'memfd_or_tmpfs',
          noRefreshToken: true,
          issuedAt: '2026-11-27T07:59:00.000Z',
          expiresAt: '2026-11-27T08:15:00.000Z',
        },
        pgDecision: 'unknown',
        sourceLeaseRevoked: false,
        targetLeaseRevoked: false,
        sourceExecEnvRestored: false,
        sourceQuiesced: true,
        reason: 'post_abort_crash_before_wal_ack',
        recordedAt: '2026-11-27T07:59:00.000Z',
      },
    ])

    const revokedLeases: string[] = []
    const restoredExecEnvs: Array<{ leaseId: string; nextBrainGen: number }> = []
    const authorityStore: MigrationAuthorityStorePort = {
      async beginPlacementMigration() {
        throw new Error('unused')
      },
      async commitPlacementMigration() {
        throw new Error('unused')
      },
      async abortPlacementMigration() {
        throw new Error('unused')
      },
      async saveRollingCheckpoint() {
        throw new Error('unused')
      },
      async getPlacementMigration(id: string) {
        return migrations.get(id) ?? null
      },
    }

    // Fresh coordinator simulates restart after the retention sweep.
    const restartedCoordinator = new MigrationCoordinator({
      authorityStore,
      pendingReconciliationStore: pendingStore,
      capsuleStore: {
        async exportCapsule() {
          return { ok: false, reason: 'unused' }
        },
        async importCapsule() {
          return { ok: false, reason: 'unused' }
        },
        async degradeToTranscript() {
          return { ok: false, reason: 'unused' }
        },
      },
      execEnv: {
        async quiesce() {
          return { quiesced: true, activeToolCalls: 0 }
        },
        async exportAttachmentDigest() {
          throw new Error('unused')
        },
        async rebindBrain(args) {
          restoredExecEnvs.push({ leaseId: args.leaseId, nextBrainGen: args.nextBrainGen })
          return { ok: true, brainGen: args.nextBrainGen, fencingToken: args.nextFencingToken }
        },
      },
      credentialLeases: {
        async issueLease() {
          throw new Error('unused')
        },
        async revokeLease(leaseId) {
          revokedLeases.push(leaseId)
          return true
        },
      },
      drivers: {
        async stopLane() {
          return { stopped: true, reachable: true }
        },
        async prewarm() {
          return { ready: true }
        },
      },
    })

    const committedRes = await restartedCoordinator.reconcilePendingCredentialCleanup(committedId)
    assert.ok(committedRes)
    assert.equal(committedRes.status, 'committed')
    assert.equal(committedRes.stillPending, false)
    assert.equal(committedRes.fullyConverged, true)
    assert.equal(pendingStore.get(committedId), null)

    const abortedRes = await restartedCoordinator.reconcilePendingCredentialCleanup(abortedId)
    assert.ok(abortedRes)
    assert.equal(abortedRes.status, 'aborted')
    assert.equal(abortedRes.stillPending, false)
    assert.equal(abortedRes.fullyConverged, true)
    assert.equal(pendingStore.get(abortedId), null)

    assert.deepEqual(revokedLeases, ['cred-src-1', 'cred-dst-2'])
    assert.deepEqual(restoredExecEnvs, [{ leaseId: 'exec-2', nextBrainGen: 5 }])
  })
})
