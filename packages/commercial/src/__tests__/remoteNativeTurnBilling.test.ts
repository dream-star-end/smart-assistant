/** Offline contract tests: real signed authority/catalog/calculator, fake financial I/O.
 * Run through scripts/test-mutex.sh commercial; no model, Redis or production DB calls.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import {
  AUTHORITY_TTL_MS, MODEL_AUTHORITY_VERSION, authoritySigningInput,
  encodeAuthorityEnvelope, encodeTurnLeaseEnvelope, turnLeaseSigningInput,
  type AuthorityKeyring, type ModelAuthorityPayload, type TurnLease,
} from '@openclaude/protocol'
import type { Cc5BridgeBinding } from '@openclaude/gateway/cc5-container-runtime'
import type { Cc5NativeTerminalReceipt } from '@openclaude/gateway/cc5-finance'
import { computeCost } from '../billing/calculator.js'
import {
  ModelCatalogSnapshot, type ModelCatalogCache, type ModelCatalogEntry,
  type ModelCatalogPricing,
} from '../billing/modelCatalog.js'
import type { PreCheckRedis } from '../billing/preCheck.js'
import { SettlementCommitOutcomeUnknownError, type settleUsageAndLedger } from '../billing/proxyBilling.js'
import {
  createRemoteNativeTurnFinance, recoverRemoteNativeTurnBilling,
  REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
  type RemoteNativeFinanceFixtures,
} from '../billing/remoteNativeTurnBilling.js'
import { createLogger } from '../logging/logger.js'

const NOW = 1_760_000_000_000
const MODEL = 'claude-opus-5-5-remote'
const UPSTREAM = 'claude-opus-5-5'
const SESSION = 'agent:main:webchat:dm:new_chat_123'
const OPERATION = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const NATIVE_SESSION = '33333333-3333-4333-8333-333333333333'
const DISPATCH = '44444444-4444-4444-8444-444444444444'
const REQUEST = 'native_request_42'
const TURN = 'b'.repeat(64)
const AUTHORITY_TURN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
const KEY_ID = 'mak1_testkey00000001'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
const KEYS: AuthorityKeyring = new Map([[KEY_ID, new Uint8Array(Buffer.from(jwk.x, 'base64url'))]])
const logger = createLogger({ out: () => undefined })

const ENTRY: ModelCatalogEntry = {
  entryId: 1, modelId: MODEL, engine: 'ccb', providerId: 'remote_pool', placement: 'remote_pool',
  upstreamModelId: UPSTREAM, contextWindow: 200_000,
  capabilityProfile: { supportsVision: true, reasoning: { supported: [], codexModelDefault: null },
    ccb: { capabilityZero: false, supportsThinking: true, contextOwner: 'box-native-v1' } },
  capabilitySchemaVersion: 1, state: 'active', lockVersion: 0,
}
function snapshot(rate = 1n): ModelCatalogSnapshot {
  const price: ModelCatalogPricing = {
    modelId: MODEL, displayName: MODEL, inputPerMtok: 600n * rate,
    outputPerMtok: 2400n * rate, cacheReadPerMtok: 120n * rate,
    cacheWritePerMtok: 750n * rate, multiplier: '1.000', visibility: 'public',
    sortOrder: 100, defaultEffort: null,
  }
  return new ModelCatalogSnapshot({ entries: [ENTRY], aliases: new Map(),
    pricing: new Map([[MODEL, price]]), securityEpoch: 5n })
}
function binding(over: Partial<Cc5BridgeBinding> = {}): Cc5BridgeBinding {
  return { version: 2, backendKind: 'cc5-interactive-v1', canonicalModel: MODEL,
    sessionKey: SESSION, runId: RUN, uid: '42', containerDbId: '7', dockerId: 'a'.repeat(64),
    operationId: OPERATION, capability: 'fixture-only', expiresAt: NOW + 60 * 60_000, ...over }
}
function tickets(s: ModelCatalogSnapshot, over: Partial<ModelAuthorityPayload> = {}) {
  const descriptor = s.resolve(MODEL)!
  const a: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION, keyId: KEY_ID, uid: 42, containerId: 7,
    authorityTurnId: AUTHORITY_TURN, connectionChallenge: 'fixture-challenge',
    canonicalModel: MODEL, engine: 'ccb', executionDescriptor: {
      capabilityProfile: { supportsVision: true,
        reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: true, contextOwner: 'box-native-v1' } },
      capabilitySchemaVersion: 1, contextWindow: descriptor.contextWindow,
      supportsVision: descriptor.capabilityProfile.supportsVision,
      supportedEfforts: [...descriptor.capabilityProfile.reasoning.supported],
    },
    executionBackend: { kind: 'cc5-interactive-v1', sessionKey: SESSION, operationId: OPERATION },
    executionRevision: s.executionRevision, securityEpoch: 5,
    issuedAt: NOW, expiresAt: NOW + AUTHORITY_TTL_MS, billingRequestId: REQUEST, ...over,
  }
  const lease: TurnLease = {
    v: a.v, keyId: a.keyId, uid: a.uid, containerId: a.containerId,
    authorityTurnId: a.authorityTurnId, canonicalModel: a.canonicalModel,
    securityEpoch: a.securityEpoch, connectionChallenge: a.connectionChallenge,
    issuedAt: NOW, expiresAt: NOW + 50 * 60_000,
  }
  return {
    authorityEnvelope: encodeAuthorityEnvelope(a, sign(null, authoritySigningInput(a), privateKey)),
    leaseEnvelope: encodeTurnLeaseEnvelope(lease, sign(null, turnLeaseSigningInput(lease), privateKey)),
  }
}
type LiveReceipt = Extract<Cc5NativeTerminalReceipt, { version: 2 }>
function receipt(over: Partial<LiveReceipt> = {}): LiveReceipt {
  const b = binding()
  return { version: 2, authorityTurnId: AUTHORITY_TURN, turnKey: TURN,
    backendKind: b.backendKind, uid: b.uid, containerDbId: b.containerDbId,
    dockerId: b.dockerId, operationId: b.operationId, runId: b.runId, sessionKey: b.sessionKey,
    nativeSessionId: NATIVE_SESSION, canonicalModel: MODEL, upstreamModel: UPSTREAM,
    resultSha256: 'c'.repeat(64), status: 'success',
    usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 3_000, cacheWriteTokens: 400 }, ...over }
}

type Settlement = Parameters<typeof settleUsageAndLedger>[1]
type Json = Record<string, any>
interface TestTurnIdentity { requestId: string; authorityTurnId: string; turnKey: string; dispatchId: string }
const FIRST_TURN: TestTurnIdentity = { requestId: REQUEST, authorityTurnId: AUTHORITY_TURN, turnKey: TURN, dispatchId: DISPATCH }
const SECOND_TURN: TestTurnIdentity = { requestId: 'native_request_43', authorityTurnId: 'e'.repeat(32),
  turnKey: 'f'.repeat(64), dispatchId: '55555555-5555-4555-8555-555555555555' }
/** This models only persisted rows and CAS outcomes; it does not recalculate money. */
class FinancialStore {
  events: string[] = []
  journal: { state: string; ctx: Json; claim?: string } | undefined
  settled: Settlement | undefined
  dispatchTurn: string | null
  authorityTurn: string | null
  dispatchExists = true
  bindTurnConflict = false
  duplicateJournal = false
  ackLostTag: string | undefined
  stale = false
  proofPatch: Json = {}
  attribution: string | null | undefined
  attributionCost: string | undefined
  attributionLedger: string | null | undefined
  constructor(readonly identity = FIRST_TURN) {
    this.dispatchTurn = identity.turnKey
    this.authorityTurn = identity.turnKey
  }
  result(rows: unknown[] = [], rowCount = rows.length) { return { rows, rowCount } }
  persist(args: Settlement) { this.settled = structuredClone(args) }
  async connect() { return { query: this.query.bind(this), release() {} } }
  async query(sql: string, values: any[] = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return this.result()
    const tag = /remote-native:([a-z-]+)/.exec(sql)?.[1]
    if (tag) this.events.push(tag)
    if (tag === 'dispatch') {
      assert.deepEqual(values, [this.identity.authorityTurnId, '42', this.identity.requestId, '7', MODEL])
      return this.result(this.dispatchExists ? [{ dispatch_id: this.identity.dispatchId, attempt_no: 1,
        session_id: SESSION, turn_key: this.dispatchTurn, authority_turn_key: this.authorityTurn }] : [])
    }
    if (tag === 'bind-turn') {
      assert.deepEqual(values.slice(0, 5), [this.identity.authorityTurnId, '42', this.identity.dispatchId, 1, SESSION])
      if (this.bindTurnConflict || (this.dispatchTurn !== null && this.dispatchTurn !== values[5])
        || (this.authorityTurn !== null && this.authorityTurn !== values[5])) return this.result()
      this.dispatchTurn = values[5]; this.authorityTurn = values[5]
      return this.result([], 1)
    }
    if (sql.includes('INSERT INTO request_finalize_journal')) {
      this.events.push('journal')
      if (this.journal || this.duplicateJournal) return this.result()
      this.journal = { state: 'inflight', ctx: JSON.parse(values[3]) }
      return this.result([], 1)
    }
    const j = this.journal
    if (tag === 'recovery-scan') return this.result(j && j.state !== 'committed' && j.ctx.remoteNative.receipt
      ? [{ request_id: this.identity.requestId, user_id: '42', state: j.state, ctx: structuredClone(j.ctx), updated_at: new Date(NOW) }] : [])
    if (tag === 'readback') {
      if (!j || !this.settled) return this.result()
      const s = this.settled
      return this.result([{ state: j.state, ctx: structuredClone(j.ctx), usage_id: '91', ledger_id: s.costCredits > 0n ? '92' : null,
        cost_credits: s.costCredits.toString(), account_id: s.accountId?.toString() ?? null,
        model: s.model, container_id: '7', session_id: s.sessionId, turn_key: s.turnKey, dispatch_id: s.dispatchId,
        attempt_no: s.attemptNo, status: s.status,
        input_tokens: String(s.usage.input_tokens), output_tokens: String(s.usage.output_tokens),
        cache_read_tokens: String(s.usage.cache_read_tokens), cache_write_tokens: String(s.usage.cache_write_tokens),
        price_snapshot: JSON.parse(s.snapshotJson), execution_revision: s.authority?.executionRevision,
        security_epoch: s.authority?.securityEpoch?.toString(), authority_kind: s.authority?.kind,
        ...this.proofPatch }])
    }
    if (sql.includes('SELECT usage_records.id::text AS id')) {
      return this.result(this.settled ? [{ id: '91', ledger_id: this.attributionLedger === undefined
        ? (this.settled.costCredits > 0n ? '92' : null) : this.attributionLedger,
        cost_credits: this.attributionCost ?? this.settled.costCredits.toString(),
        attribution_credits: this.attribution === undefined ? this.settled.costCredits.toString() : this.attribution }] : [])
    }
    if (tag === 'reserved') {
      if (!j || j.state !== 'inflight' || j.ctx.remoteNative.hostStartAttempted) return this.result()
      j.ctx.remoteNative = JSON.parse(values[3])
      return this.ack(tag)
    }
    if (tag === 'host-start' || tag === 'dispatch-input' || tag === 'receipt') {
      if (!j || j.state !== 'inflight') return this.result()
      const c = j.ctx.remoteNative
      if (tag === 'host-start' && (!c.reserved || c.hostStartAttempted)) return this.result()
      if (tag === 'dispatch-input' && (!c.hostStartAttempted || c.input !== null)) return this.result()
      if (tag === 'receipt' && (!c.hostStartAttempted || c.input === null)) return this.result()
      const path = tag === 'host-start' ? 'hostStartAttempted' : tag === 'dispatch-input' ? 'input' : 'receipt'
      c[path] = JSON.parse(values[4])
      return this.ack(tag)
    }
    if (tag === 'prehost-abort') {
      if (!j || j.state !== 'inflight' || j.ctx.remoteNative.hostStartAttempted || j.ctx.remoteNative.input) return this.result()
      j.state = 'aborted'
      return this.result([], 1)
    }
    if (tag === 'repair') {
      if (!j || !['inflight', 'finalizing'].includes(j.state)) return this.result()
      j.state = 'committed'; Reflect.deleteProperty(j.ctx, 'settlementClaimId')
      return this.result([], 1)
    }
    if (tag === 'reclaim') {
      if (!j || j.state !== 'finalizing' || !this.stale || this.settled) return this.result()
      j.state = 'inflight'; Reflect.deleteProperty(j.ctx, 'settlementClaimId')
      return this.result([], 1)
    }
    if (sql.includes("SET state='finalizing'")) {
      this.events.push('claim')
      if (!j || j.state !== 'inflight') return this.result()
      j.state = 'finalizing'; j.claim = values[1]; j.ctx.settlementClaimId = values[1]
      return this.result([], 1)
    }
    if (sql.includes("SET state='committed'")) {
      this.events.push('finalize')
      if (!j || j.state !== 'finalizing' || j.claim !== values[4]) return this.result()
      j.state = 'committed'; Reflect.deleteProperty(j.ctx, 'settlementClaimId')
      return this.result([], 1)
    }
    throw new Error(`unhandled fixture SQL: ${sql}`)
  }
  private ack(tag: string) {
    if (this.ackLostTag === tag) throw new Error('fixture lost DB acknowledgement')
    return this.result([], 1)
  }
}
function fixture(options: {
  settle?: 'unknown-committed' | 'unknown-unproven'; deny?: boolean; releaseFails?: boolean
  dispatchPool?: Pick<Pool, 'connect'>
  identity?: TestTurnIdentity
} = {}) {
  const store = new FinancialStore(options.identity)
  let catalogSnapshot = snapshot()
  let keyring = KEYS
  let reserveCount = 0
  let releaseCount = 0
  let settleCount = 0
  const settlements: Settlement[] = []
  const redis: PreCheckRedis = {
    async atomicReserve() { throw new Error('unmocked Redis reserve') },
    async releaseReservation() { releaseCount++; return true },
  }
  const fixtures: RemoteNativeFinanceFixtures = {
    async reserve(_redis, input) {
      reserveCount++; store.events.push('reserve')
      assert.equal(input.maxCost, 100n)
      assert.equal(store.journal?.ctx.remoteNativeBillingRecovery, REMOTE_NATIVE_BILLING_RECOVERY_VERSION)
      return { maxCost: input.maxCost, balance: 10_000n, capped: false, originalMaxCost: input.maxCost,
        reservation: { userId: String(input.userId), requestId: input.requestId } }
    },
    async release(_redis, handle) {
      assert.deepEqual(handle, { userId: '42', requestId: store.identity.requestId })
      releaseCount++; store.events.push('release')
      if (options.releaseFails) throw new Error('fixture Redis release unavailable')
      return true
    },
    async settle(_pool, args) {
      settleCount++; store.events.push('settle'); settlements.push(args)
      if (options.settle !== 'unknown-unproven') store.persist(args)
      if (options.settle) throw new SettlementCommitOutcomeUnknownError(args.requestId)
      return { usageId: 91n, ledgerId: args.costCredits > 0n ? 92n : null, clamped: false,
        debitedCredits: args.costCredits, attributionCredits: args.costCredits,
        balanceAfter: 10_000n - args.costCredits, settledCostCredits: args.costCredits }
    },
  }
  const pool = (options.dispatchPool
    ? { query: store.query.bind(store), connect: options.dispatchPool.connect.bind(options.dispatchPool) }
    : store) as unknown as Pool
  const finance = createRemoteNativeTurnFinance({ upstreamModel: UPSTREAM, pool, preCheckRedis: redis,
    catalog: { assertFresh: async () => catalogSnapshot } as unknown as ModelCatalogCache,
    keyring: () => keyring, loadUserModelAuthz: async (uid, epoch) => {
      assert.equal(uid, 42n); assert.equal(epoch, 5n)
      return { uid, role: 'user', grantedModelIds: new Set<string>(),
        deniedModelIds: new Set<string>(options.deny ? [MODEL] : []), userPlanTier: null, orgPlanCode: null }
    }, log: logger, now: () => NOW }, fixtures)
  const admit = (over: Partial<Parameters<typeof finance.admit>[0]> = {}, authority: Partial<ModelAuthorityPayload> = {}) =>
    finance.admit({ binding: binding(), ...tickets(catalogSnapshot, {
      authorityTurnId: store.identity.authorityTurnId, billingRequestId: store.identity.requestId, ...authority }),
      turnKey: store.identity.turnKey, sessionKey: SESSION, ...over })
  return { store, finance, admit, pool, redis, fixtures, settlements,
    counts: () => ({ reserve: reserveCount, release: releaseCount, settle: settleCount }),
    setCatalog: (s: ModelCatalogSnapshot) => { catalogSnapshot = s },
    setKeys: (keys: AuthorityKeyring) => { keyring = keys } }
}
async function started(f = fixture()) {
  const turn = await f.admit()
  await turn.beforeHostStart()
  await turn.beforeDispatch({ sequence: 1, inputSha256: 'd'.repeat(64) })
  return { f, turn }
}

