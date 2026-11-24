/**
 * OCV5-879: Local native Antigravity swarm per-member built-in model selection:
 *   - route-level `allowedModelIds` serialization / legacy compatibility / fail-closed validation
 *   - server-side engine + catalog + pricing + user-auth fail-closed filtering (BLOCKER-3)
 *   - admission account directory & per-model cooldown intersection + relay cooldown enforcement (BLOCKER-4)
 *   - composite orchestrator exclusion as extra members to prevent shared-worker ambiguity (BLOCKER-5)
 *   - per-model accurate billing, fail-closed missing-pricing retention as pending (BLOCKER-1)
 *   - member HTTP 410 retirement isolation so successful primary delivery is still billed (BLOCKER-2)
 *   - real-time budget gate using the actual member model's pricing (no cheap-session bypass)
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/antigravitySwarmModels.test.ts
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, test } from 'node:test'

import { admitAntigravityTurn } from '../account-pool/antigravityAdmission.js'
import { type ContainerIdentityRepo, hashSecret } from '../auth/containerIdentity.js'
import {
  _resetAntigravityRelayRoutesForTests,
  configureAntigravityRelayKv,
  mintAntigravityRelayRoute,
  resolveAntigravityRelayRoute,
  resolveLocalSwarmAllowedAntigravityModels,
} from '../billing/antigravityRouteContext.js'
import {
  MissingAntigravityModelPricingError,
  antigravityUsageCost,
  antigravityUsageCostOrNull,
  hasAllAntigravityExtraPricing,
  planAntigravitySettle,
  resolveAntigravityBillableTarget,
  settleAntigravityTurn,
  sumAntigravityRelayUsage,
} from '../billing/antigravitySettle.js'
import type { ModelPricing } from '../billing/pricing.js'
import {
  ANTIGRAVITY_RELAY_PREFIX,
  type AntigravityUsageRow,
  _antigravityInflightForTests,
  makeAntigravityRelayHandler,
} from '../http/internalAntigravityRelay.js'

const SECRET = 'c'.repeat(64)
const CONTAINER_TOKEN = `oc-v3.11.${SECRET}`
const CTX = { hostUuid: 'host-swarm', boundIp: '172.30.0.19' }
const REQUEST_ID = 'e'.repeat(32)
const FULL_TOKEN = 'ya29.swarm-full-scope-token'

function repo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null
      return {
        id: 11,
        user_id: 42,
        bound_ip: CTX.boundIp,
        host_uuid: CTX.hostUuid,
        secret_hash: hashSecret(SECRET),
      }
    },
  }
}

function makePricing(
  modelId: string,
  input: bigint,
  output: bigint,
  cacheRead: bigint,
  multiplier = '1.000',
): ModelPricing {
  return {
    model_id: modelId,
    display_name: modelId,
    input_per_mtok: input,
    output_per_mtok: output,
    cache_read_per_mtok: cacheRead,
    cache_write_per_mtok: 0n,
    multiplier,
    enabled: true,
    visibility: 'public',
    sort_order: 1,
    default_effort: null,
    extra_system_prompt: null,
    updated_at: new Date(0),
  }
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  'antigravity-gemini-4-hydrogen': makePricing('antigravity-gemini-4-hydrogen', 300n, 1500n, 8n),
  'antigravity-gemini-4-carbon': makePricing('antigravity-gemini-4-carbon', 400n, 2000n, 10n),
  'antigravity-gemini-4-neon': makePricing('antigravity-gemini-4-neon', 600n, 3000n, 15n),
  'antigravity-claude-opus-5.5': makePricing('antigravity-claude-opus-5.5', 200n, 1000n, 10n, '2.000'),
}

function pricingLookup(entries: Record<string, ModelPricing> = PRICING_TABLE) {
  return { get: (id: string) => entries[id] ?? null }
}

function sseWithUsage(prompt: number, candidates: number, cached = 0, thoughts = 0): string {
  return `data: ${JSON.stringify({
    response: {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {
        promptTokenCount: prompt,
        candidatesTokenCount: candidates,
        cachedContentTokenCount: cached,
        thoughtsTokenCount: thoughts,
      },
    },
  })}\n\n`
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
}

afterEach(() => {
  _resetAntigravityRelayRoutesForTests()
})

describe('OCV5-879: local native Antigravity swarm per-member built-in models', () => {
  test('BLOCKER-3 & BLOCKER-5: resolveLocalSwarmAllowedAntigravityModels fails closed on missing catalog/pricing/auth, rejects non-antigravity engines, and excludes composite orchestrators', () => {
    const allAllowed = () => true
    const allPriced = (id: string) => Boolean(PRICING_TABLE[id])
    const allLocal = (id: string) => Boolean(PRICING_TABLE[id])

    // Missing any required evidence fails closed (returns undefined -> primary-only)
    assert.equal(
      resolveLocalSwarmAllowedAntigravityModels({
        primaryModelId: 'antigravity-gemini-4-hydrogen',
        isAllowedForUser: null,
        isCatalogRoutableLocal: allLocal,
        hasPricing: allPriced,
      }),
      undefined,
    )
    assert.equal(
      resolveLocalSwarmAllowedAntigravityModels({
        primaryModelId: 'antigravity-gemini-4-hydrogen',
        isAllowedForUser: allAllowed,
        isCatalogRoutableLocal: null, // missing catalog snapshot -> fail-closed
        hasPricing: allPriced,
      }),
      undefined,
    )
    assert.equal(
      resolveLocalSwarmAllowedAntigravityModels({
        primaryModelId: 'antigravity-gemini-4-hydrogen',
        isAllowedForUser: allAllowed,
        isCatalogRoutableLocal: allLocal,
        hasPricing: null, // missing pricing -> fail-closed
      }),
      undefined,
    )

    // Non-antigravity engine in catalog (even if priced & user-allowed) is rejected; orchestrators excluded
    const descriptors: Record<string, { canonicalModel: string; engine: string; placement: string }> = {
      'antigravity-gemini-4-hydrogen': { canonicalModel: 'antigravity-gemini-4-hydrogen', engine: 'antigravity', placement: 'local' },
      'antigravity-gemini-4-carbon': { canonicalModel: 'antigravity-gemini-4-carbon', engine: 'codex', placement: 'local' }, // rerouted to non-antigravity engine
      'antigravity-gemini-4-neon': { canonicalModel: 'antigravity-gemini-4-neon', engine: 'antigravity', placement: 'local' },
      'antigravity-claude-opus-5.5': { canonicalModel: 'antigravity-claude-opus-5.5', engine: 'antigravity', placement: 'remote_pool' }, // remote placement rejected
      'antigravity-orchestrator-neon': { canonicalModel: 'antigravity-orchestrator-neon', engine: 'antigravity', placement: 'local' }, // composite orchestrator excluded
    }
    const resolved = resolveLocalSwarmAllowedAntigravityModels({
      primaryModelId: 'antigravity-gemini-4-hydrogen',
      isAllowedForUser: () => true,
      isCatalogRoutableLocal: (id) => {
        const d = descriptors[id]
        return Boolean(d && d.canonicalModel === id && d.engine === 'antigravity' && d.placement !== 'remote_pool')
      },
      hasPricing: (id) => id in descriptors,
    })
    assert.deepEqual(resolved, [
      'antigravity-gemini-4-hydrogen',
      'antigravity-gemini-4-neon',
    ])
  })

  test('BLOCKER-4: admitAntigravityTurn intersects allowedModelIds with bound account directory availability and per-model cooldowns', async () => {
    let mintedAllowed: readonly string[] | undefined
    const now = Date.now()
    const futureReset = new Date(now + 3600_000).toISOString()

    await admitAntigravityTurn(
      {
        containerId: 11,
        userId: 42n,
        requestId: REQUEST_ID,
        modelId: 'antigravity-gemini-4-hydrogen',
        allowedModelIds: [
          'antigravity-gemini-4-hydrogen',
          'antigravity-gemini-4-neon',     // healthy on account -> KEEP
          'antigravity-gemini-4-carbon',   // quota exhausted (remainingFraction=0, future reset) -> DROP
          'antigravity-claude-opus-5.5',   // in cooldown on this account -> DROP
          'antigravity-gpt-oss-120b',      // missing from account directory -> DROP
        ],
        budgetCredits: 10_000n,
        relayPort: 18789,
      },
      {
        clientSecret: 'GOCSPX-secret',
        pick: async () => ({
          accountId: 7n,
          email: 'ultra@example.com',
          availableModels: {
            'gemini-4-hydrogen-low': { remainingFraction: 1, resetTime: null },
            'gemini-4-hydrogen-medium': { remainingFraction: 1, resetTime: null },
            'gemini-4-hydrogen-high': { remainingFraction: 1, resetTime: null },
            'gemini-4-hydrogen-xhigh': { remainingFraction: 1, resetTime: null },
            'gemini-4-neon-low': { remainingFraction: 0.8, resetTime: null },
            'gemini-4-neon-medium': { remainingFraction: 0.8, resetTime: null },
            'gemini-4-neon-high': { remainingFraction: 0.8, resetTime: null },
            'gemini-4-neon-xhigh': { remainingFraction: 0.8, resetTime: null },
            'gemini-4-carbon-low': { remainingFraction: 0, resetTime: futureReset },
            'gemini-4-carbon-medium': { remainingFraction: 0, resetTime: futureReset },
            'gemini-4-carbon-high': { remainingFraction: 0, resetTime: futureReset },
            'claude-opus-5-5-low': { remainingFraction: 1, resetTime: null },
            'claude-opus-5-5-medium': { remainingFraction: 1, resetTime: null },
            'claude-opus-5-5-high': { remainingFraction: 1, resetTime: null },
          },
        }),
        modelCoolingUntil: async (_accountId, modelId) =>
          modelId === 'antigravity-claude-opus-5.5' ? now + 60_000 : null,
        mintLimited: async () => ({
          accessToken: 'ya29.limited',
          expiresAt: new Date(now + 3600_000),
          idToken: null,
        }),
        mintRoute: async (routeArgs) => {
          mintedAllowed = routeArgs.allowedModelIds
          return { token: '1'.repeat(64), baseUrl: 'http://127.0.0.1:18789/r' }
        },
      },
    )

    assert.deepEqual(mintedAllowed, [
      'antigravity-gemini-4-hydrogen',
      'antigravity-gemini-4-neon',
    ])

    // Account with null availableModels (before first background refresh) keeps primary-only and never expands to extra members
    let nullDirAllowed: readonly string[] | undefined = ['sentinel']
    await admitAntigravityTurn(
      {
        containerId: 11,
        userId: 42n,
        requestId: '7'.repeat(32),
        modelId: 'antigravity-gemini-3.8-flash',
        allowedModelIds: ['antigravity-gemini-3.8-flash', 'antigravity-gpt-oss-120b'],
        budgetCredits: 10_000n,
        relayPort: 18789,
      },
      {
        clientSecret: 'GOCSPX-secret',
        pick: async () => ({
          accountId: 8n,
          email: 'legacy@example.com',
          availableModels: null,
        }),
        modelCoolingUntil: async () => null,
        mintLimited: async () => ({
          accessToken: 'ya29.limited',
          expiresAt: new Date(now + 3600_000),
          idToken: null,
        }),
        mintRoute: async (routeArgs) => {
          nullDirAllowed = routeArgs.allowedModelIds
          return { token: '2'.repeat(64), baseUrl: 'http://127.0.0.1:18789/r' }
        },
      },
    )
    assert.equal(nullDirAllowed, undefined)
  })

  test('route KV preserves allowedModelIds, keeps legacy routes compatible, rejects composite orchestrator extra members & tampered Redis rows', async () => {
    const store = new Map<string, string>()
    configureAntigravityRelayKv({
      async get(key) { return store.get(key) ?? null },
      async set(key, value) { store.set(key, value) },
      async del(key) { store.delete(key) },
    })

    // 1. Non-swarm route omits allowedModelIds completely
    const single = await mintAntigravityRelayRoute({
      containerId: 11,
      userId: 42n,
      requestId: REQUEST_ID,
      modelId: 'antigravity-gemini-4-hydrogen',
      accountId: 7n,
      budgetCredits: 10_000n,
      relayPort: 18789,
    })
    const resolvedSingle = await resolveAntigravityRelayRoute({
      token: single.token,
      containerId: 11,
      userId: 42n,
    })
    assert.equal(resolvedSingle?.allowedModelIds, undefined)

    // 2. Swarm route persists allowedModelIds cleanly (even when primary itself is an orchestrator)
    const multi = await mintAntigravityRelayRoute({
      containerId: 11,
      userId: 42n,
      requestId: 'f'.repeat(32),
      modelId: 'antigravity-orchestrator-carbon',
      allowedModelIds: ['antigravity-gemini-4-neon', 'antigravity-gemini-4-carbon'],
      accountId: 7n,
      budgetCredits: 10_000n,
      relayPort: 18789,
    })
    const resolvedMulti = await resolveAntigravityRelayRoute({
      token: multi.token,
      containerId: 11,
      userId: 42n,
    })
    assert.deepEqual(resolvedMulti?.allowedModelIds, [
      'antigravity-gemini-4-carbon',
      'antigravity-gemini-4-neon',
      'antigravity-orchestrator-carbon',
    ])

    // 3. Reject composite orchestrator as an extra member (prevents shared gemini-flash-worker-agy ambiguity)
    await assert.rejects(
      mintAntigravityRelayRoute({
        containerId: 11,
        userId: 42n,
        requestId: '9'.repeat(32),
        modelId: 'antigravity-orchestrator-carbon',
        allowedModelIds: ['antigravity-orchestrator-neon'],
        accountId: 7n,
        budgetCredits: 10_000n,
        relayPort: 18789,
      }),
      /non-allowlisted/,
    )

    // 4. Reject non-Antigravity model at mint time
    await assert.rejects(
      mintAntigravityRelayRoute({
        containerId: 11,
        userId: 42n,
        requestId: 'a'.repeat(32),
        modelId: 'antigravity-gemini-4-hydrogen',
        allowedModelIds: ['gpt-6.2-astra'],
        accountId: 7n,
        budgetCredits: 10_000n,
        relayPort: 18789,
      }),
      /non-allowlisted/,
    )

    // 5. Tampered Redis payload containing non-allowlisted model fails closed
    for (const [k, v] of store.entries()) {
      if (v.includes('allowedModelIds')) {
        const parsed = JSON.parse(v) as Record<string, unknown>
        parsed.allowedModelIds = ['antigravity-orchestrator-carbon', 'antigravity-orchestrator-neon']
        store.set(k, JSON.stringify(parsed))
      }
    }
    const tampered = await resolveAntigravityRelayRoute({
      token: multi.token,
      containerId: 11,
      userId: 42n,
    })
    assert.equal(tampered, null)
  })

  test('relay enforces allowlist, member cooldown (503 without upstream), 5xx cooldown isolation, real-model budget gate, and fail-closed missing pricing (both precheck & recorded usage)', async () => {
    const minted = await mintAntigravityRelayRoute({
      containerId: 11,
      userId: 42n,
      requestId: REQUEST_ID,
      modelId: 'antigravity-gemini-4-hydrogen',
      allowedModelIds: ['antigravity-gemini-4-hydrogen', 'antigravity-gemini-4-neon', 'antigravity-gemini-4-carbon'],
      accountId: 7n,
      budgetCredits: 5n,
      relayPort: 18789,
    })
    const path = `${ANTIGRAVITY_RELAY_PREFIX}/route/${minted.token}/v1internal:streamGenerateContent?alt=sse`

    const usageRows: AntigravityUsageRow[] = []
    const modelOutcomes: Array<[bigint, string, boolean]> = []
    let cooledModel: string | null = 'antigravity-gemini-4-carbon'
    let activePricing: Record<string, ModelPricing> = { ...PRICING_TABLE }
    let upstreamCalls = 0
    let nextUpstreamStatus = 200
    let nextSse = sseWithUsage(1_000, 1_000)

    const handler = makeAntigravityRelayHandler({
      identityRepo: repo(),
      clientSecret: 'GOCSPX-test-secret-000',
      pricing: { get: (id) => activePricing[id] ?? null },
      freshToken: async () => Buffer.from(FULL_TOKEN, 'utf8'),
      reportOutcome: async () => {},
      reportModelOutcome: async (accountId, modelId, ok) => {
        modelOutcomes.push([accountId, modelId, ok])
      },
      modelCoolingUntil: async (_accountId, modelId) =>
        cooledModel === modelId ? Date.now() + 60_000 : null,
      recordUsage: async (row) => {
        usageRows.push(row)
      },
      meteredCost: async () => 0n,
      requestFn: (async () => {
        upstreamCalls += 1
        return {
          statusCode: nextUpstreamStatus,
          headers: { 'content-type': 'text/event-stream' },
          body: Readable.from([Buffer.from(nextSse)]),
        }
      }) as never,
    })

    const server = createServer((req, res) => {
      void handler(req, res, CTX)
    })
    const port = await listen(server)
    const send = (model: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${CONTAINER_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }),
      })

    try {
      // 1. Unauthorized Antigravity model (not in route.allowedModelIds) -> 403
      const denied = await send('claude-opus-5-5-high')
      assert.equal(denied.status, 403)
      assert.equal((await denied.json() as { error: { code: string } }).error.code, 'ANTIGRAVITY_MODEL_NOT_ALLOWED')
      assert.equal(upstreamCalls, 0)

      // 2. BLOCKER-4: Cooled member model (Carbon) -> 503 ANTIGRAVITY_MODEL_COOLING_DOWN without calling upstream; healthy coordinator succeeds
      const cooledRes = await send('gemini-4-carbon-high')
      assert.equal(cooledRes.status, 503)
      assert.equal((await cooledRes.json() as { error: { code: string } }).error.code, 'ANTIGRAVITY_MODEL_COOLING_DOWN')
      assert.equal(upstreamCalls, 0)

      // Healthy coordinator still runs fine on the same account
      nextUpstreamStatus = 200
      nextSse = sseWithUsage(0, 500) // 500 * 1500 / 1e6 = 0.75 -> 1 credit (< 5n)
      const coordOk = await send('gemini-4-hydrogen-high')
      assert.equal(coordOk.status, 200)
      await coordOk.text()
      assert.equal(upstreamCalls, 1)

      // 3. Authorized member model (Neon) gets 503 -> cools ONLY Neon, NOT coordinator Hydrogen
      nextUpstreamStatus = 503
      nextSse = ''
      const neon503 = await send('gemini-4-neon-xhigh')
      assert.equal(neon503.status, 503)
      assert.deepEqual(modelOutcomes.at(-1), [7n, 'antigravity-gemini-4-neon', false])

      // 4. Neon succeeds and burns 2,000 output tokens = ceil(2000 * 3000 / 1e6) = 6 credits (> budget 5n)
      nextUpstreamStatus = 200
      nextSse = sseWithUsage(0, 2_000)
      const neonOk = await send('gemini-4-neon-xhigh')
      assert.equal(neonOk.status, 200)
      await neonOk.text()
      assert.equal(usageRows.at(-1)?.upstreamModel, 'gemini-4-neon-xhigh')
      assert.equal(usageRows.at(-1)?.routeModelId, 'antigravity-gemini-4-hydrogen')
      assert.deepEqual(modelOutcomes.at(-1), [7n, 'antigravity-gemini-4-neon', true])

      // 5. BLOCKER-1: If Neon pricing disappears AFTER usage was recorded, totalsCost fails closed (503) instead of falling back to Hydrogen rate
      const savedNeon = activePricing['antigravity-gemini-4-neon']!
      delete activePricing['antigravity-gemini-4-neon']
      const missingAfterRecord = await send('gemini-4-hydrogen-high')
      assert.equal(missingAfterRecord.status, 503)
      assert.equal((await missingAfterRecord.json() as { error: { code: string } }).error.code, 'ANTIGRAVITY_PRICING_UNAVAILABLE')
      activePricing['antigravity-gemini-4-neon'] = savedNeon

      // 6. With Neon pricing restored, next call on coordinator Hydrogen is blocked with 402 ANTIGRAVITY_BUDGET_EXHAUSTED
      const exhausted = await send('gemini-4-hydrogen-high')
      assert.equal(exhausted.status, 402)
      assert.equal((await exhausted.json() as { error: { code: string } }).error.code, 'ANTIGRAVITY_BUDGET_EXHAUSTED')
      assert.equal(_antigravityInflightForTests().get(minted.token)?.reserved, 0n)
    } finally {
      server.closeAllConnections()
      await close(server)
    }
  })

  test('BLOCKER-1 & BLOCKER-2: settle fails closed (returns null -> stays pending) when extra member pricing is missing, settles accurately once restored, and isolates member 410 retirement without waiving primary delivery', async () => {
    assert.deepEqual(
      resolveAntigravityBillableTarget('antigravity-gemini-4-hydrogen', 'gemini-4-hydrogen-high'),
      { bucket: 'primary', modelId: 'antigravity-gemini-4-hydrogen' },
    )
    assert.deepEqual(
      resolveAntigravityBillableTarget('antigravity-gemini-4-hydrogen', 'gemini-4-neon-xhigh'),
      { bucket: 'model', modelId: 'antigravity-gemini-4-neon' },
    )
    assert.deepEqual(
      resolveAntigravityBillableTarget('antigravity-gemini-4-hydrogen', 'claude-opus-5-5-high'),
      { bucket: 'model', modelId: 'antigravity-claude-opus-5.5' },
    )
    assert.deepEqual(
      resolveAntigravityBillableTarget('antigravity-gemini-4-hydrogen', 'gemini-3.5-flash-lite'),
      { bucket: 'aux', modelId: 'aux' },
    )

    // Scenario A (BLOCKER-1): Primary Hydrogen (1M out @ 1500) + Member Neon (1M out @ 3000) = 4500 credits
    const fakePoolA = {
      async query() {
        return {
          rows: [
            {
              route_model_id: 'antigravity-gemini-4-hydrogen',
              upstream_model: 'gemini-4-hydrogen-high',
              prompt: '0',
              candidates: '1000000',
              thoughts: '0',
              cached: '0',
              billable_prompt: '0',
              billable_candidates: '1000000',
              billable_thoughts: '0',
              billable_cached: '0',
              calls: '1',
              billable_calls: '1',
              retired_calls: '0',
              monitoring_calls: '0',
              retired: false,
            },
            {
              route_model_id: 'antigravity-gemini-4-hydrogen',
              upstream_model: 'gemini-4-neon-xhigh',
              prompt: '0',
              candidates: '1000000',
              thoughts: '0',
              cached: '0',
              billable_prompt: '0',
              billable_candidates: '1000000',
              billable_thoughts: '0',
              billable_cached: '0',
              calls: '1',
              billable_calls: '1',
              retired_calls: '0',
              monitoring_calls: '0',
              retired: false,
            },
          ],
        }
      },
    }

    const totalsA = await sumAntigravityRelayUsage(fakePoolA as never, REQUEST_ID, 42n)
    const missingNeonLookup = pricingLookup({
      'antigravity-gemini-4-hydrogen': PRICING_TABLE['antigravity-gemini-4-hydrogen']!,
    })
    assert.equal(hasAllAntigravityExtraPricing(totalsA, missingNeonLookup), false)
    assert.equal(
      antigravityUsageCostOrNull(totalsA, PRICING_TABLE['antigravity-gemini-4-hydrogen']!, missingNeonLookup),
      null,
    )
    assert.throws(
      () =>
        planAntigravitySettle({
          engineStatus: 'success',
          totals: totalsA,
          pricing: PRICING_TABLE['antigravity-gemini-4-hydrogen']!,
          pricingLookup: missingNeonLookup,
        }),
      MissingAntigravityModelPricingError,
    )
    // settleAntigravityTurn returns null (stays pending, never writes wrong 3000-credit ledger entry)
    const deferred = await settleAntigravityTurn({
      pool: fakePoolA as never,
      pricing: missingNeonLookup,
      userId: 42n,
      requestId: REQUEST_ID,
      modelId: 'antigravity-gemini-4-hydrogen',
      sessionId: 's-1',
      engineStatus: 'success',
    })
    assert.equal(deferred, null)

    // Once Neon pricing is restored, exact cost = 1500 + 3000 = 4500 credits
    const fullLookup = pricingLookup()
    assert.equal(
      antigravityUsageCost(totalsA, PRICING_TABLE['antigravity-gemini-4-hydrogen']!, fullLookup),
      4500n,
    )

    // Scenario B (BLOCKER-2): Primary Hydrogen succeeded (1800 credits) + Member Claude Opus returned 410 retirement banner (500k tokens) + Member Neon succeeded (3600 credits)
    // -> Turn remains success, charges 1800 + 3600 = 5400 credits, retirement banner itself is 0 credits and recorded in antigravity_retired_models!
    const fakePoolB = {
      async query() {
        return {
          rows: [
            {
              route_model_id: 'antigravity-gemini-4-hydrogen',
              upstream_model: 'gemini-4-hydrogen-high',
              prompt: '1000000',
              candidates: '1000000',
              thoughts: '0',
              cached: '0',
              billable_prompt: '1000000',
              billable_candidates: '1000000',
              billable_thoughts: '0',
              billable_cached: '0',
              calls: '2',
              billable_calls: '2',
              retired_calls: '0',
              monitoring_calls: '0',
              retired: false,
            },
            {
              route_model_id: 'antigravity-gemini-4-hydrogen',
              upstream_model: 'gemini-4-neon-xhigh',
              prompt: '1000000',
              candidates: '1000000',
              thoughts: '0',
              cached: '0',
              billable_prompt: '1000000',
              billable_candidates: '1000000',
              billable_thoughts: '0',
              billable_cached: '0',
              calls: '1',
              billable_calls: '1',
              retired_calls: '0',
              monitoring_calls: '0',
              retired: false,
            },
            {
              route_model_id: 'antigravity-gemini-4-hydrogen',
              upstream_model: 'claude-opus-5-5-medium',
              prompt: '500000',
              candidates: '500000',
              thoughts: '0',
              cached: '0',
              billable_prompt: '0',
              billable_candidates: '0',
              billable_thoughts: '0',
              billable_cached: '0',
              calls: '1',
              billable_calls: '0',
              retired_calls: '1',
              monitoring_calls: '0',
              retired: true,
            },
          ],
        }
      },
    }

    const totalsB = await sumAntigravityRelayUsage(fakePoolB as never, REQUEST_ID, 42n)
    assert.equal(totalsB.retired, false)
    assert.deepEqual(totalsB.retiredExtraModels, { 'antigravity-claude-opus-5.5': 1 })
    assert.equal(totalsB.extraModels?.['antigravity-claude-opus-5.5'], undefined)

    const planB = planAntigravitySettle({
      engineStatus: 'success',
      totals: totalsB,
      pricing: PRICING_TABLE['antigravity-gemini-4-hydrogen']!,
      pricingLookup: fullLookup,
    })
    assert.equal(planB.settleStatus, 'success')
    assert.equal(planB.costCredits, 5400n)
    const snapB = JSON.parse(planB.snapshotJson) as Record<string, any>
    assert.equal(snapB.antigravity_primary.calls, 2)
    assert.equal(snapB.antigravity_primary.cost_credits, '1800')
    assert.equal(snapB.antigravity_models['antigravity-gemini-4-neon'].cost_credits, '3600')
    assert.deepEqual(snapB.antigravity_retired_models, { 'antigravity-claude-opus-5.5': 1 })

    // Scenario C: Primary model itself returning 410 still waives the entire turn (preserves legacy behavior)
    const fakePoolPrimaryRetired = {
      async query() {
        return {
          rows: [
            {
              route_model_id: 'antigravity-claude-opus-5.5',
              upstream_model: 'claude-opus-5-5-medium',
              prompt: '1000000',
              candidates: '1000000',
              thoughts: '0',
              cached: '0',
              billable_prompt: '0',
              billable_candidates: '0',
              billable_thoughts: '0',
              billable_cached: '0',
              calls: '1',
              billable_calls: '0',
              retired_calls: '1',
              monitoring_calls: '0',
              retired: true,
            },
          ],
        }
      },
    }
    const totalsC = await sumAntigravityRelayUsage(fakePoolPrimaryRetired as never, REQUEST_ID, 42n)
    assert.equal(totalsC.retired, true)
    const planC = planAntigravitySettle({
      engineStatus: 'success',
      totals: totalsC,
      pricing: PRICING_TABLE['antigravity-claude-opus-5.5']!,
      pricingLookup: fullLookup,
    })
    assert.equal(planC.settleStatus, 'error')
    assert.equal(planC.costCredits, 0n)
  })
})
