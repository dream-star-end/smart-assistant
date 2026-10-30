import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { TURN_LEASE_TTL_MS, verifyTurnLease } from '@openclaude/protocol'
import type { Pool, PoolClient } from 'pg'
import { type ContainerIdentityRepo, hashSecret } from '../auth/containerIdentity.js'
import { makeTurnLeaseRenewHandler } from '../http/internalTurnLeaseRenew.js'
import { AuthoritySigner } from '../ws/authoritySigner.js'

const ORIGINAL = 1_780_000_000_000
const TURN_KEY = 'c'.repeat(64)
const SECRET = 'ab'.repeat(32)
const LEGACY_KEYS = ['authorityTurnId', 'auxModels', 'canonicalModel', 'connectionChallenge',
  'containerId', 'expiresAt', 'issuedAt', 'keyId', 'securityEpoch', 'uid', 'v']
class Req extends Readable {
  method = 'POST'
  headers = { authorization: `Bearer oc-v3.7.${SECRET}` }
  constructor(body: unknown) { super(); this.push(Buffer.from(JSON.stringify(body))); this.push(null) }
}
class Res {
  statusCode = 0
  headersSent = false
  chunks: Buffer[] = []
  setHeader(): void {}
  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
    this.headersSent = true
  }
  json(): any { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')) }
}
const identityRepo: ContainerIdentityRepo = {
  async findActiveByHostAndBoundIp() {
    return { id: 7, user_id: 42, bound_ip: '172.30.0.7', host_uuid: 'host-1', secret_hash: hashSecret(SECRET) }
  },
}
function mint(signer: AuthoritySigner) {
  return signer.signBundle({
    uid: 42, containerId: 7, connectionChallenge: 'challenge-1', canonicalModel: 'kimi-k3',
    engine: 'ccb', executionDescriptor: { capabilityProfile: {}, capabilitySchemaVersion: 1,
      contextWindow: 262_144, supportedEfforts: [], supportsVision: true },
    executionRevision: 'd'.repeat(64), securityEpoch: 9, auxModels: [],
  }, { now: ORIGINAL })
}
interface DbOpts {
  terminal?: boolean; waived?: boolean; dispatch?: boolean; turnKey?: string | null
  status?: string; containerId?: number; canonicalModel?: string; dispatchAttemptNo?: number
  fenced?: boolean; epoch?: bigint; conflicting?: boolean; matching?: boolean; bindable?: string[]
}
function fakePool(opts: DbOpts = {}) {
  const sql: Array<{ text: string; params: readonly unknown[] }> = []
  let boundKey = opts.turnKey === undefined ? TURN_KEY : opts.turnKey
  const client = {
    async query(raw: any, params: readonly unknown[] = []) {
      const text = (typeof raw === 'string' ? raw : raw.text).replace(/\s+/g, ' ').trim()
      sql.push({ text, params })
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text) || /pg_advisory_xact_lock/.test(text))
        return { rowCount: 0, rows: [] }
      if (/FROM server_authored_turn_anchor_map/.test(text))
        return { rowCount: opts.terminal ? 1 : 0, rows: opts.terminal ? [{}] : [] }
      if (/FROM turn_waivers/.test(text))
        return { rowCount: opts.waived ? 1 : 0, rows: opts.waived ? [{}] : [] }
      if (/FROM authority_turn_dispatches atd/.test(text)) {
        const found = opts.dispatch !== false
        return { rowCount: found ? 1 : 0, rows: found ? [{
          turn_key: boundKey, canonical_model: opts.canonicalModel ?? 'kimi-k3',
          attempt_no: 1, dispatch_attempt_no: opts.dispatchAttemptNo ?? 1,
          status: opts.status ?? 'accepted', terminal_at: null,
          producer_fenced_at: opts.fenced ? new Date(ORIGINAL) : null,
          agent_container_id: String(opts.containerId ?? 7),
        }] : [] }
      }
      if (/FROM request_finalize_journal/.test(text))
        return { rowCount: 1, rows: [{ conflicting: opts.conflicting ?? false,
          matching: opts.matching ?? false, bindable: opts.bindable ?? [] }] }
      if (/UPDATE authority_turn_dispatches/.test(text)) {
        if (boundKey !== null) return { rowCount: 0, rows: [] }
        boundKey = String(params[2])
        return { rowCount: 1, rows: [] }
      }
      if (/UPDATE request_finalize_journal/.test(text)) return { rowCount: 1, rows: [] }
      if (/FROM model_security_epoch/.test(text))
        return { rowCount: 1, rows: [{ epoch: String(opts.epoch ?? 9n) }] }
      throw new Error(`unhandled SQL: ${text}`)
    },
    release() {},
  } as unknown as PoolClient
  return { sql, pool: { async connect() { return client } } as unknown as Pool }
}
async function run(signer: AuthoritySigner, lease: string, now: number, opts: DbOpts = {}, key = TURN_KEY) {
  const db = fakePool(opts)
  const handler = makeTurnLeaseRenewHandler({ identityRepo, pgPool: db.pool,
    getSigner: () => signer, now: () => now })
  const req = new Req({ turnKey: key, lease }); const res = new Res()
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse,
    { hostUuid: 'host-1', boundIp: '172.30.0.7' })
  return { res, sql: db.sql }
}
test('active exact dispatch recovers expired lease after 24h with strict legacy wire', async () => {
  const signer = AuthoritySigner.createEphemeral(); const initial = mint(signer)
  const now = ORIGINAL + 24 * 60 * 60_000
  const { res, sql } = await run(signer, initial.bundle.lease, now)
  assert.equal(res.statusCode, 200)
  const renewed = verifyTurnLease(res.json().lease, signer.publicKeyring(), now)
  assert.equal(renewed.expiresAt, now + TURN_LEASE_TTL_MS)
  assert.equal(renewed.authorityTurnId, initial.lease.authorityTurnId)
  assert.equal(renewed.originalIssuedAt, undefined)
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(res.json().lease, 'base64url').toString()).payload).sort(), LEGACY_KEYS)
  assert.equal(sql.some((q) => /FROM request_finalize_journal/.test(q.text)), false,
    'durably bound active dispatch survives journal GC and long tools')
  const dispatch = sql.find((q) => /FROM authority_turn_dispatches/.test(q.text))!
  assert.deepEqual(dispatch.params, [initial.lease.authorityTurnId, 42])
  assert.match(dispatch.text, /FOR UPDATE OF atd, td/)
  assert.equal(sql.at(-1)?.text, 'COMMIT')
})
test('consecutive renewals keep short windows without an absolute task deadline', async () => {
  const signer = AuthoritySigner.createEphemeral(); const initial = mint(signer)
  const first = await run(signer, initial.bundle.lease, ORIGINAL + 30 * 60_000)
  const now = ORIGINAL + 8 * 24 * 60 * 60_000
  const second = await run(signer, first.res.json().lease, now)
  assert.equal(second.res.statusCode, 200)
  assert.equal(verifyTurnLease(second.res.json().lease, signer.publicKeyring(), now).expiresAt, now + TURN_LEASE_TTL_MS)
})
test('nullable durable key binds once; a subsequent different key is rejected', async () => {
  const signer = AuthoritySigner.createEphemeral(); const initial = mint(signer)
  const { res, sql } = await run(signer, initial.bundle.lease, ORIGINAL + 60_000, { turnKey: null, matching: true })
  assert.equal(res.statusCode, 200)
  assert.ok(sql.some((q) => /UPDATE authority_turn_dispatches/.test(q.text) && /turn_key IS NULL/.test(q.text)))
  const other = await run(signer, initial.bundle.lease, ORIGINAL + 60_000, {}, 'd'.repeat(64))
  assert.equal(other.res.json().error.code, 'TURN_KEY_MISMATCH')
})
test('lease-only dispatch first binding works without a proxy journal', async () => {
  const signer = AuthoritySigner.createEphemeral()
  const { res, sql } = await run(signer, mint(signer).bundle.lease,
    ORIGINAL + 24 * 60 * 60_000, { turnKey: null })
  assert.equal(res.statusCode, 200)
  assert.ok(sql.some((q) => /UPDATE authority_turn_dispatches/.test(q.text)))
})
test('conflicting journal cannot first-bind a different durable turn key', async () => {
  const signer = AuthoritySigner.createEphemeral()
  const { res, sql } = await run(signer, mint(signer).bundle.lease, ORIGINAL + 60_000,
    { turnKey: null, conflicting: true })
  assert.equal(res.json().error.code, 'TURN_KEY_MISMATCH')
  assert.equal(sql.some((q) => /UPDATE authority_turn_dispatches/.test(q.text)), false)
})
test('expired historical journal without exact active dispatch cannot resurrect a turn', async () => {
  const signer = AuthoritySigner.createEphemeral()
  const { res } = await run(signer, mint(signer).bundle.lease, ORIGINAL + TURN_LEASE_TTL_MS + 1,
    { dispatch: false, matching: true })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error.code, 'TURN_NOT_ACTIVE')
})
test('unexpired legacy Codex inflight journal can bind its first key', async () => {
  const signer = AuthoritySigner.createEphemeral()
  const { res, sql } = await run(signer, mint(signer).bundle.lease, ORIGINAL + 60_000,
    { dispatch: false, bindable: ['codex-1'] })
  assert.equal(res.statusCode, 200)
  assert.ok(sql.some((q) => /UPDATE request_finalize_journal/.test(q.text)))
})
test('terminal/waived/policy/container/model/attempt/fenced states cannot renew', async () => {
  const signer = AuthoritySigner.createEphemeral(); const initial = mint(signer)
  for (const [opts, code] of [
    [{ terminal: true }, 'TURN_FINALIZED'], [{ waived: true }, 'TURN_FINALIZED'],
    [{ epoch: 10n }, 'MODEL_CONFIG_CHANGED'], [{ status: 'terminal' }, 'TURN_NOT_ACTIVE'],
    [{ status: 'rejecting' }, 'TURN_NOT_ACTIVE'], [{ status: 'manual_reconcile' }, 'TURN_NOT_ACTIVE'],
    [{ containerId: 8 }, 'TURN_NOT_ACTIVE'], [{ canonicalModel: 'other' }, 'TURN_NOT_ACTIVE'],
    [{ dispatchAttemptNo: 2 }, 'TURN_NOT_ACTIVE'], [{ fenced: true }, 'TURN_NOT_ACTIVE'],
  ] as const) {
    const { res, sql } = await run(signer, initial.bundle.lease, ORIGINAL + 24 * 60 * 60_000, opts)
    assert.equal(res.statusCode, 409, JSON.stringify(opts))
    assert.equal(res.json().error.code, code, JSON.stringify(opts))
    assert.ok(sql.some((q) => q.text === 'ROLLBACK'))
  }
})
test('wrong signed container and forged expired lease are rejected before SQL', async () => {
  const signer = AuthoritySigner.createEphemeral(); const initial = mint(signer)
  const wrong = await run(signer, signer.signTurnLease({ ...initial.lease, containerId: 8 }),
    ORIGINAL + 24 * 60 * 60_000)
  assert.equal(wrong.res.json().error.code, 'LEASE_IDENTITY_MISMATCH')
  assert.equal(wrong.sql.length, 0)
  const wire = JSON.parse(Buffer.from(initial.bundle.lease, 'base64url').toString())
  wire.payload.uid = 43
  const forged = await run(signer, Buffer.from(JSON.stringify(wire)).toString('base64url'),
    ORIGINAL + 24 * 60 * 60_000)
  assert.equal(forged.res.json().error.code, 'LEASE_INVALID')
  assert.equal(forged.sql.length, 0)
})
test('legacy experimental originalIssuedAt is stripped while current short window rolls', async () => {
  const signer = AuthoritySigner.createEphemeral(); const initial = mint(signer)
  const { res } = await run(signer,
    signer.signTurnLease({ ...initial.lease, originalIssuedAt: ORIGINAL - 60_000 }),
    ORIGINAL + 24 * 60 * 60_000)
  assert.equal(res.statusCode, 200)
  assert.equal(verifyTurnLease(res.json().lease, signer.publicKeyring(),
    ORIGINAL + 24 * 60 * 60_000).originalIssuedAt, undefined)
})