function continuedFixture(first: Parameters<typeof fixture>[0] = {}) {
  const turns = [fixture(first), fixture({ identity: SECOND_TURN })]
  const queries: string[] = []
  const byRequest = (requestId: string) => {
    const f = turns.find((item) => item.store.identity.requestId === requestId)
    assert.ok(f, `unknown fixture request ${requestId}`)
    return f
  }
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql)
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return turns[0].store.result()
    const f = turns.find((item) => values.includes(item.store.identity.requestId)
      || values.includes(item.store.identity.authorityTurnId))
    assert.ok(f, 'query must address one exact fixture turn')
    return f.store.query(sql, values)
  }
  const pool = { query, async connect() { return { query, release() {} } } } as unknown as Pool
  const finance = createRemoteNativeTurnFinance({ upstreamModel: UPSTREAM, pool, preCheckRedis: turns[0].redis,
    catalog: { assertFresh: async () => snapshot() } as unknown as ModelCatalogCache,
    keyring: KEYS, loadUserModelAuthz: async (uid) => ({ uid, role: 'user',
      grantedModelIds: new Set<string>(), deniedModelIds: new Set<string>(), userPlanTier: null, orgPlanCode: null }),
    log: logger, now: () => NOW }, {
    reserve: (redis, input) => byRequest(input.requestId).fixtures.reserve!(redis, input),
    release: (redis, handle) => byRequest(handle.requestId).fixtures.release!(redis, handle),
    settle: (db, args) => byRequest(args.requestId).fixtures.settle!(db, args),
  })
  const admit = (index: number, over: Partial<Parameters<typeof finance.admit>[0]> = {},
    authority: Partial<ModelAuthorityPayload> = {}) => {
    const identity = turns[index].store.identity
    return finance.admit({ binding: binding(), sessionKey: SESSION, turnKey: identity.turnKey,
      ...tickets(snapshot(), { authorityTurnId: identity.authorityTurnId,
        billingRequestId: identity.requestId, ...authority }), ...over })
  }
  const result = (index: number) => {
    const identity = turns[index].store.identity
    return receipt({ authorityTurnId: identity.authorityTurnId, turnKey: identity.turnKey,
      resultSha256: (index ? 'e' : 'c').repeat(64),
      usage: { ...receipt().usage, outputTokens: 2_000 + index } })
  }
  const start = async (index: number, sequence: number) => {
    const turn = await admit(index)
    await turn.beforeHostStart()
    await turn.beforeDispatch({ sequence, inputSha256: 'd'.repeat(64) })
    return turn
  }
  return { turns, admit, result, start, queries }
}

