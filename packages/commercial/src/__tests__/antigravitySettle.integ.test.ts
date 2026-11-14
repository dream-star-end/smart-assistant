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
import { existsSync } from 'node:fs'
const selfhost = existsSync(new URL('../db/migrations/0341_selfhost_sync_compat.sql', import.meta.url))
assert.notEqual(selfhost, existsSync(new URL('../db/migrations/0340_commercial_sync_compat.sql', import.meta.url)))
import { describe, test } from 'node:test'

import {
  abandonAntigravityTurn,
  reconcileStaleAntigravityTurns,
  recordAntigravityTurn,
  refreshWaivedAntigravityUsage,
  settleAntigravityTurnRecord,
} from '../billing/antigravitySettle.js'
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
      ...(selfhost ? [{
        model_id: 'antigravity-gemini-4-carbon', state: 'staged',
        enabled: false, visibility: 'public',
      }, {
        model_id: 'antigravity-gemini-4-hydrogen', state: 'staged',
        enabled: false, visibility: 'admin',
      }] : []),
      {
        model_id: 'antigravity-gpt-oss-120b',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
      ...(selfhost ? [{
        model_id: 'antigravity-orchestrator-carbon',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      }] : []),
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
    const r=await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached,
      p.cache_write_per_mtok::text AS cache_write,p.multiplier::text AS multiplier
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-gemini-4-carbon'`)
    // No catalog seed is imported into commercial by the compatibility migration.
    assert.deepEqual(r.rows,selfhost ? [{ state:'staged',upstream_model_id:'gemini-4-carbon-medium',context_window:1048576,
      enabled:false,visibility:'public',default_effort:'medium',input:'100',output:'500',cached:'5',
      cache_write:'0',multiplier:'1.000' }] : [])
  })
})

describe('Gemini 4 Hydrogen staged pricing (OCV5-768)', () => {
  test('new Hydrogen family seeds staged with explicit high effort, admin visibility, and official 1.50/7.50/0.075 USD rates', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const r = await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached,
      p.cache_write_per_mtok::text AS cache_write,p.multiplier::text AS multiplier
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-gemini-4-hydrogen'`)
    assert.deepEqual(
      r.rows,
      selfhost
        ? [{
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
          }]
        : [],
    )
  })
})

describe('Orchestrator Carbon staged pricing (OCV5-769)', () => {
  test('Orchestrator Carbon seeds staged with fixed default, admin visibility, and Carbon rates', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const r = await query(`SELECT c.state,c.upstream_model_id,c.context_window,p.enabled,p.visibility,p.default_effort,
      p.input_per_mtok::text AS input,p.output_per_mtok::text AS output,p.cache_read_per_mtok::text AS cached,
      p.cache_write_per_mtok::text AS cache_write,p.multiplier::text AS multiplier
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='antigravity-orchestrator-carbon'`)
    assert.deepEqual(
      r.rows,
      selfhost
        ? [{
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
          }]
        : [],
    )
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
