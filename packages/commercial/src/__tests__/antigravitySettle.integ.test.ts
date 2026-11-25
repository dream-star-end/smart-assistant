import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { hashSecret } from '../auth/containerIdentity.js'
import { makeAntigravityRelayHandler, ANTIGRAVITY_RELAY_PREFIX } from '../http/internalAntigravityRelay.js'
import { makeDelegateAntigravityRouteHandler, DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH } from '../http/internalDelegateAntigravityRoute.js'
import { renewAntigravityRouteLease } from '../../../gateway/src/delegateAntigravityRoute.js'
import { createHash, randomUUID } from 'node:crypto'
import IORedis from 'ioredis'
import { readAntigravityRouteAuthority } from '../billing/antigravityRouteAuthority.js'
import {
  _resetAntigravityRelayRoutesForTests, configureAntigravityRelayKv,
  configureAntigravityRelayAuthority, createIoredisAntigravityRelayKv,
  mintAntigravityRelayRoute, resolveAntigravityRelayRoute,
  expireAntigravityRelayRouteForRequest,
} from '../billing/antigravityRouteContext.js'
/**
 * OCV5-415 P2 billing on real PG: migration 0307 + relay usage rows + the
 * durable turn claim (Codex r1 P1: a reconnected bridge must still settle).
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/antigravitySettle.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
const selfhost = existsSync(new URL('../db/migrations/0341_selfhost_sync_compat.sql', import.meta.url))
assert.notEqual(selfhost, existsSync(new URL('../db/migrations/0340_commercial_sync_compat.sql', import.meta.url)))
import { describe, test } from 'node:test'

import {
  abandonAntigravityTurn,
  reconcileStaleAntigravityTurns,
  recordAntigravityTurn,
  refreshWaivedAntigravityUsage,
  settleAntigravityTurnRecord,
  settleLateAntigravityRelayUsage,
} from '../billing/antigravitySettle.js'
import {
  runAntigravityTurnReconcileTick,
  settleDurableAntigravityBilling,
} from '../billing/durableAntigravityBilling.js'
import { DURABLE_CODEX_RECOVERY_VERSION } from '../billing/codexFinalizer.js'
import { reconcileStuckFinalizeJournal } from '../billing/finalizeJournalReconciler.js'
import { serializeBillingPricing } from '../billing/persistedBillingPricing.js'
import { startInflightJournal } from '../billing/proxyBilling.js'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'
import { parseLosslessTurnPayload } from '../http/losslessTurnTape.js'
import { LOSSLESS_TURN_TAPE_VERSION } from '@openclaude/protocol'
import type { ModelPricing, PricingCache } from '../billing/pricing.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { recordAntigravityRelayUsage } from '../http/internalAntigravityRelay.js'
import { useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('antigravity_settle_0307_test')
const MODEL = 'antigravity-gemini-3.8-flash'
const PRICING = {
  model_id: MODEL,
  display_name: 'Gemini 3.8 Flash (Antigravity)',
  input_per_mtok: 120n,
  output_per_mtok: 150n,
  cache_read_per_mtok: 5n,
  cache_write_per_mtok: 0n,
  multiplier: '1.000',
  enabled: true,
} as unknown as ModelPricing
const pricing = { get: (id: string) => (id === MODEL ? PRICING : null) } as unknown as PricingCache

let seq = 0
function rid(): string {
  seq += 1
  return seq.toString(16).padStart(32, 'a')
}

async function user(credits: bigint): Promise<bigint> {
  seq += 1
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', $2, 'user') RETURNING id::text AS id",
    [`agy-${seq}@example.test`, credits.toString()],
  )
  return BigInt(r.rows[0]!.id)
}

async function usageRow(
  requestId: string,
  userId: bigint,
  prompt: number,
  out: number,
  cached = 0,
): Promise<void> {
  await query(
    `INSERT INTO antigravity_relay_usage
       (call_id, request_id, user_id, route_model_id, upstream_model, request_type, status_code,
        prompt_tokens, candidates_tokens, thoughts_tokens, cached_tokens)
     VALUES (gen_random_uuid(), $1, $2, $3, 'gemini-3.8-flash-low', 'agent', 200, $4, $5, 0, $6)`,
    [requestId, userId.toString(), MODEL, prompt, out, cached],
  )
}

async function balance(userId: bigint): Promise<bigint> {
  const r = await query<{ credits: string }>(
    'SELECT credits::text AS credits FROM users WHERE id = $1',
    [userId.toString()],
  )
  return BigInt(r.rows[0]!.credits)
}

async function turnStatus(requestId: string): Promise<string | undefined> {
  const r = await query<{ status: string }>(
    'SELECT status FROM antigravity_turns WHERE request_id = $1',
    [requestId],
  )
  return r.rows[0]?.status
}

describe('0307 antigravity engine schema', () => {
  test('engine CHECK accepts antigravity; catalog rows preserve the target edition staged, disabled and visibility policies', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const rows = await query<{
      model_id: string
      state: string
      enabled: boolean
      visibility: string
    }>(
      `SELECT c.model_id, c.state, p.enabled, p.visibility
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.engine = 'antigravity' ORDER BY c.model_id`,
    )
    assert.deepEqual(rows.rows, [
      {
        model_id: 'antigravity-claude-opus-4.6',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
      {
        model_id: 'antigravity-claude-opus-5.5',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
      {
        model_id: 'antigravity-claude-sonnet-4.6',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
      {
        model_id: 'antigravity-claude-sonnet-5.5',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
      {
        model_id: 'antigravity-gemini-3.8-flash',
        state: 'staged',
        enabled: false,
        visibility: selfhost ? 'public' : 'admin',
      },
      {
        model_id: 'antigravity-gemini-4-argon',
        state: 'staged',
        enabled: false,
        visibility: selfhost ? 'public' : 'admin',
      },
      ...(selfhost
        ? [
            {
              model_id: 'antigravity-gemini-4-carbon',
              state: 'staged',
              enabled: false,
              visibility: 'public',
            },
            {
              model_id: 'antigravity-gemini-4-hydrogen',
              state: 'staged',
              enabled: false,
              visibility: 'admin',
            },
            {
              model_id: 'antigravity-gemini-4-neon',
              state: 'staged',
              enabled: false,
              visibility: 'admin',
            },
          ]
        : [
            {
              model_id: 'antigravity-gemini-4-carbon',
              state: 'staged',
              enabled: false,
              visibility: 'admin',
            },
            {
              model_id: 'antigravity-gemini-4-hydrogen',
              state: 'staged',
              enabled: false,
              visibility: 'admin',
            },
            {
              model_id: 'antigravity-gemini-4-neon',
              state: 'staged',
              enabled: false,
              visibility: 'admin',
            },
          ]),
      {
        model_id: 'antigravity-gpt-oss-120b',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
      {
        model_id: 'antigravity-orchestrator-carbon',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
      {
        model_id: 'antigravity-orchestrator-neon',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
    ])
    // An automatic path can never leave an account disabled without admin provenance.
    await assert.rejects(
      query(
        `INSERT INTO gemini_oauth_accounts (label, email, refresh_token_enc, refresh_token_nonce, status)
         VALUES ('x', 'x@example.test', '\\x00', '\\x00', 'disabled')`,
      ),
      /gemini_oauth_accounts_disabled_by_admin/,
    )
  })
})

describe('Antigravity durable turn settlement', () => {
  test('a different bridge settles from the turn row and the relay rows; replays do not double-charge', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: MODEL,
      sessionId: 'peer-1',
      traceId: null,
    })
    // Title + agent call, cached prefix on the second.
    await usageRow(requestId, uid, 123, 3)
    await usageRow(requestId, uid, 11_885, 29, 9_000)
    const done = await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId,
      userId: uid,
      engineStatus: 'success',
    })
    assert.ok(done)
    assert.equal(done.turn.sessionId, 'peer-1')
    // ceil((3008*120 + 32*150 + 9000*5) / 1e6) = 1 credit, as computeCost rounds up.
    const usage = await query<{
      cost_credits: string
      input_tokens: string
      output_tokens: string
      cache_read_tokens: string
      status: string
    }>(
      `SELECT cost_credits::text, input_tokens::text, output_tokens::text, cache_read_tokens::text, status
         FROM usage_records WHERE request_id = $1 AND user_id = $2`,
      [requestId, uid.toString()],
    )
    assert.equal(usage.rows.length, 1)
    assert.equal(usage.rows[0]!.input_tokens, '3008')
    assert.equal(usage.rows[0]!.output_tokens, '32')
    assert.equal(usage.rows[0]!.cache_read_tokens, '9000')
    assert.equal(usage.rows[0]!.status, 'success')
    const charged = BigInt(usage.rows[0]!.cost_credits)
    assert.ok(charged > 0n)
    assert.equal(await balance(uid), 1_000_000n - charged)
    assert.equal(await turnStatus(requestId), 'settled')
    // A replayed terminal frame (any bridge) finds nothing to claim.
    assert.equal(
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing,
        requestId,
        userId: uid,
        engineStatus: 'success',
      }),
      null,
    )
    assert.equal(await balance(uid), 1_000_000n - charged)
  })

  test('errors are recorded but not charged; another user cannot claim the turn', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000_000n)
    const other = await user(1_000_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: MODEL,
      sessionId: null,
      traceId: null,
    })
    await usageRow(requestId, uid, 5_000, 40)
    assert.equal(
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing,
        requestId,
        userId: other,
        engineStatus: 'success',
      }),
      null,
    )
    const done = await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId,
      userId: uid,
      engineStatus: 'error',
      terminalCode: 'ENGINE_ERROR',
    })
    assert.ok(done)
    assert.equal(await balance(uid), 1_000_000n)
    const usage = await query<{ cost_credits: string; status: string }>(
      'SELECT cost_credits::text, status FROM usage_records WHERE request_id = $1',
      [requestId],
    )
    assert.deepEqual(usage.rows, [{ cost_credits: '0', status: 'error' }])
  })

  test("turns that never got a terminal frame settle on the next admission's reconcile pass", async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000_000n)
    const stale = rid()
    const fresh = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: stale,
      userId: uid,
      modelId: MODEL,
      sessionId: null,
      traceId: null,
    })
    await recordAntigravityTurn(getPool(), {
      requestId: fresh,
      userId: uid,
      modelId: MODEL,
      sessionId: null,
      traceId: null,
    })
    await usageRow(stale, uid, 2_000_000, 1_000)
    await usageRow(fresh, uid, 2_000_000, 1_000)
    await query(
      "UPDATE antigravity_turns SET updated_at = NOW() - interval '3 hours' WHERE request_id = $1",
      [stale],
    )
    const done = await reconcileStaleAntigravityTurns({ pool: getPool(), pricing, userId: uid })
    assert.deepEqual(
      done.map((d) => d.turn.requestId),
      [stale],
    )
    assert.equal(await turnStatus(stale), 'settled')
    assert.equal(await turnStatus(fresh), 'pending')
    assert.ok((await balance(uid)) < 1_000_000n)
  })

  test('reconcile keeps a persisted error status: a failed turn stays free (Codex r2 P1)', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: MODEL,
      sessionId: null,
      traceId: null,
    })
    await usageRow(requestId, uid, 2_000_000, 1_000)
    // The bridge saw an error terminal, but its settle could not run (pricing not loaded yet).
    const noPricing = { get: () => null } as unknown as PricingCache
    assert.equal(
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing: noPricing,
        requestId,
        userId: uid,
        engineStatus: 'error',
        terminalCode: 'ENGINE_ERROR',
      }),
      null,
    )
    assert.equal(await turnStatus(requestId), 'pending')
    await query(
      "UPDATE antigravity_turns SET updated_at = NOW() - interval '3 hours' WHERE request_id = $1",
      [requestId],
    )
    const done = await reconcileStaleAntigravityTurns({ pool: getPool(), pricing, userId: uid })
    assert.deepEqual(
      done.map((d) => d.turn.requestId),
      [requestId],
    )
    const usage = await query<{ cost_credits: string; status: string }>(
      'SELECT cost_credits::text, status FROM usage_records WHERE request_id = $1',
      [requestId],
    )
    assert.deepEqual(usage.rows, [{ cost_credits: '0', status: 'error' }])
    assert.equal(await balance(uid), 1_000n)
  })

  test('a retried usage insert after a lost commit acknowledgement is not double-billed (Codex r3 P1)', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: MODEL,
      sessionId: null,
      traceId: null,
    })
    const account = await query<{ id: string }>(
      `INSERT INTO gemini_oauth_accounts (label, email, refresh_token_enc, refresh_token_nonce)
       VALUES ('t', $1, '\\x00', '\\x00') RETURNING id::text AS id`,
      [`acct-${requestId}@example.test`],
    )
    const row = {
      callId: '0f1e2d3c-4b5a-4968-8776-655443322110',
      requestId,
      userId: uid,
      accountId: BigInt(account.rows[0]!.id),
      routeModelId: MODEL,
      upstreamModel: 'gemini-3.8-flash-low',
      requestType: 'agent',
      statusCode: 200,
      promptTokens: 2_000_000,
      candidatesTokens: 1_000,
      thoughtsTokens: 0,
      cachedTokens: 0,
    }
    // First insert committed but its acknowledgement was lost; the relay retries the same call.
    await recordAntigravityRelayUsage(row)
    await recordAntigravityRelayUsage(row)
    const count = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM antigravity_relay_usage WHERE request_id = $1',
      [requestId],
    )
    assert.equal(count.rows[0]?.n, '1')
    const done = await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId,
      userId: uid,
      engineStatus: 'success',
    })
    assert.ok(done)
    // 2,000,000 × 120 + 1,000 × 150 → ceil(240.15) = 241, charged once.
    assert.equal(await balance(uid), 1_000n - 241n)
  })

  test('an admission that failed before the container ran is abandoned (never billed later)', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: MODEL,
      sessionId: null,
      traceId: null,
    })
    await abandonAntigravityTurn(getPool(), requestId, uid)
    assert.equal(await turnStatus(requestId), 'abandoned')
    assert.equal(
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing,
        requestId,
        userId: uid,
        engineStatus: 'success',
      }),
      null,
    )
  })

  test('a call recorded after a stopped turn settled is folded into the waived row (OCV5-451)', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: MODEL,
      sessionId: null,
      traceId: null,
    })
    // The checkpoint call finished; the agent call is still streaming when Stop settles the turn.
    await usageRow(requestId, uid, 16_376, 10)
    const done = await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId,
      userId: uid,
      engineStatus: 'error',
      terminalCode: 'USER_STOPPED',
    })
    assert.ok(done)
    const read = async () =>
      (
        await query<{
          cost_credits: string
          input_tokens: string
          output_tokens: string
          snapshot: Record<string, unknown>
        }>(
          `SELECT cost_credits::text, input_tokens::text, output_tokens::text, price_snapshot AS snapshot
             FROM usage_records WHERE request_id = $1 AND user_id = $2`,
          [requestId, uid.toString()],
        )
      ).rows[0]!
    assert.equal((await read()).snapshot.antigravity_calls, 1)
    // The relay read the agent call to its end and records it after settlement.
    await usageRow(requestId, uid, 29_175, 8_525)
    assert.equal(
      await refreshWaivedAntigravityUsage({ pool: getPool(), pricing, requestId, userId: uid }),
      true,
    )
    const after = await read()
    assert.equal(after.cost_credits, '0')
    assert.equal(after.input_tokens, String(16_376 + 29_175))
    assert.equal(after.output_tokens, String(10 + 8_525))
    assert.equal(after.snapshot.antigravity_calls, 2)
    assert.equal(after.snapshot.antigravity_status, 'error')
    assert.equal(after.snapshot.antigravity_terminal_code, 'USER_STOPPED')
    assert.equal(after.snapshot.waived, 'antigravity_engine_not_success')
    // ceil((45551 × 120 + 8535 × 150) / 1e6) = ceil(6.74637) = 7
    assert.equal(after.snapshot.wouldHaveCharged, '7')
    assert.equal(await balance(uid), 1_000n)
    // Idempotent: nothing new to fold.
    assert.equal(
      await refreshWaivedAntigravityUsage({ pool: getPool(), pricing, requestId, userId: uid }),
      false,
    )
  })

  test('the late-row refresh never touches a charged turn (OCV5-451)', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: MODEL,
      sessionId: null,
      traceId: null,
    })
    await usageRow(requestId, uid, 2_000_000, 1_000)
    assert.ok(
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing,
        requestId,
        userId: uid,
        engineStatus: 'success',
      }),
    )
    const charged = 1_000_000n - (await balance(uid))
    assert.ok(charged > 0n)
    await usageRow(requestId, uid, 5_000, 40)
    assert.equal(
      await refreshWaivedAntigravityUsage({ pool: getPool(), pricing, requestId, userId: uid }),
      false,
    )
    const row = await query<{ cost_credits: string; input_tokens: string }>(
      'SELECT cost_credits::text, input_tokens::text FROM usage_records WHERE request_id = $1',
      [requestId],
    )
    assert.deepEqual(row.rows, [{ cost_credits: charged.toString(), input_tokens: '2000000' }])
    assert.equal(1_000_000n - (await balance(uid)), charged)
  })
})


describe('OCV5-515 authoritative retirement waiver', () => {
  test('a successful CLI terminal cannot bill title tokens when the relay observed retirement', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1000000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), { requestId, userId: uid, modelId: MODEL, sessionId: null, traceId: null })
    await usageRow(requestId, uid, 3000, 200)
    await query(`INSERT INTO antigravity_relay_usage
      (call_id,request_id,user_id,route_model_id,upstream_model,status_code)
      VALUES (gen_random_uuid(),$1,$2,$3,'claude-sonnet-4-6',410)`, [requestId, uid.toString(), MODEL])
    const done = await settleAntigravityTurnRecord({ pool: getPool(), pricing, requestId, userId: uid, engineStatus: 'success' })
    assert.ok(done)
    assert.equal(await balance(uid), 1000000n)
    const rows = await query<{ cost: string; status: string; ledger_id: string | null; code: string }>(
      `SELECT cost_credits::text AS cost, status, ledger_id::text,
        price_snapshot->>'antigravity_terminal_code' AS code FROM usage_records WHERE request_id=$1`, [requestId])
    assert.deepEqual(rows.rows, [{ cost: '0', status: 'error', ledger_id: null, code: 'ANTIGRAVITY_MODEL_RETIRED' }])
    assert.equal((await query('SELECT 1 FROM credit_ledger WHERE user_id=$1', [uid.toString()])).rowCount, 0)
  })
})


describe('Gemini 4 Argon staged pricing (OCV5-517)', () => {
  // Commercial: 0312 keeps the row admin-only (OCV5-411) and 0313 prices it as Claude Opus 5.5 (user 2026-10-20).
  test('new public family stays staged with explicit medium effort and verified introductory rates', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const r=await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-gemini-4-argon'`)
    assert.deepEqual(r.rows,[{ state:'staged',upstream_model_id:'gemini-4-argon-medium',context_window:1048576,
      enabled:false,visibility:selfhost ? 'public' : 'admin',default_effort:'medium',
      input:selfhost ? '100' : '1400',output:selfhost ? '500' : '5000',cached:selfhost ? '5' : '36' }])
  })
})

describe('Gemini 4 Carbon staged pricing (OCV5-757)', () => {
  test('new public family stays staged with explicit medium effort and the same introductory rates as Argon', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const r = await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached,
      p.cache_write_per_mtok::text AS cache_write,p.multiplier::text AS multiplier
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-gemini-4-carbon'`)
    assert.deepEqual(r.rows, [{
      state: 'staged', upstream_model_id: 'gemini-4-carbon-medium', context_window: 1048576,
      enabled: false, visibility: selfhost ? 'public' : 'admin', default_effort: 'medium',
      input: '100', output: '500', cached: '5', cache_write: '0', multiplier: '1.000',
    }])
  })
})

describe('Gemini 4 Hydrogen staged pricing (OCV5-768)', () => {
  test('new Hydrogen family seeds staged with explicit high effort, admin visibility, and official 1.50/7.50/0.075 USD rates', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const r = await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached,
      p.cache_write_per_mtok::text AS cache_write,p.multiplier::text AS multiplier
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-gemini-4-hydrogen'`)
    assert.deepEqual(r.rows, [{
      state: 'staged',
      upstream_model_id: 'gemini-4-hydrogen-high',
      context_window: 1048576,
      enabled: false,
      visibility: 'admin',
      default_effort: 'high',
      input: '75',
      output: '375',
      cached: '4',
      cache_write: '0',
      multiplier: '1.000',
    }])
  })
})

describe('Orchestrator Carbon staged pricing (OCV5-769)', () => {
  test('Orchestrator Carbon seeds staged with fixed default, admin visibility, and Carbon rates', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const r = await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached,
      p.cache_write_per_mtok::text AS cache_write,p.multiplier::text AS multiplier
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-orchestrator-carbon'`)
    assert.deepEqual(r.rows, [{
      state: 'staged',
      upstream_model_id: 'gemini-pro-orchestrator',
      context_window: 1048576,
      enabled: false,
      visibility: 'admin',
      default_effort: null,
      input: '100',
      output: '500',
      cached: '5',
      cache_write: '0',
      multiplier: '1.000',
    }])
  })
})

describe('Gemini 4 Neon & Orchestrator Neon staged pricing (OCV5-803)', () => {
  test('Gemini 4 Neon seeds staged with explicit high effort, admin visibility, and commercial 600/3000/15/0 rates', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const r = await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached,
      p.cache_write_per_mtok::text AS cache_write,p.multiplier::text AS multiplier
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-gemini-4-neon'`)
    assert.deepEqual(
      r.rows,
      [{
        state: 'staged',
        upstream_model_id: 'gemini-4-neon-high',
        context_window: 1048576,
        enabled: false,
        visibility: 'admin',
        default_effort: 'high',
        input: '600',
        output: '3000',
        cached: '15',
        cache_write: '0',
        multiplier: '1.000',
      }],
    )
  })

  test('Orchestrator Neon seeds staged with fixed default, admin visibility, and commercial 600/3000/15/0 rates', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const r = await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached,
      p.cache_write_per_mtok::text AS cache_write,p.multiplier::text AS multiplier
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-orchestrator-neon'`)
    assert.deepEqual(
      r.rows,
      [{
        state: 'staged',
        upstream_model_id: 'gemini-pro-orchestrator-neon',
        context_window: 1048576,
        enabled: false,
        visibility: 'admin',
        default_effort: null,
        input: '600',
        output: '3000',
        cached: '15',
        cache_write: '0',
        multiplier: '1.000',
      }],
    )
  })
})

describe('0344 commercial Neon migration replay & guard proofs (OCV5-807)', () => {
  test('0344 replays idempotently, preserves active rows without INSERT trigger downgrade, and rejects drift/half-pair', async (t) => {
    if (db.skipIfUnavailable(t)) return
    if (selfhost) {
      t.skip('commercial 0344 migration only runs on commercial schema')
      return
    }
    const sql0344 = readFileSync(
      new URL('../db/migrations/0344_commercial_antigravity_gemini_4_neon.sql', import.meta.url),
      'utf8',
    )
    const migRow = await query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '0344_commercial_antigravity_gemini_4_neon'`,
    )
    assert.equal(migRow.rows.length, 1, '0344 must be registered in commercial schema_migrations')

    const epochBefore = Number(
      (await query<{ epoch: string }>('SELECT epoch::text FROM model_security_epoch WHERE id')).rows[0]!.epoch,
    )
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      // 1. Clean replay on staged/disabled/admin baseline: idempotent & epoch unchanged
      await client.query(sql0344)
      const epochAfterReplay = Number(
        (await client.query<{ epoch: string }>('SELECT epoch::text FROM model_security_epoch WHERE id')).rows[0]!.epoch,
      )
      assert.equal(epochAfterReplay, epochBefore)

      // 1b. Pre-seeded staged/disabled/public row must refuse 0344 fail-closed without mutating rows
      await client.query('SAVEPOINT sp_staged_public')
      await client.query(
        `UPDATE model_pricing SET visibility = 'public' WHERE model_id = 'antigravity-gemini-4-neon'`,
      )
      await client.query('SAVEPOINT sp_staged_public_exec')
      await assert.rejects(() => client.query(sql0344), /refuses drifted or inconsistent/)
      await client.query('ROLLBACK TO SAVEPOINT sp_staged_public_exec')
      const stagedPublicUnchanged = await client.query<{ state: string; enabled: boolean; visibility: string }>(
        `SELECT c.state, p.enabled, p.visibility
           FROM model_catalog c JOIN model_pricing p USING (model_id)
          WHERE c.model_id = 'antigravity-gemini-4-neon'`,
      )
      assert.deepEqual(stagedPublicUnchanged.rows, [{ state: 'staged', enabled: false, visibility: 'public' }])
      await client.query('ROLLBACK TO SAVEPOINT sp_staged_public')
      const stagedAfterReject = await client.query<{ state: string; enabled: boolean; visibility: string }>(
        `SELECT c.state, p.enabled, p.visibility
           FROM model_catalog c JOIN model_pricing p USING (model_id)
          WHERE c.model_id = 'antigravity-gemini-4-neon'`,
      )
      assert.deepEqual(stagedAfterReject.rows, [{ state: 'staged', enabled: false, visibility: 'admin' }])

      // 2. Active/public row must stay active/enabled=true/public without BEFORE INSERT downgrade or epoch bump
      await client.query(
        `UPDATE model_catalog SET state = 'active' WHERE model_id = 'antigravity-gemini-4-neon'`,
      )
      await client.query(
        `UPDATE model_pricing SET enabled = TRUE, visibility = 'public' WHERE model_id = 'antigravity-gemini-4-neon'`,
      )
      const epochActiveBefore = Number(
        (await client.query<{ epoch: string }>('SELECT epoch::text FROM model_security_epoch WHERE id')).rows[0]!.epoch,
      )
      await client.query(sql0344)
      const activeAfter = await client.query<{ state: string; enabled: boolean; visibility: string }>(
        `SELECT c.state, p.enabled, p.visibility
           FROM model_catalog c JOIN model_pricing p USING (model_id)
          WHERE c.model_id = 'antigravity-gemini-4-neon'`,
      )
      assert.deepEqual(activeAfter.rows, [{ state: 'active', enabled: true, visibility: 'public' }])
      const epochActiveAfter = Number(
        (await client.query<{ epoch: string }>('SELECT epoch::text FROM model_security_epoch WHERE id')).rows[0]!.epoch,
      )
      assert.equal(epochActiveAfter, epochActiveBefore)

      // 3. Drifted pricing refuses 0344 fail-closed
      await client.query('SAVEPOINT sp_drift')
      await client.query(
        `UPDATE model_pricing SET input_per_mtok = 999 WHERE model_id = 'antigravity-gemini-4-neon'`,
      )
      await assert.rejects(() => client.query(sql0344), /refuses drifted or inconsistent/)
      await client.query('ROLLBACK TO SAVEPOINT sp_drift')

      // 4. Half-pair (pricing missing while catalog exists) refuses 0344 fail-closed
      await client.query('SAVEPOINT sp_half')
      await client.query(`SET LOCAL openclaude.catalog_sync = '1'`)
      await client.query(`DELETE FROM model_pricing WHERE model_id = 'antigravity-orchestrator-neon'`)
      await assert.rejects(() => client.query(sql0344), /refuses incomplete/)
      await client.query('ROLLBACK TO SAVEPOINT sp_half')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

// INC-20261112-AGY-ROUTE-LIFETIME: real PG ownership + real Redis CAS.
// No model request, no shared Redis FLUSH; each test deletes only its minted keys.
async function lifetimeFixture(kind: 'chat' | 'delegate' | 'legacy' = 'chat') {
  const uid = await user(100_000n)
  const requestId = rid()
  const sessionId = `agy-lifetime-${requestId}`
  await recordAntigravityTurn(getPool(), { requestId, userId: uid, modelId: MODEL, sessionId, traceId: null })
  let containerId = 11
  if (kind === 'chat') {
    await query(`INSERT INTO turn_dispatches
      (dispatch_id,user_id,session_id,client_message_id,agent_id,model,request_hash,billing_request_id,status)
      VALUES ($1,$2,$3,'msg-lifetime','main','alias-model',$4,$5,'accepted')`,
      [randomUUID(), uid.toString(), sessionId, 'a'.repeat(64), requestId])
  } else if (kind === 'delegate') {
    const sub = await query<{id: string}>(`INSERT INTO agent_subscriptions(user_id,plan,end_at)
      VALUES ($1,'basic',NOW()+INTERVAL '1 day') RETURNING id::text`, [uid.toString()])
    const c = await query<{id: string}>(`INSERT INTO agent_containers
      (user_id,subscription_id,docker_name,workspace_volume,home_volume,image,status,secret_hash)
      VALUES ($1,$2,$3,'w','h','test','running',decode(repeat('00',32),'hex')) RETURNING id::text`,
      [uid.toString(), sub.rows[0]!.id, sessionId])
    containerId = Number(c.rows[0]!.id)
    await query(`INSERT INTO request_finalize_journal(request_id,user_id,container_id,ctx,precheck_credits)
      VALUES ($1,$2,$3,'{"source":"delegate_antigravity"}',1000)`, [requestId, uid.toString(), containerId])
  }
  const redis = new IORedis('redis://127.0.0.1:56379/15', { lazyConnect: true, maxRetriesPerRequest: 0,
    connectTimeout: 1500, retryStrategy: () => null })
  await redis.connect()
  _resetAntigravityRelayRoutesForTests()
  const kv = createIoredisAntigravityRelayKv(redis)
  configureAntigravityRelayKv(kv)
  configureAntigravityRelayAuthority((route) => readAntigravityRouteAuthority(getPool(), route))
  const started = Date.now()
  const minted = await mintAntigravityRelayRoute({ containerId, userId: uid, requestId,
    modelId: MODEL, accountId: 1n, budgetCredits: 100_000n, relayPort: 18789, nowMs: started })
  const tk = `oc:v5:antigravity-relay:${createHash('sha256').update(minted.token).digest('hex')}`
  const rk = `oc:v5:antigravity-relay:req:${requestId}`
  const resolve = (minute = 0) => resolveAntigravityRelayRoute({ token: minted.token,
    containerId, userId: uid, nowMs: started + minute * 60_000 })
  return { uid, requestId, sessionId, containerId, token: minted.token, redis, kv, started, tk, rk, resolve,
    async close() { await redis.del(tk, rk); await redis.quit(); _resetAntigravityRelayRoutesForTests() } }
}

describe('INC-20261112-AGY-ROUTE-LIFETIME authoritative rolling lease', () => {
  for (const kind of ['chat', 'delegate'] as const) {
    test(`${kind} live turn crosses 6 hours with no generation and concurrent renewals`, async (t) => {
      if (db.skipIfUnavailable(t)) return
      const f = await lifetimeFixture(kind)
      try {
        for (let minute = 31; minute < 500; minute += 31) {
          const rows = await Promise.all(Array.from({ length: 4 }, () => f.resolve(minute)))
          assert.ok(rows.every(Boolean), `all concurrent leases valid at ${minute}m`)
        }
        assert.ok(await f.resolve(500))
        assert.equal(await f.redis.get(f.rk), f.tk)
        assert.ok((await f.redis.ttl(f.rk)) >= 3590, 'reverse index outlives renewed token')
        // Live >2h turn must not be claimed, released or charged by orphan recovery.
        await usageRow(f.requestId, f.uid, 20_000, 500)
        await query("UPDATE antigravity_turns SET updated_at=NOW()-INTERVAL '3 hours' WHERE request_id=$1", [f.requestId])
        assert.equal((await reconcileStaleAntigravityTurns({ pool: getPool(), pricing, userId: f.uid })).length, 0)
        const direct = await settleAntigravityTurnRecord({ pool: getPool(), pricing, userId: f.uid,
          requestId: f.requestId, engineStatus: 'unknown', staleBefore: new Date() })
        assert.equal(direct, null, 'atomic claim repeats live-owner guard')
        assert.equal(await turnStatus(f.requestId), 'pending')
        assert.equal(await balance(f.uid), 100_000n)
        const once = await settleAntigravityTurnRecord({ pool: getPool(), pricing,
          userId: f.uid, requestId: f.requestId, engineStatus: 'success' })
        assert.ok(once, 'normal terminal settlement is not subject to stale guard')
        const spent = await balance(f.uid)
        assert.ok(spent < 100_000n)
        assert.equal(await settleAntigravityTurnRecord({ pool: getPool(), pricing,
          userId: f.uid, requestId: f.requestId, engineStatus: 'success' }), null)
        assert.equal(await balance(f.uid), spent)
        assert.equal(await f.resolve(500), null, 'settled execution cannot use even an unexpired route')
      } finally { await f.close() }
    })
  }

  test('persisted Stop and fenced owner deny; reconnect, alias and old Stop do not', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const f = await lifetimeFixture()
    try {
      await query(`UPDATE turn_dispatches SET owner_id='reconnected',lease_epoch=99,
        lease_until=NOW()-INTERVAL '1 hour' WHERE billing_request_id=$1`, [f.requestId])
      await query(`INSERT INTO turn_control_requests(control_id,user_id,session_id,kind,payload_json,created_at)
        VALUES ($1,$2,$3,'stop','{}',NOW()-INTERVAL '1 day')`, [randomUUID(), f.uid.toString(), f.sessionId])
      assert.ok(await f.resolve(), 'old NULL-root Stop never fences a later turn')
      const stop = randomUUID()
      await query(`INSERT INTO turn_control_requests(control_id,user_id,session_id,root_client_message_id,kind,payload_json)
        VALUES ($1,$2,$3,'unrelated','stop','{}')`, [stop, f.uid.toString(), f.sessionId])
      assert.ok(await f.resolve(), 'unrelated Stop does not fence this turn')
      await query('UPDATE turn_control_requests SET root_client_message_id=NULL WHERE control_id=$1', [stop])
      assert.equal(await f.resolve(), null)
      await query("UPDATE turn_control_requests SET status='cancelled' WHERE control_id=$1", [stop])
      assert.ok(await f.resolve())
      await query('UPDATE turn_dispatches SET producer_fenced_at=NOW() WHERE billing_request_id=$1', [f.requestId])
      assert.equal(await f.resolve(), null)
    } finally { await f.close() }
  })

  test('legacy prompt queue retains bounded lease and never acquires active-owner privileges', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const f = await lifetimeFixture('legacy')
    try {
      assert.ok(await f.resolve())
      for (let min = 31; min < 360; min += 31) assert.ok(await f.resolve(min))
      assert.equal(await f.resolve(361), null)
    } finally { await f.close() }
  })

  test('Redis terminal CAS wins over delayed renew even after revocation marker GC', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const f = await lifetimeFixture()
    try {
      const old = await f.resolve()
      assert.ok(old)
      await expireAntigravityRelayRouteForRequest(f.requestId)
      assert.equal(await f.kv.renew!({ row: old!, now: f.started+31*60_000, active: true }), null)
      await f.redis.del(f.rk) // simulate tombstone TTL elapsed, not a production repair
      assert.equal(await f.kv.renew!({ row: old!, now: f.started+31*60_000, active: true }), null)
      assert.equal(await f.redis.exists(f.tk), 0)
      assert.equal(await f.redis.exists(f.rk), 0)
    } finally { await f.close() }
  })

  test('delegate finalizing denies route but remains protected from stale settlement', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const f = await lifetimeFixture('delegate')
    try {
      await query("UPDATE request_finalize_journal SET state='finalizing' WHERE request_id=$1", [f.requestId])
      assert.equal(await f.resolve(), null)
      await query("UPDATE antigravity_turns SET updated_at=NOW()-INTERVAL '3 hours' WHERE request_id=$1", [f.requestId])
      assert.equal((await reconcileStaleAntigravityTurns({ pool: getPool(), pricing, userId: f.uid })).length, 0)
    } finally { await f.close() }
  })
})


test('INC-20261112-AGY-ROUTE-LIFETIME: HTTP heartbeat crosses six hours then Stop blocks upstream', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await lifetimeFixture()
  const secret = 'b'.repeat(64)
  const bearer = `oc-v3.${f.containerId}.${secret}`
  const identityRepo = { async findActiveByHostAndBoundIp() { return {
    id: f.containerId, user_id: Number(f.uid), bound_ip: '127.0.0.1',
    host_uuid: 'test-lifetime', secret_hash: hashSecret(secret),
  } } }
  const ctx = { hostUuid: 'test-lifetime', boundIp: '127.0.0.1' }
  let upstreamCalls = 0
  const relay = makeAntigravityRelayHandler({ identityRepo, clientSecret: 'test',
    freshToken: async () => Buffer.from('test'), reportOutcome: async () => {},
    requestFn: (async () => { upstreamCalls += 1; return { statusCode: 200,
      headers: { 'content-type': 'application/json' }, body: Readable.from(['{"ok":true}']) } }) as never,
  })
  const renew = makeDelegateAntigravityRouteHandler({ identityRepo, pool: getPool(),
    relayPort: 18789, clientSecret: 'test' })
  const server = createServer((req, res) => {
    const handler = req.url === DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH ? renew : relay
    void handler(req, res, ctx).catch(() => { res.statusCode = 500; res.end() })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const env = { OC_SELFHOST_ENGINE_LOCAL_TURNS: '1', OPENCLAUDE_V3_MASTER_BASE_URL: base,
    OPENCLAUDE_V3_CONTAINER_TOKEN: bearer }
  const realNow = Date.now
  let now = f.started
  Date.now = () => now
  const request = () => fetch(`${base}${ANTIGRAVITY_RELAY_PREFIX}/route/${f.token}/v1internal:loadCodeAssist`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}',
  })
  try {
    for (let minute = 31; minute < 500; minute += 31) {
      now = f.started + minute * 60_000
      await renewAntigravityRouteLease(f.token, { env })
    }
    assert.equal(upstreamCalls, 0, 'heartbeats are control-only, no paid calls')
    const ok = await request()
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).ok, true)
    assert.equal(upstreamCalls, 1)
    await query(`INSERT INTO turn_control_requests(control_id,user_id,session_id,kind,payload_json)
      VALUES ($1,$2,$3,'stop','{}')`, [randomUUID(), f.uid.toString(), f.sessionId])
    const denied = await request()
    assert.equal(denied.status, 404)
    await denied.text()
    assert.equal(upstreamCalls, 1, 'Stop denied before OAuth/upstream dispatch')
    await assert.rejects(renewAntigravityRouteLease(f.token, { env }), /rejected/)
  } finally {
    Date.now = realNow
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await f.close()
  }
})

describe('P0-2a real PG aux/monitoring settlement attribution & legacy compatibility', () => {
  const NEON_MODEL = 'antigravity-gemini-4-neon'
  const NEON_PRICING = {
    model_id: NEON_MODEL,
    display_name: 'Gemini 4 Neon (Antigravity)',
    input_per_mtok: 600n,
    output_per_mtok: 3000n,
    cache_read_per_mtok: 15n,
    cache_write_per_mtok: 0n,
    multiplier: '1.000',
    enabled: true,
  } as unknown as ModelPricing
  const neonPricingCache = {
    get: (id: string) => (id === NEON_MODEL ? NEON_PRICING : null),
  } as unknown as PricingCache

  async function customUsageRow(args: {
    requestId: string
    userId: bigint
    routeModelId: string
    upstreamModel: string
    requestType: string | null
    prompt: number
    out: number
    cached?: number
  }): Promise<void> {
    await query(
      `INSERT INTO antigravity_relay_usage
         (call_id, request_id, user_id, route_model_id, upstream_model, request_type, status_code,
          prompt_tokens, candidates_tokens, thoughts_tokens, cached_tokens)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 200, $6, $7, 0, $8)`,
      [
        args.requestId,
        args.userId.toString(),
        args.routeModelId,
        args.upstreamModel,
        args.requestType,
        args.prompt,
        args.out,
        args.cached ?? 0,
      ],
    )
  }

  test('same request_id mixing Neon primary + flash-lite agent_monitoring + web_search bills all aux at light-model rate (~97% lower than Neon)', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: NEON_MODEL,
      sessionId: 'swarm-neon-1',
      traceId: null,
    })
    // Primary Neon: 100k prompt (90k cached -> 10k uncached), 1k output -> 10.35 fen
    await customUsageRow({
      requestId,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-4-neon-high',
      requestType: 'agent',
      prompt: 100_000,
      out: 1_000,
      cached: 90_000,
    })
    // 3 heavy uncached agent_monitoring calls on gemini-3.5-flash-lite: 30M uncached input, 6k output
    //   At 20/80/1: 600.48 fen (vs 18,018 fen if billed at Neon rate!)
    for (let i = 0; i < 3; i++) {
      await customUsageRow({
        requestId,
        userId: uid,
        routeModelId: NEON_MODEL,
        upstreamModel: 'gemini-3.5-flash-lite',
        requestType: 'agent_monitoring',
        prompt: 10_000_000,
        out: 2_000,
        cached: 0,
      })
    }
    // 1 web_search call on gemini-3.5-flash-lite: 100k uncached input, 1k output -> 2.08 fen at 20/80/1
    await customUsageRow({
      requestId,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-3.5-flash-lite',
      requestType: 'web_search',
      prompt: 100_000,
      out: 1_000,
      cached: 0,
    })

    const done = await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing: neonPricingCache,
      requestId,
      userId: uid,
      engineStatus: 'success',
    })
    assert.ok(done)
    // Single ceiling(10.35 + 600.48 + 2.08) = ceil(612.91) = 613 fen (vs 18,092 fen if billed at Neon rate!)
    assert.equal(await balance(uid), 1_000_000n - 613n)
    const usage = await query<{
      cost_credits: string
      input_tokens: string
      output_tokens: string
      cache_read_tokens: string
      snapshot: Record<string, unknown>
    }>(
      `SELECT cost_credits::text, input_tokens::text, output_tokens::text, cache_read_tokens::text,
              price_snapshot AS snapshot
         FROM usage_records WHERE request_id = $1 AND user_id = $2`,
      [requestId, uid.toString()],
    )
    assert.equal(usage.rows.length, 1)
    assert.equal(usage.rows[0]!.cost_credits, '613')
    assert.equal(usage.rows[0]!.input_tokens, '30110000')
    assert.equal(usage.rows[0]!.output_tokens, '8000')
    assert.equal(usage.rows[0]!.cache_read_tokens, '90000')
    const snap = usage.rows[0]!.snapshot as Record<string, Record<string, unknown>>
    assert.equal(usage.rows[0]!.snapshot.antigravity_calls, 5)
    assert.equal(snap.antigravity_aux?.calls, 4)
    assert.equal(snap.antigravity_aux?.monitoring_calls, 3)
    assert.equal(snap.antigravity_aux?.input_tokens, '30100000')
    assert.equal(snap.antigravity_monitoring, undefined)
  })

  test('B2 real PG trust boundary: identical flash-lite usage settles to identical credits for agent_monitoring vs web_search vs NULL request_type', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const costs: bigint[] = []
    for (const reqType of ['agent_monitoring', 'web_search', null] as const) {
      const uid = await user(1_000_000n)
      const requestId = rid()
      await recordAntigravityTurn(getPool(), {
        requestId,
        userId: uid,
        modelId: NEON_MODEL,
        sessionId: `b2-invariance-${reqType ?? 'null'}`,
        traceId: null,
      })
      await customUsageRow({
        requestId,
        userId: uid,
        routeModelId: NEON_MODEL,
        upstreamModel: 'gemini-3.5-flash-lite',
        requestType: reqType,
        prompt: 1_000_000,
        out: 2_000,
        cached: 0,
      })
      const done = await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing: neonPricingCache,
        requestId,
        userId: uid,
        engineStatus: 'success',
      })
      assert.ok(done)
      costs.push(1_000_000n - (await balance(uid)))
    }
    // ceil((1_000_000*20 + 2_000*80)/1e6) = ceil(20.16) = 21 fen (vs 606 fen at Neon rate)
    assert.deepEqual(costs, [21n, 21n, 21n])
  })

  test('four-quadrant compat & anti-spoof: NULL/empty request_type and spoofed primary agent_monitoring stay accurately billed', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: NEON_MODEL,
      sessionId: 'compat-neon-1',
      traceId: null,
    })
    // 1. Legacy primary row with NULL request_type -> primary Neon rate: 100k * 600 + 1k * 3000 = 63 fen
    await customUsageRow({
      requestId,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-4-neon-high',
      requestType: null,
      prompt: 100_000,
      out: 1_000,
    })
    // 2. Spoofed primary row with request_type='agent_monitoring' -> MUST stay primary Neon rate: 63 fen
    await customUsageRow({
      requestId,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-4-neon-high',
      requestType: 'agent_monitoring',
      prompt: 100_000,
      out: 1_000,
    })
    // 3. Legacy aux row with NULL request_type -> aux light rate (20/80/1), NOT Neon, NOT waived: 2.08 fen
    await customUsageRow({
      requestId,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-3.5-flash-lite',
      requestType: null,
      prompt: 100_000,
      out: 1_000,
    })

    const done = await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing: neonPricingCache,
      requestId,
      userId: uid,
      engineStatus: 'success',
    })
    assert.ok(done)
    // Primary total = 200k input * 600 + 2k output * 3000 = 126.00 fen
    // Aux total = 100k input * 20 + 1k output * 80 = 2.08 fen
    // Single ceiling(128.08) = 129 fen
    assert.equal(await balance(uid), 1_000_000n - 129n)
    const snap = (
      await query<{ snapshot: Record<string, unknown> }>(
        'SELECT price_snapshot AS snapshot FROM usage_records WHERE request_id = $1',
        [requestId],
      )
    ).rows[0]!.snapshot
    assert.equal(snap.antigravity_monitoring, undefined)
    assert.equal((snap.antigravity_primary as Record<string, unknown>).calls, 2)
    assert.equal((snap.antigravity_aux as Record<string, unknown>).calls, 1)
  })

  test('refreshWaivedAntigravityUsage folds late flash-lite aux call at light-model rate without inflating at Neon rate', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(1_000n)
    const requestId = rid()
    await recordAntigravityTurn(getPool(), {
      requestId,
      userId: uid,
      modelId: NEON_MODEL,
      sessionId: null,
      traceId: null,
    })
    await customUsageRow({
      requestId,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-4-neon-high',
      requestType: 'agent',
      prompt: 10_000,
      out: 100,
    })
    assert.ok(
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing: neonPricingCache,
        requestId,
        userId: uid,
        engineStatus: 'error',
        terminalCode: 'USER_STOPPED',
      }),
    )
    const read = async () =>
      (
        await query<{ snapshot: Record<string, unknown>; input_tokens: string }>(
          'SELECT price_snapshot AS snapshot, input_tokens::text FROM usage_records WHERE request_id = $1',
          [requestId],
        )
      ).rows[0]!
    const before = await read()
    assert.equal(before.snapshot.antigravity_calls, 1)
    // ceil((10_000*600 + 100*3000)/1e6) = ceil(6.3) = 7
    assert.equal(before.snapshot.wouldHaveCharged, '7')

    // Late flash-lite agent_monitoring row lands after turn stopped: 1M input + 1k output -> 20.08 fen at aux rate (vs 603 at Neon!)
    await customUsageRow({
      requestId,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-3.5-flash-lite',
      requestType: 'agent_monitoring',
      prompt: 1_000_000,
      out: 1_000,
    })
    assert.equal(
      await refreshWaivedAntigravityUsage({
        pool: getPool(),
        pricing: neonPricingCache,
        requestId,
        userId: uid,
      }),
      true,
    )
    const after = await read()
    assert.equal(after.snapshot.antigravity_calls, 2)
    // Single ceiling(6.3 + 20.08) = ceil(26.38) = 27 fen (still waived to 0 charged)
    assert.equal(after.snapshot.wouldHaveCharged, '27')
    assert.equal(after.input_tokens, '1010000')
    assert.equal(
      (after.snapshot.antigravity_aux as Record<string, unknown>).monitoring_calls,
      1,
    )
    assert.equal(await balance(uid), 1_000n)
    // Idempotent second call
    assert.equal(
      await refreshWaivedAntigravityUsage({
        pool: getPool(),
        pricing: neonPricingCache,
        requestId,
        userId: uid,
      }),
      false,
    )
  })

  test('OCV5-887 durable tape billing settles disconnected swarm turns, backfills raced live WS turnKey, waives crashed/interrupted unknown reconciles, and bills late worker streams via CAS delta row', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(5_000n)

    // 1. Disconnected WS: durable `engine: 'antigravity'` frame settles turn, writes turn_key, and folds cost component
    const req1 = rid()
    const tk1 = createHash('sha256').update(`tk1:${req1}`).digest('hex')
    const folded: Array<{ reqId: string; credits: string; turnKey: string | null | undefined }> = []
    await recordAntigravityTurn(getPool(), {
      requestId: req1,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-durable-1',
      traceId: null,
    })
    await usageRow(req1, uid, 100_000, 20_000) // 100k*120 + 20k*150 = 15M/1M = 15 credits
    const d1 = await settleDurableAntigravityBilling(
      {
        pgPool: getPool(),
        pricing,
        expireRouteForRequest: async () => {},
        appendCostCredits: async (rId, _u, credits, _s, _ps, _da, tKey) => {
          folded.push({ reqId: rId, credits, turnKey: tKey ?? '' })
        },
      },
      uid,
      {
        engine: 'antigravity',
        requestId: req1,
        engineSessionId: `oceng-${'1'.repeat(48)}`,
        status: 'success',
        durationMs: 1_000,
        turnKey: tk1,
      },
    )
    assert.equal(d1, 'committed')
    assert.equal(await balance(uid), 4_985n)
    assert.deepEqual(folded, [{ reqId: req1, credits: '15', turnKey: tk1 }])
    const ur1 = await query<{ turn_key: string | null; cost_credits: string }>(
      'SELECT turn_key, cost_credits::text FROM usage_records WHERE request_id = $1',
      [req1],
    )
    assert.equal(ur1.rows[0]?.turn_key, tk1)
    assert.equal(ur1.rows[0]?.cost_credits, '15')

    // 2. Late orphaned worker stream finishes AFTER parent turn settled as 'success':
    //    parent row stays immutable (OCV5-451 preserved), while exact delta (6 credits) settles once under CAS lateRequestId!
    await usageRow(req1, uid, 50_000, 0) // +50k*120 = +6 credits -> cumulative 21, delta = 6
    const [lateA, lateB] = await Promise.all([
      settleLateAntigravityRelayUsage({
        pool: getPool(),
        pricing,
        requestId: req1,
        userId: uid,
        appendCostCredits: async (rId, _u, credits, _s, _ps, _da, tKey) => {
          folded.push({ reqId: rId, credits, turnKey: tKey ?? '' })
        },
      }),
      settleLateAntigravityRelayUsage({
        pool: getPool(),
        pricing,
        requestId: req1,
        userId: uid,
        appendCostCredits: async (rId, _u, credits, _s, _ps, _da, tKey) => {
          folded.push({ reqId: rId, credits, turnKey: tKey ?? '' })
        },
      }),
    ])
    assert.equal(Number(lateA) + Number(lateB), 1, 'concurrent late stream settle must commit once via CAS')
    assert.equal(await balance(uid), 4_979n) // 4985 - 6 = 4979
    // Parent usage_records row MUST remain 15 credits (OCV5-451 invariant!)
    const parentAfterLate = await query<{ cost_credits: string }>(
      'SELECT cost_credits::text FROM usage_records WHERE request_id = $1',
      [req1],
    )
    assert.equal(parentAfterLate.rows[0]?.cost_credits, '15')
    assert.equal(folded.length, 2)
    assert.equal(folded[1]?.credits, '6')
    assert.equal(folded[1]?.turnKey, tk1)

    // 3. Raced live WS settled without turnKey before tape finalize -> durable settle backfills turn_key & folds once without double debit
    const req2 = rid()
    const tk2 = createHash('sha256').update(`tk2:${req2}`).digest('hex')
    await recordAntigravityTurn(getPool(), {
      requestId: req2,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-durable-2',
      traceId: null,
    })
    await usageRow(req2, uid, 100_000, 20_000) // 15 credits
    await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId: req2,
      userId: uid,
      engineStatus: 'success',
    })
    assert.equal(await balance(uid), 4_964n)
    const d2 = await settleDurableAntigravityBilling(
      {
        pgPool: getPool(),
        pricing,
        expireRouteForRequest: async () => {},
        appendCostCredits: async (rId, _u, credits, _s, _ps, _da, tKey) => {
          folded.push({ reqId: rId, credits, turnKey: tKey ?? '' })
        },
      },
      uid,
      {
        engine: 'antigravity',
        requestId: req2,
        engineSessionId: `oceng-${'2'.repeat(48)}`,
        status: 'success',
        durationMs: 1_000,
        turnKey: tk2,
      },
    )
    assert.equal(d2, 'already_committed')
    assert.equal(await balance(uid), 4_964n, 'must not double-charge when live WS raced ahead')
    const ur2 = await query<{ turn_key: string | null }>(
      'SELECT turn_key FROM usage_records WHERE request_id = $1',
      [req2],
    )
    assert.equal(ur2.rows[0]?.turn_key, tk2, 'must backfill turn_key onto usage_records')
    assert.equal(folded[folded.length - 1]?.turnKey, tk2)

    // 4. Stale reconciler (`engineStatus: 'unknown'`) inspects turn_dispatches outcome:
    //    crashed / interrupted dispatches waive at 0 credits instead of overcharging as RECONCILED,
    //    and >6h stale manual_reconcile no longer strands antigravity_turns forever!
    const reqCrash = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: reqCrash,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-crash-reconcile',
      traceId: null,
    })
    await usageRow(reqCrash, uid, 500_000, 100_000) // would be 75 credits if wrongly charged!
    await query(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, model, request_hash,
          billing_request_id, status, outcome, owner_id, lease_epoch, lease_until, admitted_at)
       VALUES ($1, $2, 's-crash-reconcile', $3, 'main', $4, 'h1', $5,
               'terminal', 'crashed', 'm1', 1, NOW() - INTERVAL '7 hours', NOW() - INTERVAL '7 hours')`,
      [randomUUID(), uid.toString(), `cm-${reqCrash.slice(-8)}`, MODEL, reqCrash],
    )
    await query(
      "UPDATE antigravity_turns SET updated_at = NOW() - INTERVAL '1 hour' WHERE request_id = $1",
      [reqCrash],
    )
    const tickRes = await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
    })
    assert.ok(tickRes.settled >= 1)
    assert.equal(await balance(uid), 4_964n, 'crashed dispatch must be waived at 0 credits by reconciler')
    assert.equal(await turnStatus(reqCrash), 'settled')
    const crashUr = await query<{ cost_credits: string; snapshot: Record<string, unknown> }>(
      'SELECT cost_credits::text, price_snapshot AS snapshot FROM usage_records WHERE request_id = $1',
      [reqCrash],
    )
    assert.equal(crashUr.rows[0]?.cost_credits, '0')
    assert.equal(crashUr.rows[0]?.snapshot.antigravity_terminal_code, 'ENGINE_ERROR')
  })

  test('OCV5-887 R2 blockers B2/B3/B4/B5/B11: executed_error waive, late-stream reconciler sweep, delegate 1.5x frozen pricing & 2x price-hike immunity, clamped-0 real appendCostCredits, and foreign requestId zero side-effect fence', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await query(
      `INSERT INTO sessions_store_migration_state
         (singleton, authority, generation, cutover_id, source_digest, completed_at)
       VALUES (true, 'pg_authoritative', 1, 'test', 'test', 1)
       ON CONFLICT (singleton) DO UPDATE
         SET authority = 'pg_authoritative', generation = 1, cutover_id = 'test', source_digest = 'test', completed_at = 1`,
    )
    const sessionsBackend = createPgSessionsBackend(getPool(), { expectedGeneration: 1 })
    const realAppendCostCredits = (
      rId: string,
      rawUid: string,
      cost: string,
      sessId?: string | null,
      parentSessId?: string | null,
      delAgent?: string | null,
      tKey?: string | null,
      pTurnKey?: string | null,
    ) =>
      sessionsBackend.appendCostCredits(
        rId,
        rawUid.startsWith('c:') ? rawUid : `c:${rawUid}`,
        cost,
        sessId,
        parentSessId,
        delAgent,
        tKey,
        pTurnKey,
      )

    const uidA = await user(1_000n)
    const uidB = await user(0n) // zero wallet balance to prove B5 clamped-0 actual debit!

    // B11: Foreign / unknown requestId MUST return immediately with ZERO expireRouteForRequest calls!
    const foreignReq = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: foreignReq,
      userId: uidA,
      modelId: MODEL,
      sessionId: 's-b11',
      traceId: null,
    })
    let expiredCalls = 0
    await settleDurableAntigravityBilling(
      {
        pgPool: getPool(),
        pricing,
        expireRouteForRequest: async () => {
          expiredCalls += 1
        },
      },
      uidB, // wrong tenant!
      {
        engine: 'antigravity',
        requestId: foreignReq,
        engineSessionId: `oceng-${'9'.repeat(48)}`,
        status: 'success',
        durationMs: 500,
      },
    )
    assert.equal(expiredCalls, 0, 'B11: foreign tenant must never trigger route expiry')

    // B2: Real turnDispatchReconciler writes outcome='executed_error' -> reconciler MUST waive at 0 credits!
    //     And an open `status='accepted'` dispatch MUST stay pending (not prematurely charged)!
    const reqExecErr = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: reqExecErr,
      userId: uidA,
      modelId: MODEL,
      sessionId: 's-b2-exec-err',
      traceId: null,
    })
    await usageRow(reqExecErr, uidA, 200_000, 40_000) // 30 credits if wrongly charged
    await query(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, model, request_hash,
          billing_request_id, status, outcome, failure_code, owner_id, lease_epoch, lease_until, admitted_at)
       VALUES ($1, $2, 's-b2-exec-err', $3, 'main', $4, 'h-b2', $5,
               'terminal', 'executed_error', 'SERVICE_RESTART', 'm1', 1, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')`,
      [randomUUID(), uidA.toString(), `cm-${reqExecErr.slice(-8)}`, MODEL, reqExecErr],
    )
    await query("UPDATE antigravity_turns SET updated_at = NOW() - INTERVAL '1 hour' WHERE request_id = $1", [reqExecErr])

    const reqOpen = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: reqOpen,
      userId: uidA,
      modelId: MODEL,
      sessionId: 's-b2-open',
      traceId: null,
    })
    await usageRow(reqOpen, uidA, 100_000, 10_000)
    await query(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, model, request_hash,
          billing_request_id, status, outcome, owner_id, lease_epoch, lease_until, admitted_at)
       VALUES ($1, $2, 's-b2-open', $3, 'main', $4, 'h-b2o', $5,
               'accepted', NULL, 'm1', 1, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '7 hours')`,
      [randomUUID(), uidA.toString(), `cm-${reqOpen.slice(-8)}`, MODEL, reqOpen],
    )
    await query("UPDATE antigravity_turns SET updated_at = NOW() - INTERVAL '1 hour' WHERE request_id = $1", [reqOpen])

    await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
    })
    assert.equal(await balance(uidA), 1_000n, 'B2: executed_error waived 0 and open dispatch left pending')
    assert.equal(await turnStatus(reqExecErr), 'settled')
    assert.equal(await turnStatus(reqOpen), 'pending', 'B2: non-terminal dispatch must remain pending')

    // B4(a): Delegate Antigravity frozen 2.000x multiplier in request_finalize_journal + B4(b) 3x live price hike on late stream!
    const reqDel = rid()
    const tkParent = createHash('sha256').update(`parent:${reqDel}`).digest('hex')
    await sessionsBackend.upsertClientSession({
      id: 's-b4-parent',
      userId: `c:${uidA}`,
      agentId: 'main',
      title: 'B4',
      pinned: false,
      createdAt: Date.now(),
      lastAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: 'cm-b4', role: 'user', text: 'go', ts: Date.now() }],
    })
    const tapeBytes = Buffer.from(
      JSON.stringify({
        sessionId: 's-b4-parent',
        agentId: 'main',
        turnIndex: 1,
        status: 'completed',
        turnKey: tkParent,
        clientMessageId: 'cm-b4',
        text: 'done',
        createdAt: Date.now(),
      }),
    )
    const tapeHash = createHash('sha256').update(tapeBytes).digest('hex')
    const baseTape = {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      sessionId: 's-b4-parent',
      agentId: 'main',
      turnIndex: 1,
      status: 'completed' as const,
      turnKey: tkParent,
      tapeId: tkParent,
      tapeSha256: tapeHash,
      totalBytes: tapeBytes.length,
      partCount: 1,
      createdAt: Date.now(),
    }
    await sessionsBackend.stageLosslessTurnTapePart(
      `c:${uidA}`,
      { ...baseTape, action: 'part', partIndex: 0, partSha256: tapeHash, data: tapeBytes.toString('base64') },
      tapeBytes,
    )
    await sessionsBackend.finalizeLosslessTurnTape(`c:${uidA}`, { ...baseTape, action: 'finalize' })

    const frozen2x = { ...PRICING, multiplier: '2.000' } as ModelPricing
    await startInflightJournal(getPool(), {
      requestId: reqDel,
      userId: uidA,
      containerId: null,
      model: MODEL,
      precheckCredits: 100n,
      ctxJson: {
        source: 'delegate_antigravity',
        model: MODEL,
        delegateAgentId: 'auditor',
        parentSessionId: 's-b4-parent',
        parentTurnKey: tkParent,
        billingPricing: serializeBillingPricing(frozen2x),
      },
    })
    await recordAntigravityTurn(getPool(), {
      requestId: reqDel,
      userId: uidA,
      modelId: MODEL,
      sessionId: 's-b4-child',
      traceId: null,
    })
    await usageRow(reqDel, uidA, 100_000, 20_000) // base=15 -> frozen 2.000x = 30 credits!
    const delOut = await settleDurableAntigravityBilling(
      {
        pgPool: getPool(),
        pricing, // live pricing is 1.000x (15), journal frozen is 2.000x (30)!
        expireRouteForRequest: async () => {},
        appendCostCredits: realAppendCostCredits,
      },
      uidA,
      {
        engine: 'antigravity',
        requestId: reqDel,
        engineSessionId: `oceng-${'4'.repeat(48)}`,
        status: 'success',
        durationMs: 800,
        parentTurnKey: tkParent,
        parentSessionId: 's-b4-parent',
        delegateAgentId: 'auditor',
      },
    )
    assert.equal(delOut, 'committed')
    assert.equal(await balance(uidA), 970n, 'B4(a): delegate must debit frozen 2.000x rate (30), not live 1.000x (15)')
    const jState = await query<{ state: string }>('SELECT state FROM request_finalize_journal WHERE request_id = $1', [reqDel])
    assert.equal(jState.rows[0]?.state, 'committed')

    // B3 + B4(b): Simulate a late stream row that missed initial settle (interleaved before COMMIT),
    // AND hike live catalog price 3x (`multiplier: '3.000'`). Reconciler tick MUST sweep the late row
    // and price ONLY the late delta at the frozen 2.000x rate (+50k in = base 6 * 2.000x = 12 credits, NOT 3x*(15+6)-30 = 33)!
    await usageRow(reqDel, uidA, 50_000, 0)
    const hiked3xPricing = {
      get: (id: string) => (id === MODEL ? ({ ...PRICING, multiplier: '3.000' } as ModelPricing) : null),
    } as unknown as PricingCache
    const lateTick = await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing: hiked3xPricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
      appendCostCredits: realAppendCostCredits,
    })
    assert.equal(lateTick.lateSettled, 1, 'B3: reconciler tick must sweep missed post-SUM/pre-COMMIT late stream')
    assert.equal(await balance(uidA), 958n, 'B4(b): late delta must charge frozen 2x delta (12), never reprice history at 3x')

    // B5: Wallet balance=0 (uidB): live WS settles without turnKey (nominal cost_credits=15, actual debited=0, ledger_id=NULL)
    //     and parks a keyless pending_usage_patches row (cost_credits='0', turn_key=NULL).
    //     Durable settle MUST upgrade keyless pending & fold ACTUAL 0 credits (NEVER nominal 15!) into turn_tape_cost_components!
    const reqClamp = rid()
    const tkClamp = createHash('sha256').update(`clamp:${reqClamp}`).digest('hex')
    await sessionsBackend.upsertClientSession({
      id: 's-b5-clamp',
      userId: `c:${uidB}`,
      agentId: 'main',
      title: 'B5',
      pinned: false,
      createdAt: Date.now(),
      lastAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: 'cm-b5', role: 'user', text: 'go', ts: Date.now() }],
    })
    await recordAntigravityTurn(getPool(), {
      requestId: reqClamp,
      userId: uidB,
      modelId: MODEL,
      sessionId: 's-b5-clamp',
      traceId: null,
    })
    await usageRow(reqClamp, uidB, 100_000, 20_000) // nominal 15, wallet=0 -> clamped debited=0!
    const liveClamp = await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId: reqClamp,
      userId: uidB,
      engineStatus: 'success',
    })
    assert.ok(liveClamp)
    assert.equal(liveClamp.settled.debitedCredits, 0n)
    // Simulate keyless pending_usage_patches parked before tape finalize
    await realAppendCostCredits(reqClamp, uidB.toString(), '0', 's-b5-clamp', null, null, null, null)

    const clampTapeBytes = Buffer.from(
      JSON.stringify({
        sessionId: 's-b5-clamp',
        agentId: 'main',
        turnIndex: 1,
        status: 'completed',
        turnKey: tkClamp,
        clientMessageId: 'cm-b5',
        text: 'clamped ok',
        createdAt: Date.now(),
      }),
    )
    const clampHash = createHash('sha256').update(clampTapeBytes).digest('hex')
    const clampBase = {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      sessionId: 's-b5-clamp',
      agentId: 'main',
      turnIndex: 1,
      status: 'completed' as const,
      turnKey: tkClamp,
      tapeId: tkClamp,
      tapeSha256: clampHash,
      totalBytes: clampTapeBytes.length,
      partCount: 1,
      createdAt: Date.now(),
    }
    await sessionsBackend.stageLosslessTurnTapePart(
      `c:${uidB}`,
      { ...clampBase, action: 'part', partIndex: 0, partSha256: clampHash, data: clampTapeBytes.toString('base64') },
      clampTapeBytes,
    )
    await sessionsBackend.finalizeLosslessTurnTape(`c:${uidB}`, { ...clampBase, action: 'finalize' })

    const repairClamp = await settleDurableAntigravityBilling(
      {
        pgPool: getPool(),
        pricing,
        expireRouteForRequest: async () => {},
        appendCostCredits: realAppendCostCredits,
      },
      uidB,
      {
        engine: 'antigravity',
        requestId: reqClamp,
        engineSessionId: `oceng-${'5'.repeat(48)}`,
        status: 'success',
        durationMs: 600,
        turnKey: tkClamp,
      },
    )
    assert.equal(repairClamp, 'already_committed')
    const compRes = await query<{ cost_credits: string }>(
      'SELECT cost_credits::text FROM turn_tape_cost_components WHERE user_id = $1 AND request_id = $2',
      [`c:${uidB}`, reqClamp],
    )
    assert.equal(compRes.rows[0]?.cost_credits, '0', 'B5: folded tape cost component must equal actual debit 0, never nominal 15')

    // R2 final closure proofs:
    // (a) B4①: Already-aborted delegate journal MUST NOT charge when a late `success` tape arrives!
    const reqAbortedDel = rid()
    await startInflightJournal(getPool(), {
      requestId: reqAbortedDel,
      userId: uidA,
      containerId: null,
      model: MODEL,
      precheckCredits: 100n,
      ctxJson: {
        source: 'delegate_antigravity',
        model: MODEL,
        billingPricing: serializeBillingPricing(PRICING),
      },
    })
    await query("UPDATE request_finalize_journal SET state = 'aborted' WHERE request_id = $1", [reqAbortedDel])
    await recordAntigravityTurn(getPool(), {
      requestId: reqAbortedDel,
      userId: uidA,
      modelId: MODEL,
      sessionId: 's-b4-aborted',
      traceId: null,
    })
    await usageRow(reqAbortedDel, uidA, 100_000, 20_000) // would be 15 credits if wrongly settled!
    const abortedOut = await settleDurableAntigravityBilling(
      { pgPool: getPool(), pricing, expireRouteForRequest: async () => {} },
      uidA,
      {
        engine: 'antigravity',
        requestId: reqAbortedDel,
        engineSessionId: `oceng-${'6'.repeat(48)}`,
        status: 'success',
        durationMs: 400,
      },
    )
    assert.equal(abortedOut, 'waived', 'B4①: aborted delegate journal must return waived without debiting')
    assert.equal(await balance(uidA), 958n, 'B4①: balance must stay completely untouched')

    // (b) B3 R2: Mixed HTTP 200 + HTTP 429 in parent (`antigravity_calls = 2`), followed by a late HTTP 200:
    //     total rows = 3 > 2, so reconciler MUST select and bill the late HTTP 200 row!
    const reqMixed = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: reqMixed,
      userId: uidA,
      modelId: MODEL,
      sessionId: 's-b3-mixed',
      traceId: null,
    })
    await usageRow(reqMixed, uidA, 100_000, 20_000) // HTTP 200 (15 credits)
    await query(
      `INSERT INTO antigravity_relay_usage
         (call_id, request_id, user_id, route_model_id, upstream_model, request_type, status_code,
          prompt_tokens, candidates_tokens, thoughts_tokens, cached_tokens)
       VALUES (gen_random_uuid(), $1, $2, $3, 'gemini-3.8-flash-low', 'agent', 429, 0, 0, 0, 0)`,
      [reqMixed, uidA.toString(), MODEL],
    )
    await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId: reqMixed,
      userId: uidA,
      engineStatus: 'success',
    })
    assert.equal(await balance(uidA), 943n) // 958 - 15 = 943 (parent accounted_calls = 2)
    // Late HTTP 200 arrives (total rows = 3, HTTP<400 rows = 2 == parent accounted_calls = 2!)
    await usageRow(reqMixed, uidA, 50_000, 0) // +6 credits
    const mixedTick = await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
    })
    assert.equal(mixedTick.lateSettled, 1, 'B3 R2: mixed 200+429 turn must still sweep late 200 row')
    assert.equal(await balance(uidA), 937n) // 943 - 6 = 937
  })

  test('OCV5-887 audit fixes P1-01~06 & P2-01/02/04: aborted delegate guard, finalizing unstuck, journal-first attribution, frozen aux fallback, per-row 410 ignore, late turn_key cascade, manual_reconcile hold, ASC late scan + error count, AUTH/QUOTA terminal codes', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const uid = await user(10_000n)

    // P1-01: Aborted delegate_antigravity journal must NEVER be billed by reconciler / direct settle;
    // antigravity_turns closes to 'abandoned' even when relay rows exist.
    const reqAbortedTick = rid()
    await startInflightJournal(getPool(), {
      requestId: reqAbortedTick,
      userId: uid,
      containerId: null,
      model: MODEL,
      precheckCredits: 100n,
      ctxJson: {
        source: 'delegate_antigravity',
        model: MODEL,
        durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
        billingPricing: serializeBillingPricing(PRICING),
      },
    })
    await query("UPDATE request_finalize_journal SET state = 'aborted' WHERE request_id = $1", [
      reqAbortedTick,
    ])
    await recordAntigravityTurn(getPool(), {
      requestId: reqAbortedTick,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-p1-01',
      traceId: null,
    })
    await usageRow(reqAbortedTick, uid, 200_000, 40_000) // would be 30 credits if wrongly charged
    await query(
      "UPDATE antigravity_turns SET updated_at = NOW() - INTERVAL '3 hours' WHERE request_id = $1",
      [reqAbortedTick],
    )
    const p101Tick = await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
    })
    assert.equal(p101Tick.settled, 0)
    assert.equal(await balance(uid), 10_000n, 'P1-01: aborted delegate must never debit on reconcile tick')
    assert.equal(await turnStatus(reqAbortedTick), 'abandoned', 'P1-01: turn closes to abandoned')
    assert.equal(
      (await query('SELECT 1 FROM usage_records WHERE request_id = $1', [reqAbortedTick])).rowCount,
      0,
    )

    // P1-01(b): Invalid frozen delegate pricing in settleDurableAntigravityBilling also marks turn abandoned.
    const reqBadPricing = rid()
    await startInflightJournal(getPool(), {
      requestId: reqBadPricing,
      userId: uid,
      containerId: null,
      model: MODEL,
      precheckCredits: 100n,
      ctxJson: {
        source: 'delegate_antigravity',
        model: MODEL,
        durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
        billingPricing: { bad: true },
      },
    })
    await recordAntigravityTurn(getPool(), {
      requestId: reqBadPricing,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-p1-01b',
      traceId: null,
    })
    await usageRow(reqBadPricing, uid, 100_000, 20_000)
    const badPricingOut = await settleDurableAntigravityBilling(
      { pgPool: getPool(), pricing, expireRouteForRequest: async () => {} },
      uid,
      {
        engine: 'antigravity',
        requestId: reqBadPricing,
        engineSessionId: `oceng-${'a'.repeat(48)}`,
        status: 'success',
        durationMs: 200,
      },
    )
    assert.equal(badPricingOut, 'waived')
    assert.equal(await turnStatus(reqBadPricing), 'abandoned')
    assert.equal(await balance(uid), 10_000n)

    // P1-02: Crashed delegate_antigravity finalizing journal (no usage_records) is reset to inflight
    // with settlementClaimId stripped by reconcileStuckFinalizeJournal, then settled cleanly on retry.
    const reqStuckFin = rid()
    await startInflightJournal(getPool(), {
      requestId: reqStuckFin,
      userId: uid,
      containerId: null,
      model: MODEL,
      precheckCredits: 100n,
      ctxJson: {
        source: 'delegate_antigravity',
        model: MODEL,
        durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
        billingPricing: serializeBillingPricing(PRICING),
        settlementClaimId: 'crashed-claim-p102',
      },
    })
    await query(
      `UPDATE request_finalize_journal
          SET state = 'finalizing', updated_at = NOW() - INTERVAL '45 minutes'
        WHERE request_id = $1`,
      [reqStuckFin],
    )
    await recordAntigravityTurn(getPool(), {
      requestId: reqStuckFin,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-p1-02',
      traceId: null,
    })
    // Simulate crash AFTER BOTH journal -> finalizing AND antigravity_turns -> settling!
    await query(
      `UPDATE antigravity_turns
          SET status = 'settling', updated_at = NOW() - INTERVAL '45 minutes'
        WHERE request_id = $1`,
      [reqStuckFin],
    )
    await usageRow(reqStuckFin, uid, 100_000, 20_000) // 15 credits
    await reconcileStuckFinalizeJournal(30 * 60_000)
    const unstuckRow = await query<{ state: string; claim: string | null }>(
      "SELECT state, ctx->>'settlementClaimId' AS claim FROM request_finalize_journal WHERE request_id = $1",
      [reqStuckFin],
    )
    assert.equal(unstuckRow.rows[0]?.state, 'inflight', 'P1-02: stuck delegate finalizing resets to inflight')
    assert.equal(unstuckRow.rows[0]?.claim, null, 'P1-02: stale settlementClaimId must be removed')
    assert.equal(await turnStatus(reqStuckFin), 'pending', 'P1-02: paired settling antigravity_turns resets to pending')
    const p102Out = await settleDurableAntigravityBilling(
      { pgPool: getPool(), pricing, expireRouteForRequest: async () => {} },
      uid,
      {
        engine: 'antigravity',
        requestId: reqStuckFin,
        engineSessionId: `oceng-${'b'.repeat(48)}`,
        status: 'success',
        durationMs: 300,
      },
    )
    assert.equal(p102Out, 'committed')
    assert.equal(await turnStatus(reqStuckFin), 'settled')
    assert.equal(await balance(uid), 9_985n)

    // P1-03: Journal delegate attribution takes precedence over conflicting frame fields.
    const reqP103 = rid()
    const tkJournal = createHash('sha256').update(`p103-journal:${reqP103}`).digest('hex')
    const tkFrame = createHash('sha256').update(`p103-frame:${reqP103}`).digest('hex')
    await startInflightJournal(getPool(), {
      requestId: reqP103,
      userId: uid,
      containerId: null,
      model: MODEL,
      precheckCredits: 100n,
      ctxJson: {
        source: 'delegate_antigravity',
        model: MODEL,
        durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
        parentTurnKey: tkJournal,
        parentSessionId: 's-journal-parent',
        delegateAgentId: 'journal-agent',
        billingPricing: serializeBillingPricing(PRICING),
      },
    })
    await recordAntigravityTurn(getPool(), {
      requestId: reqP103,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-p1-03-child',
      traceId: null,
    })
    await usageRow(reqP103, uid, 100_000, 20_000) // 15 credits
    const p103CostCalls: Array<{
      parentSessionId: string | null | undefined
      delegateAgentId: string | null | undefined
      parentTurnKey: string | null | undefined
    }> = []
    await settleDurableAntigravityBilling(
      {
        pgPool: getPool(),
        pricing,
        expireRouteForRequest: async () => {},
        appendCostCredits: async (_r, _u, _c, _s, ps, da, _tk, ptk) => {
          p103CostCalls.push({ parentSessionId: ps, delegateAgentId: da, parentTurnKey: ptk })
        },
      },
      uid,
      {
        engine: 'antigravity',
        requestId: reqP103,
        engineSessionId: `oceng-${'c'.repeat(48)}`,
        status: 'success',
        durationMs: 300,
        parentTurnKey: tkFrame,
        parentSessionId: 's-frame-parent',
        delegateAgentId: 'frame-agent',
      },
    )
    const p103Ur = await query<{
      parent_turn_key: string | null
      parent_session_id: string | null
      delegate_agent_id: string | null
    }>(
      'SELECT parent_turn_key, parent_session_id, delegate_agent_id FROM usage_records WHERE request_id = $1',
      [reqP103],
    )
    assert.equal(p103Ur.rows[0]?.parent_turn_key, tkJournal)
    assert.equal(p103Ur.rows[0]?.parent_session_id, 's-journal-parent')
    assert.equal(p103Ur.rows[0]?.delegate_agent_id, 'journal-agent')
    assert.deepEqual(p103CostCalls, [
      { parentSessionId: 's-journal-parent', delegateAgentId: 'journal-agent', parentTurnKey: tkJournal },
    ])
    assert.equal(await balance(uid), 9_970n)

    // P1-04: Late aux call keeps parent's frozen fallback rate (20/80/1) even after live catalog adds 10x price.
    const reqP104 = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: reqP104,
      userId: uid,
      modelId: NEON_MODEL,
      sessionId: 's-p1-04',
      traceId: null,
    })
    await customUsageRow({
      requestId: reqP104,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-3.5-flash-lite',
      requestType: 'web_search',
      prompt: 1_000_000, // 20 credits at fallback 20/MTok
      out: 0,
    })
    await customUsageRow({
      requestId: reqP104,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-4-neon-high',
      requestType: 'agent',
      prompt: 0,
      out: 1_000, // 3 credits at Neon 3000/MTok -> total 23 credits
    })
    assert.ok(
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing: neonPricingCache,
        requestId: reqP104,
        userId: uid,
        engineStatus: 'success',
      }),
    )
    assert.equal(await balance(uid), 9_947n) // 9970 - 23 = 9947
    // Late aux call (500k input -> 10 credits at frozen fallback 20/MTok)
    await customUsageRow({
      requestId: reqP104,
      userId: uid,
      routeModelId: NEON_MODEL,
      upstreamModel: 'gemini-3.5-flash-lite',
      requestType: 'web_search',
      prompt: 500_000,
      out: 0,
    })
    const hikedAuxCatalog = {
      get: (id: string) => {
        if (id === NEON_MODEL) return NEON_PRICING
        if (id === 'gemini-3.5-flash-lite' || id === 'antigravity-gemini-3.5-flash-lite') {
          return {
            model_id: id,
            display_name: 'Hiked Flash Lite',
            input_per_mtok: 200n,
            output_per_mtok: 800n,
            cache_read_per_mtok: 10n,
            cache_write_per_mtok: 0n,
            multiplier: '1.000',
            enabled: true,
          } as unknown as ModelPricing
        }
        return null
      },
    } as unknown as PricingCache
    assert.equal(
      await settleLateAntigravityRelayUsage({
        pool: getPool(),
        pricing: hikedAuxCatalog,
        requestId: reqP104,
        userId: uid,
      }),
      true,
    )
    assert.equal(await balance(uid), 9_937n, 'P1-04: late aux must charge frozen fallback 10 credits, never 280')

    // P1-05: Settled success turn ignores late HTTP 410 rows and still bills valid late HTTP 200 rows
    // (including when parent already recorded an extra-model 410 row).
    const reqP105 = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: reqP105,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-p1-05',
      traceId: null,
    })
    await usageRow(reqP105, uid, 100_000, 20_000) // 15 credits
    await query(
      `INSERT INTO antigravity_relay_usage
         (call_id, request_id, user_id, route_model_id, upstream_model, request_type, status_code)
       VALUES (gen_random_uuid(), $1, $2, $3, 'gemini-4-neon-high', 'agent', 410)`,
      [reqP105, uid.toString(), MODEL],
    )
    assert.ok(
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing,
        requestId: reqP105,
        userId: uid,
        engineStatus: 'success',
      }),
    )
    assert.equal(await balance(uid), 9_922n) // 9937 - 15
    // Late primary 410 + late primary 200 (50k in -> 6 credits)
    await query(
      `INSERT INTO antigravity_relay_usage
         (call_id, request_id, user_id, route_model_id, upstream_model, request_type, status_code)
       VALUES (gen_random_uuid(), $1, $2, $3, 'gemini-3.8-flash-low', 'agent', 410)`,
      [reqP105, uid.toString(), MODEL],
    )
    await usageRow(reqP105, uid, 50_000, 0) // +6 credits
    const p105Tick = await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
    })
    assert.equal(p105Tick.lateSettled, 1, 'P1-05: late 410 must not block valid late 200 row')
    assert.equal(await balance(uid), 9_916n) // 9922 - 6
    const p105Tick2 = await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
    })
    assert.equal(p105Tick2.lateSettled, 0, 'P1-05: subsequent tick is idempotent')

    // P1-06: Parent settled without turnKey + late delta settled without turnKey ->
    // durable tape finalize cascades turn_key and real credit_ledger appendCostCredits to late delta row!
    const reqP106 = rid()
    const tkP106 = createHash('sha256').update(`p106:${reqP106}`).digest('hex')
    await recordAntigravityTurn(getPool(), {
      requestId: reqP106,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-p1-06',
      traceId: null,
    })
    await usageRow(reqP106, uid, 100_000, 20_000) // 15 credits
    await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId: reqP106,
      userId: uid,
      engineStatus: 'success',
    })
    await usageRow(reqP106, uid, 50_000, 0) // +6 credits late before tape finalize
    assert.equal(
      await settleLateAntigravityRelayUsage({
        pool: getPool(),
        pricing,
        requestId: reqP106,
        userId: uid,
      }),
      true,
    )
    const p106Folded: Array<{ reqId: string; credits: string; turnKey: string | null | undefined }> = []
    const p106Res = await settleDurableAntigravityBilling(
      {
        pgPool: getPool(),
        pricing,
        expireRouteForRequest: async () => {},
        appendCostCredits: async (rId, _u, credits, _s, _ps, _da, tKey) => {
          p106Folded.push({ reqId: rId, credits, turnKey: tKey })
        },
      },
      uid,
      {
        engine: 'antigravity',
        requestId: reqP106,
        engineSessionId: `oceng-${'d'.repeat(48)}`,
        status: 'success',
        durationMs: 400,
        turnKey: tkP106,
      },
    )
    assert.equal(p106Res, 'already_committed')
    const p106LateRow = await query<{ request_id: string; turn_key: string | null }>(
      `SELECT request_id, turn_key FROM usage_records
        WHERE user_id = $1 AND price_snapshot->>'antigravity_late_of' = $2`,
      [uid.toString(), reqP106],
    )
    assert.equal(p106LateRow.rows.length, 1)
    assert.equal(p106LateRow.rows[0]?.turn_key, tkP106, 'P1-06: late delta row must receive cascaded turn_key')
    assert.deepEqual(p106Folded, [
      { reqId: reqP106, credits: '15', turnKey: tkP106 },
      { reqId: p106LateRow.rows[0]!.request_id, credits: '6', turnKey: tkP106 },
    ])
    assert.equal(await balance(uid), 9_895n) // 9916 - 15 - 6

    // P2-01: Unresolved manual_reconcile older than 6h remains protected and does not spin in reconciler.
    const reqManual = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: reqManual,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-p2-01',
      traceId: null,
    })
    await usageRow(reqManual, uid, 100_000, 20_000)
    await query(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, model, request_hash,
          billing_request_id, status, outcome, conflict_reason, owner_id, lease_epoch, lease_until, admitted_at)
       VALUES ($1, $2, 's-p2-01', $3, 'main', $4, 'h-p201', $5,
               'manual_reconcile', NULL, 'billed_ambiguous', 'm1', 1, NOW() - INTERVAL '8 hours', NOW() - INTERVAL '8 hours')`,
      [randomUUID(), uid.toString(), `cm-${reqManual.slice(-8)}`, MODEL, reqManual],
    )
    await query(
      "UPDATE antigravity_turns SET updated_at = NOW() - INTERVAL '2 hours' WHERE request_id = $1",
      [reqManual],
    )
    const manualClaim = await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId: reqManual,
      userId: uid,
      engineStatus: 'unknown',
      staleBefore: new Date(),
    })
    assert.equal(manualClaim, null, 'P2-01: unresolved manual_reconcile >6h must stay protected')
    assert.equal(await turnStatus(reqManual), 'pending')

    // P2-02: Late scan prioritizes oldest turns first (ORDER BY t.updated_at ASC) and increments errors on scan failure.
    const reqOldLate = rid()
    const reqNewLate = rid()
    for (const rId of [reqOldLate, reqNewLate]) {
      await recordAntigravityTurn(getPool(), {
        requestId: rId,
        userId: uid,
        modelId: MODEL,
        sessionId: `s-${rId}`,
        traceId: null,
      })
      await usageRow(rId, uid, 100_000, 20_000) // 15 credits
      await settleAntigravityTurnRecord({
        pool: getPool(),
        pricing,
        requestId: rId,
        userId: uid,
        engineStatus: 'success',
      })
      await usageRow(rId, uid, 50_000, 0) // +6 credits late
    }
    await query("UPDATE antigravity_turns SET updated_at = NOW() - INTERVAL '2 hours' WHERE request_id = $1", [
      reqOldLate,
    ])
    await query("UPDATE antigravity_turns SET updated_at = NOW() - INTERVAL '1 minute' WHERE request_id = $1", [
      reqNewLate,
    ])
    const ascTick = await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing,
      minAgeMs: 5_000,
      batchSize: 1,
      expireRouteForRequest: async () => {},
    })
    assert.equal(ascTick.lateSettled, 1)
    assert.equal(
      (
        await query(
          "SELECT 1 FROM usage_records WHERE user_id = $1 AND price_snapshot->>'antigravity_late_of' = $2",
          [uid.toString(), reqOldLate],
        )
      ).rowCount,
      1,
      'P2-02: oldest turn must be swept before newer turn',
    )
    assert.equal(
      (
        await query(
          "SELECT 1 FROM usage_records WHERE user_id = $1 AND price_snapshot->>'antigravity_late_of' = $2",
          [uid.toString(), reqNewLate],
        )
      ).rowCount,
      0,
    )
    // Drain remaining late turn and verify outer late-scan catch increments errors.
    await runAntigravityTurnReconcileTick({
      pgPool: getPool(),
      pricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
    })
    let stubQueryCount = 0
    const errTick = await runAntigravityTurnReconcileTick({
      pgPool: {
        query: async () => {
          stubQueryCount += 1
          if (stubQueryCount === 1) return { rows: [] }
          throw new Error('synthetic late scan failure')
        },
      } as never,
      pricing,
      minAgeMs: 5_000,
      expireRouteForRequest: async () => {},
    })
    assert.equal(errTick.errors, 1, 'P2-02: late-scan SQL failure must increment errors')

    // P2-04: AUTH_UNAVAILABLE / QUOTA_UNAVAILABLE survive losslessTurnTape parse and durableAntigravityBilling settle.
    for (const code of ['AUTH_UNAVAILABLE', 'QUOTA_UNAVAILABLE'] as const) {
      const rId = rid()
      const tk = createHash('sha256').update(`p204:${code}:${rId}`).digest('hex')
      const parsed = parseLosslessTurnPayload({
        sessionId: 'sess-p204-test',
        agentId: 'main',
        turnIndex: 1,
        status: 'crashed',
        turnKey: tk,
        text: '',
        errorCode: code,
        createdAt: Date.now(),
        requestId: rId,
        engineBilling: {
          engine: 'antigravity',
          requestId: rId,
          engineSessionId: `oceng-${'e'.repeat(48)}`,
          status: 'error',
          terminalCode: code,
          durationMs: 100,
          turnKey: tk,
        },
      })
      assert.equal(parsed.engineBilling?.terminalCode, code)
      await recordAntigravityTurn(getPool(), {
        requestId: rId,
        userId: uid,
        modelId: MODEL,
        sessionId: 'sess-p204-test',
        traceId: null,
      })
      await usageRow(rId, uid, 10_000, 100)
      await settleDurableAntigravityBilling(
        { pgPool: getPool(), pricing, expireRouteForRequest: async () => {} },
        uid,
        parsed.engineBilling!,
      )
      const snapRow = await query<{ code: string | null }>(
        "SELECT price_snapshot->>'antigravity_terminal_code' AS code FROM usage_records WHERE request_id = $1",
        [rId],
      )
      assert.equal(snapRow.rows[0]?.code, code, `P2-04: ${code} must be preserved in price_snapshot`)
    }

    // Auditor R1 P1-2: Pre-upgrade parent (1 primary 200 + 1 extra-model 410 => calls=2) +
    // pre-upgrade late child (`late-from:2`, late_calls=1) must NOT collide with `late-from:2`
    // when a new valid late 200 arrives post-upgrade; replay stays idempotent.
    const reqPreUpg = rid()
    await recordAntigravityTurn(getPool(), {
      requestId: reqPreUpg,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-r1-p12',
      traceId: null,
    })
    await usageRow(reqPreUpg, uid, 100_000, 20_000) // primary 200 (15 credits)
    await query(
      `INSERT INTO antigravity_relay_usage
         (call_id, request_id, user_id, route_model_id, upstream_model, request_type, status_code)
       VALUES (gen_random_uuid(), $1, $2, $3, 'gemini-4-neon-high', 'agent', 410)`,
      [reqPreUpg, uid.toString(), MODEL],
    )
    const balBeforePreUpg = await balance(uid)
    await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId: reqPreUpg,
      userId: uid,
      engineStatus: 'success',
    })
    assert.equal(await balance(uid), balBeforePreUpg - 15n)
    // Simulate pre-upgrade late 200 settled using old key `late-from:2` (where calls included the 410).
    await usageRow(reqPreUpg, uid, 50_000, 0) // +6 credits
    const legacyChildReqId = createHash('sha256').update(`${reqPreUpg}:late-from:2`, 'utf8').digest('hex').slice(0, 32)
    await query(
      `INSERT INTO usage_records
         (user_id, request_id, model, mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_credits, status, session_id, price_snapshot)
       VALUES ($1, $2, $3, 'chat', 50000, 0, 0, 0, 6, 'success', 's-r1-p12', $4::jsonb)`,
      [
        uid.toString(),
        legacyChildReqId,
        MODEL,
        JSON.stringify({
          antigravity_status: 'success',
          antigravity_late_of: reqPreUpg,
          antigravity_late_from_calls: 2,
          antigravity_late_calls: 1,
        }),
      ],
    )
    // Now a post-upgrade valid late 200 arrives: must debit +6 using monotonic watermark `late-from:3`, NOT collide with `late-from:2`.
    await usageRow(reqPreUpg, uid, 50_000, 0) // +6 credits
    const balBeforeNewLate = await balance(uid)
    assert.equal(
      await settleLateAntigravityRelayUsage({
        pool: getPool(),
        pricing,
        requestId: reqPreUpg,
        userId: uid,
      }),
      true,
      'R1 P1-2: new valid 200 after pre-upgrade 410+late child must settle cleanly',
    )
    assert.equal(await balance(uid), balBeforeNewLate - 6n)
    assert.equal(
      await settleLateAntigravityRelayUsage({
        pool: getPool(),
        pricing,
        requestId: reqPreUpg,
        userId: uid,
      }),
      false,
      'R1 P1-2: replay must stay idempotent',
    )
    assert.equal(await balance(uid), balBeforeNewLate - 6n)

    // Auditor R1 P1-3: Interleaved late INSERT (saw NULL parent turn_key before commit) and
    // concurrent parent turn_key backfill -> store-load barrier populates late row turn_key & appendCostCredits!
    const reqInterleave = rid()
    const tkInterleave = createHash('sha256').update(`r1-p13:${reqInterleave}`).digest('hex')
    await recordAntigravityTurn(getPool(), {
      requestId: reqInterleave,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-r1-p13',
      traceId: null,
    })
    await usageRow(reqInterleave, uid, 100_000, 20_000) // 15 credits
    await settleAntigravityTurnRecord({
      pool: getPool(),
      pricing,
      requestId: reqInterleave,
      userId: uid,
      engineStatus: 'success',
    })
    await usageRow(reqInterleave, uid, 50_000, 0) // +6 credits late
    // Intercept pool.query on first late-row parent read to concurrently commit parent turn_key before late INSERT completes!
    const realPool = getPool()
    let injectedConcurrentBackfill = false
    const interleavedPool = new Proxy(realPool, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (...qArgs: unknown[]) => {
            const sql = typeof qArgs[0] === 'string' ? qArgs[0] : ''
            const res = await (target.query as (...a: unknown[]) => Promise<unknown>)(...qArgs)
            if (!injectedConcurrentBackfill && sql.includes("price_snapshot ? 'antigravity_status'")) {
              injectedConcurrentBackfill = true
              await realPool.query(
                `UPDATE usage_records SET turn_key = $3 WHERE user_id = $1 AND request_id = $2`,
                [uid.toString(), reqInterleave, tkInterleave],
              )
            }
            return res
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const interleaveAppends: Array<{ reqId: string; credits: string; turnKey: string | null | undefined }> = []
    assert.equal(
      await settleLateAntigravityRelayUsage({
        pool: interleavedPool,
        pricing,
        requestId: reqInterleave,
        userId: uid,
        appendCostCredits: async (rId, _u, credits, _s, _ps, _da, tKey) => {
          interleaveAppends.push({ reqId: rId, credits, turnKey: tKey })
        },
      }),
      true,
    )
    const interleaveLateRow = await query<{ request_id: string; turn_key: string | null }>(
      `SELECT request_id, turn_key FROM usage_records
        WHERE user_id = $1 AND price_snapshot->>'antigravity_late_of' = $2`,
      [uid.toString(), reqInterleave],
    )
    assert.equal(interleaveLateRow.rows[0]?.turn_key, tkInterleave, 'R1 P1-3: store-load barrier must backfill interleaved late row turn_key')
    assert.deepEqual(interleaveAppends, [
      { reqId: interleaveLateRow.rows[0]!.request_id, credits: '6', turnKey: tkInterleave },
    ])

    // Auditor R1 P1-4: Same-UID root frame with mismatched turnKey vs authoritative dispatch
    // MUST be rejected BEFORE route expiry, with zero route/DB/balance side effects.
    const reqMismatchRoot = rid()
    const authDispatchId = randomUUID()
    const tkAuth = createHash('sha256').update(`r1-p14-auth:${reqMismatchRoot}`).digest('hex')
    const tkWrong = createHash('sha256').update(`r1-p14-wrong:${reqMismatchRoot}`).digest('hex')
    await recordAntigravityTurn(getPool(), {
      requestId: reqMismatchRoot,
      userId: uid,
      modelId: MODEL,
      sessionId: 's-r1-p14',
      traceId: null,
    })
    await usageRow(reqMismatchRoot, uid, 100_000, 20_000)
    await query(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, model, request_hash,
          billing_request_id, status, outcome, owner_id, lease_epoch, lease_until, attempt_no)
       VALUES ($1, $2, 's-r1-p14', $3, 'main', $4, 'h-r1p14', $5,
               'terminal', 'completed', 'm1', 1, NOW(), 1)`,
      [authDispatchId, uid.toString(), `cm-${reqMismatchRoot.slice(-8)}`, MODEL, reqMismatchRoot],
    )
    await query(
      `INSERT INTO authority_turn_dispatches
         (authority_turn_id, dispatch_id, user_id, attempt_no, session_id, turn_key, canonical_model)
       VALUES ($1, $2, $3, 1, 's-r1-p14', $4, $5)`,
      [rid(), authDispatchId, uid.toString(), tkAuth, MODEL],
    )
    let mismatchExpireCalls = 0
    const balBeforeMismatch = await balance(uid)
    const mismatchOut = await settleDurableAntigravityBilling(
      {
        pgPool: getPool(),
        pricing,
        expireRouteForRequest: async () => {
          mismatchExpireCalls += 1
        },
      },
      uid,
      {
        engine: 'antigravity',
        requestId: reqMismatchRoot,
        engineSessionId: `oceng-${'f'.repeat(48)}`,
        status: 'success',
        durationMs: 250,
        turnKey: tkWrong,
      },
    )
    assert.equal(mismatchOut, 'already_committed')
    assert.equal(mismatchExpireCalls, 0, 'R1 P1-4: mismatched same-UID root turnKey must NOT expire route')
    assert.equal(await turnStatus(reqMismatchRoot), 'pending', 'R1 P1-4: turn must stay pending on conflict')
    assert.equal(await balance(uid), balBeforeMismatch, 'R1 P1-4: balance must stay untouched on conflict')
  })
})
