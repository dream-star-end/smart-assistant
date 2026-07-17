import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import {
  AUTHORITY_TURN_MAX_LIFETIME_MS,
  TURN_LEASE_TTL_MS,
  turnLeaseOriginalIssuedAt,
  verifyTurnLease,
} from '@openclaude/protocol'
import type { Pool, PoolClient } from 'pg'

import { type ContainerIdentityRepo, hashSecret } from '../auth/containerIdentity.js'
import {
  type TurnLeaseRenewHandler,
  makeTurnLeaseRenewHandler,
} from '../http/internalTurnLeaseRenew.js'
import { AuthoritySigner } from '../ws/authoritySigner.js'

const ORIGINAL = 1_780_000_000_000
const TURN_KEY = 'c'.repeat(64)
const SECRET = 'ab'.repeat(32)
const TOKEN = `Bearer oc-v3.7.${SECRET}`

class MockReq extends Readable {
  method = 'POST'
  headers: Record<string, string> = { authorization: TOKEN }

  constructor(body: unknown) {
    super()
    this.push(Buffer.from(JSON.stringify(body)))
    this.push(null)
  }
}

class MockRes {
  statusCode = 0
  headersSent = false
  chunks: Buffer[] = []
  headers = new Map<string, string>()
  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), String(value))
  }
  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    this.headersSent = true
  }
  json(): any {
    return JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
  }
}

function identityRepo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== 'host-1' || boundIp !== '172.30.0.7') return null
      return {
        id: 7,
        user_id: 42,
        bound_ip: boundIp,
        host_uuid: hostUuid,
        secret_hash: hashSecret(SECRET),
      }
    },
  }
}

function fakePool(
  opts: {
    terminal?: boolean
    waived?: boolean
    evidence?: boolean
    evidenceTurnKey?: string | null
    evidenceState?: string
    evidenceSource?: string
    epoch?: bigint
  } = {},
): { pool: Pool; sql: Array<{ text: string; params: readonly unknown[] }> } {
  const sql: Array<{ text: string; params: readonly unknown[] }> = []
  const client: PoolClient = {
    async query(raw: any, params: readonly unknown[] = []): Promise<any> {
      const text = (typeof raw === 'string' ? raw : raw.text).replace(/\s+/g, ' ').trim()
      sql.push({ text, params })
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rowCount: 0, rows: [] }
      }
      if (/pg_advisory_xact_lock/.test(text)) return { rowCount: 1, rows: [{}] }
      if (/FROM server_authored_turn_anchor_map/.test(text)) {
        return { rowCount: opts.terminal ? 1 : 0, rows: opts.terminal ? [{}] : [] }
      }
      if (/FROM turn_waivers/.test(text)) {
        return { rowCount: opts.waived ? 1 : 0, rows: opts.waived ? [{}] : [] }
      }
      if (/FROM request_finalize_journal/.test(text)) {
        const found = opts.evidence ?? true
        return {
          rowCount: found ? 1 : 0,
          rows: found
            ? [
                {
                  request_id: 'renew-journal-1',
                  state: opts.evidenceState ?? 'committed',
                  source: opts.evidenceSource ?? 'ccb_proxy',
                  turn_key: opts.evidenceTurnKey === undefined ? TURN_KEY : opts.evidenceTurnKey,
                },
              ]
            : [],
        }
      }
      if (/UPDATE request_finalize_journal/.test(text)) {
        return { rowCount: 1, rows: [] }
      }
      if (/FROM model_security_epoch/.test(text)) {
        return { rowCount: 1, rows: [{ epoch: (opts.epoch ?? 9n).toString() }] }
      }
      throw new Error(`unhandled SQL: ${text}`)
    },
    release() {},
  } as unknown as PoolClient
  return {
    pool: {
      async connect() {
        return client
      },
    } as unknown as Pool,
    sql,
  }
}

function mint(signer: AuthoritySigner, now = ORIGINAL) {
  return signer.signBundle(
    {
      uid: 42,
      containerId: 7,
      connectionChallenge: 'challenge-1',
      canonicalModel: 'kimi-k3',
      engine: 'ccb',
      executionDescriptor: {
        capabilityProfile: {},
        capabilitySchemaVersion: 1,
        contextWindow: 262_144,
        supportedEfforts: [],
        supportsVision: true,
      },
      executionRevision: 'd'.repeat(64),
      securityEpoch: 9,
      auxModels: [],
    },
    { now },
  )
}

async function run(handler: TurnLeaseRenewHandler, body: unknown): Promise<MockRes> {
  const req = new MockReq(body)
  const res = new MockRes()
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse, {
    hostUuid: 'host-1',
    boundIp: '172.30.0.7',
  })
  return res
}

