import { createHash } from 'node:crypto'
import { LOSSLESS_TURN_TAPE_VERSION } from '@openclaude/protocol'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'
/**
 * readSwitchContext 真 PG 集成测试 —— 首轮零 token 崩溃后的"同模型继续不误弹费用确认"。
 *
 * 单测（modelSwitchCostContext.test.ts）用 fake pool 锁调用契约；本套件锁的是真
 * SQL 行为：JSONB 计数是否为"明确数字 0"、全会话 NOT EXISTS 否决、子卷/continuation、
 * 6 条 tape 窗口外的旧成功记录、以及报价后历史变化必须让免确认失效。
 *
 * 失败即回归：把 modelSwitchCostFailedStart.ts 的调用撤掉，T1 会从 'unchanged'
 * 变回 'unknown'，其余反例用例应当仍然保持 'unknown'。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createPool, closePool, setPoolOverride, resetPool, getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { runMigrations } from '../db/migrate.js'
import { readSwitchContext } from '../billing/modelSwitchCostContext.js'
import { ModelSwitchCostService } from '../billing/modelSwitchCost.js'
import { PricingCache, type ModelPricing } from '../billing/pricing.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
let ready = false

function assertTestDatabase(url: string): void {
  let dbName: string
  try {
    dbName = new URL(url).pathname.replace(/^\//, '')
  } catch {
    throw new Error(`invalid TEST_DATABASE_URL: ${url}`)
  }
  if (!dbName.endsWith('_test'))
    throw new Error(`refusing to reset non-test database: ${dbName} (must end with _test)`)
}

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* ignore */
    }
    return false
  }
}

before(async () => {
  ready = await probe()
  if (!ready) {
    if (REQUIRE_TEST_DB)
      throw new Error(
        'Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). ' +
          'See packages/commercial/README.md for bootstrap.',
      )
    return
  }
  await resetPool()
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 })
  setPoolOverride(pool)
  assertTestDatabase(TEST_DB_URL)
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await query('GRANT ALL ON SCHEMA public TO public')
  await runMigrations()
})

after(async () => {
  if (ready) await closePool()
})

const HEX = (c: string) => c.repeat(64)
const hex = (n: number) => n.toString(16).padStart(64, '0')
const ZERO_USAGE = (model: string) =>
  JSON.stringify({
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  })

async function makeSession(uid: string, sid: string, messages: unknown[]): Promise<void> {
  await query(
    `INSERT INTO client_sessions (id,user_id,agent_id,title,created_at,last_at,messages,message_count,updated_at)
     VALUES ($1,$2,'main','t',1,1,$3,$4,1)`,
    [sid, `c:${uid}`, JSON.stringify(messages), messages.length],
  )
}

async function addTape(input: {
  uid: string
  sid: string
  tapeId: string
  status?: 'completed' | 'interrupted' | 'crashed'
  usage: string
  createdAt: number
  finalizedAt: number | null
  clientMessageId?: string | null
  parentTurnKey?: string | null
  continuationOf?: string | null
  turnIndex?: number
}): Promise<void> {
  await query(
    `INSERT INTO client_session_turn_tapes
       (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,parent_turn_key,
        continuation_of_turn_key,tape_sha256,total_bytes,part_count,usage,created_at,finalized_at,
        client_message_id)
     VALUES ($1,$2,$3,'main',$4,$5,$6,$7,$8,$9,0,1,$10,$11,$12,$13)`,
    [
      input.sid,
      `c:${input.uid}`,
      input.tapeId,
      input.turnIndex ?? 0,
      input.status ?? 'crashed',
      hex(input.createdAt),
      input.parentTurnKey ?? null,
      input.continuationOf ?? null,
      HEX('b'),
      input.usage,
      input.createdAt,
      input.finalizedAt,
      input.clientMessageId ?? null,
    ],
  )
}

