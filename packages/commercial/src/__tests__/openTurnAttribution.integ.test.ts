import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { computeDispatchRequestHash, LOSSLESS_TURN_TAPE_VERSION } from '@openclaude/protocol'
import type { MessageLike } from '@openclaude/storage'
import { getPool } from '../db/index.js'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'
import {
  __resetOpenTurnKeyMemory,
  attributeOpenTurn,
  bindActiveDispatchTurnKey,
  rememberOpenTurnKey,
  verifyAndBindParentTurnFromEvidence,
} from '../billing/openTurnAttribution.js'
import { lockTurnBillingKeys } from '../billing/turnLock.js'
import { settleUsageAndLedger } from '../billing/proxyBilling.js'
import { useDedicatedTestDatabase } from './helpers/db.js'

const fixture = useDedicatedTestDatabase('ocv5_763_turn_attribution_test')

for (const state of ['one', 'none', 'many', 'unkeyed'] as const) {
  test(`real PG attribution ${state}: debit 132 once, refresh label ${state === 'one' ? 132 : 97}`, async t => {
    if (fixture.skipIfUnavailable(t)) return
    const pool = getPool()
    assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,
      'ocv5_763_turn_attribution_test')
    const uid = BigInt((await pool.query(`INSERT INTO users(email,password_hash,credits,role)
      VALUES ($1,'fixture',1000,'user') RETURNING id::text`, [`${randomUUID()}@test.local`])).rows[0].id)
    const cid = BigInt((await pool.query(`INSERT INTO agent_containers(user_id,secret_hash,state,runtime_channel)
      VALUES ($1,$2,'active','v5') RETURNING id::text`, [uid.toString(), Buffer.alloc(32)])).rows[0].id)
    await pool.query(`INSERT INTO sessions_store_migration_state
      (singleton,authority,generation,cutover_id,source_digest,completed_at)
      VALUES (true,'pg_authoritative',1,'fixture','fixture',1)
      ON CONFLICT(singleton) DO UPDATE SET authority='pg_authoritative',generation=1`)
    const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 })
    const sessionId = `attribution-${randomUUID()}`
    const owner = `c:${uid}`
    const turnKey = createHash('sha256').update(sessionId).digest('hex')
    const now = Date.now()
    await backend.upsertClientSession({ id: sessionId, userId: owner, agentId: 'main',
      title: 'isolated attribution proof', pinned: false, createdAt: now, lastAt: now,
      updatedAt: now, messages: [] })
    for (let n = 0; n < (state === 'none' ? 0 : state === 'many' ? 2 : 1); n++) {
      const dispatchId = randomUUID()
      const admission = await backend.admitUserTurn({ uid, sessionUserId: owner,
        sessionId: n === 0 ? sessionId : `${sessionId}-other`, clientMessageId: `message-${n}`,
        agentId: 'main', model: 'deepseek-v4-flash', requestHash: computeDispatchRequestHash({ text: 'fixture' }),
        billingRequestId: randomUUID().replaceAll('-', ''), dispatchId, ownerId: 'fixture',
        agentContainerId: Number(cid), runtimeKind: 'docker',
        message: { id: `message-${n}`, role: 'user', text: 'fixture', ts: now } })
      assert.equal(admission.kind, 'admitted')
      if (state !== 'unkeyed') await rememberOpenTurnKey(pool, { dispatchId, userId: uid,
        turnKey: n === 0 ? turnKey : createHash('sha256').update(dispatchId).digest('hex') })
    }
    // Finalize a real tape; the read model and appendCostCredits must fold committed locators.
    const bytes = Buffer.from(JSON.stringify({ sessionId, agentId: 'main', turnIndex: 1,
      status: 'completed', turnKey, text: 'fixture answer', createdAt: now }))
    const hash = createHash('sha256').update(bytes).digest('hex')
    const base = { protocolVersion: LOSSLESS_TURN_TAPE_VERSION, sessionId, agentId: 'main', turnIndex: 1,
      status: 'completed' as const, turnKey, tapeId: turnKey, tapeSha256: hash,
      totalBytes: bytes.length, partCount: 1, createdAt: now }
    await backend.stageLosslessTurnTapePart(owner, { ...base, action: 'part', partIndex: 0,
      partSha256: hash, data: bytes.toString('base64') }, bytes)
    assert.equal((await backend.finalizeLosslessTurnTape(owner, { ...base, action: 'finalize' })).applied, 'finalized')
    const stamp = await attributeOpenTurn(pool, { userId: uid, containerId: cid })
    assert.ok(stamp)
    assert.equal('turnKey' in stamp ? 'one' : stamp.openTurnAttribution, state)
    assert.deepEqual(await attributeOpenTurn(pool, { userId: uid, containerId: cid + 1000000n }),
      { openTurnAttribution: 'none' }, 'foreign container never receives the label')

    const settled: Array<Parameters<typeof settleUsageAndLedger>[1]> = []
    for (const [index, amount] of [97n, 7n, 9n, 8n, 11n].entries()) {
      const key = index === 0 ? turnKey : 'turnKey' in stamp ? stamp.turnKey : null
      const args: Parameters<typeof settleUsageAndLedger>[1] = {
        userId: uid, accountId: null, requestId: randomUUID().replaceAll('-', ''),
        model: 'deepseek-v4-flash', usage: { input_tokens: 1, output_tokens: 1,
          cache_read_tokens: 0, cache_write_tokens: 0 }, snapshotJson: '{}',
        costCredits: amount, status: 'success', sessionId: 'synthetic-container-session', turnKey: key,
      }
      const result = await settleUsageAndLedger(pool, args)
      assert.equal(result.debitedCredits, amount)
      settled.push(args)
      if (key) await backend.appendCostCredits(args.requestId, owner, amount.toString(), args.sessionId,
        null, null, key)
    }
    const label = async () => {
      const session = await backend.getClientSession(sessionId, owner)
      const reply = (session?.messages as MessageLike[] | undefined)?.find(m => m.role === 'assistant')
      assert.ok(reply, 'real refreshed session contains the finalized answer')
      return (reply.usage as { costCredits?: string })?.costCredits
    }
    assert.equal(await label(), state === 'one' ? '132' : '97')
    for (const args of settled) {
      const replay = await settleUsageAndLedger(pool, args)
      assert.equal(replay.commitDisposition, 'existing')
      assert.equal(replay.debitedCredits, null)
      if (args.turnKey) await backend.appendCostCredits(args.requestId, owner, args.costCredits.toString(),
        args.sessionId, null, null, args.turnKey)
    }
    assert.equal(await label(), state === 'one' ? '132' : '97', 'replay cannot double the label')
    const totals = (await pool.query(`SELECT
      (SELECT credits::text FROM users WHERE id=$1) AS balance,
      (SELECT sum(cost_credits)::text FROM usage_records WHERE user_id=$1) AS usage,
      (SELECT (-sum(delta))::bigint::text FROM credit_ledger WHERE user_id=$1 AND reason='chat') AS ledger`,
      [uid.toString()])).rows[0]
    assert.deepEqual(totals, { balance: '868', usage: '132', ledger: '132' })
  })
}