test('one stable Worker binding settles two sequential signed turns independently', async () => {
  const f = continuedFixture()
  const first = await f.start(0, 1)
  assert.equal((await first.terminal(f.result(0))).state, 'proven')
  const second = await f.start(1, 4)
  assert.equal((await second.terminal(f.result(1))).state, 'proven')
  assert.deepEqual(f.turns.map((turn) => turn.counts()), [
    { reserve: 1, release: 1, settle: 1 }, { reserve: 1, release: 1, settle: 1 },
  ])
  const settlements = f.turns.map((turn) => turn.settlements[0])
  assert.deepEqual(settlements.map((s) => s.requestId), [REQUEST, SECOND_TURN.requestId])
  assert.deepEqual(settlements.map((s) => s.turnKey), [TURN, SECOND_TURN.turnKey])
  assert.deepEqual(settlements.map((s) => s.dispatchId), [DISPATCH, SECOND_TURN.dispatchId])
  assert.deepEqual(settlements.map((s) => s.usage.output_tokens), [2_000, 2_001])
  assert.deepEqual(f.turns.map((turn) => turn.store.journal?.ctx.remoteNative.scope.operationId), [OPERATION, OPERATION])
  assert.deepEqual(f.turns.map((turn) => turn.store.journal?.ctx.remoteNative.input.sequence), [1, 4])
  assert.equal(JSON.parse(settlements[1].snapshotJson).remote_native.authorityTurnId, SECOND_TURN.authorityTurnId)
})