async function addDispatch(input: {
  uid: string
  sid: string
  clientMessageId: string
  model: string
  agent?: string
  status?: string
  outcome?: string | null
  accepted?: boolean
}): Promise<string> {
  const res = await query<{ dispatch_id: string }>(
    `INSERT INTO turn_dispatches
       (dispatch_id,user_id,session_id,client_message_id,agent_id,model,request_hash,
        billing_request_id,status,outcome,admitted_at,accepted_at,terminal_at)
     VALUES (gen_random_uuid(),$1::bigint,$2,$3,$4,$5,'h',$6,$7,$8,now(),$9,now())
     RETURNING dispatch_id::text AS dispatch_id`,
    [
      input.uid,
      input.sid,
      input.clientMessageId,
      input.agent ?? 'main',
      input.model,
      `br-${input.uid}-${input.sid}-${input.clientMessageId}`,
      input.status ?? 'terminal',
      input.outcome === undefined ? 'crashed' : input.outcome,
      input.accepted === false ? null : new Date(),
    ],
  )
  return res.rows[0]!.dispatch_id
}

const ANCHOR = { id: 'anchor', role: 'assistant', _source: 'server', _turnTapeId: 'tape-1', _turnTapeSha256: HEX('b'), _turnTapeComplete: true }

/** The exact shape a first turn that crashed at zero tokens leaves behind. */
async function seedFailedFirstTurn(uid: string, sid: string, requestId = 'req-next') {
  await makeSession(uid, sid, [
    { role: 'user', id: 'msg-1' },
    ANCHOR,
    { role: 'user', id: requestId },
  ])
  await addTape({
    uid,
    sid,
    tapeId: 'tape-1',
    usage: ZERO_USAGE('cheap'),
    createdAt: 1,
    finalizedAt: 2,
    clientMessageId: 'msg-1',
  })
  const dispatchId = await addDispatch({ uid, sid, clientMessageId: 'msg-1', model: 'cheap' })
  await query('UPDATE client_session_turn_tapes SET dispatch_id=$2::uuid,attempt_no=1 WHERE session_id=$1 AND tape_id=$3', [sid, dispatchId, 'tape-1'])
}

const context = (uid: string, sid: string, targetModel: string, requestId = 'req-next') =>
  readSwitchContext({ query } as never, uid, sid, requestId, {
    targetModel,
    targetAgent: 'main',
  })

test('same model continues the failed first turn without a switch quote', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  await seedFailedFirstTurn('901', 's-ok')
  const ctx = await context('901', 's-ok', 'cheap')
  assert.equal(ctx.source, 'unchanged')
  assert.equal(ctx.sourceModel, 'cheap')
  assert.equal(ctx.sourceAgent, 'main')
  assert.equal(ctx.tokens, null)
})

test('a real model change after the failed first turn stays risk, never empty', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  await seedFailedFirstTurn('902', 's-switch')
  const ctx = await context('902', 's-switch', 'expensive')
  assert.equal(ctx.source, 'unknown')
  assert.equal(ctx.sourceModel, null)
  assert.equal(ctx.tokens, null)
})

test('missing or non-numeric counters are never read as zero', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  await makeSession('903', 's-missing', [{ role: 'user', id: 'msg-1' }])
  const usages = [
    JSON.stringify({ model: 'cheap' }),
    JSON.stringify({ model: 'cheap', inputTokens: '0', outputTokens: 0 }),
    JSON.stringify({ model: 'cheap', inputTokens: null, outputTokens: 0 }),
    JSON.stringify({ model: 'cheap', inputTokens: -1, outputTokens: 0 }),
  ]
  for (const [index, usage] of usages.entries()) {
    const sid = `s-missing-${index}`
    await makeSession('903', sid, [{ role: 'user', id: 'msg-1' }])
    await addTape({
      uid: '903',
      sid,
      tapeId: 'tape-1',
      usage,
      createdAt: 1,
      finalizedAt: 2,
      clientMessageId: 'msg-1',
    })
    await addDispatch({ uid: '903', sid, clientMessageId: 'msg-1', model: 'cheap' })
    const ctx = await context('903', sid, 'cheap')
    assert.equal(ctx.source, 'unknown', `usage ${index} must not be treated as zero`)
    assert.equal(ctx.sourceModel, null)
  }
})

