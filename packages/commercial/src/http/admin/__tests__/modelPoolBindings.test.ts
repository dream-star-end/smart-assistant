import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { signAccess } from '../../../auth/jwt.js'
import type { ModelCapabilityProfile } from '../../../billing/modelCatalog.js'
import type { PgQueryResult, PgQueryable } from '../../../db/threeLayerStateStore.js'
import type { CommercialHttpDeps, RequestContext } from '../../handlers.js'
import { createCommercialHandler } from '../../router.js'
import { HttpError } from '../../util.js'
import {
  createAdminModelPoolBindingsHandlers,
  handleAdminModelPoolBindingPut,
  handleAdminModelPoolBindingsList,
  handleAdminModelPoolBindingsSync,
  setVerifiedAdminForRequest,
} from '../modelPoolBindings.js'

function makeProfile(): ModelCapabilityProfile {
  return {
    supportsVision: true,
    reasoning: {
      supported: ['low', 'medium', 'high'],
      codexModelDefault: 'medium',
    },
    ccb: {
      capabilityZero: false,
      supportsThinking: true,
    },
  }
}

function makeRawProfileJson(): Record<string, unknown> {
  return {
    supports_vision: true,
    reasoning: {
      supported: ['low', 'medium', 'high'],
      codex_model_default: 'medium',
    },
    ccb: {
      capability_zero: false,
      supports_thinking: true,
    },
  }
}

function makeReq(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const stream = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []) as IncomingMessage
  stream.method = method
  stream.url = url
  stream.headers = { host: 'localhost', ...headers }
  ;(stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: '127.0.0.1',
  }
  return stream
}

interface CapturedResponse {
  res: ServerResponse
  status: number
  headers: Record<string, string>
  bodyText: string
  json<T = Record<string, unknown>>(): T
}

function makeRes(): CapturedResponse {
  const state: CapturedResponse = {
    res: null as unknown as ServerResponse,
    status: 200,
    headers: {},
    bodyText: '',
    json<T = Record<string, unknown>>(): T {
      return JSON.parse(state.bodyText) as T
    },
  }
  state.res = {
    get statusCode() {
      return state.status
    },
    set statusCode(v: number) {
      state.status = v
    },
    headersSent: false,
    setHeader(name: string, value: string | number) {
      state.headers[name.toLowerCase()] = String(value)
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()]
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        state.bodyText += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
      ;(state.res as unknown as { headersSent: boolean }).headersSent = true
    },
    destroy() {},
  } as unknown as ServerResponse
  return state
}

interface StoredBindingRow {
  binding_id: string
  logical_model_id: string
  pool_kind: string
  driver_id: string
  canonical_model_id: string
  priority: number
  capabilities_json: unknown
  enabled: boolean
  created_at: string
  updated_at: string
}

interface StoredCatalogRow {
  model_id: string
  engine: string
  upstream_model_id: string | null
  context_window: number | null
  capability_profile: unknown
  state: string
  placement: string | null
  default_effort: string | null
}

class MockAdminBindingsPool implements PgQueryable {
  readonly bindings = new Map<string, StoredBindingRow>()
  readonly catalog = new Map<string, StoredCatalogRow>()
  private nextId = 1

  key(logicalModelId: string, poolKind: string, driverId: string): string {
    return `${logicalModelId}|${poolKind}|${driverId}`
  }