test('an active or financially unknown turn never admits the next signed turn', async () => {
  for (const pending of [false, true]) {
    const f = continuedFixture(pending ? { settle: 'unknown-unproven' } : {})
    const first = await f.start(0, 1)
    await assert.rejects(f.admit(1))
    assert.deepEqual(f.turns[1].counts(), { reserve: 0, release: 0, settle: 0 })
    if (pending) {
      assert.equal((await first.terminal(f.result(0))).state, 'pending')
      await assert.rejects(f.admit(1))
      assert.equal((await first.terminal(f.result(0))).state, 'pending')
      assert.equal(f.turns[0].counts().settle, 1)
    } else {
      await first.terminal(f.result(0))
      const second = await f.start(1, 2)
      assert.equal((await second.terminal(f.result(1))).state, 'proven')
    }
  }
})

test('completed authority, billing request and logical turn identities cannot be reused', async () => {
  for (const kind of ['authority', 'request', 'turn'] as const) {
    const f = continuedFixture()
    const first = await f.start(0, 1)
    await first.terminal(f.result(0))
    const before = f.queries.length
    await assert.rejects(f.admit(1, kind === 'turn' ? { turnKey: TURN } : {},
      kind === 'authority' ? { authorityTurnId: AUTHORITY_TURN }
        : kind === 'request' ? { billingRequestId: REQUEST } : {}), kind)
    assert.equal(f.turns[1].store.journal, undefined, kind)
    assert.equal(f.turns[1].counts().reserve, 0, kind)
    assert.equal(f.queries.length, before, kind)
  }
})