test('a turn executed after the quote withdraws the exemption', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  await seedFailedFirstTurn('904', 's-after')
  const quoted = await context('904', 's-after', 'cheap')
  assert.equal(quoted.source, 'unchanged')
  // Between the quote and the click the session really ran a turn on another
  // model. The signed quote carries fingerprint/revision, so it can no longer
  // match; the recomputed context must be risk rather than a remembered exemption.
  await addTape({
    uid: '904',
    sid: 's-after',
    tapeId: 'tape-2',
    status: 'completed',
    usage: JSON.stringify({
      model: 'expensive',
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }),
    createdAt: 3,
    finalizedAt: 4,
    clientMessageId: 'msg-1',
    turnIndex: 1,
  })
  const ctx = await context('904', 's-after', 'cheap')
  assert.notEqual(ctx.fingerprint, quoted.fingerprint)
  assert.equal(ctx.source, 'unknown')
  assert.equal(ctx.sourceModel, 'expensive')
  assert.equal(ctx.tokens, null)
})

test('child and continuation tapes veto the failed-start proof', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  for (const [index, kind] of ['parent', 'continuation'].entries()) {
    const sid = `s-child-${index}`
    await seedFailedFirstTurn('905', sid)
    await addTape({
      uid: '905',
      sid,
      tapeId: 'tape-child',
      usage: ZERO_USAGE('cheap'),
      createdAt: 5,
      finalizedAt: 6,
      clientMessageId: 'msg-child',
      parentTurnKey: kind === 'parent' ? hex(1) : null,
      continuationOf: kind === 'continuation' ? hex(1) : null,
      turnIndex: 1,
    })
    const ctx = await context('905', sid, 'cheap')
    assert.equal(ctx.source, 'unknown')
    assert.equal(ctx.sourceModel, null)
  }
})

test('an archived session is never a failed first turn', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  await seedFailedFirstTurn('906', 's-archive')
  await query(
    `INSERT INTO client_session_archive_chunks
       (session_id,user_id,first_seq,last_seq,message_count,messages,created_at)
     VALUES ($1,$2,1,1,1,'[]',1)`,
    ['s-archive', 'c:906'],
  )
  const ctx = await context('906', 's-archive', 'cheap')
  assert.equal(ctx.source, 'unknown')
  assert.equal(ctx.sourceModel, null)
})

test('an executed legacy tape keeps priority over the failed-start fallback', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  await makeSession('907', 's-legacy', [{ role: 'user', id: 'msg-1' }])
  await addTape({
    uid: '907',
    sid: 's-legacy',
    tapeId: 'tape-0',
    status: 'completed',
    usage: JSON.stringify({
      model: 'legacy',
      inputTokens: 1000,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }),
    createdAt: 0,
    finalizedAt: 1,
    clientMessageId: 'msg-0',
  })
  await addTape({
    uid: '907',
    sid: 's-legacy',
    tapeId: 'tape-1',
    usage: ZERO_USAGE('cheap'),
    createdAt: 2,
    finalizedAt: 3,
    clientMessageId: 'msg-1',
    turnIndex: 1,
  })
  await addDispatch({ uid: '907', sid: 's-legacy', clientMessageId: 'msg-1', model: 'cheap' })
  const ctx = await context('907', 's-legacy', 'cheap')
  assert.equal(ctx.sourceModel, 'legacy')
  assert.equal(ctx.source, 'unknown')
  assert.equal(ctx.tokens, null)
})

test('a successful tape outside the six-row window still vetoes the exemption', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  const uid = '908'
  const sid = 's-window'
  await makeSession(uid, sid, [{ role: 'user', id: 'msg-1' }])
  await addTape({
    uid,
    sid,
    tapeId: 'tape-old',
    status: 'completed',
    usage: JSON.stringify({
      model: 'cheap',
      inputTokens: 1000,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }),
    createdAt: 0,
    finalizedAt: 1,
    clientMessageId: 'msg-old',
  })
  for (let i = 1; i <= 6; i++) {
    await addTape({
      uid,
      sid,
      tapeId: `tape-${i}`,
      usage: ZERO_USAGE('cheap'),
      createdAt: i,
      finalizedAt: i + 100,
      clientMessageId: i === 6 ? 'msg-1' : `msg-fail-${i}`,
      turnIndex: i,
    })
  }
  await addDispatch({ uid, sid, clientMessageId: 'msg-1', model: 'cheap' })
  const ctx = await context(uid, sid, 'cheap')
  assert.equal(ctx.source, 'unknown')
  assert.equal(ctx.sourceModel, null)
})

