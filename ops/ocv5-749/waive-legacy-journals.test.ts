import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Pool } from 'pg'
import { claimInflightJournalForSettlement } from '../../packages/commercial/src/billing/proxyBilling.js'
import { RemoteReleaseDrainCoordinator } from '../../packages/commercial/src/account-pool/remotePool/drainGate.js'
import { IDS, LANES, REQUEST_LANE, AUDIT_KEY, applyWaiver, capture, digest, readback, savePrivate, validate } from './waive-legacy-journals.mjs'

const url = process.env.TEST_DATABASE_URL
assert.ok(url && new URL(url).pathname.endsWith('_test'), 'explicit isolated test database required')
assert.equal(new URL(url).hostname, '127.0.0.1')
const tables = ['remote_agent_bindings', 'request_finalize_journal', 'usage_records', 'credit_ledger', 'pending_usage_patches', 'turn_tape_cost_components']

test('seven historical waiver: real PG, original production table shapes, no external operations', async t => {
  const schema = `waiver_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  const pool = new Pool({ connectionString: url, max: 5, options: `-c search_path=${schema},pg_catalog -c statement_timeout=10000` })
  const dir = mkdtempSync(join(tmpdir(), 'ocv5-749-waiver-'))
  try {
    assert.match((await admin.query('SELECT current_database() db')).rows[0].db, /_test$/)
    await admin.query(`CREATE SCHEMA ${schema}`)
    // Private tables only: no reset, no fixtures or writes to public. Preserve real column/check constraints.
    for (const table of tables) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
    await pool.query('CREATE TABLE users(id bigint PRIMARY KEY,credits bigint); INSERT INTO users VALUES(3,123456)')
    for (const table of [...tables, 'users']) {
      assert.equal((await pool.query('SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE c.oid=to_regclass($1)', [table])).rows[0].nspname, schema)
    }
    async function seed() {
      for (const table of tables) await pool.query(`TRUNCATE ${table}`)
      for (const lane of LANES) await pool.query(`INSERT INTO remote_agent_bindings
        (operation_id,run_id,uid,container_db_id,docker_id,session_key,node_id,profile_id,canonical_model_id,generation,state,expires_at)
        VALUES($1,$2,3,7,$3,$4,$5,$6,'claude-opus-5-5-remote',$7,$8,NOW()-INTERVAL '1 day')`,
      [lane.operation, lane.run, lane.docker, `session:${lane.operation}`, randomUUID(), randomUUID(), lane.generation, lane.state])
      for (const id of IDS) {
        const lane = LANES[REQUEST_LANE[id]]
        await pool.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx,precheck_credits)
          VALUES($1,3,'inflight',$2,100)`, [id, {
          untouchedAudit: { evidence: 'must-survive' }, remoteNativeBillingRecovery: 'cc5-native-v1',
          remoteNative: { v: 1, requestId: id, receipt: null, input: { sequence: 1, inputSha256: 'a'.repeat(64) },
            hostStartAttempted: true, reserved: true, reservedCredits: '100', scope: { uid: '3', dockerId: lane.docker,
              runId: lane.run, operationId: lane.operation, sessionKey: `session:${lane.operation}`,
              backendKind: 'cc5-interactive-v1', canonicalModel: 'claude-opus-5-5-remote' } },
        }])
      }
      await pool.query("INSERT INTO request_finalize_journal(request_id,user_id,state,ctx,precheck_credits) VALUES('bystander',4,'inflight','{}',10)")
      return capture(pool)
    }
    const untouched = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(u)) FROM users u) users,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY operation_id) FROM remote_agent_bindings b) bindings,
      (SELECT to_jsonb(j) FROM request_finalize_journal j WHERE request_id='bystander') bystander,
      (SELECT jsonb_agg(to_jsonb(u)) FROM usage_records u) usage,
      (SELECT jsonb_agg(to_jsonb(l)) FROM credit_ledger l) ledger,
      (SELECT jsonb_agg(to_jsonb(p)) FROM pending_usage_patches p) pending,
      (SELECT jsonb_agg(to_jsonb(c)) FROM turn_tape_cost_components c) tape`)).rows[0]

    await t.test('seven atomic waived; original ctx, bindings, balance and all financial tables unchanged; real drain and claim', async () => {
      const expected = await seed(), before = await untouched()
      validate(expected)
      const drain = new RemoteReleaseDrainCoordinator()
      await assert.rejects(drain.drainForCutover(pool, { timeoutMs: 50 }), /REMOTE_RELEASE_DRAIN_TIMEOUT/)
      const file = join(dir, 'snapshot.json')
      assert.deepEqual(await applyWaiver(pool, expected, value => savePrivate(file, value)), { committed: true })
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.equal(digest(JSON.parse(readFileSync(file, 'utf8'))), digest(expected))
      assert.deepEqual(await untouched(), before)
      assert.equal(await readback(pool, expected), 'committed-verified')
      for (const id of IDS) assert.equal(await claimInflightJournalForSettlement(pool, id), null)
      assert.equal((await drain.drainForCutover(pool, { timeoutMs: 100, keepClosedForRestart: false })).drained, true)
      const j = (await capture(pool)).journals[0]
      assert.equal(j.ctx[AUDIT_KEY].remoteStopVerified, false)
      assert.equal(j.ctx.remoteNative.receipt, null)
    })
    for (const [label, sql] of [
      ['ctx drift', "UPDATE request_finalize_journal SET ctx=ctx||'{\"changed\":true}' WHERE request_id=$1"],
      ['receipt arrived', "UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{remoteNative,receipt}','{\"usage\":1}') WHERE request_id=$1"],
      ['wrong uid', 'UPDATE request_finalize_journal SET user_id=4 WHERE request_id=$1'],
      ['claimed', "UPDATE request_finalize_journal SET state='finalizing',ctx=ctx||'{\"settlementClaimId\":\"winner\"}' WHERE request_id=$1"],
      ['committed', "UPDATE request_finalize_journal SET state='committed' WHERE request_id=$1"],
      ['binding generation drift', 'UPDATE remote_agent_bindings SET generation=generation+1 WHERE operation_id=(SELECT (ctx#>>\'{remoteNative,scope,operationId}\')::uuid FROM request_finalize_journal WHERE request_id=$1)'],
    ]) await t.test(`${label}: entire batch rejected before snapshot/write`, async () => {
      const expected = await seed()
      await pool.query(sql, [IDS.at(-1)])
      const frozen = await capture(pool); let persisted = false
      await assert.rejects(applyWaiver(pool, expected, () => { persisted = true }), /WAIVER_REJECTED/)
      assert.equal(persisted, false); assert.deepEqual(await capture(pool), frozen)
    })
    await t.test('refuse preexisting usage, ledger or orphan attribution, even absent journal FK', async () => {
      const inserts = [
        "INSERT INTO usage_records(id,user_id,request_id,model,mode,status,price_snapshot,cost_credits) VALUES(900001,3,$1,'m','chat','error','{}',0)",
        "INSERT INTO credit_ledger(id,user_id,delta,balance_after,reason,ref_type,ref_id) VALUES(900001,3,-7,123449,'chat','request',$1)",
        "INSERT INTO pending_usage_patches(user_id,request_id,cost_credits) VALUES('c:3',$1,'7')",
        "INSERT INTO turn_tape_cost_components(user_id,request_id,session_id,tape_id,billing_anchor_id,cost_credits,updated_at) VALUES('c:3',$1,'s','t','b',7,1)",
      ]
      for (const sql of inserts) {
        const expected = await seed(); await pool.query(sql, [IDS[0]])
        const before = await untouched()
        await assert.rejects(applyWaiver(pool, expected, () => assert.fail('must not persist')), /WAIVER_REJECTED/)
        assert.deepEqual(await capture(pool), expected); assert.deepEqual(await untouched(), before)
      }
    })
    await t.test('additional pending request on any frozen operation refuses', async () => {
      const expected = await seed()
      await pool.query("UPDATE request_finalize_journal SET ctx=$1 WHERE request_id='bystander'", [{ remoteNative: { scope: { operationId: LANES[0].operation } } }])
      await assert.rejects(applyWaiver(pool, expected, () => assert.fail('must not persist')), /WAIVER_REJECTED/)
      assert.deepEqual(await capture(pool), expected)
    })
    await t.test('failure on seventh UPDATE rolls back first six', async () => {
      const expected = await seed()
      await pool.query(`CREATE FUNCTION fail_last() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.request_id='${IDS.at(-1)}' AND NEW.state='aborted' THEN RAISE EXCEPTION 'last write failed'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_last BEFORE UPDATE ON request_finalize_journal FOR EACH ROW EXECUTE FUNCTION fail_last()`)
      try {
        await assert.rejects(applyWaiver(pool, expected, () => {}), /WAIVER_REJECTED/)
        assert.deepEqual(await capture(pool), expected)
      } finally { await pool.query('DROP TRIGGER fail_last ON request_finalize_journal; DROP FUNCTION fail_last()') }
    })
    await t.test('snapshot persistence failure does not write', async () => {
      const expected = await seed()
      await assert.rejects(applyWaiver(pool, expected, () => { throw Error('disk full') }), /WAIVER_REJECTED/)
      assert.deepEqual(await capture(pool), expected)
    })
    await t.test('waiver locks first: real late claimant blocks, then cannot obtain settlement ownership', async () => {
      const expected = await seed()
      let entered!: () => void, unlock!: () => void
      const ready = new Promise<void>(r => { entered = r }), hold = new Promise<void>(r => { unlock = r })
      const applying = applyWaiver(pool, expected, async () => { entered(); await hold })
      await ready
      const contender = await pool.connect()
      const pid = (await contender.query('SELECT pg_backend_pid() pid')).rows[0].pid
      const claiming = claimInflightJournalForSettlement(contender as any, IDS[0])
      try {
        let blocked = false
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked
          if (!blocked) await new Promise(r => setTimeout(r, 10))
        }
        assert.equal(blocked, true)
      } finally { unlock() }
      await applying; assert.equal(await claiming, null); contender.release()
    })
    await t.test('claim first: real owner retained and batch rejected', async () => {
      const expected = await seed()
      const owner = await claimInflightJournalForSettlement(pool, IDS[0]); assert.ok(owner)
      const before = await capture(pool)
      await assert.rejects(applyWaiver(pool, expected, () => {}), /WAIVER_REJECTED/)
      assert.deepEqual(await capture(pool), before)
    })
    for (const committed of [true, false]) await t.test(`COMMIT response loss, server committed=${committed}: only independent readback; no repeat writes`, async () => {
      const expected = await seed(); let updates = 0
      const faultPool = { connect: async () => {
        const c = await pool.connect()
        return { release: (destroy: boolean) => c.release(destroy), query: async (sql: string, values?: any[]) => {
          if (sql.startsWith('UPDATE request_finalize_journal')) updates++
          if (sql === 'COMMIT') { if (committed) await c.query(sql); throw Error('transport lost') }
          return c.query(sql, values)
        } }
      } }
      await assert.rejects(applyWaiver(faultPool, expected, () => {}), /COMMIT_OUTCOME_UNKNOWN_READBACK_ONLY/)
      assert.equal(await readback(pool, expected), committed ? 'committed-verified' : 'unchanged-outcome-not-confirmed')
      assert.equal(updates, 7)
    })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end(); rmSync(dir, { recursive: true, force: true })
  }
})