test('cross-turn or legacy receipts cannot settle a live continued turn', async () => {
  const f = continuedFixture()
  const first = await f.start(0, 1)
  for (const bad of [f.result(1), receipt({ authorityTurnId: SECOND_TURN.authorityTurnId }),
    receipt({ turnKey: SECOND_TURN.turnKey })]) assert.throws(() => first.terminal(bad))
  const { authorityTurnId: _authority, turnKey: _turn, ...legacy } = receipt()
  assert.throws(() => first.terminal({ ...legacy, version: 1 }))
  assert.equal(f.turns[0].counts().settle, 0)
  await first.terminal(f.result(0))
  const second = await f.start(1, 2)
  assert.throws(() => second.terminal(f.result(0)))
  assert.equal(f.turns[1].counts().settle, 0)
  await second.terminal(f.result(1))
})

test('every turn needs a fresh effect marker and one safe positive input sequence', async () => {
  const f = fixture()
  const turn = await f.admit()
  await assert.rejects(turn.beforeDispatch({ sequence: 3, inputSha256: 'd'.repeat(64) }))
  await turn.beforeHostStart()
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    await assert.rejects(turn.beforeDispatch({ sequence, inputSha256: 'd'.repeat(64) }))
  }
  await turn.beforeDispatch({ sequence: 3, inputSha256: 'd'.repeat(64) })
  await assert.rejects(turn.beforeDispatch({ sequence: 4, inputSha256: 'e'.repeat(64) }))
  assert.equal((await turn.terminal(receipt())).state, 'proven')
  assert.equal(f.store.journal?.ctx.remoteNative.input.sequence, 3)
})

test('a proven pre-effect cancellation releases only its own active turn', async () => {
  const f = continuedFixture()
  const first = await f.admit(0)
  await first.stop({ hostStartAttempted: false, userSubmitted: false, remoteStopped: true })
  const second = await f.start(1, 2)
  // Repeating an old Stop cannot release the next turn's operation fence.
  await first.stop({ hostStartAttempted: false, userSubmitted: false, remoteStopped: true })
  const before = f.queries.length
  await assert.rejects(f.admit(1, { turnKey: 'a'.repeat(64) },
    { authorityTurnId: '1'.repeat(32), billingRequestId: 'third_native_request' }))
  assert.equal(f.queries.length, before)
  assert.equal((await second.terminal(f.result(1))).state, 'proven')
})

test('signed existing Sonnet admission persists reservation and effects before terminal settlement', async () => {
  const f = fixture()
  const turn = await f.admit()
  assert.deepEqual(f.store.events, ['dispatch', 'bind-turn', 'journal', 'reserve', 'reserved'])
  await assert.rejects(turn.beforeDispatch({ sequence: 1, inputSha256: 'd'.repeat(64) }))
  await turn.beforeHostStart()
  assert.equal(f.store.journal?.ctx.remoteNative.hostStartAttempted, true)
  await turn.beforeDispatch({ sequence: 1, inputSha256: 'd'.repeat(64) })
  assert.deepEqual(f.store.journal?.ctx.remoteNative.input, { sequence: 1, inputSha256: 'd'.repeat(64) })
  assert.deepEqual(await turn.terminal(receipt()), { state: 'proven', requestId: REQUEST })
  assert.equal(f.store.journal?.state, 'committed')
  assert.deepEqual(f.counts(), { reserve: 1, release: 1, settle: 1 })
  const s = f.settlements[0]
  assert.equal(s.accountId, null)
  assert.equal(s.model, MODEL)
  assert.equal(s.dispatchId, DISPATCH)
  assert.equal(s.turnKey, TURN)
  assert.equal(s.authority?.kind, 'bridge_signed')
  assert.equal(s.costCredits, computeCost(s.usage, snapshot().billingPricingFor(MODEL)!).cost_credits)
  assert.ok(f.store.events.indexOf('receipt') < f.store.events.indexOf('settle'))
  assert.ok(f.store.events.indexOf('readback', f.store.events.indexOf('settle')) < f.store.events.indexOf('release'))
})