test('without an accepted terminal crashed dispatch the failure is not authoritative', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  for (const [index, variant] of [
    { accepted: false },
    { status: 'admitted', outcome: null },
    { outcome: 'executed_error' },
  ].entries()) {
    const uid = '909'
    const sid = `s-dispatch-${index}`
    await makeSession(uid, sid, [{ role: 'user', id: 'msg-1' }])
    await addTape({
      uid,
      sid,
      tapeId: 'tape-1',
      usage: ZERO_USAGE('cheap'),
      createdAt: 1,
      finalizedAt: 2,
      clientMessageId: 'msg-1',
    })
    await addDispatch({ uid, sid, clientMessageId: 'msg-1', model: 'cheap', ...variant })
    const ctx = await context(uid, sid, 'cheap')
    assert.equal(ctx.source, 'unknown')
    assert.equal(ctx.sourceModel, null)
  }
})

test('old unknown zero-like tapes veto both inside and outside the six-row window', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  for (const count of [0, 6]) {
    const sid = 's-unknown-' + count
    await seedFailedFirstTurn('910', sid)
    await query("UPDATE client_session_turn_tapes SET created_at=100,finalized_at=101 WHERE session_id=$1", [sid])
    await addTape({ uid: '910', sid, tapeId: 'unknown-old', createdAt: 0, finalizedAt: 1, turnIndex: 20,
      usage: JSON.stringify({ model: 'cheap', inputTokens: 0, outputTokens: 0 }) })
    for (let i = 1; i <= count; i++)
      await addTape({ uid: '910', sid, tapeId: 'zero-old-' + i, createdAt: i, finalizedAt: i + 1,
        usage: ZERO_USAGE('cheap'), turnIndex: i })
    assert.equal((await context('910', sid, 'cheap')).source, 'unknown')
  }
})

test('failed tape identity must bind the exact dispatch and attempt', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  for (const [index, mutation] of [
    'dispatch_id=NULL', 'attempt_no=NULL', 'attempt_no=attempt_no+1',
    "dispatch_id='00000000-0000-4000-8000-000000000742'::uuid",
  ].entries()) {
    const sid = 's-exact-' + index
    await seedFailedFirstTurn('911', sid)
    assert.equal((await context('911', sid, 'cheap')).source, 'unchanged')
    await query('UPDATE client_session_turn_tapes SET ' + mutation + ' WHERE session_id=$1', [sid])
    assert.equal((await context('911', sid, 'cheap')).source, 'unknown', mutation)
  }
})

test('model-visible hot history and forged anchors veto first-failure exemption', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  const extra = [
    { role: 'plan', text: 'old plan' }, { role: 'goal', objective: 'old goal' },
    { role: 'thinking', text: 'old reasoning' }, { role: 'future-kind', content: 'unknown' },
    { ...ANCHOR, text: 'old assistant body' }, { ...ANCHOR, _turnTapeSha256: HEX('a') },
    { ...ANCHOR, _turnTapeComplete: false },
  ]
  for (const [index, row] of extra.entries()) {
    const sid = 's-hot-' + index
    await seedFailedFirstTurn('912', sid)
    await query("UPDATE client_sessions SET messages=$2 WHERE id=$1",
      [sid, JSON.stringify([{ role: 'user', id: 'msg-1' }, ANCHOR, row])])
    assert.equal((await context('912', sid, 'cheap')).source, 'unknown', JSON.stringify(row))
  }
})

