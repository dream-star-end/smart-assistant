import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { computeDispatchRequestHash, LOSSLESS_TURN_TAPE_VERSION } from '@openclaude/protocol'
import type { MessageLike } from '@openclaude/storage'
import { getPool } from '../db/index.js'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'
import { attributeOpenTurn, rememberOpenTurnKey } from '../billing/openTurnAttribution.js'
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
