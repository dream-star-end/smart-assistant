/**
 * OCV5-415 P2 billing on real PG: migration 0307 + relay usage rows + the
 * durable turn claim (Codex r1 P1: a reconnected bridge must still settle).
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/antigravitySettle.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  abandonAntigravityTurn,
  reconcileStaleAntigravityTurns,
  recordAntigravityTurn,
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
  test('engine CHECK accepts antigravity; catalog rows are staged, pricing disabled, claude/gpt-oss admin-only', async (t) => {
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
        model_id: 'antigravity-claude-sonnet-4.6',
        state: 'staged',
        enabled: false,
        visibility: 'admin',
      },
      {
        model_id: 'antigravity-gemini-3.8-flash',
        state: 'staged',
        enabled: false,
        visibility: 'public',
      },
      {
        model_id: 'antigravity-gpt-oss-120b',
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
})