test('a cheaper different model or different agent still requires an actual risk quote', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  await seedFailedFirstTurn('913', 's-cheaper')
  const pricing = new PricingCache()
  const price = (id: string, cost: bigint) => ({
    model_id: id, display_name: id, input_per_mtok: cost, output_per_mtok: cost,
    cache_read_per_mtok: cost, cache_write_per_mtok: cost, multiplier: '1.000',
  } as ModelPricing)
  pricing._setForTests([price('cheap', 100n), price('cheaper', 1n)])
  const service = new ModelSwitchCostService({
    pool: { query } as never, pricing, secret: 'offline-fixture-only',
    balance: async () => 10000n, sourceEngine: () => 'codex',
    resolveTarget: async (_uid, model) => ({ pricing: pricing.get(model)!, engine: 'codex', contextWindow: 200000 }),
  })
  for (const [targetModel, agentId] of [['cheaper', 'main'], ['cheap', 'other']]) {
    const result = await service.quote('913', { sessionId: 's-cheaper', requestId: 'req-next', targetModel, agentId })
    assert.equal(result.mode, 'risk')
    assert.equal(result.requiresConfirmation, true)
    assert.equal(result.sourceModel, null)
  }
})

test('the real batched tape writer produces an eligible failed-start anchor', async (t) => {
  if (!ready) return t.skip('Postgres test fixture unavailable')
  const uid = '914', sid = 's-real-runtime-batch', owner = 'c:' + uid
  await makeSession(uid, sid, [{ id: 'msg-batch', role: 'user', text: 'original goal' }])
  const dispatchId = await addDispatch({ uid, sid, clientMessageId: 'msg-batch', model: 'cheap' })
  const payload = {
    sessionId: sid, agentId: 'main', turnIndex: 1, status: 'crashed',
    turnKey: HEX('f'), clientMessageId: 'msg-batch', text: '', createdAt: Date.now(),
    errorCode: 'ENGINE_ERROR', usage: { ...JSON.parse(ZERO_USAGE('cheap')), turn: 1, totalTokens: 0 },
    runtimeEvents: Array.from({ length: 4 }, (_, ordinal) => ({
      ordinal, observedAt: Date.now() + ordinal, source: 'gateway',
      payload: { type: 'legacy-progress', ordinal },
    })),
  }
  const bytes = Buffer.from(JSON.stringify(payload))
  const hash = (input: Buffer | string) => createHash('sha256').update(input).digest('hex')
  const base = {
    protocolVersion: LOSSLESS_TURN_TAPE_VERSION, sessionId: sid, agentId: 'main', turnIndex: 1,
    status: 'crashed' as const, turnKey: payload.turnKey, tapeId: hash('runtime-batch'),
    tapeSha256: hash(bytes), totalBytes: bytes.length, partCount: 1, createdAt: payload.createdAt,
  }
  const backend = createPgSessionsBackend(getPool(), { expectedGeneration: 0 })
  const old = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING
  process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = '1'
  try {
    await backend.stageLosslessTurnTapePart(owner, {
      ...base, action: 'part', partIndex: 0, partSha256: hash(bytes), data: bytes.toString('base64'),
    }, bytes, { dispatchId, attemptNo: 1 })
    assert.equal((await backend.finalizeLosslessTurnTape(owner, {
      ...base, action: 'finalize', dispatchId, attemptNo: 1,
    })).applied, 'finalized')
    const messages = JSON.parse((await query<{ messages: string }>(
      'SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2', [sid, owner])).rows[0]!.messages)
    const anchor = messages.find((m: Record<string, unknown>) => m._turnTapeId === base.tapeId)
    assert.match(anchor._turnTapeRuntimeManifestSha256, /^[a-f0-9]{64}$/)
    assert.equal((await context(uid, sid, 'cheap')).source, 'unchanged')
    anchor._turnTapeRuntimeManifestSha256 = 'invalid manifest metadata'
    await query('UPDATE client_sessions SET messages=$2 WHERE id=$1', [sid, JSON.stringify(messages)])
    assert.equal((await context(uid, sid, 'cheap')).source, 'unknown')
  } finally {
    if (old === undefined) delete process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING
    else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = old
  }
})
