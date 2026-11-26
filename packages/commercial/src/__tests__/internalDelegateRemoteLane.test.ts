/**
 * Unit tests for Master internal delegate/swarm remote-lane endpoint (OCV5-835).
 *
 * Covers:
 * - Selfhost v5 gate (404 on non-selfhost), method check (405), container identity auth (401)
 * - Child sessionKey boundary (rejects webchat & reserved keys, allows delegate & swarm)
 * - Catalog placement check (rejects local models) & user model authz (403)
 * - BLOCKER 2: Ownership-bound `/release` (foreign dispatch untouched; stale operationId returns
 *   `state: 'mismatch'` without stopping successor lane)
 * - BLOCKER 3: Master-verified `parentTurnKey` (403 on unknown/foreign, 200 on owned) embedded
 *   into signed `ModelAuthorityPayload.billingAttribution` (`mode: 'delegate'`)
 * - IMPORTANT 1: Uses standard rolling `TURN_LEASE_TTL_MS` (50 min) for dispatch & lease
 * - IMPORTANT 2: Rollback when `admitDispatch` OR `bindAuthorityTurnDispatch` throws; honest HTTP
 *   503 `{ released: false, state: 'unknown' }` when lane stop is unproven
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { TURN_LEASE_TTL_MS } from '@openclaude/protocol'
import { hashSecret } from '../auth/containerIdentity.js'
import {
  DELEGATE_REMOTE_LANE_ENSURE_PATH,
  DELEGATE_REMOTE_LANE_RELEASE_PATH,
  makeDelegateRemoteLaneHandler,
} from '../http/internalDelegateRemoteLane.js'

const VALID_SWARM_KEY = 'agent:main:swarm:dm:coord123_worker1_r1'
const VALID_DELEGATE_KEY = 'agent:coding-assistant:delegate:main:1763719200000-a1b2c3d4'
const TEST_SECRET_HEX = 'a'.repeat(64)
const TEST_CONTAINER_ID = 42
const VALID_AUTH_HEADER = `Bearer oc-v3.${TEST_CONTAINER_ID}.${TEST_SECRET_HEX}`
const OWNED_PARENT_TURN_KEY = 'b'.repeat(64)
const FOREIGN_PARENT_TURN_KEY = 'f'.repeat(64)
const OP_ID_GEN1 = '11111111-1111-4111-8111-111111111111'
const OP_ID_GEN2 = '22222222-2222-4222-8222-222222222222'

function makeReq(method: string, body?: unknown, auth = VALID_AUTH_HEADER): IncomingMessage {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const stream = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []) as IncomingMessage
  stream.method = method
  stream.headers = auth ? { authorization: auth } : {}
  return stream
}

function makeRes() {
  let statusCode = 200
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = String(v)
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()]
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += chunk.toString()
    },
  } as unknown as ServerResponse
  return {
    res,
    get status() {
      return statusCode
    },
    json() {
      return JSON.parse(body) as Record<string, unknown>
    },
  }
}

function makeHarness(overrides: {
  flavor?: 'selfhost' | 'commercial'
  authOk?: boolean
  canUseModel?: boolean
  placement?: 'local' | 'remote_pool'
  canonicalModel?: string
  engine?: 'ccb' | 'codex' | 'antigravity'
  failAdmit?: boolean
  failBind?: boolean
  laneReleaseState?: 'released' | 'not_found' | 'mismatch' | 'unknown'
  currentOperationId?: string
} = {}) {
  const prevChannel = process.env.OC_RUNTIME_CHANNEL
  process.env.OC_RUNTIME_CHANNEL = 'v5'

  const sqlCalls: Array<{ sql: string; params: unknown[] }> = []
  const releasedCalls: Array<{
    uid: number
    sessionKey: string
    opts?: { operationId?: string; generation?: string }
  }> = []
  const ensuredCalls: Array<{ uid: number; sessionKey: string; model: string }> = []
  const signedInputs: Array<{ payload: Record<string, unknown>; opts?: { leaseTtlMs?: number } }> = []

  let storedDispatch: Record<string, unknown> | null = null
  let storedBinding: Record<string, unknown> | null = null
  let currentOp = overrides.currentOperationId ?? OP_ID_GEN1

  const runQuery = async (sql: string, params: unknown[] = []) => {
    sqlCalls.push({ sql, params })
    if (sql.includes('delegate-remote-lane:verify-parent-turn')) {
      const uid = String(params[0])
      const containerId = String(params[1])
      const key = String(params[2])
      if (uid === '3' && containerId === String(TEST_CONTAINER_ID) && key === OWNED_PARENT_TURN_KEY) {
        return { rows: [{ session_id: 'parent-sess-1' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('delegate-remote-lane:check-owned')) {
      const dispatchId = String(params[0])
      if (storedDispatch && storedDispatch.dispatch_id === dispatchId) {
        return { rows: [storedDispatch], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('INSERT INTO turn_dispatches')) {
      if (overrides.failAdmit) {
        throw new Error('DB_ADMIT_FAILED')
      }
      storedDispatch = {
        dispatch_id: params[0],
        user_id: String(params[1]),
        session_id: params[2],
        client_message_id: params[3],
        agent_id: params[4],
        model: params[5],
        request_hash: params[6],
        billing_request_id: params[7],
        owner_id: params[8],
        status: 'admitted',
        outcome: null,
        failure_code: null,
        conflict_reason: null,
        resolution: null,
        resolved_at: null,
        client_notified: false,
        attempt_no: 1,
        lease_epoch: '1',
        lease_until: new Date(Date.now() + TURN_LEASE_TTL_MS),
        anchor_seq: null,
        admitted_at: Date.now(),
        accepted_at: null,
        terminal_at: null,
        last_attempt_at: Date.now(),
        agent_container_id: String(TEST_CONTAINER_ID),
        runtime_kind: 'v5',
      }
      return { rows: [storedDispatch], rowCount: 1 }
    }
    if (sql.includes('FROM turn_dispatches') && sql.includes('FOR UPDATE') && storedDispatch) {
      return { rows: [storedDispatch], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO authority_turn_dispatches')) {
      if (overrides.failBind) {
        throw new Error('DB_BIND_FAILED')
      }
      storedBinding = {
        authority_turn_id: params[0],
        user_id: String(params[1]),
        dispatch_model: params[2],
        canonical_model: params[3],
        session_id: params[4],
        dispatch_id: String(params[5]),
        attempt_no: params[6],
      }
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM authority_turn_dispatches') && storedBinding) {
      return { rows: [storedBinding], rowCount: 1 }
    }
    if (sql.includes('delegate-remote-lane:release-owned')) {
      const [dispatchId, uid, containerId, sessionId, ownerId, leaseEpoch] = params
      const matches =
        storedDispatch !== null &&
        storedDispatch.dispatch_id === dispatchId &&
        storedDispatch.user_id === String(uid) &&
        storedDispatch.agent_container_id === String(containerId) &&
        storedDispatch.session_id === sessionId &&
        storedDispatch.owner_id === ownerId &&
        Number(storedDispatch.lease_epoch) === Number(leaseEpoch) &&
        storedDispatch.status !== 'terminal'
      if (matches && storedDispatch) {
        storedDispatch.status = 'terminal'
        return { rows: [{ dispatch_id: dispatchId }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }

  const pool = {
    query: runQuery,
    async connect() {
      return { query: runQuery, release() {} }
    },
  }

  const fakeBackend = {
    kind: 'remote-driver-v4' as const,
    version: 4 as const,
    engineId: 'antigravity',
    authorityEngine: 'antigravity' as const,
    driverId: 'antigravity',
    driverVersion: '1.0.0',
    sessionKey: VALID_SWARM_KEY,
    operationId: OP_ID_GEN1,
    generation: '1',
    profileId: 'prof-1',
    authEpoch: 'epoch-1',
  }

  const cc5Runtime = {
    async ensureLane(input: { uid: number; sessionKey: string; canonicalModel: string }) {
      ensuredCalls.push({
        uid: input.uid,
        sessionKey: input.sessionKey,
        model: input.canonicalModel,
      })
      return { ...fakeBackend, sessionKey: input.sessionKey, operationId: currentOp }
    },
    async releaseSessionKey(
      uid: number,
      sessionKey: string,
      opts?: { operationId?: string; generation?: string },
    ) {
      releasedCalls.push({ uid, sessionKey, opts })
      if (overrides.laneReleaseState) {
        return {
          released: overrides.laneReleaseState === 'released' || overrides.laneReleaseState === 'not_found',
          state: overrides.laneReleaseState,
        }
      }
      if (opts?.operationId && opts.operationId !== currentOp) {
        return { released: false, state: 'mismatch' as const }
      }
      return { released: true, state: 'released' as const }
    },
  }

  const entry = {
    canonicalModel: overrides.canonicalModel ?? 'antigravity-gemini-4-neon-remote',
    engine: overrides.engine ?? 'antigravity',
    placement: overrides.placement ?? 'remote_pool',
    contextWindow: 1_000_000,
    capabilitySchemaVersion: 1,
    capabilityProfile: {
      supportsVision: true,
      reasoning: { supported: ['medium', 'high', 'xhigh'], codexModelDefault: null },
      ccb: { capabilityZero: false, supportsThinking: true, contextOwner: 'gateway' },
    },
  }

  const handler = makeDelegateRemoteLaneHandler({
    identityRepo: {
      async findActiveByHostAndBoundIp() {
        if (overrides.authOk === false) return null
        return {
          id: TEST_CONTAINER_ID,
          user_id: 3,
          host_uuid: 'host-1',
          bound_ip: '172.18.0.5',
          secret_hash: hashSecret(TEST_SECRET_HEX),
        }
      },
    },
    pool: pool as never,
    flavorIdentity: {
      status: 'ok',
      flavor: overrides.flavor ?? 'selfhost',
    } as never,
    env: {
      OC_SELFHOST_CC5_T1555U_ENABLED: '1',
      OC_SELFHOST_CC5_T1555U_TEST_UID: '3',
    },
    loadUserModelAuthz: (async () => ({ userId: 3n })) as never,
    cc5RuntimeRef: { current: cc5Runtime as never },
    getModelAuthoritySigner: () =>
      ({
        signBundle: (payload: Record<string, unknown>, opts?: { leaseTtlMs?: number }) => {
          signedInputs.push({ payload, opts })
          return {
            payload: { ...payload, authorityTurnId: '2'.repeat(32) },
            bundle: {
              v: 1,
              sig: 'test-sig',
              payload: { ...payload, authorityTurnId: '2'.repeat(32) },
            },
          }
        },
      }) as never,
    getModelCatalog: () =>
      ({
        assertFresh: async () => ({
          executionRevision: 7,
          securityEpoch: 1n,
          aliasToCanonical: (m: string) => m,
          resolve: (m: string) => (m === entry.canonicalModel ? entry : undefined),
          canUseModel: () => overrides.canUseModel ?? true,
        }),
      }) as never,
  })

  return {
    handler,
    sqlCalls,
    releasedCalls,
    ensuredCalls,
    signedInputs,
    setCurrentOp(op: string) {
      currentOp = op
    },
    getStoredDispatch() {
      return storedDispatch
    },
    restore() {
      if (prevChannel === undefined) delete process.env.OC_RUNTIME_CHANNEL
      else process.env.OC_RUNTIME_CHANNEL = prevChannel
    },
  }
}

describe('internalDelegateRemoteLane (OCV5-835)', () => {
  it('returns 404 on non-selfhost flavor and 405 on GET', async () => {
    const h = makeHarness({ flavor: 'commercial' })
    try {
      const r1 = makeRes()
      await h.handler(
        makeReq('POST', {}),
        r1.res,
        { hostUuid: 'host-1', boundIp: '172.18.0.5' },
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(r1.status, 404)

      const r2 = makeRes()
      await h.handler(
        makeReq('GET'),
        r2.res,
        { hostUuid: 'host-1', boundIp: '172.18.0.5' },
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(r2.status, 405)
    } finally {
      h.restore()
    }
  })

  it('rejects unauthenticated (401), webchat sessionKey (400), local model (400), forbidden model (403), and foreign parentTurnKey (403)', async () => {
    const ctx = { hostUuid: 'host-1', boundIp: '172.18.0.5' }
    const hAuth = makeHarness({ authOk: false })
    try {
      const r = makeRes()
      await hAuth.handler(
        makeReq('POST', { sessionKey: VALID_SWARM_KEY, model: 'antigravity-gemini-4-neon-remote' }),
        r.res,
        ctx,
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(r.status, 401)
    } finally {
      hAuth.restore()
    }

    const hLocal = makeHarness({ placement: 'local' })
    try {
      const rWeb = makeRes()
      await hLocal.handler(
        makeReq('POST', {
          sessionKey: 'agent:main:webchat:dm:sess-12345678',
          model: 'antigravity-gemini-4-neon-remote',
        }),
        rWeb.res,
        ctx,
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(rWeb.status, 400)

      const rLocal = makeRes()
      await hLocal.handler(
        makeReq('POST', { sessionKey: VALID_DELEGATE_KEY, model: 'antigravity-gemini-4-neon-remote' }),
        rLocal.res,
        ctx,
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(rLocal.status, 400)
    } finally {
      hLocal.restore()
    }

    const hForbid = makeHarness({ canUseModel: false })
    try {
      const rForbid = makeRes()
      await hForbid.handler(
        makeReq('POST', { sessionKey: VALID_DELEGATE_KEY, model: 'antigravity-gemini-4-neon-remote' }),
        rForbid.res,
        ctx,
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(rForbid.status, 403)
    } finally {
      hForbid.restore()
    }

    const hParent = makeHarness()
    try {
      const rParent = makeRes()
      await hParent.handler(
        makeReq('POST', {
          sessionKey: VALID_DELEGATE_KEY,
          model: 'antigravity-gemini-4-neon-remote',
          parentTurnKey: FOREIGN_PARENT_TURN_KEY,
        }),
        rParent.res,
        ctx,
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(rParent.status, 403)
      assert.equal(hParent.ensuredCalls.length, 0, 'invalid parentTurnKey must reject before acquiring lane')
    } finally {
      hParent.restore()
    }
  })

  it('signs TURN_LEASE_TTL_MS with Master-verified delegate billingAttribution and enforces ownership + operationId on release', async () => {
    const h = makeHarness()
    const ctx = { hostUuid: 'host-1', boundIp: '172.18.0.5' }
    try {
      const rEnsure = makeRes()
      await h.handler(
        makeReq('POST', {
          sessionKey: VALID_SWARM_KEY,
          model: 'antigravity-gemini-4-neon-remote',
          agentId: 'main',
          delegateAgentId: 'swarm:worker1',
          parentTurnKey: OWNED_PARENT_TURN_KEY,
        }),
        rEnsure.res,
        ctx,
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(rEnsure.status, 200, JSON.stringify(rEnsure.json()))
      const body = rEnsure.json()
      assert.equal(h.signedInputs.length, 1)
      assert.equal(h.signedInputs[0]?.opts?.leaseTtlMs, TURN_LEASE_TTL_MS)
      assert.deepEqual(h.signedInputs[0]?.payload.billingAttribution, {
        mode: 'delegate',
        parentTurnKey: OWNED_PARENT_TURN_KEY,
        parentSessionId: 'parent-sess-1',
        delegateAgentId: 'swarm:worker1',
      })

      // Foreign/mismatched ownerId release with VALID operationId must return 403 and NEVER stop the lane (B2)
      const rWrongOwner = makeRes()
      await h.handler(
        makeReq('POST', {
          sessionKey: VALID_SWARM_KEY,
          dispatchId: body.dispatchId,
          ownerId: 'wrong-owner',
          leaseEpoch: body.leaseEpoch,
          operationId: OP_ID_GEN1,
          outcome: 'completed',
          releaseLane: true,
        }),
        rWrongOwner.res,
        ctx,
        DELEGATE_REMOTE_LANE_RELEASE_PATH,
      )
      assert.equal(rWrongOwner.status, 403)
      assert.equal(rWrongOwner.json().dispatchUpdated, false)
      assert.equal(rWrongOwner.json().released, false)
      assert.equal(rWrongOwner.json().state, 'forbidden')
      assert.equal(h.releasedCalls.length, 0, 'wrong-owner release must NOT call releaseSessionKey')
      assert.equal(h.getStoredDispatch()?.status, 'admitted', 'foreign release must leave dispatch untouched')

      // Stale operationId with valid owner returns mismatch without stopping successor lane
      const rStaleOp = makeRes()
      await h.handler(
        makeReq('POST', {
          sessionKey: VALID_SWARM_KEY,
          dispatchId: body.dispatchId,
          ownerId: body.ownerId,
          leaseEpoch: body.leaseEpoch,
          operationId: OP_ID_GEN2,
          outcome: 'completed',
          releaseLane: true,
        }),
        rStaleOp.res,
        ctx,
        DELEGATE_REMOTE_LANE_RELEASE_PATH,
      )
      assert.equal(rStaleOp.status, 200)
      assert.equal(rStaleOp.json().released, false)
      assert.equal(rStaleOp.json().state, 'mismatch')

      // Idempotent retry with matching operationId releases lane cleanly
      const rRel = makeRes()
      await h.handler(
        makeReq('POST', {
          sessionKey: VALID_SWARM_KEY,
          dispatchId: body.dispatchId,
          ownerId: body.ownerId,
          leaseEpoch: body.leaseEpoch,
          operationId: OP_ID_GEN1,
          generation: '1',
          outcome: 'completed',
          releaseLane: true,
        }),
        rRel.res,
        ctx,
        DELEGATE_REMOTE_LANE_RELEASE_PATH,
      )
      assert.equal(rRel.status, 200)
      assert.equal(rRel.json().released, true)
      assert.equal(h.getStoredDispatch()?.status, 'terminal')
    } finally {
      h.restore()
    }
  })

  it('rolls back lane on admitDispatch throw, rolls back both dispatch & lane on bind throw, and returns 503 on unproven stop', async () => {
    const ctx = { hostUuid: 'host-1', boundIp: '172.18.0.5' }

    const hAdmitFail = makeHarness({ failAdmit: true })
    try {
      const r = makeRes()
      await hAdmitFail.handler(
        makeReq('POST', {
          sessionKey: VALID_DELEGATE_KEY,
          model: 'antigravity-gemini-4-neon-remote',
        }),
        r.res,
        ctx,
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(r.status, 500)
      assert.equal(hAdmitFail.releasedCalls.length, 1, 'admitDispatch throw must release acquired lane')
      assert.equal(hAdmitFail.releasedCalls[0]?.opts?.operationId, OP_ID_GEN1)
    } finally {
      hAdmitFail.restore()
    }

    const hBindFail = makeHarness({ failBind: true })
    try {
      const r = makeRes()
      await hBindFail.handler(
        makeReq('POST', {
          sessionKey: VALID_DELEGATE_KEY,
          model: 'antigravity-gemini-4-neon-remote',
        }),
        r.res,
        ctx,
        DELEGATE_REMOTE_LANE_ENSURE_PATH,
      )
      assert.equal(r.status, 500)
      assert.equal(hBindFail.releasedCalls.length, 1)
      assert.equal(hBindFail.getStoredDispatch()?.status, 'terminal')
    } finally {
      hBindFail.restore()
    }

    const hUnknownStop = makeHarness({ laneReleaseState: 'unknown' })
    try {
      const r = makeRes()
      await hUnknownStop.handler(
        makeReq('POST', {
          sessionKey: VALID_SWARM_KEY,
          operationId: OP_ID_GEN1,
          releaseLane: true,
        }),
        r.res,
        ctx,
        DELEGATE_REMOTE_LANE_RELEASE_PATH,
      )
      assert.equal(r.status, 503)
      assert.equal(r.json().released, false)
      assert.equal(r.json().state, 'unknown')
    } finally {
      hUnknownStop.restore()
    }
  })

  it('OCV5-897 B5: rejects non-4-family remote_pool delegate models with 400 before lane ensure or dispatch', async () => {
    const ctx = { hostUuid: 'host-1', boundIp: '172.18.0.5' }
    for (const [model, engine] of [
      ['box-claude-opus-5-5', 'ccb'],
      ['antigravity-claude-sonnet-5.5', 'antigravity'],
    ] as const) {
      const h = makeHarness({ canonicalModel: model, engine })
      try {
        const r = makeRes()
        await h.handler(
          makeReq('POST', { sessionKey: VALID_DELEGATE_KEY, model }),
          r.res,
          ctx,
          DELEGATE_REMOTE_LANE_ENSURE_PATH,
        )
        assert.equal(r.status, 400, model)
        assert.equal(
          (r.json().error as { code?: string } | undefined)?.code,
          'DELEGATE_REMOTE_LANE_MODEL_FAMILY_NOT_ALLOWED',
        )
        assert.equal(h.ensuredCalls.length, 0, `${model} must not call ensureLane`)
        assert.equal(h.getStoredDispatch(), null, `${model} must not insert turn_dispatches`)
      } finally {
        h.restore()
      }
    }
  })
})