describe('internal turn-lease renewal', () => {
  test('authenticated active turn renews under the shared turn lock and preserves originalIssuedAt', async () => {
    const signer = AuthoritySigner.createEphemeral()
    const initial = mint(signer)
    const now = ORIGINAL + 30 * 60_000
    const db = fakePool()
    const handler = makeTurnLeaseRenewHandler({
      identityRepo: identityRepo(),
      pgPool: db.pool,
      getSigner: () => signer,
      now: () => now,
    })

    const res = await run(handler, { turnKey: TURN_KEY, lease: initial.bundle.lease })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    const renewed = verifyTurnLease(body.lease, signer.publicKeyring(), now)
    assert.equal(turnLeaseOriginalIssuedAt(renewed), ORIGINAL)
    assert.equal(renewed.issuedAt, now)
    assert.equal(renewed.expiresAt, now + TURN_LEASE_TTL_MS)
    const evidence = db.sql.find((q) => /FROM request_finalize_journal/.test(q.text))
    assert.deepEqual(evidence?.params.slice(0, 3), [42, 7, initial.lease.authorityTurnId])
    assert.ok(db.sql.some((q) => /pg_advisory_xact_lock/.test(q.text)))
    assert.ok(db.sql.some((q) => q.text === 'COMMIT'))
  })

  test('first Codex bridge renewal binds the gateway turn key before signing', async () => {
    const signer = AuthoritySigner.createEphemeral()
    const initial = mint(signer)
    const db = fakePool({
      evidenceTurnKey: null,
      evidenceState: 'inflight',
      evidenceSource: 'codex_bridge',
    })
    const handler = makeTurnLeaseRenewHandler({
      identityRepo: identityRepo(),
      pgPool: db.pool,
      getSigner: () => signer,
      now: () => ORIGINAL + 30 * 60_000,
    })

    const res = await run(handler, { turnKey: TURN_KEY, lease: initial.bundle.lease })
    assert.equal(res.statusCode, 200)
    const bind = db.sql.find((q) => /UPDATE request_finalize_journal/.test(q.text))
    assert.deepEqual(bind?.params, ['renew-journal-1', TURN_KEY])
    assert.ok(bind?.text.includes("ctx->>'turnKey' IS NULL"))
  })

  test('a previously bound authority turn rejects a different billing turn key', async () => {
    const signer = AuthoritySigner.createEphemeral()
    const initial = mint(signer)
    const db = fakePool({ evidenceTurnKey: 'd'.repeat(64) })
    const handler = makeTurnLeaseRenewHandler({
      identityRepo: identityRepo(),
      pgPool: db.pool,
      getSigner: () => signer,
      now: () => ORIGINAL + 30 * 60_000,
    })

    const res = await run(handler, { turnKey: TURN_KEY, lease: initial.bundle.lease })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'TURN_KEY_MISMATCH')
    assert.equal(
      db.sql.some((q) => /FROM model_security_epoch/.test(q.text)),
      false,
    )
  })

  test('renewal near 12h is capped exactly at the original absolute deadline', async () => {
    const signer = AuthoritySigner.createEphemeral()
    const initial = mint(signer)
    const nearEnd = {
      ...initial.lease,
      issuedAt: ORIGINAL + 11 * 60 * 60_000,
      expiresAt: ORIGINAL + AUTHORITY_TURN_MAX_LIFETIME_MS,
    }
    const lease = signer.signTurnLease(nearEnd)
    const now = ORIGINAL + 11 * 60 * 60_000 + 10 * 60_000
    const db = fakePool()
    const handler = makeTurnLeaseRenewHandler({
      identityRepo: identityRepo(),
      pgPool: db.pool,
      getSigner: () => signer,
      now: () => now,
    })

    const res = await run(handler, { turnKey: TURN_KEY, lease })
    assert.equal(res.statusCode, 200)
    const renewed = verifyTurnLease(res.json().lease, signer.publicKeyring(), now)
    assert.equal(renewed.expiresAt, ORIGINAL + AUTHORITY_TURN_MAX_LIFETIME_MS)
  })

  test('terminal or already-waived turn is rejected before active evidence and rolls back', async () => {
    const signer = AuthoritySigner.createEphemeral()
    const initial = mint(signer)
    for (const state of [{ terminal: true }, { waived: true }]) {
      const db = fakePool(state)
      const handler = makeTurnLeaseRenewHandler({
        identityRepo: identityRepo(),
        pgPool: db.pool,
        getSigner: () => signer,
        now: () => ORIGINAL + 60_000,
      })
      const res = await run(handler, { turnKey: TURN_KEY, lease: initial.bundle.lease })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'TURN_FINALIZED')
      assert.equal(
        db.sql.some((q) => /FROM request_finalize_journal/.test(q.text)),
        false,
      )
      assert.ok(db.sql.some((q) => q.text === 'ROLLBACK'))
    }
  })

  test('missing active evidence or changed security epoch cannot extend a lease', async () => {
    const signer = AuthoritySigner.createEphemeral()
    const initial = mint(signer)
    for (const [dbOpts, expected] of [
      [{ evidence: false }, 'TURN_NOT_ACTIVE'],
      [{ epoch: 10n }, 'MODEL_CONFIG_CHANGED'],
    ] as const) {
      const db = fakePool(dbOpts)
      const handler = makeTurnLeaseRenewHandler({
        identityRepo: identityRepo(),
        pgPool: db.pool,
        getSigner: () => signer,
        now: () => ORIGINAL + 60_000,
      })
      const res = await run(handler, { turnKey: TURN_KEY, lease: initial.bundle.lease })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, expected)
      assert.ok(db.sql.some((q) => q.text === 'ROLLBACK'))
    }
  })
})
