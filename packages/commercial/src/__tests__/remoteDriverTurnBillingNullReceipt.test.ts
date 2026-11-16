/**
 * Contract & isolated-PG tests for `recoverRemoteDriverTurnBilling` null-receipt dead-turn abort
 * (`OCV5-777` / `INC-20261117-CC5-BASH-TIMEOUT-PS-ENOENT`):
 * 1. Still-live `remote-driver-v4` turns (`input !== null`, `receipt === null`) stay `'inflight'`
 *    and rotate `updated_at` without releasing Redis soft reservation.
 * 2. Proven-dead `per_turn` turns (`00000014-stopped.json` + `released` binding / terminal crash)
 *    abort cleanly at 0 credits, clear `remote_native_threads.pending_request_id` so subsequent
 *    turns on the chat do not fail with `REMOTE_SESSION_BOUNDARY_BUSY_OR_MISMATCH`, and release
 *    Redis soft reservation.
 * 3. Proven-dead `cumulative` dispatched turns abort `request_finalize_journal` to unblock
 *    selfhost release drain while keeping `pending_request_id` intact against unmeasured rollout deltas;
 *    `cumulative` pre-dispatch turns clear `pending_request_id` iff `total === baseline`.
 * 4. Completed dispatch outcomes (`d.outcome = 'completed'`) or existing `usage_records` never abort.
 * 5. Sub-grace rotation (`updated_at` touched repeatedly before grace elapses) still converges once
 *    `COALESCE(b.updated_at, j0.created_at)` crosses `nullReceiptGraceMs`.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { REMOTE_DRIVER_BACKEND, type RemoteDriverUsagePolicy } from '@openclaude/protocol'
import { Pool } from 'pg'
import type { PreCheckRedis } from '../billing/preCheck.js'
import {
  REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
  recoverRemoteDriverTurnBilling,
} from '../billing/remoteDriverTurnBilling.js'
import { createLogger } from '../logging/logger.js'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const PROFILE_ID = '33333333-3333-4333-8333-333333333333'
const DISPATCH_ID = '44444444-4444-4444-8444-444444444444'
const NATIVE_SESSION_ID = '55555555-5555-4555-8555-555555555555'
const CANONICAL_MODEL = 'claude-opus-5-5-remote'

const CC_USAGE_POLICY: RemoteDriverUsagePolicy = {
  semanticsId: 'cc-result-per-turn-v1',
  mode: 'per_turn',
  inputField: 'input_tokens',
  outputField: 'output_tokens',
  cacheReadField: 'cache_read_input_tokens',
  cacheWriteField: 'cache_creation_input_tokens',
  inputIncludesCacheRead: false,
  outputIncludesReasoning: true,
  allowCacheWrite: true,
}

const CODEX_USAGE_POLICY: RemoteDriverUsagePolicy = {
  semanticsId: 'codex-thread-total-v1',
  mode: 'cumulative',
  inputField: 'inputTokens',
  outputField: 'outputTokens',
  cacheReadField: 'cachedInputTokens',
  cacheWriteField: 'cacheWriteInputTokens',
  reasoningField: 'reasoningOutputTokens',
  inputIncludesCacheRead: true,
  outputIncludesReasoning: true,
  allowCacheWrite: false,
}

const ZERO_CODEX_TOTAL = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
}

function makeJournalContext(options: {
  requestId: string
  mode: 'per_turn' | 'cumulative'
  dispatched?: boolean
  generation?: string
}) {
  const isCumulative = options.mode === 'cumulative'
  return {
    v: 4 as const,
    scope: {
      version: 4 as const,
      backendKind: REMOTE_DRIVER_BACKEND,
      operationId: OPERATION_ID,
      runId: RUN_ID,
      uid: '42',
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:ocv5_777_null_receipt',
      canonicalModel: CANONICAL_MODEL,
      upstreamModel: 'claude-opus-5-5',
      driverId: isCumulative ? 'codex' : 'cc',
      engineId: isCumulative ? 'codex' : 'claude-code',
      authorityEngine: isCumulative ? ('codex' as const) : ('ccb' as const),
      driverVersion: '4.0.0',
      driverDigest: 'b'.repeat(64),
      coreDigest: 'c'.repeat(64),
      probeFingerprint: 'd'.repeat(64),
      manifestSha256: 'e'.repeat(64),
      generation: options.generation ?? '1',
      profileId: PROFILE_ID,
      authEpoch: 'epoch-1',
      expiresAt: Date.now() + 3_600_000,
    },
    requestId: options.requestId,
    turnKey: 'f'.repeat(64),
    authorityTurnId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    dispatchId: DISPATCH_ID,
    attemptNo: 1,
    sessionId: 'ocv5_777_null_receipt',
    pricing: {
      v: 1 as const,
      modelId: CANONICAL_MODEL,
      displayName: CANONICAL_MODEL,
      inputPerMtok: '600',
      outputPerMtok: '2400',
      cacheReadPerMtok: '120',
      cacheWritePerMtok: '750',
      multiplier: '1.000',
    },
    billingRevision: 'rev-1',
    authority: {
      kind: 'bridge_signed' as const,
      executionRevision: 'exec-rev-1',
      projectionRevision: null,
      securityEpoch: '5',
    },
    usagePolicy: isCumulative ? CODEX_USAGE_POLICY : CC_USAGE_POLICY,
    hostStartAttempted: true,
    input:
      options.dispatched === false
        ? null
        : {
            sequence: 1,
            inputSha256: '9'.repeat(64),
          },
    native: {
      sessionId: NATIVE_SESSION_ID,
      baseline: isCumulative ? { ...ZERO_CODEX_TOTAL } : null,
    },
    receipt: null,
    reserved: true,
    reservedCredits: '100',
  }
}

test('offline contract: recoverRemoteDriverTurnBilling rotates live turns, aborts proven-dead null-receipt turns, and clears per_turn thread claim only (OCV5-777)', async () => {
  const tmpRoot = mkdtempSync('/tmp/ocv5-777-v4-null-')
  try {
    const journalDir = join(tmpRoot, OPERATION_ID, '1', 'journal')
    mkdirSync(journalDir, { recursive: true, mode: 0o700 })

    let releasedReservations = 0
    const redis = {
      async releaseReservation() {
        releasedReservations += 1
        return true
      },
    } as unknown as PreCheckRedis

    let dead = false
    let rotateCount = 0
    let lastAbortParams: unknown[] | undefined
    let lastAbortSql = ''
    let currentCtx = makeJournalContext({ requestId: 'req_per_turn_1', mode: 'per_turn' })

    const fakePool = {
      async query(sql: string, params?: unknown[]) {
        if (sql.includes('remote-driver-v4:recovery-scan')) {
          return {
            rows: [
              {
                request_id: currentCtx.requestId,
                user_id: '42',
                state: 'inflight',
                ctx: {
                  remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                  remoteDriverV4: currentCtx,
                },
                updated_at: new Date(),
              },
            ],
          }
        }
        if (sql.includes('remote-driver-v4:null-receipt-abort')) {
          lastAbortSql = sql
          lastAbortParams = params
          return { rows: [{ aborted_count: dead ? 1 : 0 }], rowCount: 1 }
        }
        if (sql.includes('SET updated_at = NOW()')) {
          rotateCount += 1
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`unexpected SQL in offline test: ${sql}`)
      },
    } as unknown as Pool

    const log = createLogger({ out: () => undefined })

    // 1. Live turn (no stopped.json, dead=false): rotates updated_at, stays pending, keeps reservation.
    assert.deepEqual(
      await recoverRemoteDriverTurnBilling(
        { pool: fakePool, preCheckRedis: redis, log },
        { evidenceRoot: tmpRoot },
      ),
      { proven: 0, pending: 1 },
    )
    assert.equal(rotateCount, 1)
    assert.equal(releasedReservations, 0)
    assert.equal(
      lastAbortParams?.[6],
      false,
      'hasStoppedJournal must be false before stopped.json exists',
    )
    assert.ok(lastAbortSql.includes("d.outcome IS DISTINCT FROM 'completed'"))
    assert.ok(lastAbortSql.includes('COALESCE(b.updated_at, j0.created_at)'))
    assert.ok(lastAbortSql.includes('NOT EXISTS'))

    // 2. Write durable 00000014-stopped.json and mark dead=true for per_turn: aborts + clears pending_request_id + releases reservation.
    const stoppedPath = join(journalDir, '00000014-stopped.json')
    writeFileSync(stoppedPath, JSON.stringify({ remoteStopped: true }), { mode: 0o600 })
    chmodSync(stoppedPath, 0o600)
    dead = true

    assert.deepEqual(
      await recoverRemoteDriverTurnBilling(
        { pool: fakePool, preCheckRedis: redis, log },
        { evidenceRoot: tmpRoot },
      ),
      { proven: 1, pending: 0 },
    )
    assert.equal(releasedReservations, 1)
    assert.equal(
      lastAbortParams?.[6],
      true,
      'hasStoppedJournal must be true when 00000014-stopped.json has remoteStopped=true',
    )
    assert.equal(
      lastAbortParams?.[14],
      true,
      'per_turn mode must clear remote_native_threads.pending_request_id',
    )
    assert.equal(lastAbortParams?.[15], NATIVE_SESSION_ID)

    // 3. Cumulative dispatched dead turn: aborts journal (`proven: 1`) while keeping clearPendingOwner=false.
    currentCtx = makeJournalContext({
      requestId: 'req_cum_1',
      mode: 'cumulative',
      dispatched: true,
    })
    assert.deepEqual(
      await recoverRemoteDriverTurnBilling(
        { pool: fakePool, preCheckRedis: redis, log },
        { evidenceRoot: tmpRoot },
      ),
      { proven: 1, pending: 0 },
    )
    assert.equal(releasedReservations, 2)
    assert.equal(
      lastAbortParams?.[14],
      false,
      'cumulative dispatched turn must keep pending_request_id fail-closed',
    )
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

const PG_REQUIRED = process.env.REQUIRE_TEST_DB === '1' || process.env.CI === 'true'
const PG_TEST_URL = process.env.NATIVE_FINANCE_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL

test(
  'isolated PG: recoverRemoteDriverTurnBilling executes CTE SQL end-to-end against real PostgreSQL tables (OCV5-777)',
  { skip: !PG_REQUIRED && !PG_TEST_URL },
  async () => {
    assert.ok(PG_TEST_URL, 'explicit PostgreSQL test URL required')
    const target = new URL(PG_TEST_URL)
    assert.ok(
      decodeURIComponent(target.pathname.slice(1)).endsWith('_test'),
      'database name must end in _test',
    )

    const tmpRoot = mkdtempSync('/tmp/ocv5-777-v4-pg-')
    const schema = `v4_null_receipt_${process.pid}_${randomBytes(6).toString('hex')}`
    const real = new Pool({ connectionString: PG_TEST_URL, max: 2 })
    let created = false
    try {
      await real.query(`CREATE SCHEMA ${schema}`)
      created = true
      await real.query(`
        CREATE TABLE ${schema}.request_finalize_journal (
          request_id TEXT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          state TEXT NOT NULL,
          final_credits BIGINT,
          failure_code TEXT,
          error_msg TEXT,
          ctx JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${schema}.turn_dispatches (
          dispatch_id UUID PRIMARY KEY,
          user_id BIGINT NOT NULL,
          attempt_no INTEGER NOT NULL,
          status TEXT NOT NULL,
          outcome TEXT,
          failure_code TEXT,
          terminal_at TIMESTAMPTZ,
          producer_fenced_at TIMESTAMPTZ
        );
        CREATE TABLE ${schema}.agent_containers (
          id BIGINT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          state TEXT NOT NULL,
          runtime_kind TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${schema}.remote_agent_bindings (
          operation_id UUID NOT NULL,
          generation BIGINT NOT NULL,
          remote_protocol_version INTEGER NOT NULL,
          state TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (operation_id, generation)
        );
        CREATE TABLE ${schema}.remote_native_threads (
          uid BIGINT NOT NULL,
          operation_id UUID NOT NULL,
          native_thread_id TEXT NOT NULL,
          pending_request_id TEXT,
          total JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (uid, operation_id, native_thread_id)
        );
        CREATE TABLE ${schema}.usage_records (
          request_id TEXT NOT NULL,
          user_id BIGINT NOT NULL
        );
      `)

      const scopedPool = {
        async query(sql: string, params?: unknown[]) {
          const client = await real.connect()
          try {
            await client.query(`SET search_path TO ${schema}`)
            return await client.query(sql, params)
          } finally {
            client.release()
          }
        },
      } as unknown as Pool

      let releases = 0
      const redis = {
        async releaseReservation() {
          releases += 1
          return true
        },
      } as unknown as PreCheckRedis
      const log = createLogger({ out: () => undefined })

      const ctx = makeJournalContext({
        requestId: 'req_pg_live_then_dead',
        mode: 'per_turn',
        dispatched: true,
      })
      await real.query(
        `INSERT INTO ${schema}.request_finalize_journal (request_id, user_id, state, ctx)
         VALUES ($1, 42, 'inflight', $2::jsonb)`,
        [
          ctx.requestId,
          JSON.stringify({
            remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
            remoteDriverV4: ctx,
          }),
        ],
      )
      await real.query(
        `INSERT INTO ${schema}.turn_dispatches (dispatch_id, user_id, attempt_no, status, outcome)
         VALUES ($1::uuid, 42, 1, 'accepted', NULL)`,
        [DISPATCH_ID],
      )
      await real.query(
        `INSERT INTO ${schema}.agent_containers (id, user_id, state, runtime_kind)
         VALUES (7, 42, 'active', 'docker')`,
      )
      await real.query(
        `INSERT INTO ${schema}.remote_agent_bindings (operation_id, generation, remote_protocol_version, state, expires_at)
         VALUES ($1::uuid, 1, 4, 'running', NOW() + INTERVAL '1 hour')`,
        [OPERATION_ID],
      )
      await real.query(
        `INSERT INTO ${schema}.remote_native_threads (uid, operation_id, native_thread_id, pending_request_id, total)
         VALUES (42, $1::uuid, $2, $3, '{"input_tokens":0}'::jsonb)`,
        [OPERATION_ID, NATIVE_SESSION_ID, ctx.requestId],
      )

      // 1. Still live -> pending: 1
      assert.deepEqual(
        await recoverRemoteDriverTurnBilling(
          { pool: scopedPool, preCheckRedis: redis, log },
          { evidenceRoot: tmpRoot },
        ),
        { proven: 0, pending: 1 },
      )
      assert.equal(releases, 0)

      // 2. Completed outcome guard -> even with released binding + stopped.json, never aborts!
      const journalDir = join(tmpRoot, OPERATION_ID, '1', 'journal')
      mkdirSync(journalDir, { recursive: true, mode: 0o700 })
      const stoppedPath = join(journalDir, '00000014-stopped.json')
      writeFileSync(stoppedPath, JSON.stringify({ remoteStopped: true }), { mode: 0o600 })
      chmodSync(stoppedPath, 0o600)
      await real.query(`UPDATE ${schema}.remote_agent_bindings SET state = 'released'`)
      await real.query(
        `UPDATE ${schema}.turn_dispatches SET status = 'terminal', outcome = 'completed', terminal_at = NOW()`,
      )
      assert.deepEqual(
        await recoverRemoteDriverTurnBilling(
          { pool: scopedPool, preCheckRedis: redis, log },
          { evidenceRoot: tmpRoot },
        ),
        { proven: 0, pending: 1 },
      )

      // 3. Existing usage_records guard -> even when outcome is executed_error, never aborts!
      await real.query(
        `UPDATE ${schema}.turn_dispatches SET outcome = 'executed_error', failure_code = 'CC5_TOOLHOST_EXECUTION_UNKNOWN'`,
      )
      await real.query(
        `INSERT INTO ${schema}.usage_records (request_id, user_id) VALUES ($1, 42)`,
        [ctx.requestId],
      )
      assert.deepEqual(
        await recoverRemoteDriverTurnBilling(
          { pool: scopedPool, preCheckRedis: redis, log },
          { evidenceRoot: tmpRoot },
        ),
        { proven: 0, pending: 1 },
      )
      assert.equal(releases, 0)
      await real.query(`DELETE FROM ${schema}.usage_records WHERE request_id = $1`, [ctx.requestId])

      // 4. Terminal executed_error + released binding + stopped.json -> aborts at 0 credits & clears per_turn thread claim!
      assert.deepEqual(
        await recoverRemoteDriverTurnBilling(
          { pool: scopedPool, preCheckRedis: redis, log },
          { evidenceRoot: tmpRoot },
        ),
        { proven: 1, pending: 0 },
      )
      assert.equal(releases, 1)

      const jRow = (
        await real.query(
          `SELECT state, final_credits::text, failure_code, error_msg FROM ${schema}.request_finalize_journal WHERE request_id = $1`,
          [ctx.requestId],
        )
      ).rows[0]
      assert.deepEqual(jRow, {
        state: 'aborted',
        final_credits: '0',
        failure_code: 'INTERNAL_ERROR',
        error_msg: 'remote_driver_v4_terminal_null_receipt',
      })
      const thRow = (
        await real.query(
          `SELECT pending_request_id FROM ${schema}.remote_native_threads WHERE operation_id = $1::uuid`,
          [OPERATION_ID],
        )
      ).rows[0]
      assert.equal(thRow.pending_request_id, null)

      // 5. Cumulative dispatched dead turn -> aborts journal (`proven: 1`) while retaining `pending_request_id`.
      const cumDispCtx = makeJournalContext({
        requestId: 'req_pg_cum_dispatched',
        mode: 'cumulative',
        dispatched: true,
        generation: '2',
      })
      await real.query(
        `INSERT INTO ${schema}.remote_agent_bindings (operation_id, generation, remote_protocol_version, state, expires_at)
         VALUES ($1::uuid, 2, 4, 'released', NOW() + INTERVAL '1 hour')`,
        [OPERATION_ID],
      )
      await real.query(
        `UPDATE ${schema}.remote_native_threads SET pending_request_id = $2, total = $3::jsonb WHERE operation_id = $1::uuid`,
        [OPERATION_ID, cumDispCtx.requestId, JSON.stringify(ZERO_CODEX_TOTAL)],
      )
      await real.query(
        `INSERT INTO ${schema}.request_finalize_journal (request_id, user_id, state, ctx)
         VALUES ($1, 42, 'inflight', $2::jsonb)`,
        [
          cumDispCtx.requestId,
          JSON.stringify({
            remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
            remoteDriverV4: cumDispCtx,
          }),
        ],
      )
      assert.deepEqual(
        await recoverRemoteDriverTurnBilling(
          { pool: scopedPool, preCheckRedis: redis, log },
          { evidenceRoot: tmpRoot },
        ),
        { proven: 1, pending: 0 },
      )
      assert.equal(
        (
          await real.query(
            `SELECT pending_request_id FROM ${schema}.remote_native_threads WHERE operation_id = $1::uuid`,
            [OPERATION_ID],
          )
        ).rows[0].pending_request_id,
        cumDispCtx.requestId,
        'cumulative dispatched dead turn must retain pending_request_id',
      )

      // 6. Cumulative pre-dispatch (`input: null`) sub-grace rotation + baseline match/mismatch guard:
      //    No stopped.json and non-terminal dispatch -> rotates while binding age < grace, then converges
      //    once binding age crosses grace even after repeated journal updated_at rotations (`W3`).
      const cumPreMismatch = makeJournalContext({
        requestId: 'req_pg_cum_pre_mismatch',
        mode: 'cumulative',
        dispatched: false,
        generation: '3',
      })
      await real.query(
        `UPDATE ${schema}.turn_dispatches SET status = 'accepted', outcome = NULL, failure_code = NULL, terminal_at = NULL`,
      )
      await real.query(
        `INSERT INTO ${schema}.remote_agent_bindings (operation_id, generation, remote_protocol_version, state, expires_at, updated_at)
         VALUES ($1::uuid, 3, 4, 'released', NOW() + INTERVAL '1 hour', NOW())`,
        [OPERATION_ID],
      )
      await real.query(
        `UPDATE ${schema}.remote_native_threads
            SET pending_request_id = $2,
                total = '{"inputTokens":99,"outputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"reasoningOutputTokens":0}'::jsonb
          WHERE operation_id = $1::uuid`,
        [OPERATION_ID, cumPreMismatch.requestId],
      )
      await real.query(
        `INSERT INTO ${schema}.request_finalize_journal (request_id, user_id, state, ctx)
         VALUES ($1, 42, 'inflight', $2::jsonb)`,
        [
          cumPreMismatch.requestId,
          JSON.stringify({
            remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
            remoteDriverV4: cumPreMismatch,
          }),
        ],
      )

      // Sub-grace rotation pass 1 & 2 (grace=500ms, binding updated_at=NOW()): rotates j0.updated_at, stays pending
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(
          await recoverRemoteDriverTurnBilling(
            { pool: scopedPool, preCheckRedis: redis, log },
            { evidenceRoot: tmpRoot, nullReceiptGraceMs: 500 },
          ),
          { proven: 0, pending: 1 },
        )
      }

      // Advance binding updated_at past 500ms while j0.updated_at was just rotated to NOW():
      // COALESCE(b.updated_at, j0.created_at) still converges! And mismatched total keeps pending_request_id set.
      await real.query(
        `UPDATE ${schema}.remote_agent_bindings SET updated_at = NOW() - INTERVAL '2 seconds' WHERE generation = 3`,
      )
      assert.deepEqual(
        await recoverRemoteDriverTurnBilling(
          { pool: scopedPool, preCheckRedis: redis, log },
          { evidenceRoot: tmpRoot, nullReceiptGraceMs: 500 },
        ),
        { proven: 1, pending: 0 },
      )
      assert.equal(
        (
          await real.query(
            `SELECT pending_request_id FROM ${schema}.remote_native_threads WHERE operation_id = $1::uuid`,
            [OPERATION_ID],
          )
        ).rows[0].pending_request_id,
        cumPreMismatch.requestId,
        'mismatched cumulative baseline must not clear pending_request_id',
      )

      // Matching cumulative baseline on pre-dispatch dead turn clears pending_request_id cleanly!
      const cumPreMatch = makeJournalContext({
        requestId: 'req_pg_cum_pre_match',
        mode: 'cumulative',
        dispatched: false,
        generation: '3',
      })
      await real.query(
        `UPDATE ${schema}.remote_native_threads SET pending_request_id = $2, total = $3::jsonb WHERE operation_id = $1::uuid`,
        [OPERATION_ID, cumPreMatch.requestId, JSON.stringify(ZERO_CODEX_TOTAL)],
      )
      await real.query(
        `INSERT INTO ${schema}.request_finalize_journal (request_id, user_id, state, ctx)
         VALUES ($1, 42, 'inflight', $2::jsonb)`,
        [
          cumPreMatch.requestId,
          JSON.stringify({
            remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
            remoteDriverV4: cumPreMatch,
          }),
        ],
      )
      assert.deepEqual(
        await recoverRemoteDriverTurnBilling(
          { pool: scopedPool, preCheckRedis: redis, log },
          { evidenceRoot: tmpRoot, nullReceiptGraceMs: 500 },
        ),
        { proven: 1, pending: 0 },
      )
      assert.equal(
        (
          await real.query(
            `SELECT pending_request_id FROM ${schema}.remote_native_threads WHERE operation_id = $1::uuid`,
            [OPERATION_ID],
          )
        ).rows[0].pending_request_id,
        null,
        'matching cumulative baseline on pre-dispatch dead turn clears pending_request_id',
      )
    } finally {
      try {
        if (created) await real.query(`DROP SCHEMA ${schema} CASCADE`)
      } finally {
        await real.end()
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    }
  },
)