for (const [name, override] of [
  ['uid', { uid: '43' }], ['session', { sessionKey: 'agent:main:webchat:dm:other_chat_123' }],
  ['operation', { operationId: RUN }], ['container', { containerDbId: '8' }],
] as const) test(`valid signature cannot be reused across ${name}`, async () => {
  const f = fixture()
  await assert.rejects(f.admit({ binding: binding(override) }))
  assert.deepEqual(f.counts(), { reserve: 0, release: 0, settle: 0 })
})
test('current grants, rotated public keys and durable dispatch binding fail before reserving', async () => {
  for (const kind of ['denied', 'keys', 'dispatch', 'duplicate'] as const) {
    const f = fixture({ deny: kind === 'denied' })
    if (kind === 'keys') f.setKeys(new Map())
    if (kind === 'dispatch') f.store.dispatchTurn = 'e'.repeat(64)
    if (kind === 'duplicate') f.store.duplicateJournal = true
    await assert.rejects(f.admit(), kind)
    assert.equal(f.counts().reserve, 0, kind)
  }
})
test('first gateway turn binds both previously NULL dispatch locators before reserving', async () => {
  for (const partial of [false, true]) {
    const f = fixture()
    f.store.dispatchTurn = null
    f.store.authorityTurn = partial ? TURN : null
    await f.admit()
    assert.equal(f.store.dispatchTurn, TURN)
    assert.equal(f.store.authorityTurn, TURN)
    assert.ok(f.store.events.indexOf('bind-turn') < f.store.events.indexOf('reserve'))
  }
})
test('conflicting authority locator or a lost binding CAS prevents journal/reservation/effect', async () => {
  for (const conflict of ['authority', 'cas'] as const) {
    const f = fixture()
    if (conflict === 'authority') f.store.authorityTurn = 'e'.repeat(64)
    else { f.store.dispatchTurn = null; f.store.authorityTurn = null; f.store.bindTurnConflict = true }
    await assert.rejects(f.admit())
    assert.equal(f.store.journal, undefined)
    assert.equal(f.counts().reserve, 0)
  }
})
test('a lost reservation acknowledgement closes only its owned pre-host journal', async () => {
  const f = fixture()
  f.store.ackLostTag = 'reserved'
  await assert.rejects(f.admit())
  assert.equal(f.store.journal?.state, 'aborted')
  assert.deepEqual(f.counts(), { reserve: 1, release: 1, settle: 0 })
})
test('host-start lost acknowledgement forbids a second start or caller-driven abort', async () => {
  const f = fixture()
  const turn = await f.admit()
  f.store.ackLostTag = 'host-start'
  await assert.rejects(turn.beforeHostStart())
  assert.equal(f.store.journal?.ctx.remoteNative.hostStartAttempted, true)
  await assert.rejects(turn.beforeHostStart())
  await turn.stop({ hostStartAttempted: false, userSubmitted: false, remoteStopped: true })
  assert.equal(f.store.journal?.state, 'inflight')
  assert.equal(f.counts().release, 0)
})
test('terminal charges the admission price after another catalog snapshot replaces the cache', async () => {
  const f = fixture()
  const turn = await f.admit()
  const frozen = snapshot().billingPricingFor(MODEL)!
  f.setCatalog(snapshot(100n))
  await turn.beforeHostStart()
  await turn.beforeDispatch({ sequence: 1, inputSha256: 'd'.repeat(64) })
  assert.equal((await turn.terminal(receipt())).state, 'proven')
  const s = f.settlements[0]
  assert.equal(s.costCredits, computeCost(s.usage, frozen).cost_credits)
  assert.equal(JSON.parse(s.snapshotJson).input_per_mtok, '600')
})
test('native receipt rejects malformed scope, hashes and each unsafe token shape without settlement', async () => {
  const { f, turn } = await started()
  const invalid = [receipt({ uid: '43' }), receipt({ operationId: RUN }), receipt({ runId: OPERATION }),
    receipt({ sessionKey: 'agent:main:webchat:dm:other_chat_123' }),
    receipt({ resultSha256: 'bad' }), receipt({ nativeSessionId: 'other' }), receipt({ upstreamModel: MODEL }),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN].map((v) => receipt({ usage: { ...receipt().usage, inputTokens: v } })),
    { ...receipt(), unexpected: true }, { ...receipt(), usage: { ...receipt().usage, totalCost: 0 } }]
  for (const r of invalid) assert.throws(() => turn.terminal(r as Cc5NativeTerminalReceipt))
  assert.equal(f.counts().settle, 0)
  assert.equal(f.store.journal?.ctx.remoteNative.receipt, null)
})
test('same terminal is idempotent; conflicting result bytes or usage are rejected', async () => {
  const { f, turn } = await started()
  const original = receipt()
  const first = turn.terminal(original)
  assert.equal(turn.terminal(structuredClone(original)), first)
  await first
  assert.throws(() => turn.terminal(receipt({ resultSha256: 'e'.repeat(64) })))
  assert.throws(() => turn.terminal(receipt({ usage: { ...original.usage, outputTokens: 3_000 } })))
  assert.equal(f.counts().settle, 1)
})
test('unknown COMMIT delivers only after complete usage and attribution readback, without resettling', async () => {
  const { f, turn } = await started(fixture({ settle: 'unknown-committed' }))
  assert.deepEqual(await turn.terminal(receipt()), { state: 'proven', requestId: REQUEST })
  assert.equal(f.store.journal?.state, 'committed')
  assert.equal(f.counts().settle, 1)
  assert.ok(f.store.events.includes('repair'))
})
test('Redis release failure cannot turn proven committed settlement into a pending terminal', async () => {
  const { f, turn } = await started(fixture({ releaseFails: true }))
  const r = receipt()
  const first = turn.terminal(r)
  assert.deepEqual(await first, { state: 'proven', requestId: REQUEST })
  assert.equal(turn.terminal(structuredClone(r)), first)
  assert.deepEqual(await turn.terminal(r), { state: 'proven', requestId: REQUEST })
  assert.equal(f.store.journal?.state, 'committed')
  assert.equal(f.counts().settle, 1)
  assert.ok(f.counts().release >= 1)
})
test('unproven COMMIT retains reservation/journal and replays neither input nor settlement', async () => {
  const { f, turn } = await started(fixture({ settle: 'unknown-unproven' }))
  const r = receipt()
  assert.deepEqual(await turn.terminal(r), { state: 'pending' })
  assert.deepEqual(await turn.terminal(r), { state: 'pending' })
  assert.equal(f.store.journal?.state, 'finalizing')
  assert.deepEqual(f.counts(), { reserve: 1, release: 0, settle: 1 })
  assert.deepEqual(await recoverRemoteNativeTurnBilling({ pool: f.pool, preCheckRedis: f.redis, log: logger },
    { settle: f.fixtures.settle }), { proven: 0, pending: 1 })
  assert.equal(f.counts().settle, 1)
  await assert.rejects(turn.beforeDispatch({ sequence: 1, inputSha256: 'd'.repeat(64) }))
})
for (const [name, patch] of [
  ['tokens', { output_tokens: '999' }], ['account', { account_id: '123' }],
  ['dispatch', { dispatch_id: RUN }], ['price', { price_snapshot: {} }],
  ['session', { session_id: 'another-session' }],
] as const) test(`readback with conflicting ${name} cannot prove delivery`, async () => {
  const { f, turn } = await started()
  f.store.proofPatch = patch
  assert.deepEqual(await turn.terminal(receipt()), { state: 'pending' })
  assert.equal(f.counts().release, 0)
  assert.equal(f.counts().settle, 1)
})
test('usage without a persisted debit attribution remains pending', async () => {
  const { f, turn } = await started()
  f.store.attribution = null
  assert.deepEqual(await turn.terminal(receipt()), { state: 'pending' })
  assert.equal(f.counts().release, 0)
})
test('matching rows with an incorrect nominal cost or positive debit without a ledger cannot prove delivery', async () => {
  for (const kind of ['cost', 'ledger', 'negative-attribution', 'excess-attribution'] as const) {
    const { f, turn } = await started()
    if (kind === 'cost') {
      f.store.proofPatch.cost_credits = '999'
      f.store.attributionCost = '999'
    } else if (kind === 'ledger') {
      f.store.proofPatch.ledger_id = null
      f.store.attributionLedger = null
    } else f.store.attribution = kind === 'negative-attribution' ? '-1' : '999'
    assert.deepEqual(await turn.terminal(receipt()), { state: 'pending' }, kind)
    assert.equal(f.counts().release, 0, kind)
  }
})
test('existing clamp semantics allow a proven debit smaller than nominal cost', async () => {
  const { f, turn } = await started()
  f.store.attribution = '3'
  assert.equal((await turn.terminal(receipt())).state, 'proven')
  assert.equal(f.counts().release, 1)
})
test('native error and successful no-output receipts preserve usage without charging', async () => {
  for (const r of [receipt({ status: 'error' }), receipt({ usage: { ...receipt().usage, outputTokens: 0 } })]) {
    const { f, turn } = await started()
    assert.equal((await turn.terminal(r)).state, 'proven')
    assert.equal(f.settlements[0].costCredits, 0n)
    assert.equal(f.settlements[0].usage.input_tokens, r.usage.inputTokens)
  }
})
test('only a proven pre-host stop releases a reservation; started host cannot be erased by false flags', async () => {
  for (const mode of ['prehost', 'unproven-stop', 'host-started'] as const) {
    const f = fixture()
    const turn = await f.admit()
    if (mode === 'host-started') await turn.beforeHostStart()
    await turn.stop({ hostStartAttempted: false, userSubmitted: false, remoteStopped: mode !== 'unproven-stop' })
    assert.equal(f.store.journal?.state, mode === 'prehost' ? 'aborted' : 'inflight')
    assert.equal(f.counts().release, mode === 'prehost' ? 1 : 0)
  }
})
test('durable receipt with lost acknowledgement recovers financially without any new worker effect', async () => {
  const { f, turn } = await started()
  f.store.ackLostTag = 'receipt'
  assert.deepEqual(await turn.terminal(receipt()), { state: 'pending' })
  assert.equal(f.counts().settle, 0)
  assert.deepEqual(await recoverRemoteNativeTurnBilling({ pool: f.pool, preCheckRedis: f.redis, log: logger },
    { settle: f.fixtures.settle }), { proven: 1, pending: 0 })
  assert.equal(f.counts().settle, 1)
  assert.equal(f.store.events.filter((event) => event === 'host-start').length, 1)
  assert.equal(f.store.events.filter((event) => event === 'dispatch-input').length, 1)
})