  seedBinding(row: Omit<StoredBindingRow, 'binding_id' | 'created_at' | 'updated_at'>): void {
    const id = String(this.nextId++)
    this.bindings.set(this.key(row.logical_model_id, row.pool_kind, row.driver_id), {
      binding_id: id,
      ...row,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
  }

  seedCatalog(row: StoredCatalogRow): void {
    this.catalog.set(row.model_id, row)
  }

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PgQueryResult<R>> {
    if (sql.includes('FROM model_catalog') && sql.includes("mc.state IN ('active', 'disabled')")) {
      const modelId = params[0] as string
      const row = this.catalog.get(modelId)
      if (row && (row.state === 'active' || row.state === 'disabled')) {
        return { rows: [row as unknown as R], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    if (sql.includes('FROM model_catalog') && sql.includes("mc.state = 'active'")) {
      const modelId = params[0] as string
      const row = this.catalog.get(modelId)
      if (row && row.state === 'active') {
        return { rows: [row as unknown as R], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    if (sql.includes('FROM model_logical_pool_bindings') && sql.includes('WHERE logical_model_id = $1')) {
      const [logicalModelId, poolKind, driverId] = params as [string, string, string]
      const row = this.bindings.get(this.key(logicalModelId, poolKind, driverId))
      return { rows: row ? [row as unknown as R] : [], rowCount: row ? 1 : 0 }
    }

    if (sql.includes('FROM model_logical_pool_bindings')) {
      const rows = [...this.bindings.values()].sort(
        (a, b) =>
          a.logical_model_id.localeCompare(b.logical_model_id) ||
          a.priority - b.priority ||
          a.driver_id.localeCompare(b.driver_id),
      )
      return { rows: rows as unknown as R[], rowCount: rows.length }
    }

    if (sql.includes('UPDATE model_logical_pool_bindings')) {
      const [logicalModelId, poolKind, driverId, capabilitiesJson, enabled, expectedCanonicalModelId] =
        params as [string, string, string, string, boolean, string?]
      const k = this.key(logicalModelId, poolKind, driverId)
      const existing = this.bindings.get(k)
      if (!existing) {
        return { rows: [], rowCount: 0 }
      }
      if (
        sql.includes('AND canonical_model_id = $6') &&
        existing.canonical_model_id !== expectedCanonicalModelId
      ) {
        return { rows: [], rowCount: 0 }
      }
      const nextEnabled = sql.includes('CASE WHEN $5 = FALSE THEN FALSE ELSE enabled END')
        ? enabled === false
          ? false
          : existing.enabled
        : enabled
      const next: StoredBindingRow = {
        ...existing,
        capabilities_json: JSON.parse(capabilitiesJson),
        enabled: nextEnabled,
        updated_at: new Date().toISOString(),
      }
      this.bindings.set(k, next)
      return { rows: [next as unknown as R], rowCount: 1 }
    }

    if (sql.includes('INSERT INTO model_logical_pool_bindings')) {
      const [
        logicalModelId,
        poolKind,
        driverId,
        canonicalModelId,
        priority,
        capabilitiesJson,
        enabled,
      ] = params as [string, string, string, string, number, string, boolean]
      const k = this.key(logicalModelId, poolKind, driverId)
      const existing = this.bindings.get(k)
      const preservesOverrides = sql.includes(
        'WHEN model_logical_pool_bindings.canonical_model_id = EXCLUDED.canonical_model_id',
      )
      const nowIso = new Date().toISOString()
      let next: StoredBindingRow
      if (!existing) {
        next = {
          binding_id: String(this.nextId++),
          logical_model_id: logicalModelId,
          pool_kind: poolKind,
          driver_id: driverId,
          canonical_model_id: canonicalModelId,
          priority,
          capabilities_json: JSON.parse(capabilitiesJson),
          enabled,
          created_at: nowIso,
          updated_at: nowIso,
        }
      } else if (preservesOverrides) {
        const sameTarget = existing.canonical_model_id === canonicalModelId
        next = {
          ...existing,
          capabilities_json: sameTarget ? JSON.parse(capabilitiesJson) : existing.capabilities_json,
          enabled: sameTarget && enabled === false ? false : existing.enabled,
          updated_at: nowIso,
        }
      } else {
        next = {
          ...existing,
          canonical_model_id: canonicalModelId,
          priority,
          capabilities_json: JSON.parse(capabilitiesJson),
          enabled,
          updated_at: nowIso,
        }
      }
      this.bindings.set(k, next)
      return { rows: [next as unknown as R], rowCount: 1 }
    }

    throw new Error(`Unexpected SQL: ${sql}`)
  }
}

const TEST_CTX: RequestContext = {
  requestId: 'req-test-1',
  clientIp: '127.0.0.1',
  authBoundIp: '127.0.0.1',
  userAgent: 'unit-test',
  log: {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this
    },
  } as unknown as RequestContext['log'],
}

const TEST_DEPS = { jwtSecret: 'test-model-pool-bindings-secret-only' } as CommercialHttpDeps

describe('admin model pool bindings auth boundary', () => {
  it('router global admin gate rejects anonymous (401) and ordinary user (403) on all 3 routes', async () => {
    const secret = 'test-router-model-bindings-secret'
    const { token: userToken } = await signAccess({ sub: '42', role: 'user' }, secret)
    const handler = createCommercialHandler({
      jwtSecret: secret,
    } as CommercialHttpDeps)

    const routes: Array<readonly [string, string, unknown?]> = [
      ['GET', '/api/admin/pools/model-bindings'],
      ['POST', '/api/admin/pools/model-bindings/sync', {}],
      [
        'PUT',
        '/api/admin/pools/model-bindings',
        {
          logical_model_id: 'gpt-6.2-astra',
          pool_kind: 'remote_pool',
          driver_id: 'codex',
          enabled: true,
        },
      ],
    ]

    for (const [method, url, body] of routes) {
      // Anonymous -> 401
      const anonRes = makeRes()
      const handledAnon = await handler(makeReq(method, url, body), anonRes.res)
      assert.equal(handledAnon, true)
      assert.equal(anonRes.status, 401, `${method} ${url} anonymous must be 401`)

      // Valid non-admin user -> 403
      const userRes = makeRes()
      const handledUser = await handler(
        makeReq(method, url, body, { authorization: `Bearer ${userToken}` }),
        userRes.res,
      )
      assert.equal(handledUser, true)
      assert.equal(userRes.status, 403, `${method} ${url} ordinary user must be 403`)
    }
  })

  it('direct handler invocation fails closed with 401/403 when verified admin principal is absent or non-admin', async () => {
    const res = makeRes()
    for (const [fn, method, url] of [
      [handleAdminModelPoolBindingsList, 'GET', '/api/admin/pools/model-bindings'],
      [handleAdminModelPoolBindingsSync, 'POST', '/api/admin/pools/model-bindings/sync'],
      [handleAdminModelPoolBindingPut, 'PUT', '/api/admin/pools/model-bindings'],
    ] as const) {
      const unauthReq = makeReq(method, url, {})
      await assert.rejects(
        () => fn(unauthReq, res.res, TEST_CTX, TEST_DEPS),
        (err: unknown) => err instanceof HttpError && err.status === 401 && err.code === 'UNAUTHORIZED',
      )

      const userReq = makeReq(method, url, {})
      setVerifiedAdminForRequest(userReq, { id: '9', role: 'user', jti: 'test-jti-user' })
      await assert.rejects(
        () => fn(userReq, res.res, TEST_CTX, TEST_DEPS),
        (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === 'FORBIDDEN',
      )
    }
  })
})

describe('admin model pool bindings GET / POST sync / PUT business rules', () => {
  it('GET lists all rows including disabled and computes accurate summary', async () => {
    const pool = new MockAdminBindingsPool()
    pool.seedBinding({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 50,
      capabilities_json: { logicalModel: 'gpt-6.2-astra' },
      enabled: true,
    })
    pool.seedBinding({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 100,
      capabilities_json: { logicalModel: 'gpt-6.2-astra' },
      enabled: false,
    })
    pool.seedBinding({
      logical_model_id: 'claude-sonnet-5',
      pool_kind: 'local_pool',
      driver_id: 'local-cc',
      canonical_model_id: 'claude-sonnet-5',
      priority: 100,
      capabilities_json: { logicalModel: 'claude-sonnet-5' },
      enabled: true,
    })

    const handlers = createAdminModelPoolBindingsHandlers({ getPool: () => pool })
    const req = makeReq('GET', '/api/admin/pools/model-bindings')
    setVerifiedAdminForRequest(req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    const res = makeRes()

    await handlers.handleList(req, res.res, TEST_CTX, TEST_DEPS)
    assert.equal(res.status, 200)
    const body = res.json<{
      bindings: Array<{ logical_model_id: string; enabled: boolean }>
      summary: { total: number; enabled: number; disabled: number; logical_models: number }
    }>()
    assert.equal(body.bindings.length, 3)
    assert.deepEqual(body.summary, {
      total: 3,
      enabled: 2,
      disabled: 1,
      logical_models: 2,
    })
  })

  it('POST /sync syncs from catalog, validates body, and writes admin_audit', async () => {
    const pool = new MockAdminBindingsPool()
    pool.seedBinding({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 15,
      capabilities_json: {},
      enabled: false,
    })

    const audits: Array<{ action: string; target: string | null; after: unknown }> = []
    const handlers = createAdminModelPoolBindingsHandlers({
      getPool: () => pool,
      loadCatalogEntries: async () => [
        {
          modelId: 'gpt-6.2-astra-remote',
          engine: 'codex',
          contextWindow: 256_000,
          capabilityProfile: makeProfile(),
          state: 'active',
          placement: 'remote_pool',
        },
        {
          modelId: 'gpt-6.2-astra',
          engine: 'codex',
          contextWindow: 256_000,
          capabilityProfile: makeProfile(),
          state: 'active',
          placement: 'local',
        },
      ],
      writeAudit: async (_ctx, action, target, _before, after) => {
        audits.push({ action, target, after })
      },
    })

    // Invalid body type -> 400
    const badReq = makeReq('POST', '/api/admin/pools/model-bindings/sync', {
      overwrite_admin_overrides: 'yes',
    })
    setVerifiedAdminForRequest(badReq, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    await assert.rejects(
      () => handlers.handleSync(badReq, makeRes().res, TEST_CTX, TEST_DEPS),
      (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === 'VALIDATION',
    )

    // Empty body -> overwrite_admin_overrides=false (preserves admin disabled remote_pool)
    const req1 = makeReq('POST', '/api/admin/pools/model-bindings/sync')
    setVerifiedAdminForRequest(req1, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    const res1 = makeRes()
    await handlers.handleSync(req1, res1.res, TEST_CTX, TEST_DEPS)
    assert.equal(res1.status, 200)
    assert.deepEqual(res1.json(), {
      synced: 2,
      enabled: 1,
      disabled: 1,
      skipped: 0,
      overwrite_admin_overrides: false,
    })
    assert.equal(audits.length, 1)
    assert.equal(audits[0]!.action, 'model_pool_bindings.sync')

    // overwrite_admin_overrides: true -> resets remote_pool back to enabled=true, priority=50
    const req2 = makeReq('POST', '/api/admin/pools/model-bindings/sync', {
      overwrite_admin_overrides: true,
    })
    setVerifiedAdminForRequest(req2, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    const res2 = makeRes()
    await handlers.handleSync(req2, res2.res, TEST_CTX, TEST_DEPS)
    assert.equal(res2.status, 200)
    assert.deepEqual(res2.json(), {
      synced: 2,
      enabled: 2,
      disabled: 0,
      skipped: 0,
      overwrite_admin_overrides: true,
    })
    assert.equal(audits.length, 2)
  })

  it('PUT enforces strict validation, blocks enabling non-active catalog models (400 MODEL_NOT_ACTIVE_IN_CATALOG), and audits updates', async () => {
    const pool = new MockAdminBindingsPool()
    pool.seedCatalog({
      model_id: 'gpt-6.2-astra-remote',
      engine: 'codex',
      upstream_model_id: 'gpt-6.2-astra',
      context_window: 256_000,
      capability_profile: makeRawProfileJson(),
      state: 'active',
      placement: 'remote_pool',
      default_effort: 'medium',
    })
    pool.seedCatalog({
      model_id: 'gpt-6.2-astra-retired',
      engine: 'codex',
      upstream_model_id: 'gpt-6.2-astra',
      context_window: 256_000,
      capability_profile: makeRawProfileJson(),
      state: 'disabled',
      placement: 'local',
      default_effort: 'medium',
    })
    pool.seedBinding({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra-retired',
      priority: 100,
      capabilities_json: {},
      enabled: false,
    })

    const audits: Array<{ action: string; target: string | null; before: unknown; after: unknown }> = []
    const handlers = createAdminModelPoolBindingsHandlers({
      getPool: () => pool,
      writeAudit: async (_ctx, action, target, before, after) => {
        audits.push({ action, target, before, after })
      },
    })

    const callPut = async (body: unknown) => {
      const req = makeReq('PUT', '/api/admin/pools/model-bindings', body)
      setVerifiedAdminForRequest(req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
      const res = makeRes()
      await handlers.handlePut(req, res.res, TEST_CTX, TEST_DEPS)
      return res
    }

    // 1. Validation failures
    for (const badBody of [
      { logical_model_id: 'gpt-6.2-astra-remote', pool_kind: 'remote_pool', driver_id: 'codex', enabled: true },
      { logical_model_id: 'gpt-6.2-astra', pool_kind: 'invalid_pool', driver_id: 'codex', enabled: true },
      { logical_model_id: 'gpt-6.2-astra', pool_kind: 'remote_pool', driver_id: 'BAD DRIVER!', enabled: true },
      { logical_model_id: 'gpt-6.2-astra', pool_kind: 'remote_pool', driver_id: 'codex', priority: -1 },
      { logical_model_id: 'gpt-6.2-astra', pool_kind: 'remote_pool', driver_id: 'codex', enabled: 'true' },
      { logical_model_id: 'gpt-6.2-astra', pool_kind: 'remote_pool', driver_id: 'codex' },
      { logical_model_id: 'brand-new', pool_kind: 'remote_pool', driver_id: 'codex', enabled: false },
    ]) {
      await assert.rejects(
        () => callPut(badBody),
        (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === 'VALIDATION',
      )
    }

    // 2. Security guard: reject enabling a binding whose canonical_model_id is disabled in model_catalog
    await assert.rejects(
      () =>
        callPut({
          logical_model_id: 'gpt-6.2-astra',
          pool_kind: 'local_pool',
          driver_id: 'local-codex',
          enabled: true,
        }),
      (err: unknown) =>
        err instanceof HttpError &&
        err.status === 400 &&
        err.code === 'MODEL_NOT_ACTIVE_IN_CATALOG',
    )

    // 3. Security guard: reject creating an enabled binding for an unknown/non-existent catalog model
    await assert.rejects(
      () =>
        callPut({
          logical_model_id: 'ghost-model',
          pool_kind: 'remote_pool',
          driver_id: 'codex',
          canonical_model_id: 'ghost-model-remote',
          enabled: true,
        }),
      (err: unknown) =>
        err instanceof HttpError &&
        err.status === 400 &&
        err.code === 'MODEL_NOT_ACTIVE_IN_CATALOG',
    )

    // 4. Disabling is allowed even when catalog row is disabled
    const resDisable = await callPut({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      priority: 120,
      enabled: false,
    })
    assert.equal(resDisable.status, 200)
    assert.equal(resDisable.json<{ binding: { priority: number; enabled: boolean } }>().binding.priority, 120)
    assert.equal(audits.length, 1)
    assert.equal(audits[0]!.action, 'model_pool_bindings.put')
    assert.deepEqual(audits[0]!.before, {
      canonical_model_id: 'gpt-6.2-astra-retired',
      priority: 100,
      enabled: false,
    })
    assert.deepEqual(audits[0]!.after, {
      canonical_model_id: 'gpt-6.2-astra-retired',
      priority: 120,
      enabled: false,
    })

    // 5. Creating/enabling an active catalog model succeeds, derives capabilities, and audits
    const resEnable = await callPut({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 40,
      enabled: true,
    })
    assert.equal(resEnable.status, 200)
    const enablePayload = resEnable.json<{
      created: boolean
      binding: {
        logical_model_id: string
        pool_kind: string
        driver_id: string
        canonical_model_id: string
        priority: number
        enabled: boolean
        capabilities: { contextWindow?: number; supportsVision?: boolean }
      }
    }>()
    assert.equal(enablePayload.created, true)
    assert.equal(enablePayload.binding.priority, 40)
    assert.equal(enablePayload.binding.enabled, true)
    assert.equal(enablePayload.binding.capabilities.contextWindow, 256_000)
    assert.equal(enablePayload.binding.capabilities.supportsVision, true)
    assert.equal(audits.length, 2)
    assert.equal(audits[1]!.target, 'model_pool_binding:gpt-6.2-astra:remote_pool:codex')
    assert.equal(audits[1]!.before, null)
  })

  it('B6: PUT rejects box_pool, local canonical on remote_pool, wrong driver_id, and unsupported engine even when enabled=false', async () => {
    const pool = new MockAdminBindingsPool()
    pool.seedCatalog({
      model_id: 'gpt-6.2-astra',
      engine: 'codex',
      upstream_model_id: 'gpt-6.2-astra',
      context_window: 256_000,
      capability_profile: makeRawProfileJson(),
      state: 'active',
      placement: 'local',
      default_effort: 'medium',
    })
    pool.seedCatalog({
      model_id: 'gpt-6.2-astra-remote',
      engine: 'codex',
      upstream_model_id: 'gpt-6.2-astra',
      context_window: 256_000,
      capability_profile: makeRawProfileJson(),
      state: 'active',
      placement: 'remote_pool',
      default_effort: 'medium',
    })
    pool.seedCatalog({
      model_id: 'unknown-engine-model',
      engine: 'mystery-engine',
      upstream_model_id: 'unknown-engine-model',
      context_window: 128_000,
      capability_profile: makeRawProfileJson(),
      state: 'active',
      placement: 'local',
      default_effort: null,
    })

    const handlers = createAdminModelPoolBindingsHandlers({
      getPool: () => pool,
      writeAudit: async () => {},
    })
    const callPut = async (body: unknown) => {
      const req = makeReq('PUT', '/api/admin/pools/model-bindings', body)
      setVerifiedAdminForRequest(req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
      const res = makeRes()
      await handlers.handlePut(req, res.res, TEST_CTX, TEST_DEPS)
      return res
    }

    // 1. box_pool rejected immediately for both enabled=true and enabled=false
    for (const enabled of [true, false]) {
      await assert.rejects(
        () =>
          callPut({
            logical_model_id: 'gpt-6.2-astra',
            pool_kind: 'box_pool',
            driver_id: 'codex',
            canonical_model_id: 'gpt-6.2-astra',
            enabled,
          }),
        (err: unknown) =>
          err instanceof HttpError && err.status === 400 && err.code === 'MODEL_POOL_KIND_UNSUPPORTED',
      )
    }

    // 2. Local canonical attached to remote_pool -> 400 MODEL_POOL_PLACEMENT_MISMATCH (enabled=true & false)
    for (const enabled of [true, false]) {
      await assert.rejects(
        () =>
          callPut({
            logical_model_id: 'gpt-6.2-astra',
            pool_kind: 'remote_pool',
            driver_id: 'codex',
            canonical_model_id: 'gpt-6.2-astra',
            enabled,
          }),
        (err: unknown) =>
          err instanceof HttpError &&
          err.status === 400 &&
          err.code === 'MODEL_POOL_PLACEMENT_MISMATCH',
      )
    }

    // 3. Remote canonical attached to local_pool -> 400 MODEL_POOL_PLACEMENT_MISMATCH
    await assert.rejects(
      () =>
        callPut({
          logical_model_id: 'gpt-6.2-astra',
          pool_kind: 'local_pool',
          driver_id: 'local-codex',
          canonical_model_id: 'gpt-6.2-astra-remote',
          enabled: true,
        }),
      (err: unknown) =>
        err instanceof HttpError &&
        err.status === 400 &&
        err.code === 'MODEL_POOL_PLACEMENT_MISMATCH',
    )

    // 4. Wrong driver_id -> 400 MODEL_POOL_DRIVER_MISMATCH (enabled=true & false)
    for (const enabled of [true, false]) {
      await assert.rejects(
        () =>
          callPut({
            logical_model_id: 'gpt-6.2-astra',
            pool_kind: 'local_pool',
            driver_id: 'codex',
            canonical_model_id: 'gpt-6.2-astra',
            enabled,
          }),
        (err: unknown) =>
          err instanceof HttpError && err.status === 400 && err.code === 'MODEL_POOL_DRIVER_MISMATCH',
      )
    }

    // 5. Unsupported catalog engine -> 400 MODEL_POOL_ENGINE_UNSUPPORTED
    await assert.rejects(
      () =>
        callPut({
          logical_model_id: 'unknown-engine-model',
          pool_kind: 'local_pool',
          driver_id: 'local-codex',
          canonical_model_id: 'unknown-engine-model',
          enabled: false,
        }),
      (err: unknown) =>
        err instanceof HttpError &&
        err.status === 400 &&
        err.code === 'MODEL_POOL_ENGINE_UNSUPPORTED',
    )
  })

  it('B7: PUT canonical override survives normal POST /sync (restart simulation) and GET, disables if overridden target goes disabled, resets on overwrite=true', async () => {
    const pool = new MockAdminBindingsPool()
    pool.seedCatalog({
      model_id: 'gpt-6.2-astra',
      engine: 'codex',
      upstream_model_id: 'gpt-6.2-astra',
      context_window: 128_000,
      capability_profile: makeRawProfileJson(),
      state: 'active',
      placement: 'local',
      default_effort: 'medium',
    })
    pool.seedCatalog({
      model_id: 'gpt-6.2-astra-v2',
      engine: 'codex',
      upstream_model_id: 'gpt-6.2-astra-v2',
      context_window: 512_000,
      capability_profile: makeRawProfileJson(),
      state: 'active',
      placement: 'local',
      default_effort: 'high',
    })

    let v2State: 'active' | 'disabled' = 'active'
    const handlers = createAdminModelPoolBindingsHandlers({
      getPool: () => pool,
      loadCatalogEntries: async () => [
        {
          modelId: 'gpt-6.2-astra',
          engine: 'codex',
          contextWindow: 128_000,
          capabilityProfile: makeProfile(),
          state: 'active',
          placement: 'local',
        },
        {
          modelId: 'gpt-6.2-astra-v2',
          engine: 'codex',
          contextWindow: 512_000,
          capabilityProfile: makeProfile(),
          state: v2State,
          placement: 'local',
        },
      ],
      writeAudit: async () => {},
    })

    // 1. Initial sync creates default local binding for gpt-6.2-astra -> gpt-6.2-astra
    const sync0Req = makeReq('POST', '/api/admin/pools/model-bindings/sync')
    setVerifiedAdminForRequest(sync0Req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    await handlers.handleSync(sync0Req, makeRes().res, TEST_CTX, TEST_DEPS)

    // 2. Admin PUT overrides canonical_model_id to gpt-6.2-astra-v2 & priority to 20
    const putReq = makeReq('PUT', '/api/admin/pools/model-bindings', {
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra-v2',
      priority: 20,
      enabled: true,
    })
    setVerifiedAdminForRequest(putReq, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    const putRes = makeRes()
    await handlers.handlePut(putReq, putRes.res, TEST_CTX, TEST_DEPS)
    assert.equal(putRes.status, 200)

    // 3. Normal POST /sync (simulates restart): GET MUST still show gpt-6.2-astra-v2, priority 20, contextWindow 512_000
    const sync1Req = makeReq('POST', '/api/admin/pools/model-bindings/sync')
    setVerifiedAdminForRequest(sync1Req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    await handlers.handleSync(sync1Req, makeRes().res, TEST_CTX, TEST_DEPS)

    const list1Req = makeReq('GET', '/api/admin/pools/model-bindings')
    setVerifiedAdminForRequest(list1Req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    const list1Res = makeRes()
    await handlers.handleList(list1Req, list1Res.res, TEST_CTX, TEST_DEPS)
    const row1 = list1Res
      .json<{
        bindings: Array<{
          logical_model_id: string
          canonical_model_id: string
          priority: number
          enabled: boolean
          capabilities: { contextWindow?: number }
        }>
      }>()
      .bindings.find((b) => b.logical_model_id === 'gpt-6.2-astra')!
    assert.equal(row1.canonical_model_id, 'gpt-6.2-astra-v2')
    assert.equal(row1.priority, 20)
    assert.equal(row1.enabled, true)
    assert.equal(row1.capabilities.contextWindow, 512_000)

    // 4. Mark gpt-6.2-astra-v2 disabled -> normal sync forces enabled=false while keeping canonical override
    v2State = 'disabled'
    const sync2Req = makeReq('POST', '/api/admin/pools/model-bindings/sync')
    setVerifiedAdminForRequest(sync2Req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    await handlers.handleSync(sync2Req, makeRes().res, TEST_CTX, TEST_DEPS)

    const list2Req = makeReq('GET', '/api/admin/pools/model-bindings')
    setVerifiedAdminForRequest(list2Req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    const list2Res = makeRes()
    await handlers.handleList(list2Req, list2Res.res, TEST_CTX, TEST_DEPS)
    const row2 = list2Res
      .json<{
        bindings: Array<{
          logical_model_id: string
          canonical_model_id: string
          priority: number
          enabled: boolean
        }>
      }>()
      .bindings.find((b) => b.logical_model_id === 'gpt-6.2-astra')!
    assert.equal(row2.canonical_model_id, 'gpt-6.2-astra-v2')
    assert.equal(row2.priority, 20)
    assert.equal(row2.enabled, false)

    // 5. Explicit overwrite_admin_overrides=true resets back to derived default gpt-6.2-astra
    const sync3Req = makeReq('POST', '/api/admin/pools/model-bindings/sync', {
      overwrite_admin_overrides: true,
    })
    setVerifiedAdminForRequest(sync3Req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    await handlers.handleSync(sync3Req, makeRes().res, TEST_CTX, TEST_DEPS)

    const list3Req = makeReq('GET', '/api/admin/pools/model-bindings')
    setVerifiedAdminForRequest(list3Req, { id: '3', role: 'admin', jti: 'test-jti-admin' })
    const list3Res = makeRes()
    await handlers.handleList(list3Req, list3Res.res, TEST_CTX, TEST_DEPS)
    const row3 = list3Res
      .json<{
        bindings: Array<{
          logical_model_id: string
          canonical_model_id: string
          priority: number
          enabled: boolean
        }>
      }>()
      .bindings.find((b) => b.logical_model_id === 'gpt-6.2-astra')!
    assert.equal(row3.canonical_model_id, 'gpt-6.2-astra')
    assert.equal(row3.priority, 50)
    assert.equal(row3.enabled, true)
  })
})
