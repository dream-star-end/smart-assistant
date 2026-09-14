import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { ReceiptDeliveryStore } from '@openclaude/storage/receiptDeliveryStore'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { DelegateDurableDb as LegacyV4 } from './fixtures/delegateLegacyV4.fixture.js'
import { migrateOriginalV4Prefix } from './fixtures/delegateHistoricalMigrations.fixture.js'

test('identity schema storage fence rejects preexisting and reopened legacy connections without partial writes', () => {
  const path=join(mkdtempSync(join(tmpdir(),'delegate-identity-schema-')),'jobs.db')
  // Connection predates the migration; unlike a new-code version check the
  // trigger is enforced by SQLite for this already-open connection as well.
  const held=new Database(path), db=new DelegateDurableDb(path)
  const jobs=new DelegateJobStore({durable:db,sm:true,deliveryReceipts:true})
  const reopened=new Database(path)
  try {
    const source=jobs.create('worker');assert.ok('jobId' in source)
    assert.equal(held.pragma('user_version',{simple:true}),12)
    const before=held.prepare('SELECT job_id,state,callback_state FROM delegate_jobs').all()
    for (const old of [held,reopened]) {
      assert.throws(()=>old.prepare("UPDATE delegate_jobs SET state='failed'").run(),/no such function: oc_delegate_schema10/)
      assert.throws(()=>old.prepare('DELETE FROM delegate_jobs').run(),/no such function: oc_delegate_schema10/)
      assert.deepEqual(old.prepare('SELECT job_id,state,callback_state FROM delegate_jobs').all(),before)
    }
    reopened.function('oc_delegate_schema10',()=>9)
    assert.throws(()=>reopened.prepare('DELETE FROM delegate_jobs').run(),/schema10 writer required/)
    const claim=jobs.snapshotOf(source.jobId)!
    assert.equal(jobs.fail(source.jobId,{failureClass:'internal',detail:'private failure',httpStatus:500,claimToken:claim.claimToken,fencingEpoch:claim.fencingEpoch}),true)
    assert.equal(jobs.snapshotOf(source.jobId)?.state,'failed','registered original writer remains functional')
  } finally {jobs.close();db.close();held.close();reopened.close()}
})

test('schema10 receipt rows survive real migration12 and current recovery; incompatible consumers fail closed', async () => {
  const path=join(mkdtempSync(join(tmpdir(),'delegate-receipt-schema-')),'jobs.db')
  const seedPath=path+'.seed'
  const db=new DelegateDurableDb(seedPath),jobs=new DelegateJobStore({durable:db,sm:true,deliveryReceipts:true})
  const made=jobs.create('worker',{callback:'stdout-wait',callbackOriginUserId:'private',parentSessionKey:'parent',
    deliveryReceipt:{parentTurnKey:'turn',nativeToolUseId:'tool',receiptNonceHash:createHash('sha256').update('nonce').digest('hex')}})
  assert.ok('jobId' in made);const claim=jobs.snapshotOf(made.jobId)!
  assert.equal(jobs.complete(made.jobId,{httpStatus:200,body:{ok:true,output:'private result'}},
    {claimToken:claim.claimToken!,fencingEpoch:claim.fencingEpoch}),true)
  const binding=db.getDeliveryReceipt(made.jobId,0)!
  const seed=new Database(seedPath)
  const copy=new Map(['delegate_jobs','delegate_delivery_receipt'].map(table=>[table,seed.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[]]))
  seed.close();jobs.close()
  // Actual create/complete above supplies the rows. Build the complete frozen
  // schema10 prefix, not current tables with only a forged user_version.
  new LegacyV4(path).close();migrateOriginalV4Prefix(path,10)
  const raw=new Database(path)
  try {
    raw.function('oc_delegate_schema10',()=>10)
    raw.transaction(()=>{for(const [table,rows] of copy) for(const row of rows) {
      const keys=Object.keys(row)
      raw.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k=>'@'+k).join(',')})`).run(row)
    }})()
    // A separate unregistered legacy writer proves the guard after migration.
    const oldWriter=new Database(path)
    const before=raw.prepare('SELECT * FROM delegate_delivery_receipt').all()
    assert.throws(()=>new ReceiptDeliveryStore(path),/unsupported receipt consumer schema/)
    assert.equal(raw.pragma('user_version',{simple:true}),10,'consumer never migrates')
    const migrated=new DelegateDurableDb(path)
    assert.equal(raw.pragma('user_version',{simple:true}),12)
    assert.deepEqual(raw.prepare('SELECT * FROM delegate_delivery_receipt').all(),before)
    const consumer=new ReceiptDeliveryStore(path)
    try {
      assert.equal(await consumer.recover(binding,async()=>({kind:'absent'}),async()=>'inactive'),'notify_ready')
      assert.equal(migrated.get(made.jobId)?.callbackState,'pending')
      assert.throws(()=>oldWriter.prepare('UPDATE delegate_jobs SET callback_origin_user_id=callback_origin_user_id').run(),/no such function/)
      assert.throws(()=>oldWriter.prepare('UPDATE delegate_jobs SET result_json=result_json').run(),/no such function/)
    } finally {consumer.close();migrated.close();oldWriter.close()}
    raw.pragma('user_version=13')
    assert.throws(()=>new ReceiptDeliveryStore(path),/unsupported receipt consumer schema/)
    assert.equal(raw.pragma('user_version',{simple:true}),13)
  } finally {raw.close()}
})

test('schema9 metadata upgrades preserve exact old users without promoting default to a public owner', () => {
  const path=join(mkdtempSync(join(tmpdir(),'delegate-identity-upgrade-')),'jobs.db')
  new LegacyV4(path).close();migrateOriginalV4Prefix(path,9)
  const sql=new Database(path)
  // PRIVATE complete historical schema fixture, not a production downgrade or old binary.
  // The actual frozen schema9 writer is independently covered by the retained
  // old-writer-guard probe; here the oracle is exact migration/backfill content.
  const metadata=(userId:string)=>JSON.stringify({version:1,userId,parentSessionKey:'agent:main:webchat:dm:p',parentClientSessionId:'p',
    originSessionKey:'agent:main:webchat:dm:p',childSessionKey:'agent:worker:delegate:main:old',targetAgentId:'worker',sourceAgentId:'main',depth:0,model:null})
  for (const userId of ['default','c:7']) sql.prepare(`INSERT INTO delegate_retry_source
    (job_id,generation,user_id,parent_client_session_id,parent_session,child_session,target_agent_id,metadata_json,created_at)
    VALUES (?,0,?,'p','agent:main:webchat:dm:p','agent:worker:delegate:main:old','worker',?,1)`).run('old-'+userId,userId,metadata(userId))
  sql.close()
  const migrated=new DelegateDurableDb(path)
  try {
    for (const userId of ['default','c:7']) {
      const source=migrated.getRetrySource(userId,'old-'+userId,0)
      assert.equal(JSON.stringify(source),metadata(userId));assert.equal(source?.storageUserId,undefined)
    }
    assert.equal(migrated.getRetrySource('c:7','old-default',0),undefined)
  } finally {migrated.close()}
})
