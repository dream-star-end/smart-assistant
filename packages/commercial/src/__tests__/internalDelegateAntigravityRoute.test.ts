/**
 * Delegate antigravity route mint/renew/release internal endpoint (OCV5-738):
 * container identity gate, journal-bound admission, durable turn record,
 * routeToken persistence and mint rollback. No live pool or Google traffic is
 * used; admit/record/expire are injected.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/internalDelegateAntigravityRoute.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import {
  _resetAntigravityRelayRoutesForTests,
  configureAntigravityRelayKv,
  mintAntigravityRelayRoute,
  resolveAntigravityRelayRoute,
} from '../billing/antigravityRouteContext.js'
import { AntigravityAdmissionError } from '../account-pool/antigravityAdmission.js'
import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH,
  isDelegateAntigravityRoutePath,
  makeDelegateAntigravityRouteHandler,
} from '../http/internalDelegateAntigravityRoute.js'

const SECRET = 'e'.repeat(64)
const CONTAINER_TOKEN = `oc-v3.11.${SECRET}`
const CTX = { hostUuid: 'host-antigravity', boundIp: '172.30.0.14' }
const REQUEST_ID = 'ab'.repeat(16)
const ROUTE_TOKEN = 'cd'.repeat(32)
const BASE_URL = `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${ROUTE_TOKEN}`

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

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
}

async function call(
  port: number,
  path: string,
  body: unknown,
  auth = `Bearer ${CONTAINER_TOKEN}`,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json().catch(() => null) }
}

interface JournalRow {
  user_id: string
  container_id: string | null
  state: string
  ctx: Record<string, unknown>
  precheck_credits: string | null
}

function journalRow(over: Partial<JournalRow> = {}): JournalRow {
  return {
    user_id: '42',
    container_id: '11',
    state: 'inflight',
    ctx: {
      source: 'delegate_antigravity',
      model: 'antigravity-gemini-4-neon',
      parentSessionId: 'agent:main:delegate:leader:1',
    },
    precheck_credits: '250',
    ...over,
  }
}

function makePool(opts: {
  row?: JournalRow | JournalRow[]
  claimRows?: number
  persistRows?: number
  persistError?: Error
  selectError?: Error
}) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const rows = Array.isArray(opts.row) ? opts.row : opts.row ? [opts.row] : []
  let selectIdx = 0
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params: params ?? [] })
      if (sql.includes('FROM request_finalize_journal') && sql.includes('SELECT')) {
        if (opts.selectError) throw opts.selectError
        const row = rows[selectIdx++] ?? undefined
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (
        sql.includes('UPDATE request_finalize_journal') &&
        sql.includes("jsonb_build_object('antigravityMintClaim'")
      ) {
        const count = opts.claimRows ?? 1
        return {
          rows: Array.from({ length: count }, () => ({ request_id: REQUEST_ID })),
          rowCount: count,
        }
      }
      if (sql.includes('UPDATE request_finalize_journal') && sql.includes('antigravityRouteToken')) {
        if (opts.persistError) throw opts.persistError
        const count = opts.persistRows ?? 1
        return {
          rows: Array.from({ length: count }, () => ({ request_id: REQUEST_ID })),
          rowCount: count,
        }
      }
      if (
        sql.includes('UPDATE request_finalize_journal') &&
        sql.includes("ctx - 'antigravityMintClaim'")
      ) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return { pool: pool as any, queries }
}

function makeHandler(deps: {
  pool: any
  admit?: any
  recordTurn?: any
  abandonTurn?: any
  expireRoute?: any
  resolveRoute?: any
  releaseInflightFn?: any
  renewInflightFn?: any
  readBalance?: any
  clientSecret?: string
}) {
  return makeDelegateAntigravityRouteHandler({
    identityRepo: repo(),
    relayPort: 18789,
    clientSecret: deps.clientSecret ?? 'client-secret',
    pool: deps.pool,
    admit: deps.admit ?? (async () => mintedRoute()),
    recordTurn: deps.recordTurn ?? (async () => {}),
    abandonTurn: deps.abandonTurn ?? (async () => {}),
    expireRoute: deps.expireRoute ?? (async () => {}),
    resolveRoute: deps.resolveRoute ?? (async () => null),
    releaseInflightFn: deps.releaseInflightFn ?? (() => {}),
    ...(deps.renewInflightFn ? { renewInflightFn: deps.renewInflightFn } : {}),
    ...(deps.readBalance ? { readBalance: deps.readBalance } : {}),
  })
}

function mintedRoute() {
  return {
    token: ROUTE_TOKEN,
    baseUrl: BASE_URL,
    accessToken: 'A'.repeat(48),
    accessTokenExpiresAt: '2026-11-05T00:00:00.000Z',
  }
}

async function withServer(
  handler: ReturnType<typeof makeDelegateAntigravityRouteHandler>,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    void handler(req, res, CTX)
  })
  const port = await listen(server)
  try {
    await run(port)
  } finally {
    await close(server)
  }
}

describe('internalDelegateAntigravityRoute', () => {
  test('matches exactly the three managed paths', () => {
    assert.equal(isDelegateAntigravityRoutePath(DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH), true)
    assert.equal(isDelegateAntigravityRoutePath(DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH), true)
    assert.equal(isDelegateAntigravityRoutePath(DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH), true)
    assert.equal(isDelegateAntigravityRoutePath(`${DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH}/x`), false)
    assert.equal(
      isDelegateAntigravityRoutePath('/internal/v5/antigravity-relay/route/x'),
      false,
    )
  })

  test('rejects callers without container identity before touching the journal', async () => {
    const { pool, queries } = makePool({ row: journalRow() })
    const handler = makeHandler({ pool })
    await withServer(handler, async (port) => {
      const result = await call(
        port,
        DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH,
        { requestId: REQUEST_ID },
        'Bearer oc-v3.11.wrong',
      )
      assert.equal(result.status, 401)
      assert.equal(result.json.error.code, 'UNAUTHORIZED')
    })
    assert.equal(queries.length, 0, 'identity failure must not read the journal')
  })

  test('mint binds the route to the admission journal and persists its token', async () => {
    const { pool, queries } = makePool({ row: journalRow() })
    const admitCalls: any[] = []
    const recordCalls: any[] = []
    const handler = makeHandler({
      pool,
      admit: async (args: any, o: any) => {
        admitCalls.push({ args, o })
        return mintedRoute()
      },
      recordTurn: async (_pool: unknown, args: any) => {
        recordCalls.push(args)
      },
    })
    await withServer(handler, async (port) => {
      const result = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
        requestId: REQUEST_ID,
        // Body-supplied identity/model are ignored: the journal owns them.
        containerId: 99,
        userId: 7,
        modelId: 'antigravity-gemini-4-argon',
      })
      assert.equal(result.status, 200, JSON.stringify(result.json))
      assert.deepEqual(result.json, {
        ok: true,
        route: {
          baseUrl: BASE_URL,
          routeToken: ROUTE_TOKEN,
          accessToken: 'A'.repeat(48),
          accessTokenExpiresAt: '2026-11-05T00:00:00.000Z',
        },
      })
      // No pool/account identifiers or client secret leak to the container.
      assert.equal('accountId' in result.json.route, false)
      assert.equal('clientSecret' in result.json.route, false)
    })
    assert.equal(admitCalls.length, 1)
    assert.deepEqual(admitCalls[0].args, {
      containerId: 11,
      userId: 42n,
      requestId: REQUEST_ID,
      modelId: 'antigravity-gemini-4-neon',
      budgetCredits: 250n,
      relayPort: 18789,
      strictCapacity: true,
    })
    assert.equal(admitCalls[0].o.clientSecret, 'client-secret')
    assert.deepEqual(recordCalls, [
      {
        requestId: REQUEST_ID,
        userId: 42n,
        modelId: 'antigravity-gemini-4-neon',
        sessionId: 'agent:main:delegate:leader:1',
        traceId: null,
      },
    ])
    const persist = queries.find((q) =>
      q.sql.includes("jsonb_build_object('antigravityRouteToken'"),
    )
    assert.ok(persist, 'journal must persist the opaque route token')
    assert.deepEqual(persist!.params.slice(0, 4), [REQUEST_ID, ROUTE_TOKEN, 42, 11])
    assert.equal(typeof persist!.params[4], 'string')
  })

  test('mint uses spendable balance (ctx.antigravityBudgetCredits / readBalance) instead of 64-credit precheck cap', async () => {
    const { pool } = makePool({
      row: journalRow({
        precheck_credits: '64',
        ctx: {
          source: 'delegate_antigravity',
          model: 'antigravity-gemini-4-neon',
          antigravityBudgetCredits: '2278962',
        },
      }),
    })
    const admitCalls: any[] = []
    const handler = makeHandler({
      pool,
      admit: async (args: any) => {
        admitCalls.push(args)
        return mintedRoute()
      },
    })
    await withServer(handler, async (port) => {
      const result = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
        requestId: REQUEST_ID,
      })
      assert.equal(result.status, 200)
    })
    assert.equal(admitCalls.length, 1)
    assert.equal(admitCalls[0].budgetCredits, 2278962n)
  })

  test('OCV5-897 B2: mint caps the turn at live spendable balance and rejects live=0n with 402 (never falls back to precheck)', async () => {
    const budgets: bigint[] = []
    {
      const { pool } = makePool({
        row: journalRow({
          precheck_credits: '64',
          ctx: {
            source: 'delegate_antigravity',
            model: 'antigravity-gemini-4-neon',
            antigravityBudgetCredits: '2278962',
          },
        }),
      })
      const handler = makeHandler({
        pool,
        readBalance: async () => 5000n,
        admit: async (args: any) => {
          budgets.push(args.budgetCredits)
          return mintedRoute()
        },
      })
      await withServer(handler, async (port) => {
        assert.equal(
          (await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, { requestId: REQUEST_ID })).status,
          200,
        )
      })
    }
    assert.deepEqual(budgets, [5000n])

    let zeroAdmits = 0
    {
      const { pool } = makePool({
        row: journalRow({
          precheck_credits: '64',
          ctx: {
            source: 'delegate_antigravity',
            model: 'antigravity-gemini-4-neon',
            antigravityBudgetCredits: '2278962',
          },
        }),
      })
      const handler = makeHandler({
        pool,
        readBalance: async () => 0n,
        admit: async () => {
          zeroAdmits += 1
          return mintedRoute()
        },
      })
      await withServer(handler, async (port) => {
        const res = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
          requestId: REQUEST_ID,
        })
        assert.equal(res.status, 402)
        assert.equal(res.json.error.code, 'ANTIGRAVITY_BUDGET_UNAVAILABLE')
      })
    }
    assert.equal(zeroAdmits, 0, 'zero live spendable balance must fail closed before admit')
  })

  test('mint falls back to ctx.antigravityBudgetCredits when readBalance throws, and forwards frozen billingPricing override (OCV5-897 B2)', async () => {
    const admissionBudget = 2278962n
    let seenArgs: any
    {
      const { pool } = makePool({
        row: journalRow({
          precheck_credits: '64',
          ctx: {
            source: 'delegate_antigravity',
            model: 'antigravity-gemini-4-neon',
            antigravityBudgetCredits: String(admissionBudget),
            billingPricing: {
              v: 1,
              modelId: 'antigravity-gemini-4-neon',
              displayName: 'Gemini 4 Neon',
              inputPerMtok: '120',
              outputPerMtok: '1500',
              cacheReadPerMtok: '12',
              cacheWritePerMtok: '0',
              multiplier: '2.000',
            },
          },
        }),
      })
      const handler = makeHandler({
        pool,
        readBalance: async () => {
          throw new Error('pg lookup timeout')
        },
        admit: async (args: any) => {
          seenArgs = args
          return mintedRoute()
        },
      })
      await withServer(handler, async (port) => {
        const res = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
          requestId: REQUEST_ID,
        })
        assert.equal(res.status, 200)
      })
    }
    assert.equal(seenArgs.budgetCredits, admissionBudget)
    assert.equal(seenArgs.strictCapacity, true)
    assert.deepEqual(seenArgs.pricingOverride, {
      modelId: 'antigravity-gemini-4-neon',
      displayName: 'Gemini 4 Neon',
      inputPerMtok: '120',
      outputPerMtok: '1500',
      cacheReadPerMtok: '12',
      cacheWritePerMtok: '0',
      multiplier: '2.000',
    })
  })

  test('migration 0344 idempotently drops legacy manual delegate_antigravity budget trigger and function (OCV5-752)', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const migrationsDir = resolve(repoRoot, 'packages/commercial/src/db/migrations')
    const isCommercial = existsSync(resolve(migrationsDir, '0340_commercial_sync_compat.sql'))
    const isSelfhost = existsSync(resolve(migrationsDir, '0341_selfhost_sync_compat.sql'))
    assert.notEqual(
      isCommercial,
      isSelfhost,
      'exactly one edition compatibility marker migration must exist',
    )
    const migration0344Path = resolve(
      migrationsDir,
      '0344_drop_delegate_antigravity_budget_trigger.sql',
    )
    if (isSelfhost) {
      const migrationSql = readFileSync(migration0344Path, 'utf8')
      assert.match(
        migrationSql,
        /DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_rfj_delegate_antigravity_budget\s+ON\s+public\.request_finalize_journal\s*;/i,
      )
      assert.match(
        migrationSql,
        /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.trg_rfj_delegate_antigravity_budget\(\)\s*;/i,
      )
      return
    }
    assert.equal(
      existsSync(migration0344Path),
      false,
      'commercial edition must not include selfhost-only migration 0344',
    )
    const sqlFiles = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'))
    for (const file of sqlFiles) {
      const sql = readFileSync(resolve(migrationsDir, file), 'utf8')
      assert.doesNotMatch(
        sql,
        /CREATE\s+TRIGGER\s+trg_rfj_delegate_antigravity_budget/i,
        `${file} must not create legacy manual delegate_antigravity budget trigger`,
      )
    }
  })

  test('mint rejects an admission owned by another user or container', async () => {
    for (const row of [
      journalRow({ user_id: '43' }),
      journalRow({ container_id: '12' }),
      journalRow({ state: 'finalizing' }),
      journalRow({ ctx: { source: 'delegate_codex', model: 'antigravity-claude-sonnet-5.5' } }),
    ]) {
      const { pool } = makePool({ row })
      let admitted = 0
      const handler = makeHandler({
        pool,
        admit: async () => {
          admitted += 1
          return mintedRoute()
        },
      })
      await withServer(handler, async (port) => {
        const result = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
          requestId: REQUEST_ID,
        })
        assert.equal(result.status, 409, JSON.stringify(result.json))
        assert.equal(result.json.error.code, 'DELEGATE_ANTIGRAVITY_ROUTE_JOURNAL_INVALID')
      })
      assert.equal(admitted, 0, 'a non-owned/unused admission must never mint')
    }
  })

  test('mint refuses a second route for an admission that already holds one', async () => {
    const row = journalRow({
      ctx: {
        source: 'delegate_antigravity',
        model: 'antigravity-gemini-4-neon',
        antigravityRouteToken: ROUTE_TOKEN,
      },
    })
    const { pool } = makePool({ row })
    let admitted = 0
    const handler = makeHandler({
      pool,
      admit: async () => {
        admitted += 1
        return mintedRoute()
      },
    })
    await withServer(handler, async (port) => {
      const result = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
        requestId: REQUEST_ID,
      })
      assert.equal(result.status, 409)
      assert.equal(result.json.error.code, 'DELEGATE_ANTIGRAVITY_ROUTE_ALREADY_MINTED')
    })
    assert.equal(admitted, 0)
  })

  test('mint rolls the turn back when the journal token cannot be persisted', async () => {
    // Losing the persist race (0 rows) must not leak a live route/turn.
    const { pool } = makePool({ row: journalRow(), persistRows: 0 })
    const expired: string[] = []
    const abandoned: string[] = []
    const released: string[] = []
    const handler = makeHandler({
      pool,
      expireRoute: async (token: string) => {
        expired.push(token)
      },
      abandonTurn: async (_pool: unknown, requestId: string) => {
        abandoned.push(requestId)
      },
      releaseInflightFn: (requestId: string) => {
        released.push(requestId)
      },
    })
    await withServer(handler, async (port) => {
      const result = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
        requestId: REQUEST_ID,
      })
      assert.equal(result.status, 409)
      assert.equal(result.json.error.code, 'DELEGATE_ANTIGRAVITY_ROUTE_ALREADY_MINTED')
    })
    assert.deepEqual(expired, [ROUTE_TOKEN])
    assert.deepEqual(abandoned, [REQUEST_ID])
    assert.deepEqual(released, [REQUEST_ID])
  })

  test('mint rolls back exactly once when the durable turn record fails', async () => {
    const { pool } = makePool({ row: journalRow() })
    const expired: string[] = []
    const released: string[] = []
    const handler = makeHandler({
      pool,
      recordTurn: async () => {
        throw new Error('record down')
      },
      expireRoute: async (token: string) => {
        expired.push(token)
      },
      releaseInflightFn: (requestId: string) => {
        released.push(requestId)
      },
    })
    await withServer(handler, async (port) => {
      const result = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
        requestId: REQUEST_ID,
      })
      assert.equal(result.status, 503)
      assert.equal(result.json.error.code, 'ANTIGRAVITY_ROUTE_RECORD_FAILED')
    })
    assert.deepEqual(expired, [ROUTE_TOKEN])
    assert.deepEqual(released, [REQUEST_ID])
  })

  test('release expires only a route owned by the caller and is idempotent', async () => {
    const { pool } = makePool({})
    const resolved: any[] = []
    const expired: string[] = []
    let owned = true
    const handler = makeHandler({
      pool,
      resolveRoute: async (args: any) => {
        resolved.push(args)
        return owned
          ? {
              baseUrl: BASE_URL,
              accessToken: 'A'.repeat(48),
              accessTokenExpiresAt: '2026-11-05T00:00:00.000Z',
            }
          : null
      },
      expireRoute: async (token: string) => {
        expired.push(token)
      },
    })
    await withServer(handler, async (port) => {
      const first = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH, {
        routeToken: ROUTE_TOKEN,
      })
      assert.equal(first.status, 200)
      assert.deepEqual(first.json, { ok: true, expired: true })
      owned = false
      const second = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH, {
        routeToken: ROUTE_TOKEN,
      })
      assert.equal(second.status, 200)
      assert.deepEqual(second.json, { ok: true, expired: false })
    })
    assert.deepEqual(expired, [ROUTE_TOKEN], 'unknown/already-expired release is a no-op')
    assert.deepEqual(resolved, [
      { token: ROUTE_TOKEN, containerId: 11, userId: 42n, ownershipOnly: true },
      { token: ROUTE_TOKEN, containerId: 11, userId: 42n, ownershipOnly: true },
    ])
  })

  test('renew reports liveness scoped to the caller and renews account inflight slot (OCV5-897 B3)', async () => {
    const { pool } = makePool({})
    let live = true
    const renewedTokens: string[] = []
    const handler = makeHandler({
      pool,
      renewInflightFn: (tok: string) => {
        renewedTokens.push(tok)
        return true
      },
      resolveRoute: async () =>
        live
          ? {
              requestId: REQUEST_ID,
              baseUrl: BASE_URL,
              accessToken: 'A'.repeat(48),
              accessTokenExpiresAt: '2026-11-05T00:00:00.000Z',
            }
          : null,
    })
    await withServer(handler, async (port) => {
      const first = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH, {
        routeToken: ROUTE_TOKEN,
      })
      assert.equal(first.status, 200)
      assert.deepEqual(first.json, { ok: true })
      live = false
      const second = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH, {
        routeToken: ROUTE_TOKEN,
      })
      assert.equal(second.status, 200)
      assert.deepEqual(second.json, { ok: false, expired: true })
    })
    assert.deepEqual(renewedTokens, [REQUEST_ID])
  })

  test('mint rejects a malformed requestId and a non-antigravity admission model', async () => {
    {
      const { pool } = makePool({ row: journalRow() })
      const handler = makeHandler({ pool })
      await withServer(handler, async (port) => {
        const result = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
          requestId: 'not-hex',
        })
        assert.equal(result.status, 400)
        assert.equal(result.json.error.code, 'INVALID_BODY')
      })
    }
    {
      const { pool } = makePool({
        row: journalRow({
          ctx: { source: 'delegate_antigravity', model: 'gpt-5.6-sol' },
        }),
      })
      const handler = makeHandler({ pool })
      await withServer(handler, async (port) => {
        const result = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
          requestId: REQUEST_ID,
        })
        assert.equal(result.status, 409)
        assert.equal(result.json.error.code, 'DELEGATE_ANTIGRAVITY_ROUTE_JOURNAL_INVALID')
      })
    }
  })

  test('concurrent mints for the same requestId serialize and loser never abandons winner turn or in-flight slot (Blocker 4)', async () => {
    const { pool } = makePool({ row: [journalRow(), journalRow()] })
    let admitted = 0
    const abandoned: string[] = []
    const released: string[] = []
    const handler = makeHandler({
      pool,
      admit: async () => {
        admitted += 1
        await new Promise((r) => setTimeout(r, 20))
        return mintedRoute()
      },
      abandonTurn: async (_pool: unknown, requestId: string) => {
        abandoned.push(requestId)
      },
      releaseInflightFn: (requestId: string) => {
        released.push(requestId)
      },
    })
    await withServer(handler, async (port) => {
      const [r1, r2] = await Promise.all([
        call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, { requestId: REQUEST_ID }),
        call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, { requestId: REQUEST_ID }),
      ])
      const statuses = [r1.status, r2.status].sort((a, b) => a - b)
      assert.deepEqual(statuses, [200, 409])
    })
    assert.equal(admitted, 1, 'only one mint may allocate upstream resources')
    assert.deepEqual(abandoned, [], 'loser must not abandon winner turn')
    assert.deepEqual(released, [], 'loser must not release winner in-flight slot')
  })

  test('cross-instance persist race loser only expires its own token when winner bound a token or verification query fails (Blocker 4)', async () => {
    // Case 1: second SELECT shows another winner already persisted antigravityRouteToken
    {
      const winnerRow = journalRow({
        ctx: {
          source: 'delegate_antigravity',
          model: 'antigravity-gemini-4-neon',
          antigravityRouteToken: 'ff'.repeat(32),
        },
      })
      const { pool } = makePool({ row: [journalRow(), winnerRow], persistRows: 0 })
      const expired: string[] = []
      const abandoned: string[] = []
      const released: string[] = []
      const handler = makeHandler({
        pool,
        expireRoute: async (token: string) => {
          expired.push(token)
        },
        abandonTurn: async (_pool: unknown, requestId: string) => {
          abandoned.push(requestId)
        },
        releaseInflightFn: (requestId: string) => {
          released.push(requestId)
        },
      })
      await withServer(handler, async (port) => {
        const res = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
          requestId: REQUEST_ID,
        })
        assert.equal(res.status, 409)
        assert.equal(res.json.error.code, 'DELEGATE_ANTIGRAVITY_ROUTE_ALREADY_MINTED')
      })
      assert.deepEqual(expired, [ROUTE_TOKEN])
      assert.deepEqual(abandoned, [])
      assert.deepEqual(released, [])
    }
    // Case 2: second SELECT throws transient DB error -> ownership unknown, do not touch shared requestId
    {
      let selectCalls = 0
      const pool = {
        async query(sql: string) {
          if (sql.includes('SELECT')) {
            selectCalls += 1
            if (selectCalls === 1) return { rows: [journalRow()], rowCount: 1 }
            throw new Error('verification query failed')
          }
          if (sql.includes('UPDATE request_finalize_journal')) {
            if (sql.includes("jsonb_build_object('antigravityMintClaim'")) {
              return { rows: [{ request_id: REQUEST_ID }], rowCount: 1 }
            }
            return { rows: [], rowCount: 0 }
          }
          return { rows: [], rowCount: 0 }
        },
      }
      const expired: string[] = []
      const abandoned: string[] = []
      const released: string[] = []
      const handler = makeHandler({
        pool,
        expireRoute: async (token: string) => {
          expired.push(token)
        },
        abandonTurn: async (_pool: unknown, requestId: string) => {
          abandoned.push(requestId)
        },
        releaseInflightFn: (requestId: string) => {
          released.push(requestId)
        },
      })
      await withServer(handler, async (port) => {
        const res = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
          requestId: REQUEST_ID,
        })
        assert.equal(res.status, 503)
        assert.equal(res.json.error.code, 'ANTIGRAVITY_ROUTE_PERSIST_FAILED')
      })
      assert.deepEqual(expired, [ROUTE_TOKEN])
      assert.deepEqual(abandoned, [])
      assert.deepEqual(released, [])
    }
  })

  test('OCV5-897 B5: mint rejects legacy non-4-family antigravity journals (claude / gpt-oss) before admit', async () => {
    for (const model of ['antigravity-claude-sonnet-5.5', 'antigravity-gpt-oss-120b']) {
      const { pool } = makePool({
        row: journalRow({ ctx: { source: 'delegate_antigravity', model } }),
      })
      let admitted = 0
      const handler = makeHandler({
        pool,
        admit: async () => {
          admitted += 1
          return mintedRoute()
        },
      })
      await withServer(handler, async (port) => {
        const res = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
          requestId: REQUEST_ID,
        })
        assert.equal(res.status, 409, model)
        assert.equal(res.json.error.code, 'DELEGATE_ANTIGRAVITY_ROUTE_MODEL_FAMILY_NOT_ALLOWED')
      })
      assert.equal(admitted, 0, `${model} must never reach admit`)
    }
  })

  test('OCV5-897 B3: admit failure (ANTIGRAVITY_NO_ACCOUNT under strictCapacity) returns 503 and releases mint claim', async () => {
    const { pool, queries } = makePool({ row: journalRow() })
    const handler = makeHandler({
      pool,
      admit: async (args: any) => {
        assert.equal(args.strictCapacity, true)
        throw new AntigravityAdmissionError('ANTIGRAVITY_NO_ACCOUNT')
      },
    })
    await withServer(handler, async (port) => {
      const res = await call(port, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, {
        requestId: REQUEST_ID,
      })
      assert.equal(res.status, 503)
      assert.equal(res.json.error.code, 'ANTIGRAVITY_NO_ACCOUNT')
    })
    assert.equal(
      queries.some((q) => q.sql.includes("ctx - 'antigravityMintClaim'")),
      true,
      'failed admit must release PG mint claim so retry is possible',
    )
  })

  test('OCV5-897 B4: dual-instance concurrent mint race serializes in PG so loser never touches Redis or clobbers winner route', async () => {
    _resetAntigravityRelayRoutesForTests()
    const kvStore = new Map<string, string>()
    configureAntigravityRelayKv({
      get: async (k) => kvStore.get(k) ?? null,
      set: async (k, v) => {
        kvStore.set(k, v)
      },
      del: async (k) => {
        kvStore.delete(k)
      },
    })
    try {
      // Stateful shared PG row simulating two separate master instances racing on one journal row.
      const rowState: JournalRow = journalRow()
      const sharedPool = {
        async query(sql: string, params: unknown[] = []) {
          if (sql.includes('FROM request_finalize_journal') && sql.includes('SELECT')) {
            return { rows: [{ ...rowState, ctx: { ...rowState.ctx } }], rowCount: 1 }
          }
          if (
            sql.includes('UPDATE request_finalize_journal') &&
            sql.includes("jsonb_build_object('antigravityMintClaim'")
          ) {
            if (rowState.ctx.antigravityRouteToken || rowState.ctx.antigravityMintClaim) {
              return { rows: [], rowCount: 0 }
            }
            rowState.ctx.antigravityMintClaim = params[1]
            return { rows: [{ request_id: REQUEST_ID }], rowCount: 1 }
          }
          if (
            sql.includes('UPDATE request_finalize_journal') &&
            sql.includes('antigravityRouteToken')
          ) {
            if (
              rowState.ctx.antigravityRouteToken ||
              rowState.ctx.antigravityMintClaim !== params[4]
            ) {
              return { rows: [], rowCount: 0 }
            }
            delete rowState.ctx.antigravityMintClaim
            rowState.ctx.antigravityRouteToken = params[1]
            return { rows: [{ request_id: REQUEST_ID }], rowCount: 1 }
          }
          if (sql.includes("ctx - 'antigravityMintClaim'")) {
            if (rowState.ctx.antigravityMintClaim === params[3]) {
              delete rowState.ctx.antigravityMintClaim
            }
            return { rows: [], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        },
      }
      let admitCount = 0
      const realAdmit = async (args: any) => {
        admitCount += 1
        await new Promise((r) => setTimeout(r, 20))
        const minted = await mintAntigravityRelayRoute({
          containerId: args.containerId,
          userId: args.userId,
          requestId: args.requestId,
          modelId: args.modelId,
          accountId: 7n,
          budgetCredits: args.budgetCredits,
          relayPort: args.relayPort,
        })
        return {
          token: minted.token,
          baseUrl: minted.baseUrl,
          accessToken: 'A'.repeat(48),
          accessTokenExpiresAt: '2026-11-05T00:00:00.000Z',
        }
      }
      // Two distinct handler instances (separate in-process mintInFlight sets)
      const handlerA = makeHandler({ pool: sharedPool, admit: realAdmit })
      const handlerB = makeHandler({ pool: sharedPool, admit: realAdmit })
      const serverA = createServer((req, res) => void handlerA(req, res, CTX))
      const serverB = createServer((req, res) => void handlerB(req, res, CTX))
      const [portA, portB] = await Promise.all([listen(serverA), listen(serverB)])
      try {
        const [rA, rB] = await Promise.all([
          call(portA, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, { requestId: REQUEST_ID }),
          call(portB, DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH, { requestId: REQUEST_ID }),
        ])
        const winner = rA.status === 200 ? rA : rB
        const loser = rA.status === 200 ? rB : rA
        assert.equal(winner.status, 200)
        assert.equal(loser.status, 409)
        assert.equal(loser.json.error.code, 'DELEGATE_ANTIGRAVITY_ROUTE_ALREADY_MINTED')
        assert.equal(admitCount, 1, 'loser replica must never call admit or overwrite Redis route key')
        const winnerToken = winner.json.route.routeToken as string
        const resolved = await resolveAntigravityRelayRoute({
          token: winnerToken,
          containerId: 11,
          userId: 42n,
        })
        assert.ok(resolved, 'winner route must remain valid in shared KV after loser fails')
        assert.equal(resolved!.requestId, REQUEST_ID)
      } finally {
        await Promise.all([close(serverA), close(serverB)])
      }
    } finally {
      _resetAntigravityRelayRoutesForTests()
    }
  })
})