test('OCV5-898 R2 real PG: positive evidence, two-connection concurrency + unique index 0355, lockTurnBillingKeys waiver serialization, and strict container isolation', async t => {
  if (fixture.skipIfUnavailable(t)) return
  __resetOpenTurnKeyMemory()
  const pool = getPool()

  // 0. Verify migration 0355 partial unique index exists and is valid
  const idxRow = (await pool.query<{ indisvalid: boolean; indisunique: boolean }>(
    `SELECT i.indisvalid, i.indisunique
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'idx_turn_dispatches_active_user_turn_key'`,
  )).rows[0]
  assert.deepEqual(idxRow, { indisvalid: true, indisunique: true })

  const uid = BigInt((await pool.query(`INSERT INTO users(email,password_hash,credits,role)
    VALUES ($1,'fixture',1000,'user') RETURNING id::text`, [`${randomUUID()}@test.local`])).rows[0].id)
  const cid1 = BigInt((await pool.query(`INSERT INTO agent_containers(user_id,secret_hash,state,runtime_channel)
    VALUES ($1,$2,'active','v5') RETURNING id::text`, [uid.toString(), Buffer.alloc(32, 1)])).rows[0].id)
  const cid2 = BigInt((await pool.query(`INSERT INTO agent_containers(user_id,secret_hash,state,runtime_channel,runtime_kind)
    VALUES ($1,$2,'active','v5','desktop') RETURNING id::text`, [uid.toString(), Buffer.alloc(32, 2)])).rows[0].id)
  const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 })
  const owner = `c:${uid}`
  const now = Date.now()
  const sessA = `ocv5-898-a-${randomUUID()}`
  const sessB = `ocv5-898-b-${randomUUID()}`
  const sessC = `ocv5-898-c-${randomUUID()}`
  for (const sid of [sessA, sessB, sessC]) {
    await backend.upsertClientSession({
      id: sid, userId: owner, agentId: 'main', title: sid, pinned: false,
      createdAt: now, lastAt: now, updatedAt: now, messages: [],
    })
  }
  const admitOne = async (sid: string, cmid: string, containerId: bigint | null) => {
    const dispatchId = randomUUID()
    const adm = await backend.admitUserTurn({
      uid, sessionUserId: owner, sessionId: sid, clientMessageId: cmid,
      agentId: 'main', model: 'antigravity-gemini-4-neon',
      requestHash: computeDispatchRequestHash({ text: cmid }),
      billingRequestId: randomUUID().replaceAll('-', ''), dispatchId, ownerId: 'fixture',
      ...(containerId !== null ? { agentContainerId: Number(containerId) } : {}),
      runtimeKind: 'docker',
      message: { id: cmid, role: 'user', text: cmid, ts: now },
    })
    assert.equal(adm.kind, 'admitted')
    return dispatchId
  }

  // 1. BLOCKER 1: Unverified key on an active unkeyed dispatch MUST fail closed (null) even with matching sessionId
  const dA = await admitOne(sessA, 'cm-a1', cid1)
  const unverifiedKey = createHash('sha256').update(`unverified-${dA}`).digest('hex')
  assert.equal(
    await verifyAndBindParentTurnFromEvidence(pool, {
      userId: uid, containerId: cid1, turnKey: unverifiedKey, requestedParentSessionId: sessA,
    }),
    null,
    'session uniqueness alone must NOT authorize binding an unverified turnKey',
  )

  // 2. Positive authority_turn_dispatches evidence authorizes binding & backfills turn_dispatches.turn_key
  const authKey = createHash('sha256').update(`auth-${dA}`).digest('hex')
  await pool.query(
    `INSERT INTO authority_turn_dispatches
       (authority_turn_id, user_id, dispatch_model, canonical_model, session_id, dispatch_id, attempt_no, turn_key)
     VALUES ($1, $2, 'antigravity-gemini-4-neon', 'antigravity-gemini-4-neon', $3, $4::uuid, 1, $5)`,
    [randomUUID().replaceAll('-', ''), uid.toString(), sessA, dA, authKey],
  )
  assert.deepEqual(
    await verifyAndBindParentTurnFromEvidence(pool, {
      userId: uid, containerId: cid1, turnKey: authKey, requestedParentSessionId: sessA,
    }),
    { dispatchId: dA, sessionId: sessA },
  )

  // 3. BLOCKER 3: Strict container ownership — NULL agent_container_id row and foreign container row BOTH rejected
  const dNullContainer = await admitOne(sessC, 'cm-c-null', null)
  const nullCidKey = createHash('sha256').update(`null-cid-${dNullContainer}`).digest('hex')
  assert.equal(
    await bindActiveDispatchTurnKey(pool, {
      dispatchId: dNullContainer, userId: uid, containerId: cid1,
      attemptNo: 1, sessionId: sessC, clientMessageId: 'cm-c-null', turnKey: nullCidKey, skipCache: true,
    }),
    false,
    'row with agent_container_id IS NULL must reject receipt turn_key bind',
  )
  const dOtherCid = await admitOne(sessC, 'cm-c-other', cid2)
  assert.equal(
    await bindActiveDispatchTurnKey(pool, {
      dispatchId: dOtherCid, userId: uid, containerId: cid1,
      attemptNo: 1, sessionId: sessC, clientMessageId: 'cm-c-other', turnKey: nullCidKey, skipCache: true,
    }),
    false,
    'foreign container of same user must reject receipt turn_key bind',
  )

  // 4. BLOCKER 2 (two-connection concurrency + DB unique index): two concurrent binds of SAME turnKey onto TWO active dispatches -> AT MOST ONE wins
  const dRace1 = await admitOne(sessB, 'cm-race-1', cid1)
  const dRace2 = await admitOne(sessC, 'cm-race-2', cid2)
  const raceKey = createHash('sha256').update(`race-${dRace1}-${dRace2}`).digest('hex')
  const [win1, win2] = await Promise.all([
    bindActiveDispatchTurnKey(pool, {
      dispatchId: dRace1, userId: uid, containerId: cid1,
      attemptNo: 1, sessionId: sessB, clientMessageId: 'cm-race-1', turnKey: raceKey, skipCache: true,
    }),
    bindActiveDispatchTurnKey(pool, {
      dispatchId: dRace2, userId: uid, containerId: cid2,
      attemptNo: 1, sessionId: sessC, clientMessageId: 'cm-race-2', turnKey: raceKey, skipCache: true,
    }),
  ])
  assert.equal(Number(win1) + Number(win2), 1, 'exactly one concurrent dispatch may win active (user_id, turn_key)')
  const raceCount = Number((await pool.query(
    `SELECT count(*)::int AS c FROM turn_dispatches WHERE user_id=$1 AND turn_key=$2 AND status IN ('admitted','accepted','rejecting')`,
    [uid.toString(), raceKey],
  )).rows[0].c)
  assert.equal(raceCount, 1)

  // Direct raw SQL on second dispatch proves DB partial unique index rejects duplicate even without advisory lock
  const loserId = win1 ? dRace2 : dRace1
  await assert.rejects(
    pool.query(`UPDATE turn_dispatches SET turn_key = $2 WHERE dispatch_id = $1::uuid`, [loserId, raceKey]),
    (err: { code?: string; constraint?: string }) =>
      err.code === '23505' && err.constraint === 'idx_turn_dispatches_active_user_turn_key',
  )

  // 5. BLOCKER 2 (lockTurnBillingKeys serialization with concurrent waiver): bind waits for waiver lock and fails closed once waiver commits
  const dWaive = await admitOne(sessB, 'cm-waive-lock', cid1)
  const waiveLockKey = createHash('sha256').update(`waive-lock-${dWaive}`).digest('hex')
  const waiverClient = await pool.connect()
  try {
    await waiverClient.query('BEGIN')
    await lockTurnBillingKeys(waiverClient, uid, [waiveLockKey])
    let bindSettled = false
    const bindPromise = bindActiveDispatchTurnKey(pool, {
      dispatchId: dWaive, userId: uid, containerId: cid1,
      attemptNo: 1, sessionId: sessB, clientMessageId: 'cm-waive-lock', turnKey: waiveLockKey, skipCache: true,
    }).then((ok) => {
      bindSettled = true
      return ok
    })
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(bindSettled, false, 'bindActiveDispatchTurnKey must wait on lockTurnBillingKeys held by waiver tx')
    await waiverClient.query(
      `INSERT INTO turn_waivers(user_id, turn_key, reason, status) VALUES ($1, $2, 'no_response', 'pending')`,
      [uid.toString(), waiveLockKey],
    )
    await waiverClient.query('COMMIT')
    assert.equal(await bindPromise, false, 'bind must fail closed after concurrent waiver commits')
  } catch (err) {
    await waiverClient.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    waiverClient.release()
  }

  // 6. Historical finalized tape, foreign usage_records, fenced dispatch, and same-session terminal replay all rejected
  const finalizedKey = createHash('sha256').update(`finalized-${dWaive}`).digest('hex')
  const tapeBytes = Buffer.from(JSON.stringify({
    sessionId: sessB, agentId: 'main', turnIndex: 1,
    status: 'completed', turnKey: finalizedKey, text: 'historical finalized turn', createdAt: now,
  }))
  const tapeHash = createHash('sha256').update(tapeBytes).digest('hex')
  const tapeBase = {
    protocolVersion: LOSSLESS_TURN_TAPE_VERSION, sessionId: sessB, agentId: 'main', turnIndex: 1,
    status: 'completed' as const, turnKey: finalizedKey, tapeId: finalizedKey, tapeSha256: tapeHash,
    totalBytes: tapeBytes.length, partCount: 1, createdAt: now,
  }
  await backend.stageLosslessTurnTapePart(owner, { ...tapeBase, action: 'part', partIndex: 0, partSha256: tapeHash, data: tapeBytes.toString('base64') }, tapeBytes)
  assert.equal((await backend.finalizeLosslessTurnTape(owner, { ...tapeBase, action: 'finalize' })).applied, 'finalized')
  assert.equal(
    await bindActiveDispatchTurnKey(pool, {
      dispatchId: dWaive, userId: uid, containerId: cid1, attemptNo: 1, sessionId: sessB, turnKey: finalizedKey, skipCache: true,
    }),
    false,
  )

  const usedKey = createHash('sha256').update(`used-${dWaive}`).digest('hex')
  await settleUsageAndLedger(pool, {
    userId: uid, accountId: null, requestId: randomUUID().replaceAll('-', ''),
    model: 'deepseek-v4-flash', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 },
    snapshotJson: '{}', costCredits: 1n, status: 'success', sessionId: sessB, turnKey: usedKey,
  })
  assert.equal(
    await bindActiveDispatchTurnKey(pool, {
      dispatchId: dWaive, userId: uid, containerId: cid1, attemptNo: 1, sessionId: sessB, turnKey: usedKey, skipCache: true,
    }),
    false,
  )

  await pool.query(`UPDATE turn_dispatches SET producer_fenced_at = NOW() WHERE dispatch_id = $1::uuid`, [dWaive])
  assert.equal(
    await bindActiveDispatchTurnKey(pool, {
      dispatchId: dWaive, userId: uid, containerId: cid1, attemptNo: 1, sessionId: sessB,
      turnKey: createHash('sha256').update(`fenced-${dWaive}`).digest('hex'), skipCache: true,
    }),
    false,
  )

  await pool.query(`UPDATE turn_dispatches SET status = 'terminal', outcome = 'executed_error', terminal_at = NOW() WHERE dispatch_id = $1::uuid`, [dA])
  const dA2 = await admitOne(sessA, 'cm-a2', cid1)
  assert.equal(
    await bindActiveDispatchTurnKey(pool, {
      dispatchId: dA2, userId: uid, containerId: cid1, attemptNo: 1, sessionId: sessA, turnKey: authKey, skipCache: true,
    }),
    false,
    'same-session terminal turn_key must not replay onto a fresh active dispatch',
  )
})