test('persisted legacy v1 receipts remain recoverable without enabling live v1 delivery', async () => {
  const { f, turn } = await started()
  f.store.ackLostTag = 'receipt'
  assert.equal((await turn.terminal(receipt())).state, 'pending')
  // Represent the exact historical v1 context saved before this upgrade.
  const { authorityTurnId: _authority, turnKey: _turn, ...legacy } = receipt()
  f.store.journal!.ctx.remoteNative.receipt = { ...legacy, version: 1 }
  assert.deepEqual(await recoverRemoteNativeTurnBilling({ pool: f.pool, preCheckRedis: f.redis, log: logger },
    { settle: f.fixtures.settle }), { proven: 1, pending: 0 })
  assert.equal(f.counts().settle, 1)
  const stamp = JSON.parse(f.settlements[0].snapshotJson).remote_native
  assert.equal(stamp.version, 1)
  assert.equal('authorityTurnId' in stamp, false)
  assert.equal('turnKey' in stamp, false)
})

test('a journal written before remote lanes (pinned Sonnet, no upstream in scope) still settles on recovery', async () => {
  for (const [canonicalModel, expected] of [
    ['box-claude-sonnet-5', { proven: 1, pending: 0 }],
    ['claude-opus-5-5-remote', { proven: 0, pending: 1 }], // A lane journal always names its upstream.
  ] as const) {
    const { f, turn } = await started()
    f.store.ackLostTag = 'receipt'
    assert.equal((await turn.terminal(receipt())).state, 'pending')
    const ctx = f.store.journal!.ctx.remoteNative
    delete ctx.scope.upstreamModel
    ctx.scope.canonicalModel = canonicalModel
    ctx.pricing.modelId = canonicalModel
    ctx.receipt = { ...ctx.receipt, canonicalModel, upstreamModel: 'claude-sonnet-5' }
    const persisted = JSON.stringify(ctx)
    assert.deepEqual(await recoverRemoteNativeTurnBilling({ pool: f.pool, preCheckRedis: f.redis, log: logger },
      { settle: f.fixtures.settle }), expected, canonicalModel)
    assert.equal(f.counts().settle, expected.proven)
    if (expected.proven) assert.equal(f.settlements[0].model, 'box-claude-sonnet-5')
    assert.equal(JSON.stringify(f.store.journal!.ctx.remoteNative), persisted, 'the stored context is not rewritten')
  }
})

const PG_REQUIRED = process.env.REQUIRE_TEST_DB === '1' || process.env.CI === 'true'
const PG_TEST_URL = process.env.NATIVE_FINANCE_TEST_DATABASE_URL
  || (PG_REQUIRED ? process.env.TEST_DATABASE_URL : undefined)
test('isolated PG: concurrent first-turn binding locks both rows and admits exactly one turnKey',
  { skip: !PG_REQUIRED && !PG_TEST_URL }, async () => {
    // CI/required runs may share the explicitly provided isolated test fixture;
    // never infer a connection from production/default PG environment variables.
    assert.ok(PG_TEST_URL, 'explicit PostgreSQL test URL required when CI or REQUIRE_TEST_DB is set')
    const target = new URL(PG_TEST_URL)
    assert.ok(['postgres:', 'postgresql:'].includes(target.protocol), 'explicit PostgreSQL test URL required')
    assert.ok(decodeURIComponent(target.pathname.slice(1)).endsWith('_test'), 'database name must end in _test')
    const schema = `native_finance_${process.pid}_${randomBytes(6).toString('hex')}`
    const real = new Pool({ connectionString: PG_TEST_URL, max: 3,
      application_name: 'remote-native-finance-isolated-test' })
    let created = false
    try {
      await real.query(`CREATE SCHEMA ${schema}`)
      created = true
      await real.query(`CREATE TABLE ${schema}.turn_dispatches (
        dispatch_id UUID PRIMARY KEY,user_id BIGINT NOT NULL,billing_request_id TEXT NOT NULL,
        agent_container_id BIGINT NOT NULL,model TEXT NOT NULL,attempt_no INTEGER NOT NULL,
        session_id TEXT NOT NULL,status TEXT NOT NULL,turn_key TEXT,
        terminal_at TIMESTAMPTZ,producer_fenced_at TIMESTAMPTZ
      )`)
      await real.query(`CREATE TABLE ${schema}.authority_turn_dispatches (
        authority_turn_id TEXT PRIMARY KEY,user_id BIGINT NOT NULL,dispatch_id UUID NOT NULL,
        canonical_model TEXT NOT NULL,attempt_no INTEGER NOT NULL,session_id TEXT NOT NULL,turn_key TEXT
      )`)
      await real.query(`INSERT INTO ${schema}.turn_dispatches
        (dispatch_id,user_id,billing_request_id,agent_container_id,model,attempt_no,session_id,status)
        VALUES ($1,42,$2,7,$3,1,$4,'admitted')`, [DISPATCH, REQUEST, MODEL, SESSION])
      await real.query(`INSERT INTO ${schema}.authority_turn_dispatches
        (authority_turn_id,user_id,dispatch_id,canonical_model,attempt_no,session_id)
        VALUES ($1,42,$2,$3,1,$4)`, ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', DISPATCH, MODEL, SESSION])
      const dispatchPool = {
        async connect() {
          const client = await real.connect()
          try { await client.query(`SET search_path TO ${schema}`); return client }
          catch (error) { client.release(); throw error }
        },
      } as Pick<Pool, 'connect'>
      const contenders = [fixture({ dispatchPool }), fixture({ dispatchPool })]
      const turnKeys = [TURN, 'd'.repeat(64)]
      const attempts = await Promise.allSettled(contenders.map((f, i) => f.admit({ turnKey: turnKeys[i] })))
      const winners = attempts.flatMap((result, i) => result.status === 'fulfilled' ? [i] : [])
      assert.equal(winners.length, 1)
      const winner = winners[0]
      const loser = winner === 0 ? 1 : 0
      assert.equal(attempts[loser].status, 'rejected')
      assert.deepEqual(contenders[winner].counts(), { reserve: 1, release: 0, settle: 0 })
      assert.deepEqual(contenders[loser].counts(), { reserve: 0, release: 0, settle: 0 })
      assert.equal(contenders[loser].store.journal, undefined)
      const row = (await real.query(`SELECT d.turn_key AS dispatch_turn,a.turn_key AS authority_turn
        FROM ${schema}.turn_dispatches d JOIN ${schema}.authority_turn_dispatches a
        ON a.dispatch_id=d.dispatch_id WHERE d.dispatch_id=$1`, [DISPATCH])).rows[0]
      assert.deepEqual(row, { dispatch_turn: turnKeys[winner], authority_turn: turnKeys[winner] })
    } finally {
      try { if (created) await real.query(`DROP SCHEMA ${schema} CASCADE`) }
      finally { await real.end() }
    }
  })
